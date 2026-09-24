"""ERIS organization model: offices, branches, membership, coverage, classification rules.

Revision ID: 20260911_org_model
Revises: 20260910_routing_v2
Create Date: 2026-09-11

The org model turns the organization itself into data (design §3). Today an
office is a bare string on ``users.metadata_json``, the district -> office map is
hard-coded in three places, and a branch cannot be expressed at all. After this
revision:

  1. seven ``org_*`` tables hold offices, the districts they serve, branches, the
     districts a branch covers, per-user membership + identity, coordinator
     coverage and the classification -> role rules (design §3.3);
  2. ``assessments`` carries five snapshot columns — the office and branch NAME
     as they read when the assessment was routed — so a later rename or a
     deactivation cannot rewrite history (design §3.5);
  3. ``CALTRANS_VIEWER`` exists as a role row (design §4);
  4. every active user gets an ``org_user_profiles`` row backfilled from
     ``users.metadata_json``, and the twelve ``geotech_office_routing`` rows
     become the one-time seed of ``org_office_districts`` (design §3.7).

Conventions inherited from 20260910_routing_v2: raw ``op.execute()`` DDL,
additive, idempotent (``CREATE TABLE IF NOT EXISTS``, ``ADD COLUMN IF NOT
EXISTS``, every ``DROP CONSTRAINT IF EXISTS`` paired with its ``ADD``),
re-runnable because the clean base->head CI job re-runs it, a real
``downgrade()``, and a backfill that REFUSES rather than guesses.

PRE-FLIGHT — run this BEFORE ``alembic upgrade head`` on any real database.
``metadata_json.office_code`` is free text today (the admin form is an
``<input list=...>`` over a datalist and ``normalize_office_code`` only trims and
upcases), so ``WEST GEOTECH`` or ``W`` is a realistic value. The profile backfill
refuses to guess what such a value meant; this query is how an operator sees the
list first (design §3.7 step 6, §13.1):

    SELECT u.id, u.email,
           UPPER(TRIM(JSON_VALUE(u.metadata_json,'$.office_code'))) AS office_code
    FROM users u
    WHERE u.is_active = 1
      AND COALESCE(TRIM(JSON_VALUE(u.metadata_json,'$.office_code')),'') <> ''
      AND UPPER(TRIM(JSON_VALUE(u.metadata_json,'$.office_code')))
          NOT IN ('WEST','NORTH','SOUTH','POLICY','SUPPORT')
    ORDER BY office_code, u.id;

An empty result means the backfill will pass. Otherwise add the office or correct
the account first — the migration will not decide for you.

NOT A NO-OP ON RE-RUN, deliberately (design §3.7 step 3, §13.4): the two
``assessments`` foreign keys are dropped and re-created as one
``DROP CONSTRAINT IF EXISTS`` + ``ADD CONSTRAINT`` pair, because MariaDB has no
``ADD CONSTRAINT IF NOT EXISTS`` and no transactional DDL. That takes a metadata
lock on a large, hot table. Everything else in this revision is free to repeat.

TWO DEPARTURES FROM THE DESIGN'S DDL, both forced by MariaDB and both explained
where they occur. A column that a generated column reads may not carry a
cascading referential action, and a bare CHAR column may not appear in a
generated expression at all (error 1901, "Function or expression ... cannot be
used in the GENERATED ALWAYS AS clause") — the design's §3.3 as literally written
does not create on MariaDB 11:
  * ``fk_org_office_districts_office`` is ``ON UPDATE RESTRICT`` (design: CASCADE)
    and ``fk_org_branch_parent`` is ``ON DELETE RESTRICT`` (design: SET NULL),
    because ``active_district_key`` reads ``org_type`` and ``active_unit_key``
    reads ``parent_branch_id``. Nothing this model does is blocked: offices and
    branches are deactivated, never deleted, and ``org_offices.id`` is
    AUTO_INCREMENT and never updated.
  * ``active_district_key`` concatenates ``RTRIM(district)`` rather than
    ``district``. A CHAR's trailing spaces depend on the session's
    PAD_CHAR_TO_FULL_LENGTH, so the reference is not strictly deterministic;
    RTRIM is a no-op on the zero-padded two-character codes actually stored.

NOT TOUCHED, deliberately — do not "clean these up":
  * ``users``. Org facts never become columns on the authentication hot path, and
    ``users.metadata_json``'s three-key whitelist (app/user_metadata.py) is
    unchanged. The blob becomes a derived MIRROR of the profile row, never the
    source (design §3.2).
  * ``geotech_office_routing``. It stays for one release so a rollback to the
    previous backend still routes; ``services/org_directory.py`` is its only
    writer, and revision ``20260912_drop_geotech_office_routing`` drops it
    (design §13.6).
  * ``incidents.district`` stays ``VARCHAR(64)`` free text — normalizing it is a
    separate migration with its own risk (design §3.6).
  * ``incident_routing_assignments`` and its CHECK. The table is retired at the
    API, not in the schema; its rows stay as history (design §3.6).
  * The legacy ``REVIEWER`` role. Migrating those accounts to Viewer would
    NARROW them (design §13.10).

A DOWNGRADE UN-GRANTS EVERY VIEWER. ``downgrade()`` deletes the
``CALTRANS_VIEWER`` role row, and ``user_roles`` rows follow by ON DELETE
CASCADE, exactly as 0008_assessment_domain.py does for its roles. A later upgrade
does NOT restore them. Say so in the release note (design §13.9).
"""

from alembic import op
from sqlalchemy import text

revision = "20260911_org_model"
down_revision = "20260910_routing_v2"
branch_labels = None
depends_on = None


# --------------------------------------------------------------------------
# Seed data (design §10) — STRUCTURE ONLY.
# --------------------------------------------------------------------------
# No real employee name from any chart appears in any seeded row (owner
# decision 6), and no branch carries a chief: roles are never bound to named
# people. Position counts from the charts are reference data, not accounts, and
# are deliberately NOT stored — a count that nobody reads would go stale.

# code, unit_number, name, short_name, home_city, home_district,
# home_location_label, is_routing_target, sort_order
_OFFICES: list[tuple] = [
    ("WEST", "59-315", "Office of Geotechnical Design West", "OGDW",
     "Oakland", "04", None, 1, 10),
    ("NORTH", "59-323", "Office of Geotechnical Design North", "OGDN",
     "Sacramento", None, "Translab", 1, 20),
    ("SOUTH", "59-324", "Office of Geotechnical Design South", "OGDS",
     "Los Angeles", "07", None, 1, 30),
    # POLICY is shaped inversely to the three design offices (9 specialists, two
    # subject-named branches, no district list) and SUPPORT has no chart at all,
    # so neither is offered for a district incident (design §10, open question 2).
    ("POLICY", "59-325", "Office of Geotechnical Design Policies & Practices", "OGDPP",
     "Sacramento", None, "Translab", 0, 40),
    ("SUPPORT", "59-316", "Office of Geotechnical Support", "OGS",
     "Sacramento", None, "Translab", 0, 50),
]

# office_code, letter, name, home_city, home_district, home_location_label,
# accepts_assignments, sort_order
#
# `name` is the PRINTED name per office and the letter is stored separately,
# because the printed label is not a stable key: WEST and SOUTH print "Branch A",
# NORTH prints "Districts Branch A" and POLICY prints two subject names.
# Seventeen branches: WEST 6 + NORTH 4 + SOUTH 5 + POLICY 2 + SUPPORT 0.
_BRANCHES: list[tuple] = [
    ("WEST", "A", "Branch A", "Oakland", "04", None, 1, 1),
    ("WEST", "B", "Branch B", "Oakland", "04", None, 1, 2),
    ("WEST", "C", "Branch C", "Oakland", "04", None, 1, 3),
    # Branch D's chief sits at Oakland D04 while three of its five staff sit at
    # Orinda — same district, different city. Branch home city is therefore
    # stored separately from a person's home city (design §10).
    ("WEST", "D", "Branch D", "Oakland", "04", None, 1, 4),
    ("WEST", "E", "Branch E", "San Luis Obispo", "05", None, 1, 5),
    ("WEST", "F", "Branch F", "Eureka", "01", None, 1, 6),
    ("NORTH", "A", "Districts Branch A", "Sacramento", None, "Translab", 1, 1),
    ("NORTH", "B", "Districts Branch B", "Sacramento", None, "Translab", 1, 2),
    ("NORTH", "C", "Districts Branch C", "Sacramento", None, "Translab", 1, 3),
    ("NORTH", "D", "Districts Branch D", "Sacramento", None, "Translab", 1, 4),
    ("SOUTH", "A", "Branch A", "Los Angeles", "07", None, 1, 1),
    ("SOUTH", "B", "Branch B", "San Diego", "11", None, 1, 2),
    ("SOUTH", "C", "Branch C", "Santa Ana", "12", None, 1, 3),
    ("SOUTH", "D", "Branch D", "Los Angeles", "07", None, 1, 4),
    # Proposed, not staffed: dashed boxes, a vacant chief and three vacant staff
    # on the chart. It exists so the structure is complete, and
    # accepts_assignments = 0 keeps it out of every picker until someone fills it.
    ("SOUTH", "E", "Branch E", "San Bernardino", "08", None, 0, 5),
    ("POLICY", "A", "Structure Foundation & Roadway Geotechnical Design Branch A",
     "Sacramento", None, "Translab", 1, 1),
    ("POLICY", "B", "Structure Foundation & Roadway Geotechnical Design Branch B",
     "Sacramento", None, "Translab", 1, 2),
]

# rule_kind, class_code, marker, title_pattern, level_code, title, eris_role,
# is_supervisor, priority, notes
#
# Fourteen CLASS rows and two PATTERN rows (design §6). This is a SUGGESTION
# engine: the API renders "classification 3161 (Sup) suggests Branch Chief" in
# the admin UI and NEVER writes user_roles. The charts are why — the NORTH office
# chief position is vacant and filled out of class, and a SOUTH senior specialist
# is OOC-covered for eight months, so an admin must be able to grant a role that
# contradicts a stored classification.
_RDS_II_NOTE = (
    "one WEST Branch D position is mid-reclassification: the box reads "
    "'TET to RDS II', numbered 559-315-3175-003 (5758-xxx), and prints level R11"
)
_CLASSIFICATIONS: list[tuple] = [
    ("CLASS", "3155", "", "", "M09", "Supervising TE", "GEOTECH_OFFICE_CHIEF", 1, 100, None),
    ("CLASS", "3161", "SUP", "", "S09", "Senior Transportation Engineer (Sup)",
     "GEOTECH_BRANCH_CHIEF", 1, 100, None),
    ("CLASS", "3751", "SUP", "", "S09", "Senior Engineering Geologist (Sup)",
     "GEOTECH_BRANCH_CHIEF", 1, 100, None),
    ("CLASS", "3161", "SPEC", "", "R09", "Senior Transportation Engineer (Spec)",
     "GEOTECH_SENIOR_ENGINEER", 0, 100, None),
    ("CLASS", "3751", "SPEC", "", "R09", "Senior Engineering Geologist (Spec)",
     "GEOTECH_SENIOR_ENGINEER", 0, 100, None),
    ("CLASS", "3375", "SPEC", "", "R09", "Senior Materials & Research Engineer (Spec)",
     "GEOTECH_SENIOR_ENGINEER", 0, 100, None),
    ("CLASS", "3185", "SPEC", "", "R09", "Senior Bridge Engineer (Spec)",
     "GEOTECH_SENIOR_ENGINEER", 0, 100, None),
    ("CLASS", "3135", "", "", "R09", "Transportation Engineer, Civil",
     "GEOTECH_ENGINEER", 0, 100, None),
    ("CLASS", "3756", "", "", "R09", "Engineering Geologist", "GEOTECH_ENGINEER", 0, 100, None),
    ("CLASS", "3175", "", "", "R11", "Transportation Engineering Technician",
     "GEOTECH_ENGINEER", 0, 100, None),
    ("CLASS", "3381", "", "", "R11", "Materials & Research Engineering Associate",
     "GEOTECH_ENGINEER", 0, 100, None),
    # Undecided on purpose: eris_role NULL means "no suggestion", not "no role"
    # (owner open question 15).
    ("CLASS", "5758", "", "", "R11", "Research Data Specialist II", None, 0, 100, _RDS_II_NOTE),
    ("CLASS", "5393", "", "", "R01", "Analyst II", "CALTRANS_VIEWER", 0, 100, None),
    ("CLASS", "1139", "", "", "R01", "Office Technician (T)", "CALTRANS_VIEWER", 0, 100, None),
    # The two general rules, as DATA so a new discipline needs no code change.
    # They resolve AFTER every CLASS row (priority 500 vs 100).
    ("PATTERN", "", "SPEC", "SENIOR %", "", "Any Senior <discipline> marked (Spec)",
     "GEOTECH_SENIOR_ENGINEER", 0, 500,
     "general rule: any Senior <discipline> marked (Spec) is a senior specialist"),
    ("PATTERN", "", "SUP", "%", "S09", "Any classification marked (Sup) at level S09",
     "GEOTECH_BRANCH_CHIEF", 1, 500,
     "general rule: any classification marked (Sup) at level S09 is a branch chief"),
]

# The SQL that normalizes users.metadata_json.district into a CHAR(2) district
# code, mirroring app/user_metadata.normalize_district_code: take the first one
# or two digits and zero-pad. Written once because the profile and coverage
# backfills must agree exactly.
#
# JSON_VALUE, not JSON_UNQUOTE(JSON_EXTRACT(...)): MariaDB's unquoting form
# answers the four-character STRING 'null' for a JSON null, and a JSON null is
# what app/user_metadata.user_metadata_json writes for every key an admin left
# blank. Read that way, an account with no office reads as an office code of
# 'NULL', matches no org_offices row, and ABORTS THIS MIGRATION on any database
# where somebody has ever saved a user with a blank office. JSON_VALUE answers
# SQL NULL, which is what both statements below already handle.
_METADATA_DISTRICT_SQL = """
  NULLIF(
    LPAD(
      NULLIF(
        REGEXP_SUBSTR(
          COALESCE(JSON_VALUE(u.metadata_json, '$.district'), ''),
          '[0-9]{1,2}'
        ),
      ''),
    2, '0'),
  '')
"""

_METADATA_OFFICE_CODE_SQL = (
    "UPPER(TRIM(COALESCE(JSON_VALUE(u.metadata_json, '$.office_code'), '')))"
)


# --------------------------------------------------------------------------
# Upgrade
# --------------------------------------------------------------------------


def upgrade() -> None:
    _create_tables()
    _seed_structure()
    _add_assessment_snapshot_columns()
    _seed_viewer_role()
    _backfill_office_districts()
    _backfill_user_profiles()
    _backfill_coordinator_coverage()
    _backfill_assessment_snapshots()


# ---- 1. Tables (design §3.3) ---------------------------------------------


def _create_tables() -> None:
    # 1. Offices — GeoTech now, Maintenance when its chart arrives.
    #
    # `code` is unique WITHIN an org type, so a future maintenance office may
    # reuse WEST/NORTH/SOUTH. Every code -> office resolution therefore passes an
    # org_type; assessments and incidents always pass 'GEOTECH'.
    # uk_org_office_id_type exists only to be the parent key of the composite FK
    # on org_office_districts — `id` is its leftmost column, so InnoDB accepts it.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS org_offices (
          id BIGINT PRIMARY KEY AUTO_INCREMENT,
          code VARCHAR(16) NOT NULL,
          org_type VARCHAR(16) NOT NULL DEFAULT 'GEOTECH',
          unit_number VARCHAR(16) NULL,
          name VARCHAR(160) NOT NULL,
          short_name VARCHAR(64) NULL,
          home_city VARCHAR(64) NULL,
          home_district CHAR(2) NULL,
          home_location_label VARCHAR(64) NULL,
          is_routing_target TINYINT NOT NULL DEFAULT 1,
          is_active TINYINT NOT NULL DEFAULT 1,
          sort_order INT NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_org_office_code (org_type, code),
          UNIQUE KEY uk_org_office_id_type (id, org_type),
          INDEX idx_org_office_type_active (org_type, is_active),
          CONSTRAINT chk_org_office_org_type CHECK (org_type IN ('GEOTECH','MAINTENANCE'))
        ) ENGINE=InnoDB
        """
    )

    # 2. Districts an office serves — ROWS, not JSON. office_for_district is on
    # the incident-creation path and needs an index; JSON_CONTAINS is not one.
    #
    # The invariant is "at most one ACTIVE office OF A GIVEN ORG TYPE per
    # district". MariaDB has no partial unique index, so it is a stored generated
    # column that is NULL when the row is inactive (UNIQUE ignores NULLs).
    #
    # RTRIM(district) is not cosmetic: MariaDB refuses a bare CHAR column inside
    # ANY generated expression, stored or virtual — a CHAR's trailing spaces
    # depend on the session's PAD_CHAR_TO_FULL_LENGTH, so the reference is not
    # strictly deterministic and the server answers 1901 "Function or expression
    # ... cannot be used in the GENERATED ALWAYS AS clause". RTRIM makes the value
    # explicit and is a no-op on the zero-padded two-character codes actually
    # stored, so the key still reads 'GEOTECH:04'.
    #
    # org_type cannot be read from the parent inside a generated column, so it is
    # denormalized here and held true by the composite FK: the API cannot write a
    # district row whose type disagrees with its office. Scoping the key to
    # org_type is what lets a maintenance office cover district 04 while WEST also
    # covers it (owner decision 3).
    #
    # ON UPDATE RESTRICT, not CASCADE (the design's DDL says CASCADE and MariaDB
    # refuses it): a column a generated column reads may not carry a cascading
    # referential action — same error 1901 — because the cascade would rewrite the
    # base column without recomputing the key. RESTRICT costs nothing here.
    # org_offices.id is AUTO_INCREMENT and never updated, and re-typing an office
    # that already serves districts is exactly the kind of change that should be a
    # deliberate data migration rather than a silent cascade (design §3.8 rule 2
    # makes the same call for `code`). Move the district rows first, then re-type
    # the office.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS org_office_districts (
          id BIGINT PRIMARY KEY AUTO_INCREMENT,
          office_id BIGINT NOT NULL,
          org_type VARCHAR(16) NOT NULL DEFAULT 'GEOTECH',
          district CHAR(2) NOT NULL,
          is_primary TINYINT NOT NULL DEFAULT 1,
          is_active TINYINT NOT NULL DEFAULT 1,
          active_district_key VARCHAR(24) GENERATED ALWAYS AS
            (IF(is_active = 1, CONCAT(org_type, ':', RTRIM(district)), NULL)) STORED,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          CONSTRAINT fk_org_office_districts_office FOREIGN KEY (office_id, org_type)
            REFERENCES org_offices(id, org_type) ON UPDATE RESTRICT ON DELETE CASCADE,
          UNIQUE KEY uk_org_office_district (office_id, district),
          UNIQUE KEY uk_org_district_active (active_district_key),
          INDEX idx_org_office_districts_lookup (org_type, district, is_active)
        ) ENGINE=InnoDB
        """
    )

    # 3. Branches — and, later, maintenance regions / areas / yards.
    #
    # TWO generated keys, not one. active_key is the "one active letter per
    # office" rule and is NULL when the row is inactive OR letterless;
    # active_unit_key is the letterless half — one active unit of a given name
    # under a given parent, per office. A single key would produce
    # '<office_id>:' for every letterless unit and make the second yard in an
    # office un-insertable, which is exactly the schema change owner decision 3
    # forbids.
    #
    # fk_org_branch_parent is ON DELETE RESTRICT, not SET NULL (the design's DDL
    # says SET NULL and MariaDB refuses it): active_unit_key reads
    # parent_branch_id, and a column read by a generated column may not carry a
    # cascading referential action — error 1901, the same rule that turned the
    # office-districts FK into ON UPDATE RESTRICT. RESTRICT matches how this model
    # treats units anyway: branches and offices are DEACTIVATED, never deleted
    # (fk_org_branch_office is already ON DELETE RESTRICT), so the only behaviour
    # that changes is that a hard DELETE of a parent unit that still has children
    # is refused instead of silently orphaning them.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS org_branches (
          id BIGINT PRIMARY KEY AUTO_INCREMENT,
          office_id BIGINT NOT NULL,
          parent_branch_id BIGINT NULL,
          unit_type VARCHAR(16) NOT NULL DEFAULT 'BRANCH',
          letter VARCHAR(4) NULL,
          name VARCHAR(160) NOT NULL,
          home_city VARCHAR(64) NULL,
          home_district CHAR(2) NULL,
          home_location_label VARCHAR(64) NULL,
          chief_user_id BIGINT NULL,
          accepts_assignments TINYINT NOT NULL DEFAULT 1,
          is_active TINYINT NOT NULL DEFAULT 1,
          sort_order INT NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          active_key VARCHAR(32) GENERATED ALWAYS AS
            (IF(is_active = 1 AND letter IS NOT NULL, CONCAT(office_id, ':', letter), NULL)) STORED,
          active_unit_key VARCHAR(224) GENERATED ALWAYS AS
            (IF(is_active = 1 AND letter IS NULL,
                CONCAT(office_id, ':', COALESCE(parent_branch_id, 0), ':', unit_type, ':', name),
                NULL)) STORED,
          CONSTRAINT fk_org_branch_office FOREIGN KEY (office_id)
            REFERENCES org_offices(id) ON DELETE RESTRICT,
          CONSTRAINT fk_org_branch_parent FOREIGN KEY (parent_branch_id)
            REFERENCES org_branches(id) ON DELETE RESTRICT,
          CONSTRAINT fk_org_branch_chief FOREIGN KEY (chief_user_id)
            REFERENCES users(id) ON DELETE SET NULL,
          UNIQUE KEY uk_org_branch_active_letter (active_key),
          UNIQUE KEY uk_org_branch_active_unit (active_unit_key),
          INDEX idx_org_branch_office_active (office_id, is_active, sort_order),
          INDEX idx_org_branch_natural (office_id, unit_type, letter),
          CONSTRAINT chk_org_branch_unit_type
            CHECK (unit_type IN ('BRANCH','REGION','AREA','YARD'))
        ) ENGINE=InnoDB
        """
    )

    # 4. Districts a branch covers. Seeded EMPTY for every office: no chart
    # states branch-to-district coverage anywhere, so the first row entered will
    # be somebody's judgement. `source` is what keeps a charted fact
    # distinguishable from a guess (design §10, open question 1).
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS org_branch_districts (
          id BIGINT PRIMARY KEY AUTO_INCREMENT,
          branch_id BIGINT NOT NULL,
          district CHAR(2) NOT NULL,
          source VARCHAR(16) NOT NULL DEFAULT 'ADMIN',
          notes VARCHAR(255) NULL,
          is_active TINYINT NOT NULL DEFAULT 1,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          CONSTRAINT fk_org_branch_districts_branch FOREIGN KEY (branch_id)
            REFERENCES org_branches(id) ON DELETE CASCADE,
          UNIQUE KEY uk_org_branch_district (branch_id, district),
          INDEX idx_org_branch_districts_lookup (district, is_active),
          CONSTRAINT chk_org_branch_district_source
            CHECK (source IN ('CHART','INFERRED','ADMIN'))
        ) ENGINE=InnoDB
        """
    )

    # 5. Membership + the identity fields Entra ID will populate.
    #
    # A 1:1 table rather than columns on `users`, for three reasons (design
    # §3.1): 0001_baseline forbids adding columns to the fresh-install schema
    # file, so a new table is the only shape both install paths create
    # identically; `users` is the authentication hot path and its metadata_json
    # is replaced WHOLESALE by the admin PATCH, so org facts kept there would be
    # silently destroyed; and one row shape serves both hierarchies — a
    # maintenance reporter's branch_id points at a YARD, a Staff member's at a
    # BRANCH.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS org_user_profiles (
          user_id BIGINT PRIMARY KEY,
          office_id BIGINT NULL,
          branch_id BIGINT NULL,
          home_city VARCHAR(64) NULL,
          home_district CHAR(2) NULL,
          classification_code VARCHAR(8) NULL,
          classification_marker VARCHAR(8) NULL,
          position_number VARCHAR(32) NULL,
          job_title VARCHAR(96) NULL,
          level_code VARCHAR(8) NULL,
          supervisor_user_id BIGINT NULL,
          availability VARCHAR(16) NOT NULL DEFAULT 'AVAILABLE',
          available_from DATE NULL,
          available_until DATE NULL,
          source VARCHAR(16) NOT NULL DEFAULT 'MANUAL',
          notes VARCHAR(255) NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          CONSTRAINT fk_org_profile_user FOREIGN KEY (user_id)
            REFERENCES users(id) ON DELETE CASCADE,
          CONSTRAINT fk_org_profile_office FOREIGN KEY (office_id)
            REFERENCES org_offices(id) ON DELETE SET NULL,
          CONSTRAINT fk_org_profile_branch FOREIGN KEY (branch_id)
            REFERENCES org_branches(id) ON DELETE SET NULL,
          CONSTRAINT fk_org_profile_supervisor FOREIGN KEY (supervisor_user_id)
            REFERENCES users(id) ON DELETE SET NULL,
          INDEX idx_org_profile_office (office_id, branch_id),
          INDEX idx_org_profile_branch (branch_id),
          INDEX idx_org_profile_district (home_district),
          INDEX idx_org_profile_class (classification_code),
          CONSTRAINT chk_org_profile_availability
            CHECK (availability IN ('AVAILABLE','ROTATION_OUT','ACTING_ELSEWHERE','UNAVAILABLE'))
        ) ENGINE=InnoDB
        """
    )

    # 6. Coordinator coverage: one coordinator may cover several districts, and
    # one district may have several coordinators. is_primary gives notification a
    # deterministic first recipient (design §3.6, open question 10).
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS org_coordinator_coverage (
          id BIGINT PRIMARY KEY AUTO_INCREMENT,
          district CHAR(2) NOT NULL,
          user_id BIGINT NOT NULL,
          is_primary TINYINT NOT NULL DEFAULT 1,
          is_active TINYINT NOT NULL DEFAULT 1,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          CONSTRAINT fk_org_coverage_user FOREIGN KEY (user_id)
            REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE KEY uk_org_coverage (district, user_id),
          INDEX idx_org_coverage_lookup (district, is_active, is_primary)
        ) ENGINE=InnoDB
        """
    )

    # 7. Classification -> role rules, as DATA: concrete classes AND the two
    # general rules. Every part of the natural key is NOT NULL with a '' default
    # so the seed upsert stays deterministic and re-runnable.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS org_classifications (
          id BIGINT PRIMARY KEY AUTO_INCREMENT,
          rule_kind VARCHAR(16) NOT NULL DEFAULT 'CLASS',
          class_code VARCHAR(8) NOT NULL DEFAULT '',
          marker VARCHAR(8) NOT NULL DEFAULT '',
          title_pattern VARCHAR(96) NOT NULL DEFAULT '',
          level_code VARCHAR(8) NOT NULL DEFAULT '',
          title VARCHAR(96) NOT NULL,
          eris_role VARCHAR(64) NULL,
          is_supervisor TINYINT NOT NULL DEFAULT 0,
          priority INT NOT NULL DEFAULT 100,
          notes VARCHAR(255) NULL,
          is_active TINYINT NOT NULL DEFAULT 1,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_org_classification (rule_kind, class_code, marker, title_pattern, level_code),
          INDEX idx_org_classification_lookup (is_active, priority),
          CONSTRAINT chk_org_classification_kind CHECK (rule_kind IN ('CLASS','PATTERN'))
        ) ENGINE=InnoDB
        """
    )


# ---- 2. Structure seed (design §3.7 step 2, §10) --------------------------


def _seed_structure() -> None:
    """Insert the five offices, seventeen branches and sixteen rules — once.

    Every statement is ``INSERT ... SELECT ... WHERE NOT EXISTS`` keyed on a
    STABLE NATURAL TUPLE: offices on ``(org_type, code)``, branches on
    ``(office_id, unit_type, letter)``, rules on the five-part rule key.

    NOT ``ON DUPLICATE KEY UPDATE`` over a generated column — ``active_key`` is
    NULL on a deactivated branch, so an upsert keyed on it would insert a SECOND
    Branch D the moment an admin deactivated the first, and the clean base->head
    CI job re-runs this revision on every build. Insert-only also means a re-run
    never overwrites an admin's edit.
    """
    bind = op.get_bind()

    for (code, unit_number, name, short_name, home_city, home_district,
         home_location_label, is_routing_target, sort_order) in _OFFICES:
        bind.execute(
            text(
                """
                INSERT INTO org_offices
                  (code, org_type, unit_number, name, short_name, home_city,
                   home_district, home_location_label, is_routing_target, is_active, sort_order)
                SELECT :code, 'GEOTECH', :unit_number, :name, :short_name, :home_city,
                       :home_district, :home_location_label, :is_routing_target, 1, :sort_order
                  FROM DUAL
                 WHERE NOT EXISTS (
                   SELECT 1 FROM org_offices o WHERE o.org_type = 'GEOTECH' AND o.code = :code
                 )
                """
            ),
            {
                "code": code,
                "unit_number": unit_number,
                "name": name,
                "short_name": short_name,
                "home_city": home_city,
                "home_district": home_district,
                "home_location_label": home_location_label,
                "is_routing_target": is_routing_target,
                "sort_order": sort_order,
            },
        )

    for (office_code, letter, name, home_city, home_district, home_location_label,
         accepts_assignments, sort_order) in _BRANCHES:
        bind.execute(
            text(
                """
                INSERT INTO org_branches
                  (office_id, parent_branch_id, unit_type, letter, name, home_city,
                   home_district, home_location_label, chief_user_id,
                   accepts_assignments, is_active, sort_order)
                SELECT o.id, NULL, 'BRANCH', :letter, :name, :home_city,
                       :home_district, :home_location_label, NULL,
                       :accepts_assignments, 1, :sort_order
                  FROM org_offices o
                 WHERE o.org_type = 'GEOTECH' AND o.code = :office_code
                   AND NOT EXISTS (
                     SELECT 1 FROM org_branches b
                      WHERE b.office_id = o.id AND b.unit_type = 'BRANCH' AND b.letter = :letter
                   )
                """
            ),
            {
                "office_code": office_code,
                "letter": letter,
                "name": name,
                "home_city": home_city,
                "home_district": home_district,
                "home_location_label": home_location_label,
                "accepts_assignments": accepts_assignments,
                "sort_order": sort_order,
            },
        )

    for (rule_kind, class_code, marker, title_pattern, level_code, title, eris_role,
         is_supervisor, priority, notes) in _CLASSIFICATIONS:
        bind.execute(
            text(
                """
                INSERT INTO org_classifications
                  (rule_kind, class_code, marker, title_pattern, level_code, title,
                   eris_role, is_supervisor, priority, notes, is_active)
                SELECT :rule_kind, :class_code, :marker, :title_pattern, :level_code, :title,
                       :eris_role, :is_supervisor, :priority, :notes, 1
                  FROM DUAL
                 WHERE NOT EXISTS (
                   SELECT 1 FROM org_classifications c
                    WHERE c.rule_kind = :rule_kind
                      AND c.class_code = :class_code
                      AND c.marker = :marker
                      AND c.title_pattern = :title_pattern
                      AND c.level_code = :level_code
                 )
                """
            ),
            {
                "rule_kind": rule_kind,
                "class_code": class_code,
                "marker": marker,
                "title_pattern": title_pattern,
                "level_code": level_code,
                "title": title,
                "eris_role": eris_role,
                "is_supervisor": is_supervisor,
                "priority": priority,
                "notes": notes,
            },
        )


# ---- 3. Assessment snapshots (design §3.5, §3.7 step 3) -------------------


def _add_assessment_snapshot_columns() -> None:
    """Freeze the office and branch NAME onto the assessment at routing time.

    Today ``assessments`` stores only ``office_code``, so renaming an office or
    retiring a branch silently rewrites every historical record — which owner
    decision 8 forbids. Clients render the snapshot and fall back to the live
    record only when it is NULL (pre-migration rows).
    """
    op.execute(
        """
        ALTER TABLE assessments
          ADD COLUMN IF NOT EXISTS routed_office_id BIGINT NULL AFTER office_override_reason,
          ADD COLUMN IF NOT EXISTS routed_office_name VARCHAR(160) NULL AFTER routed_office_id,
          ADD COLUMN IF NOT EXISTS routed_branch_id BIGINT NULL AFTER routed_office_name,
          ADD COLUMN IF NOT EXISTS routed_branch_name VARCHAR(160) NULL AFTER routed_branch_id,
          ADD COLUMN IF NOT EXISTS routed_branch_letter VARCHAR(4) NULL AFTER routed_branch_name,
          ADD INDEX IF NOT EXISTS idx_assessment_routed_office (routed_office_id)
        """
    )
    # THE ONE STEP THAT IS NOT FREE TO REPEAT (design §13.4). MariaDB has no
    # ADD CONSTRAINT IF NOT EXISTS, so each FK is a DROP-IF-EXISTS + ADD pair —
    # the routing-v2 convention — and that takes a metadata lock on a large, hot
    # table. Schedule the upgrade accordingly.
    op.execute("ALTER TABLE assessments DROP CONSTRAINT IF EXISTS fk_assessment_routed_office")
    op.execute(
        """
        ALTER TABLE assessments
          ADD CONSTRAINT fk_assessment_routed_office FOREIGN KEY (routed_office_id)
          REFERENCES org_offices(id) ON DELETE SET NULL
        """
    )
    op.execute("ALTER TABLE assessments DROP CONSTRAINT IF EXISTS fk_assessment_routed_branch")
    op.execute(
        """
        ALTER TABLE assessments
          ADD CONSTRAINT fk_assessment_routed_branch FOREIGN KEY (routed_branch_id)
          REFERENCES org_branches(id) ON DELETE SET NULL
        """
    )


# ---- 4. The viewer role (design §3.7 step 4, §4) --------------------------


def _seed_viewer_role() -> None:
    """Create the role row; grant it to nobody.

    ``roles.name`` is UNIQUE, so this is the upgrade path;
    ``database/init/020_seed.sql`` is the fresh-install path and carries the same
    row, because the clean base->head CI job never loads the seed. The viewer
    ships behind no flag but with no accounts: nobody holds it until an admin
    grants it (design §13.8).
    """
    op.execute(
        """
        INSERT INTO roles (name, description) VALUES
          ('CALTRANS_VIEWER', 'Viewer: read-only access to approved records')
        ON DUPLICATE KEY UPDATE description = VALUES(description)
        """
    )


# ---- 5. org_office_districts <- geotech_office_routing (step 5) -----------


def _backfill_office_districts() -> None:
    """The twelve existing routing rows become the one-time seed of the real table.

    Keyed on ``uk_org_office_district (office_id, district)`` — a stable natural
    key, never the generated column. ``geotech_office_routing`` stays in place for
    one release so a rollback to the previous backend still routes;
    ``services/org_directory.py`` is its only writer from here on, and revision
    ``20260912_drop_geotech_office_routing`` drops it (design §13.6).
    """
    op.execute(
        """
        INSERT INTO org_office_districts (office_id, org_type, district, is_primary, is_active)
        SELECT o.id, 'GEOTECH', r.district, 1, r.is_active
          FROM geotech_office_routing r
          JOIN org_offices o ON o.code = r.office_code AND o.org_type = 'GEOTECH'
        ON DUPLICATE KEY UPDATE is_active = VALUES(is_active)
        """
    )


# ---- 6. org_user_profiles <- users.metadata_json (step 6) -----------------


def _backfill_user_profiles() -> None:
    """One row for EVERY active user — including users with no office.

    A user with no ``office_code`` gets a row whose ``office_id IS NULL``. That is
    exactly why ``resolve_user_org``'s fallback keys on ``office_id IS NULL`` and
    not on the row being absent (design §3.2): after this backfill, row absence
    means "created since the migration", not "has no office".

    REFUSAL INVARIANT: an active user whose non-blank ``office_code`` matches no
    GeoTech office aborts the migration by name. ``office_code`` is free text
    today, so guessing what ``W`` or ``WEST GEOTECH`` meant would silently
    misroute a chief's queue. The pre-flight query in this module's docstring is
    how an operator sees the list before running anything.
    """
    bind = op.get_bind()
    unresolvable = bind.execute(
        text(
            f"""
            SELECT u.id, u.email, {_METADATA_OFFICE_CODE_SQL} AS office_code
              FROM users u
             WHERE u.is_active = 1
               AND {_METADATA_OFFICE_CODE_SQL} <> ''
               AND NOT EXISTS (
                 SELECT 1 FROM org_offices o
                  WHERE o.org_type = 'GEOTECH' AND o.code = {_METADATA_OFFICE_CODE_SQL}
               )
             ORDER BY office_code, u.id
            """
        )
    ).mappings().all()
    if unresolvable:
        codes = sorted({str(r["office_code"]) for r in unresolvable})
        ids = ", ".join(str(int(r["id"])) for r in unresolvable)
        raise RuntimeError(
            f"The org model cannot resolve the office of {len(unresolvable)} active "
            f"user(s): id in ({ids}); office_code in ({', '.join(codes)}). "
            "users.metadata_json.office_code is free text and no GeoTech office "
            "carries these codes, so the backfill will not guess. Add the office "
            "with an INSERT INTO org_offices, or correct the accounts, e.g.\n"
            "  UPDATE users SET metadata_json = JSON_SET(metadata_json, '$.office_code', 'WEST') "
            f"WHERE id IN ({ids});\n"
            "then re-run `alembic upgrade head`. The pre-flight SELECT in this "
            "revision's docstring lists exactly these accounts."
        )

    # NOT EXISTS on user_id, so a re-run adds only accounts created since the last
    # one and never overwrites an admin's edit. branch_id is deliberately NOT
    # backfilled: nothing in the database says who is in Branch C. A branch chief
    # with branch_id IS NULL is GROUPED under "Branch not recorded" rather than
    # hidden — fail open on display, fail closed on authority, and no authority
    # check in this design keys on branch_id.
    op.execute(
        f"""
        INSERT INTO org_user_profiles
          (user_id, office_id, branch_id, home_district, availability, source, notes)
        SELECT u.id,
               (SELECT o.id FROM org_offices o
                 WHERE o.org_type = 'GEOTECH' AND o.code = {_METADATA_OFFICE_CODE_SQL}
                 LIMIT 1),
               NULL,
               {_METADATA_DISTRICT_SQL},
               'AVAILABLE',
               'BACKFILL',
               NULL
          FROM users u
         WHERE u.is_active = 1
           AND NOT EXISTS (SELECT 1 FROM org_user_profiles p WHERE p.user_id = u.id)
        """
    )


# ---- 7. org_coordinator_coverage <- users (step 7) ------------------------


def _backfill_coordinator_coverage() -> None:
    """Every active coordinator's single metadata district becomes one coverage row.

    Multi-district coverage is what the table exists for; the backfill can only
    know what ``metadata_json.district`` recorded, which is one district per
    person. Admins add the rest.
    """
    op.execute(
        f"""
        INSERT INTO org_coordinator_coverage (district, user_id, is_primary, is_active)
        SELECT {_METADATA_DISTRICT_SQL} AS district, u.id, 1, 1
          FROM users u
          JOIN user_roles ur ON ur.user_id = u.id
          JOIN roles r ON r.id = ur.role_id
         WHERE u.is_active = 1
           AND r.name IN ('MAINTENANCE_COORDINATOR', 'MAINT_COORDINATOR')
           AND {_METADATA_DISTRICT_SQL} IS NOT NULL
         GROUP BY district, u.id
        ON DUPLICATE KEY UPDATE is_active = VALUES(is_active)
        """
    )


# ---- 8. Assessment snapshot backfill (step 8) ----------------------------


def _backfill_assessment_snapshots() -> None:
    """Stamp the office snapshot onto existing assessments; leave branches NULL.

    Only where the snapshot is NULL, so the statement is re-runnable and never
    rewrites a snapshot already frozen at routing time. Branch snapshots stay
    NULL because the data does not exist — the picker's "Branch not recorded"
    group is what keeps those chiefs visible.

    Safe against the assessment triggers: ``trg_assessment_engineer_elig_bu``
    fires only when ``assigned_engineer_user_id`` actually changes, and
    ``trg_assessment_no_new_finalize`` only when the state moves INTO FINALIZED.
    """
    op.execute(
        """
        UPDATE assessments a
          JOIN org_offices o ON o.org_type = 'GEOTECH' AND o.code = a.office_code
           SET a.routed_office_id = o.id,
               a.routed_office_name = o.name
         WHERE a.routed_office_id IS NULL
           AND a.office_code IS NOT NULL
           AND a.office_code <> ''
        """
    )


# --------------------------------------------------------------------------
# Downgrade
# --------------------------------------------------------------------------


def downgrade() -> None:
    """Drop the org model.

    THIS UN-GRANTS EVERY VIEWER. The ``CALTRANS_VIEWER`` role row goes, and its
    ``user_roles`` grants follow by ON DELETE CASCADE — real data loss for every
    viewer account an admin created, which a later upgrade does not restore
    (design §13.9). It also discards every office, branch, membership,
    classification and coverage row an admin has entered, and every office/branch
    snapshot frozen onto an assessment; ``assessments.office_code`` is untouched,
    so routing and review authority survive.
    """
    # The assessment foreign keys first: org_offices and org_branches cannot be
    # dropped while they are referenced.
    op.execute("ALTER TABLE assessments DROP CONSTRAINT IF EXISTS fk_assessment_routed_branch")
    op.execute("ALTER TABLE assessments DROP CONSTRAINT IF EXISTS fk_assessment_routed_office")
    op.execute("ALTER TABLE assessments DROP INDEX IF EXISTS idx_assessment_routed_office")
    op.execute("ALTER TABLE assessments DROP COLUMN IF EXISTS routed_branch_letter")
    op.execute("ALTER TABLE assessments DROP COLUMN IF EXISTS routed_branch_name")
    op.execute("ALTER TABLE assessments DROP COLUMN IF EXISTS routed_branch_id")
    op.execute("ALTER TABLE assessments DROP COLUMN IF EXISTS routed_office_name")
    op.execute("ALTER TABLE assessments DROP COLUMN IF EXISTS routed_office_id")

    # Then the tables, children before parents.
    op.execute("DROP TABLE IF EXISTS org_branch_districts")
    op.execute("DROP TABLE IF EXISTS org_office_districts")
    op.execute("DROP TABLE IF EXISTS org_coordinator_coverage")
    op.execute("DROP TABLE IF EXISTS org_user_profiles")
    op.execute("DROP TABLE IF EXISTS org_classifications")
    op.execute("DROP TABLE IF EXISTS org_branches")
    op.execute("DROP TABLE IF EXISTS org_offices")

    op.execute("DELETE FROM roles WHERE name = 'CALTRANS_VIEWER'")

"""``20260911_org_model``: what it installs, what it refuses, what it re-runs.

The clean base->head path is a CI job (``.github/workflows/ci.yml`` stamps
``0001_baseline`` and upgrades head, then upgrades head a SECOND time to prove
the whole chain is a no-op on re-run). This module is the part that job cannot
express, and each case is a specific failure the design went looking for:

* **Everything the revision claims to install is really there** — seven tables,
  five snapshot columns, two foreign keys and the role row. "The upgrade ran"
  and "the upgrade did all of it" are different statements.
* **Re-running the structure seed is a no-op EVEN AFTER an admin has deactivated
  a seeded branch.** This is the case revision 1's key got wrong: it upserted on
  the generated ``active_key``, which is NULL on a deactivated row, so the next
  clean base->head build would have inserted a SECOND Branch D. The seed is
  therefore ``INSERT ... WHERE NOT EXISTS`` on a stable natural tuple, and this
  is the test that says so.
* **The profile backfill REFUSES rather than guesses**, naming the offending
  codes and the offending user ids, and the pre-flight SELECT documented in the
  revision and in ``docs/MIGRATIONS.md`` returns exactly those accounts.
* **``downgrade()`` leaves ``users`` and ``assessments`` readable** — and
  un-grants every viewer, which is real data loss and must be in the release
  note.

HOW THE RE-RUNS ARE EXERCISED WITHOUT A SECOND DATABASE: the revision's steps are
plain DML, so each one runs here inside a transaction that is ROLLED BACK, with
the module's ``op`` temporarily bound to an Alembic ``Operations`` on that
connection. The DDL steps are not re-run that way (MariaDB DDL is not
transactional); their idempotence is the CI job's second ``upgrade head``.

Requires a live MariaDB at Alembic head. Run with: pytest -m db
"""

from __future__ import annotations

import re
import uuid
from contextlib import contextmanager
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import text

pytestmark = pytest.mark.db

_RUN = uuid.uuid4().hex[:8]

_REPO_ROOT = Path(__file__).resolve().parents[2]
_MIGRATIONS_DOC = _REPO_ROOT / "docs" / "MIGRATIONS.md"


# ---------------------------------------------------------------------------
# Running a revision step against a transaction that is thrown away
# ---------------------------------------------------------------------------


@contextmanager
def revision_ops(revision):
    """Bind the revision module's ``op`` to a rolled-back transaction.

    Everything yielded here is discarded, so a step may insert, refuse or half-do
    its work without touching the shared database.
    """
    from app.db import engine

    connection = engine.connect()
    transaction = connection.begin()
    operations = Operations(MigrationContext.configure(connection))
    original = revision.op
    revision.op = operations
    try:
        yield connection
    finally:
        revision.op = original
        transaction.rollback()
        connection.close()


class _RecordingOps:
    """An ``op`` that records SQL instead of running it, for reading a step."""

    def __init__(self):
        self.statements: list[str] = []

    def execute(self, statement, *args, **kwargs):
        self.statements.append(" ".join(str(statement).split()))

    def get_bind(self):  # pragma: no cover - a failure path
        raise AssertionError("this step needs a real connection; run it under revision_ops")


def _counts(connection) -> dict[str, int]:
    tables = (
        "org_offices",
        "org_branches",
        "org_office_districts",
        "org_branch_districts",
        "org_classifications",
        "org_user_profiles",
        "org_coordinator_coverage",
    )
    return {
        table: int(connection.execute(text(f"SELECT COUNT(*) FROM {table}")).scalar()) for table in tables
    }


def _rows(sql: str, params: dict | None = None) -> list[dict]:
    from app.db import engine

    with engine.connect() as conn:
        return [dict(row) for row in conn.execute(text(sql), params or {}).mappings().all()]


# ---------------------------------------------------------------------------
# The upgrade really installed everything it claims
# ---------------------------------------------------------------------------


class TestUpgradeApplied:
    def test_the_revision_sits_after_routing_v2(self, org_model_revision):
        assert org_model_revision.revision == "20260911_org_model"
        assert org_model_revision.down_revision == "20260910_routing_v2"

    @pytest.mark.parametrize(
        "table",
        [
            "org_offices",
            "org_office_districts",
            "org_branches",
            "org_branch_districts",
            "org_user_profiles",
            "org_coordinator_coverage",
            "org_classifications",
        ],
    )
    def test_all_seven_tables_exist(self, client_db, table):
        assert _rows(
            "SELECT 1 AS present FROM information_schema.TABLES "
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t",
            {"t": table},
        ), f"{table} was not created"

    @pytest.mark.parametrize(
        "column",
        ["routed_office_id", "routed_office_name", "routed_branch_id", "routed_branch_name", "routed_branch_letter"],
    )
    def test_the_five_assessment_snapshot_columns_exist(self, client_db, column):
        assert _rows(
            "SELECT 1 AS present FROM information_schema.COLUMNS "
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'assessments' AND COLUMN_NAME = :c",
            {"c": column},
        ), f"assessments.{column} is missing"

    @pytest.mark.parametrize(
        "constraint", ["fk_assessment_routed_office", "fk_assessment_routed_branch"]
    )
    def test_the_two_assessment_foreign_keys_exist(self, client_db, constraint):
        assert _rows(
            "SELECT 1 AS present FROM information_schema.TABLE_CONSTRAINTS "
            "WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'assessments' "
            "AND CONSTRAINT_NAME = :c",
            {"c": constraint},
        ), f"{constraint} is missing"

    def test_the_two_scoped_uniqueness_keys_exist(self, client_db):
        # The pair owner decision 3 turns on: one ACTIVE letter per office, and
        # separately one active letterless unit per (office, parent, type, name).
        # A single key would have made the second yard in an office un-insertable.
        names = {
            row["INDEX_NAME"]
            for row in _rows(
                "SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS "
                "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'org_branches'"
            )
        }
        assert {"uk_org_branch_active_letter", "uk_org_branch_active_unit"} <= names

    def test_the_viewer_role_row_exists(self, client_db):
        # This revision seeded CALTRANS_VIEWER; at head it is GUEST, which
        # 20260923_roles_consolidated moved every holder onto.
        assert int(_rows("SELECT COUNT(*) AS n FROM roles WHERE name = 'GUEST'")[0]["n"]) == 1
        assert int(_rows("SELECT COUNT(*) AS n FROM roles WHERE name = 'CALTRANS_VIEWER'")[0]["n"]) == 0

    def test_the_legacy_routing_table_survives_for_one_release(self, client_db):
        # It is kept so a rollback to the previous backend still routes;
        # org_directory is its only writer and the FOLLOW-UP revision
        # 20260912_drop_geotech_office_routing (not in this release) is what
        # drops it.
        assert _rows(
            "SELECT 1 AS present FROM information_schema.TABLES "
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'geotech_office_routing'"
        )


# ---------------------------------------------------------------------------
# Re-running the revision's DML steps changes nothing
# ---------------------------------------------------------------------------


class TestReRunIsANoOp:
    def test_the_structure_seed_inserts_nothing_the_second_time(self, client_db, org_model_revision):
        with revision_ops(org_model_revision) as connection:
            before = _counts(connection)
            org_model_revision._seed_structure()
            after = _counts(connection)
        assert after == before

    def test_the_structure_seed_is_still_a_no_op_after_a_branch_is_deactivated(
        self, client_db, org_model_revision
    ):
        # THE regression case. `active_key` is NULL on a deactivated row, so an
        # upsert keyed on it would see no conflict and insert a SECOND WEST
        # Branch D — on the very next clean base->head build, silently, in a
        # table an admin is looking at.
        with revision_ops(org_model_revision) as connection:
            branch_id = connection.execute(
                text(
                    """
                    SELECT b.id FROM org_branches b JOIN org_offices o ON o.id = b.office_id
                     WHERE o.code = 'WEST' AND b.letter = 'D' LIMIT 1
                    """
                )
            ).scalar()
            assert branch_id, "the WEST Branch D seed row is missing"
            connection.execute(
                text("UPDATE org_branches SET is_active = 0 WHERE id = :bid"), {"bid": int(branch_id)}
            )
            before = _counts(connection)
            org_model_revision._seed_structure()
            after = _counts(connection)
            assert after == before
            # ...and specifically: still exactly one WEST Branch D, the retired one.
            rows = connection.execute(
                text(
                    """
                    SELECT b.id, b.is_active FROM org_branches b JOIN org_offices o ON o.id = b.office_id
                     WHERE o.code = 'WEST' AND b.letter = 'D'
                    """
                )
            ).mappings().all()
            assert len(rows) == 1
            assert int(rows[0]["is_active"]) == 0

    def test_the_structure_seed_does_not_overwrite_an_admins_edit(self, client_db, org_model_revision):
        # Insert-only, never ON DUPLICATE KEY UPDATE: a re-run must not restore
        # the chart's name over the one an admin chose.
        with revision_ops(org_model_revision) as connection:
            connection.execute(
                text("UPDATE org_offices SET name = :n WHERE code = 'WEST' AND org_type = 'GEOTECH'"),
                {"n": f"West, renamed by an admin {_RUN}"},
            )
            org_model_revision._seed_structure()
            name = connection.execute(
                text("SELECT name FROM org_offices WHERE code = 'WEST' AND org_type = 'GEOTECH'")
            ).scalar()
            assert name == f"West, renamed by an admin {_RUN}"

    # _seed_viewer_role is not here: 20260923_roles_consolidated turned its
    # CALTRANS_VIEWER row into GUEST, so re-running this revision's step against
    # a database at head would re-create a retired role, not change nothing.
    @pytest.mark.parametrize(
        "step",
        ["_backfill_office_districts", "_backfill_assessment_snapshots"],
    )
    def test_each_one_time_backfill_changes_nothing_the_second_time(
        self, client_db, org_model_revision, step
    ):
        with revision_ops(org_model_revision) as connection:
            before = _counts(connection)
            role_rows = int(connection.execute(text("SELECT COUNT(*) FROM roles")).scalar())
            getattr(org_model_revision, step)()
            assert _counts(connection) == before
            assert int(connection.execute(text("SELECT COUNT(*) FROM roles")).scalar()) == role_rows

    @pytest.mark.parametrize("step", ["_backfill_user_profiles", "_backfill_coordinator_coverage"])
    def test_each_per_user_backfill_settles_after_one_run(self, client_db, org_model_revision, step):
        # These two are keyed on the USER, so a re-run legitimately picks up
        # accounts created since the last one — that is the documented behaviour,
        # not drift. What must never happen is a second run adding anything on
        # top of the first: no duplicate row, no resurrection, no growth.
        with revision_ops(org_model_revision) as connection:
            getattr(org_model_revision, step)()
            settled = _counts(connection)
            getattr(org_model_revision, step)()
            assert _counts(connection) == settled

    def test_the_profile_backfill_gives_exactly_the_missing_accounts_a_row(
        self, client_db, org_model_revision
    ):
        with revision_ops(org_model_revision) as connection:
            missing = int(
                connection.execute(
                    text(
                        """
                        SELECT COUNT(*) FROM users u
                         WHERE u.is_active = 1
                           AND NOT EXISTS (SELECT 1 FROM org_user_profiles p WHERE p.user_id = u.id)
                        """
                    )
                ).scalar()
            )
            before = _counts(connection)["org_user_profiles"]
            org_model_revision._backfill_user_profiles()
            assert _counts(connection)["org_user_profiles"] == before + missing

    def test_the_profile_backfill_never_overwrites_an_existing_row(self, client_db, org_model_revision):
        # NOT EXISTS on user_id, never ON DUPLICATE KEY UPDATE: an admin who has
        # moved somebody must not be undone by a re-run.
        with revision_ops(org_model_revision) as connection:
            user_id = int(
                connection.execute(text("SELECT user_id FROM org_user_profiles LIMIT 1")).scalar()
            )
            connection.execute(
                text("UPDATE org_user_profiles SET job_title = :t, source = 'MANUAL' WHERE user_id = :id"),
                {"t": f"Set by an admin {_RUN}", "id": user_id},
            )
            org_model_revision._backfill_user_profiles()
            row = connection.execute(
                text("SELECT job_title, source FROM org_user_profiles WHERE user_id = :id"),
                {"id": user_id},
            ).mappings().first()
            assert row["job_title"] == f"Set by an admin {_RUN}"
            assert row["source"] == "MANUAL"


# ---------------------------------------------------------------------------
# The refusal, and the pre-flight query that predicts it
# ---------------------------------------------------------------------------


_PREFLIGHT_RE = re.compile(r"(SELECT\s+u\.id,\s*u\.email,.*?ORDER BY office_code, u\.id;)", re.DOTALL)


def _preflight_sql(source: str) -> str:
    match = _PREFLIGHT_RE.search(source)
    assert match, "the documented pre-flight SELECT could not be found"
    return " ".join(match.group(1).rstrip(";").split())


class TestTheBackfillRefusesRatherThanGuesses:
    def _plant_unresolvable_user(self, connection, code: str) -> int:
        email = f"orgmodel-badoffice-{_RUN}-{code.lower().replace(' ', '')}@example.test"
        connection.execute(
            text(
                """
                INSERT INTO users (email, full_name, password_hash, metadata_json, is_active)
                VALUES (:email, :name, 'x', JSON_OBJECT('office_code', :code), 1)
                """
            ),
            {"email": email, "name": f"Unresolvable office {code}", "code": code},
        )
        return int(connection.execute(text("SELECT id FROM users WHERE email = :e"), {"e": email}).scalar())

    def test_it_raises_naming_the_codes_and_the_user_ids(self, client_db, org_model_revision):
        with revision_ops(org_model_revision) as connection:
            first = self._plant_unresolvable_user(connection, "WEST GEOTECH")
            second = self._plant_unresolvable_user(connection, "W")
            with pytest.raises(RuntimeError) as excinfo:
                org_model_revision._backfill_user_profiles()
            message = str(excinfo.value)
            # Both halves matter: the codes tell an operator WHAT to add, the ids
            # tell them WHICH accounts to correct.
            assert "WEST GEOTECH" in message
            assert str(first) in message and str(second) in message
            assert "will not guess" in message
            # ...and it refused BEFORE writing anything.
            planted = connection.execute(
                text("SELECT COUNT(*) FROM org_user_profiles WHERE user_id IN (:a, :b)"),
                {"a": first, "b": second},
            ).scalar()
            assert int(planted) == 0

    def test_an_inactive_account_does_not_block_the_migration(self, client_db, org_model_revision):
        # Only ACTIVE users are backfilled, so a retired account with a junk
        # office code must not hold up an upgrade.
        with revision_ops(org_model_revision) as connection:
            user_id = self._plant_unresolvable_user(connection, "W")
            connection.execute(text("UPDATE users SET is_active = 0 WHERE id = :id"), {"id": user_id})
            org_model_revision._backfill_user_profiles()  # must not raise

    def test_a_json_null_office_code_is_not_a_refusal(self, client_db, org_model_revision):
        # users.metadata_json carries an explicit JSON null for every key an
        # admin left blank — that is what user_metadata_json writes. MariaDB's
        # JSON_UNQUOTE(JSON_EXTRACT(...)) answers the four-character STRING
        # 'null' for one, so read that way an ordinary account with no office
        # looks like an office code of NULL that matches nothing, and this
        # migration ABORTS on any database where somebody once saved a user with
        # a blank office. JSON_VALUE answers SQL NULL.
        with revision_ops(org_model_revision) as connection:
            email = f"orgmodel-jsonnull-{_RUN}@example.test"
            connection.execute(
                text(
                    """
                    INSERT INTO users (email, full_name, password_hash, metadata_json, is_active)
                    VALUES (:e, 'Blank office, saved by the admin form', 'x',
                            JSON_OBJECT('district', NULL, 'office_code', NULL, 'office_location', NULL), 1)
                    """
                ),
                {"e": email},
            )
            preflight = _preflight_sql(org_model_revision.__doc__ or "")
            assert connection.execute(text(preflight)).mappings().all() == []
            org_model_revision._backfill_user_profiles()  # must not raise
            row = connection.execute(
                text(
                    """
                    SELECT p.office_id, p.home_district FROM org_user_profiles p
                      JOIN users u ON u.id = p.user_id WHERE u.email = :e
                    """
                ),
                {"e": email},
            ).mappings().first()
            assert row is not None
            assert row["office_id"] is None
            assert row["home_district"] is None

    def test_the_documented_preflight_returns_exactly_the_offending_accounts(
        self, client_db, org_model_revision
    ):
        preflight = _preflight_sql(org_model_revision.__doc__ or "")
        with revision_ops(org_model_revision) as connection:
            # Nothing to fix before the accounts are planted...
            assert connection.execute(text(preflight)).mappings().all() == []
            first = self._plant_unresolvable_user(connection, "WEST GEOTECH")
            second = self._plant_unresolvable_user(connection, "W")
            listed = connection.execute(text(preflight)).mappings().all()
            assert {int(row["id"]) for row in listed} == {first, second}
            assert {str(row["office_code"]) for row in listed} == {"WEST GEOTECH", "W"}
            # ...and the query agrees with the refusal it predicts.
            with pytest.raises(RuntimeError):
                org_model_revision._backfill_user_profiles()

    def test_the_runbook_and_the_revision_document_the_same_query(self, org_model_revision):
        # Two copies of one query is how a runbook goes stale. They must be the
        # same text, character for character once whitespace is collapsed.
        assert _preflight_sql(_MIGRATIONS_DOC.read_text(encoding="utf-8")) == _preflight_sql(
            org_model_revision.__doc__ or ""
        )

    def test_a_resolvable_office_code_is_not_a_refusal(self, client_db, org_model_revision):
        with revision_ops(org_model_revision) as connection:
            user_id = self._plant_unresolvable_user(connection, "WEST")
            org_model_revision._backfill_user_profiles()  # must not raise
            row = connection.execute(
                text(
                    """
                    SELECT p.office_id, o.code FROM org_user_profiles p
                      LEFT JOIN org_offices o ON o.id = p.office_id
                     WHERE p.user_id = :id
                    """
                ),
                {"id": user_id},
            ).mappings().first()
            assert row is not None and row["code"] == "WEST"

    def test_a_user_with_no_office_still_gets_a_row(self, client_db, org_model_revision):
        # The reason resolve_user_org's fallback keys on `office_id IS NULL` and
        # not on the row being absent: after this backfill, an absent row means
        # "created since the migration", never "has no office".
        with revision_ops(org_model_revision) as connection:
            email = f"orgmodel-nooffice-{_RUN}@example.test"
            connection.execute(
                text(
                    "INSERT INTO users (email, full_name, password_hash, metadata_json, is_active) "
                    "VALUES (:e, 'No office at all', 'x', NULL, 1)"
                ),
                {"e": email},
            )
            org_model_revision._backfill_user_profiles()
            row = connection.execute(
                text(
                    """
                    SELECT p.office_id, p.source FROM org_user_profiles p
                      JOIN users u ON u.id = p.user_id WHERE u.email = :e
                    """
                ),
                {"e": email},
            ).mappings().first()
            assert row is not None
            assert row["office_id"] is None
            assert row["source"] == "BACKFILL"


# ---------------------------------------------------------------------------
# downgrade(): what it takes, and what it must leave behind
# ---------------------------------------------------------------------------


class TestDowngrade:
    @pytest.fixture(scope="class")
    def statements(self, org_model_revision):
        recorder = _RecordingOps()
        original = org_model_revision.op
        org_model_revision.op = recorder
        try:
            org_model_revision.downgrade()
        finally:
            org_model_revision.op = original
        return recorder.statements

    def test_it_drops_all_seven_tables(self, statements):
        dropped = {
            statement.split("DROP TABLE IF EXISTS ")[1]
            for statement in statements
            if statement.startswith("DROP TABLE IF EXISTS ")
        }
        assert dropped == {
            "org_offices",
            "org_branches",
            "org_office_districts",
            "org_branch_districts",
            "org_user_profiles",
            "org_coordinator_coverage",
            "org_classifications",
        }

    def test_users_and_assessments_stay_readable(self, statements):
        # The revision's whole reach into pre-existing tables is five ADDED
        # columns, two foreign keys and one index. A downgrade takes back exactly
        # those and nothing else: no DROP TABLE, no TRUNCATE, no DELETE against
        # users or assessments, and assessments.office_code — which routing and
        # review authority read — is never touched.
        for statement in statements:
            upper = statement.upper()
            assert not upper.startswith("DROP TABLE IF EXISTS USERS")
            assert not upper.startswith("DROP TABLE IF EXISTS ASSESSMENTS")
            assert "TRUNCATE" not in upper
            assert "DELETE FROM USERS" not in upper
            assert "DELETE FROM ASSESSMENTS" not in upper
            assert "OFFICE_CODE" not in upper
        assessment_columns = {
            statement.split("DROP COLUMN IF EXISTS ")[1]
            for statement in statements
            if "ALTER TABLE assessments DROP COLUMN IF EXISTS " in statement
        }
        assert assessment_columns == {
            "routed_office_id",
            "routed_office_name",
            "routed_branch_id",
            "routed_branch_name",
            "routed_branch_letter",
        }

    def test_it_un_grants_every_viewer(self, statements):
        assert "DELETE FROM roles WHERE name = 'CALTRANS_VIEWER'" in statements

    def test_the_grants_really_follow_the_role_row(self, client_db):
        # The statement above is only half the claim: the user_roles rows go with
        # it by ON DELETE CASCADE. If that referential action were RESTRICT, the
        # DELETE would fail and the downgrade would abort mid-way instead.
        rule = _rows(
            """
            SELECT rc.DELETE_RULE
              FROM information_schema.REFERENTIAL_CONSTRAINTS rc
              JOIN information_schema.KEY_COLUMN_USAGE k
                ON k.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
               AND k.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
             WHERE rc.CONSTRAINT_SCHEMA = DATABASE()
               AND rc.TABLE_NAME = 'user_roles'
               AND k.REFERENCED_TABLE_NAME = 'roles'
             LIMIT 1
            """
        )
        assert rule and rule[0]["DELETE_RULE"] == "CASCADE"

    def test_the_release_note_says_so(self):
        # Real data loss that a later upgrade does not restore has to be in the
        # runbook, not only in a docstring.
        note = _MIGRATIONS_DOC.read_text(encoding="utf-8")
        assert "un-grants every viewer" in note
        assert "CALTRANS_VIEWER" in note
        assert "ON DELETE CASCADE" in note

    def test_the_revision_docstring_carries_the_same_warning(self, org_model_revision):
        assert "UN-GRANTS EVERY VIEWER" in (org_model_revision.downgrade.__doc__ or "").upper()

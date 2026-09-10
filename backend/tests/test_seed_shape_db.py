"""What the org model actually installs, counted (design §10, §12, W21).

Revision 1 of this design said the offices hold **18** branches. They hold 17.
Nobody noticed until the rows were counted, which is the whole argument for this
module: the structure seed is transcribed from org charts by hand, in two places
(the Alembic revision and ``database/init/020_seed.sql``), and a transcription
error is invisible until something counts.

Every assertion here is a count or an exact value, and each one is checked
against BOTH sources:

* the DATABASE, after ``alembic upgrade head`` (and, on a fresh install, after
  the init SQL) — what a deployment really has; and
* the REVISION's own seed lists — what the code says it installs.

Checking one without the other lets the two drift: the init SQL and the revision
seed the same rows by different routes, and an office added to one alone would
pass a single-sided test.

Requires a live MariaDB at Alembic head. Run with: pytest -m db
"""

from __future__ import annotations

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.db


SEEDED_OFFICE_CODES = ["WEST", "NORTH", "SOUTH", "POLICY", "SUPPORT"]
BRANCHES_PER_OFFICE = {"WEST": 6, "NORTH": 4, "SOUTH": 5, "POLICY": 2, "SUPPORT": 0}
SEEDED_DISTRICTS = {
    "WEST": ["01", "04", "05"],
    "NORTH": ["02", "03", "06", "09", "10"],
    "SOUTH": ["07", "08", "11", "12"],
    "POLICY": [],
    "SUPPORT": [],
}


def _rows(sql: str, params: dict | None = None) -> list[dict]:
    from app.db import engine

    with engine.connect() as conn:
        return [dict(row) for row in conn.execute(text(sql), params or {}).mappings().all()]


def _scalar(sql: str, params: dict | None = None):
    from app.db import engine

    with engine.connect() as conn:
        return conn.execute(text(sql), params or {}).scalar()


# ---------------------------------------------------------------------------
# Counts
# ---------------------------------------------------------------------------


class TestSeededCounts:
    def test_five_offices_and_no_others(self, client_db):
        codes = [
            row["code"]
            for row in _rows("SELECT code FROM org_offices WHERE org_type = 'GEOTECH' ORDER BY sort_order, code")
        ]
        assert codes == SEEDED_OFFICE_CODES, (
            "The GeoTech office set has drifted from the five seeded offices. If a test created "
            f"an office and did not remove it, that is the bug: {codes}"
        )

    def test_seventeen_branches_split_six_four_five_two_zero(self, client_db):
        counts = {
            row["code"]: int(row["branches"])
            for row in _rows(
                """
                SELECT o.code, COUNT(b.id) AS branches
                  FROM org_offices o
                  LEFT JOIN org_branches b ON b.office_id = o.id
                 WHERE o.org_type = 'GEOTECH'
                 GROUP BY o.code
                """
            )
        }
        assert counts == BRANCHES_PER_OFFICE
        assert sum(counts.values()) == 17, "revision 1 of the design said 18; the charts show 17"

    def test_twelve_office_district_rows(self, client_db):
        assert int(_scalar("SELECT COUNT(*) FROM org_office_districts WHERE org_type = 'GEOTECH'")) == 12
        by_office = {code: [] for code in SEEDED_OFFICE_CODES}
        for row in _rows(
            """
            SELECT o.code, d.district
              FROM org_office_districts d
              JOIN org_offices o ON o.id = d.office_id
             WHERE d.org_type = 'GEOTECH' AND d.is_active = 1
             ORDER BY o.code, d.district
            """
        ):
            by_office[row["code"]].append(str(row["district"]).strip())
        assert by_office == SEEDED_DISTRICTS

    def test_branch_district_coverage_is_seeded_empty(self, client_db):
        # No chart states branch-to-district coverage for ANY office — not for
        # NORTH, and not for WEST or SOUTH either. The first row entered will be
        # somebody's judgement, so it belongs to an admin and carries a `source`
        # that says so (open question 1).
        assert int(_scalar("SELECT COUNT(*) FROM org_branch_districts")) == 0

    def test_sixteen_classification_rules_fourteen_class_two_pattern(self, client_db):
        counts = {
            row["rule_kind"]: int(row["n"])
            for row in _rows("SELECT rule_kind, COUNT(*) AS n FROM org_classifications GROUP BY rule_kind")
        }
        assert counts == {"CLASS": 14, "PATTERN": 2}

    def test_exactly_one_viewer_role_row(self, client_db):
        assert int(_scalar("SELECT COUNT(*) FROM roles WHERE name = 'CALTRANS_VIEWER'")) == 1
        # ...and it is a role row, not a grant: the migration seeds the role and
        # nobody holds it until an admin grants it. Among ACTIVE accounts the dev
        # seed's viewer@local is the one exception, and it is the only one.
        holders = _rows(
            """
            SELECT u.email FROM user_roles ur
              JOIN roles r ON r.id = ur.role_id
              JOIN users u ON u.id = ur.user_id
             WHERE r.name = 'CALTRANS_VIEWER' AND u.is_active = 1
             ORDER BY u.email
            """
        )
        assert [row["email"] for row in holders] == ["viewer@local"]


# ---------------------------------------------------------------------------
# The values the charts and the owner decisions pin
# ---------------------------------------------------------------------------


class TestSeededValues:
    def test_policy_and_support_are_not_routing_targets(self, client_db):
        targets = {
            row["code"]: bool(row["is_routing_target"])
            for row in _rows("SELECT code, is_routing_target FROM org_offices WHERE org_type = 'GEOTECH'")
        }
        assert targets == {
            "WEST": True,
            "NORTH": True,
            "SOUTH": True,
            # POLICY is shaped inversely to the three design offices (specialists,
            # two subject-named branches, no district list) and SUPPORT has no
            # chart at all, so neither is offered for a district incident
            # (open question 2).
            "POLICY": False,
            "SUPPORT": False,
        }

    def test_the_south_office_is_seeded_at_los_angeles(self, client_db):
        # Two charts disagree: the office chart puts the SOUTH chief at
        # "Los Angeles, D07" and the DES executive chart at "San Diego,
        # District 11". The office chart wins until the owner says otherwise
        # (open question 14).
        row = _rows("SELECT home_city, home_district FROM org_offices WHERE code = 'SOUTH'")[0]
        assert row["home_city"] == "Los Angeles"
        assert str(row["home_district"]).strip() == "07"

    def test_the_translab_offices_carry_a_label_and_no_district(self, client_db):
        for code in ("NORTH", "POLICY", "SUPPORT"):
            row = _rows(
                "SELECT home_city, home_district, home_location_label FROM org_offices WHERE code = :c",
                {"c": code},
            )[0]
            assert row["home_city"] == "Sacramento"
            assert row["home_district"] is None, f"{code} should have no district"
            assert row["home_location_label"] == "Translab"

    def test_south_branch_e_is_proposed_and_accepts_nothing(self, client_db):
        # Dashed boxes on the chart, a vacant chief and three vacant staff. It
        # exists so the structure is complete; accepts_assignments = 0 keeps it
        # out of every picker until somebody fills it.
        row = _rows(
            """
            SELECT b.letter, b.accepts_assignments, b.is_active, b.home_city
              FROM org_branches b JOIN org_offices o ON o.id = b.office_id
             WHERE o.code = 'SOUTH' AND b.letter = 'E'
            """
        )[0]
        assert bool(row["accepts_assignments"]) is False
        assert bool(row["is_active"]) is True
        assert row["home_city"] == "San Bernardino"

    def test_every_other_seeded_branch_accepts_assignments(self, client_db):
        refusing = _rows(
            """
            SELECT o.code, b.letter FROM org_branches b
              JOIN org_offices o ON o.id = b.office_id
             WHERE b.accepts_assignments = 0
            """
        )
        assert [(row["code"], row["letter"]) for row in refusing] == [("SOUTH", "E")]

    def test_north_prints_its_branches_with_the_districts_prefix(self, client_db):
        # The printed name is not a stable key: WEST and SOUTH print "Branch A",
        # NORTH prints "Districts Branch A" and POLICY prints two subject names.
        # That is exactly why `letter` is stored separately from `name`.
        names = [
            row["name"]
            for row in _rows(
                """
                SELECT b.name FROM org_branches b JOIN org_offices o ON o.id = b.office_id
                 WHERE o.code = 'NORTH' ORDER BY b.sort_order
                """
            )
        ]
        assert names == [
            "Districts Branch A",
            "Districts Branch B",
            "Districts Branch C",
            "Districts Branch D",
        ]

    def test_no_seeded_branch_binds_a_role_to_a_named_person(self, client_db):
        # Owner decision 6: no real employee name from any chart appears in any
        # seeded row, and roles are never bound to named people.
        assert int(_scalar("SELECT COUNT(*) FROM org_branches WHERE chief_user_id IS NOT NULL")) == 0

    def test_the_undecided_class_is_seeded_with_no_role_and_a_note(self, client_db):
        row = _rows("SELECT eris_role, notes, level_code FROM org_classifications WHERE class_code = '5758'")[0]
        # eris_role NULL means "no suggestion", not "no role" (open question 15).
        assert row["eris_role"] is None
        assert row["level_code"] == "R11", "the chart prints the RDS II position at R11"
        assert "TET to RDS II" in (row["notes"] or "")

    def test_the_two_pattern_rules_resolve_after_every_class_row(self, client_db):
        highest_class = int(_scalar("SELECT MAX(priority) FROM org_classifications WHERE rule_kind = 'CLASS'"))
        lowest_pattern = int(_scalar("SELECT MIN(priority) FROM org_classifications WHERE rule_kind = 'PATTERN'"))
        assert highest_class < lowest_pattern


# ---------------------------------------------------------------------------
# The database and the revision's own seed lists must agree
# ---------------------------------------------------------------------------


class TestTheTwoSeedSourcesAgree:
    def test_the_revision_lists_match_the_counts(self, org_model_revision):
        assert len(org_model_revision._OFFICES) == 5
        assert len(org_model_revision._BRANCHES) == 17
        assert len(org_model_revision._CLASSIFICATIONS) == 16
        per_office: dict[str, int] = {code: 0 for code in SEEDED_OFFICE_CODES}
        for branch in org_model_revision._BRANCHES:
            per_office[branch[0]] += 1
        assert per_office == BRANCHES_PER_OFFICE

    @pytest.mark.parametrize("code", SEEDED_OFFICE_CODES)
    def test_each_office_row_matches_the_revision(self, client_db, org_model_revision, code):
        expected = {row[0]: row for row in org_model_revision._OFFICES}[code]
        (_, unit_number, name, short_name, home_city, home_district,
         home_location_label, is_routing_target, sort_order) = expected
        row = _rows(
            """
            SELECT unit_number, name, short_name, home_city, home_district,
                   home_location_label, is_routing_target, sort_order
              FROM org_offices WHERE org_type = 'GEOTECH' AND code = :c
            """,
            {"c": code},
        )[0]
        assert row["unit_number"] == unit_number
        assert row["name"] == name
        assert row["short_name"] == short_name
        assert row["home_city"] == home_city
        assert (str(row["home_district"]).strip() if row["home_district"] else None) == home_district
        assert row["home_location_label"] == home_location_label
        assert int(row["is_routing_target"]) == is_routing_target
        assert int(row["sort_order"]) == sort_order

    def test_every_branch_row_matches_the_revision(self, client_db, org_model_revision):
        stored = {
            (row["code"], row["letter"]): row
            for row in _rows(
                """
                SELECT o.code, b.letter, b.name, b.home_city, b.home_district,
                       b.home_location_label, b.accepts_assignments, b.sort_order, b.unit_type
                  FROM org_branches b JOIN org_offices o ON o.id = b.office_id
                 WHERE o.org_type = 'GEOTECH'
                """
            )
        }
        assert len(stored) == 17
        for (office_code, letter, name, home_city, home_district, home_location_label,
             accepts_assignments, sort_order) in org_model_revision._BRANCHES:
            row = stored[(office_code, letter)]
            assert row["unit_type"] == "BRANCH"
            assert row["name"] == name
            assert row["home_city"] == home_city
            assert (str(row["home_district"]).strip() if row["home_district"] else None) == home_district
            assert row["home_location_label"] == home_location_label
            assert int(row["accepts_assignments"]) == accepts_assignments
            assert int(row["sort_order"]) == sort_order

    def test_every_classification_rule_matches_the_revision(self, client_db, org_model_revision):
        stored = {
            (row["rule_kind"], row["class_code"], row["marker"], row["title_pattern"], row["level_code"]): row
            for row in _rows(
                """
                SELECT rule_kind, class_code, marker, title_pattern, level_code,
                       title, eris_role, is_supervisor, priority
                  FROM org_classifications
                """
            )
        }
        assert len(stored) == 16
        for (rule_kind, class_code, marker, title_pattern, level_code, title, eris_role,
             is_supervisor, priority, _notes) in org_model_revision._CLASSIFICATIONS:
            row = stored[(rule_kind, class_code, marker, title_pattern, level_code)]
            assert row["title"] == title
            assert row["eris_role"] == eris_role
            assert int(row["is_supervisor"]) == is_supervisor
            assert int(row["priority"]) == priority

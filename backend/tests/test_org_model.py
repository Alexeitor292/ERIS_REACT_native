"""No-DB unit tests for the organization model's pure logic (design §12, W17).

Three things are decided here without a database, because all three are pure
functions and all three are where a real deployment breaks first:

1. **Classification -> role derivation** (design §6). The rules live in
   ``org_classifications`` as DATA, and ``suggest_role_from_rules`` takes the rows
   as an argument, so the whole engine answers here against the exact rows the
   migration seeds. The marker spellings are taken from the org charts, not
   invented: ``Senior TE(Sup)``, ``Senior TE (Sup)``, ``Sr TE/Sr EG (SUP`` and
   ``Senior TE(Spec)`` are four printings of two facts, and an exact string match
   fails on real data.
2. **Location parsing.** The charts print a person's home as ``City, D#``,
   ``City, D0#`` or — where the site has no district — ``Sacramento, Translab``.
   A district code and a location LABEL are different columns, and mistaking one
   for the other is how NORTH would end up serving a district called "Translab".
3. **``resolve_user_org``'s fallback and deactivation rules**, both of which are
   easy to state and easy to get subtly wrong: the mirror answers when there is
   no profile row AND when the row exists with ``office_id IS NULL``, and a
   deactivated office still resolves so history can name it.

Everything here runs under ``pytest -m "not db"``.
"""

from __future__ import annotations

import pytest

from app.routes import incidents as incidents_routes
from app.services import org_directory
from app.user_metadata import normalize_district_code


# ---------------------------------------------------------------------------
# The seeded rules, read from the revision rather than restated
# ---------------------------------------------------------------------------


_RULE_COLUMNS = (
    "rule_kind",
    "class_code",
    "marker",
    "title_pattern",
    "level_code",
    "title",
    "eris_role",
    "is_supervisor",
    "priority",
    "notes",
)


@pytest.fixture(scope="module")
def rules(org_model_revision):
    """``org_classifications`` as the migration seeds it, shaped like DB rows.

    ``id`` is the seed order, which is what the database's AUTO_INCREMENT will
    also produce; ``suggest_role_from_rules`` uses it only as the last tiebreak
    after ``priority`` and ``rule_kind``.
    """
    return [
        dict(zip(_RULE_COLUMNS, row), id=index, is_active=1)
        for index, row in enumerate(org_model_revision._CLASSIFICATIONS, start=1)
    ]


def _suggest(rules, **kwargs):
    return org_directory.suggest_role_from_rules(rules, **kwargs)


# ---------------------------------------------------------------------------
# Marker parsing: four chart spellings, two facts
# ---------------------------------------------------------------------------


class TestClassificationMarkerParsing:
    @pytest.mark.parametrize(
        "printed,expected",
        [
            # The four spellings design §6 names, verbatim from the charts.
            ("Senior TE(Sup)", "SUP"),
            ("Senior TE (Sup)", "SUP"),
            ("Sr TE/Sr EG (SUP", "SUP"),  # no closing parenthesis on the chart
            ("Senior TE(Spec)", "SPEC"),
            # ...and the shapes an admin form or an SSO sync will send.
            ("SUP", "SUP"),
            ("sup", "SUP"),
            ("(SPEC)", "SPEC"),
            ("  spec  ", "SPEC"),
            ("Senior Engineering Geologist (Spec)", "SPEC"),
        ],
    )
    def test_every_chart_spelling_normalizes(self, printed, expected):
        assert org_directory.normalize_classification_marker(printed) == expected

    @pytest.mark.parametrize(
        "printed",
        ["Transportation Engineer, Civil", "Engineering Geologist", "", "   ", None],
    )
    def test_an_unmarked_title_has_no_marker(self, printed):
        # None, not "": a missing marker is a fact, and "" would match a rule
        # row whose marker column is the empty-string default.
        assert org_directory.normalize_classification_marker(printed) is None

    def test_title_normalization_collapses_whitespace_and_upcases(self):
        # The LIKE patterns are written in upper case with single spaces, so the
        # title has to be too before any of them can be trusted.
        assert org_directory.normalize_classification_title("Senior  TE   (Sup)") == "SENIOR TE (SUP)"
        assert org_directory.normalize_classification_title(None) == ""


class TestLikeMatching:
    def test_percent_is_a_wildcard(self):
        assert org_directory._like_matches("SENIOR %", "SENIOR ENGINEERING GEOLOGIST (SPEC)")
        assert org_directory._like_matches("%", "ANYTHING AT ALL")

    def test_prefix_must_still_match(self):
        assert not org_directory._like_matches("SENIOR %", "ENGINEERING GEOLOGIST")

    def test_empty_pattern_matches_nothing(self):
        # A CLASS row's title_pattern is '' — it must never behave like '%'.
        assert not org_directory._like_matches("", "SENIOR TE (SUP)")


# ---------------------------------------------------------------------------
# Derivation over the concrete classes
# ---------------------------------------------------------------------------


class TestClassRules:
    @pytest.mark.parametrize(
        "printed_title,expected_role",
        [
            ("Senior TE(Sup)", "GEOTECH_BRANCH_CHIEF"),
            ("Senior TE (Sup)", "GEOTECH_BRANCH_CHIEF"),
            ("Sr TE/Sr EG (SUP", "GEOTECH_BRANCH_CHIEF"),
            ("Senior TE(Spec)", "GEOTECH_SENIOR_ENGINEER"),
        ],
    )
    def test_class_3161_resolves_from_the_title_alone(self, rules, printed_title, expected_role):
        # No `marker=` argument: the marker is pulled out of the printed title,
        # which is all an SSO sync or a chart transcription will carry.
        suggestion = _suggest(rules, class_code="3161", title=printed_title)
        assert suggestion is not None
        assert suggestion["suggested_role"] == expected_role
        assert suggestion["rule_kind"] == "CLASS"

    @pytest.mark.parametrize(
        "class_code,marker,expected_role",
        [
            ("3155", None, "GEOTECH_OFFICE_CHIEF"),
            ("3161", "SUP", "GEOTECH_BRANCH_CHIEF"),
            ("3751", "SUP", "GEOTECH_BRANCH_CHIEF"),
            ("3161", "SPEC", "GEOTECH_SENIOR_ENGINEER"),
            ("3751", "SPEC", "GEOTECH_SENIOR_ENGINEER"),
            ("3375", "SPEC", "GEOTECH_SENIOR_ENGINEER"),
            ("3185", "SPEC", "GEOTECH_SENIOR_ENGINEER"),
            ("3135", None, "GEOTECH_ENGINEER"),
            ("3756", None, "GEOTECH_ENGINEER"),
            ("3175", None, "GEOTECH_ENGINEER"),
            ("3381", None, "GEOTECH_ENGINEER"),
            ("5393", None, "CALTRANS_VIEWER"),
            ("1139", None, "CALTRANS_VIEWER"),
        ],
    )
    def test_every_decided_class_suggests_its_role(self, rules, class_code, marker, expected_role):
        suggestion = _suggest(rules, class_code=class_code, marker=marker)
        assert suggestion is not None, f"class {class_code} matched no rule"
        assert suggestion["suggested_role"] == expected_role
        assert suggestion["rule_kind"] == "CLASS"

    def test_the_supervisor_flag_travels_with_the_rule(self, rules):
        assert _suggest(rules, class_code="3155")["is_supervisor"] is True
        assert _suggest(rules, class_code="3161", marker="SPEC")["is_supervisor"] is False

    def test_rds_ii_matches_and_suggests_nothing(self, rules):
        # Class 5758 is a MATCH whose eris_role is NULL — different from no match
        # at all, and the difference is the whole of open question 15. The note
        # is what an admin reads instead of a suggestion.
        suggestion = _suggest(rules, class_code="5758")
        assert suggestion is not None
        assert suggestion["suggested_role"] is None
        assert suggestion["rule_kind"] == "CLASS"
        assert "TET to RDS II" in (suggestion["notes"] or "")

    def test_a_stated_level_that_disagrees_refuses_the_class_row(self, rules):
        # 3155 is an M09 row. A profile that says 3155 at R09 is a data error,
        # not a supervisor, and it must not silently suggest an office chief.
        assert _suggest(rules, class_code="3155", level_code="R09") is None


# ---------------------------------------------------------------------------
# The two PATTERN rules resolve AFTER the CLASS rows, and only then
# ---------------------------------------------------------------------------


class TestPatternRules:
    def test_pattern_answers_for_a_discipline_nobody_has_entered(self, rules):
        # "Any Senior <discipline> marked (Spec)" — the point of storing the rule
        # as a row is that a new discipline needs no code change.
        suggestion = _suggest(rules, class_code="9999", title="Senior Hydraulics Engineer (Spec)")
        assert suggestion is not None
        assert suggestion["suggested_role"] == "GEOTECH_SENIOR_ENGINEER"
        assert suggestion["rule_kind"] == "PATTERN"

    def test_pattern_sup_at_s09_answers_for_an_unknown_class(self, rules):
        suggestion = _suggest(
            rules, class_code="7777", marker="SUP", level_code="S09", title="Supervising Whatever"
        )
        assert suggestion is not None
        assert suggestion["suggested_role"] == "GEOTECH_BRANCH_CHIEF"
        assert suggestion["rule_kind"] == "PATTERN"

    def test_the_exact_class_row_wins_over_the_pattern_that_also_matches(self, rules):
        # 3161 (Spec) is matched by BOTH the CLASS row and the `SENIOR %` PATTERN.
        # Priority 100 before 500 is what makes the answer deterministic; a
        # different order would still return GEOTECH_SENIOR_ENGINEER here, so the
        # assertion that matters is rule_kind and the rule's own title.
        suggestion = _suggest(rules, class_code="3161", title="Senior TE (Spec)")
        assert suggestion["rule_kind"] == "CLASS"
        assert suggestion["title"] == "Senior Transportation Engineer (Spec)"

    def test_the_sup_pattern_needs_the_level_it_names(self, rules):
        # `%` + SUP + S09 must not fire for a (Sup) position at some other level:
        # the level is the only thing separating a branch chief from any other
        # supervisor in the department.
        assert _suggest(rules, class_code="7777", marker="SUP", title="Supervising Whatever") is None
        assert (
            _suggest(rules, class_code="7777", marker="SUP", level_code="M09", title="Supervising Whatever")
            is None
        )

    def test_nothing_matches_when_nothing_should(self, rules):
        assert _suggest(rules, class_code="0000", title="Groundskeeper") is None
        assert _suggest(rules) is None

    def test_an_inactive_rule_is_not_consulted(self, rules):
        retired = [dict(rule, is_active=0) if rule["class_code"] == "3155" else rule for rule in rules]
        assert _suggest(retired, class_code="3155") is None
        # ...and every other rule still answers.
        assert _suggest(retired, class_code="3161", marker="SUP")["suggested_role"] == "GEOTECH_BRANCH_CHIEF"

    def test_the_seed_holds_fourteen_class_rows_and_two_patterns(self, rules):
        assert len(rules) == 16
        assert sum(1 for r in rules if r["rule_kind"] == "CLASS") == 14
        assert sum(1 for r in rules if r["rule_kind"] == "PATTERN") == 2
        # Every PATTERN resolves after every CLASS, which is the ordering the two
        # tests above depend on.
        assert max(r["priority"] for r in rules if r["rule_kind"] == "CLASS") < min(
            r["priority"] for r in rules if r["rule_kind"] == "PATTERN"
        )


# ---------------------------------------------------------------------------
# Location parsing: `City, D#`, `City, D0#`, `Sacramento, Translab`
# ---------------------------------------------------------------------------


class TestLocationParsing:
    @pytest.mark.parametrize(
        "printed,expected",
        [
            ("D4", "04"),      # City, D#
            ("D04", "04"),     # City, D0#
            ("4", "04"),
            ("04", "04"),
            ("District 07", "07"),
            ("d12", "12"),
        ],
    )
    def test_a_printed_district_normalizes_to_the_two_character_code(self, printed, expected):
        assert normalize_district_code(printed) == expected

    def test_translab_is_a_location_label_and_never_a_district(self):
        # "Sacramento, Translab" is the chart's way of printing a site with no
        # district. The parse must not invent one: there is no digit to find, so
        # the value comes back as text and the office row stores it in
        # home_location_label with home_district left NULL (asserted below).
        parsed = normalize_district_code("Translab")
        assert parsed is not None and not parsed.isdigit()

    def test_the_seeded_translab_offices_carry_a_label_and_no_district(self, org_model_revision):
        by_code = {row[0]: row for row in org_model_revision._OFFICES}
        # (code, unit_number, name, short_name, home_city, home_district,
        #  home_location_label, is_routing_target, sort_order)
        north = by_code["NORTH"]
        assert north[4] == "Sacramento"
        assert north[5] is None, "a Translab-sited office has no district"
        assert north[6] == "Translab"
        # ...and the two offices printed with a district keep it.
        assert by_code["WEST"][4:7] == ("Oakland", "04", None)
        assert by_code["SOUTH"][4:7] == ("Los Angeles", "07", None)

    @pytest.mark.parametrize(
        "city,district,key,label",
        [
            ("Oakland", "04", "loc:Oakland:04", "Oakland, D04"),
            ("San Luis Obispo", "05", "loc:San Luis Obispo:05", "San Luis Obispo, D05"),
            # The Translab shape: a city, no district. The person is still
            # grouped and still labelled — nobody vanishes from a picker for
            # sitting at a site with no district number.
            ("Sacramento", None, "loc:Sacramento:", "Sacramento"),
            (None, "07", "loc::07", "District 07"),
            (None, None, "loc:UNKNOWN", "Location not recorded"),
        ],
    )
    def test_the_senior_engineer_picker_groups_by_parsed_location(self, city, district, key, label):
        assert incidents_routes._location_group_key(city, district) == key
        assert incidents_routes._location_group_label(city, district) == label


# ---------------------------------------------------------------------------
# resolve_user_org: the fallback rule and the deactivation rule
# ---------------------------------------------------------------------------


class _NullTransaction:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Result:
    def __init__(self, row):
        self._row = row

    def mappings(self):
        return self

    def first(self):
        return self._row


class _FakeSession:
    """The two queries ``resolve_user_org`` issues, answered from memory.

    Not a mock of SQLAlchemy: it recognises the two statements by the table they
    read and returns the row a real database would. Anything else raises, so a
    new query added to the resolve path fails this suite loudly rather than
    silently returning None.
    """

    def __init__(self, *, profile=None, offices=None):
        self.profile = profile
        self.offices = offices or {}
        self.seen: list[str] = []

    def begin_nested(self):
        return _NullTransaction()

    def execute(self, statement, params=None):
        sql = " ".join(str(statement).split())
        self.seen.append(sql)
        if "FROM org_user_profiles p" in sql:
            return _Result(self.profile)
        if "FROM org_offices" in sql:
            return _Result(self.offices.get((params or {}).get("code")))
        raise AssertionError(f"unexpected SQL in a no-DB unit test: {sql[:140]}")


def _profile_row(**overrides):
    row = {
        "user_id": 42,
        "office_id": None,
        "branch_id": None,
        "home_city": None,
        "home_district": None,
        "classification_code": None,
        "classification_marker": None,
        "position_number": None,
        "job_title": None,
        "level_code": None,
        "supervisor_user_id": None,
        "availability": "AVAILABLE",
        "available_from": None,
        "available_until": None,
        "source": "BACKFILL",
        "office_code": None,
        "office_name": None,
        "office_short_name": None,
        "office_unit_number": None,
        "office_is_active": None,
        "branch_letter": None,
        "branch_name": None,
        "branch_is_active": None,
    }
    row.update(overrides)
    return row


def _office_row(**overrides):
    row = {
        "id": 1,
        "code": "WEST",
        "org_type": "GEOTECH",
        "unit_number": "59-315",
        "name": "Office of Geotechnical Design West",
        "short_name": "West GeoTech Office",
        "home_city": "Oakland",
        "home_district": "04",
        "home_location_label": None,
        "is_routing_target": 1,
        "is_active": 1,
        "sort_order": 10,
    }
    row.update(overrides)
    return row


def _user(**overrides):
    user = {"id": 42, "email": "someone@local", "roles": [], "metadata": {}}
    user.update(overrides)
    return user


class TestResolveUserOrgFallback:
    def test_no_profile_row_falls_back_to_the_metadata_mirror(self):
        db = _FakeSession(profile=None, offices={"WEST": _office_row()})
        org = org_directory.resolve_user_org(db, _user(metadata={"office_code": "WEST", "district": "04"}))
        assert org["has_profile"] is False
        assert org["office_id"] == 1
        assert org["office_code"] == "WEST"
        assert org["office_name"] == "Office of Geotechnical Design West"
        assert org["home_district"] == "04"

    def test_a_row_with_office_id_null_also_falls_back(self):
        # THE trap. The migration gives EVERY active user a profile row, so "no
        # row" stops meaning "no office" the moment it runs. Keying the fallback
        # on the row's absence would blank the office of every account whose
        # office only ever lived in the mirror.
        db = _FakeSession(profile=_profile_row(office_id=None), offices={"WEST": _office_row()})
        org = org_directory.resolve_user_org(db, _user(metadata={"office_code": "WEST"}))
        assert org["has_profile"] is True
        assert org["office_id"] == 1
        assert org["office_code"] == "WEST"

    def test_the_profile_wins_when_it_names_an_office(self):
        db = _FakeSession(
            profile=_profile_row(office_id=3, office_code="SOUTH", office_name="…Design South", office_is_active=1),
            offices={"WEST": _office_row()},
        )
        org = org_directory.resolve_user_org(db, _user(metadata={"office_code": "WEST"}))
        assert org["office_id"] == 3
        assert org["office_code"] == "SOUTH"
        # The mirror was never consulted: no org_offices lookup was issued.
        assert not any("FROM org_offices" in sql for sql in db.seen)

    def test_the_district_falls_back_independently_of_the_office(self):
        db = _FakeSession(profile=_profile_row(office_id=3, office_code="SOUTH", home_district=None))
        org = org_directory.resolve_user_org(db, _user(metadata={"district": "D7"}))
        assert org["office_code"] == "SOUTH"
        assert org["home_district"] == "07"

    def test_an_unknown_mirror_code_still_reports_the_code(self):
        # The office does not exist, so nothing can be said about it — but the
        # code itself is what every legacy office check compares, so dropping it
        # would silently unscope the account.
        db = _FakeSession(profile=None, offices={})
        org = org_directory.resolve_user_org(db, _user(metadata={"office_code": "WEST"}))
        assert org["office_code"] == "WEST"
        assert org["office_id"] is None

    def test_no_profile_and_no_mirror_is_an_empty_record_not_an_error(self):
        db = _FakeSession(profile=None)
        org = org_directory.resolve_user_org(db, _user())
        assert org["office_code"] is None
        assert org["home_district"] is None
        assert org["availability"] == "AVAILABLE"

    def test_the_answer_is_cached_on_the_request_user(self):
        db = _FakeSession(profile=_profile_row(office_id=3, office_code="SOUTH"))
        user = _user()
        first = org_directory.resolve_user_org(db, user)
        queries = len(db.seen)
        second = org_directory.resolve_user_org(db, user)
        assert second is first
        assert len(db.seen) == queries, "a second resolve re-queried the database"


class TestResolveUserOrgDeactivation:
    def test_a_deactivated_office_still_resolves(self):
        # An assessment routed to an office that has since been retired must
        # still be able to name it, and its chief must keep their queue while the
        # move is being sorted out. is_active is REPORTED, never filtered on.
        db = _FakeSession(
            profile=_profile_row(office_id=3, office_code="SOUTH", office_name="…Design South", office_is_active=0)
        )
        org = org_directory.resolve_user_org(db, _user())
        assert org["office_code"] == "SOUTH"
        assert org["office_is_active"] is False

    def test_a_deactivated_office_resolves_through_the_mirror_too(self):
        db = _FakeSession(profile=None, offices={"WEST": _office_row(is_active=0)})
        org = org_directory.resolve_user_org(db, _user(metadata={"office_code": "WEST"}))
        assert org["office_id"] == 1
        assert org["office_is_active"] is False

    def test_a_deactivated_branch_still_resolves_and_is_badged(self):
        db = _FakeSession(
            profile=_profile_row(
                office_id=1,
                office_code="WEST",
                office_is_active=1,
                branch_id=9,
                branch_letter="D",
                branch_name="Branch D",
                branch_is_active=0,
            )
        )
        org = org_directory.resolve_user_org(db, _user())
        assert org["branch_id"] == 9
        assert org["branch_name"] == "Branch D"
        assert org["branch_is_active"] is False

"""Moving work when someone moves on (routes/assessments.py: workload)."""
from datetime import datetime

from app.routes.assessments import group_work


def assessment(id, *, route="BRANCH", state="DRAFT", chief=None, assignee=None, branch=3, office="WEST"):
    return {
        "id": id, "incident_id": id * 10, "state": state, "routing_path": route, "office_code": office,
        "branch_chief_user_id": chief, "assigned_engineer_user_id": assignee, "routed_branch_id": branch,
        "routed_branch_name": "Branch C", "routed_branch_letter": "C", "updated_at": datetime(2026, 11, 1), "title": f"Report {id}",
    }


def person(name, position, *, office="WEST", branch=3, active=True):
    return {
        "full_name": name, "active": active,
        "place": {"position": position, "office_code": office, "branch_id": branch, "label": f"{position} · {office}"},
    }


CHIEF, FORMER_CHIEF, STAFF, LEFT_STAFF, SPECIALIST, LEFT_SPECIALIST = 1, 2, 3, 4, 5, 6
PEOPLE = {
    CHIEF: person("New Chief", "BRANCH_CHIEF"),
    FORMER_CHIEF: person("Former Chief", "STAFF"),
    STAFF: person("Sam Staff", "STAFF"),
    LEFT_STAFF: person("Lee Left", None, office=None, branch=None),
    SPECIALIST: person("Sue Specialist", "SENIOR_SPECIALIST", branch=None),
    LEFT_SPECIALIST: person("Tom Moved", "STAFF", office="SOUTH", branch=9),
}


def groups(rows, **view):
    found = group_work(rows, people=PEOPLE, **{"office_view": False, "branch_view_of": None, **view})
    return {(g["kind"], g["holder"]["id"]): g for g in found}


def test_a_replaced_chiefs_work_is_flagged_for_the_office_chief():
    found = groups([assessment(1, chief=FORMER_CHIEF), assessment(2, chief=CHIEF)], office_view=True)
    assert found[("BRANCH_CHIEF", FORMER_CHIEF)]["left"] is True
    assert found[("BRANCH_CHIEF", CHIEF)]["left"] is False


def test_a_chief_now_leading_another_branch_has_left_this_one():
    moved = {**PEOPLE, 7: person("Moved Chief", "BRANCH_CHIEF", branch=8)}
    found = {g["holder"]["id"]: g for g in group_work([assessment(1, chief=7)], office_view=True, branch_view_of=None, people=moved)}
    assert found[7]["left"] is True


def test_a_chief_who_was_deleted_leaves_work_with_nobody():
    found = groups([assessment(1, chief=None)], office_view=True)
    assert found[("BRANCH_CHIEF", None)]["left"] is True


def test_a_senior_specialist_who_moved_on_is_flagged():
    found = groups(
        [assessment(1, route="SENIOR_ENGINEER", assignee=LEFT_SPECIALIST, branch=None),
         assessment(2, route="SENIOR_ENGINEER", assignee=SPECIALIST, branch=None)],
        office_view=True,
    )
    assert found[("SENIOR_SPECIALIST", LEFT_SPECIALIST)]["left"] is True
    assert found[("SENIOR_SPECIALIST", SPECIALIST)]["left"] is False


def test_a_senior_specialists_submitted_work_stays_out_since_the_office_reviews_it():
    found = groups([assessment(1, route="SENIOR_ENGINEER", state="SUBMITTED", assignee=LEFT_SPECIALIST, branch=None)], office_view=True)
    assert found == {}


def test_a_branch_chief_sees_the_staff_on_what_was_handed_to_them():
    found = groups(
        [assessment(1, chief=CHIEF, assignee=STAFF), assessment(2, chief=CHIEF, assignee=LEFT_STAFF),
         assessment(3, chief=FORMER_CHIEF, assignee=STAFF)],
        branch_view_of=CHIEF,
    )
    assert [i["id"] for i in found[("STAFF", STAFF)]["items"]] == [1]
    assert found[("STAFF", STAFF)]["left"] is False
    assert found[("STAFF", LEFT_STAFF)]["left"] is True


def test_nothing_assigned_yet_is_not_someones_work_to_move():
    assert groups([assessment(1, chief=CHIEF, state="PENDING_ENGINEER_ASSIGNMENT")], branch_view_of=CHIEF) == {}


def test_a_staff_member_now_in_another_branch_has_left_this_one():
    moved = {**PEOPLE, 8: person("Other Branch", "STAFF", branch=8)}
    found = group_work([assessment(1, chief=CHIEF, assignee=8)], office_view=False, branch_view_of=CHIEF, people=moved)
    assert found[0]["left"] is True


def test_someone_disabled_has_left():
    gone = {**PEOPLE, 9: person("Disabled", "STAFF", active=False)}
    assert group_work([assessment(1, chief=CHIEF, assignee=9)], office_view=False, branch_view_of=CHIEF, people=gone)[0]["left"] is True


def test_what_was_left_behind_comes_first():
    found = group_work(
        [assessment(1, chief=CHIEF, assignee=STAFF), assessment(2, chief=CHIEF, assignee=LEFT_STAFF)],
        office_view=False, branch_view_of=CHIEF, people=PEOPLE,
    )
    assert [g["holder"]["id"] for g in found] == [LEFT_STAFF, STAFF]

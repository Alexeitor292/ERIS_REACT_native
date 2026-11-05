"""Who a routing picker offers: exactly the right people (owner, 2026-11-03)."""
from app.admin_users import staff_of_branch


def person(id, branch):
    return {"id": id, "branch_id": branch}


def test_a_branch_chief_is_offered_only_the_staff_of_that_branch():
    people = [person(1, 3), person(2, 4), person(3, None)]
    assert [p["id"] for p in staff_of_branch(people, 3)] == [1]


def test_with_no_branch_to_go_by_the_office_staff_stand():
    people = [person(1, 3), person(2, 4)]
    assert staff_of_branch(people, None) == people

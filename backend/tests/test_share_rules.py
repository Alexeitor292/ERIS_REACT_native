"""The team's sharing rule, case by case (services/share_rules.py)."""
from __future__ import annotations

from app.services.share_rules import APPROVAL, BRANCH, NOTICE, OFFICE, Place, Review, reviews_for

WEST, NORTH = 1, 2
WEST_A, WEST_B, NORTH_A = 11, 12, 21


def staff(office, branch):
    return Place("STAFF", office, branch)


def chief(office, branch):
    return Place("BRANCH_CHIEF", office, branch)


def specialist(office):
    return Place("SENIOR_SPECIALIST", office, None)


def test_inside_one_branch_it_goes_through_and_the_branch_chief_is_told():
    assert reviews_for(staff(WEST, WEST_A), staff(WEST, WEST_A)) == [Review(BRANCH, WEST_A, NOTICE)]


def test_across_branches_of_one_office_both_branch_chiefs_approve():
    assert reviews_for(staff(WEST, WEST_A), staff(WEST, WEST_B)) == [
        Review(BRANCH, WEST_A, APPROVAL),
        Review(BRANCH, WEST_B, APPROVAL),
    ]


def test_across_offices_both_branch_chiefs_approve_and_both_office_chiefs_are_told():
    assert reviews_for(staff(WEST, WEST_A), staff(NORTH, NORTH_A)) == [
        Review(BRANCH, WEST_A, APPROVAL),
        Review(BRANCH, NORTH_A, APPROVAL),
        Review(OFFICE, WEST, NOTICE),
        Review(OFFICE, NORTH, NOTICE),
    ]


def test_specialist_to_specialist_in_one_office_goes_through_and_the_office_chief_is_told():
    assert reviews_for(specialist(WEST), specialist(WEST)) == [Review(OFFICE, WEST, NOTICE)]


def test_specialists_in_two_offices_go_through_and_both_office_chiefs_are_told():
    assert reviews_for(specialist(WEST), specialist(NORTH)) == [Review(OFFICE, WEST, NOTICE), Review(OFFICE, NORTH, NOTICE)]


def test_staff_to_a_specialist_of_their_office_needs_the_branch_chief_and_tells_the_office_chief():
    assert reviews_for(staff(WEST, WEST_A), specialist(WEST)) == [Review(BRANCH, WEST_A, APPROVAL), Review(OFFICE, WEST, NOTICE)]


def test_staff_to_a_specialist_of_another_office_needs_the_branch_chief_and_tells_both_office_chiefs():
    assert reviews_for(staff(WEST, WEST_A), specialist(NORTH)) == [
        Review(BRANCH, WEST_A, APPROVAL),
        Review(OFFICE, WEST, NOTICE),
        Review(OFFICE, NORTH, NOTICE),
    ]


def test_a_specialist_sharing_into_a_branch_needs_that_branch_chief():
    assert reviews_for(specialist(WEST), staff(WEST, WEST_B)) == [Review(BRANCH, WEST_B, APPROVAL), Review(OFFICE, WEST, NOTICE)]


def test_a_branch_chief_is_part_of_their_branch():
    assert reviews_for(chief(WEST, WEST_A), staff(WEST, WEST_A)) == [Review(BRANCH, WEST_A, NOTICE)]
    assert reviews_for(chief(WEST, WEST_A), chief(WEST, WEST_B)) == [
        Review(BRANCH, WEST_A, APPROVAL),
        Review(BRANCH, WEST_B, APPROVAL),
    ]


def test_leaving_a_branch_for_someone_placed_nowhere_still_needs_the_branch_chief():
    assert reviews_for(staff(WEST, WEST_A), Place()) == [Review(BRANCH, WEST_A, APPROVAL)]
    assert reviews_for(Place(), Place()) == []

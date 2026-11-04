"""The District Contact and Immediate Actions delivered from a draft."""
from datetime import datetime
import json

import pytest
from fastapi import HTTPException

from app.routes.field_notices import notice_text, supervisors_of
from app.services.district_contact import LOOP_EVENTS, choose, form_contact


def test_a_hand_off_names_who_it_asks_for():
    assert choose(requested=7, default=8, eligible={7, 8}) == 7


def test_nobody_from_outside_the_district_can_be_named():
    with pytest.raises(HTTPException) as refused:
        choose(requested=9, default=8, eligible={7, 8})
    assert refused.value.status_code == 400


def test_with_nobody_asked_for_the_districts_default_stands():
    assert choose(requested=None, default=8, eligible={7, 8}) == 8


def test_a_contact_has_to_be_named_when_someone_could_be():
    with pytest.raises(HTTPException) as refused:
        choose(requested=None, default=None, eligible={7})
    assert "Choose a District Contact" in refused.value.detail


def test_a_default_who_left_the_district_does_not_count():
    with pytest.raises(HTTPException):
        choose(requested=None, default=9, eligible={7})


def test_an_emergency_is_never_held_up_by_an_empty_list():
    assert choose(requested=None, default=None, eligible=set()) is None
    assert choose(requested=None, default=9, eligible=set()) is None


def test_the_form_stores_the_contact_as_its_section_does():
    stored = json.loads(form_contact("Ana Maria Ruiz"))[0]
    assert (stored["first_name"], stored["last_name"]) == ("Ana", "Maria Ruiz")
    assert stored["phone"] == "" and stored["id"]
    assert json.loads(form_contact("Ana"))[0]["last_name"] == ""


def test_the_contact_hears_the_milestones_and_no_triage_or_forms():
    assert {"SUBMITTED", "APPROVED", "REVISION_REQUESTED", "OFFICE_DELEGATED", "ENGINEER_ASSIGNED"} <= set(LOOP_EVENTS)
    assert "SUBMISSION_CREATED" not in LOOP_EVENTS


def test_staff_answer_to_the_branch_chief_named_on_the_assessment():
    assert supervisors_of(None, {"routing_path": "BRANCH", "branch_chief_user_id": 5}) == [5]
    assert supervisors_of(None, {"routing_path": "BRANCH", "branch_chief_user_id": None}) == []
    assert supervisors_of(None, None) == []


def test_a_notice_says_what_was_done_and_why():
    now = datetime(2026, 11, 4, 15, 0)
    assert notice_text(["Close shoulder", "Close lane"], "Rocks on the road.", None, now) == "Close shoulder, Close lane. Rocks on the road."


def test_a_late_notice_says_when_it_was_written():
    sent = datetime(2026, 11, 4, 15, 0)
    assert notice_text(["Close shoulder"], "Rocks.", datetime(2026, 11, 4, 14, 58), sent) == "Close shoulder. Rocks."
    late = notice_text(["Close shoulder"], "Rocks.", datetime(2026, 11, 4, 14, 20), sent)
    assert late.endswith("Written Nov 4, 2:20 PM, with no connection.")

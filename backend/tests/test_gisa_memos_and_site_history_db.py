"""Formatted memos on the GISA form, and the form's site history.

Requires a live MariaDB at Alembic head with the mock accounts loaded.
Run with: pytest -m db
"""

from __future__ import annotations

from uuid import uuid4

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.db

UNGROUPED = {"X-ERIS-Test-Preserve-Projectless": "1"}
# A spot of its own, so other tests' reports never count as "nearby".
SITE = {"latitude": 38.51234, "longitude": -122.91234}


def _login(client, email: str) -> dict:
    resp = client.post("/auth/login", json={"email": email, "password": "password"})
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


@pytest.fixture(scope="module")
def staff(client_db):
    return _login(client_db, "mock.staff@dot.ca.gov")


@pytest.fixture()
def form(client_db, staff):
    created = client_db.post("/submissions", json={"title": f"Memo fixture {uuid4().hex[:6]}"}, headers=staff)
    assert created.status_code == 200, created.text
    submission_id = int(created.json()["submission_id"])
    resp = client_db.patch(f"/submissions/{submission_id}/gisa", json=dict(SITE), headers=staff)
    assert resp.status_code == 200, resp.text
    return submission_id


def _gisa(client, headers, submission_id):
    resp = client.get(f"/submissions/{submission_id}", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()["gisa"]


class TestFormattedMemos:
    def test_a_memo_is_sanitized_and_mirrored_as_plain_text(self, client_db, staff, form):
        html = (
            '<h2>Findings</h2><p style="text-align:center;position:fixed" onclick="x()">Slope is '
            "<strong>saturated</strong><script>alert(1)</script></p>"
            '<ul><li><p>Crack A</p></li><li>Crack B</li></ul><p><a href="javascript:alert(1)">bad</a></p>'
        )
        resp = client_db.patch(f"/submissions/{form}/gisa", json={"geotechnical_assessment_notes_html": html}, headers=staff)
        assert resp.status_code == 200, resp.text
        gisa = _gisa(client_db, staff, form)
        stored = gisa["geotechnical_assessment_notes_html"]
        assert "<script" not in stored and "onclick" not in stored and "javascript:" not in stored
        assert "position" not in stored and 'style="text-align:center"' in stored
        assert "<strong>saturated</strong>" in stored
        assert gisa["geotechnical_assessment_notes"] == "Findings\nSlope is saturated\n• Crack A\n• Crack B\nbad"

    def test_clearing_a_memo_clears_its_plain_text(self, client_db, staff, form):
        client_db.patch(f"/submissions/{form}/gisa", json={"observations_notes_html": "<p>Wet toe</p>"}, headers=staff)
        client_db.patch(f"/submissions/{form}/gisa", json={"observations_notes_html": "<p></p>"}, headers=staff)
        gisa = _gisa(client_db, staff, form)
        assert gisa["observations_notes_html"] is None and gisa["observations_notes"] is None

    def test_an_oversized_memo_is_refused(self, client_db, staff, form):
        huge = "<p>" + ("x" * 210_000) + "</p>"
        resp = client_db.patch(f"/submissions/{form}/gisa", json={"recommendations_notes_html": huge}, headers=staff)
        assert resp.status_code == 413, resp.text


class TestSiteHistory:
    def _report(self, client, crew, title, **where):
        body = {
            "title": f"{title} {uuid4().hex[:6]}",
            "description": "Seen from the shoulder.",
            "first_observed_at": "2026-09-20T08:00:00",
            "district": "01",
            "county": "HUM",
            "route": "101",
            "post_mile": "12.00",
            **SITE,
            **where,
        }
        resp = client.post("/incidents", json=body, headers=crew)
        assert resp.status_code == 200, resp.text
        return int(resp.json()["incident"]["id"])

    def test_it_splits_the_record_from_maintenance_history_and_marks_recurrence(self, client_db, staff, form):
        crew = _login(client_db, "mock.maintenance.crew@dot.ca.gov")
        coordinator = _login(client_db, "mock.coordinator.d01@dot.ca.gov")
        in_record = self._report(client_db, crew, "Earlier slide")
        closed = self._report(client_db, crew, "Debris on shoulder")
        far_away = self._report(client_db, crew, "Somewhere else", latitude=38.60, longitude=-122.80)

        accepted = client_db.post(
            f"/incidents/{in_record}/triage",
            json={"disposition": "ASSESSMENT_REQUIRED", "event_group": {"mode": "CREATE_NEW"}},
            headers={**coordinator, **UNGROUPED},
        )
        assert accepted.status_code == 200, accepted.text
        declined = client_db.post(
            f"/incidents/{closed}/triage",
            json={"disposition": "NO_ASSESSMENT_REQUIRED", "notes": "Cleared by the crew."},
            headers={**coordinator, **UNGROUPED},
        )
        assert declined.status_code == 200, declined.text

        history = client_db.get(f"/submissions/{form}/site-history", headers=staff)
        assert history.status_code == 200, history.text
        body = history.json()
        record_ids = [item["incident_id"] for item in body["record_of_events"]]
        maintenance_ids = [item["incident_id"] for item in body["maintenance_history"]]
        assert in_record in record_ids and closed not in record_ids
        assert closed in maintenance_ids and in_record not in maintenance_ids
        assert far_away not in record_ids + maintenance_ids

        entry = next(item for item in body["maintenance_history"] if item["incident_id"] == closed)
        assert entry["outcome"] == "NO_ASSESSMENT_REQUIRED"
        assert entry["coordinator_notes"] == "Cleared by the crew."
        assert entry["distance_m"] is not None and entry["distance_m"] < 1

        # Recurrence: give the earlier incident a form with a type, then match it.
        from app.db import engine

        other = client_db.post("/submissions", json={"title": "Earlier form"}, headers=staff)
        other_id = int(other.json()["submission_id"])
        staff_id = client_db.get("/auth/me", headers=staff).json()["id"]
        with engine.begin() as conn:
            conn.execute(
                text("INSERT INTO incident_submission_links (incident_id, submission_id, linked_by_user_id) VALUES (:i, :s, :u)"),
                {"i": in_record, "s": other_id, "u": staff_id},
            )
        assert client_db.put(f"/submissions/{other_id}/gisa/incident-types", json={"items": ["SLIDE"]}, headers=staff).status_code == 200

        def relation():
            items = client_db.get(f"/submissions/{form}/site-history", headers=staff).json()["record_of_events"]
            return next(item for item in items if item["incident_id"] == in_record)["relation"]

        assert relation() == "UNCLASSIFIED"
        client_db.put(f"/submissions/{form}/gisa/incident-types", json={"items": ["SLIDE"]}, headers=staff)
        assert relation() == "SAME_TYPE"
        client_db.put(f"/submissions/{form}/gisa/incident-types", json={"items": ["ROCK_FALL"]}, headers=staff)
        assert relation() == "DIFFERENT_TYPE"

    def test_only_operational_roles_may_read_it(self, client_db, form, viewer_token):
        crew = _login(client_db, "mock.maintenance.crew@dot.ca.gov")
        assert client_db.get(f"/submissions/{form}/site-history", headers=crew).status_code == 403
        guest = {"Authorization": f"Bearer {viewer_token}"}
        assert client_db.get(f"/submissions/{form}/site-history", headers=guest).status_code == 403

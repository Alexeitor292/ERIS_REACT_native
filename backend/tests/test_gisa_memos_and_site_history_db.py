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

    def test_one_list_with_each_incidents_maintenance_under_it(self, client_db, staff, form):
        crew = _login(client_db, "mock.maintenance.crew@dot.ca.gov")
        coordinator = _login(client_db, "mock.coordinator.d01@dot.ca.gov")
        in_record = self._report(client_db, crew, "Earlier slide")
        closed = self._report(client_db, crew, "Debris on shoulder")
        repeat = self._report(client_db, crew, "Same slide again")
        far_away = self._report(client_db, crew, "Somewhere else", latitude=38.60, longitude=-122.80)

        accepted = client_db.post(
            f"/incidents/{in_record}/triage",
            json={"disposition": "ASSESSMENT_REQUIRED", "notes": "Send it to geotech.", "event_group": {"mode": "CREATE_NEW"}},
            headers={**coordinator, **UNGROUPED},
        )
        assert accepted.status_code == 200, accepted.text
        declined = client_db.post(
            f"/incidents/{closed}/triage",
            json={"disposition": "NO_ASSESSMENT_REQUIRED", "notes": "Cleared by the crew."},
            headers={**coordinator, **UNGROUPED},
        )
        assert declined.status_code == 200, declined.text
        duplicate = client_db.post(
            f"/incidents/{repeat}/triage",
            json={"disposition": "DUPLICATE_OR_LINKED", "target_incident_id": in_record, "notes": "Already in."},
            headers={**coordinator, **UNGROUPED},
        )
        assert duplicate.status_code == 200, duplicate.text

        # The earlier incident's technical form, with its actions and a type.
        from app.db import engine

        other = client_db.post("/submissions", json={"title": "Earlier form"}, headers=staff)
        other_id = int(other.json()["submission_id"])
        staff_id = client_db.get("/auth/me", headers=staff).json()["id"]
        coordinator_id = client_db.get("/auth/me", headers=coordinator).json()["id"]
        with engine.begin() as conn:
            conn.execute(
                text("INSERT INTO incident_submission_links (incident_id, submission_id, linked_by_user_id) VALUES (:i, :s, :u)"),
                {"i": in_record, "s": other_id, "u": staff_id},
            )
            # A note the coordinator left in the incident's history.
            conn.execute(
                text("INSERT INTO assessment_events (incident_id, actor_user_id, event_type, notes) VALUES (:i, :u, 'COMMENT', :n)"),
                {"i": in_record, "u": coordinator_id, "n": "Crew cleared the ditch on 9/21."},
            )
        actions = {"immediate": ["REMOVE_DEBRIS", "CLOSE_HIGHWAY_SHOULDER"], "follow_up": ["ROUTINE_VISUAL_MONITOR"]}
        assert client_db.put(f"/submissions/{other_id}/gisa/actions", json=actions, headers=staff).status_code == 200

        history = client_db.get(f"/submissions/{form}/site-history", headers=staff)
        assert history.status_code == 200, history.text
        items = {item["incident_id"]: item for item in history.json()["incidents"]}
        assert in_record in items and closed in items
        assert far_away not in items
        assert repeat not in items  # shown under the incident it duplicates

        earlier = items[in_record]
        assert earlier["in_record"] is True and earlier["outcome"] is None
        upkeep = earlier["maintenance"]
        assert upkeep["report"]["description"] == "Seen from the shoulder."
        assert upkeep["triage"]["disposition"] == "ASSESSMENT_REQUIRED"
        assert upkeep["triage"]["notes"] == "Send it to geotech."
        assert [a["label"] for a in upkeep["immediate_actions"]] == ["Close highway shoulder", "Remove landslide debris"]
        assert [a["label"] for a in upkeep["follow_up_actions"]] == ["Routine visual monitor"]
        assert [n["text"] for n in upkeep["notes"]] == ["Crew cleared the ditch on 9/21."]
        assert [d["incident_id"] for d in upkeep["also_reported"]] == [repeat]
        assert upkeep["also_reported"][0]["coordinator_notes"] == "Already in."

        outside = items[closed]
        assert outside["in_record"] is False and outside["outcome"] == "NO_ASSESSMENT_REQUIRED"
        assert outside["maintenance"]["triage"]["notes"] == "Cleared by the crew."
        assert outside["maintenance"]["immediate_actions"] == []
        assert outside["distance_m"] is not None and outside["distance_m"] < 1

        # Recurrence: the earlier incident's form has a type; match it.
        assert client_db.put(f"/submissions/{other_id}/gisa/incident-types", json={"items": ["SLIDE"]}, headers=staff).status_code == 200

        def relation():
            listed = client_db.get(f"/submissions/{form}/site-history", headers=staff).json()["incidents"]
            return next(item for item in listed if item["incident_id"] == in_record)["relation"]

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

"""My Work holds only what concerns the person: a coordinator's triage queue is
the reports in the districts they cover (their Maintenance lists and their home
district), and every report in it is one they may open.

Requires a live MariaDB at Alembic head. Run with: pytest -m db
"""
from __future__ import annotations

import uuid

import pytest

pytestmark = pytest.mark.db

_RUN = uuid.uuid4().hex[:6]
_PASSWORD = "my-work-scope-password"


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(scope="module")
def cast(client_db, admin_token):
    admin = _auth(admin_token)
    made = {}
    for key in ("coord11", "coord45", "crew", "nobody"):
        email = f"mywork-{key}-{_RUN}@example.test"
        resp = client_db.post("/admin/users", json={"email": email, "full_name": f"Zzz My Work {key}", "password": _PASSWORD}, headers=admin)
        assert resp.status_code == 201, resp.text
        made[key] = {"id": resp.json()["id"], "email": email}
    # Coverage comes only from the district lists: none of them has a home district.
    for district, key in (("11", "coord11"), ("04", "coord45"), ("05", "coord45")):
        assert client_db.post(f"/org/maintenance/{district}/coordinators", json={"user_id": made[key]["id"]}, headers=admin).status_code == 200
    assert client_db.post("/org/maintenance/07/crew", json={"user_id": made["crew"]["id"]}, headers=admin).status_code == 200
    for key in made:
        resp = client_db.post("/auth/login", json={"email": made[key]["email"], "password": _PASSWORD})
        made[key]["token"] = resp.json()["access_token"]
    yield made
    for district, key in (("11", "coord11"), ("04", "coord45"), ("05", "coord45")):
        client_db.delete(f"/org/maintenance/{district}/coordinators/{made[key]['id']}", headers=admin)
    client_db.delete(f"/org/maintenance/07/crew/{made['crew']['id']}", headers=admin)
    for person in made.values():
        client_db.patch(f"/admin/users/{person['id']}", json={"is_active": False}, headers=admin)


@pytest.fixture(scope="module")
def reports(client_db, cast):
    crew = _auth(cast["crew"]["token"])
    ids = {}
    for district, county, route in (("11", "SD", "94"), ("04", "MRN", "1"), ("05", "MON", "1"), ("07", "LA", "2")):
        resp = client_db.post(
            "/incidents",
            json={
                "title": f"My Work scope {district} {_RUN}", "incident_type": "ROCK_FALL", "description": "Scope fixture.",
                "first_observed_at": "2026-09-22T08:00:00", "latitude": 34.0, "longitude": -118.0,
                "district": district, "county": county, "route": route, "post_mile": "10.00",
            },
            headers=crew,
        )
        assert resp.status_code == 200, resp.text
        ids[district] = resp.json()["incident"]["id"]
    return ids


def _triage(client_db, token) -> set[int]:
    resp = client_db.get("/incidents", params={"queue": "triage", "limit": 1000}, headers=_auth(token))
    assert resp.status_code == 200, resp.text
    return {item["id"] for item in resp.json()["items"]}


def test_a_coordinator_triages_only_their_district(client_db, cast, reports):
    mine = _triage(client_db, cast["coord11"]["token"]) & set(reports.values())
    assert mine == {reports["11"]}


def test_every_district_on_their_lists_counts_and_can_be_opened(client_db, cast, reports):
    mine = _triage(client_db, cast["coord45"]["token"]) & set(reports.values())
    assert mine == {reports["04"], reports["05"]}
    token = _auth(cast["coord45"]["token"])
    assert client_db.get(f"/incidents/{reports['05']}/attachments", headers=token).status_code == 200
    assert client_db.get(f"/incidents/{reports['11']}/attachments", headers=token).status_code == 403


def test_the_broad_list_is_still_broad(client_db, cast, reports):
    # Browsing incidents is not the work queue: the coordinator can still see them all.
    resp = client_db.get("/incidents", params={"limit": 1000}, headers=_auth(cast["coord11"]["token"]))
    listed = {item["id"] for item in resp.json()["items"]}
    assert set(reports.values()) <= listed


def test_nobody_else_has_anything_to_triage(client_db, cast, reports, admin_token):
    assert not (_triage(client_db, cast["crew"]["token"]) & set(reports.values()))
    assert set(reports.values()) <= _triage(client_db, admin_token)
    assert client_db.get("/incidents", params={"queue": "nonsense"}, headers=_auth(admin_token)).status_code == 400

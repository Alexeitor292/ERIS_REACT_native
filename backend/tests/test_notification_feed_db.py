"""The notification feed (web bell, mobile app) and its push to phones.

Requires a live MariaDB at Alembic head. Run with: pytest -m db
"""
from __future__ import annotations

import pytest

from tests.org_people import People

pytestmark = pytest.mark.db


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _login(client, email: str, password: str = "password") -> dict:
    resp = client.post("/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text
    return _auth(resp.json()["access_token"])


def _feed(client, headers) -> dict:
    resp = client.get("/notifications", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.fixture(scope="module")
def cast(client_db, admin_token):
    placed = People(client_db, admin_token, prefix="Zzz Feed")
    chief = placed.make("BRANCH_CHIEF", "feed-chief")
    branch = placed.branches[-1]
    owner = placed.make("STAFF", "feed-owner", branch_id=branch)
    other = placed.make("STAFF", "feed-other")  # West Branch A: another branch
    people = {"chief": chief, "owner": owner, "other": other}
    for person in people.values():
        person["headers"] = placed.login(person)
    yield people
    placed.cleanup()


def test_a_share_tells_the_chiefs_the_recipient_and_the_sharer(client_db, cast):
    owner, other, chief = cast["owner"], cast["other"], cast["chief"]
    form = client_db.post("/submissions", json={"title": "Feed test form"}, headers=owner["headers"]).json()["submission_id"]
    share = client_db.post(f"/submissions/{form}/share", json={"user_id": other["id"]}, headers=owner["headers"]).json()["share"]
    assert share["status"] == "PENDING"

    asked = [n for n in _feed(client_db, chief["headers"])["items"] if n["kind"] == "SHARE_APPROVAL"]
    assert asked and asked[0]["link"] == "/my-work" and "Feed test form" in asked[0]["body"]
    # Nobody is told about their own action.
    assert not [n for n in _feed(client_db, owner["headers"])["items"] if n["kind"].startswith("SHARE_")]

    # Both branch chiefs approve (owner's branch here, and West Branch A's chief).
    for headers in (chief["headers"], _login(client_db, "mock.branch.chief@dot.ca.gov")):
        item = next(i for i in client_db.get("/shares/reviews", headers=headers).json()["items"] if i["share_id"] == share["id"])
        assert client_db.post(f"/shares/{share['id']}/reviews/{item['review_id']}", json={"decision": "APPROVE"}, headers=headers).status_code == 200

    received = [n for n in _feed(client_db, other["headers"])["items"] if n["kind"] == "SHARE_RECEIVED"]
    assert received and received[0]["link"] == f"/submissions/{form}"
    approved = [n for n in _feed(client_db, owner["headers"])["items"] if n["kind"] == "SHARE_APPROVED"]
    assert approved


def test_reading_clears_the_badge(client_db, cast):
    headers = cast["other"]["headers"]
    before = client_db.get("/notifications/unread", headers=headers).json()["unread"]
    assert before >= 1
    first = _feed(client_db, headers)["items"][0]
    after_one = client_db.post("/notifications/read", json={"ids": [first["id"]]}, headers=headers).json()["unread"]
    assert after_one == before - 1
    assert client_db.post("/notifications/read", json={}, headers=headers).json()["unread"] == 0
    assert all(n["read"] for n in _feed(client_db, headers)["items"])


def test_a_new_field_report_reaches_the_districts_coordinator(client_db):
    crew = _login(client_db, "mock.maintenance.crew@dot.ca.gov")
    coordinator = _login(client_db, "mock.coordinator.d01@dot.ca.gov")
    before = {n["id"] for n in _feed(client_db, coordinator)["items"]}
    report = client_db.post(
        "/incidents",
        json={
            "incident_type": "ROCK_FALL", "description": "Feed fixture.", "first_observed_at": "2026-09-30T08:00:00",
            "latitude": 40.8, "longitude": -124.1, "district": "01", "county": "HUM", "route": "101", "post_mile": "80.00",
        },
        headers=crew,
    )
    assert report.status_code == 200, report.text
    new = [n for n in _feed(client_db, coordinator)["items"] if n["id"] not in before]
    assert any(n["kind"] == "INCIDENT_COORDINATOR_REVIEW" and "District 1" in (n["body"] or "") for n in new)


def test_a_guest_has_no_feed(client_db, viewer_token):
    assert client_db.get("/notifications", headers=_auth(viewer_token)).status_code == 403


def test_phones_are_registered_and_pushed_to(client_db, cast, monkeypatch):
    from app.db import SessionLocal
    from app.services import push

    headers, uid = cast["owner"]["headers"], cast["owner"]["id"]
    good, gone = "ExponentPushToken[feed-good-token]", "ExponentPushToken[feed-gone-token]"
    for token in (good, gone):
        assert client_db.post("/notifications/devices", json={"token": token, "platform": "ios"}, headers=headers).status_code == 200

    from app.services import notification_feed

    db = SessionLocal()
    try:
        [mine_id] = notification_feed.add(db, [uid], kind="TEST", title="Pushed", body="to the phone", link="/my-work")
        db.commit()
        sent: list[dict] = []

        def fake_post(messages):
            sent.extend(messages)
            return [{"status": "error", "details": {"error": "DeviceNotRegistered"}} if m["to"] == gone else {"status": "ok"} for m in messages]

        monkeypatch.setattr(push, "_post", fake_post)
        from sqlalchemy import text

        # Each round sends the oldest waiting rows first; other modules' rows may be ahead.
        for _ in range(100):
            push.send_pending(db)
            if db.execute(text("SELECT push_state FROM user_notifications WHERE id = :id"), {"id": mine_id}).scalar():
                break
        mine = [m for m in sent if m["title"] == "Pushed"]
        assert {m["to"] for m in mine} == {good, gone}
        assert mine[0]["data"]["link"] == "/my-work"

        active = dict(db.execute(text("SELECT token, is_active FROM push_devices WHERE token IN (:a, :b)"), {"a": good, "b": gone}).all())
        assert active == {good: 1, gone: 0}
    finally:
        db.close()
    assert client_db.post("/notifications/devices/unregister", json={"token": good}, headers=headers).status_code == 200

"""Saved screen layouts: each person's own, named, one default per screen.

Requires a live MariaDB at Alembic head with the mock accounts loaded.
Run with: pytest -m db
"""

from __future__ import annotations

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.db

SCOPE = "submission_canvas"
LAYOUT = {"version": 2, "custom": True, "order": ["report_header"], "sizes": {}, "positions": {}}


def _login(client, email: str) -> dict:
    resp = client.post("/auth/login", json={"email": email, "password": "password"})
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


@pytest.fixture()
def staff(client_db):
    headers = _login(client_db, "mock.staff@dot.ca.gov")
    yield headers
    from app.db import engine

    with engine.begin() as conn:
        conn.execute(
            text(
                "DELETE l FROM user_saved_layouts l JOIN users u ON u.id = l.user_id "
                "WHERE u.email IN ('mock.staff@dot.ca.gov', 'mock.staff.2@dot.ca.gov')"
            )
        )


def _create(client, headers, name, **extra):
    return client.post("/me/layouts", json={"scope": SCOPE, "name": name, "layout": LAYOUT, **extra}, headers=headers)


class TestSavedLayouts:
    def test_create_list_update_and_delete(self, client_db, staff):
        created = _create(client_db, staff, "  Field   review  ")
        assert created.status_code == 201, created.text
        body = created.json()
        assert body["name"] == "Field review" and body["layout"] == LAYOUT and body["is_default"] is False

        listed = client_db.get(f"/me/layouts?scope={SCOPE}", headers=staff).json()["items"]
        assert [item["name"] for item in listed] == ["Field review"]

        moved = {**LAYOUT, "order": ["distribution"]}
        updated = client_db.put(f"/me/layouts/{body['id']}", json={"name": "Office", "layout": moved}, headers=staff)
        assert updated.status_code == 200, updated.text
        assert updated.json()["name"] == "Office" and updated.json()["layout"] == moved

        assert client_db.delete(f"/me/layouts/{body['id']}", headers=staff).status_code == 204
        assert client_db.get(f"/me/layouts?scope={SCOPE}", headers=staff).json()["items"] == []

    def test_only_one_default_per_screen(self, client_db, staff):
        first = _create(client_db, staff, "First", is_default=True).json()
        second = _create(client_db, staff, "Second", is_default=True).json()
        items = {i["name"]: i["is_default"] for i in client_db.get(f"/me/layouts?scope={SCOPE}", headers=staff).json()["items"]}
        assert items == {"First": False, "Second": True}
        client_db.put(f"/me/layouts/{first['id']}", json={"is_default": True}, headers=staff)
        items = {i["name"]: i["is_default"] for i in client_db.get(f"/me/layouts?scope={SCOPE}", headers=staff).json()["items"]}
        assert items == {"First": True, "Second": False}
        assert second["id"] != first["id"]

    def test_a_name_is_unique_per_person(self, client_db, staff):
        assert _create(client_db, staff, "Mine").status_code == 201
        duplicate = _create(client_db, staff, "Mine")
        assert duplicate.status_code == 409, duplicate.text
        other = _login(client_db, "mock.staff.2@dot.ca.gov")
        assert _create(client_db, other, "Mine").status_code == 201

    def test_someone_elses_layout_is_not_found(self, client_db, staff):
        mine = _create(client_db, staff, "Private").json()
        other = _login(client_db, "mock.staff.2@dot.ca.gov")
        assert client_db.put(f"/me/layouts/{mine['id']}", json={"name": "Taken"}, headers=other).status_code == 404
        assert client_db.delete(f"/me/layouts/{mine['id']}", headers=other).status_code == 404
        assert client_db.get(f"/me/layouts?scope={SCOPE}", headers=other).json()["items"] == []

    def test_bad_input_is_refused(self, client_db, staff):
        assert client_db.post("/me/layouts", json={"scope": "other", "name": "x", "layout": LAYOUT}, headers=staff).status_code == 422
        assert _create(client_db, staff, "   ").status_code == 422
        huge = {"blob": "x" * 25_000}
        assert client_db.post("/me/layouts", json={"scope": SCOPE, "name": "Huge", "layout": huge}, headers=staff).status_code == 413

    def test_guests_and_anonymous_callers_are_refused(self, client_db, viewer_token):
        assert client_db.get(f"/me/layouts?scope={SCOPE}").status_code == 401
        guest = {"Authorization": f"Bearer {viewer_token}"}
        assert client_db.get(f"/me/layouts?scope={SCOPE}", headers=guest).status_code == 403

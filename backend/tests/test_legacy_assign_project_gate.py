from __future__ import annotations

from uuid import uuid4

import pytest

pytestmark = pytest.mark.db


def test_legacy_admin_assign_returns_controlled_project_gate(client_db, admin_token):
    headers = {"Authorization": f"Bearer {admin_token}"}
    created = client_db.post(
        "/incidents",
        headers=headers,
        json={
            "title": f"Legacy assign Project gate {uuid4().hex}",
            "first_observed_at": "2026-08-17T18:00:00",
            "latitude": 38.800337,
            "longitude": -121.256742,
            "district": "03",
            "county": "PLA",
            "route": "065",
            "post_mile": "6.40",
        },
    )
    assert created.status_code == 200, created.text
    incident_id = int(created.json()["incident"]["id"])

    me = client_db.get("/auth/me", headers=headers)
    assert me.status_code == 200
    admin_user_id = int(me.json()["id"])

    # The DB test client normally satisfies Project prerequisites for old
    # downstream fixtures. This internal header tells the fixture adapter to
    # preserve the intentional projectless state for this regression proof.
    gated = client_db.post(
        f"/incidents/{incident_id}/assign",
        headers={
            **headers,
            "X-ERIS-Test-Preserve-Projectless": "1",
        },
        json={"assignee_user_id": admin_user_id},
    )

    assert gated.status_code == 409, gated.text
    detail = str(gated.json().get("detail", ""))
    assert detail == "Choose or create a Project for this Incident before engineering assignment."
    assert "OperationalError" not in detail
    assert "UPDATE incidents" not in detail
    assert "sqlalche.me" not in detail

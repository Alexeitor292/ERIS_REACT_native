from __future__ import annotations

from uuid import uuid4

import pytest

pytestmark = pytest.mark.db


def _create_incident(client_db, headers: dict[str, str], suffix: str) -> int:
    response = client_db.post(
        "/incidents",
        headers=headers,
        json={
            "title": f"Batch classification {suffix} {uuid4().hex[:8]}",
            "first_observed_at": "2026-08-17T12:00:00",
            "latitude": 38.58,
            "longitude": -121.49,
            "district": "04",
            "county": "Marin",
            "route": "1",
            "post_mile": suffix,
        },
    )
    assert response.status_code == 200, response.text
    return int(response.json()["incident"]["id"])


def test_batch_classification_preserves_requested_order_and_unclassified_state(client_db, admin_token) -> None:
    headers = {"Authorization": f"Bearer {admin_token}"}
    first_id = _create_incident(client_db, headers, "10.1")
    second_id = _create_incident(client_db, headers, "10.2")

    response = client_db.post(
        "/incident-classifications/query",
        headers=headers,
        json={"incident_ids": [second_id, first_id, second_id]},
    )
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert [int(item["incident_id"]) for item in items] == [second_id, first_id]
    assert all(item["classification_status"] == "UNCLASSIFIED" for item in items)
    assert all(item["reason"] == "ASSESSMENT_NOT_STARTED" for item in items)
    assert all(item["codes"] == [] for item in items)

from __future__ import annotations

from uuid import uuid4

import pytest

from app.routes.incident_classification import _classification_view


def test_classification_view_preserves_multi_value_review_state() -> None:
    assert _classification_view(None, ["ROCK_FALL"]) == {
        "classification_status": "UNCLASSIFIED",
        "reason": "ASSESSMENT_NOT_STARTED",
        "confirmed": False,
        "codes": [],
    }
    assert _classification_view("DRAFT", ["ROCK_FALL", "EROSION"])["codes"] == []

    submitted = _classification_view("SUBMITTED", ["ROCK_FALL", "EROSION"])
    assert submitted["classification_status"] == "CLASSIFIED_PENDING_REVIEW"
    assert submitted["confirmed"] is False
    assert submitted["codes"] == [
        {"code": "ROCK_FALL", "label": "Rock Fall"},
        {"code": "EROSION", "label": "Erosion"},
    ]

    approved = _classification_view("APPROVED", ["ROCK_FALL", "EROSION"])
    assert approved["classification_status"] == "CLASSIFIED"
    assert approved["confirmed"] is True
    assert approved["codes"] == submitted["codes"]


@pytest.mark.db
def test_incident_classification_follows_real_assessment_lifecycle(client_db, admin_token) -> None:
    headers = {"Authorization": f"Bearer {admin_token}"}
    me = client_db.get("/auth/me", headers=headers)
    assert me.status_code == 200, me.text
    admin_user_id = int(me.json()["id"])

    unique = uuid4().hex[:10]
    created = client_db.post(
        "/incidents",
        headers=headers,
        json={
            "title": f"Classification lifecycle {unique}",
            "description": "Classification must come from the completed field assessment.",
            "first_observed_at": "2026-08-17T12:00:00",
            "latitude": 38.581600,
            "longitude": -121.494400,
            "district": "04",
            "county": "Marin",
            "route": "1",
            "post_mile": "10.0",
        },
    )
    assert created.status_code == 200, created.text
    incident_id = int(created.json()["incident"]["id"])

    unclassified = client_db.get(f"/incidents/{incident_id}/classification", headers=headers)
    assert unclassified.status_code == 200, unclassified.text
    assert unclassified.json()["classification_status"] == "UNCLASSIFIED"
    assert unclassified.json()["reason"] == "ASSESSMENT_NOT_STARTED"
    assert unclassified.json()["codes"] == []

    triaged = client_db.post(
        f"/incidents/{incident_id}/triage",
        headers=headers,
        json={"disposition": "ASSESSMENT_REQUIRED", "notes": "Field assessment required."},
    )
    assert triaged.status_code == 200, triaged.text
    assessment_id = int(triaged.json()["assessment"]["id"])

    branch_options = client_db.get(f"/assessments/{assessment_id}/branch-options", headers=headers)
    assert branch_options.status_code == 200, branch_options.text
    assert branch_options.json()["items"], "Expected a configured branch chief option"
    branch_chief_id = int(branch_options.json()["items"][0]["id"])

    delegated = client_db.post(
        f"/assessments/{assessment_id}/delegate-branch",
        headers=headers,
        json={"branch_chief_user_id": branch_chief_id, "notes": "Classification lifecycle test."},
    )
    assert delegated.status_code == 200, delegated.text

    assigned = client_db.post(
        f"/assessments/{assessment_id}/assign-engineer",
        headers=headers,
        json={"engineer_user_id": admin_user_id, "notes": "Admin acts as eligible test engineer."},
    )
    assert assigned.status_code == 200, assigned.text
    submission_id = int(assigned.json()["assessment"]["submission_id"])

    recorded = client_db.put(
        f"/submissions/{submission_id}/gisa/incident-types",
        headers=headers,
        json={"items": ["ROCK_FALL", "EROSION"]},
    )
    assert recorded.status_code == 200, recorded.text
    assert set(recorded.json()["incident_types"]) == {"ROCK_FALL", "EROSION"}

    # Draft assessment values are still field work, not official Incident
    # classification. The endpoint intentionally does not leak them as final.
    draft = client_db.get(f"/incidents/{incident_id}/classification", headers=headers)
    assert draft.status_code == 200, draft.text
    assert draft.json()["assessment_state"] == "DRAFT"
    assert draft.json()["classification_status"] == "UNCLASSIFIED"
    assert draft.json()["reason"] == "ASSESSMENT_IN_PROGRESS"
    assert draft.json()["codes"] == []

    submitted = client_db.post(
        f"/assessments/{assessment_id}/submit",
        headers=headers,
        json={"notes": "Assessment classification submitted for review."},
    )
    assert submitted.status_code == 200, submitted.text
    assert submitted.json()["assessment"]["state"] == "SUBMITTED"

    pending = client_db.get(f"/incidents/{incident_id}/classification", headers=headers)
    assert pending.status_code == 200, pending.text
    pending_body = pending.json()
    assert pending_body["classification_status"] == "CLASSIFIED_PENDING_REVIEW"
    assert pending_body["confirmed"] is False
    assert pending_body["source"] == "GISA_ASSESSMENT"
    assert {item["code"] for item in pending_body["codes"]} == {"ROCK_FALL", "EROSION"}
    assert {item["label"] for item in pending_body["codes"]} == {"Rock Fall", "Erosion"}

    approved = client_db.post(
        f"/assessments/{assessment_id}/review",
        headers=headers,
        json={"action": "APPROVE", "notes": "Classification confirmed."},
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["state"] == "APPROVED"

    confirmed = client_db.get(f"/incidents/{incident_id}/classification", headers=headers)
    assert confirmed.status_code == 200, confirmed.text
    confirmed_body = confirmed.json()
    assert confirmed_body["classification_status"] == "CLASSIFIED"
    assert confirmed_body["confirmed"] is True
    assert confirmed_body["reason"] == "ASSESSMENT_APPROVED"
    assert confirmed_body["assessment_state"] == "APPROVED"
    assert confirmed_body["assigned_at"] is not None
    assert confirmed_body["codes"] == pending_body["codes"]

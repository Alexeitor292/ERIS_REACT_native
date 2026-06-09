"""
DB-backed mutation flow tests — require a live MariaDB stamped at Alembic head.
Run in isolation with: pytest -m db

Covers:
  - Submission create / GISA patch / GET round-trip / submit-readiness errors
  - Incident create / list / location candidates / location link / timeline

Records created: one submission and one incident per test run are added to the
DB via module-scoped fixtures. These records persist locally between runs;
CI always starts with a fresh MariaDB container so there is no cross-run bleed.
"""
import uuid

import pytest

pytestmark = pytest.mark.db

_RUN_ID = uuid.uuid4().hex[:8]

# GISA payload used for patch and round-trip assertions.
# material_soil=True is required to persist est_boulder_pct (it is a soil
# composition field that the patch endpoint clears when soil is not selected).
# Debris percentages sum to 100 so debris_pct validation passes at submit time.
_GISA_PAYLOAD = {
    "district": "04",
    "county": "Marin",
    "route": "1",
    "post_mile": "23.1",
    "latitude": 37.9,
    "longitude": -122.5,
    "pavement_ground_annotation_layout_json": {
        "version": 1,
        "shapes": [{"type": "circle", "x": 10, "y": 20}],
    },
    "material_pavement_type": "ASPHALT",
    "material_rock": True,
    "est_rock_pct": 60.0,
    "material_soil": True,
    "est_boulder_pct": 40.0,
    "est_debris_clay_silt_pct": 25.0,
    "est_debris_sand_pct": 25.0,
    "est_debris_gravel_pct": 25.0,
    "est_debris_boulder_pct": 25.0,
    "pavement_ground_cracks": True,
}

_INCIDENT_PAYLOAD = {
    "title": f"Mutation test incident {_RUN_ID}",
    "incident_type": "ROCK_FALL",
    "description": "Integration test incident for mutation flow tests",
    "first_observed_at": "2026-06-08T10:00:00",
    "latitude": 37.7749,
    "longitude": -122.4194,
    "district": "04",
    "county": "San Francisco",
    "route": "101",
    "post_mile": "12.5",
}


# ---------------------------------------------------------------------------
# Module-scoped fixtures — shared state for the test session within this file
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def submission_id(admin_token, client_db):
    """Creates one draft submission per module run; returns its ID."""
    resp = client_db.post(
        "/submissions",
        json={"title": f"Mutation test submission {_RUN_ID}"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert resp.status_code == 200, f"Create submission failed: {resp.status_code} {resp.text}"
    return resp.json()["submission_id"]


@pytest.fixture(scope="module")
def patched_gisa(admin_token, client_db, submission_id):
    """Patches GISA fields onto the test submission once; returns the gisa dict."""
    resp = client_db.patch(
        f"/submissions/{submission_id}/gisa",
        json=_GISA_PAYLOAD,
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert resp.status_code == 200, f"GISA patch failed: {resp.status_code} {resp.text}"
    return resp.json()["gisa"]


@pytest.fixture(scope="module")
def incident_id(admin_token, client_db):
    """Creates one test incident per module run; returns its ID."""
    resp = client_db.post(
        "/incidents",
        json=_INCIDENT_PAYLOAD,
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert resp.status_code == 200, f"Create incident failed: {resp.status_code} {resp.text}"
    return resp.json()["incident"]["id"]


@pytest.fixture(scope="module")
def linked_location_id(admin_token, client_db, incident_id):
    """Links a new location to the test incident; returns the location_id."""
    resp = client_db.post(
        f"/incidents/{incident_id}/location-link",
        json={"mode": "CREATE_NEW"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert resp.status_code == 200, f"Location link failed: {resp.status_code} {resp.text}"
    data = resp.json()
    assert data["location_match_status"] == "NEW_LOCATION_CREATED"
    return data["location_id"]


# ---------------------------------------------------------------------------
# Submission create
# ---------------------------------------------------------------------------


class TestSubmissionCreate:
    def test_creates_draft_and_returns_id(self, admin_token, client_db):
        resp = client_db.post(
            "/submissions",
            json={"title": f"Create-test {_RUN_ID}"},
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "submission_id" in data
        assert data["submission_id"] > 0

    def test_create_without_auth_rejected(self, client_db):
        resp = client_db.post("/submissions", json={})
        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# GISA patch round-trip
# ---------------------------------------------------------------------------


class TestGISAPatch:
    def test_patch_returns_gisa_dict(self, patched_gisa):
        assert patched_gisa is not None

    def test_annotation_json_roundtrip(self, patched_gisa):
        assert patched_gisa["pavement_ground_annotation_layout_json"] == _GISA_PAYLOAD[
            "pavement_ground_annotation_layout_json"
        ]

    def test_material_pavement_type_roundtrip(self, patched_gisa):
        assert patched_gisa["material_pavement_type"] == "ASPHALT"

    def test_est_rock_pct_roundtrip(self, patched_gisa):
        assert float(patched_gisa["est_rock_pct"]) == 60.0

    def test_est_boulder_pct_roundtrip(self, patched_gisa):
        assert float(patched_gisa["est_boulder_pct"]) == 40.0

    def test_debris_pct_roundtrip(self, patched_gisa):
        assert float(patched_gisa["est_debris_clay_silt_pct"]) == 25.0
        assert float(patched_gisa["est_debris_sand_pct"]) == 25.0
        assert float(patched_gisa["est_debris_gravel_pct"]) == 25.0
        assert float(patched_gisa["est_debris_boulder_pct"]) == 25.0

    def test_pavement_ground_cracks_roundtrip(self, patched_gisa):
        assert patched_gisa["pavement_ground_cracks"] is True

    def test_patch_without_auth_rejected(self, client_db, submission_id):
        resp = client_db.patch(f"/submissions/{submission_id}/gisa", json={})
        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# GET submission — verify persisted GISA fields
# ---------------------------------------------------------------------------


class TestGetSubmission:
    def test_get_returns_status_draft(self, admin_token, client_db, submission_id, patched_gisa):
        resp = client_db.get(
            f"/submissions/{submission_id}",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        assert resp.json()["submission"]["status"] == "DRAFT"

    def test_get_returns_gisa_with_district(self, admin_token, client_db, submission_id, patched_gisa):
        resp = client_db.get(
            f"/submissions/{submission_id}",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        gisa = resp.json()["gisa"]
        assert gisa is not None
        assert gisa["district"] == "04"

    def test_get_annotation_json_persisted(self, admin_token, client_db, submission_id, patched_gisa):
        resp = client_db.get(
            f"/submissions/{submission_id}",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        annotation = resp.json()["gisa"]["pavement_ground_annotation_layout_json"]
        assert annotation is not None
        assert annotation["version"] == 1

    def test_get_without_auth_rejected(self, client_db, submission_id):
        resp = client_db.get(f"/submissions/{submission_id}")
        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Submit-readiness validation
# ---------------------------------------------------------------------------


class TestSubmitReadiness:
    def test_submit_incomplete_returns_409(self, admin_token, client_db, submission_id, patched_gisa):
        resp = client_db.post(
            f"/submissions/{submission_id}/submit",
            json={},
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 409

    def test_submit_error_mentions_missing_fields(self, admin_token, client_db, submission_id, patched_gisa):
        resp = client_db.post(
            f"/submissions/{submission_id}/submit",
            json={},
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        detail = resp.json()["detail"]
        assert "Cannot submit" in detail
        assert "missing required fields" in detail

    def test_submit_without_auth_rejected(self, client_db, submission_id):
        resp = client_db.post(f"/submissions/{submission_id}/submit", json={})
        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Incident create
# ---------------------------------------------------------------------------


class TestIncidentCreate:
    def test_created_incident_has_new_status(self, admin_token, client_db, incident_id):
        resp = client_db.get(
            f"/incidents/{incident_id}",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        inc = resp.json()["incident"]
        assert inc["id"] == incident_id
        assert inc["status"] == "NEW"
        assert inc["current_stage"] == "COORDINATOR_REVIEW"

    def test_create_without_auth_rejected(self, client_db):
        resp = client_db.post("/incidents", json=_INCIDENT_PAYLOAD)
        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Incident list
# ---------------------------------------------------------------------------


class TestIncidentList:
    def test_list_includes_created_incident(self, admin_token, client_db, incident_id):
        resp = client_db.get(
            "/incidents",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        ids = [item["id"] for item in resp.json()["items"]]
        assert incident_id in ids

    def test_list_mobile_scope_returns_200(self, admin_token, client_db):
        resp = client_db.get(
            "/incidents?scope=mobile",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        assert "items" in resp.json()


# ---------------------------------------------------------------------------
# Incident location link
# ---------------------------------------------------------------------------


class TestIncidentLocationLink:
    def test_location_candidates_returns_200(self, admin_token, client_db, incident_id):
        resp = client_db.get(
            f"/incidents/{incident_id}/location-candidates",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["incident_id"] == incident_id
        assert "items" in data

    def test_link_create_new_returns_new_location_created(self, admin_token, client_db, incident_id, linked_location_id):
        # Re-calling CREATE_NEW is idempotent: _create_or_select_location returns the
        # same location_id when district/county/route/post_mile already match.
        resp = client_db.post(
            f"/incidents/{incident_id}/location-link",
            json={"mode": "CREATE_NEW"},
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["location_id"] == linked_location_id
        assert data["location_match_status"] == "NEW_LOCATION_CREATED"

    def test_incident_location_id_set_after_link(self, admin_token, client_db, incident_id, linked_location_id):
        resp = client_db.get(
            f"/incidents/{incident_id}",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        inc = resp.json()["incident"]
        assert inc["location_id"] == linked_location_id
        assert inc["location_match_status"] == "NEW_LOCATION_CREATED"


# ---------------------------------------------------------------------------
# Incident location timeline
# ---------------------------------------------------------------------------


class TestLocationTimeline:
    def test_timeline_returns_200(self, admin_token, client_db, linked_location_id):
        resp = client_db.get(
            f"/incident-locations/{linked_location_id}/timeline",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200

    def test_timeline_location_id_matches(self, admin_token, client_db, linked_location_id):
        resp = client_db.get(
            f"/incident-locations/{linked_location_id}/timeline",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        data = resp.json()
        assert data["location"]["id"] == linked_location_id

    def test_timeline_contains_linked_incident(self, admin_token, client_db, incident_id, linked_location_id):
        resp = client_db.get(
            f"/incident-locations/{linked_location_id}/timeline",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        data = resp.json()
        incident_ids = [i["id"] for i in data["incidents"]]
        assert incident_id in incident_ids

    def test_timeline_without_auth_rejected(self, client_db, linked_location_id):
        resp = client_db.get(f"/incident-locations/{linked_location_id}/timeline")
        assert resp.status_code == 401

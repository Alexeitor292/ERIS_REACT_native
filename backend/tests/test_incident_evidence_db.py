"""A field report's evidence, as the coordinator's triage review reads it.

Before ``GET /incidents/{id}/attachments`` existed there was no way for a
maintenance coordinator to see what a reporter had attached: the only read path
for a report's files was the Mission Center map, which returns ``kind = 'PHOTO'``
rows alone, so a report whose evidence was a video or a document looked empty.
The coordinator was then asked which Incident Group the report belonged to — a
judgement about a real-world event — with none of the evidence in front of them.

These tests pin the three properties the triage review depends on: every kind of
attachment comes back, capture metadata comes with it, and the row-level scope is
the incident's own rule rather than a new one.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

pytestmark = pytest.mark.db


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _login(client_db, email: str) -> str:
    resp = client_db.post("/auth/login", json={"email": email, "password": "password"})
    assert resp.status_code == 200, f"{email} login failed: {resp.status_code} {resp.text}"
    return resp.json()["access_token"]


@pytest.fixture(scope="module")
def coordinator_token(client_db):
    return _login(client_db, "mock.coordinator.d01@dot.ca.gov")


@pytest.fixture(scope="module")
def reporter_token(client_db):
    return _login(client_db, "mock.maintenance.crew@dot.ca.gov")


@pytest.fixture(scope="module", autouse=True)
def _no_object_store():
    """Uploads and download links stand in for MinIO, which CI's DB job does not run."""
    with patch("app.routes.incidents.put_object_bytes"), patch(
        "app.routes.incidents.object_access_url",
        side_effect=lambda bucket, object_key, expires_seconds=900: f"https://storage.test/{bucket}/{object_key}",
    ):
        yield


@pytest.fixture(scope="module")
def report(client_db, reporter_token):
    """A district-01 report filed by the maintenance reporter, with three files."""
    resp = client_db.post(
        "/incidents",
        json={
            "title": "Evidence review fixture",
            "incident_type": "ROCK_FALL",
            "description": "Boulders on the eastbound shoulder.",
            "first_observed_at": "2026-09-20T08:00:00",
            "latitude": 40.605,
            "longitude": -124.134,
            "district": "01",
            "county": "HUM",
            "route": "101",
            "post_mile": "84.20",
        },
        headers=_auth(reporter_token),
    )
    assert resp.status_code == 200, f"create incident failed: {resp.status_code} {resp.text}"
    incident_id = resp.json()["incident"]["id"]

    uploads = [
        ("PHOTO", "slide.jpg", b"\xff\xd8\xff\xe0 jpeg bytes", "image/jpeg"),
        ("VIDEO", "slide.mp4", b"\x00\x00\x00 ftyp mp4 bytes", "video/mp4"),
        ("DOC", "field-notes.pdf", b"%PDF-1.4 notes", "application/pdf"),
    ]
    for kind, name, blob, mime in uploads:
        upload = client_db.post(
            f"/incidents/{incident_id}/attachments?kind={kind}",
            files={"file": (name, blob, mime)},
            headers=_auth(reporter_token),
        )
        assert upload.status_code == 200, f"{kind} upload failed: {upload.status_code} {upload.text}"
    return {"incident_id": incident_id}


class TestTheCoordinatorSeesEveryAttachment:
    def test_all_three_kinds_come_back_not_only_photos(self, client_db, coordinator_token, report):
        resp = client_db.get(
            f"/incidents/{report['incident_id']}/attachments", headers=_auth(coordinator_token)
        )
        assert resp.status_code == 200, resp.text
        items = resp.json()["items"]
        assert {item["kind"] for item in items} == {"PHOTO", "VIDEO", "DOC"}, (
            "The Mission Center photo map returns PHOTO rows alone; the triage review must not "
            "inherit that filter or a video-only report reads as having no evidence."
        )

    def test_every_item_carries_what_the_review_renders(self, client_db, coordinator_token, report):
        resp = client_db.get(
            f"/incidents/{report['incident_id']}/attachments", headers=_auth(coordinator_token)
        )
        items = resp.json()["items"]
        for item in items:
            assert item["download_url"], "a file with no URL cannot be looked at"
            assert item["file_name"]
            assert item["mime_type"]
            # Present even when null: the review distinguishes "no position
            # recorded" from "position absent from the payload".
            for key in ("captured_at", "latitude", "longitude", "camera_heading_deg", "horizontal_accuracy_m"):
                assert key in item, f"{key} missing from the evidence payload"

    def test_order_is_the_order_they_were_attached(self, client_db, coordinator_token, report):
        resp = client_db.get(
            f"/incidents/{report['incident_id']}/attachments", headers=_auth(coordinator_token)
        )
        names = [item["file_name"] for item in resp.json()["items"]]
        assert names == ["slide.jpg", "slide.mp4", "field-notes.pdf"]

    def test_a_report_with_nothing_attached_is_an_empty_list_not_an_error(
        self, client_db, coordinator_token, reporter_token
    ):
        created = client_db.post(
            "/incidents",
            json={
                "title": "No evidence fixture",
                "incident_type": "ROCK_FALL",
                "description": "Reported by radio, no photos taken.",
                "first_observed_at": "2026-09-20T09:00:00",
                "latitude": 40.61,
                "longitude": -124.14,
                "district": "01",
                "county": "HUM",
                "route": "101",
                "post_mile": "84.30",
            },
            headers=_auth(reporter_token),
        )
        incident_id = created.json()["incident"]["id"]
        resp = client_db.get(f"/incidents/{incident_id}/attachments", headers=_auth(coordinator_token))
        assert resp.status_code == 200
        assert resp.json()["items"] == []


class TestScopeIsTheIncidentsOwnRule:
    def test_the_reporter_reads_their_own_report(self, client_db, reporter_token, report):
        resp = client_db.get(
            f"/incidents/{report['incident_id']}/attachments", headers=_auth(reporter_token)
        )
        assert resp.status_code == 200
        assert len(resp.json()["items"]) == 3

    def test_a_missing_incident_is_404(self, client_db, coordinator_token):
        resp = client_db.get("/incidents/99999999/attachments", headers=_auth(coordinator_token))
        assert resp.status_code == 404

    def test_a_viewer_cannot_see_the_evidence_of_a_report_still_in_flight(
        self, client_db, viewer_token, report
    ):
        # 404, not 403: a viewer must not be able to learn that an unapproved
        # report exists by probing ids (org model design §4.3). The approved-record
        # half lives in test_viewer_visibility_db, which owns an approved fixture.
        resp = client_db.get(
            f"/incidents/{report['incident_id']}/attachments", headers=_auth(viewer_token)
        )
        assert resp.status_code == 404, resp.text


class TestTheReporterIsNamed:
    def test_the_incident_payload_names_who_filed_it(self, client_db, coordinator_token, report):
        """"Filed by User #7" is not an answer to "who reported this?"."""
        resp = client_db.get(f"/incidents/{report['incident_id']}", headers=_auth(coordinator_token))
        assert resp.status_code == 200, resp.text
        incident = resp.json()["incident"]
        assert incident["reporter_name"] == "Mock Maintenance Crew"
        assert incident["reporter_email"] == "mock.maintenance.crew@dot.ca.gov"

    def test_the_list_names_them_too_so_the_queue_and_the_review_agree(
        self, client_db, coordinator_token, report
    ):
        resp = client_db.get("/incidents?limit=200", headers=_auth(coordinator_token))
        assert resp.status_code == 200
        rows = [row for row in resp.json()["items"] if row["id"] == report["incident_id"]]
        assert rows and rows[0]["reporter_name"] == "Mock Maintenance Crew"

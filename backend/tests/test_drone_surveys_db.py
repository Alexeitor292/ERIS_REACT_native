"""Drone surveys on a technical form: the elevation patch, the orthomosaic, and
the before/after record kept with them.

Storage is replaced by a dict, so MinIO is not needed. Requires a live MariaDB
at Alembic head. Run with: pytest -m db
"""
from __future__ import annotations

import json
import math
import struct

import pytest

from tests.org_people import People

pytestmark = pytest.mark.db


def patch_bytes(west=-122.50, south=37.80, east=-122.499, north=37.801, cols=4, rows=3, values=None) -> bytes:
    header = json.dumps({"west": west, "south": south, "east": east, "north": north, "cols": cols, "rows": rows}).encode()
    header += b" " * ((4 - (12 + len(header)) % 4) % 4)
    values = values if values is not None else [100.0 + i for i in range(cols * rows)]
    return b"ERISDSM1" + struct.pack("<I", len(header)) + header + struct.pack(f"<{len(values)}f", *values)


@pytest.fixture(autouse=True)
def memory_storage(monkeypatch):
    from app.routes import drone_surveys

    store: dict[str, bytes] = {}
    monkeypatch.setattr(drone_surveys, "put_object_bytes", lambda *, object_key, data, content_type, bucket=None: store.__setitem__(object_key, data))
    monkeypatch.setattr(drone_surveys, "get_object_bytes", lambda *, object_key, bucket=None: (store[object_key], "application/octet-stream"))
    monkeypatch.setattr(drone_surveys, "remove_object_quietly", lambda *, object_key, bucket=None: store.pop(object_key, None))
    return store


@pytest.fixture(scope="module")
def cast(client_db, admin_token):
    placed = People(client_db, admin_token, prefix="Zzz Drone")
    owner = placed.make("STAFF", "drone-owner")
    other = placed.make("STAFF", "drone-other")
    people = {"owner": owner, "other": other}
    for person in people.values():
        person["headers"] = placed.login(person)
    form = client_db.post("/submissions", json={"title": "Drone survey form"}, headers=owner["headers"]).json()["submission_id"]
    people["form"] = form
    yield people
    placed.cleanup()


def _create(client_db, cast, **meta):
    body = {"label": "After the storm", "captured_on": "2026-09-27", "source": "DroneDeploy", "dsm_filename": "dsm.tif",
            "source_crs": "EPSG:32610", "resolution_m": 0.25, "vertical_offset_m": -31.5, "offset_mode": "AUTO", **meta}
    files = {"patch": ("patch.bin", patch_bytes(), "application/octet-stream")}
    if "overlay_corners" in meta:
        files["overlay"] = ("ortho.webp", b"RIFF....WEBPVP8 ", "image/webp")
    return client_db.post(
        f"/submissions/{cast['form']}/drone-surveys", data={"meta": json.dumps(body)}, files=files, headers=cast["owner"]["headers"]
    )


def test_a_survey_keeps_its_patch_image_and_offset(client_db, cast, memory_storage):
    corners = [[-122.5, 37.801], [-122.499, 37.801], [-122.499, 37.8], [-122.5, 37.8]]
    resp = _create(client_db, cast, overlay_corners=corners)
    assert resp.status_code == 201, resp.text
    survey = resp.json()
    assert survey["bounds"] == {"west": -122.5, "south": 37.8, "east": -122.499, "north": 37.801}
    assert (survey["cols"], survey["rows"]) == (4, 3)
    assert survey["vertical_offset_m"] == -31.5 and survey["has_overlay"] and survey["overlay_corners"] == corners

    listed = client_db.get(f"/submissions/{cast['form']}/drone-surveys", headers=cast["other"]["headers"]).json()["items"]
    assert survey["id"] in [s["id"] for s in listed]
    patch = client_db.get(f"/submissions/{cast['form']}/drone-surveys/{survey['id']}/patch", headers=cast["other"]["headers"])
    assert patch.status_code == 200 and patch.content == patch_bytes()
    image = client_db.get(f"/submissions/{cast['form']}/drone-surveys/{survey['id']}/overlay", headers=cast["owner"]["headers"])
    assert image.status_code == 200 and image.headers["content-type"] == "image/webp"


def test_the_before_after_record_and_points_are_saved(client_db, cast):
    survey = _create(client_db, cast).json()
    comparison = {"original": {"slope_deg": 34.1, "height_m": 21.0}, "updated": {"slope_deg": 28.7, "height_m": 17.4}, "loss_m3": 412.0}
    points = [{"lon": -122.4995, "lat": 37.8005, "historical_m": 120.4, "actual_m": 117.9, "label": "Crest"}]
    resp = client_db.patch(
        f"/submissions/{cast['form']}/drone-surveys/{survey['id']}",
        json={"comparison": comparison, "points": points, "vertical_offset_m": -30.9, "offset_mode": "MANUAL"},
        headers=cast["owner"]["headers"],
    )
    assert resp.status_code == 200, resp.text
    saved = resp.json()
    assert saved["comparison"] == comparison and saved["points"] == points
    assert saved["vertical_offset_m"] == -30.9 and saved["offset_mode"] == "MANUAL"


def test_only_people_who_can_edit_the_form_change_it(client_db, cast):
    survey = _create(client_db, cast).json()
    other = cast["other"]["headers"]
    base = f"/submissions/{cast['form']}/drone-surveys"
    assert client_db.patch(f"{base}/{survey['id']}", json={"label": "x"}, headers=other).status_code == 403
    assert client_db.delete(f"{base}/{survey['id']}", headers=other).status_code == 403
    files = {"patch": ("patch.bin", patch_bytes(), "application/octet-stream")}
    assert client_db.post(base, data={"meta": "{}"}, files=files, headers=other).status_code == 403


def test_a_damaged_or_oversized_patch_is_refused(client_db, cast):
    base = f"/submissions/{cast['form']}/drone-surveys"
    headers = cast["owner"]["headers"]

    def post(data: bytes):
        return client_db.post(base, data={"meta": "{}"}, files={"patch": ("p.bin", data, "application/octet-stream")}, headers=headers)

    assert post(b"not a patch").status_code == 422
    assert post(patch_bytes()[:-4]).status_code == 422  # one value short
    assert post(patch_bytes(west=-123.0, east=-122.0)).status_code == 422  # a county, not a site
    nan_values = [math.nan] * 12
    assert post(patch_bytes(values=nan_values)).status_code == 201  # NaN is "the drone saw nothing"


def test_deleting_a_survey_removes_its_files(client_db, cast, memory_storage):
    survey = _create(client_db, cast).json()
    before = len(memory_storage)
    assert client_db.delete(f"/submissions/{cast['form']}/drone-surveys/{survey['id']}", headers=cast["owner"]["headers"]).status_code == 200
    assert len(memory_storage) == before - 1
    assert client_db.get(f"/submissions/{cast['form']}/drone-surveys/{survey['id']}/patch", headers=cast["owner"]["headers"]).status_code == 404


def test_a_guest_sees_nothing(client_db, cast, viewer_token):
    assert client_db.get(f"/submissions/{cast['form']}/drone-surveys", headers={"Authorization": f"Bearer {viewer_token}"}).status_code == 403

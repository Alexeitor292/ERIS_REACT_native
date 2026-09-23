"""Roadway context for measuring a slide's encroachment: the inventory cross-section
(traveled way and inside shoulders come from the extract's extra columns) and the
highway centerline around the site."""
from __future__ import annotations

import io

import openpyxl
import pytest

from app.services import roadway_context as rc

BOUNDS = {"min_lon": -122.59, "min_lat": 37.85, "max_lon": -122.57, "max_lat": 37.87}


def test_clip_keeps_the_runs_inside_with_one_vertex_either_side():
    coords = [[-122.60, 37.86], [-122.585, 37.86], [-122.58, 37.86], [-122.56, 37.86], [-122.55, 37.86]]
    assert rc._clip(coords, BOUNDS) == [[[-122.60, 37.86], [-122.585, 37.86], [-122.58, 37.86], [-122.56, 37.86]]]
    # A line that leaves and comes back gives two runs.
    wiggle = [[-122.58, 37.86], [-122.58, 37.90], [-122.58, 37.95], [-122.58, 37.865]]
    assert len(rc._clip(wiggle, BOUNDS)) == 2
    assert rc._clip([[-122.0, 37.0], [-122.1, 37.1]], BOUNDS) == []


def test_shn_centerlines_keep_the_form_route_and_county(monkeypatch):
    def fake_fetch(url, bounds, **kwargs):
        line = {"type": "LineString", "coordinates": [[-122.585, 37.86], [-122.575, 37.861]]}
        return [
            {"type": "Feature", "geometry": line, "properties": {"Route": 1, "County": "MRN", "AlignCode": "Right", "Direction": "NB", "bPM": 0.0, "ePM": 46.7}},
            {"type": "Feature", "geometry": line, "properties": {"Route": 1, "County": "SON", "AlignCode": "Right"}},
            {"type": "Feature", "geometry": line, "properties": {"Route": 101, "County": "MRN", "AlignCode": "Right"}},
        ]

    monkeypatch.setattr(rc, "fetch_arcgis_line_layer", fake_fetch)
    monkeypatch.setattr(rc.settings, "ROADWAY_CENTERLINE_SOURCE", "caltrans_shn")
    out = rc.centerlines(BOUNDS, route="001", county_code="mrn")
    assert out["source"] == "caltrans_shn"
    assert "SHN" in out["provenance"]
    assert len(out["lines"]) == 1
    assert out["lines"][0]["align"] == "Right" and out["lines"][0]["direction"] == "NB"
    assert out["lines"][0]["name"] == "Route 1"


def test_tigerweb_prefers_the_named_state_route(monkeypatch):
    def fake_tiger(bounds, **kwargs):
        line = {"type": "LineString", "coordinates": [[-122.585, 37.86], [-122.575, 37.861]]}
        return [
            {"type": "Feature", "geometry": line, "properties": {"NAME": "State Rte 1"}},
            {"type": "Feature", "geometry": line, "properties": {"NAME": "Panoramic Hwy"}},
        ]

    monkeypatch.setattr(rc, "fetch_tigerweb_road_features", fake_tiger)
    monkeypatch.setattr(rc.settings, "ROADWAY_CENTERLINE_SOURCE", "census_tigerweb")
    out = rc.centerlines(BOUNDS, route="1", county_code="MRN")
    assert [line["name"] for line in out["lines"]] == ["State Rte 1"]


# --- endpoint, against the database ----------------------------------------------------

_EXTRA = ["THY_LT_TRAV_WAY_WIDTH_AMT", "THY_RT_TRAV_WAY_WIDTH_AMT", "THY_LT_I_SHD_TOT_WIDTH_AMT", "THY_RT_I_SHD_TOT_WIDTH_AMT", "THY_HIGHWAY_GROUP_CODE"]
_HEADERS = [
    "THY_ID", "THY_DISTRICT_CODE", "THY_COUNTY_CODE", "THY_ROUTE_NAME", "THY_BEGIN_PM_AMT", "THY_END_PM_AMT",
    "THY_LT_LANES_AMT", "THY_LT_O_SHD_TOT_WIDTH_AMT", "THY_RT_LANES_AMT", "THY_RT_O_SHD_TOT_WIDTH_AMT",
    "THY_MEDIAN_TYPE_CODE", "THY_MEDIAN_WIDTH_AMT", "THY_EXTRACT_DATE", *_EXTRA,
]


def _publish_inventory(client, token, tag, rows):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(_HEADERS)
    for row in rows:
        ws.append([row.get(h) for h in _HEADERS])
    buf = io.BytesIO()
    wb.save(buf)
    auth = {"Authorization": f"Bearer {token}"}
    up = client.post(
        "/road-inventory/upload",
        files={"file": ("test.xlsx", buf.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        params={"version_tag": tag},
        headers=auth,
    )
    assert up.status_code == 201, up.text
    pub = client.post(f"/road-inventory/versions/{up.json()['version_id']}/publish", headers=auth)
    assert pub.status_code == 200, pub.text


def _cleanup(tag):
    from sqlalchemy import text

    from app.db import engine

    with engine.begin() as conn:
        conn.execute(text("DELETE FROM road_inventory_datasets WHERE version_tag = :tag"), {"tag": tag})


@pytest.mark.db
def test_roadway_context_joins_the_cross_section_and_the_centerline(client_db, admin_token, monkeypatch):
    import app.routes.road_inventory as routes

    calls = {}

    def fake_centerlines(bounds, *, route, county_code):
        calls["args"] = (bounds, route, county_code)
        return {"source": "caltrans_shn", "provenance": "test", "lines": [{"coordinates": [[-122.585, 37.86], [-122.575, 37.861]]}]}

    monkeypatch.setattr(routes, "roadway_centerlines", fake_centerlines)
    tag = "roadway-context"
    try:
        _publish_inventory(client_db, admin_token, tag, [{
            "THY_ID": 1, "THY_DISTRICT_CODE": "04", "THY_COUNTY_CODE": "MRN", "THY_ROUTE_NAME": "001",
            "THY_BEGIN_PM_AMT": 10.0, "THY_END_PM_AMT": 14.0,
            "THY_LT_LANES_AMT": 1, "THY_LT_O_SHD_TOT_WIDTH_AMT": 2.0, "THY_RT_LANES_AMT": 1, "THY_RT_O_SHD_TOT_WIDTH_AMT": 4.0,
            "THY_MEDIAN_TYPE_CODE": "A", "THY_MEDIAN_WIDTH_AMT": 0, "THY_EXTRACT_DATE": "2026-06-01",
            "THY_LT_TRAV_WAY_WIDTH_AMT": 11.0, "THY_RT_TRAV_WAY_WIDTH_AMT": 12.0,
            "THY_LT_I_SHD_TOT_WIDTH_AMT": 0, "THY_RT_I_SHD_TOT_WIDTH_AMT": 0, "THY_HIGHWAY_GROUP_CODE": "U",
        }])
        resp = client_db.get(
            "/road-inventory/roadway-context",
            params={"county": "MRN", "route": "1", "postmile": 12.3, "bbox": "-122.59,37.85,-122.57,37.87"},
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        section = body["cross_section"]
        assert section["route"] == "1" and section["county"] == "MRN"
        assert section["highway_group"] == "U"
        assert section["left"] == {"lanes": 1, "traveled_way_ft": 11.0, "outside_shoulder_ft": 2.0, "inside_shoulder_ft": 0.0}
        assert section["right"]["traveled_way_ft"] == 12.0 and section["right"]["outside_shoulder_ft"] == 4.0
        assert section["median_width_ft"] == 0.0
        assert body["centerline"]["lines"] and body["centerline_error"] is None
        assert calls["args"][1:] == ("1", "MRN")
    finally:
        _cleanup(tag)


@pytest.mark.db
def test_roadway_context_reports_a_centerline_outage(client_db, admin_token, monkeypatch):
    import app.routes.road_inventory as routes

    def down(*args, **kwargs):
        raise RuntimeError("timed out")

    monkeypatch.setattr(routes, "roadway_centerlines", down)
    resp = client_db.get(
        "/road-inventory/roadway-context",
        params={"county": "MRN", "route": "1", "postmile": 99.0, "bbox": "-122.59,37.85,-122.57,37.87"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["cross_section"] is None
    assert body["centerline"]["lines"] == []
    assert "did not answer" in body["centerline_error"]


@pytest.mark.db
@pytest.mark.parametrize("bbox", ["a,b,c,d", "-122.59,37.85,-122.57", "-80,37.85,-79.9,37.87", "-122.7,37.85,-122.57,37.87"])
def test_roadway_context_rejects_a_bad_bbox(client_db, admin_token, bbox):
    resp = client_db.get(
        "/road-inventory/roadway-context",
        params={"county": "MRN", "route": "1", "postmile": 12.3, "bbox": bbox},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert resp.status_code == 422


@pytest.mark.db
def test_roadway_context_needs_a_sign_in(client_db):
    resp = client_db.get("/road-inventory/roadway-context", params={"county": "MRN", "route": "1", "postmile": 1, "bbox": "-122.59,37.85,-122.57,37.87"})
    assert resp.status_code == 401

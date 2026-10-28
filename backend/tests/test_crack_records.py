"""Crack records: what a crack may hold, checked without a database (routes/cracks.py)."""

import re
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.routes.cracks import normalize_annotations, normalize_fields, normalize_geometry

ROOT = Path(__file__).resolve().parents[2]


def _refused(call) -> str:
    with pytest.raises(HTTPException) as caught:
        call()
    assert caught.value.status_code == 422
    return str(caught.value.detail)


def test_every_crack_offers_what_gisa_001_asks_for():
    # Location, length, width, horizontal and vertical displacement, depth and direction.
    fields = normalize_fields({
        "label": "  NB shoulder  ", "latitude": 37.7312, "longitude": -122.1975, "location_source": "PHOTO",
        "length_ft": "12.5", "width_in": 0.75, "horizontal_disp_in": 1, "vertical_disp_in": 2.25, "depth_in": 6,
        "trend_deg": 35, "orientation": "TRANSVERSE", "notes": " Opening since last week ",
    })
    assert fields == {
        "label": "NB shoulder", "latitude": 37.7312, "longitude": -122.1975, "location_source": "PHOTO",
        "length_ft": 12.5, "width_in": 0.75, "horizontal_disp_in": 1.0, "vertical_disp_in": 2.25, "depth_in": 6.0,
        "trend_deg": 35.0, "orientation": "TRANSVERSE", "notes": "Opening since last week",
    }


def test_only_the_fields_sent_are_changed_and_blanks_clear():
    assert normalize_fields({"depth_in": None}) == {"depth_in": None}
    assert normalize_fields({"length_ft": ""}) == {"length_ft": None}
    assert normalize_fields({"label": "   "}) == {"label": None}
    assert normalize_fields({}) == {}


def test_a_crack_line_runs_both_ways():
    assert normalize_fields({"trend_deg": 200})["trend_deg"] == 20.0
    assert normalize_fields({"trend_deg": 179.96})["trend_deg"] == 0.0
    assert normalize_fields({"trend_deg": 0})["trend_deg"] == 0.0
    assert "trend_deg" in _refused(lambda: normalize_fields({"trend_deg": 360}))


def test_impossible_values_are_refused_with_their_field():
    assert "length_ft" in _refused(lambda: normalize_fields({"length_ft": -1}))
    assert "width_in" in _refused(lambda: normalize_fields({"width_in": "wide"}))
    assert "depth_in" in _refused(lambda: normalize_fields({"depth_in": True}))
    assert "go together" in _refused(lambda: normalize_fields({"latitude": 37.7}))
    assert "orientation" in _refused(lambda: normalize_fields({"orientation": "SIDEWAYS"}))
    assert "location_source" in _refused(lambda: normalize_fields({"location_source": "GUESS"}))
    assert "Unknown crack fields: crack_length_ft" in _refused(lambda: normalize_fields({"crack_length_ft": 3}))
    assert "photo_attachment_id" in _refused(lambda: normalize_fields({"photo_attachment_id": "12"}))
    assert "label" in _refused(lambda: normalize_fields({"label": "x" * 81}))


def test_the_drawing_keeps_its_shapes_and_drops_anything_else():
    drawing = normalize_annotations({"version": 7, "shapes": [
        {"type": "path", "points": [[0.1, 0.7], [0.3, 0.6], [0.45, 0.74]], "color": "#FF3B30", "pressure": [1, 2]},
        {"type": "arrow", "points": [[0.4, 0.55], [0.44, 0.66]], "measure": "horizontal_disp_in"},
        {"type": "label", "at": [0.5, 0.4], "text": "Length", "measure": "length_ft"},
    ]})
    assert drawing == {"version": 1, "shapes": [
        {"type": "path", "points": [[0.1, 0.7], [0.3, 0.6], [0.45, 0.74]], "color": "#FF3B30"},
        {"type": "arrow", "points": [[0.4, 0.55], [0.44, 0.66]], "measure": "horizontal_disp_in"},
        {"type": "label", "at": [0.5, 0.4], "text": "Length", "measure": "length_ft"},
    ]}
    assert normalize_annotations(None) is None
    assert normalize_annotations({"shapes": []}) == {"version": 1, "shapes": []}


def test_a_drawing_stays_on_its_photo_and_within_bounds():
    assert "points" in _refused(lambda: normalize_annotations({"shapes": [{"type": "path", "points": [[0.1, 1.2], [0.2, 0.2]]}]}))
    assert "2 to" in _refused(lambda: normalize_annotations({"shapes": [{"type": "arrow", "points": [[0.1, 0.1]]}]}))
    assert "type" in _refused(lambda: normalize_annotations({"shapes": [{"type": "circle"}]}))
    assert "measure" in _refused(lambda: normalize_annotations({"shapes": [{"type": "label", "at": [0.1, 0.1], "measure": "area"}]}))
    assert "at most 200" in _refused(lambda: normalize_annotations({"shapes": [{"type": "label", "at": [0, 0]}] * 201}))
    assert "color" in _refused(lambda: normalize_annotations({"shapes": [{"type": "label", "at": [0, 0], "color": "red"}]}))


def test_a_mapped_trace_is_a_point_or_a_line_in_longitude_latitude():
    assert normalize_geometry({"type": "LineString", "coordinates": [[-122.19, 37.73], [-122.18, 37.74, 12]]}) == {
        "type": "LineString", "coordinates": [[-122.19, 37.73], [-122.18, 37.74]]}
    assert normalize_geometry({"type": "Point", "coordinates": [-122.19, 37.73]}) == {"type": "Point", "coordinates": [-122.19, 37.73]}
    assert "LineString" in _refused(lambda: normalize_geometry({"type": "LineString", "coordinates": [[-122.19, 37.73]]}))
    assert "latitude" in _refused(lambda: normalize_geometry({"type": "Point", "coordinates": [10, 95]}))
    assert "Point or LineString" in _refused(lambda: normalize_geometry({"type": "Polygon", "coordinates": []}))


def _create_table(sql: str) -> str:
    """The CREATE TABLE for the crack table, without comments or spacing differences."""
    start = sql.index("CREATE TABLE IF NOT EXISTS submission_gisa_cracks")
    body = sql[start:sql.index(") ENGINE=InnoDB", start)]
    body = re.sub(r"--[^\n]*", "", body)
    return re.sub(r"\s+", " ", body).strip()


def test_the_fresh_install_schema_and_the_migration_make_the_same_table():
    schema = (ROOT / "database" / "init" / "010_schema.sql").read_text()
    migration = (ROOT / "backend" / "migrations" / "versions" / "20261029_submission_cracks.py").read_text()
    assert _create_table(schema) == _create_table(migration)
    gisa = schema[schema.index("CREATE TABLE IF NOT EXISTS submission_gisa ("):]
    gisa = gisa[:gisa.index(") ENGINE=InnoDB")]
    assert "crack_length_ft" not in gisa and "pavement_ground_cracks" in gisa

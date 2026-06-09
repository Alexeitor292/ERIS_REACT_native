"""
Unit tests for road_inventory_parser.py — no database or MinIO required.
"""

from __future__ import annotations

import io
from decimal import Decimal

import openpyxl
import pytest

from app.services.road_inventory_parser import (
    ParseError,
    ParseResult,
    REQUIRED_COLUMNS,
    normalize_route,
    parse_excel,
)


# ---------------------------------------------------------------------------
# Helpers to build synthetic workbooks
# ---------------------------------------------------------------------------

_REQUIRED_HEADERS = [
    "THY_COUNTY_CODE",
    "THY_ROUTE_NAME",
    "THY_BEGIN_PM_AMT",
    "THY_END_PM_AMT",
]

_FULL_HEADERS = [
    "THY_ID", "THY_DISTRICT_CODE", "THY_COUNTY_CODE", "THY_ROUTE_NAME",
    "THY_ROUTE_SUFFIX_CODE", "THY_PM_PREFIX_CODE",
    "THY_BEGIN_PM_AMT", "THY_END_PM_AMT", "THY_PM_SUFFIX_CODE",
    "THY_LENGTH_MILES_AMT", "THY_LT_SURF_TYPE_CODE", "THY_LT_LANES_AMT",
    "THY_LT_O_SHD_TOT_WIDTH_AMT", "THY_RT_SURF_TYPE_CODE", "THY_RT_LANES_AMT",
    "THY_RT_O_SHD_TOT_WIDTH_AMT", "THY_MEDIAN_TYPE_CODE", "THY_MEDIAN_WIDTH_AMT",
    "THY_HIGHWAY_ACCESS_CODE", "THY_TERRAIN_CODE", "THY_DESIGN_SPEED_AMT",
    "THY_ADT_AMT", "THY_LANDMARK_SHORT_DESC", "THY_FUNCTIONAL_CLASS_CODE",
    "THY_MAINT_SVC_LVL_CODE", "THY_FEDERAL_AID_CODE", "THY_SCENIC_FREEWAY_CODE",
    "THY_EXTRACT_DATE",
]


def _make_workbook(headers: list[str], data_rows: list[list]) -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(headers)
    for row in data_rows:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _good_row(
    county="SAC", route="050", begin=0.0, end=1.0, **overrides
) -> list:
    """Build a full data row aligned to _FULL_HEADERS."""
    values = {
        "THY_ID": 12345,
        "THY_DISTRICT_CODE": "03",
        "THY_COUNTY_CODE": county,
        "THY_ROUTE_NAME": route,
        "THY_ROUTE_SUFFIX_CODE": None,
        "THY_PM_PREFIX_CODE": None,
        "THY_BEGIN_PM_AMT": begin,
        "THY_END_PM_AMT": end,
        "THY_PM_SUFFIX_CODE": None,
        "THY_LENGTH_MILES_AMT": round(end - begin, 4),
        "THY_LT_SURF_TYPE_CODE": "H",
        "THY_LT_LANES_AMT": 2,
        "THY_LT_O_SHD_TOT_WIDTH_AMT": 8.0,
        "THY_RT_SURF_TYPE_CODE": "H",
        "THY_RT_LANES_AMT": 2,
        "THY_RT_O_SHD_TOT_WIDTH_AMT": 8.0,
        "THY_MEDIAN_TYPE_CODE": "M",
        "THY_MEDIAN_WIDTH_AMT": 20.0,
        "THY_HIGHWAY_ACCESS_CODE": "F",
        "THY_TERRAIN_CODE": "F",
        "THY_DESIGN_SPEED_AMT": 65,
        "THY_ADT_AMT": 50000,
        "THY_LANDMARK_SHORT_DESC": "TEST SEGMENT",
        "THY_FUNCTIONAL_CLASS_CODE": "1",
        "THY_MAINT_SVC_LVL_CODE": "2",
        "THY_FEDERAL_AID_CODE": "0",
        "THY_SCENIC_FREEWAY_CODE": None,
        "THY_EXTRACT_DATE": "2025-06-08",
    }
    values.update(overrides)
    return [values[h] for h in _FULL_HEADERS]


# ---------------------------------------------------------------------------
# parse_excel: valid input
# ---------------------------------------------------------------------------

class TestParseExcelValid:
    def test_returns_parse_result(self):
        xlsx = _make_workbook(_FULL_HEADERS, [_good_row()])
        result = parse_excel(xlsx)
        assert isinstance(result, ParseResult)

    def test_correct_row_count(self):
        xlsx = _make_workbook(_FULL_HEADERS, [_good_row(), _good_row(county="ORA", route="001", begin=5.0, end=6.0)])
        result = parse_excel(xlsx)
        assert result.row_count == 2
        assert result.skipped_count == 0

    def test_normalized_fields_present(self):
        xlsx = _make_workbook(_FULL_HEADERS, [_good_row(county="SAC", route="050", begin=1.0, end=2.5)])
        result = parse_excel(xlsx)
        row = result.rows[0]
        assert row["county_code"] == "SAC"
        assert row["route_name"] == "50"  # normalized: leading zeros stripped
        assert row["begin_pm"] == Decimal("1.0")
        assert row["end_pm"] == Decimal("2.5")
        assert row["district_code"] == "03"
        assert row["left_lanes"] == 2
        assert row["adt"] == 50000

    def test_extract_date_captured(self):
        from datetime import date
        xlsx = _make_workbook(_FULL_HEADERS, [_good_row()])
        result = parse_excel(xlsx)
        assert result.extract_date == date(2025, 6, 8)

    def test_raw_json_contains_extra_cols(self):
        import json
        extra_headers = _FULL_HEADERS + ["THY_ELEMENT_ID", "THY_SEG_ORDER_ID"]
        row = _good_row() + [999, 100]
        xlsx = _make_workbook(extra_headers, [row])
        result = parse_excel(xlsx)
        raw = json.loads(result.rows[0]["raw_json"])
        assert "THY_ELEMENT_ID" in raw
        assert raw["THY_ELEMENT_ID"] == 999


# ---------------------------------------------------------------------------
# parse_excel: file-level errors → ParseError
# ---------------------------------------------------------------------------

class TestParseExcelFileErrors:
    def test_not_a_workbook(self):
        with pytest.raises(ParseError, match="Cannot open workbook"):
            parse_excel(b"this is not xlsx")

    def test_missing_required_column(self):
        headers_no_pm = [h for h in _FULL_HEADERS if h != "THY_BEGIN_PM_AMT"]
        xlsx = _make_workbook(headers_no_pm, [])
        with pytest.raises(ParseError, match="Missing required columns"):
            parse_excel(xlsx)

    def test_missing_multiple_required_columns(self):
        minimal = ["THY_ID", "THY_DISTRICT_CODE"]
        xlsx = _make_workbook(minimal, [])
        with pytest.raises(ParseError) as exc_info:
            parse_excel(xlsx)
        msg = str(exc_info.value)
        assert "THY_COUNTY_CODE" in msg
        assert "THY_ROUTE_NAME" in msg

    def test_empty_sheet(self):
        xlsx = _make_workbook([], [])
        with pytest.raises(ParseError):
            parse_excel(xlsx)


# ---------------------------------------------------------------------------
# parse_excel: row-level validation → skip + warn
# ---------------------------------------------------------------------------

class TestParseExcelRowValidation:
    def test_blank_county_skipped(self):
        xlsx = _make_workbook(
            _FULL_HEADERS,
            [_good_row(county=""), _good_row(county="SAC")],
        )
        result = parse_excel(xlsx)
        assert result.row_count == 1
        assert result.skipped_count == 1
        assert any("THY_COUNTY_CODE" in w for w in result.warnings)

    def test_blank_route_skipped(self):
        xlsx = _make_workbook(
            _FULL_HEADERS,
            [_good_row(route=""), _good_row()],
        )
        result = parse_excel(xlsx)
        assert result.row_count == 1
        assert result.skipped_count == 1

    def test_invalid_begin_pm_skipped(self):
        row = _good_row()
        row[_FULL_HEADERS.index("THY_BEGIN_PM_AMT")] = "not-a-number"
        xlsx = _make_workbook(_FULL_HEADERS, [row, _good_row()])
        result = parse_excel(xlsx)
        assert result.row_count == 1
        assert result.skipped_count == 1
        assert any("THY_BEGIN_PM_AMT" in w for w in result.warnings)

    def test_begin_ge_end_skipped(self):
        xlsx = _make_workbook(_FULL_HEADERS, [_good_row(begin=5.0, end=5.0)])
        result = parse_excel(xlsx)
        assert result.row_count == 0
        assert result.skipped_count == 1
        assert any("begin_pm" in w for w in result.warnings)

    def test_begin_gt_end_skipped(self):
        xlsx = _make_workbook(_FULL_HEADERS, [_good_row(begin=10.0, end=5.0)])
        result = parse_excel(xlsx)
        assert result.skipped_count == 1

    def test_skipped_count_in_warnings(self):
        rows = [_good_row(county="") for _ in range(3)]
        xlsx = _make_workbook(_FULL_HEADERS, rows)
        result = parse_excel(xlsx)
        assert result.skipped_count == 3
        assert any("Skipped 3" in w for w in result.warnings)


# ---------------------------------------------------------------------------
# normalize_route
# ---------------------------------------------------------------------------

class TestNormalizeRoute:
    @pytest.mark.parametrize("inp,expected", [
        ("001",    "1"),
        ("050",    "50"),
        ("101",    "101"),
        ("US 101", "101"),
        ("SR 99",  "99"),
        ("  101 ", "101"),
        ("HWY 1",  "1"),
        ("CA 1",   "1"),
        ("HIGHWAY 1", "1"),
        ("0",      "0"),
        (None,     None),
        ("",       None),
    ])
    def test_normalize(self, inp, expected):
        assert normalize_route(inp) == expected

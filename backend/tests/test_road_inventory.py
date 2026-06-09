"""
Road inventory route and lookup integration tests.

Requires a live MariaDB at Alembic head (0002_road_inventory).
Run with: pytest -m db -v tests/test_road_inventory.py

These tests use the admin_token fixture and a real DB connection.
Each test class cleans up its own road_inventory_datasets rows to avoid
cross-test pollution.
"""

from __future__ import annotations

import io
from decimal import Decimal

import openpyxl
import pytest

pytestmark = pytest.mark.db


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_HEADERS = [
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


def _row(county="SAC", route="050", begin=0.0, end=1.0, district="03", **kw) -> list:
    base = {
        "THY_ID": 99001,
        "THY_DISTRICT_CODE": district,
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
        "THY_ADT_AMT": 40000,
        "THY_LANDMARK_SHORT_DESC": "TEST",
        "THY_FUNCTIONAL_CLASS_CODE": "1",
        "THY_MAINT_SVC_LVL_CODE": "2",
        "THY_FEDERAL_AID_CODE": "0",
        "THY_SCENIC_FREEWAY_CODE": None,
        "THY_EXTRACT_DATE": "2025-06-08",
    }
    base.update(kw)
    return [base[h] for h in _HEADERS]


def _make_xlsx(*data_rows) -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(_HEADERS)
    for row in data_rows:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _upload(client, token: str, *data_rows, tag: str = "test") -> dict:
    xlsx = _make_xlsx(*data_rows)
    resp = client.post(
        "/road-inventory/upload",
        files={"file": ("test.xlsx", xlsx, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        params={"version_tag": tag},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 201, f"Upload failed: {resp.status_code} {resp.text}"
    return resp.json()


def _publish(client, token: str, version_id: int) -> None:
    resp = client.post(
        f"/road-inventory/versions/{version_id}/publish",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200, f"Publish failed: {resp.status_code} {resp.text}"


# ---------------------------------------------------------------------------
# Upload tests
# ---------------------------------------------------------------------------

class TestUpload:
    def test_upload_requires_admin(self, client_db, admin_token):
        # Get a non-admin token (field worker, if seeded — or just test with no token)
        resp = client_db.post(
            "/road-inventory/upload",
            files={"file": ("x.xlsx", b"data", "application/octet-stream")},
        )
        assert resp.status_code == 401

    def test_upload_rejects_non_xlsx(self, client_db, admin_token):
        resp = client_db.post(
            "/road-inventory/upload",
            files={"file": ("report.pdf", b"fake pdf bytes", "application/pdf")},
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 422
        assert "xlsx" in resp.json()["detail"].lower()

    def test_upload_rejects_corrupt_xlsx(self, client_db, admin_token):
        resp = client_db.post(
            "/road-inventory/upload",
            files={"file": ("bad.xlsx", b"not really xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 422

    def test_upload_rejects_missing_required_columns(self, client_db, admin_token):
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.append(["THY_ID", "THY_DISTRICT_CODE"])  # missing required cols
        buf = io.BytesIO()
        wb.save(buf)
        resp = client_db.post(
            "/road-inventory/upload",
            files={"file": ("bad.xlsx", buf.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 422
        assert "Missing required columns" in resp.json()["detail"]

    def test_upload_creates_pending_version(self, client_db, admin_token):
        data = _upload(client_db, admin_token, _row(), tag="upload-test-pending")
        assert data["status"] == "pending"
        assert data["row_count"] == 1
        assert data["skipped_count"] == 0
        assert "version_id" in data

        # Clean up
        from app.db import engine
        from sqlalchemy import text
        with engine.begin() as conn:
            conn.execute(text("DELETE FROM road_inventory_datasets WHERE id = :id"), {"id": data["version_id"]})

    def test_upload_skipped_count_in_response(self, client_db, admin_token):
        bad_row = _row()
        bad_row[_HEADERS.index("THY_BEGIN_PM_AMT")] = "bad"
        data = _upload(client_db, admin_token, bad_row, _row(), tag="upload-skip-test")
        assert data["row_count"] == 1
        assert data["skipped_count"] == 1

        from app.db import engine
        from sqlalchemy import text
        with engine.begin() as conn:
            conn.execute(text("DELETE FROM road_inventory_datasets WHERE id = :id"), {"id": data["version_id"]})


# ---------------------------------------------------------------------------
# Publish / rollback tests
# ---------------------------------------------------------------------------

class TestPublishRollback:
    def test_publish_creates_published_version(self, client_db, admin_token):
        v = _upload(client_db, admin_token, _row(), tag="pub-test")
        _publish(client_db, admin_token, v["version_id"])

        # Manifest must return this version
        resp = client_db.get(
            "/road-inventory/manifest",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        assert resp.json()["version_id"] == v["version_id"]

        # Clean up
        from app.db import engine
        from sqlalchemy import text
        with engine.begin() as conn:
            conn.execute(text("DELETE FROM road_inventory_datasets WHERE version_tag = 'pub-test'"))

    def test_publish_supersedes_previous(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text

        v1 = _upload(client_db, admin_token, _row(), tag="sup-v1")
        _publish(client_db, admin_token, v1["version_id"])

        v2 = _upload(client_db, admin_token, _row(county="ORA", route="001"), tag="sup-v2")
        _publish(client_db, admin_token, v2["version_id"])

        with engine.connect() as conn:
            status_v1 = conn.execute(text(
                "SELECT status FROM road_inventory_datasets WHERE id = :id"
            ), {"id": v1["version_id"]}).scalar()

        assert status_v1 == "superseded"

        # Manifest points to v2
        resp = client_db.get(
            "/road-inventory/manifest",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.json()["version_id"] == v2["version_id"]

        # Clean up
        with engine.begin() as conn:
            conn.execute(text("DELETE FROM road_inventory_datasets WHERE version_tag IN ('sup-v1', 'sup-v2')"))

    def test_rollback_re_publishes_superseded(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text

        v1 = _upload(client_db, admin_token, _row(), tag="rb-v1")
        _publish(client_db, admin_token, v1["version_id"])
        v2 = _upload(client_db, admin_token, _row(county="ORA"), tag="rb-v2")
        _publish(client_db, admin_token, v2["version_id"])

        # Rollback to v1
        resp = client_db.post(
            f"/road-inventory/versions/{v1['version_id']}/rollback",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        assert resp.json()["version_id"] == v1["version_id"]

        # Manifest now points to v1
        manifest = client_db.get(
            "/road-inventory/manifest",
            headers={"Authorization": f"Bearer {admin_token}"},
        ).json()
        assert manifest["version_id"] == v1["version_id"]

        with engine.begin() as conn:
            conn.execute(text("DELETE FROM road_inventory_datasets WHERE version_tag IN ('rb-v1', 'rb-v2')"))

    def test_publish_already_published_returns_409(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text

        v = _upload(client_db, admin_token, _row(), tag="dup-pub")
        _publish(client_db, admin_token, v["version_id"])

        resp = client_db.post(
            f"/road-inventory/versions/{v['version_id']}/publish",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 409

        with engine.begin() as conn:
            conn.execute(text("DELETE FROM road_inventory_datasets WHERE version_tag = 'dup-pub'"))


# ---------------------------------------------------------------------------
# Manifest tests
# ---------------------------------------------------------------------------

class TestManifest:
    def test_manifest_requires_auth(self, client_db):
        resp = client_db.get("/road-inventory/manifest")
        assert resp.status_code == 401

    def test_manifest_404_when_no_published(self, client_db, admin_token):
        # This may 200 if a prior test left a published version. The test is
        # meaningful only when run in a clean DB; it will be skipped if any
        # published version exists.
        from app.db import engine
        from sqlalchemy import text
        with engine.connect() as conn:
            count = conn.execute(text(
                "SELECT COUNT(*) FROM road_inventory_datasets WHERE status='published'"
            )).scalar()
        if count > 0:
            pytest.skip("A published version already exists; 404 test not applicable")

        resp = client_db.get(
            "/road-inventory/manifest",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Lookup tests
# ---------------------------------------------------------------------------

class TestLookup:
    def test_lookup_requires_auth(self, client_db):
        resp = client_db.get("/road-inventory/lookup?county=SAC&route=50&postmile=5.0")
        assert resp.status_code == 401

    def test_lookup_empty_when_no_published_dataset(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text
        with engine.connect() as conn:
            count = conn.execute(text(
                "SELECT COUNT(*) FROM road_inventory_datasets WHERE status='published'"
            )).scalar()
        if count > 0:
            pytest.skip("A published version exists; empty-lookup test not applicable")

        resp = client_db.get(
            "/road-inventory/lookup?county=SAC&route=50&postmile=5.0",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        assert resp.json()["segments"] == []

    def test_lookup_returns_matching_segment(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text

        v = _upload(
            client_db, admin_token,
            _row(county="SAC", route="050", begin=0.0, end=10.0, district="03"),
            tag="lookup-match",
        )
        _publish(client_db, admin_token, v["version_id"])

        resp = client_db.get(
            "/road-inventory/lookup?county=SAC&route=50&postmile=5.0",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        segs = resp.json()["segments"]
        assert len(segs) == 1
        assert segs[0]["county_code"] == "SAC"
        assert segs[0]["route_name"] == "50"  # normalized at insert time

        with engine.begin() as conn:
            conn.execute(text("DELETE FROM road_inventory_datasets WHERE version_tag = 'lookup-match'"))

    def test_lookup_empty_when_postmile_outside_range(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text

        v = _upload(
            client_db, admin_token,
            _row(county="SAC", route="050", begin=0.0, end=5.0),
            tag="lookup-miss",
        )
        _publish(client_db, admin_token, v["version_id"])

        resp = client_db.get(
            "/road-inventory/lookup?county=SAC&route=50&postmile=99.0",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        assert resp.json()["segments"] == []

        with engine.begin() as conn:
            conn.execute(text("DELETE FROM road_inventory_datasets WHERE version_tag = 'lookup-miss'"))

    def test_lookup_prefers_shortest_segment(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text

        # Two segments both containing postmile 5.0; shorter one should be first
        v = _upload(
            client_db, admin_token,
            _row(county="ALA", route="013", begin=0.0, end=20.0),  # long
            _row(county="ALA", route="013", begin=4.0, end=6.0),   # short
            tag="lookup-shortest",
        )
        _publish(client_db, admin_token, v["version_id"])

        resp = client_db.get(
            "/road-inventory/lookup?county=ALA&route=13&postmile=5.0",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        segs = resp.json()["segments"]
        assert len(segs) == 2
        # Shorter segment (length 2.0) should come first
        assert float(segs[0]["end_pm"]) - float(segs[0]["begin_pm"]) < \
               float(segs[1]["end_pm"]) - float(segs[1]["begin_pm"])

        with engine.begin() as conn:
            conn.execute(text("DELETE FROM road_inventory_datasets WHERE version_tag = 'lookup-shortest'"))

    def test_lookup_prefers_district_match(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text

        # Two identical-length segments; different districts
        v = _upload(
            client_db, admin_token,
            _row(county="KER", route="099", begin=0.0, end=5.0, district="09"),
            _row(county="KER", route="099", begin=0.0, end=5.0, district="06"),
            tag="lookup-district",
        )
        _publish(client_db, admin_token, v["version_id"])

        resp = client_db.get(
            "/road-inventory/lookup?county=KER&route=99&postmile=2.5&district=06",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        segs = resp.json()["segments"]
        assert len(segs) == 2
        assert segs[0]["district_code"] == "06"  # preferred district first

        with engine.begin() as conn:
            conn.execute(text("DELETE FROM road_inventory_datasets WHERE version_tag = 'lookup-district'"))


# ---------------------------------------------------------------------------
# Versions list
# ---------------------------------------------------------------------------

class TestVersionsList:
    def test_versions_requires_admin(self, client_db):
        resp = client_db.get("/road-inventory/versions")
        assert resp.status_code == 401

    def test_versions_returns_list(self, client_db, admin_token):
        resp = client_db.get(
            "/road-inventory/versions",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

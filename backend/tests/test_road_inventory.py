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


def _associate_project(client_db, headers: dict[str, str], incident_id: int) -> None:
    response = client_db.post(
        f"/incidents/{incident_id}/project-association",
        headers=headers,
        json={
            "mode": "CREATE_NEW",
            "title": f"Integration Project {incident_id}",
            "notes": "Legacy DB fixture Project association.",
        },
    )
    assert response.status_code == 200, f"Project association failed: {response.status_code} {response.text}"


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
# Async import jobs
# ---------------------------------------------------------------------------

class TestImportJobs:
    def test_import_job_requires_admin(self, client_db):
        resp = client_db.post(
            "/road-inventory/import-jobs",
            files={"file": ("x.xlsx", b"data", "application/octet-stream")},
        )
        assert resp.status_code == 401

    def test_import_job_rejects_non_xlsx(self, client_db, admin_token):
        resp = client_db.post(
            "/road-inventory/import-jobs",
            files={"file": ("report.pdf", b"fake pdf bytes", "application/pdf")},
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 422
        assert "xlsx" in resp.json()["detail"].lower()

    def test_import_job_creates_queued_job(self, client_db, admin_token):
        from unittest.mock import patch
        from app.db import engine
        from sqlalchemy import text

        xlsx = _make_xlsx(_row())
        with patch("app.routes.road_inventory.ensure_bucket_exists"), \
            patch("app.routes.road_inventory.put_object_bytes"), \
            patch("app.routes.road_inventory.run_import_job_svc"):
            resp = client_db.post(
                "/road-inventory/import-jobs",
                files={"file": ("test.xlsx", xlsx, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                params={"version_tag": "queued-job-test"},
                headers={"Authorization": f"Bearer {admin_token}"},
            )
        assert resp.status_code == 202
        data = resp.json()
        assert "job_uuid" in data
        assert data["status"] == "queued"

        with engine.begin() as conn:
            conn.execute(text(
                "DELETE FROM road_inventory_import_jobs WHERE job_uuid = :uuid"
            ), {"uuid": data["job_uuid"]})

    def test_get_import_job_requires_admin(self, client_db):
        resp = client_db.get("/road-inventory/import-jobs/fake-uuid")
        assert resp.status_code == 401

    def test_get_import_job_not_found(self, client_db, admin_token):
        resp = client_db.get(
            "/road-inventory/import-jobs/00000000-0000-0000-0000-000000000000",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 404

    def test_list_import_jobs_requires_admin(self, client_db):
        resp = client_db.get("/road-inventory/import-jobs")
        assert resp.status_code == 401

    def test_list_import_jobs_returns_list(self, client_db, admin_token):
        resp = client_db.get(
            "/road-inventory/import-jobs",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

    def test_run_import_job_success(self, client_db, admin_token):
        from unittest.mock import patch
        from app.db import engine
        from sqlalchemy import text

        xlsx = _make_xlsx(_row())
        # BackgroundTasks run synchronously in TestClient, so by the time
        # the 202 response returns, the background job has already finished.
        with patch("app.routes.road_inventory.ensure_bucket_exists"), \
            patch("app.routes.road_inventory.put_object_bytes"), \
            patch("app.services.road_inventory_import_jobs.get_object_bytes") as mock_get:
            mock_get.return_value = (xlsx, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            resp = client_db.post(
                "/road-inventory/import-jobs",
                files={"file": ("test.xlsx", xlsx, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                params={"version_tag": "async-success"},
                headers={"Authorization": f"Bearer {admin_token}"},
            )
        assert resp.status_code == 202
        job_uuid = resp.json()["job_uuid"]

        resp2 = client_db.get(
            f"/road-inventory/import-jobs/{job_uuid}",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp2.status_code == 200
        job = resp2.json()
        assert job["status"] == "succeeded"
        assert job["row_count"] == 1
        assert job["dataset_version_id"] is not None

        with engine.begin() as conn:
            conn.execute(text(
                "DELETE FROM road_inventory_datasets WHERE id = :id"
            ), {"id": job["dataset_version_id"]})
            conn.execute(text(
                "DELETE FROM road_inventory_import_jobs WHERE job_uuid = :uuid"
            ), {"uuid": job_uuid})

    def test_import_job_returns_503_if_storage_unavailable(self, client_db, admin_token):
        from unittest.mock import patch
        xlsx = _make_xlsx(_row())
        with patch("app.routes.road_inventory.ensure_bucket_exists") as mock_ensure:
            mock_ensure.side_effect = RuntimeError("MinIO connection refused")
            resp = client_db.post(
                "/road-inventory/import-jobs",
                files={"file": ("test.xlsx", xlsx, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                params={"version_tag": "storage-fail-test"},
                headers={"Authorization": f"Bearer {admin_token}"},
            )
        assert resp.status_code == 503
        assert resp.json()["detail"] in {
            "Internal server error",
            "Road inventory storage is unavailable. Please check MinIO bucket configuration.",
        }

    def test_run_import_job_failure(self, client_db, admin_token):
        from unittest.mock import patch
        from app.db import engine
        from sqlalchemy import text

        xlsx = _make_xlsx(_row())
        with patch("app.routes.road_inventory.ensure_bucket_exists"), \
            patch("app.routes.road_inventory.put_object_bytes"), \
            patch("app.services.road_inventory_import_jobs.get_object_bytes") as mock_get:
            mock_get.side_effect = RuntimeError("MinIO unreachable")
            resp = client_db.post(
                "/road-inventory/import-jobs",
                files={"file": ("test.xlsx", xlsx, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                params={"version_tag": "async-fail"},
                headers={"Authorization": f"Bearer {admin_token}"},
            )
        assert resp.status_code == 202
        job_uuid = resp.json()["job_uuid"]

        resp2 = client_db.get(
            f"/road-inventory/import-jobs/{job_uuid}",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp2.status_code == 200
        job = resp2.json()
        assert job["status"] == "failed"
        assert job["error_message"] is not None

        with engine.begin() as conn:
            conn.execute(text(
                "DELETE FROM road_inventory_import_jobs WHERE job_uuid = :uuid"
            ), {"uuid": job_uuid})


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


# ---------------------------------------------------------------------------
# Package generation
# ---------------------------------------------------------------------------

class TestPackageGeneration:
    _PKG_PATCH = "app.services.road_inventory_packages"

    def _generate(self, client_db, admin_token, version_id: int):
        from unittest.mock import patch
        with patch(f"{self._PKG_PATCH}.ensure_bucket_exists"), \
             patch(f"{self._PKG_PATCH}.put_object_bytes"), \
             patch(f"{self._PKG_PATCH}.object_access_url", return_value="http://minio/pkg.gz"):
            return client_db.post(
                f"/road-inventory/versions/{version_id}/package",
                headers={"Authorization": f"Bearer {admin_token}"},
            )

    def test_generate_package_requires_admin(self, client_db):
        resp = client_db.post("/road-inventory/versions/1/package")
        assert resp.status_code == 401

    def test_generate_package_missing_dataset(self, client_db, admin_token):
        from unittest.mock import patch
        with patch(f"{self._PKG_PATCH}.ensure_bucket_exists"), \
             patch(f"{self._PKG_PATCH}.put_object_bytes"):
            resp = client_db.post(
                "/road-inventory/versions/999999/package",
                headers={"Authorization": f"Bearer {admin_token}"},
            )
        assert resp.status_code == 404

    def test_generate_package_non_published_dataset(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text

        v = _upload(client_db, admin_token, _row(), tag="pkg-nonpub")
        # dataset is pending — do NOT publish
        try:
            resp = self._generate(client_db, admin_token, v["version_id"])
            assert resp.status_code == 422
            assert "published" in resp.json()["detail"].lower()
        finally:
            with engine.begin() as conn:
                conn.execute(text(
                    "DELETE FROM road_inventory_datasets WHERE version_tag = 'pkg-nonpub'"
                ))

    def test_generate_package_creates_package_row(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text

        v = _upload(client_db, admin_token, _row(), tag="pkg-create")
        _publish(client_db, admin_token, v["version_id"])
        try:
            resp = self._generate(client_db, admin_token, v["version_id"])
            assert resp.status_code == 200
            data = resp.json()
            assert data["dataset_version_id"] == v["version_id"]
            assert data["size_bytes"] > 0
            assert len(data["sha256"]) == 64
            assert data["storage_key"].endswith(".json.gz")

            # Verify DB row was created
            with engine.connect() as conn:
                row = conn.execute(text("""
                    SELECT file_size_bytes, sha256 FROM road_inventory_packages
                    WHERE dataset_version_id = :vid AND package_type = 'json_gz'
                """), {"vid": v["version_id"]}).mappings().first()
            assert row is not None
            assert row["sha256"] == data["sha256"]
        finally:
            with engine.begin() as conn:
                conn.execute(text(
                    "DELETE FROM road_inventory_datasets WHERE version_tag = 'pkg-create'"
                ))

    def test_generate_package_upserts_on_regenerate(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text

        v = _upload(client_db, admin_token, _row(), tag="pkg-upsert")
        _publish(client_db, admin_token, v["version_id"])
        try:
            # Generate twice — should not raise a unique key violation
            r1 = self._generate(client_db, admin_token, v["version_id"])
            r2 = self._generate(client_db, admin_token, v["version_id"])
            assert r1.status_code == 200
            assert r2.status_code == 200

            with engine.connect() as conn:
                count = conn.execute(text("""
                    SELECT COUNT(*) FROM road_inventory_packages
                    WHERE dataset_version_id = :vid AND package_type = 'json_gz'
                """), {"vid": v["version_id"]}).scalar()
            assert count == 1
        finally:
            with engine.begin() as conn:
                conn.execute(text(
                    "DELETE FROM road_inventory_datasets WHERE version_tag = 'pkg-upsert'"
                ))

    def test_manifest_shows_package_after_generation(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text

        v = _upload(client_db, admin_token, _row(), tag="pkg-manifest")
        _publish(client_db, admin_token, v["version_id"])
        try:
            self._generate(client_db, admin_token, v["version_id"])

            manifest = client_db.get(
                "/road-inventory/manifest",
                headers={"Authorization": f"Bearer {admin_token}"},
            ).json()

            assert manifest["package"]["available"] is True
            assert manifest["package"]["size_bytes"] > 0
            assert len(manifest["package"]["sha256"]) == 64
            assert manifest["package"]["generated_at"] is not None
        finally:
            with engine.begin() as conn:
                conn.execute(text(
                    "DELETE FROM road_inventory_datasets WHERE version_tag = 'pkg-manifest'"
                ))

    def test_get_package_requires_auth(self, client_db):
        resp = client_db.get("/road-inventory/package")
        assert resp.status_code == 401

    def test_get_package_404_when_no_package(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text

        v = _upload(client_db, admin_token, _row(), tag="pkg-404")
        _publish(client_db, admin_token, v["version_id"])
        try:
            resp = client_db.get(
                "/road-inventory/package",
                headers={"Authorization": f"Bearer {admin_token}"},
            )
            assert resp.status_code == 404
        finally:
            with engine.begin() as conn:
                conn.execute(text(
                    "DELETE FROM road_inventory_datasets WHERE version_tag = 'pkg-404'"
                ))

    def test_get_package_returns_metadata(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text

        v = _upload(client_db, admin_token, _row(), tag="pkg-get")
        _publish(client_db, admin_token, v["version_id"])
        try:
            self._generate(client_db, admin_token, v["version_id"])

            resp = client_db.get(
                "/road-inventory/package",
                headers={"Authorization": f"Bearer {admin_token}"},
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["dataset_version_id"] == v["version_id"]
            assert data["size_bytes"] > 0
            assert len(data["sha256"]) == 64
            assert data["generated_at"] is not None
        finally:
            with engine.begin() as conn:
                conn.execute(text(
                    "DELETE FROM road_inventory_datasets WHERE version_tag = 'pkg-get'"
                ))


# ---------------------------------------------------------------------------
# Road inventory context on incidents
# ---------------------------------------------------------------------------

class TestRoadInventoryContext:

    def _incident_payload(self, ri_context=None) -> dict:
        payload = {
            "first_observed_at": "2026-06-09T00:00:00",
            "latitude": 38.5,
            "longitude": -121.5,
            "district": "03",
            "county": "SAC",
            "route": "50",
            "post_mile": "5.0",
        }
        if ri_context is not None:
            payload["road_inventory_context"] = ri_context
        return payload

    def _get_segment_id(self, version_id: int) -> int:
        from app.db import engine
        from sqlalchemy import text
        with engine.connect() as conn:
            return conn.execute(text(
                "SELECT id FROM road_segments WHERE dataset_version_id = :vid LIMIT 1"
            ), {"vid": version_id}).scalar()

    def test_create_without_ri_context_works(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text

        resp = client_db.post(
            "/incidents",
            json=self._incident_payload(),
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        incident = resp.json()["incident"]
        assert incident["road_inventory_context"] is None

        with engine.begin() as conn:
            conn.execute(text("DELETE FROM incidents WHERE id = :id"), {"id": incident["id"]})

    def test_create_with_valid_context_stores_all_fields(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text

        v = _upload(client_db, admin_token, _row(county="SAC", route="050", begin=0.0, end=10.0, district="03"), tag="ri-ctx-valid")
        _publish(client_db, admin_token, v["version_id"])
        seg_id = self._get_segment_id(v["version_id"])
        try:
            resp = client_db.post(
                "/incidents",
                json=self._incident_payload({
                    "dataset_version_id": v["version_id"],
                    "segment_id": seg_id,
                    "match_method": "MOBILE_OFFLINE",
                    "snapshot": {"county_code": "SAC", "route_name": "50"},
                }),
                headers={"Authorization": f"Bearer {admin_token}"},
            )
            assert resp.status_code == 200
            incident = resp.json()["incident"]
            ctx = incident["road_inventory_context"]
            assert ctx is not None
            assert ctx["dataset_version_id"] == v["version_id"]
            assert ctx["segment_id"] == seg_id
            assert ctx["match_method"] == "MOBILE_OFFLINE"
            assert ctx["checked_at"] is not None

            with engine.begin() as conn:
                conn.execute(text("DELETE FROM incidents WHERE id = :id"), {"id": incident["id"]})
        finally:
            with engine.begin() as conn:
                conn.execute(text("DELETE FROM road_inventory_datasets WHERE version_tag = 'ri-ctx-valid'"))

    def test_create_with_invalid_dataset_id_returns_400(self, client_db, admin_token):
        resp = client_db.post(
            "/incidents",
            json=self._incident_payload({
                "dataset_version_id": 999999999,
                "segment_id": 1,
            }),
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 400

    def test_create_with_segment_from_wrong_dataset_returns_400(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text

        v1 = _upload(client_db, admin_token, _row(county="SAC", route="050", begin=0.0, end=10.0), tag="ri-ctx-ds1")
        _publish(client_db, admin_token, v1["version_id"])
        seg_from_v1 = self._get_segment_id(v1["version_id"])

        v2 = _upload(client_db, admin_token, _row(county="ORA", route="001"), tag="ri-ctx-ds2")
        _publish(client_db, admin_token, v2["version_id"])
        try:
            resp = client_db.post(
                "/incidents",
                json=self._incident_payload({
                    "dataset_version_id": v2["version_id"],
                    "segment_id": seg_from_v1,
                }),
                headers={"Authorization": f"Bearer {admin_token}"},
            )
            assert resp.status_code == 400
        finally:
            with engine.begin() as conn:
                conn.execute(text("DELETE FROM road_inventory_datasets WHERE version_tag IN ('ri-ctx-ds1', 'ri-ctx-ds2')"))

    def test_list_incidents_includes_ri_context(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text

        v = _upload(client_db, admin_token, _row(county="SAC", route="050", begin=0.0, end=10.0, district="03"), tag="ri-ctx-list")
        _publish(client_db, admin_token, v["version_id"])
        seg_id = self._get_segment_id(v["version_id"])
        try:
            create_resp = client_db.post(
                "/incidents",
                json=self._incident_payload({
                    "dataset_version_id": v["version_id"],
                    "segment_id": seg_id,
                }),
                headers={"Authorization": f"Bearer {admin_token}"},
            )
            assert create_resp.status_code == 200
            incident_id = create_resp.json()["incident"]["id"]

            list_resp = client_db.get(
                "/incidents?scope=all",
                headers={"Authorization": f"Bearer {admin_token}"},
            )
            assert list_resp.status_code == 200
            found = next((i for i in list_resp.json()["items"] if i["id"] == incident_id), None)
            assert found is not None
            assert found["road_inventory_context"] is not None
            assert found["road_inventory_context"]["dataset_version_id"] == v["version_id"]

            with engine.begin() as conn:
                conn.execute(text("DELETE FROM incidents WHERE id = :id"), {"id": incident_id})
        finally:
            with engine.begin() as conn:
                conn.execute(text("DELETE FROM road_inventory_datasets WHERE version_tag = 'ri-ctx-list'"))


# ---------------------------------------------------------------------------
# Road inventory context on submission_gisa (via incident forward)
# ---------------------------------------------------------------------------

class TestSubmissionGisaRiContext:
    """Tests that forwarding an incident copies its road inventory context into submission_gisa."""

    def _incident_payload(self, ri_context=None) -> dict:
        payload = {
            "first_observed_at": "2026-06-10T00:00:00",
            "latitude": 37.7,
            "longitude": -122.4,
            "district": "04",
            "county": "ALA",
            "route": "080",
            "post_mile": "5.0",
        }
        if ri_context is not None:
            payload["road_inventory_context"] = ri_context
        return payload

    def _get_segment_id(self, version_id: int) -> int:
        from app.db import engine
        from sqlalchemy import text
        with engine.connect() as conn:
            return conn.execute(text(
                "SELECT id FROM road_segments WHERE dataset_version_id = :vid LIMIT 1"
            ), {"vid": version_id}).scalar()

    def _create_incident(self, client_db, admin_token, payload: dict) -> int:
        resp = client_db.post(
            "/incidents",
            json=payload,
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200
        return resp.json()["incident"]["id"]

    def _link_location_and_forward(self, client_db, admin_token, incident_id: int) -> int:
        """Link a new location and forward the incident so a submission is created."""
        _associate_project(client_db, {"Authorization": f"Bearer {admin_token}"}, int(incident_id))
        link_resp = client_db.post(
            f"/incidents/{incident_id}/location-link",
            json={"mode": "CREATE_NEW"},
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert link_resp.status_code == 200

        fwd_resp = client_db.post(
            f"/incidents/{incident_id}/coordinator/forward",
            json={"comment": "test"},
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert fwd_resp.status_code == 200
        return fwd_resp.json()["linked_submission_id"]

    def test_forward_without_ri_context_creates_gisa_without_ri(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text

        incident_id = self._create_incident(client_db, admin_token, self._incident_payload())
        try:
            sub_id = self._link_location_and_forward(client_db, admin_token, incident_id)
            resp = client_db.get(
                f"/submissions/{sub_id}",
                headers={"Authorization": f"Bearer {admin_token}"},
            )
            assert resp.status_code == 200
            gisa = resp.json()["gisa"]
            assert gisa["road_inventory_context"] is None
        finally:
            with engine.begin() as conn:
                conn.execute(text("DELETE FROM incidents WHERE id = :id"), {"id": incident_id})

    def test_forward_with_ri_context_populates_submission_gisa(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text

        v = _upload(client_db, admin_token, _row(county="SAC", route="050", begin=0.0, end=10.0, district="03"), tag="gisa-ri-fwd")
        _publish(client_db, admin_token, v["version_id"])
        seg_id = self._get_segment_id(v["version_id"])
        incident_id = None
        try:
            incident_id = self._create_incident(client_db, admin_token, self._incident_payload({
                "dataset_version_id": v["version_id"],
                "segment_id": seg_id,
                "match_method": "MOBILE_OFFLINE",
                "snapshot": {"county_code": "SAC", "route_name": "50", "left_lanes": 2},
            }))
            sub_id = self._link_location_and_forward(client_db, admin_token, incident_id)

            resp = client_db.get(
                f"/submissions/{sub_id}",
                headers={"Authorization": f"Bearer {admin_token}"},
            )
            assert resp.status_code == 200
            gisa = resp.json()["gisa"]
            ctx = gisa["road_inventory_context"]
            assert ctx is not None
            assert ctx["dataset_version_id"] == v["version_id"]
            assert ctx["segment_id"] == seg_id
            assert ctx["match_method"] == "MOBILE_OFFLINE"
            assert ctx["snapshot"] is not None
            assert ctx["snapshot"]["county_code"] == "SAC"
        finally:
            if incident_id:
                with engine.begin() as conn:
                    conn.execute(text("DELETE FROM incidents WHERE id = :id"), {"id": incident_id})
            with engine.begin() as conn:
                conn.execute(text("DELETE FROM road_inventory_datasets WHERE version_tag = 'gisa-ri-fwd'"))

    def test_gisa_patch_does_not_wipe_ri_context(self, client_db, admin_token):
        from app.db import engine
        from sqlalchemy import text

        v = _upload(client_db, admin_token, _row(county="SAC", route="050", begin=0.0, end=10.0, district="03"), tag="gisa-ri-patch")
        _publish(client_db, admin_token, v["version_id"])
        seg_id = self._get_segment_id(v["version_id"])
        incident_id = None
        try:
            incident_id = self._create_incident(client_db, admin_token, self._incident_payload({
                "dataset_version_id": v["version_id"],
                "segment_id": seg_id,
                "match_method": "MOBILE_OFFLINE",
                "snapshot": {"county_code": "SAC"},
            }))
            sub_id = self._link_location_and_forward(client_db, admin_token, incident_id)

            # Patch some unrelated GISA fields
            patch_resp = client_db.patch(
                f"/submissions/{sub_id}/gisa",
                json={"observations_notes": "Test observation after patch"},
                headers={"Authorization": f"Bearer {admin_token}"},
            )
            assert patch_resp.status_code == 200

            # RI context must still be present
            get_resp = client_db.get(
                f"/submissions/{sub_id}",
                headers={"Authorization": f"Bearer {admin_token}"},
            )
            assert get_resp.status_code == 200
            ctx = get_resp.json()["gisa"]["road_inventory_context"]
            assert ctx is not None
            assert ctx["dataset_version_id"] == v["version_id"]
            assert get_resp.json()["gisa"]["observations_notes"] == "Test observation after patch"
        finally:
            if incident_id:
                with engine.begin() as conn:
                    conn.execute(text("DELETE FROM incidents WHERE id = :id"), {"id": incident_id})
            with engine.begin() as conn:
                conn.execute(text("DELETE FROM road_inventory_datasets WHERE version_tag = 'gisa-ri-patch'"))

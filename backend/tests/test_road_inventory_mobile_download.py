from __future__ import annotations

import gzip
import hashlib
import json
from uuid import uuid4

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.db


def test_mobile_package_download_stays_behind_eris_auth(client_db, admin_token, monkeypatch):
    from app.db import engine
    from app.routes import road_inventory_mobile_download

    payload = gzip.compress(json.dumps({"schema_version": 2, "segments": [], "postmile_points": []}).encode("utf-8"))
    digest = hashlib.sha256(payload).hexdigest()
    unique = uuid4().hex
    previous_published_id = None
    dataset_id = None

    try:
        with engine.begin() as conn:
            admin_id = int(conn.execute(text("SELECT id FROM users WHERE email='admin@local' LIMIT 1")).scalar())
            previous = conn.execute(text("""
                SELECT id
                FROM road_inventory_datasets
                WHERE status='published'
                ORDER BY published_at DESC, id DESC
                LIMIT 1
            """)).scalar()
            previous_published_id = int(previous) if previous is not None else None
            conn.execute(text("UPDATE road_inventory_datasets SET status='superseded' WHERE status='published'"))
            result = conn.execute(text("""
                INSERT INTO road_inventory_datasets
                  (version_tag, upload_filename, row_count, skipped_count, status, uploaded_by, published_at)
                VALUES
                  (:tag, :filename, 0, 0, 'published', :uid, NOW())
            """), {"tag": f"mobile-download-{unique}", "filename": "mobile-download-test.xlsx", "uid": admin_id})
            dataset_id = int(result.lastrowid)
            conn.execute(text("""
                INSERT INTO road_inventory_packages
                  (dataset_version_id, package_type, storage_key, file_size_bytes, sha256, generated_at)
                VALUES
                  (:vid, 'json_gz', :key, :size, :sha, NOW())
            """), {
                "vid": dataset_id,
                "key": f"packages/mobile-download-{unique}.json.gz",
                "size": len(payload),
                "sha": digest,
            })

        monkeypatch.setattr(
            road_inventory_mobile_download,
            "get_object_bytes",
            lambda **_kwargs: (payload, "application/gzip"),
        )

        denied = client_db.get("/road-inventory/mobile-package/download")
        assert denied.status_code == 401

        response = client_db.get(
            "/road-inventory/mobile-package/download",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert response.status_code == 200, response.text
        assert response.content == payload
        assert response.headers["content-type"].startswith("application/gzip")
        assert response.headers["x-eris-package-sha256"] == digest
        assert response.headers["cache-control"] == "private, no-store"
        assert "attachment;" in response.headers["content-disposition"]
    finally:
        with engine.begin() as conn:
            if dataset_id is not None:
                conn.execute(text("DELETE FROM road_inventory_datasets WHERE id=:id"), {"id": dataset_id})
            if previous_published_id is not None:
                conn.execute(text("""
                    UPDATE road_inventory_datasets
                    SET status='published', published_at=COALESCE(published_at, NOW())
                    WHERE id=:id
                """), {"id": previous_published_id})

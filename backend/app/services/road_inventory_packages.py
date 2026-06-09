"""Road inventory mobile package generation service.

Generates a gzip-compressed JSON package for a published road inventory dataset
and stores it in MinIO.  One json_gz package row per dataset is maintained in
road_inventory_packages via upsert.

Package file format:
  {
    "schema_version": 1,
    "dataset_version_id": <int>,
    "version_tag": "<str>",
    "extract_date": "<YYYY-MM-DD or null>",
    "generated_at": "<ISO timestamp>",
    "row_count": <int>,
    "segments": [{ ... }]
  }

Storage key pattern:
  packages/road_inventory_<dataset_version_id>_<sanitized_version_tag>.json.gz
"""

from __future__ import annotations

import gzip
import hashlib
import json
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import text

from ..storage import ensure_bucket_exists, object_access_url, put_object_bytes

_ROAD_INVENTORY_BUCKET = "road-inventory"
_PACKAGE_TYPE = "json_gz"


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def generate_package_for_dataset(
    db,
    dataset_version_id: int,
    generated_by: int | None = None,
) -> dict:
    """Generate a json.gz package for a published dataset.

    Raises ValueError if the dataset does not exist or is not published.
    Raises RuntimeError if MinIO storage fails.
    Returns package metadata dict with download_url (None if URL generation fails).
    """
    dataset = db.execute(text("""
        SELECT id, version_tag, extract_date, row_count, status
        FROM road_inventory_datasets
        WHERE id = :id
    """), {"id": dataset_version_id}).mappings().first()

    if not dataset:
        raise ValueError(f"Dataset {dataset_version_id} not found")
    if dataset["status"] != "published":
        raise ValueError(
            f"Dataset {dataset_version_id} is not published (status={dataset['status']})"
        )

    rows = db.execute(text("""
        SELECT id, district_code, county_code, route_name, route_suffix_code,
               pm_prefix_code, begin_pm, end_pm, length_miles, left_lanes,
               right_lanes, left_surface_type, right_surface_type, median_type,
               median_width, terrain_code, design_speed, adt, landmark_short_desc
        FROM road_segments
        WHERE dataset_version_id = :vid
        ORDER BY id
    """), {"vid": dataset_version_id}).mappings().all()

    def _num(v: Any) -> float | None:
        if v is None:
            return None
        return float(v) if isinstance(v, Decimal) else v

    segments = [
        {
            "id":                  r["id"],
            "district_code":       r["district_code"],
            "county_code":         r["county_code"],
            "route_name":          r["route_name"],
            "route_suffix_code":   r["route_suffix_code"],
            "pm_prefix_code":      r["pm_prefix_code"],
            "begin_pm":            _num(r["begin_pm"]),
            "end_pm":              _num(r["end_pm"]),
            "length_miles":        _num(r["length_miles"]),
            "left_lanes":          r["left_lanes"],
            "right_lanes":         r["right_lanes"],
            "left_surface_type":   r["left_surface_type"],
            "right_surface_type":  r["right_surface_type"],
            "median_type":         r["median_type"],
            "median_width":        _num(r["median_width"]),
            "terrain_code":        r["terrain_code"],
            "design_speed":        r["design_speed"],
            "adt":                 r["adt"],
            "landmark_short_desc": r["landmark_short_desc"],
        }
        for r in rows
    ]

    generated_at = _now()
    extract_date = dataset["extract_date"]
    payload = {
        "schema_version":     1,
        "dataset_version_id": dataset_version_id,
        "version_tag":        dataset["version_tag"],
        "extract_date":       extract_date.isoformat() if extract_date else None,
        "generated_at":       generated_at.isoformat(),
        "row_count":          len(segments),
        "segments":           segments,
    }

    raw_json = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    compressed = gzip.compress(raw_json)
    sha256 = hashlib.sha256(compressed).hexdigest()
    file_size_bytes = len(compressed)

    safe_tag = dataset["version_tag"].replace("/", "-").replace(" ", "_")[:40]
    object_key = f"packages/road_inventory_{dataset_version_id}_{safe_tag}.json.gz"

    ensure_bucket_exists(_ROAD_INVENTORY_BUCKET)
    put_object_bytes(
        object_key=object_key,
        data=compressed,
        content_type="application/gzip",
        bucket=_ROAD_INVENTORY_BUCKET,
    )

    existing = db.execute(text("""
        SELECT id FROM road_inventory_packages
        WHERE dataset_version_id = :vid AND package_type = :pt
    """), {"vid": dataset_version_id, "pt": _PACKAGE_TYPE}).mappings().first()

    if existing:
        db.execute(text("""
            UPDATE road_inventory_packages
            SET storage_key = :storage_key,
                file_size_bytes = :file_size_bytes,
                sha256 = :sha256,
                generated_at = :generated_at
            WHERE dataset_version_id = :vid AND package_type = :pt
        """), {
            "storage_key":     object_key,
            "file_size_bytes": file_size_bytes,
            "sha256":          sha256,
            "generated_at":    generated_at,
            "vid":             dataset_version_id,
            "pt":              _PACKAGE_TYPE,
        })
    else:
        db.execute(text("""
            INSERT INTO road_inventory_packages
                (dataset_version_id, package_type, storage_key, file_size_bytes, sha256, generated_at)
            VALUES
                (:vid, :pt, :storage_key, :file_size_bytes, :sha256, :generated_at)
        """), {
            "vid":             dataset_version_id,
            "pt":              _PACKAGE_TYPE,
            "storage_key":     object_key,
            "file_size_bytes": file_size_bytes,
            "sha256":          sha256,
            "generated_at":    generated_at,
        })
    db.commit()

    try:
        download_url = object_access_url(_ROAD_INVENTORY_BUCKET, object_key)
    except Exception:
        download_url = None

    return {
        "dataset_version_id": dataset_version_id,
        "storage_key":        object_key,
        "size_bytes":         file_size_bytes,
        "sha256":             sha256,
        "generated_at":       generated_at.isoformat(),
        "download_url":       download_url,
    }


def get_package_for_dataset(db, dataset_version_id: int) -> dict | None:
    """Return package metadata for a dataset, or None if not generated."""
    pkg = db.execute(text("""
        SELECT storage_key, file_size_bytes, sha256, generated_at
        FROM road_inventory_packages
        WHERE dataset_version_id = :vid AND package_type = :pt
        LIMIT 1
    """), {"vid": dataset_version_id, "pt": _PACKAGE_TYPE}).mappings().first()

    if not pkg:
        return None

    try:
        download_url = object_access_url(_ROAD_INVENTORY_BUCKET, pkg["storage_key"])
    except Exception:
        download_url = None

    gen_at = pkg["generated_at"]
    return {
        "dataset_version_id": dataset_version_id,
        "storage_key":        pkg["storage_key"],
        "size_bytes":         pkg["file_size_bytes"],
        "sha256":             pkg["sha256"],
        "generated_at":       gen_at.isoformat() if isinstance(gen_at, datetime) else str(gen_at),
        "download_url":       download_url,
    }

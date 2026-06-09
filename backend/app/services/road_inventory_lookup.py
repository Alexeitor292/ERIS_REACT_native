"""
Road inventory segment lookup.

Queries road_segments against the currently published dataset version.
Returns an empty list (never raises) when no published dataset exists or when
no segments match.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from .road_inventory_parser import normalize_route


def get_published_version_id(db: Session) -> int | None:
    """Return the id of the currently published dataset, or None."""
    row = db.execute(text("""
        SELECT id
        FROM road_inventory_datasets
        WHERE status = 'published'
        ORDER BY published_at DESC
        LIMIT 1
    """)).first()
    return int(row[0]) if row else None


def lookup_segments(
    db: Session,
    *,
    county_code: str,
    route: str,
    postmile: float,
    district_code: str | None = None,
    limit: int = 5,
) -> list[dict[str, Any]]:
    """Return road segments matching county + route + postmile range.

    Preference order:
      1. Exact district_code match (if provided)
      2. Shortest segment (end_pm - begin_pm ASC)

    Returns [] when no published dataset exists or no segments match.
    """
    version_id = get_published_version_id(db)
    if version_id is None:
        return []

    route_norm = normalize_route(route)
    if not route_norm:
        return []

    rows = db.execute(text("""
        SELECT
            id, thy_id, district_code, county_code, route_name,
            route_suffix_code, pm_prefix_code, begin_pm, end_pm,
            pm_suffix_code, length_miles,
            left_lanes, right_lanes,
            left_surface_type, right_surface_type,
            left_shoulder_width, right_shoulder_width,
            median_type, median_width,
            access_code, terrain_code, design_speed, adt,
            landmark_short_desc, functional_class_code,
            maintenance_service_level_code, federal_aid_code,
            scenic_freeway_code, extract_date
        FROM road_segments
        WHERE dataset_version_id = :version_id
          AND county_code        = :county_code
          AND route_name         = :route_norm
          AND begin_pm           <= :pm
          AND end_pm             >= :pm
        ORDER BY
            CASE WHEN :district_code IS NOT NULL
                      AND district_code = :district_code
                 THEN 0 ELSE 1 END,
            (end_pm - begin_pm) ASC
        LIMIT :lim
    """), {
        "version_id":    version_id,
        "county_code":   county_code.strip().upper(),
        "route_norm":    route_norm,
        "pm":            postmile,
        "district_code": district_code,
        "lim":           limit,
    }).mappings().all()

    return [dict(r) for r in rows]


def bulk_insert_segments(
    db: Session,
    dataset_version_id: int,
    rows: list[dict[str, Any]],
    batch_size: int = 500,
) -> None:
    """Insert normalized road segment rows in batches."""
    for i in range(0, len(rows), batch_size):
        batch = rows[i : i + batch_size]
        db.execute(text("""
            INSERT INTO road_segments (
                dataset_version_id, thy_id, district_code, county_code,
                route_name, route_suffix_code, pm_prefix_code,
                begin_pm, end_pm, pm_suffix_code, length_miles,
                left_lanes, right_lanes,
                left_surface_type, right_surface_type,
                left_shoulder_width, right_shoulder_width,
                median_type, median_width,
                access_code, terrain_code, design_speed, adt,
                landmark_short_desc, functional_class_code,
                maintenance_service_level_code, federal_aid_code,
                scenic_freeway_code, extract_date, raw_json
            ) VALUES (
                :dataset_version_id, :thy_id, :district_code, :county_code,
                :route_name, :route_suffix_code, :pm_prefix_code,
                :begin_pm, :end_pm, :pm_suffix_code, :length_miles,
                :left_lanes, :right_lanes,
                :left_surface_type, :right_surface_type,
                :left_shoulder_width, :right_shoulder_width,
                :median_type, :median_width,
                :access_code, :terrain_code, :design_speed, :adt,
                :landmark_short_desc, :functional_class_code,
                :maintenance_service_level_code, :federal_aid_code,
                :scenic_freeway_code, :extract_date, :raw_json
            )
        """), [{"dataset_version_id": dataset_version_id, **r} for r in batch])

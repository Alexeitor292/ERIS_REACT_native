from __future__ import annotations

import hashlib
import json
import re

from fastapi import APIRouter, Depends, File, HTTPException, Path, Query, UploadFile
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import get_current_user, require_roles
from ..precision import coordinates_differ, normalize_post_mile, normalize_route, round_coordinate
from ..schemas.common import (
    IncidentAssignBranchChiefRequest,
    IncidentAssignEngineerRequest,
    IncidentAssignRequest,
    IncidentCoordinatorForwardRequest,
    IncidentCreate,
    IncidentRequestRevision,
    IncidentResolveRequest,
    IncidentLocationLinkRequest,
)
from ..storage import make_object_key, put_object_bytes
from ..user_metadata import normalize_district_code, normalize_office_code, normalize_profile_text, parse_user_metadata

router = APIRouter(tags=["incidents"])
OFFICE_BY_DISTRICT: dict[str, str] = {
    "01": "WEST",
    "02": "NORTH",
    "03": "NORTH",
    "04": "WEST",
    "05": "WEST",
    "06": "NORTH",
    "07": "SOUTH",
    "08": "SOUTH",
    "09": "NORTH",
    "10": "NORTH",
    "11": "SOUTH",
    "12": "SOUTH",
}
REVISION_FIELDS_ALLOWED = {
    "district",
    "county",
    "route",
    "post_mile",
    "latitude",
    "longitude",
    "first_observed_at",
    "first_occurred_at",
    "description",
}


def _normalized_district_code(raw_district: str | None) -> str | None:
    return normalize_district_code(raw_district)


def _normalize_text(raw: str | None) -> str | None:
    return normalize_profile_text(raw)


def _location_display_name(
    district: str | None,
    county: str | None,
    route: str | None,
    post_mile: str | None,
) -> str | None:
    d = _normalize_text(district)
    c = _normalize_text(county)
    r = normalize_route(route)
    pm = normalize_post_mile(post_mile)
    parts = [p for p in [d, c, r, pm] if p]
    if not parts:
        return None
    if d and c and r and pm:
        return f"D{d} {c} R{r} PM {pm}"
    return " / ".join(parts)


def _office_for_district(raw_district: str | None) -> str | None:
    code = _normalized_district_code(raw_district)
    if not code:
        return None
    return OFFICE_BY_DISTRICT.get(code)


def _queue_incident_notifications(
    *,
    db: Session,
    incident_id: int,
    recipient_user_ids: list[int],
    template_code: str,
    payload: dict | None = None,
) -> None:
    unique_ids = sorted({int(x) for x in recipient_user_ids if int(x) > 0})
    if not unique_ids:
        return
    payload_json = json.dumps(payload or {})
    for uid in unique_ids:
        db.execute(
            text(
                """
                INSERT INTO incident_notifications
                  (incident_id, recipient_user_id, channel, template_code, payload_json)
                VALUES
                  (:iid, :uid, 'IN_APP', :template_code, :payload_json)
                """
            ),
            {
                "iid": incident_id,
                "uid": uid,
                "template_code": template_code,
                "payload_json": payload_json,
            },
        )


def _create_or_select_location(
    *,
    db: Session,
    district: str | None,
    county: str | None,
    route: str | None,
    post_mile: str | None,
    latitude: float,
    longitude: float,
) -> int:
    normalized_district = _normalize_text(district)
    normalized_county = _normalize_text(county)
    normalized_route = normalize_route(route)
    normalized_post_mile = normalize_post_mile(post_mile)
    rounded_latitude = round_coordinate(latitude)
    rounded_longitude = round_coordinate(longitude)

    existing = db.execute(
        text(
            """
            SELECT id
            FROM incident_locations
            WHERE COALESCE(district, '') = COALESCE(:district, '')
              AND COALESCE(county, '') = COALESCE(:county, '')
              AND COALESCE(route, '') = COALESCE(:route, '')
              AND COALESCE(post_mile_norm, '') = COALESCE(:post_mile_norm, '')
            LIMIT 1
            """
        ),
        {
            "district": normalized_district,
            "county": normalized_county,
            "route": normalized_route,
            "post_mile_norm": normalized_post_mile,
        },
    ).scalars().first()
    if existing is not None:
        return int(existing)

    db.execute(
        text(
            """
            INSERT INTO incident_locations
              (display_name, district, county, route, post_mile_raw, post_mile_norm, latitude, longitude)
            VALUES
              (:display_name, :district, :county, :route, :post_mile_raw, :post_mile_norm, :latitude, :longitude)
            """
        ),
        {
            "display_name": _location_display_name(district, county, route, post_mile),
            "district": normalized_district,
            "county": normalized_county,
            "route": normalized_route,
            "post_mile_raw": _normalize_text(post_mile),
            "post_mile_norm": normalized_post_mile,
            "latitude": rounded_latitude,
            "longitude": rounded_longitude,
        },
    )
    return int(db.execute(text("SELECT LAST_INSERT_ID()")).scalar())


def _incident_location_candidates(
    *,
    db: Session,
    district: str | None,
    county: str | None,
    route: str | None,
    post_mile: str | None,
    latitude: float,
    longitude: float,
    limit: int = 8,
) -> list[dict]:
    normalized_district = (_normalize_text(district) or "").lower()
    normalized_county = (_normalize_text(county) or "").lower()
    normalized_route = (normalize_route(route) or "").lower()
    normalized_pm = (normalize_post_mile(post_mile) or "").lower()
    rounded_latitude = round_coordinate(latitude)
    rounded_longitude = round_coordinate(longitude)
    rows = db.execute(
        text(
            """
            SELECT
              il.id,
              il.display_name,
              il.district,
              il.county,
              il.route,
              il.post_mile_raw,
              il.post_mile_norm,
              il.latitude,
              il.longitude,
              il.created_at,
              il.updated_at,
              (
                (LOWER(COALESCE(il.district, '')) = :district) +
                (LOWER(COALESCE(il.county, '')) = :county) +
                (LOWER(COALESCE(il.route, '')) = :route) +
                (COALESCE(il.post_mile_norm, '') = :post_mile_norm)
              ) AS match_score,
              (POW(COALESCE(il.latitude, :lat) - :lat, 2) + POW(COALESCE(il.longitude, :lon) - :lon, 2)) AS coordinate_distance
            FROM incident_locations il
            WHERE
              il.is_active = 1
              AND (
                :district = ''
                OR LOWER(COALESCE(il.district, '')) = :district
                OR LOWER(COALESCE(il.county, '')) = :county
                OR LOWER(COALESCE(il.route, '')) = :route
              )
            ORDER BY
              match_score DESC,
              coordinate_distance ASC,
              il.updated_at DESC
            LIMIT :limit
            """
        ),
        {
            "district": normalized_district,
            "county": normalized_county,
            "route": normalized_route,
            "post_mile_norm": normalized_pm,
            "lat": rounded_latitude,
            "lon": rounded_longitude,
            "limit": limit,
        },
    ).mappings().all()

    return [
        {
            "id": int(r["id"]),
            "display_name": r["display_name"],
            "district": r["district"],
            "county": r["county"],
            "route": r["route"],
            "post_mile": r["post_mile_raw"],
            "post_mile_norm": r["post_mile_norm"],
            "latitude": float(r["latitude"]) if r["latitude"] is not None else None,
            "longitude": float(r["longitude"]) if r["longitude"] is not None else None,
            "created_at": r["created_at"],
            "updated_at": r["updated_at"],
            "match_score": int(r["match_score"] or 0),
            "coordinate_distance": float(r["coordinate_distance"] or 0.0),
        }
        for r in rows
    ]


def _location_timeline(
    *,
    db: Session,
    location_id: int,
    limit: int = 20,
) -> dict:
    location_row = db.execute(
        text(
            """
            SELECT
              id,
              display_name,
              district,
              county,
              route,
              post_mile_raw,
              post_mile_norm,
              latitude,
              longitude,
              created_at,
              updated_at
            FROM incident_locations
            WHERE id = :location_id
            LIMIT 1
            """
        ),
        {"location_id": int(location_id)},
    ).mappings().first()
    if not location_row:
        raise HTTPException(status_code=404, detail="Location not found")

    incident_rows = db.execute(
        text(
            """
            SELECT
              i.id,
              i.status,
              i.current_stage,
              i.description,
              i.first_observed_at,
              i.first_occurred_at,
              i.created_at,
              i.updated_at,
              i.linked_submission_id
            FROM (
              SELECT
                inc.id,
                inc.status,
                inc.current_stage,
                inc.description,
                inc.first_observed_at,
                inc.first_occurred_at,
                inc.created_at,
                inc.updated_at,
                isl.submission_id AS linked_submission_id
              FROM incidents inc
              LEFT JOIN incident_submission_links isl
                ON isl.incident_id = inc.id
              WHERE inc.location_id = :location_id
              ORDER BY inc.first_observed_at DESC, inc.id DESC
              LIMIT :limit
            ) i
            ORDER BY i.first_observed_at DESC, i.id DESC
            """
        ),
        {"location_id": int(location_id), "limit": limit},
    ).mappings().all()

    submission_rows = db.execute(
        text(
            """
            SELECT
              s.id,
              s.status,
              s.title,
              s.created_at,
              s.updated_at,
              s.submitted_at,
              s.reviewed_at,
              g.date_incident_reported,
              g.report_date
            FROM submissions s
            JOIN submission_gisa g
              ON g.submission_id = s.id
            WHERE g.location_id = :location_id
            ORDER BY s.created_at DESC, s.id DESC
            LIMIT :limit
            """
        ),
        {"location_id": int(location_id), "limit": limit},
    ).mappings().all()

    return {
        "location": {
            "id": int(location_row["id"]),
            "display_name": location_row["display_name"],
            "district": location_row["district"],
            "county": location_row["county"],
            "route": location_row["route"],
            "post_mile": location_row["post_mile_raw"],
            "post_mile_norm": location_row["post_mile_norm"],
            "latitude": float(location_row["latitude"]) if location_row["latitude"] is not None else None,
            "longitude": float(location_row["longitude"]) if location_row["longitude"] is not None else None,
            "created_at": location_row["created_at"],
            "updated_at": location_row["updated_at"],
        },
        "incident_count": len(incident_rows),
        "submission_count": len(submission_rows),
        "incidents": [
            {
                "id": int(r["id"]),
                "status": r["status"],
                "current_stage": r["current_stage"],
                "description": r["description"],
                "first_observed_at": r["first_observed_at"],
                "first_occurred_at": r["first_occurred_at"],
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
                "linked_submission_id": int(r["linked_submission_id"]) if r["linked_submission_id"] is not None else None,
            }
            for r in incident_rows
        ],
        "submissions": [
            {
                "id": int(r["id"]),
                "status": r["status"],
                "title": r["title"],
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
                "submitted_at": r["submitted_at"],
                "reviewed_at": r["reviewed_at"],
                "date_incident_reported": r["date_incident_reported"],
                "report_date": r["report_date"],
            }
            for r in submission_rows
        ],
    }


def _routing_users_for(
    *,
    db: Session,
    assignment_type: str,
    district: str | None = None,
    office_code: str | None = None,
) -> list[int]:
    assignment_key = assignment_type.strip().upper()
    role_name = {
        "DISTRICT_COORDINATOR": "MAINT_COORDINATOR",
        "OFFICE_CHIEF": "OFFICE_CHIEF",
        "BRANCH_CHIEF": "BRANCH_CHIEF",
    }.get(assignment_key)
    if not role_name:
        return []

    params: dict[str, object] = {"role_name": role_name}
    where_parts = ["u.is_active = 1", "r.name = :role_name"]
    if assignment_key == "DISTRICT_COORDINATOR":
        district_code = _normalized_district_code(district)
        if not district_code:
            return []
        params["district"] = district_code
        where_parts.append("COALESCE(JSON_UNQUOTE(JSON_EXTRACT(u.metadata_json, '$.district')), '') = :district")
    else:
        normalized_office = normalize_office_code(office_code)
        if not normalized_office:
            return []
        params["office_code"] = normalized_office
        where_parts.append("COALESCE(JSON_UNQUOTE(JSON_EXTRACT(u.metadata_json, '$.office_code')), '') = :office_code")

    rows = db.execute(
        text(
            f"""
            SELECT DISTINCT u.id
            FROM users u
            JOIN user_roles ur ON ur.user_id = u.id
            JOIN roles r ON r.id = ur.role_id
            WHERE {' AND '.join(where_parts)}
            ORDER BY u.id ASC
            """
        ),
        params,
    ).scalars().all()
    return [int(x) for x in rows]


def _routing_user_options_for(
    *,
    db: Session,
    assignment_type: str,
    district: str | None = None,
    office_code: str | None = None,
) -> list[dict]:
    user_ids = _routing_users_for(db=db, assignment_type=assignment_type, district=district, office_code=office_code)
    if not user_ids:
        return []
    params = {f"user_id_{idx}": int(user_id) for idx, user_id in enumerate(user_ids)}
    tokens = ", ".join(f":user_id_{idx}" for idx in range(len(user_ids)))
    rows = db.execute(
        text(
            f"""
            SELECT id, email, full_name, metadata_json
            FROM users
            WHERE id IN ({tokens})
            ORDER BY full_name ASC, id ASC
            """
        ),
        params,
    ).mappings().all()
    return [
        {
            "id": int(r["id"]),
            "email": r["email"],
            "full_name": r["full_name"],
            "metadata": parse_user_metadata(r.get("metadata_json")),
        }
        for r in rows
    ]


def _ensure_incident_district_access(user: dict, district: str | None) -> None:
    if "ADMIN" in set(user.get("roles") or []):
        return
    user_district = _normalized_district_code((user.get("metadata") or {}).get("district"))
    incident_district = _normalized_district_code(district)
    if not user_district or user_district != incident_district:
        raise HTTPException(status_code=403, detail="Incident is outside your assigned district")


def _ensure_incident_office_access(user: dict, office_code: str | None) -> None:
    if "ADMIN" in set(user.get("roles") or []):
        return
    user_office = normalize_office_code((user.get("metadata") or {}).get("office_code"))
    incident_office = normalize_office_code(office_code)
    if not user_office or user_office != incident_office:
        raise HTTPException(status_code=403, detail="Incident is outside your assigned office")


def _ensure_incident_scope_access(user: dict, incident_row: dict) -> None:
    roles = set(user.get("roles") or [])
    if "ADMIN" in roles:
        return
    if "MAINT_COORDINATOR" in roles:
        _ensure_incident_district_access(user, incident_row.get("district"))
    if "OFFICE_CHIEF" in roles or "BRANCH_CHIEF" in roles:
        _ensure_incident_office_access(user, incident_row.get("office_code") or _office_for_district(incident_row.get("district")))


def _active_assignment_for_stage(db: Session, incident_id: int, stage: str) -> dict | None:
    row = db.execute(
        text(
            """
            SELECT a.id, a.assignee_user_id, a.assigned_by_user_id, a.assignment_mode, a.created_at
            FROM incident_assignments a
            WHERE a.incident_id = :iid
              AND a.assignment_stage = :stage
              AND a.is_active = 1
            ORDER BY a.id DESC
            LIMIT 1
            """
        ),
        {"iid": incident_id, "stage": stage},
    ).mappings().first()
    return dict(row) if row else None


def _set_stage_assignment(
    *,
    db: Session,
    incident_id: int,
    assignee_user_id: int,
    assigned_by_user_id: int,
    assignment_mode: str,
    assignment_stage: str,
) -> None:
    db.execute(
        text(
            """
            UPDATE incident_assignments
            SET is_active = 0, updated_at = NOW()
            WHERE incident_id = :iid AND assignment_stage = :stage AND is_active = 1
            """
        ),
        {"iid": incident_id, "stage": assignment_stage},
    )
    db.execute(
        text(
            """
            INSERT INTO incident_assignments (
              incident_id, assignee_user_id, assigned_by_user_id, assignment_stage, assignment_mode, is_active
            ) VALUES (
              :iid, :assignee, :assigned_by, :stage, :mode, 1
            )
            """
        ),
        {
            "iid": incident_id,
            "assignee": assignee_user_id,
            "assigned_by": assigned_by_user_id,
            "stage": assignment_stage,
            "mode": assignment_mode,
        },
    )


def ensure_incident_runtime_schema(db: Session) -> None:
    """
    TEMPORARY LEGACY COMPATIBILITY LAYER — do not add new columns here.

    This function applies idempotent ALTER TABLE / CREATE TABLE IF NOT EXISTS
    statements for databases that were bootstrapped before the current
    database/init/010_schema.sql was fully in sync with the application schema.
    All statements use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so they are
    safe to run against a fully-migrated schema.

    Status: kept until a proper migration tool (e.g. Alembic) is adopted.
    New schema changes must be made in database/init/010_schema.sql first, then
    mirrored here as ADD COLUMN IF NOT EXISTS for backward compat with existing
    dev and production databases.

    TODO: Replace with Alembic or a script-based migration runner.
    """
    ddl_statements = [
        """
        CREATE TABLE IF NOT EXISTS incident_locations (
          id BIGINT PRIMARY KEY AUTO_INCREMENT,
          display_name VARCHAR(255) NULL,
          district VARCHAR(64) NULL,
          county VARCHAR(64) NULL,
          route VARCHAR(64) NULL,
          post_mile_raw VARCHAR(64) NULL,
          post_mile_norm VARCHAR(64) NULL,
          latitude DECIMAL(10,6) NULL,
          longitude DECIMAL(10,6) NULL,
          is_active TINYINT NOT NULL DEFAULT 1,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_incident_location_identity (district, county, route, post_mile_norm),
          INDEX idx_incident_locations_geo (latitude, longitude),
          INDEX idx_incident_locations_lookup (district, county, route, post_mile_norm)
        ) ENGINE=InnoDB
        """,
        """
        ALTER TABLE incident_locations
          ADD COLUMN IF NOT EXISTS display_name VARCHAR(255) NULL
        """,
        """
        ALTER TABLE incidents
          ADD COLUMN IF NOT EXISTS first_observed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        """,
        """
        ALTER TABLE incidents
          ADD COLUMN IF NOT EXISTS first_occurred_at DATETIME NULL
        """,
        """
        ALTER TABLE incidents
          ADD COLUMN IF NOT EXISTS office_code VARCHAR(16) NULL
        """,
        """
        ALTER TABLE incidents
          ADD COLUMN IF NOT EXISTS location_id BIGINT NULL
        """,
        """
        ALTER TABLE incidents
          ADD COLUMN IF NOT EXISTS location_match_status VARCHAR(24) NOT NULL DEFAULT 'PENDING_REVIEW'
        """,
        """
        ALTER TABLE incidents
          ADD COLUMN IF NOT EXISTS location_reviewed_by_user_id BIGINT NULL
        """,
        """
        ALTER TABLE incidents
          ADD COLUMN IF NOT EXISTS location_reviewed_at DATETIME NULL
        """,
        """
        ALTER TABLE incidents
          ADD COLUMN IF NOT EXISTS location_match_metadata JSON NULL
        """,
        """
        ALTER TABLE incidents
          MODIFY COLUMN title VARCHAR(255) NULL
        """,
        """
        ALTER TABLE incident_locations
          MODIFY COLUMN latitude DECIMAL(10,6) NULL
        """,
        """
        ALTER TABLE incident_locations
          MODIFY COLUMN longitude DECIMAL(10,6) NULL
        """,
        """
        ALTER TABLE incidents
          MODIFY COLUMN latitude DECIMAL(10,6) NOT NULL
        """,
        """
        ALTER TABLE incidents
          MODIFY COLUMN longitude DECIMAL(10,6) NOT NULL
        """,
        """
        ALTER TABLE incidents
          ADD COLUMN IF NOT EXISTS current_stage VARCHAR(32) NOT NULL DEFAULT 'COORDINATOR_REVIEW'
        """,
        """
        ALTER TABLE incident_assignments
          ADD COLUMN IF NOT EXISTS assignment_stage VARCHAR(32) NOT NULL DEFAULT 'ENGINEER'
        """,
        """
        CREATE TABLE IF NOT EXISTS incident_routing_assignments (
          id BIGINT PRIMARY KEY AUTO_INCREMENT,
          assignment_type VARCHAR(32) NOT NULL,
          district VARCHAR(64) NULL,
          office_code VARCHAR(16) NULL,
          user_id BIGINT NOT NULL,
          is_active TINYINT NOT NULL DEFAULT 1,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          CONSTRAINT fk_inc_route_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE KEY uk_inc_route_unique (assignment_type, district, office_code, user_id),
          INDEX idx_inc_route_lookup (assignment_type, district, office_code, is_active)
        ) ENGINE=InnoDB
        """,
        """
        CREATE TABLE IF NOT EXISTS incident_notifications (
          id BIGINT PRIMARY KEY AUTO_INCREMENT,
          incident_id BIGINT NOT NULL,
          recipient_user_id BIGINT NOT NULL,
          channel VARCHAR(16) NOT NULL DEFAULT 'IN_APP',
          template_code VARCHAR(64) NOT NULL,
          payload_json JSON NULL,
          delivered_at DATETIME NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT fk_inc_notify_incident FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE,
          CONSTRAINT fk_inc_notify_recipient FOREIGN KEY (recipient_user_id) REFERENCES users(id) ON DELETE CASCADE,
          INDEX idx_inc_notify_incident (incident_id),
          INDEX idx_inc_notify_recipient (recipient_user_id),
          INDEX idx_inc_notify_created (created_at)
        ) ENGINE=InnoDB
        """,
    ]
    for sql in ddl_statements:
        db.execute(text(sql))


def _incident_with_assignment(db: Session, incident_id: int):
    row = db.execute(
        text(
            """
            SELECT
              i.id, i.title, i.incident_type, i.description,
              i.location_id, i.location_match_status, i.location_reviewed_by_user_id, i.location_match_metadata, i.location_reviewed_at,
              i.first_observed_at, i.first_occurred_at,
              i.latitude, i.longitude, i.district, i.county, i.route, i.post_mile,
              i.office_code, i.current_stage,
              i.status, i.reporter_user_id, i.created_at, i.updated_at,
              i.resolved_at, i.resolved_by_user_id, i.resolution_comment,
              a.id AS assignment_id, a.assignee_user_id, a.assigned_by_user_id,
              a.assignment_mode, a.assignment_stage, a.created_at AS assigned_at,
              u.email AS assignee_email, u.full_name AS assignee_name,
              isl.submission_id
            FROM incidents i
            LEFT JOIN incident_assignments a
              ON a.incident_id = i.id AND a.assignment_stage = 'ENGINEER' AND a.is_active = 1
            LEFT JOIN users u
              ON u.id = a.assignee_user_id
            LEFT JOIN incident_submission_links isl
              ON isl.incident_id = i.id
            WHERE i.id = :iid
            LIMIT 1
            """
        ),
        {"iid": incident_id},
    ).mappings().first()
    return row


def _mobile_scope_filters(db: Session, user: dict) -> tuple[list[str], dict[str, object]]:
    roles = set(user.get("roles") or [])
    uid = int(user["id"])
    if "ADMIN" in roles:
        return [], {}

    role_filters: list[str] = []
    params: dict[str, object] = {"mobile_uid": uid}
    metadata = user.get("metadata") or {}

    if "MAINT_COORDINATOR" in roles:
        district_code = _normalized_district_code(metadata.get("district"))
        if district_code:
            params["coord_district"] = district_code
            params["coord_district_plain"] = district_code.lstrip("0") or district_code
            role_filters.append(
                "(i.current_stage = 'COORDINATOR_REVIEW' AND ("
                "i.district = :coord_district OR "
                "i.district = :coord_district_plain OR "
                "i.district = CONCAT('District ', :coord_district) OR "
                "i.district = CONCAT('District ', :coord_district_plain)"
                "))"
            )

    if "OFFICE_CHIEF" in roles:
        office_code = normalize_office_code(metadata.get("office_code"))
        if office_code:
            params["office_chief_office"] = office_code
            role_filters.append(
                "(i.office_code = :office_chief_office AND i.location_id IS NOT NULL AND i.current_stage IN ('OFFICE_CHIEF_REVIEW','BRANCH_CHIEF_REVIEW','ENGINEER_ASSIGNED','RESOLVED'))"
            )

    if "BRANCH_CHIEF" in roles:
        office_code = normalize_office_code(metadata.get("office_code"))
        if office_code:
            params["branch_chief_office"] = office_code
            role_filters.append(
                "(i.office_code = :branch_chief_office AND i.location_id IS NOT NULL AND i.current_stage IN ('BRANCH_CHIEF_REVIEW','ENGINEER_ASSIGNED','RESOLVED'))"
            )

    if "FIELD_WORKER" in roles:
        role_filters.append(
            "EXISTS (SELECT 1 FROM incident_assignments ia WHERE ia.incident_id = i.id AND ia.assignment_stage = 'ENGINEER' AND ia.is_active = 1 AND ia.assignee_user_id = :mobile_uid)"
        )

    if "MAINTENANCE" in roles:
        role_filters.append("i.reporter_user_id = :mobile_uid")

    if not role_filters:
        return ["1=0"], params
    return [f"({' OR '.join(role_filters)})"], params


def _serialize_incident(row: dict) -> dict:
    return {
        "id": int(row["id"]),
        "title": row["title"],
        "incident_type": row["incident_type"],
        "description": row["description"],
        "location_id": int(row["location_id"]) if row["location_id"] is not None else None,
        "location_match_status": row["location_match_status"],
        "location_reviewed_by_user_id": int(row["location_reviewed_by_user_id"]) if row["location_reviewed_by_user_id"] is not None else None,
        "location_match_metadata": row["location_match_metadata"],
        "location_reviewed_at": row["location_reviewed_at"],
        "first_observed_at": row["first_observed_at"],
        "first_occurred_at": row["first_occurred_at"],
        "latitude": float(row["latitude"]),
        "longitude": float(row["longitude"]),
        "district": row["district"],
        "county": row["county"],
        "route": row["route"],
        "post_mile": row["post_mile"],
        "office_code": row["office_code"],
        "current_stage": row["current_stage"],
        "status": row["status"],
        "reporter_user_id": int(row["reporter_user_id"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "resolved_at": row["resolved_at"],
        "resolved_by_user_id": row["resolved_by_user_id"],
        "resolution_comment": row["resolution_comment"],
        "linked_submission_id": int(row["submission_id"]) if row["submission_id"] is not None else None,
        "assignment": (
            {
                "assignment_id": int(row["assignment_id"]),
                "assignee_user_id": int(row["assignee_user_id"]),
                "assigned_by_user_id": int(row["assigned_by_user_id"]),
                "assignment_mode": row["assignment_mode"],
                "assignment_stage": row["assignment_stage"],
                "assigned_at": row["assigned_at"],
                "assignee_email": row["assignee_email"],
                "assignee_name": row["assignee_name"],
            }
            if row["assignment_id"] is not None
            else None
        ),
    }


def _ensure_linked_submission(
    *,
    db: Session,
    incident_row: dict,
    assignee_user_id: int,
    actor_user_id: int,
) -> int:
    existing = db.execute(
        text(
            """
            SELECT submission_id
            FROM incident_submission_links
            WHERE incident_id = :iid
            LIMIT 1
            """
        ),
        {"iid": int(incident_row["id"])},
    ).scalar()
    if existing is not None:
        db.execute(
            text(
                """
                INSERT INTO submission_gisa (submission_id, location_id, updated_by_user_id)
                VALUES (:sid, :location_id, :updated_by)
                ON DUPLICATE KEY UPDATE
                  location_id = VALUES(location_id),
                  updated_by_user_id = VALUES(updated_by_user_id)
                """
            ),
            {
                "sid": int(existing),
                "location_id": incident_row["location_id"],
                "updated_by": actor_user_id,
            },
        )
        db.execute(
            text(
                """
                INSERT INTO submission_editors (submission_id, user_id, granted_by_user_id)
                VALUES (:sid, :uid, :granted_by)
                ON DUPLICATE KEY UPDATE granted_by_user_id = VALUES(granted_by_user_id)
                """
            ),
            {"sid": int(existing), "uid": assignee_user_id, "granted_by": actor_user_id},
        )
        return int(existing)

    title = f"Incident #{int(incident_row['id'])}: {incident_row['title']}"
    db.execute(
        text(
            """
            INSERT INTO submissions (created_by_user_id, status, client_submission_uuid, title)
            VALUES (:uid, 'DRAFT', UUID(), :title)
            """
        ),
        {"uid": assignee_user_id, "title": title},
    )
    submission_id = int(db.execute(text("SELECT LAST_INSERT_ID()")).scalar())

    db.execute(
        text(
            """
            INSERT INTO workflow_events
              (submission_id, actor_user_id, event_type, from_status, to_status, comment)
            VALUES
              (:sid, :actor, 'CREATE', NULL, 'DRAFT', :comment)
            """
        ),
        {
            "sid": submission_id,
            "actor": actor_user_id,
            "comment": f"Draft created from incident #{int(incident_row['id'])}",
        },
    )

    db.execute(
        text(
            """
            INSERT INTO submission_gisa (
              submission_id,
              location_id,
              report_date,
              date_incident_reported,
              district,
              county,
              route,
              post_mile,
              latitude,
              longitude,
              updated_by_user_id
            ) VALUES (
              :sid,
              :location_id,
              :date_incident_reported,
              CURDATE(),
              :district,
              :county,
              :route,
              :post_mile,
              :lat,
              :lon,
              :updated_by
            )
            """
        ),
        {
            "sid": submission_id,
            "location_id": incident_row["location_id"],
            "district": incident_row["district"],
            "county": incident_row["county"],
            "route": incident_row["route"],
            "post_mile": incident_row["post_mile"],
            "date_incident_reported": (
                incident_row["first_observed_at"].date()
                if incident_row.get("first_observed_at") is not None
                else None
            ),
            "lat": incident_row["latitude"],
            "lon": incident_row["longitude"],
            "updated_by": actor_user_id,
        },
    )

    db.execute(
        text(
            """
            INSERT INTO incident_submission_links (incident_id, submission_id, linked_by_user_id)
            VALUES (:iid, :sid, :uid)
            """
        ),
        {"iid": int(incident_row["id"]), "sid": submission_id, "uid": actor_user_id},
    )
    reporter_uid = int(incident_row["reporter_user_id"])
    if reporter_uid != assignee_user_id:
        db.execute(
            text(
                """
                INSERT INTO submission_visibility (submission_id, user_id, granted_by_user_id)
                VALUES (:sid, :uid, :granted_by)
                ON DUPLICATE KEY UPDATE granted_by_user_id = VALUES(granted_by_user_id)
                """
            ),
            {"sid": submission_id, "uid": reporter_uid, "granted_by": actor_user_id},
        )
    return submission_id


def _assign_incident(
    *,
    db: Session,
    incident_id: int,
    assignee_user_id: int,
    assigned_by_user_id: int,
    mode: str,
    require_unclaimed: bool = False,
) -> dict:
    incident = _incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    if str(incident["status"]).upper() == "RESOLVED":
        raise HTTPException(status_code=409, detail="Resolved incidents cannot be reassigned")
    if require_unclaimed and incident["assignee_user_id"] is not None and int(incident["assignee_user_id"]) != assignee_user_id:
        raise HTTPException(status_code=409, detail="Incident is already assigned")

    assignee = db.execute(
        text("SELECT id, is_active FROM users WHERE id = :uid LIMIT 1"),
        {"uid": assignee_user_id},
    ).mappings().first()
    if not assignee or int(assignee["is_active"]) != 1:
        raise HTTPException(status_code=404, detail="Assignee not found or inactive")

    _set_stage_assignment(
        db=db,
        incident_id=incident_id,
        assignee_user_id=assignee_user_id,
        assigned_by_user_id=assigned_by_user_id,
        assignment_mode=mode,
        assignment_stage="ENGINEER",
    )

    db.execute(
        text(
            """
            UPDATE incidents
            SET status = 'IN_PROGRESS',
                current_stage = 'ENGINEER_ASSIGNED',
                updated_at = NOW()
            WHERE id = :iid
            """
        ),
        {"iid": incident_id},
    )

    linked_submission_id = _ensure_linked_submission(
        db=db,
        incident_row=incident,
        assignee_user_id=assignee_user_id,
        actor_user_id=assigned_by_user_id,
    )
    return {
        "incident_id": incident_id,
        "assignee_user_id": assignee_user_id,
        "assignment_mode": mode,
        "assignment_stage": "ENGINEER",
        "linked_submission_id": linked_submission_id,
    }


def _notify_coordinator_engineer_assigned(*, db: Session, incident_id: int) -> None:
    incident = db.execute(
        text("SELECT district, office_code FROM incidents WHERE id = :iid LIMIT 1"),
        {"iid": incident_id},
    ).mappings().first()
    if not incident:
        return
    district_code = _normalized_district_code(incident["district"])
    recipients = _routing_users_for(
        db=db,
        assignment_type="DISTRICT_COORDINATOR",
        district=district_code,
    )
    _queue_incident_notifications(
        db=db,
        incident_id=incident_id,
        recipient_user_ids=recipients,
        template_code="INCIDENT_ENGINEER_ASSIGNED",
        payload={"incident_id": incident_id, "district": district_code, "office_code": incident["office_code"]},
    )


@router.post("/incidents")
def create_incident(
    payload: IncidentCreate,
    db: Session = Depends(get_db),
    user=Depends(require_roles(["MAINTENANCE", "FIELD_WORKER", "ADMIN"])),
):
    title = (payload.title or "").strip() or None
    district = _normalize_text(payload.district)
    county = _normalize_text(payload.county)
    route = normalize_route(payload.route)
    post_mile = normalize_post_mile(payload.post_mile)
    latitude = round_coordinate(payload.latitude)
    longitude = round_coordinate(payload.longitude)
    if not (district and county and route and post_mile):
        raise HTTPException(
            status_code=400,
            detail="district, county, route, and post_mile are required location fields",
        )
    if latitude is None or longitude is None:
        raise HTTPException(status_code=400, detail="latitude and longitude are required")

    district_code = _normalized_district_code(district)
    office_code = _office_for_district(district)
    try:
        db.execute(
            text(
                """
                INSERT INTO incidents (
                  title, incident_type, description, location_id, location_match_status,
                  latitude, longitude,
                  first_observed_at, first_occurred_at,
                  district, county, route, post_mile, office_code, current_stage,
                  status, reporter_user_id
                ) VALUES (
                :title, :incident_type, :description, NULL, 'PENDING_REVIEW', :lat, :lon,
                  :first_observed_at, :first_occurred_at,
                  :district, :county, :route, :post_mile, :office_code, 'COORDINATOR_REVIEW',
                  'NEW', :uid
                )
                """
            ),
            {
                "title": title,
                "incident_type": (payload.incident_type or "").strip() or None,
                "description": (payload.description or "").strip() or None,
                "lat": latitude,
                "lon": longitude,
                "first_observed_at": payload.first_observed_at,
                "first_occurred_at": payload.first_occurred_at,
                "district": district,
                "county": county,
                "route": route,
                "post_mile": post_mile,
                "office_code": office_code,
                "uid": user["id"],
            },
        )
        new_id = int(db.execute(text("SELECT LAST_INSERT_ID()")).scalar())
        coordinator_ids = _routing_users_for(
            db=db,
            assignment_type="DISTRICT_COORDINATOR",
            district=district_code,
        )
        if coordinator_ids:
            _set_stage_assignment(
                db=db,
                incident_id=new_id,
                assignee_user_id=coordinator_ids[0],
                assigned_by_user_id=int(user["id"]),
                assignment_mode="ASSIGN",
                assignment_stage="COORDINATOR",
            )
            _queue_incident_notifications(
                db=db,
                incident_id=new_id,
                recipient_user_ids=coordinator_ids,
                template_code="INCIDENT_COORDINATOR_REVIEW",
                payload={"incident_id": new_id, "district": district_code, "office_code": office_code},
            )
        db.commit()
        row = _incident_with_assignment(db, new_id)
        return {"incident": _serialize_incident(dict(row))}
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/incidents/{incident_id}/location-candidates")
def list_incident_location_candidates(
    incident_id: int = Path(..., ge=1),
    limit: int = Query(default=8, ge=1, le=20),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["MAINT_COORDINATOR", "ADMIN"])),
):
    incident = _incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    _ensure_incident_district_access(user, incident.get("district"))
    if incident["latitude"] is None or incident["longitude"] is None:
        raise HTTPException(status_code=409, detail="Incident coordinates are required for location matching")
    candidates = _incident_location_candidates(
        db=db,
        district=incident["district"],
        county=incident["county"],
        route=incident["route"],
        post_mile=incident["post_mile"],
        latitude=float(incident["latitude"]),
        longitude=float(incident["longitude"]),
        limit=limit,
    )
    return {
        "incident_id": int(incident["id"]),
        "location_id": int(incident["location_id"]) if incident["location_id"] is not None else None,
        "location_match_status": incident["location_match_status"],
        "items": candidates,
    }


@router.get("/incident-locations/{location_id}/timeline")
def get_incident_location_timeline(
    location_id: int = Path(..., ge=1),
    limit: int = Query(default=20, ge=1, le=50),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["MAINT_COORDINATOR", "OFFICE_CHIEF", "BRANCH_CHIEF", "ADMIN"])),
):
    return _location_timeline(db=db, location_id=location_id, limit=limit)


@router.post("/incidents/{incident_id}/location-link")
def link_incident_location(
    payload: IncidentLocationLinkRequest,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["MAINT_COORDINATOR", "ADMIN"])),
):
    incident = _incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    _ensure_incident_district_access(user, incident.get("district"))
    if str(incident["status"]).upper() == "RESOLVED":
        raise HTTPException(status_code=409, detail="Resolved incidents cannot be relinked")

    mode = (payload.mode or "").strip().upper()
    if mode == "EXISTING":
        if not payload.location_id:
            raise HTTPException(status_code=400, detail="location_id is required for EXISTING mode")
        chosen_location_id = int(payload.location_id)
        exists = db.execute(
            text(
                """
                SELECT id
                FROM incident_locations
                WHERE id = :location_id
                LIMIT 1
                """
            ),
            {"location_id": chosen_location_id},
        ).scalar()
        if not exists:
            raise HTTPException(status_code=404, detail="Location was not found")
        new_status = "LINKED_EXISTING"
    elif mode == "CREATE_NEW":
        chosen_location_id = _create_or_select_location(
            db=db,
            district=incident["district"],
            county=incident["county"],
            route=incident["route"],
            post_mile=incident["post_mile"],
            latitude=float(incident["latitude"]),
            longitude=float(incident["longitude"]),
        )
        new_status = "NEW_LOCATION_CREATED"
    else:
        raise HTTPException(status_code=400, detail="Invalid mode. Use EXISTING or CREATE_NEW.")

    metadata = {
        "mode": mode,
        "comment": (payload.comment or "").strip() or None,
        "performed_by_user_id": int(user["id"]),
    }
    try:
        db.execute(
            text(
                """
                UPDATE incidents
                SET location_id = :location_id,
                    location_match_status = :status,
                    location_reviewed_by_user_id = :reviewer,
                    location_reviewed_at = NOW(),
                    location_match_metadata = :metadata,
                    updated_at = NOW()
                WHERE id = :iid
                """
            ),
            {
                "iid": incident_id,
                "location_id": chosen_location_id,
                "status": new_status,
                "reviewer": int(user["id"]),
                "metadata": json.dumps(metadata),
            },
        )
        db.commit()
        return {
            "incident_id": int(incident_id),
            "location_id": chosen_location_id,
            "location_match_status": new_status,
        }
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/incidents/{incident_id}/coordinator/request-revision")
def coordinator_request_revision(
    payload: IncidentRequestRevision,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["MAINT_COORDINATOR", "ADMIN"])),
):
    incident = _incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    _ensure_incident_district_access(user, incident.get("district"))
    if str(incident["status"]).upper() == "RESOLVED":
        raise HTTPException(status_code=409, detail="Resolved incidents cannot be revised")
    if str(incident["current_stage"]).upper() != "COORDINATOR_REVIEW":
        raise HTTPException(status_code=409, detail="Revision request is only allowed during coordinator review")

    requested_fields = []
    for raw_field in payload.revision_fields or []:
        normalized = str(raw_field or "").strip().lower()
        if normalized and normalized in REVISION_FIELDS_ALLOWED and normalized not in requested_fields:
            requested_fields.append(normalized)

    metadata = {
        "mode": "REQUEST_REVISION",
        "comment": (payload.comment or "").strip() or None,
        "performed_by_user_id": int(user["id"]),
        "revision_fields": requested_fields,
    }
    try:
        db.execute(
            text(
                """
                UPDATE incidents
                SET location_match_status = 'NEEDS_REVISION',
                    location_reviewed_by_user_id = :reviewer,
                    location_reviewed_at = NOW(),
                    location_match_metadata = :metadata,
                    updated_at = NOW()
                WHERE id = :iid
                """
            ),
            {
                "iid": incident_id,
                "reviewer": int(user["id"]),
                "metadata": json.dumps(metadata),
            },
        )
        db.commit()
        return {"incident_id": int(incident_id), "location_match_status": "NEEDS_REVISION"}
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.patch("/incidents/{incident_id}")
def maintenance_resubmit_incident(
    payload: IncidentCreate,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["MAINTENANCE", "FIELD_WORKER", "ADMIN"])),
):
    incident = _incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    if str(incident["status"]).upper() == "RESOLVED":
        raise HTTPException(status_code=409, detail="Resolved incidents cannot be edited")

    user_roles = set(user.get("roles") or [])
    is_admin = "ADMIN" in user_roles
    if not is_admin and int(incident["reporter_user_id"]) != int(user["id"]):
        raise HTTPException(status_code=403, detail="Only the reporting maintenance worker can resubmit this incident")
    if str(incident["current_stage"]).upper() != "COORDINATOR_REVIEW":
        raise HTTPException(status_code=409, detail="This incident is no longer in coordinator review")
    if str(incident["location_match_status"] or "").upper() != "NEEDS_REVISION":
        raise HTTPException(status_code=409, detail="This incident is not marked for revision")

    district = _normalize_text(payload.district)
    county = _normalize_text(payload.county)
    route = normalize_route(payload.route)
    post_mile = normalize_post_mile(payload.post_mile)
    latitude = round_coordinate(payload.latitude)
    longitude = round_coordinate(payload.longitude)
    if not (district and county and route and post_mile):
        raise HTTPException(
            status_code=400,
            detail="district, county, route, and post_mile are required location fields",
        )
    if latitude is None or longitude is None:
        raise HTTPException(status_code=400, detail="latitude and longitude are required")

    metadata_obj = incident.get("location_match_metadata") or {}
    requested_fields_raw = metadata_obj.get("revision_fields") if isinstance(metadata_obj, dict) else None
    requested_fields = {
        str(x or "").strip().lower()
        for x in (requested_fields_raw or [])
        if str(x or "").strip().lower() in REVISION_FIELDS_ALLOWED
    }
    if requested_fields:
        old_first_observed = str(incident.get("first_observed_at") or "")[:10]
        old_first_occurred = str(incident.get("first_occurred_at") or "")[:10]
        changed_fields: set[str] = set()
        if _normalize_text(incident.get("district")) != district:
            changed_fields.add("district")
        if _normalize_text(incident.get("county")) != county:
            changed_fields.add("county")
        if _normalize_text(incident.get("route")) != route:
            changed_fields.add("route")
        if _normalize_text(incident.get("post_mile")) != post_mile:
            changed_fields.add("post_mile")
        if coordinates_differ(incident.get("latitude"), latitude):
            changed_fields.add("latitude")
        if coordinates_differ(incident.get("longitude"), longitude):
            changed_fields.add("longitude")
        if old_first_observed != str(payload.first_observed_at)[:10]:
            changed_fields.add("first_observed_at")
        if old_first_occurred != str(payload.first_occurred_at or "")[:10]:
            changed_fields.add("first_occurred_at")
        if _normalize_text(incident.get("description")) != _normalize_text(payload.description):
            changed_fields.add("description")
        disallowed_changes = sorted([f for f in changed_fields if f not in requested_fields])
        if disallowed_changes:
            raise HTTPException(
                status_code=400,
                detail=f"Only requested revision fields may be changed: {', '.join(sorted(requested_fields))}",
            )

    office_code = _office_for_district(district)
    metadata = {
        "mode": "RESUBMITTED_BY_MAINTENANCE",
        "performed_by_user_id": int(user["id"]),
    }
    try:
        db.execute(
            text(
                """
                UPDATE incidents
                SET title = :title,
                    incident_type = :incident_type,
                    description = :description,
                    latitude = :lat,
                    longitude = :lon,
                    first_observed_at = :first_observed_at,
                    first_occurred_at = :first_occurred_at,
                    district = :district,
                    county = :county,
                    route = :route,
                    post_mile = :post_mile,
                    office_code = :office_code,
                    location_id = NULL,
                    location_match_status = 'PENDING_REVIEW',
                    location_reviewed_by_user_id = NULL,
                    location_reviewed_at = NULL,
                    location_match_metadata = :metadata,
                    updated_at = NOW()
                WHERE id = :iid
                """
            ),
            {
                "iid": incident_id,
                "title": (payload.title or "").strip() or None,
                "incident_type": (payload.incident_type or "").strip() or None,
                "description": (payload.description or "").strip() or None,
                "lat": latitude,
                "lon": longitude,
                "first_observed_at": payload.first_observed_at,
                "first_occurred_at": payload.first_occurred_at,
                "district": district,
                "county": county,
                "route": route,
                "post_mile": post_mile,
                "office_code": office_code,
                "metadata": json.dumps(metadata),
            },
        )
        db.commit()
        row = _incident_with_assignment(db, incident_id)
        return {"incident": _serialize_incident(dict(row))}
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/incidents")
def list_incidents(
    status: str | None = Query(default=None),
    unclaimed_only: bool = Query(default=False),
    scope: str | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=1000),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["MAINTENANCE", "FIELD_WORKER", "MAINT_COORDINATOR", "OFFICE_CHIEF", "BRANCH_CHIEF", "REVIEWER", "ADMIN"])),
):
    params: dict[str, object] = {"limit": limit}
    where_parts: list[str] = []
    if status:
        status_u = status.strip().upper()
        if status_u not in {"NEW", "IN_PROGRESS", "RESOLVED"}:
            raise HTTPException(status_code=400, detail="Invalid incident status filter")
        where_parts.append("i.status = :status")
        params["status"] = status_u
    if unclaimed_only:
        where_parts.append("a.id IS NULL")
    if (scope or "").strip().lower() == "mobile":
        mobile_filters, mobile_params = _mobile_scope_filters(db, user)
        where_parts.extend(mobile_filters)
        params.update(mobile_params)
    where_sql = f"WHERE {' AND '.join(where_parts)}" if where_parts else ""
    rows = db.execute(
        text(
            f"""
            SELECT
              i.id, i.title, i.incident_type, i.description,
              i.location_id, i.location_match_status, i.location_reviewed_by_user_id, i.location_match_metadata, i.location_reviewed_at,
              i.first_observed_at, i.first_occurred_at,
              i.latitude, i.longitude, i.district, i.county, i.route, i.post_mile,
              i.office_code, i.current_stage,
              i.status, i.reporter_user_id, i.created_at, i.updated_at,
              i.resolved_at, i.resolved_by_user_id, i.resolution_comment,
              a.id AS assignment_id, a.assignee_user_id, a.assigned_by_user_id,
              a.assignment_mode, a.assignment_stage, a.created_at AS assigned_at,
              u.email AS assignee_email, u.full_name AS assignee_name,
              isl.submission_id
            FROM incidents i
            LEFT JOIN incident_assignments a
              ON a.incident_id = i.id AND a.assignment_stage = 'ENGINEER' AND a.is_active = 1
            LEFT JOIN users u
              ON u.id = a.assignee_user_id
            LEFT JOIN incident_submission_links isl
              ON isl.incident_id = i.id
            {where_sql}
            ORDER BY i.created_at DESC, i.id DESC
            LIMIT :limit
            """
        ),
        params,
    ).mappings().all()
    return {"items": [_serialize_incident(dict(r)) for r in rows], "requested_by_user_id": user["id"]}


@router.get("/incidents/{incident_id}")
def get_incident(
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["MAINTENANCE", "FIELD_WORKER", "MAINT_COORDINATOR", "OFFICE_CHIEF", "BRANCH_CHIEF", "REVIEWER", "ADMIN"])),
):
    row = _incident_with_assignment(db, incident_id)
    if not row:
        raise HTTPException(status_code=404, detail="Incident not found")
    incident = dict(row)
    _ensure_incident_scope_access(user, incident)
    return {"incident": _serialize_incident(incident), "requested_by_user_id": user["id"]}


@router.post("/incidents/{incident_id}/claim")
def claim_incident(
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["MAINTENANCE", "FIELD_WORKER", "ADMIN"])),
):
    raise HTTPException(status_code=409, detail="Claim is disabled. Incidents must follow coordinator/office/branch workflow.")


@router.post("/incidents/{incident_id}/assign")
def assign_incident(
    payload: IncidentAssignRequest,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN"])),
):
    try:
        result = _assign_incident(
            db=db,
            incident_id=incident_id,
            assignee_user_id=int(payload.assignee_user_id),
            assigned_by_user_id=int(user["id"]),
            mode="ASSIGN",
        )
        _notify_coordinator_engineer_assigned(db=db, incident_id=incident_id)
        db.commit()
        return result
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/incidents/{incident_id}/coordinator/forward")
def coordinator_forward_incident(
    payload: IncidentCoordinatorForwardRequest,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["MAINT_COORDINATOR", "ADMIN"])),
):
    incident = _incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    _ensure_incident_district_access(user, incident.get("district"))
    if str(incident["status"]).upper() == "RESOLVED":
        raise HTTPException(status_code=409, detail="Resolved incidents cannot be forwarded")
    if incident["location_id"] is None:
        raise HTTPException(
            status_code=409,
            detail="Select or create a location record before forwarding this incident.",
        )

    office_code = incident.get("office_code")
    if not office_code:
        office_code = _office_for_district(incident.get("district"))

    office_chief_ids = _routing_users_for(
        db=db,
        assignment_type="OFFICE_CHIEF",
        office_code=office_code,
    )
    if not office_chief_ids:
        raise HTTPException(status_code=400, detail="No office chief routing configured for this office")

    try:
        linked_submission_id = _ensure_linked_submission(
            db=db,
            incident_row=incident,
            assignee_user_id=int(user["id"]),
            actor_user_id=int(user["id"]),
        )
        db.execute(
            text(
                """
                UPDATE incidents
                SET current_stage = 'OFFICE_CHIEF_REVIEW',
                    office_code = :office_code,
                    updated_at = NOW()
                WHERE id = :iid
                """
            ),
            {"iid": incident_id, "office_code": office_code},
        )
        _set_stage_assignment(
            db=db,
            incident_id=incident_id,
            assignee_user_id=office_chief_ids[0],
            assigned_by_user_id=int(user["id"]),
            assignment_mode="ASSIGN",
            assignment_stage="OFFICE_CHIEF",
        )
        _queue_incident_notifications(
            db=db,
            incident_id=incident_id,
            recipient_user_ids=office_chief_ids,
            template_code="INCIDENT_OFFICE_CHIEF_REVIEW",
            payload={
                "incident_id": incident_id,
                "office_code": office_code,
                "comment": (payload.comment or "").strip() or None,
            },
        )
        db.commit()
        return {
            "incident_id": incident_id,
            "current_stage": "OFFICE_CHIEF_REVIEW",
            "office_code": office_code,
            "linked_submission_id": linked_submission_id,
        }
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/incidents/{incident_id}/office-chief/branch-options")
def office_chief_branch_options(
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["OFFICE_CHIEF", "ADMIN"])),
):
    incident = _incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    office_code = incident.get("office_code") or _office_for_district(incident.get("district"))
    _ensure_incident_office_access(user, office_code)
    return {
        "incident_id": int(incident_id),
        "office_code": office_code,
        "items": _routing_user_options_for(
            db=db,
            assignment_type="BRANCH_CHIEF",
            office_code=office_code,
        ),
    }


@router.post("/incidents/{incident_id}/office-chief/assign-branch")
def office_chief_assign_branch(
    payload: IncidentAssignBranchChiefRequest,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["OFFICE_CHIEF", "ADMIN"])),
):
    incident = _incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    if str(incident["status"]).upper() == "RESOLVED":
        raise HTTPException(status_code=409, detail="Resolved incidents cannot be reassigned")

    office_code = incident.get("office_code") or _office_for_district(incident.get("district"))
    _ensure_incident_office_access(user, office_code)
    allowed_branch_ids = _routing_users_for(
        db=db,
        assignment_type="BRANCH_CHIEF",
        office_code=office_code,
    )
    if int(payload.branch_chief_user_id) not in set(allowed_branch_ids):
        raise HTTPException(status_code=400, detail="Selected user is not configured as a branch chief for this office")

    try:
        db.execute(
            text(
                """
                UPDATE incidents
                SET current_stage = 'BRANCH_CHIEF_REVIEW',
                    office_code = :office_code,
                    updated_at = NOW()
                WHERE id = :iid
                """
            ),
            {"iid": incident_id, "office_code": office_code},
        )
        _set_stage_assignment(
            db=db,
            incident_id=incident_id,
            assignee_user_id=int(payload.branch_chief_user_id),
            assigned_by_user_id=int(user["id"]),
            assignment_mode="ASSIGN",
            assignment_stage="BRANCH_CHIEF",
        )
        _queue_incident_notifications(
            db=db,
            incident_id=incident_id,
            recipient_user_ids=[int(payload.branch_chief_user_id)],
            template_code="INCIDENT_BRANCH_CHIEF_ASSIGNMENT",
            payload={"incident_id": incident_id, "office_code": office_code},
        )
        db.commit()
        return {"incident_id": incident_id, "current_stage": "BRANCH_CHIEF_REVIEW"}
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/incidents/{incident_id}/branch-chief/assign-engineer")
def branch_chief_assign_engineer(
    payload: IncidentAssignEngineerRequest,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["BRANCH_CHIEF", "ADMIN"])),
):
    incident = _incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    _ensure_incident_office_access(user, incident.get("office_code") or _office_for_district(incident.get("district")))
    try:
        result = _assign_incident(
            db=db,
            incident_id=incident_id,
            assignee_user_id=int(payload.engineer_user_id),
            assigned_by_user_id=int(user["id"]),
            mode="ASSIGN",
        )
        _notify_coordinator_engineer_assigned(db=db, incident_id=incident_id)
        db.commit()
        return result
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/incidents/routing/assignments")
def list_incident_routing_assignments(
    assignment_type: str | None = Query(default=None),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN"])),
):
    params: dict[str, object] = {}
    where = ""
    if assignment_type:
        where = "WHERE assignment_type = :assignment_type"
        params["assignment_type"] = assignment_type.strip().upper()
    rows = db.execute(
        text(
            f"""
            SELECT
              ra.id, ra.assignment_type, ra.district, ra.office_code, ra.user_id, ra.is_active,
              u.email, u.full_name
            FROM incident_routing_assignments ra
            JOIN users u ON u.id = ra.user_id
            {where}
            ORDER BY ra.assignment_type, ra.district, ra.office_code, ra.id
            """
        ),
        params,
    ).mappings().all()
    return {
        "items": [
            {
                "id": int(r["id"]),
                "assignment_type": r["assignment_type"],
                "district": r["district"],
                "office_code": r["office_code"],
                "user_id": int(r["user_id"]),
                "is_active": bool(r["is_active"]),
                "email": r["email"],
                "full_name": r["full_name"],
            }
            for r in rows
        ],
        "requested_by_user_id": user["id"],
    }


@router.post("/incidents/routing/assignments")
def create_incident_routing_assignment(
    payload: dict,
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN"])),
):
    assignment_type = str(payload.get("assignment_type") or "").strip().upper()
    district = _normalized_district_code(payload.get("district"))
    office_code = str(payload.get("office_code") or "").strip().upper() or None
    user_id = int(payload.get("user_id") or 0)
    is_active = 1 if bool(payload.get("is_active", True)) else 0
    if assignment_type not in {"DISTRICT_COORDINATOR", "OFFICE_CHIEF", "BRANCH_CHIEF"}:
        raise HTTPException(status_code=400, detail="Invalid assignment_type")
    if user_id <= 0:
        raise HTTPException(status_code=400, detail="user_id is required")
    if assignment_type == "DISTRICT_COORDINATOR" and not district:
        raise HTTPException(status_code=400, detail="district is required for DISTRICT_COORDINATOR")
    if assignment_type in {"OFFICE_CHIEF", "BRANCH_CHIEF"} and not office_code:
        raise HTTPException(status_code=400, detail="office_code is required for this assignment_type")
    try:
        db.execute(
            text(
                """
                INSERT INTO incident_routing_assignments
                  (assignment_type, district, office_code, user_id, is_active)
                VALUES
                  (:assignment_type, :district, :office_code, :user_id, :is_active)
                ON DUPLICATE KEY UPDATE
                  is_active = VALUES(is_active),
                  updated_at = NOW()
                """
            ),
            {
                "assignment_type": assignment_type,
                "district": district,
                "office_code": office_code,
                "user_id": user_id,
                "is_active": is_active,
            },
        )
        db.commit()
        return {"ok": True, "assignment_type": assignment_type, "district": district, "office_code": office_code, "user_id": user_id}
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/incidents/routing/assignments/{assignment_id}")
def delete_incident_routing_assignment(
    assignment_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN"])),
):
    db.execute(text("DELETE FROM incident_routing_assignments WHERE id = :id"), {"id": assignment_id})
    db.commit()
    return {"ok": True, "assignment_id": assignment_id, "deleted_by_user_id": user["id"]}


@router.post("/incidents/{incident_id}/unassign")
def unassign_incident(
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN"])),
):
    incident = _incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    if str(incident["status"]).upper() == "RESOLVED":
        raise HTTPException(status_code=409, detail="Resolved incidents cannot be unassigned")
    try:
        db.execute(
            text(
                """
                UPDATE incident_assignments
                SET is_active = 0, updated_at = NOW()
                WHERE incident_id = :iid AND assignment_stage = 'ENGINEER' AND is_active = 1
                """
            ),
            {"iid": incident_id},
        )
        db.execute(
            text(
                """
                UPDATE incidents
                SET status = 'NEW',
                    current_stage = 'BRANCH_CHIEF_REVIEW',
                    updated_at = NOW()
                WHERE id = :iid
                """
            ),
            {"iid": incident_id},
        )
        db.commit()
        return {"incident_id": incident_id, "status": "NEW"}
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/incidents/{incident_id}/resolve")
def resolve_incident(
    payload: IncidentResolveRequest,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["FIELD_WORKER", "ADMIN"])),
):
    incident = _incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    assignee_user_id = incident["assignee_user_id"]
    if not ("ADMIN" in set(user["roles"]) or (assignee_user_id is not None and int(assignee_user_id) == int(user["id"]))):
        raise HTTPException(status_code=403, detail="Only assigned engineer or admin can resolve")
    try:
        db.execute(
            text(
                """
                UPDATE incidents
                SET status = 'RESOLVED',
                    current_stage = 'RESOLVED',
                    resolved_at = NOW(),
                    resolved_by_user_id = :uid,
                    resolution_comment = :comment,
                    updated_at = NOW()
                WHERE id = :iid
                """
            ),
            {
                "iid": incident_id,
                "uid": user["id"],
                "comment": (payload.comment or "").strip() or None,
            },
        )
        db.execute(
            text(
                """
                UPDATE incident_assignments
                SET is_active = 0, updated_at = NOW()
                WHERE incident_id = :iid AND is_active = 1
                """
            ),
            {"iid": incident_id},
        )
        db.commit()
        return {"incident_id": incident_id, "status": "RESOLVED"}
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/mission-center/incidents")
def mission_center_incident_feed(
    scope: str | None = Query(default=None),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["MAINTENANCE", "FIELD_WORKER", "MAINT_COORDINATOR", "OFFICE_CHIEF", "BRANCH_CHIEF", "REVIEWER", "ADMIN"])),
):
    where_parts: list[str] = []
    params: dict[str, object] = {}
    if (scope or "").strip().lower() == "mobile":
        mobile_filters, mobile_params = _mobile_scope_filters(db, user)
        where_parts.extend(mobile_filters)
        params.update(mobile_params)
    where_sql = f"WHERE {' AND '.join(where_parts)}" if where_parts else ""
    rows = db.execute(
        text(
            f"""
            SELECT
              i.id,
              i.title,
              i.incident_type,
              i.current_stage,
              i.status,
              i.latitude,
              i.longitude,
              i.created_at,
              i.updated_at,
              a.assignee_user_id,
              u.full_name AS assignee_name,
              isl.submission_id
            FROM incidents i
            LEFT JOIN incident_assignments a
              ON a.incident_id = i.id AND a.is_active = 1
            LEFT JOIN users u
              ON u.id = a.assignee_user_id
            LEFT JOIN incident_submission_links isl
              ON isl.incident_id = i.id
            {where_sql}
            ORDER BY i.created_at DESC, i.id DESC
            """
        ),
        params,
    ).mappings().all()
    return {
        "items": [
            {
                "id": int(r["id"]),
                "title": r["title"],
                "incident_type": r["incident_type"],
                "current_stage": r["current_stage"],
                "status": r["status"],
                "latitude": float(r["latitude"]),
                "longitude": float(r["longitude"]),
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
                "assignee_user_id": int(r["assignee_user_id"]) if r["assignee_user_id"] is not None else None,
                "assignee_name": r["assignee_name"],
                "linked_submission_id": int(r["submission_id"]) if r["submission_id"] is not None else None,
            }
            for r in rows
        ],
        "requested_by_user_id": user["id"],
    }


@router.post("/incidents/{incident_id}/attachments")
async def upload_incident_attachment(
    incident_id: int = Path(..., ge=1),
    file: UploadFile = File(...),
    kind: str = Query(default="PHOTO", max_length=16),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["MAINTENANCE", "FIELD_WORKER", "ADMIN"])),
):
    incident = db.execute(
        text(
            """
            SELECT
              i.id,
              i.reporter_user_id,
              a.assignee_user_id
            FROM incidents i
            LEFT JOIN incident_assignments a
              ON a.incident_id = i.id AND a.is_active = 1
            WHERE i.id = :iid
            LIMIT 1
            """
        ),
        {"iid": incident_id},
    ).mappings().first()
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    user_roles = set(user["roles"])
    if "ADMIN" not in user_roles:
        is_reporter = int(incident["reporter_user_id"]) == int(user["id"])
        is_assignee = incident["assignee_user_id"] is not None and int(incident["assignee_user_id"]) == int(user["id"])
        if not (is_reporter or is_assignee):
            raise HTTPException(status_code=403, detail="Not allowed to attach files to this incident")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")

    mime_type = file.content_type or "application/octet-stream"
    normalized_kind = (kind or "").strip().upper()
    if normalized_kind not in {"PHOTO", "VIDEO", "DOC", "SKETCH"}:
        if mime_type.lower().startswith("image/"):
            normalized_kind = "PHOTO"
        elif mime_type.lower().startswith("video/"):
            normalized_kind = "VIDEO"
        else:
            normalized_kind = "DOC"

    object_key = make_object_key(file.filename or "incident_attachment.bin")
    put_object_bytes(
        object_key=object_key,
        data=content,
        content_type=mime_type,
        bucket=settings.MINIO_BUCKET,
    )
    sha = hashlib.sha256(content).hexdigest()

    try:
        db.execute(
            text(
                """
                INSERT INTO attachments (
                  created_by_user_id, storage_provider, storage_bucket, storage_key,
                  file_name, mime_type, file_size_bytes, sha256, uploaded_at
                ) VALUES (
                  :uid, 'minio', :bucket, :key, :fname, :mime, :size, :sha, NOW()
                )
                """
            ),
            {
                "uid": user["id"],
                "bucket": settings.MINIO_BUCKET,
                "key": object_key,
                "fname": file.filename or "incident_attachment",
                "mime": mime_type,
                "size": len(content),
                "sha": sha,
            },
        )
        attachment_id = int(db.execute(text("SELECT LAST_INSERT_ID()")).scalar())
        next_sort = db.execute(
            text(
                """
                SELECT COALESCE(MAX(sort_order), -1) + 1
                FROM incident_attachments
                WHERE incident_id = :iid
                """
            ),
            {"iid": incident_id},
        ).scalar()
        db.execute(
            text(
                """
                INSERT INTO incident_attachments (incident_id, attachment_id, kind, sort_order)
                VALUES (:iid, :aid, :kind, :sort_order)
                """
            ),
            {
                "iid": incident_id,
                "aid": attachment_id,
                "kind": normalized_kind,
                "sort_order": int(next_sort or 0),
            },
        )
        db.commit()
        return {
            "incident_id": incident_id,
            "attachment_id": attachment_id,
            "kind": normalized_kind,
            "mime_type": mime_type,
        }
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))

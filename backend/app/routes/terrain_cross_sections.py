from __future__ import annotations

import json
import math
import uuid
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import get_current_user

router = APIRouter(prefix="/terrain-cross-sections", tags=["terrain-cross-sections"])


class ProjectCreateRequest(BaseModel):
    project_number: str | None = Field(default=None, max_length=128)
    title: str = Field(min_length=1, max_length=255)
    description: str | None = None
    district: str | None = Field(default=None, max_length=64)

    @field_validator("project_number", "title", "district", mode="before")
    @classmethod
    def trim_text(cls, value: Any):
        if value is None:
            return None
        value = str(value).strip()
        return value or None


class CrossSectionPointRequest(BaseModel):
    latitude: float
    longitude: float
    distance_m: float | None = None
    elevation_m: float | None = None

    @field_validator("latitude")
    @classmethod
    def valid_latitude(cls, value: float) -> float:
        if not math.isfinite(value) or not -90 <= value <= 90:
            raise ValueError("latitude must be finite and between -90 and 90")
        return value

    @field_validator("longitude")
    @classmethod
    def valid_longitude(cls, value: float) -> float:
        if not math.isfinite(value) or not -180 <= value <= 180:
            raise ValueError("longitude must be finite and between -180 and 180")
        return value

    @field_validator("distance_m", "elevation_m")
    @classmethod
    def finite_optional_number(cls, value: float | None) -> float | None:
        if value is not None and not math.isfinite(value):
            raise ValueError("value must be finite")
        return value


class CrossSectionSaveRequest(BaseModel):
    project_id: int = Field(gt=0)
    name: str = Field(min_length=1, max_length=255)
    notes: str | None = None
    preferred_spacing_m: float | None = Field(default=None, gt=0)
    actual_spacing_m: float | None = Field(default=None, gt=0)
    dem_source: str = Field(default="ARCGIS_WORLD_ELEVATION", min_length=1, max_length=128)
    control_points: list[CrossSectionPointRequest] = Field(min_length=2)
    profile_snapshot: dict[str, Any] | None = None

    @field_validator("name", "dem_source", mode="before")
    @classmethod
    def trim_required_text(cls, value: Any):
        value = str(value or "").strip()
        if not value:
            raise ValueError("value is required")
        return value

    @field_validator("notes", mode="before")
    @classmethod
    def trim_optional_text(cls, value: Any):
        if value is None:
            return None
        value = str(value).strip()
        return value or None


class CrossSectionUpdateRequest(CrossSectionSaveRequest):
    pass


def _json_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, (bytes, bytearray)):
        value = value.decode("utf-8")
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return None
    return value


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _project_row(db: Session, project_id: int):
    return db.execute(
        text(
            """
            SELECT
              p.id, p.project_key, p.project_number, p.title, p.description,
              p.district, p.status, p.source_system, p.external_project_id,
              p.last_synced_at, p.created_at, p.updated_at,
              COUNT(cs.id) AS cross_section_count
            FROM caltrans_projects p
            LEFT JOIN terrain_cross_sections cs ON cs.caltrans_project_id = p.id
            WHERE p.id = :pid
            GROUP BY
              p.id, p.project_key, p.project_number, p.title, p.description,
              p.district, p.status, p.source_system, p.external_project_id,
              p.last_synced_at, p.created_at, p.updated_at
            LIMIT 1
            """
        ),
        {"pid": project_id},
    ).mappings().first()


def _serialize_project(row) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "project_key": str(row["project_key"]),
        "project_number": row["project_number"],
        "title": row["title"],
        "description": row["description"],
        "district": row["district"],
        "status": row["status"],
        "source_system": row["source_system"],
        "external_project_id": row["external_project_id"],
        "last_synced_at": _iso(row["last_synced_at"]),
        "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row["updated_at"]),
        "cross_section_count": int(row["cross_section_count"] or 0),
    }


def _cross_section_summary(row) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "cross_section_key": str(row["cross_section_key"]),
        "project_id": int(row["caltrans_project_id"]),
        "name": row["name"],
        "notes": row["notes"],
        "preferred_spacing_m": float(row["preferred_spacing_m"]) if row["preferred_spacing_m"] is not None else None,
        "actual_spacing_m": float(row["actual_spacing_m"]) if row["actual_spacing_m"] is not None else None,
        "dem_source": row["dem_source"],
        "point_count": int(row["point_count"] or 0),
        "created_by_user_id": int(row["created_by_user_id"]),
        "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row["updated_at"]),
    }


def _cross_section_row(db: Session, cross_section_id: int):
    return db.execute(
        text(
            """
            SELECT
              cs.id, cs.cross_section_key, cs.caltrans_project_id,
              cs.name, cs.notes, cs.preferred_spacing_m, cs.actual_spacing_m,
              cs.dem_source, cs.profile_snapshot_json, cs.created_by_user_id,
              cs.created_at, cs.updated_at,
              COUNT(p.id) AS point_count
            FROM terrain_cross_sections cs
            LEFT JOIN terrain_cross_section_points p ON p.cross_section_id = cs.id
            WHERE cs.id = :cid
            GROUP BY
              cs.id, cs.cross_section_key, cs.caltrans_project_id,
              cs.name, cs.notes, cs.preferred_spacing_m, cs.actual_spacing_m,
              cs.dem_source, cs.profile_snapshot_json, cs.created_by_user_id,
              cs.created_at, cs.updated_at
            LIMIT 1
            """
        ),
        {"cid": cross_section_id},
    ).mappings().first()


def _replace_points(db: Session, cross_section_id: int, points: list[CrossSectionPointRequest]) -> None:
    db.execute(
        text("DELETE FROM terrain_cross_section_points WHERE cross_section_id = :cid"),
        {"cid": cross_section_id},
    )
    for index, point in enumerate(points, start=1):
        db.execute(
            text(
                """
                INSERT INTO terrain_cross_section_points (
                  cross_section_id, sequence_number, latitude, longitude,
                  distance_m, elevation_m
                ) VALUES (
                  :cid, :seq, :lat, :lon, :distance_m, :elevation_m
                )
                """
            ),
            {
                "cid": cross_section_id,
                "seq": index,
                "lat": point.latitude,
                "lon": point.longitude,
                "distance_m": point.distance_m,
                "elevation_m": point.elevation_m,
            },
        )


def _serialize_cross_section_detail(db: Session, row) -> dict[str, Any]:
    summary = _cross_section_summary(row)
    points = db.execute(
        text(
            """
            SELECT sequence_number, latitude, longitude, distance_m, elevation_m
            FROM terrain_cross_section_points
            WHERE cross_section_id = :cid
            ORDER BY sequence_number ASC
            """
        ),
        {"cid": row["id"]},
    ).mappings().all()
    project = _project_row(db, int(row["caltrans_project_id"]))
    return {
        **summary,
        "project": _serialize_project(project) if project else None,
        "control_points": [
            {
                "sequence_number": int(point["sequence_number"]),
                "latitude": float(point["latitude"]),
                "longitude": float(point["longitude"]),
                "distance_m": float(point["distance_m"]) if point["distance_m"] is not None else None,
                "elevation_m": float(point["elevation_m"]) if point["elevation_m"] is not None else None,
            }
            for point in points
        ],
        "profile_snapshot": _json_value(row["profile_snapshot_json"]),
    }


@router.get("/projects")
def list_cross_section_projects(
    q: str | None = Query(default=None, max_length=255),
    status_filter: Literal["ACTIVE", "INACTIVE", "ARCHIVED", "ALL"] = Query(default="ACTIVE", alias="status"),
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    where = []
    params: dict[str, Any] = {"limit": limit}
    if status_filter != "ALL":
        where.append("p.status = :status")
        params["status"] = status_filter
    if q and q.strip():
        where.append("(p.project_number LIKE :q OR p.title LIKE :q OR p.external_project_id LIKE :q)")
        params["q"] = f"%{q.strip()}%"
    where_sql = f"WHERE {' AND '.join(where)}" if where else ""
    rows = db.execute(
        text(
            f"""
            SELECT
              p.id, p.project_key, p.project_number, p.title, p.description,
              p.district, p.status, p.source_system, p.external_project_id,
              p.last_synced_at, p.created_at, p.updated_at,
              COUNT(cs.id) AS cross_section_count
            FROM caltrans_projects p
            LEFT JOIN terrain_cross_sections cs ON cs.caltrans_project_id = p.id
            {where_sql}
            GROUP BY
              p.id, p.project_key, p.project_number, p.title, p.description,
              p.district, p.status, p.source_system, p.external_project_id,
              p.last_synced_at, p.created_at, p.updated_at
            ORDER BY
              CASE WHEN p.project_number IS NULL OR p.project_number = '' THEN 1 ELSE 0 END,
              p.project_number ASC,
              p.title ASC
            LIMIT :limit
            """
        ),
        params,
    ).mappings().all()
    return {"items": [_serialize_project(row) for row in rows]}


@router.post("/projects", status_code=201)
def create_manual_cross_section_project(
    payload: ProjectCreateRequest,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    project_key = str(uuid.uuid4())
    result = db.execute(
        text(
            """
            INSERT INTO caltrans_projects (
              project_key, project_number, title, description, district,
              status, source_system, created_by_user_id
            ) VALUES (
              :project_key, :project_number, :title, :description, :district,
              'ACTIVE', 'ERIS_MANUAL', :created_by
            )
            """
        ),
        {
            "project_key": project_key,
            "project_number": payload.project_number,
            "title": payload.title,
            "description": payload.description,
            "district": payload.district,
            "created_by": int(user["id"]),
        },
    )
    project_id = int(result.lastrowid)
    db.commit()
    row = _project_row(db, project_id)
    return {"project": _serialize_project(row)}


@router.get("/projects/{project_id}/cross-sections")
def list_project_cross_sections(
    project_id: int,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    project = _project_row(db, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    rows = db.execute(
        text(
            """
            SELECT
              cs.id, cs.cross_section_key, cs.caltrans_project_id,
              cs.name, cs.notes, cs.preferred_spacing_m, cs.actual_spacing_m,
              cs.dem_source, cs.created_by_user_id, cs.created_at, cs.updated_at,
              COUNT(p.id) AS point_count
            FROM terrain_cross_sections cs
            LEFT JOIN terrain_cross_section_points p ON p.cross_section_id = cs.id
            WHERE cs.caltrans_project_id = :pid
            GROUP BY
              cs.id, cs.cross_section_key, cs.caltrans_project_id,
              cs.name, cs.notes, cs.preferred_spacing_m, cs.actual_spacing_m,
              cs.dem_source, cs.created_by_user_id, cs.created_at, cs.updated_at
            ORDER BY cs.updated_at DESC, cs.id DESC
            """
        ),
        {"pid": project_id},
    ).mappings().all()
    return {
        "project": _serialize_project(project),
        "items": [_cross_section_summary(row) for row in rows],
    }


@router.get("/{cross_section_id}")
def get_cross_section(
    cross_section_id: int,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    row = _cross_section_row(db, cross_section_id)
    if not row:
        raise HTTPException(status_code=404, detail="Cross section not found")
    return {"cross_section": _serialize_cross_section_detail(db, row)}


@router.post("", status_code=201)
def create_cross_section(
    payload: CrossSectionSaveRequest,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    project = _project_row(db, payload.project_id)
    if not project or project["status"] != "ACTIVE":
        raise HTTPException(status_code=422, detail="Select an active Project")

    key = str(uuid.uuid4())
    result = db.execute(
        text(
            """
            INSERT INTO terrain_cross_sections (
              cross_section_key, caltrans_project_id, name, notes,
              preferred_spacing_m, actual_spacing_m, dem_source,
              profile_snapshot_json, created_by_user_id
            ) VALUES (
              :key, :project_id, :name, :notes,
              :preferred_spacing_m, :actual_spacing_m, :dem_source,
              :profile_snapshot_json, :created_by
            )
            """
        ),
        {
            "key": key,
            "project_id": payload.project_id,
            "name": payload.name,
            "notes": payload.notes,
            "preferred_spacing_m": payload.preferred_spacing_m,
            "actual_spacing_m": payload.actual_spacing_m,
            "dem_source": payload.dem_source,
            "profile_snapshot_json": json.dumps(payload.profile_snapshot, separators=(",", ":")) if payload.profile_snapshot is not None else None,
            "created_by": int(user["id"]),
        },
    )
    cross_section_id = int(result.lastrowid)
    _replace_points(db, cross_section_id, payload.control_points)
    db.commit()
    row = _cross_section_row(db, cross_section_id)
    return {"cross_section": _serialize_cross_section_detail(db, row)}


@router.put("/{cross_section_id}")
def update_cross_section(
    cross_section_id: int,
    payload: CrossSectionUpdateRequest,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    existing = _cross_section_row(db, cross_section_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Cross section not found")
    project = _project_row(db, payload.project_id)
    if not project or project["status"] != "ACTIVE":
        raise HTTPException(status_code=422, detail="Select an active Project")

    db.execute(
        text(
            """
            UPDATE terrain_cross_sections
            SET caltrans_project_id = :project_id,
                name = :name,
                notes = :notes,
                preferred_spacing_m = :preferred_spacing_m,
                actual_spacing_m = :actual_spacing_m,
                dem_source = :dem_source,
                profile_snapshot_json = :profile_snapshot_json
            WHERE id = :cid
            """
        ),
        {
            "cid": cross_section_id,
            "project_id": payload.project_id,
            "name": payload.name,
            "notes": payload.notes,
            "preferred_spacing_m": payload.preferred_spacing_m,
            "actual_spacing_m": payload.actual_spacing_m,
            "dem_source": payload.dem_source,
            "profile_snapshot_json": json.dumps(payload.profile_snapshot, separators=(",", ":")) if payload.profile_snapshot is not None else None,
        },
    )
    _replace_points(db, cross_section_id, payload.control_points)
    db.commit()
    row = _cross_section_row(db, cross_section_id)
    return {"cross_section": _serialize_cross_section_detail(db, row)}

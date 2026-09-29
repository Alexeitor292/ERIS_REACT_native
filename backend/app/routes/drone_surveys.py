"""Drone surveys on a technical form (``submission_drone_surveys``).

The browser reads the drone's elevation GeoTIFF and orthomosaic, and sends:

* ``patch``: the elevation over the captured area as a longitude/latitude grid,
  in the ERIS patch format (``ERISDSM1``: magic, header length, JSON header
  with the bounds and size, then row-major little-endian float32 heights in
  metres, north row first, NaN where the drone saw nothing);
* ``overlay`` (optional): the orthomosaic as an image, with its four corners;
* ``meta``: a JSON object with the label, flight date, source, file names, the
  source coordinate system, resolution, the offset and stats.

* ``GET  /submissions/{id}/drone-surveys`` — the form's surveys.
* ``POST /submissions/{id}/drone-surveys`` — add one (multipart).
* ``GET  /submissions/{id}/drone-surveys/{sid}/patch`` and ``/overlay`` — the files.
* ``PATCH /submissions/{id}/drone-surveys/{sid}`` — label, date, vertical
  offset, the before/after comparison and the captured points.
* ``DELETE /submissions/{id}/drone-surveys/{sid}``.
"""
from __future__ import annotations

import json
import math
import struct
from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Path, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import deny_public_only, require_roles
from ..roles import GISA_AUTHOR_ROLES
from ..storage import get_object_bytes, make_object_key, put_object_bytes, remove_object_quietly

router = APIRouter(tags=["drone-surveys"])

MAGIC = b"ERISDSM1"
MAX_PATCH_BYTES = 24 * 1024 * 1024
MAX_OVERLAY_BYTES = 30 * 1024 * 1024
MAX_CELLS_PER_SIDE = 2048
MAX_SPAN_DEG = 0.1  # about 10 km: a site, not a county
OVERLAY_TYPES = {"image/webp", "image/png", "image/jpeg"}


def parse_patch_header(data: bytes) -> dict:
    """Validate an ERIS patch and return its header (bounds and size)."""
    if len(data) < 12 or data[:8] != MAGIC:
        raise HTTPException(status_code=422, detail="Not an ERIS elevation patch")
    (header_len,) = struct.unpack("<I", data[8:12])
    if header_len > 4096 or 12 + header_len > len(data):
        raise HTTPException(status_code=422, detail="Damaged elevation patch header")
    try:
        header = json.loads(data[12:12 + header_len].decode("utf-8"))
        west, south, east, north = (float(header[k]) for k in ("west", "south", "east", "north"))
        cols, rows = int(header["cols"]), int(header["rows"])
    except (ValueError, KeyError, TypeError):
        raise HTTPException(status_code=422, detail="Damaged elevation patch header")
    finite = all(math.isfinite(v) for v in (west, south, east, north))
    if not finite or not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise HTTPException(status_code=422, detail="The patch bounds are not longitude/latitude")
    if east - west > MAX_SPAN_DEG or north - south > MAX_SPAN_DEG:
        raise HTTPException(status_code=422, detail="The patch covers more than a site (over about 10 km across)")
    if not (2 <= cols <= MAX_CELLS_PER_SIDE and 2 <= rows <= MAX_CELLS_PER_SIDE):
        raise HTTPException(status_code=422, detail="The patch grid size is out of range")
    if len(data) != 12 + header_len + cols * rows * 4:
        raise HTTPException(status_code=422, detail="The patch size does not match its header")
    return {"west": west, "south": south, "east": east, "north": north, "cols": cols, "rows": rows}


class SurveyMeta(BaseModel):
    label: str | None = Field(default=None, max_length=160)
    source: str | None = Field(default=None, max_length=64)
    captured_on: date | None = None
    dsm_filename: str | None = Field(default=None, max_length=255)
    ortho_filename: str | None = Field(default=None, max_length=255)
    dsm_attachment_id: int | None = Field(default=None, ge=1)
    ortho_attachment_id: int | None = Field(default=None, ge=1)
    source_crs: str | None = Field(default=None, max_length=64)
    resolution_m: float | None = Field(default=None, gt=0, le=100)
    vertical_offset_m: float = Field(default=0.0, ge=-5000, le=5000)
    offset_mode: str = Field(default="AUTO", pattern="^(AUTO|MANUAL|NONE)$")
    overlay_corners: list[list[float]] | None = None
    stats: dict[str, Any] | None = None


class SurveyPatch(BaseModel):
    label: str | None = Field(default=None, max_length=160)
    captured_on: date | None = None
    vertical_offset_m: float | None = Field(default=None, ge=-5000, le=5000)
    offset_mode: str | None = Field(default=None, pattern="^(AUTO|MANUAL|NONE)$")
    comparison: dict[str, Any] | None = None
    points: list[dict[str, Any]] | None = Field(default=None, max_length=500)
    # How well the heights agree with the terrain model on stable ground, after lining them up again.
    alignment_spread_m: float | None = Field(default=None, ge=0, le=1000)
    alignment_points: int | None = Field(default=None, ge=0, le=100_000)


def _corners(value: list[list[float]] | None) -> list[list[float]] | None:
    if value is None:
        return None
    if len(value) != 4 or any(len(p) != 2 or not all(math.isfinite(float(v)) for v in p) for p in value):
        raise HTTPException(status_code=422, detail="The orthomosaic needs its four corners as [longitude, latitude]")
    if any(not (-180 <= p[0] <= 180 and -90 <= p[1] <= 90) for p in value):
        raise HTTPException(status_code=422, detail="The orthomosaic corners are not longitude/latitude")
    return [[float(p[0]), float(p[1])] for p in value]


def _json(value) -> Any:
    if value is None:
        return None
    return json.loads(value) if isinstance(value, (str, bytes)) else value


def _survey(row) -> dict:
    return {
        "id": int(row["id"]),
        "label": row["label"],
        "source": row["source"],
        "captured_on": row["captured_on"].isoformat() if row["captured_on"] else None,
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "created_by": row.get("created_by_name"),
        "dsm_filename": row["dsm_filename"],
        "ortho_filename": row["ortho_filename"],
        "dsm_attachment_id": row["dsm_attachment_id"],
        "ortho_attachment_id": row["ortho_attachment_id"],
        "source_crs": row["source_crs"],
        "bounds": {"west": row["west"], "south": row["south"], "east": row["east"], "north": row["north"]},
        "cols": int(row["cols"]),
        "rows": int(row["grid_rows"]),
        "resolution_m": row["resolution_m"],
        "patch_size_bytes": int(row["patch_size_bytes"]),
        "has_overlay": bool(row["overlay_object_key"]),
        "overlay_corners": _json(row["overlay_corners_json"]),
        "vertical_offset_m": float(row["vertical_offset_m"]),
        "offset_mode": row["offset_mode"],
        "stats": _json(row["stats_json"]),
        "comparison": _json(row["comparison_json"]),
        "points": _json(row["points_json"]) or [],
    }


def _row(db: Session, submission_id: int, survey_id: int) -> dict:
    row = db.execute(
        text(
            """
            SELECT s.*, u.full_name AS created_by_name FROM submission_drone_surveys s
              LEFT JOIN users u ON u.id = s.created_by_user_id
             WHERE s.id = :id AND s.submission_id = :sid
            """
        ),
        {"id": int(survey_id), "sid": int(submission_id)},
    ).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Drone survey not found")
    return dict(row)


def _can_view(submission_id: int, db: Session, user: dict) -> None:
    from ..main import require_can_view_submission  # the app module imports this router

    require_can_view_submission(submission_id, db, user)


def _can_edit(submission_id: int, db: Session, user: dict) -> None:
    from ..main import require_can_edit_submission

    require_can_edit_submission(submission_id, db, user)


@router.get("/submissions/{submission_id}/drone-surveys")
def list_surveys(submission_id: int = Path(..., ge=1), db: Session = Depends(get_db), user=Depends(deny_public_only)) -> dict:
    _can_view(submission_id, db, user)
    rows = db.execute(
        text(
            """
            SELECT s.*, u.full_name AS created_by_name FROM submission_drone_surveys s
              LEFT JOIN users u ON u.id = s.created_by_user_id
             WHERE s.submission_id = :sid ORDER BY COALESCE(s.captured_on, DATE(s.created_at)) DESC, s.id DESC
            """
        ),
        {"sid": int(submission_id)},
    ).mappings().all()
    return {"items": [_survey(dict(r)) for r in rows]}


@router.post("/submissions/{submission_id}/drone-surveys", status_code=201)
async def create_survey(
    submission_id: int = Path(..., ge=1),
    meta: str = Form(...),
    patch: UploadFile = File(...),
    overlay: UploadFile | None = File(default=None),
    db: Session = Depends(get_db),
    user=Depends(require_roles(GISA_AUTHOR_ROLES)),
) -> dict:
    _can_edit(submission_id, db, user)
    try:
        info = SurveyMeta.model_validate(json.loads(meta))
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Survey details are not valid: {exc}")
    data = await patch.read()
    if len(data) > MAX_PATCH_BYTES:
        raise HTTPException(status_code=413, detail="The elevation patch is too large")
    header = parse_patch_header(data)
    corners = _corners(info.overlay_corners)
    overlay_bytes, overlay_mime = None, None
    if overlay is not None:
        overlay_mime = (overlay.content_type or "").lower()
        if overlay_mime not in OVERLAY_TYPES:
            raise HTTPException(status_code=422, detail="The orthomosaic image must be WebP, PNG or JPEG")
        overlay_bytes = await overlay.read()
        if len(overlay_bytes) > MAX_OVERLAY_BYTES:
            raise HTTPException(status_code=413, detail="The orthomosaic image is too large")
        if corners is None:
            raise HTTPException(status_code=422, detail="The orthomosaic needs its four corners")

    patch_key = make_object_key("drone-patch.bin")
    put_object_bytes(object_key=patch_key, data=data, content_type="application/octet-stream", bucket=settings.MINIO_BUCKET)
    overlay_key = None
    if overlay_bytes is not None:
        overlay_key = make_object_key("drone-ortho." + overlay_mime.split("/")[1])
        put_object_bytes(object_key=overlay_key, data=overlay_bytes, content_type=overlay_mime, bucket=settings.MINIO_BUCKET)

    result = db.execute(
        text(
            """
            INSERT INTO submission_drone_surveys (
              submission_id, label, source, captured_on, created_by_user_id, dsm_filename, ortho_filename,
              dsm_attachment_id, ortho_attachment_id, source_crs, west, south, east, north, cols, grid_rows,
              resolution_m, patch_object_key, patch_size_bytes, overlay_object_key, overlay_mime, overlay_corners_json,
              vertical_offset_m, offset_mode, stats_json)
            VALUES (
              :sid, :label, :source, :captured_on, :uid, :dsm_filename, :ortho_filename,
              :dsm_att, :ortho_att, :crs, :west, :south, :east, :north, :cols, :rows,
              :res, :patch_key, :patch_size, :overlay_key, :overlay_mime, :corners,
              :offset, :offset_mode, :stats)
            """
        ),
        {
            "sid": int(submission_id), "label": (info.label or "").strip() or None, "source": (info.source or "").strip() or None,
            "captured_on": info.captured_on, "uid": int(user["id"]),
            "dsm_filename": info.dsm_filename, "ortho_filename": info.ortho_filename,
            "dsm_att": info.dsm_attachment_id, "ortho_att": info.ortho_attachment_id, "crs": info.source_crs,
            **header, "res": info.resolution_m, "patch_key": patch_key, "patch_size": len(data),
            "overlay_key": overlay_key, "overlay_mime": overlay_mime if overlay_key else None,
            "corners": json.dumps(corners) if corners and overlay_key else None,
            "offset": info.vertical_offset_m, "offset_mode": info.offset_mode,
            "stats": json.dumps(info.stats) if info.stats else None,
        },
    )
    db.commit()
    return _survey(_row(db, submission_id, int(result.lastrowid)))


@router.get("/submissions/{submission_id}/drone-surveys/{survey_id}/patch")
def get_patch(
    submission_id: int = Path(..., ge=1), survey_id: int = Path(..., ge=1), db: Session = Depends(get_db), user=Depends(deny_public_only)
) -> Response:
    _can_view(submission_id, db, user)
    row = _row(db, submission_id, survey_id)
    data, _ = get_object_bytes(object_key=row["patch_object_key"], bucket=settings.MINIO_BUCKET)
    return Response(content=data, media_type="application/octet-stream", headers={"Cache-Control": "private, max-age=86400"})


@router.get("/submissions/{submission_id}/drone-surveys/{survey_id}/overlay")
def get_overlay(
    submission_id: int = Path(..., ge=1), survey_id: int = Path(..., ge=1), db: Session = Depends(get_db), user=Depends(deny_public_only)
) -> Response:
    _can_view(submission_id, db, user)
    row = _row(db, submission_id, survey_id)
    if not row["overlay_object_key"]:
        raise HTTPException(status_code=404, detail="This survey has no orthomosaic")
    data, _ = get_object_bytes(object_key=row["overlay_object_key"], bucket=settings.MINIO_BUCKET)
    return Response(content=data, media_type=row["overlay_mime"] or "image/webp", headers={"Cache-Control": "private, max-age=86400"})


@router.patch("/submissions/{submission_id}/drone-surveys/{survey_id}")
def update_survey(
    payload: SurveyPatch,
    submission_id: int = Path(..., ge=1),
    survey_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(GISA_AUTHOR_ROLES)),
) -> dict:
    _can_edit(submission_id, db, user)
    current = _row(db, submission_id, survey_id)
    provided = payload.model_dump(exclude_unset=True)
    sets, params = [], {"id": int(survey_id)}
    if "label" in provided:
        sets.append("label = :label")
        params["label"] = (payload.label or "").strip() or None
    if "captured_on" in provided:
        sets.append("captured_on = :captured_on")
        params["captured_on"] = payload.captured_on
    if "vertical_offset_m" in provided and payload.vertical_offset_m is not None:
        sets.append("vertical_offset_m = :offset")
        params["offset"] = payload.vertical_offset_m
    if "offset_mode" in provided and payload.offset_mode:
        sets.append("offset_mode = :offset_mode")
        params["offset_mode"] = payload.offset_mode
    if "comparison" in provided:
        blob = json.dumps(payload.comparison) if payload.comparison is not None else None
        if blob and len(blob) > 200_000:
            raise HTTPException(status_code=413, detail="The comparison is too large to save")
        sets.append("comparison_json = :comparison")
        params["comparison"] = blob
    if "points" in provided:
        sets.append("points_json = :points")
        params["points"] = json.dumps(payload.points or [])
    if "alignment_spread_m" in provided or "alignment_points" in provided:
        stats = _json(current["stats_json"]) or {}
        if "alignment_spread_m" in provided:
            stats["alignment_spread_m"] = payload.alignment_spread_m
        if "alignment_points" in provided:
            stats["alignment_points"] = payload.alignment_points
        sets.append("stats_json = :stats")
        params["stats"] = json.dumps(stats)
    if sets:
        db.execute(text(f"UPDATE submission_drone_surveys SET {', '.join(sets)} WHERE id = :id"), params)
        db.commit()
    return _survey(_row(db, submission_id, survey_id))


@router.delete("/submissions/{submission_id}/drone-surveys/{survey_id}")
def delete_survey(
    submission_id: int = Path(..., ge=1), survey_id: int = Path(..., ge=1), db: Session = Depends(get_db), user=Depends(require_roles(GISA_AUTHOR_ROLES))
) -> dict:
    _can_edit(submission_id, db, user)
    row = _row(db, submission_id, survey_id)
    db.execute(text("DELETE FROM submission_drone_surveys WHERE id = :id"), {"id": int(survey_id)})
    db.commit()
    # The patch and image go with it; the original files stay attachments of the form.
    remove_object_quietly(object_key=row["patch_object_key"], bucket=settings.MINIO_BUCKET)
    if row["overlay_object_key"]:
        remove_object_quietly(object_key=row["overlay_object_key"], bucket=settings.MINIO_BUCKET)
    return {"deleted": int(survey_id)}

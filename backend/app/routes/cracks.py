"""Pavement/ground cracks on a technical form (``submission_gisa_cracks``).

GISA-001 asks to "map cracks": each crack's location, length, width, horizontal
and vertical displacement, depth and direction. Every crack is its own record
with the same fields, its own photo (an ordinary PHOTO attachment of the form,
so it is also on the Site Photo Map) and the labels drawn on that photo.

* ``GET    /submissions/{id}/cracks`` — the form's cracks, in order (also
  included as ``cracks`` in ``GET /submissions/{id}``).
* ``POST   /submissions/{id}/cracks`` — add one. ``client_uuid`` is made by the
  client: sending the same one again returns the crack already made.
* ``PATCH  /submissions/{id}/cracks/{crack_id}`` — change one. ``revision`` is
  the one the client last read; if someone saved since, 409 with their crack.
* ``DELETE /submissions/{id}/cracks/{crack_id}`` — its photo stays on the form.

Editing follows the form: those who may edit it, while it is a draft or
returned. Reading follows the form record, so a read-only viewer sees the
cracks of an approved, public assessment.
"""
from __future__ import annotations

import json
import math
import re
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Path
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import get_current_user, require_roles
from ..roles import GISA_AUTHOR_ROLES

router = APIRouter(tags=["cracks"])

MEASURES = ("length_ft", "width_in", "horizontal_disp_in", "vertical_disp_in", "depth_in")
ORIENTATIONS = ("LONGITUDINAL", "TRANSVERSE", "DIAGONAL", "ARCUATE", "OTHER")
LOCATION_SOURCES = ("PHOTO", "MAP", "MANUAL")
SHAPE_TYPES = ("path", "arrow", "label")
EDITABLE = (
    "label", "latitude", "longitude", "location_source", "geometry_json", "trend_deg", "orientation",
    *MEASURES, "notes", "photo_attachment_id", "annotations_json", "sort_order",
)
MAX_MEASURE = 100_000.0
MAX_SHAPES = 200
MAX_POINTS_PER_SHAPE = 500
MAX_ANNOTATIONS_BYTES = 64 * 1024
MAX_GEOMETRY_POINTS = 2_000
_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def _bad(detail: str) -> HTTPException:
    return HTTPException(status_code=422, detail=detail)


def _number(value: Any, name: str, *, minimum: float, maximum: float, below: bool = False) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise _bad(f"{name} must be a number")
    try:
        out = float(value)
    except (TypeError, ValueError):
        raise _bad(f"{name} must be a number")
    if not math.isfinite(out) or out < minimum or (out >= maximum if below else out > maximum):
        bound = f"less than {maximum:g}" if below else f"at most {maximum:g}"
        raise _bad(f"{name} must be from {minimum:g} to {bound}")
    return out


def _point(value: Any, name: str) -> list[float]:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise _bad(f"{name} must be an [x, y] pair")
    return [_number(value[0], name, minimum=0, maximum=1), _number(value[1], name, minimum=0, maximum=1)]  # type: ignore[list-item]


def normalize_annotations(raw: Any) -> dict | None:
    """The shapes drawn over a crack's photo, checked and stripped to known keys.

    Points are fractions of the photo's width and height (0..1, origin top
    left), so the drawing lines up at any size. A shape may name the measure it
    shows (``measure``), so a label follows the value when the value changes.
    """
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise _bad("annotations_json must be an object")
    shapes = raw.get("shapes") or []
    if not isinstance(shapes, list) or len(shapes) > MAX_SHAPES:
        raise _bad(f"annotations_json.shapes must be a list of at most {MAX_SHAPES} shapes")
    out_shapes = []
    for index, shape in enumerate(shapes):
        where = f"annotations_json.shapes[{index}]"
        if not isinstance(shape, dict) or shape.get("type") not in SHAPE_TYPES:
            raise _bad(f"{where}.type must be one of {', '.join(SHAPE_TYPES)}")
        clean: dict[str, Any] = {"type": shape["type"]}
        if shape["type"] in ("path", "arrow"):
            points = shape.get("points")
            if not isinstance(points, list) or not 2 <= len(points) <= MAX_POINTS_PER_SHAPE:
                raise _bad(f"{where}.points must hold 2 to {MAX_POINTS_PER_SHAPE} points")
            clean["points"] = [_point(p, f"{where}.points") for p in points]
        if shape["type"] == "label":
            clean["at"] = _point(shape.get("at"), f"{where}.at")
            label_text = shape.get("text")
            if label_text is not None and (not isinstance(label_text, str) or len(label_text) > 200):
                raise _bad(f"{where}.text must be text of at most 200 characters")
            clean["text"] = label_text
        measure = shape.get("measure")
        if measure is not None:
            if measure not in MEASURES:
                raise _bad(f"{where}.measure must be one of {', '.join(MEASURES)}")
            clean["measure"] = measure
        color = shape.get("color")
        if color is not None:
            if not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
                raise _bad(f"{where}.color must be #RRGGBB")
            clean["color"] = color
        out_shapes.append(clean)
    out = {"version": 1, "shapes": out_shapes}
    if len(json.dumps(out, separators=(",", ":"))) > MAX_ANNOTATIONS_BYTES:
        raise _bad("annotations_json is too large")
    return out


def normalize_geometry(raw: Any) -> dict | None:
    """A crack's mapped trace: a GeoJSON Point or LineString in longitude/latitude."""
    if raw is None:
        return None
    if not isinstance(raw, dict) or raw.get("type") not in ("Point", "LineString"):
        raise _bad("geometry_json must be a GeoJSON Point or LineString")
    coordinates = raw.get("coordinates")
    positions = [coordinates] if raw["type"] == "Point" else coordinates
    if not isinstance(positions, list) or not positions or len(positions) > MAX_GEOMETRY_POINTS:
        raise _bad("geometry_json has no usable coordinates")
    if raw["type"] == "LineString" and len(positions) < 2:
        raise _bad("A LineString needs at least two positions")
    clean = []
    for position in positions:
        if not isinstance(position, (list, tuple)) or len(position) < 2:
            raise _bad("geometry_json positions must be [longitude, latitude]")
        lon = _number(position[0], "longitude", minimum=-180, maximum=180)
        lat = _number(position[1], "latitude", minimum=-90, maximum=90)
        clean.append([lon, lat])
    return {"type": "Point", "coordinates": clean[0]} if raw["type"] == "Point" else {"type": "LineString", "coordinates": clean}


def normalize_fields(raw: dict) -> dict:
    """The editable fields present in ``raw``, checked and normalised."""
    unknown = sorted(set(raw) - set(EDITABLE) - {"client_uuid", "revision"})
    if unknown:
        raise _bad(f"Unknown crack fields: {', '.join(unknown)}")
    out: dict[str, Any] = {}
    if "label" in raw:
        label = raw["label"]
        if label is not None and (not isinstance(label, str) or len(label.strip()) > 80):
            raise _bad("label must be text of at most 80 characters")
        out["label"] = (label or "").strip() or None
    if "notes" in raw:
        notes = raw["notes"]
        if notes is not None and (not isinstance(notes, str) or len(notes) > 10_000):
            raise _bad("notes must be text of at most 10000 characters")
        out["notes"] = (notes or "").strip() or None
    for name in MEASURES:
        if name in raw:
            out[name] = _number(raw[name], name, minimum=0, maximum=MAX_MEASURE)
    if "latitude" in raw or "longitude" in raw:
        lat = _number(raw.get("latitude"), "latitude", minimum=-90, maximum=90)
        lon = _number(raw.get("longitude"), "longitude", minimum=-180, maximum=180)
        if (lat is None) != (lon is None):
            raise _bad("latitude and longitude go together")
        out["latitude"], out["longitude"] = lat, lon
    if "location_source" in raw:
        source = raw["location_source"]
        if source is not None and source not in LOCATION_SOURCES:
            raise _bad(f"location_source must be one of {', '.join(LOCATION_SOURCES)}")
        out["location_source"] = source
    if "trend_deg" in raw:
        trend = _number(raw["trend_deg"], "trend_deg", minimum=0, maximum=360, below=True)
        # A crack line runs both ways: 200° is the same line as 20°.
        out["trend_deg"] = None if trend is None else round(trend % 180, 1) % 180
    if "orientation" in raw:
        orientation = raw["orientation"]
        if orientation is not None and orientation not in ORIENTATIONS:
            raise _bad(f"orientation must be one of {', '.join(ORIENTATIONS)}")
        out["orientation"] = orientation
    if "geometry_json" in raw:
        out["geometry_json"] = normalize_geometry(raw["geometry_json"])
    if "annotations_json" in raw:
        out["annotations_json"] = normalize_annotations(raw["annotations_json"])
    if "photo_attachment_id" in raw:
        photo = raw["photo_attachment_id"]
        if photo is not None and (isinstance(photo, bool) or not isinstance(photo, int) or photo < 1):
            raise _bad("photo_attachment_id must be an attachment id")
        out["photo_attachment_id"] = photo
    if "sort_order" in raw:
        order = raw["sort_order"]
        if isinstance(order, bool) or not isinstance(order, int) or not 1 <= order <= 10_000:
            raise _bad("sort_order must be a whole number from 1")
        out["sort_order"] = order
    return out


def _json(value: Any) -> Any:
    if isinstance(value, (bytes, str)):
        try:
            return json.loads(value)
        except ValueError:
            return None
    return value


def serialize(row: dict) -> dict:
    out = {
        "id": int(row["id"]),
        "submission_id": int(row["submission_id"]),
        "client_uuid": row["client_uuid"],
        "sort_order": int(row["sort_order"]),
        "label": row["label"],
        "location_source": row["location_source"],
        "orientation": row["orientation"],
        "notes": row["notes"],
        "photo_attachment_id": int(row["photo_attachment_id"]) if row["photo_attachment_id"] is not None else None,
        "geometry_json": _json(row["geometry_json"]),
        "annotations_json": _json(row["annotations_json"]),
        "revision": int(row["revision"]),
        "created_by_user_id": int(row["created_by_user_id"]),
        "created_by_name": row.get("created_by_name"),
        "updated_by_user_id": int(row["updated_by_user_id"]) if row["updated_by_user_id"] is not None else None,
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
    }
    for name in ("latitude", "longitude", "trend_deg", *MEASURES):
        out[name] = float(row[name]) if row[name] is not None else None
    return out


_SELECT = """
    SELECT c.*, u.full_name AS created_by_name
    FROM submission_gisa_cracks c
    LEFT JOIN users u ON u.id = c.created_by_user_id
"""


def list_cracks(db: Session, submission_id: int) -> list[dict]:
    rows = db.execute(
        text(_SELECT + " WHERE c.submission_id = :sid ORDER BY c.sort_order, c.id"), {"sid": int(submission_id)}
    ).mappings().all()
    return [serialize(dict(row)) for row in rows]


def _crack(db: Session, submission_id: int, crack_id: int) -> dict:
    row = db.execute(
        text(_SELECT + " WHERE c.id = :id AND c.submission_id = :sid"), {"id": int(crack_id), "sid": int(submission_id)}
    ).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Crack not found")
    return dict(row)


def _require_editable(db: Session, submission_id: int, user: dict) -> None:
    from ..main import get_submission_status, require_can_edit_submission  # the app module imports this router

    require_can_edit_submission(submission_id, db, user)
    if get_submission_status(db, submission_id) not in {"DRAFT", "REJECTED"}:
        raise HTTPException(status_code=409, detail="Only DRAFT or REJECTED submissions can be edited")


def _require_form_photo(db: Session, submission_id: int, attachment_id: int | None) -> None:
    if attachment_id is None:
        return
    found = db.execute(text("""
        SELECT 1 FROM attachment_links
        WHERE submission_id = :sid AND attachment_id = :aid AND kind = 'PHOTO' LIMIT 1
    """), {"sid": int(submission_id), "aid": int(attachment_id)}).first()
    if not found:
        raise _bad("photo_attachment_id must be a photo of this form")


def _mark_cracks_present(db: Session, submission_id: int, user: dict) -> None:
    """A recorded crack answers "Pavement/Ground Cracks" with Yes."""
    updated = db.execute(text("""
        UPDATE submission_gisa
        SET pavement_ground_cracks = 1, updated_by_user_id = :uid, revision = revision + 1
        WHERE submission_id = :sid AND pavement_ground_cracks <> 1
    """), {"sid": int(submission_id), "uid": int(user["id"])})
    if updated.rowcount:
        return
    exists = db.execute(text("SELECT 1 FROM submission_gisa WHERE submission_id = :sid"), {"sid": int(submission_id)}).first()
    if not exists:
        db.execute(text("""
            INSERT INTO submission_gisa (submission_id, pavement_ground_cracks, updated_by_user_id, revision)
            VALUES (:sid, 1, :uid, 1)
        """), {"sid": int(submission_id), "uid": int(user["id"])})


def _db_value(name: str, value: Any) -> Any:
    return json.dumps(value, separators=(",", ":")) if name in ("geometry_json", "annotations_json") and value is not None else value


@router.get("/submissions/{submission_id}/cracks")
def get_cracks(submission_id: int = Path(..., ge=1), db: Session = Depends(get_db), user=Depends(get_current_user)) -> dict:
    from ..main import require_can_read_submission_record

    require_can_read_submission_record(submission_id, db, user)
    return {"items": list_cracks(db, submission_id)}


@router.post("/submissions/{submission_id}/cracks", status_code=201)
def create_crack(
    submission_id: int = Path(..., ge=1),
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    user=Depends(require_roles(GISA_AUTHOR_ROLES)),
) -> dict:
    _require_editable(db, submission_id, user)
    client_uuid = str(payload.get("client_uuid") or "").strip()
    if not _UUID_RE.fullmatch(client_uuid):
        raise _bad("client_uuid must be a UUID made by the client")
    client_uuid = client_uuid.lower()
    existing = db.execute(text(_SELECT + " WHERE c.client_uuid = :uuid"), {"uuid": client_uuid}).mappings().first()
    if existing:
        if int(existing["submission_id"]) != int(submission_id):
            raise HTTPException(status_code=409, detail="client_uuid already names a crack on another form")
        return {"crack": serialize(dict(existing)), "idempotent_replay": True}

    fields = normalize_fields(payload)
    _require_form_photo(db, submission_id, fields.get("photo_attachment_id"))
    if "sort_order" not in fields:
        fields["sort_order"] = int(db.execute(text(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM submission_gisa_cracks WHERE submission_id = :sid"
        ), {"sid": int(submission_id)}).scalar())
    columns = ["submission_id", "client_uuid", "created_by_user_id", "updated_by_user_id", *fields]
    params = {"submission_id": int(submission_id), "client_uuid": client_uuid,
              "created_by_user_id": int(user["id"]), "updated_by_user_id": int(user["id"]),
              **{name: _db_value(name, value) for name, value in fields.items()}}
    try:
        result = db.execute(text(
            f"INSERT INTO submission_gisa_cracks ({', '.join(columns)}) VALUES ({', '.join(':' + c for c in columns)})"
        ), params)
        _mark_cracks_present(db, submission_id, user)
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {"crack": serialize(_crack(db, submission_id, int(result.lastrowid))), "idempotent_replay": False}


@router.patch("/submissions/{submission_id}/cracks/{crack_id}")
def update_crack(
    submission_id: int = Path(..., ge=1),
    crack_id: int = Path(..., ge=1),
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    user=Depends(require_roles(GISA_AUTHOR_ROLES)),
) -> dict:
    _require_editable(db, submission_id, user)
    revision = payload.get("revision")
    if isinstance(revision, bool) or not isinstance(revision, int):
        raise _bad("revision is required: the crack's revision when it was read")
    fields = normalize_fields({key: value for key, value in payload.items() if key != "revision"})
    _require_form_photo(db, submission_id, fields.get("photo_attachment_id"))
    current = _crack(db, submission_id, crack_id)
    if not fields:
        return {"crack": serialize(current)}
    sets = [f"{name} = :{name}" for name in fields] + ["revision = revision + 1", "updated_by_user_id = :uid"]
    params = {name: _db_value(name, value) for name, value in fields.items()}
    params.update({"id": int(crack_id), "sid": int(submission_id), "rev": revision, "uid": int(user["id"])})
    try:
        changed = db.execute(text(
            f"UPDATE submission_gisa_cracks SET {', '.join(sets)} "
            "WHERE id = :id AND submission_id = :sid AND revision = :rev"
        ), params).rowcount
        if not changed:
            db.rollback()
            raise HTTPException(status_code=409, detail={
                "message": "Someone else saved this crack after you opened it.",
                "crack": serialize(_crack(db, submission_id, crack_id)),
            })
        db.commit()
    except HTTPException:
        raise
    except Exception:
        db.rollback()
        raise
    return {"crack": serialize(_crack(db, submission_id, crack_id))}


@router.delete("/submissions/{submission_id}/cracks/{crack_id}")
def delete_crack(
    submission_id: int = Path(..., ge=1),
    crack_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(GISA_AUTHOR_ROLES)),
) -> dict:
    _require_editable(db, submission_id, user)
    _crack(db, submission_id, crack_id)
    db.execute(text("DELETE FROM submission_gisa_cracks WHERE id = :id AND submission_id = :sid"),
               {"id": int(crack_id), "sid": int(submission_id)})
    db.commit()
    # The photo is an ordinary form photo and stays; "Pavement/Ground Cracks"
    # keeps its answer, which the person may still mean.
    return {"deleted": int(crack_id)}

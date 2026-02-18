import logging
import json
from typing import Literal

from fastapi import FastAPI, Depends, HTTPException, Path, status, Response, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy import text

from .db import SessionLocal, get_db
from .config import settings
from .auth import verify_password, create_access_token, decode_token
from .deps import get_current_user, require_roles
from .storage import ensure_bucket, make_object_key, put_object_stream, presign_get, get_object_bytes
from .seed import seed_admin
from .dev_routes import router as dev_router
from .admin_users import router as admin_users_router
from .photos import router as photos_router
from .permissions import is_admin, is_reviewer, is_field_worker, require_is_owner_or_admin



app = FastAPI(title="ERIS React Native Prototype API")
logger = logging.getLogger("eris.api")

app.include_router(dev_router)
app.include_router(admin_users_router)
app.include_router(photos_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup():
    # Create bucket if missing
    try:
        ensure_bucket()
    except Exception as exc:
        if settings.ENV.lower() == "dev":
            logger.warning("MinIO not available during startup: %s", exc)
        else:
            raise

    # Seed admin only if ENV=dev and SEED_ADMIN=true
    db = SessionLocal()
    try:
        seed_admin(db)
    except Exception as exc:
        if settings.ENV.lower() == "dev":
            logger.warning("Database not available for seeding: %s", exc)
        else:
            raise
    finally:
        db.close()


# ----------------------------
# Helpers: roles + visibility
# ----------------------------

def can_view_submission(db: Session, *, user: dict, submission_id: int) -> bool:
    if is_admin(user) or is_reviewer(user):
        return True

    row = db.execute(text("""
        SELECT
            s.created_by_user_id AS owner_id,
            EXISTS(
                SELECT 1
                FROM submission_visibility v
                WHERE v.submission_id = s.id AND v.user_id = :uid
                LIMIT 1
            ) AS has_grant
        FROM submissions s
        WHERE s.id = :sid
        LIMIT 1
    """), {"sid": submission_id, "uid": user["id"]}).mappings().first()

    if not row:
        return False

    if int(row["owner_id"]) == int(user["id"]):
        return True

    return bool(row["has_grant"])

def require_can_view_submission(submission_id: int, db: Session, user: dict) -> None:
    if not can_view_submission(db, user=user, submission_id=submission_id):
        raise HTTPException(status_code=403, detail="Not allowed to view this submission")

def get_submission_status(db: Session, submission_id: int) -> str:
    status_value = db.execute(text("""
        SELECT status
        FROM submissions
        WHERE id = :sid
        LIMIT 1
    """), {"sid": submission_id}).scalar()
    if not status_value:
        raise HTTPException(status_code=404, detail="Submission not found")
    return str(status_value)


def resolve_user_from_request_or_token(request: Request, db: Session, access_token: str | None) -> dict:
    token = (access_token or "").strip()
    if not token:
        auth_header = (request.headers.get("Authorization") or "").strip()
        if auth_header.lower().startswith("bearer "):
            token = auth_header[7:].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Missing auth token")

    try:
        payload = decode_token(token, settings.JWT_SECRET, settings.JWT_ALG)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")

    sub = payload.get("sub")
    if not sub:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    user = db.execute(text("""
        SELECT id, email, full_name, is_active
        FROM users
        WHERE id = :id
    """), {"id": int(sub)}).mappings().first()
    if not user or int(user["is_active"]) != 1:
        raise HTTPException(status_code=401, detail="User inactive or not found")

    roles = db.execute(text("""
        SELECT r.name
        FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = :id
    """), {"id": int(sub)}).scalars().all()

    return {
        "id": int(user["id"]),
        "email": user["email"],
        "full_name": user["full_name"],
        "roles": list(roles),
    }


# ----------------------------
# GISA helpers
# ----------------------------

def get_gisa(db: Session, submission_id: int) -> dict | None:
    row = db.execute(text("""
        SELECT
          submission_id,
          report_date, district, county, route, post_mile, ea, project_id,
          date_incident_reported, district_contact,
          latitude, longitude,
          distribution_code, highway_status_code, lanes_closed_count,
          pavement_ground_cracks,
          crack_length_ft, crack_horizontal_in, crack_vertical_in, crack_depth_in,
          settlement_in, bulge_in, indented_by_rocks,
          observations_notes, geometry_json,
          updated_by_user_id, created_at, updated_at
        FROM submission_gisa
        WHERE submission_id = :sid
        LIMIT 1
    """), {"sid": submission_id}).mappings().first()
    if not row:
        return None

    d = dict(row)
    if isinstance(d.get("geometry_json"), str):
        try:
            d["geometry_json"] = json.loads(d["geometry_json"])
        except Exception:
            pass
    return d

def get_gisa_incident_types(db: Session, submission_id: int) -> list[str]:
    rows = db.execute(text("""
        SELECT incident_type_code
        FROM submission_gisa_incident_types
        WHERE submission_id = :sid
        ORDER BY incident_type_code
    """), {"sid": submission_id}).scalars().all()
    return [str(x) for x in rows]

def get_gisa_actions(db: Session, submission_id: int) -> dict:
    rows = db.execute(text("""
        SELECT action_group, action_code
        FROM submission_gisa_actions
        WHERE submission_id = :sid
        ORDER BY action_group, action_code
    """), {"sid": submission_id}).mappings().all()

    immediate: list[str] = []
    follow_up: list[str] = []
    for r in rows:
        grp = str(r["action_group"]).upper()
        code = str(r["action_code"])
        if grp == "IMMEDIATE":
            immediate.append(code)
        elif grp == "FOLLOW_UP":
            follow_up.append(code)

    return {"immediate": immediate, "follow_up": follow_up}

def validate_submit_ready(db: Session, submission_id: int) -> None:
    gisa = get_gisa(db, submission_id)
    if not gisa:
        raise HTTPException(status_code=409, detail="GISA data missing. Save draft first.")

    missing: list[str] = []
    # Phase 1 required:
    if not gisa.get("district"):
        missing.append("district")
    if not gisa.get("county"):
        missing.append("county")
    if gisa.get("latitude") is None:
        missing.append("latitude")
    if gisa.get("longitude") is None:
        missing.append("longitude")

    lat = gisa.get("latitude")
    lng = gisa.get("longitude")
    try:
        if lat is not None and (float(lat) < -90 or float(lat) > 90):
            missing.append("latitude(range)")
        if lng is not None and (float(lng) < -180 or float(lng) > 180):
            missing.append("longitude(range)")
    except Exception:
        missing.append("lat/lng(type)")

    photo_count = db.execute(text("""
        SELECT COUNT(1)
        FROM attachment_links
        WHERE submission_id = :sid AND kind = 'PHOTO'
    """), {"sid": submission_id}).scalar()
    if int(photo_count or 0) < 1:
        missing.append("photo")

    if missing:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot submit: missing required fields [{', '.join(missing)}]",
        )


# ----------------------------
# Workflow transitions
# ----------------------------

ALLOWED_TRANSITIONS = {
    "DRAFT": {"SUBMITTED"},
    "SUBMITTED": {"APPROVED", "REJECTED"},
    "REJECTED": {"SUBMITTED"},
    "APPROVED": set(),
}


def transition_submission_concurrency_safe(
    db: Session,
    submission_id: int,
    actor_user_id: int,
    event_type: str,
    from_status: str,
    to_status: str,
    comment: str | None = None,
):
    # Enforce in SQL with rowcount
    res = db.execute(text("""
        UPDATE submissions
        SET status = :to_status,
            submitted_at = CASE
                WHEN :to_status = 'SUBMITTED' AND submitted_at IS NULL THEN NOW()
                ELSE submitted_at
            END,
            reviewed_at = CASE
                WHEN :to_status IN ('APPROVED','REJECTED') THEN NOW()
                ELSE reviewed_at
            END,
            reviewed_by_user_id = CASE
                WHEN :to_status IN ('APPROVED','REJECTED') THEN :actor
                ELSE reviewed_by_user_id
            END,
            review_comment = CASE
                WHEN :to_status IN ('APPROVED','REJECTED') THEN :comment
                ELSE review_comment
            END,
            updated_at = NOW()
        WHERE id = :sid AND status = :from_status
    """), {"sid": submission_id, "from_status": from_status, "to_status": to_status, "actor": actor_user_id, "comment": comment})

    if res.rowcount != 1:
        raise HTTPException(status_code=409, detail=f"Conflict: expected status {from_status}")

    db.execute(text("""
        INSERT INTO workflow_events (
            submission_id, actor_user_id, event_type, from_status, to_status, comment
        ) VALUES (
            :sid, :actor, :etype, :from_s, :to_s, :comment
        )
    """), {
        "sid": submission_id,
        "actor": actor_user_id,
        "etype": event_type,
        "from_s": from_status,
        "to_s": to_status,
        "comment": comment
    })

    return {"submission_id": submission_id, "from_status": from_status, "to_status": to_status}


# ----------------------------
# Schemas
# ----------------------------

class LoginRequest(BaseModel):
    email: str
    password: str

class SubmissionCreate(BaseModel):
    title: str | None = Field(default=None, max_length=255)

class WorkflowAction(BaseModel):
    comment: str | None = None

class ReviewAction(BaseModel):
    decision: Literal["APPROVE", "REJECT"]
    comment: str | None = None

class ShareRequest(BaseModel):
    user_id: int = Field(..., ge=1)

class SubmissionTitlePatch(BaseModel):
    title: str | None = Field(default=None, max_length=255)

class GisaDraftPatch(BaseModel):
    report_date: str | None = None  # YYYY-MM-DD (keep as string to avoid timezone weirdness)
    district: str | None = None
    county: str | None = None
    route: str | None = None
    post_mile: str | None = None
    ea: str | None = None
    project_id: str | None = None
    date_incident_reported: str | None = None
    district_contact: str | None = None

    latitude: float | None = None
    longitude: float | None = None

    distribution_code: str | None = None
    highway_status_code: str | None = None
    lanes_closed_count: int | None = None

    pavement_ground_cracks: bool | None = None
    crack_length_ft: float | None = None
    crack_horizontal_in: float | None = None
    crack_vertical_in: float | None = None
    crack_depth_in: float | None = None
    settlement_in: float | None = None
    bulge_in: float | None = None
    indented_by_rocks: bool | None = None

    observations_notes: str | None = None
    geometry_json: dict | None = None

class ReplaceIncidentTypes(BaseModel):
    items: list[str]

class ReplaceActions(BaseModel):
    immediate: list[str] = []
    follow_up: list[str] = []

class GeometryUpsert(BaseModel):
    geometry: dict = Field(..., description="GeoJSON geometry object (Polygon/MultiPolygon/etc)")
    srid: int = Field(default=4326, ge=1, le=999999)
    source: str = Field(default="MOBILE_ARCGIS", max_length=64)

class GeometryResponse(BaseModel):
    submission_id: int
    geometry: dict | None
    srid: int | None = 4326
    source: str | None = None


# ----------------------------
# Health
# ----------------------------

@app.get("/health")
def health():
    return {"ok": True}


@app.get("/gisa/lookups")
def get_gisa_lookups(
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    distribution = db.execute(text("""
        SELECT code, label, sort_order
        FROM gisa_distribution_lut
        ORDER BY sort_order ASC, code ASC
    """)).mappings().all()

    highway_status = db.execute(text("""
        SELECT code, label, sort_order
        FROM gisa_highway_status_lut
        ORDER BY sort_order ASC, code ASC
    """)).mappings().all()

    incident_types = db.execute(text("""
        SELECT code, label, sort_order
        FROM gisa_incident_type_lut
        ORDER BY sort_order ASC, code ASC
    """)).mappings().all()

    action_rows = db.execute(text("""
        SELECT code, label, action_group, sort_order
        FROM gisa_action_lut
        ORDER BY action_group ASC, sort_order ASC, code ASC
    """)).mappings().all()

    immediate: list[dict] = []
    follow_up: list[dict] = []
    for row in action_rows:
        item = dict(row)
        if str(item.get("action_group", "")).upper() == "IMMEDIATE":
            immediate.append(item)
        else:
            follow_up.append(item)

    return {
        "distribution": [dict(r) for r in distribution],
        "highway_status": [dict(r) for r in highway_status],
        "incident_types": [dict(r) for r in incident_types],
        "actions": {
            "immediate": immediate,
            "follow_up": follow_up,
        },
        "requested_by_user_id": user["id"],
    }


# ----------------------------
# Auth
# ----------------------------

@app.post("/auth/login")
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    row = db.execute(text("""
        SELECT id, email, password_hash, is_active
        FROM users
        WHERE email = :email
        LIMIT 1
    """), {"email": payload.email.strip().lower()}).mappings().first()

    if not row or int(row["is_active"]) != 1:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    if not verify_password(payload.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token = create_access_token(
        subject=str(int(row["id"])),
        secret=settings.JWT_SECRET,
        alg=settings.JWT_ALG,
        expires_minutes=settings.JWT_EXPIRES_MINUTES,
    )
    return {"access_token": token, "token_type": "bearer"}

@app.get("/auth/me")
def me(user=Depends(get_current_user)):
    return user


# ----------------------------
# Submissions
# ----------------------------

@app.post("/submissions")
def create_submission(
    db: Session = Depends(get_db),
    payload: SubmissionCreate = SubmissionCreate(),
    user=Depends(require_roles(["FIELD_WORKER", "ADMIN"]))
):
    try:
        status_value = "DRAFT"
        title_value = (payload.title or "").strip() or None
        db.execute(text("""
            INSERT INTO submissions (created_by_user_id, status, client_submission_uuid, title)
            VALUES (:uid, :status, UUID(), :title)
        """), {"uid": user["id"], "status": status_value, "title": title_value})

        new_id = db.execute(text("SELECT LAST_INSERT_ID()")).scalar()

        db.execute(text("""
            INSERT INTO workflow_events
              (submission_id, actor_user_id, event_type, from_status, to_status, comment)
            VALUES
              (:sid, :actor, 'CREATE', NULL, :to_status, NULL)
        """), {"sid": int(new_id), "actor": user["id"], "to_status": status_value})

        db.commit()
        return {"submission_id": int(new_id)}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/submissions")
def list_submissions(
    limit: int = 20,
    status: str | None = None,
    db: Session = Depends(get_db),
    user=Depends(get_current_user)
):
    allowed = {"DRAFT", "SUBMITTED", "APPROVED", "REJECTED"}
    params: dict[str, object] = {"limit": limit}
    status_filter = ""
    if status:
        st = status.upper()
        if st not in allowed:
            raise HTTPException(status_code=400, detail="Invalid status filter")
        params["status"] = st
        status_filter = "WHERE status = :status"

    if is_admin(user) or is_reviewer(user):
        rows = db.execute(text("""
            SELECT s.id, s.created_by_user_id, s.status, s.client_submission_uuid, s.title,
                   s.created_at, s.submitted_at, s.reviewed_at,
                   g.district, g.county, g.route, g.post_mile
            FROM submissions s
            LEFT JOIN submission_gisa g ON g.submission_id = s.id
            """ + status_filter + """
            ORDER BY s.id DESC
            LIMIT :limit
        """), params).mappings().all()
        return {"items": [dict(r) for r in rows]}

    params["uid"] = user["id"]
    where_clause = "WHERE s.created_by_user_id = :uid OR v.user_id IS NOT NULL"
    if status:
        where_clause = f"{where_clause} AND s.status = :status"

    rows = db.execute(text("""
        SELECT DISTINCT s.id, s.created_by_user_id, s.status, s.client_submission_uuid, s.title,
               s.created_at, s.submitted_at, s.reviewed_at,
               g.district, g.county, g.route, g.post_mile
        FROM submissions s
        LEFT JOIN submission_visibility v
          ON v.submission_id = s.id AND v.user_id = :uid
        LEFT JOIN submission_gisa g ON g.submission_id = s.id
        """ + where_clause + """
        ORDER BY s.id DESC
        LIMIT :limit
    """), params).mappings().all()

    return {"items": [dict(r) for r in rows]}


@app.get("/submissions/{submission_id}")
def get_submission(
    submission_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(get_current_user)
):
    sub = db.execute(text("""
        SELECT id, created_by_user_id, status, client_submission_uuid, title,
               created_at, updated_at, submitted_at, reviewed_at, reviewed_by_user_id, review_comment
        FROM submissions
        WHERE id = :sid
    """), {"sid": submission_id}).mappings().first()

    if not sub:
        raise HTTPException(status_code=404, detail="Submission not found")

    require_can_view_submission(submission_id, db, user)

    gisa = get_gisa(db, submission_id)
    incident_types = get_gisa_incident_types(db, submission_id)
    actions = get_gisa_actions(db, submission_id)

    attachments = db.execute(text("""
        SELECT a.id, a.file_name, a.mime_type, a.file_size_bytes,
               a.storage_provider, a.storage_bucket, a.storage_key,
               a.sha256, a.uploaded_at,
               al.kind, al.sort_order
        FROM attachment_links al
        JOIN attachments a ON a.id = al.attachment_id
        WHERE al.submission_id = :sid
        ORDER BY al.sort_order ASC, a.id ASC
    """), {"sid": submission_id}).mappings().all()

    events = db.execute(text("""
        SELECT id, actor_user_id, event_type, from_status, to_status,
               comment, created_at
        FROM workflow_events
        WHERE submission_id = :sid
        ORDER BY created_at ASC, id ASC
    """), {"sid": submission_id}).mappings().all()

    photo_items = [dict(a) for a in attachments if str(a["kind"]).upper() == "PHOTO"]

    return {
        "submission": dict(sub),
        "gisa": gisa,
        "incident_types": incident_types,
        "actions": actions,
        "photos": photo_items,
        "attachments": [dict(a) for a in attachments],
        "workflow_events": [dict(e) for e in events],
    }


@app.patch("/submissions/{submission_id}/title")
def patch_submission_title(
    submission_id: int = Path(..., ge=1),
    payload: SubmissionTitlePatch = ...,
    db: Session = Depends(get_db),
    user=Depends(require_roles(["FIELD_WORKER", "ADMIN"])),
):
    require_is_owner_or_admin(db, user=user, submission_id=submission_id)
    if get_submission_status(db, submission_id) not in {"DRAFT", "REJECTED"}:
        raise HTTPException(status_code=409, detail="Only DRAFT or REJECTED submissions can be edited")

    title_value = (payload.title or "").strip() or None
    try:
        db.execute(text("""
            UPDATE submissions
            SET title = :title
            WHERE id = :sid
        """), {"title": title_value, "sid": submission_id})
        db.commit()
        return {"submission_id": submission_id, "title": title_value}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/submissions/{submission_id}")
def delete_submission(
    submission_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["FIELD_WORKER", "ADMIN"])),
):
    require_is_owner_or_admin(db, user=user, submission_id=submission_id)
    if get_submission_status(db, submission_id) != "DRAFT":
        raise HTTPException(status_code=409, detail="Only DRAFT submissions can be deleted")

    try:
        db.execute(text("DELETE FROM submissions WHERE id = :sid"), {"sid": submission_id})
        db.commit()
        return {"deleted": True, "submission_id": submission_id}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/submissions/{submission_id}/geometry", response_model=GeometryResponse)
def get_submission_geometry(
    submission_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    # viewer permission (admins/reviewers + owner/grants)
    require_can_view_submission(submission_id, db, user)

    row = db.execute(text("""
        SELECT geometry_json
        FROM submission_gisa
        WHERE submission_id = :sid
        LIMIT 1
    """), {"sid": submission_id}).mappings().first()

    if not row or row["geometry_json"] is None:
        return {"submission_id": submission_id, "geometry": None, "srid": 4326, "source": None}

    geom_val = row["geometry_json"]
    if isinstance(geom_val, str):
        try:
            geom_val = json.loads(geom_val)
        except Exception:
            # if stored as a string but not parseable, return as-is
            geom_val = {"raw": geom_val}

    return {"submission_id": submission_id, "geometry": geom_val, "srid": 4326, "source": "MOBILE_ARCGIS"}


@app.put("/submissions/{submission_id}/geometry", response_model=GeometryResponse)
def put_submission_geometry(
    submission_id: int = Path(..., ge=1),
    payload: GeometryUpsert = ...,
    db: Session = Depends(get_db),
    user=Depends(require_roles(["FIELD_WORKER", "ADMIN"])),
):
    # Only owner/admin can edit
    require_is_owner_or_admin(db, user=user, submission_id=submission_id)

    # Only DRAFT/REJECTED editable
    if get_submission_status(db, submission_id) not in {"DRAFT", "REJECTED"}:
        raise HTTPException(status_code=409, detail="Only DRAFT or REJECTED submissions can be edited")

    # Basic GeoJSON sanity check (minimal but useful)
    if not isinstance(payload.geometry, dict):
        raise HTTPException(status_code=400, detail="geometry must be an object")
    gtype = str(payload.geometry.get("type", "")).lower()
    if gtype not in ("polygon", "multipolygon", "point", "multipoint", "linestring", "multilinestring", "geometrycollection"):
        raise HTTPException(status_code=400, detail=f"Unsupported GeoJSON type: {payload.geometry.get('type')}")

    geom_json_str = json.dumps(payload.geometry)

    try:
        exists = db.execute(text("""
            SELECT 1 FROM submission_gisa WHERE submission_id=:sid LIMIT 1
        """), {"sid": submission_id}).scalar()

        if exists:
            db.execute(text("""
                UPDATE submission_gisa
                SET geometry_json = :geom,
                    updated_by_user_id = :uid
                WHERE submission_id = :sid
            """), {"sid": submission_id, "geom": geom_json_str, "uid": user["id"]})
        else:
            # Create the submission_gisa row if it doesn’t exist yet
            db.execute(text("""
                INSERT INTO submission_gisa (submission_id, geometry_json, updated_by_user_id)
                VALUES (:sid, :geom, :uid)
            """), {"sid": submission_id, "geom": geom_json_str, "uid": user["id"]})

        db.commit()
        return {"submission_id": submission_id, "geometry": payload.geometry, "srid": payload.srid, "source": payload.source}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))


# ----------------------------
# GISA Draft Update Endpoints
# ----------------------------

@app.patch("/submissions/{submission_id}/gisa")
def patch_gisa(
    submission_id: int = Path(..., ge=1),
    payload: GisaDraftPatch = ...,
    db: Session = Depends(get_db),
    user=Depends(require_roles(["FIELD_WORKER", "ADMIN"])),
):
    require_is_owner_or_admin(db, user=user, submission_id=submission_id)

    current_status = get_submission_status(db, submission_id)
    if current_status not in {"DRAFT", "REJECTED"}:
        raise HTTPException(status_code=409, detail="Only DRAFT or REJECTED submissions can be edited")

    provided = payload.model_dump(exclude_unset=True)
    if not provided:
        return {"submission_id": submission_id, "gisa": get_gisa(db, submission_id)}

    if "geometry_json" in provided and provided["geometry_json"] is not None:
        provided["geometry_json"] = json.dumps(provided["geometry_json"])

    # Validate FK-backed codes if provided
    def ensure_exists(table: str, code: str):
        ok = db.execute(text(f"SELECT 1 FROM {table} WHERE code=:c LIMIT 1"), {"c": code}).scalar()
        if not ok:
            raise HTTPException(status_code=400, detail=f"Invalid code: {code}")

    if provided.get("distribution_code"):
        ensure_exists("gisa_distribution_lut", provided["distribution_code"])
    if provided.get("highway_status_code"):
        ensure_exists("gisa_highway_status_lut", provided["highway_status_code"])

    try:
        exists = db.execute(text("""
            SELECT 1 FROM submission_gisa WHERE submission_id = :sid LIMIT 1
        """), {"sid": submission_id}).scalar()

        if exists:
            set_parts = []
            params = {"sid": submission_id, "updated_by": user["id"]}
            for key, value in provided.items():
                set_parts.append(f"{key} = :{key}")
                params[key] = value
            set_parts.append("updated_by_user_id = :updated_by")
            update_sql = f"UPDATE submission_gisa SET {', '.join(set_parts)} WHERE submission_id = :sid"
            db.execute(text(update_sql), params)
        else:
            cols = ["submission_id", "updated_by_user_id"]
            vals = [":sid", ":updated_by"]
            params = {"sid": submission_id, "updated_by": user["id"]}
            for key, value in provided.items():
                cols.append(key)
                vals.append(f":{key}")
                params[key] = value
            insert_sql = f"INSERT INTO submission_gisa ({', '.join(cols)}) VALUES ({', '.join(vals)})"
            db.execute(text(insert_sql), params)

        db.commit()
        return {"submission_id": submission_id, "gisa": get_gisa(db, submission_id)}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))


@app.put("/submissions/{submission_id}/gisa/incident-types")
def replace_incident_types(
    submission_id: int = Path(..., ge=1),
    payload: ReplaceIncidentTypes = ...,
    db: Session = Depends(get_db),
    user=Depends(require_roles(["FIELD_WORKER", "ADMIN"])),
):
    require_is_owner_or_admin(db, user=user, submission_id=submission_id)
    if get_submission_status(db, submission_id) not in {"DRAFT", "REJECTED"}:
        raise HTTPException(status_code=409, detail="Only DRAFT or REJECTED submissions can be edited")

    # Validate codes exist
    for code in payload.items:
        ok = db.execute(text("SELECT 1 FROM gisa_incident_type_lut WHERE code=:c LIMIT 1"), {"c": code}).scalar()
        if not ok:
            raise HTTPException(status_code=400, detail=f"Invalid incident type: {code}")

    try:
        db.execute(text("DELETE FROM submission_gisa_incident_types WHERE submission_id=:sid"), {"sid": submission_id})
        for code in payload.items:
            db.execute(text("""
                INSERT INTO submission_gisa_incident_types (submission_id, incident_type_code)
                VALUES (:sid, :code)
            """), {"sid": submission_id, "code": code})
        db.commit()
        return {"submission_id": submission_id, "incident_types": get_gisa_incident_types(db, submission_id)}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))


@app.put("/submissions/{submission_id}/gisa/actions")
def replace_actions(
    submission_id: int = Path(..., ge=1),
    payload: ReplaceActions = ...,
    db: Session = Depends(get_db),
    user=Depends(require_roles(["FIELD_WORKER", "ADMIN"])),
):
    require_is_owner_or_admin(db, user=user, submission_id=submission_id)
    if get_submission_status(db, submission_id) not in {"DRAFT", "REJECTED"}:
        raise HTTPException(status_code=409, detail="Only DRAFT or REJECTED submissions can be edited")

    def validate_action(code: str, group: str):
        row = db.execute(text("""
            SELECT action_group FROM gisa_action_lut WHERE code=:c LIMIT 1
        """), {"c": code}).scalar()
        if not row:
            raise HTTPException(status_code=400, detail=f"Invalid action: {code}")
        if str(row).upper() != group:
            raise HTTPException(status_code=400, detail=f"Action {code} not allowed in group {group}")

    for c in payload.immediate:
        validate_action(c, "IMMEDIATE")
    for c in payload.follow_up:
        validate_action(c, "FOLLOW_UP")

    try:
        db.execute(text("DELETE FROM submission_gisa_actions WHERE submission_id=:sid"), {"sid": submission_id})
        for c in payload.immediate:
            db.execute(text("""
                INSERT INTO submission_gisa_actions (submission_id, action_group, action_code)
                VALUES (:sid, 'IMMEDIATE', :code)
            """), {"sid": submission_id, "code": c})
        for c in payload.follow_up:
            db.execute(text("""
                INSERT INTO submission_gisa_actions (submission_id, action_group, action_code)
                VALUES (:sid, 'FOLLOW_UP', :code)
            """), {"sid": submission_id, "code": c})
        db.commit()
        return {"submission_id": submission_id, "actions": get_gisa_actions(db, submission_id)}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))


# ----------------------------
# Admin: share visibility
# ----------------------------

@app.post("/submissions/{submission_id}/share")
def share_submission(
    submission_id: int = Path(..., ge=1),
    payload: ShareRequest = ...,
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN"]))
):
    exists = db.execute(text("SELECT 1 FROM submissions WHERE id=:sid"), {"sid": submission_id}).scalar()
    if not exists:
        raise HTTPException(status_code=404, detail="Submission not found")

    target = db.execute(text("SELECT 1 FROM users WHERE id=:uid"), {"uid": payload.user_id}).scalar()
    if not target:
        raise HTTPException(status_code=404, detail="Target user not found")

    try:
        db.execute(text("""
            INSERT INTO submission_visibility (submission_id, user_id, granted_by_user_id)
            VALUES (:sid, :uid, :admin_id)
            ON DUPLICATE KEY UPDATE granted_by_user_id = VALUES(granted_by_user_id)
        """), {"sid": submission_id, "uid": payload.user_id, "admin_id": user["id"]})
        db.commit()
        return {"submission_id": submission_id, "shared_with_user_id": payload.user_id}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/submissions/{submission_id}/share/{user_id}")
def unshare_submission(
    submission_id: int = Path(..., ge=1),
    user_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN"]))
):
    try:
        db.execute(text("""
            DELETE FROM submission_visibility
            WHERE submission_id = :sid AND user_id = :uid
        """), {"sid": submission_id, "uid": user_id})
        db.commit()
        return {"submission_id": submission_id, "unshared_user_id": user_id}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/submissions/{submission_id}/shared-with")
def list_shared_with(
    submission_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN"]))
):
    rows = db.execute(text("""
        SELECT v.user_id, u.email, u.full_name, v.granted_by_user_id, v.created_at
        FROM submission_visibility v
        JOIN users u ON u.id = v.user_id
        WHERE v.submission_id = :sid
        ORDER BY v.created_at ASC
    """), {"sid": submission_id}).mappings().all()

    return {"items": [dict(r) for r in rows]}

# ----------------------------
# Attachment download URLs
# ----------------------------

@app.get("/attachments/{attachment_id}/download-url")
def attachment_download_url(
    attachment_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(get_current_user)
):
    row = db.execute(text("""
        SELECT id, storage_bucket, storage_key
        FROM attachments
        WHERE id = :aid
    """), {"aid": attachment_id}).mappings().first()

    if not row:
        raise HTTPException(status_code=404, detail="Attachment not found")

    if not (is_admin(user) or is_reviewer(user)):
        sid = db.execute(text("""
            SELECT al.submission_id
            FROM attachment_links al
            WHERE al.attachment_id = :aid
            LIMIT 1
        """), {"aid": attachment_id}).scalar()

        if sid is None:
            raise HTTPException(status_code=404, detail="Attachment not linked")

        require_can_view_submission(int(sid), db, user)

    url = presign_get(row["storage_key"], bucket=row["storage_bucket"], expires_seconds=900)

    return {
        "attachment_id": row["id"],
        "storage_key": row["storage_key"],
        "download_url": url,
        "expires_seconds": 900
    }

@app.get("/photos/{photo_id}/download")
def photo_download(
    photo_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    return attachment_download_url(photo_id, db, user)


@app.get("/attachments/{attachment_id}/content")
def attachment_content(
    attachment_id: int = Path(..., ge=1),
    request: Request = None,
    access_token: str | None = None,
    db: Session = Depends(get_db),
):
    user = resolve_user_from_request_or_token(request, db, access_token)
    row = db.execute(text("""
        SELECT id, storage_bucket, storage_key
        FROM attachments
        WHERE id = :aid
    """), {"aid": attachment_id}).mappings().first()

    if not row:
        raise HTTPException(status_code=404, detail="Attachment not found")

    if not (is_admin(user) or is_reviewer(user)):
        sid = db.execute(text("""
            SELECT al.submission_id
            FROM attachment_links al
            WHERE al.attachment_id = :aid
            LIMIT 1
        """), {"aid": attachment_id}).scalar()
        if sid is None:
            raise HTTPException(status_code=404, detail="Attachment not linked")
        require_can_view_submission(int(sid), db, user)

    data, content_type = get_object_bytes(
        object_key=row["storage_key"],
        bucket=row["storage_bucket"],
    )
    return Response(content=data, media_type=content_type)


@app.get("/photos/{photo_id}/content")
def photo_content(
    photo_id: int = Path(..., ge=1),
    request: Request = None,
    access_token: str | None = None,
    db: Session = Depends(get_db),
):
    return attachment_content(photo_id, request, access_token, db)


# ----------------------------
# Workflow endpoints
# ----------------------------

@app.post("/submissions/{submission_id}/submit")
def submit(
    submission_id: int = Path(..., ge=1),
    payload: WorkflowAction = ...,
    db: Session = Depends(get_db),
    user=Depends(require_roles(["FIELD_WORKER", "ADMIN"]))
):
    require_is_owner_or_admin(db, user=user, submission_id=submission_id)
    validate_submit_ready(db, submission_id)

    current_status = get_submission_status(db, submission_id)
    if current_status not in {"DRAFT", "REJECTED"}:
        raise HTTPException(
            status_code=409,
            detail="Only DRAFT or REJECTED submissions can be submitted",
        )

    from_status = current_status
    to_status = "SUBMITTED"
    event_type = "RESUBMIT" if from_status == "REJECTED" else "SUBMIT"
    try:
        result = transition_submission_concurrency_safe(
            db=db,
            submission_id=submission_id,
            actor_user_id=user["id"],
            event_type=event_type,
            from_status=from_status,
            to_status=to_status,
            comment=payload.comment,
        )
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


@app.post("/submissions/{submission_id}/review")
def review_submission(
    submission_id: int = Path(..., ge=1),
    payload: ReviewAction = ...,
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN", "REVIEWER"])),
):
    from_status = "SUBMITTED"
    to_status = "APPROVED" if payload.decision == "APPROVE" else "REJECTED"
    try:
        result = transition_submission_concurrency_safe(
            db=db,
            submission_id=submission_id,
            actor_user_id=user["id"],
            event_type=payload.decision,
            from_status=from_status,
            to_status=to_status,
            comment=payload.comment,
        )
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


@app.post("/submissions/{submission_id}/approve")
def approve(
    submission_id: int = Path(..., ge=1),
    payload: WorkflowAction = ...,
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN", "REVIEWER"])),
):
    return review_submission(
        submission_id=submission_id,
        payload=ReviewAction(decision="APPROVE", comment=payload.comment),
        db=db,
        user=user,
    )


@app.post("/submissions/{submission_id}/reject")
def reject(
    submission_id: int = Path(..., ge=1),
    payload: WorkflowAction = ...,
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN", "REVIEWER"])),
):
    return review_submission(
        submission_id=submission_id,
        payload=ReviewAction(decision="REJECT", comment=payload.comment),
        db=db,
        user=user,
    )

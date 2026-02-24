import logging
import json
import re
import hashlib
from io import BytesIO
from pathlib import Path as FilePath
from urllib.parse import urlencode
from urllib.request import urlopen
from typing import Literal

from fastapi import FastAPI, Depends, HTTPException, Path, status, Response, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy import text
from reportlab.pdfgen import canvas
from pypdf import PdfReader, PdfWriter

from .db import SessionLocal, get_db
from .config import settings
from .auth import verify_password, create_access_token, decode_token
from .deps import get_current_user, require_roles
from .storage import ensure_bucket, make_object_key, put_object_stream, put_object_bytes, presign_get, get_object_bytes
from .seed import seed_admin
from .dev_routes import router as dev_router
from .admin_users import router as admin_users_router
from .photos import router as photos_router
from .permissions import is_admin, is_reviewer, is_field_worker, require_is_owner_or_admin



app = FastAPI(title="ERIS React Native Prototype API")
logger = logging.getLogger("eris.api")
GENERIC_SERVER_ERROR_DETAIL = "Internal server error"

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

@app.exception_handler(HTTPException)
async def eris_http_exception_handler(request: Request, exc: HTTPException):
    if int(exc.status_code) >= 500:
        logger.error(
            "HTTPException status=%s method=%s path=%s",
            exc.status_code,
            request.method,
            request.url.path,
            exc_info=exc,
        )
        return JSONResponse(status_code=exc.status_code, content={"detail": GENERIC_SERVER_ERROR_DETAIL})
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


@app.exception_handler(Exception)
async def eris_unhandled_exception_handler(request: Request, exc: Exception):
    logger.error(
        "Unhandled exception method=%s path=%s",
        request.method,
        request.url.path,
        exc_info=exc,
    )
    return JSONResponse(status_code=500, content={"detail": GENERIC_SERVER_ERROR_DETAIL})


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
        db.execute(text("""
            CREATE TABLE IF NOT EXISTS submission_editors (
                submission_id BIGINT NOT NULL,
                user_id BIGINT NOT NULL,
                granted_by_user_id BIGINT NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (submission_id, user_id),
                CONSTRAINT fk_edit_submission FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
                CONSTRAINT fk_edit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                CONSTRAINT fk_edit_granted_by FOREIGN KEY (granted_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
                INDEX idx_edit_user (user_id)
            ) ENGINE=InnoDB
        """))
        db.commit()
        cleanup_columns = [
            "DROP COLUMN IF EXISTS team_member1_last_name",
            "DROP COLUMN IF EXISTS team_member1_first_name",
            "DROP COLUMN IF EXISTS team_member1_s_number",
            "DROP COLUMN IF EXISTS team_member2_last_name",
            "DROP COLUMN IF EXISTS team_member2_first_name",
            "DROP COLUMN IF EXISTS team_member2_s_number",
            "DROP COLUMN IF EXISTS contact_phone_primary",
            "DROP COLUMN IF EXISTS contact_phone_secondary",
        ]
        for col_sql in cleanup_columns:
            db.execute(text(f"ALTER TABLE submission_gisa {col_sql}"))
        db.execute(text("""
            ALTER TABLE submission_gisa
            MODIFY COLUMN district_contact TEXT NULL
        """))
        db.commit()
        # Backfill/upgrade older DBs with explicit GISA paper-form columns.
        upgrade_columns = [
            "ADD COLUMN IF NOT EXISTS failure_rock_fall TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS failure_topple TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS failure_slide TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS failure_spread TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS failure_flow TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS failure_compound TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS failure_erosion TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS failure_surficial_failure TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS failure_scoured_toe TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS failure_washout TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS distribution_advancing TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS distribution_retrogressive TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS distribution_enlarging TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS distribution_widening TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS distribution_moving TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS distribution_confined TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS material_rock TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS material_soil TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS material_bedding TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS material_joints TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS material_fractures TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS est_soil_pct DECIMAL(5,2) NULL",
            "ADD COLUMN IF NOT EXISTS est_clay_pct DECIMAL(5,2) NULL",
            "ADD COLUMN IF NOT EXISTS est_silt_pct DECIMAL(5,2) NULL",
            "ADD COLUMN IF NOT EXISTS est_sand_pct DECIMAL(5,2) NULL",
            "ADD COLUMN IF NOT EXISTS est_gravel_pct DECIMAL(5,2) NULL",
            "ADD COLUMN IF NOT EXISTS water_dry TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS water_moist TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS water_wet TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS water_flowing TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS water_seep TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS water_spring TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS vegetation_trees VARCHAR(255) NULL",
            "ADD COLUMN IF NOT EXISTS vegetation_bushes_shrubs VARCHAR(255) NULL",
            "ADD COLUMN IF NOT EXISTS vegetation_groundcover VARCHAR(255) NULL",
            "ADD COLUMN IF NOT EXISTS drainage_clogged_inlet TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS drainage_compromised_drains TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS drainage_surface_runoff TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS drainage_torrent_surge_flood TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS impact_impacted_adj_utilities TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS impact_maybe_adj_utilities TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS impact_adj_utilities VARCHAR(255) NULL",
            "ADD COLUMN IF NOT EXISTS impact_impacted_adj_properties TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS impact_maybe_adj_properties TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS impact_adj_properties VARCHAR(255) NULL",
            "ADD COLUMN IF NOT EXISTS impact_impacted_adj_structure TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS impact_maybe_adj_structure TINYINT NOT NULL DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS impact_adj_structure VARCHAR(255) NULL",
            "ADD COLUMN IF NOT EXISTS measure_slope_height_ft DECIMAL(10,2) NULL",
            "ADD COLUMN IF NOT EXISTS measure_original_slope_deg DECIMAL(10,2) NULL",
            "ADD COLUMN IF NOT EXISTS measure_landslide_width_ft DECIMAL(10,2) NULL",
            "ADD COLUMN IF NOT EXISTS measure_landslide_length_ft DECIMAL(10,2) NULL",
            "ADD COLUMN IF NOT EXISTS measure_main_scarp_height_ft DECIMAL(10,2) NULL",
            "ADD COLUMN IF NOT EXISTS measure_landslide_slope_deg DECIMAL(10,2) NULL",
            "ADD COLUMN IF NOT EXISTS measure_roadway_length_ft DECIMAL(10,2) NULL",
            "ADD COLUMN IF NOT EXISTS measure_roadway_width_ft DECIMAL(10,2) NULL",
        ]
        for col_sql in upgrade_columns:
            db.execute(text(f"ALTER TABLE submission_gisa {col_sql}"))
        db.execute(text("""
            INSERT IGNORE INTO gisa_action_lut (code, label, action_group, sort_order) VALUES
            ('DEWATER_HORIZONTAL_DRAINS','Dewater with horizontal drains','IMMEDIATE',105),
            ('PLACE_ROCK_SLOPE_PROTECTION','Place rock slope protection (ref. manual)','IMMEDIATE',130),
            ('RECONSTRUCT_SLOPE_GEOSYNTHETICS','Reconstruct slope with geosynthetics','FOLLOW_UP',25),
            ('REPAIR_CULVERT_DRAINAGE_PIPE','Repair culvert/drainage pipe','FOLLOW_UP',28),
            ('SURVEY_SITE_DIST_SURVEY','Survey site - district survey','FOLLOW_UP',35)
        """))
        db.commit()
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
            ) AS has_view_grant,
            EXISTS(
                SELECT 1
                FROM submission_editors e
                WHERE e.submission_id = s.id AND e.user_id = :uid
                LIMIT 1
            ) AS has_edit_grant
        FROM submissions s
        WHERE s.id = :sid
        LIMIT 1
    """), {"sid": submission_id, "uid": user["id"]}).mappings().first()

    if not row:
        return False

    if int(row["owner_id"]) == int(user["id"]):
        return True

    return bool(row["has_view_grant"]) or bool(row["has_edit_grant"])

def require_can_view_submission(submission_id: int, db: Session, user: dict) -> None:
    if not can_view_submission(db, user=user, submission_id=submission_id):
        raise HTTPException(status_code=403, detail="Not allowed to view this submission")

def can_edit_submission(db: Session, *, user: dict, submission_id: int) -> bool:
    if is_admin(user):
        return True

    row = db.execute(text("""
        SELECT
            s.created_by_user_id AS owner_id,
            EXISTS(
                SELECT 1
                FROM submission_editors e
                WHERE e.submission_id = s.id AND e.user_id = :uid
                LIMIT 1
            ) AS has_edit_grant
        FROM submissions s
        WHERE s.id = :sid
        LIMIT 1
    """), {"sid": submission_id, "uid": user["id"]}).mappings().first()

    if not row:
        return False
    if int(row["owner_id"]) == int(user["id"]):
        return True
    return bool(row["has_edit_grant"])

def require_can_edit_submission(submission_id: int, db: Session, user: dict) -> None:
    if not can_edit_submission(db, user=user, submission_id=submission_id):
        raise HTTPException(status_code=403, detail="Not allowed to edit this submission")

def can_manage_submission_permissions(db: Session, *, user: dict, submission_id: int) -> bool:
    if is_admin(user):
        return True
    owner = db.execute(text("""
        SELECT created_by_user_id
        FROM submissions
        WHERE id = :sid
        LIMIT 1
    """), {"sid": submission_id}).scalar()
    if owner is None:
        return False
    return int(owner) == int(user["id"])

def require_can_manage_submission_permissions(submission_id: int, db: Session, user: dict) -> None:
    if not can_manage_submission_permissions(db, user=user, submission_id=submission_id):
        raise HTTPException(status_code=403, detail="Only owner/admin can manage permissions")

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


def _safe_json_get(url: str, timeout: float = 6.0) -> dict | None:
    try:
        with urlopen(url, timeout=timeout) as resp:
            payload = resp.read().decode("utf-8", errors="ignore")
        data = json.loads(payload)
        if isinstance(data, dict):
            return data
    except Exception:
        return None
    return None


def _normalize_county(raw: str | None) -> str | None:
    if not raw:
        return None
    return re.sub(r"\s+County$", "", raw.strip(), flags=re.IGNORECASE) or None


def _extract_route_from_text(text_value: str | None) -> str | None:
    if not text_value:
        return None
    m = re.search(r"\b(?:I|US|CA|SR)[-\s]?(\d{1,3})\b", text_value, flags=re.IGNORECASE)
    if m:
        return m.group(1)
    m = re.search(r"\b(\d{1,3})\b", text_value)
    return m.group(1) if m else None


def _reverse_geocode_arcgis(lat: float, lon: float) -> dict:
    params = urlencode({"f": "pjson", "location": f"{lon},{lat}"})
    url = f"https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?{params}"
    data = _safe_json_get(url) or {}
    address = data.get("address") if isinstance(data.get("address"), dict) else {}
    county = _normalize_county(address.get("Subregion") or address.get("District"))
    route = _extract_route_from_text(
        address.get("ShortLabel") or address.get("LongLabel") or address.get("Match_addr")
    )
    return {
        "county": county,
        "route": route,
        "source_reverse": "arcgis_world_geocoder" if address else None,
    }


def _query_postmile_layer(lat: float, lon: float) -> dict:
    base = (settings.POSTMILE_FEATURE_LAYER_URL or "").strip().rstrip("/")
    if not base:
        return {}

    out_fields = ",".join([
        settings.POSTMILE_ROUTE_FIELD,
        settings.POSTMILE_PM_FIELD,
        settings.POSTMILE_COUNTY_FIELD,
        settings.POSTMILE_DISTRICT_FIELD,
    ])
    params = urlencode(
        {
            "f": "pjson",
            "where": settings.POSTMILE_WHERE,
            "geometry": f"{lon},{lat}",
            "geometryType": "esriGeometryPoint",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "distance": str(max(1, int(settings.POSTMILE_SEARCH_DISTANCE_METERS))),
            "units": "esriSRUnit_Meter",
            "outFields": out_fields,
            "returnGeometry": "false",
            "resultRecordCount": "3",
        }
    )
    data = _safe_json_get(f"{base}/query?{params}") or {}
    features = data.get("features")
    if not isinstance(features, list) or not features:
        return {}
    attrs = features[0].get("attributes")
    if not isinstance(attrs, dict):
        return {}

    district = attrs.get(settings.POSTMILE_DISTRICT_FIELD)
    district_value = None
    if district is not None:
        digits = re.sub(r"\D", "", str(district))
        district_value = digits.zfill(2) if digits else str(district).strip()

    route = attrs.get(settings.POSTMILE_ROUTE_FIELD)
    post_mile = attrs.get(settings.POSTMILE_PM_FIELD)
    county = attrs.get(settings.POSTMILE_COUNTY_FIELD)

    return {
        "district": district_value or None,
        "county": _normalize_county(str(county)) if county is not None else None,
        "route": str(route).strip() if route is not None and str(route).strip() else None,
        "post_mile": str(post_mile).strip() if post_mile is not None and str(post_mile).strip() else None,
        "source_postmile": "arcgis_postmile_layer",
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
          failure_rock_fall, failure_topple, failure_slide, failure_spread, failure_flow,
          failure_compound, failure_erosion, failure_surficial_failure, failure_scoured_toe, failure_washout,
          distribution_advancing, distribution_retrogressive, distribution_enlarging, distribution_widening, distribution_moving, distribution_confined,
          material_rock, material_soil, material_bedding, material_joints, material_fractures,
          est_soil_pct, est_clay_pct, est_silt_pct, est_sand_pct, est_gravel_pct,
          water_dry, water_moist, water_wet, water_flowing, water_seep, water_spring,
          vegetation_trees, vegetation_bushes_shrubs, vegetation_groundcover,
          drainage_clogged_inlet, drainage_compromised_drains, drainage_surface_runoff, drainage_torrent_surge_flood,
          impact_impacted_adj_utilities, impact_maybe_adj_utilities, impact_adj_utilities,
          impact_impacted_adj_properties, impact_maybe_adj_properties, impact_adj_properties,
          impact_impacted_adj_structure, impact_maybe_adj_structure, impact_adj_structure,
          measure_slope_height_ft, measure_original_slope_deg, measure_landslide_width_ft, measure_landslide_length_ft,
          measure_main_scarp_height_ft, measure_landslide_slope_deg, measure_roadway_length_ft, measure_roadway_width_ft,
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


def _format_yn(value) -> str:
    return "Yes" if bool(value) else "No"


def _lookup_map(db: Session, table_name: str) -> dict[str, str]:
    rows = db.execute(text(f"""
        SELECT code, label
        FROM {table_name}
    """)).mappings().all()
    return {str(r["code"]): str(r["label"]) for r in rows}


def _render_gisa_pdf_bytes(db: Session, submission_id: int) -> bytes:
    sub = db.execute(text("""
        SELECT id, status, title, created_at, updated_at
        FROM submissions
        WHERE id = :sid
        LIMIT 1
    """), {"sid": submission_id}).mappings().first()
    if not sub:
        raise HTTPException(status_code=404, detail="Submission not found")

    gisa = get_gisa(db, submission_id)
    if not gisa:
        raise HTTPException(status_code=409, detail="GISA data missing. Save draft first.")

    actions = get_gisa_actions(db, submission_id)
    immediate = set(actions.get("immediate", []))
    follow_up = set(actions.get("follow_up", []))
    incident_type_codes = set(get_gisa_incident_types(db, submission_id))

    def val(k: str, default: str = "") -> str:
        v = gisa.get(k)
        if v is None:
            return default
        return str(v)

    def is_on(k: str) -> bool:
        v = gisa.get(k)
        if isinstance(v, bool):
            return v
        if v is None:
            return False
        if isinstance(v, (int, float)):
            return v != 0
        if isinstance(v, str):
            t = v.strip().lower()
            if t in {"", "0", "false", "no", "n", "off", "unknown"}:
                return False
            if t in {"1", "true", "yes", "y", "on"}:
                return True
            return False
        return bool(v)

    template_candidates = [
        FilePath(__file__).resolve().parents[1] / "assets" / "GISA001.pdf",
        FilePath(__file__).resolve().parents[2] / "mobile" / "assets" / "GISA001.pdf",
    ]
    template_path = next((p for p in template_candidates if p.exists()), None)
    if not template_path:
        attempted = [str(p) for p in template_candidates]
        logger.error("GISA template PDF missing. attempted_paths=%s", attempted)
        raise HTTPException(status_code=500, detail="Failed to generate PDF")
    logger.info("GISA template PDF selected path=%s", str(template_path))

    base_reader = PdfReader(str(template_path))
    if not base_reader.pages:
        logger.error("GISA template PDF has no pages. path=%s", str(template_path))
        raise HTTPException(status_code=500, detail="Failed to generate PDF")
    base_page = base_reader.pages[0]
    # Guardrail: XFA templates render as a fallback "Please wait..." page in pypdf.
    # We cannot position overlays on the real form until the template is flattened to static PDF.
    root = base_reader.trailer.get("/Root")
    if hasattr(root, "get_object"):
        root = root.get_object()
    acro_form = root.get("/AcroForm") if isinstance(root, dict) else None
    if hasattr(acro_form, "get_object"):
        acro_form = acro_form.get_object()
    first_page_text = (base_page.extract_text() or "").lower()
    has_xfa = bool(isinstance(acro_form, dict) and acro_form.get("/XFA"))
    has_placeholder = "please wait..." in first_page_text and "adobe reader" in first_page_text
    if has_xfa or has_placeholder:
        logger.error(
            "Unsupported XFA GISA template detected at %s. Replace with a flattened/static PDF copy of GISA001.",
            str(template_path),
        )
        raise HTTPException(status_code=500, detail="Failed to generate PDF")
    width = 612.0
    height = 792.0

    overlay_io = BytesIO()
    c = canvas.Canvas(overlay_io, pagesize=(width, height))

    # Placement calibration for the current flattened GISA template.
    # The original coordinate map was authored against a different rendering,
    # so we normalize all x/y draws through this affine transform.
    x_scale = 0.95
    x_offset = 8.0
    y_scale = 0.85
    y_offset = 60.0

    def map_xy(x: float, top_from_page_top: float) -> tuple[float, float]:
        nx = (x * x_scale) + x_offset
        ny_top = (top_from_page_top * y_scale) + y_offset
        # Convert to reportlab bottom-left origin
        return nx, (height - ny_top)

    def draw_txt(x: float, top: float, text_value, size: int = 8):
        s = str(text_value or "").strip()
        if not s:
            return
        px, py = map_xy(x, top)
        if py < 0 or py > height:
            return
        c.setFont("Helvetica", size)
        c.drawString(px, py, s)

    def draw_check(x: float, top: float, checked: bool):
        if not checked:
            return
        px, py = map_xy(x, top)
        if py < 0 or py > height:
            return
        c.setFont("Helvetica-Bold", 9)
        c.drawString(px, py, "X")

    # Header/form top rows (write only field values, no extra labels/metadata)
    # Tuned to center values inside the printed boxes on the flattened template.
    row1_top = 34
    row2_top = 61
    row3_top = 87

    draw_txt(18, row1_top, val("report_date"))
    draw_txt(124, row1_top, val("district"))
    draw_txt(194, row1_top, val("county"))
    draw_txt(258, row1_top, val("route"))
    draw_txt(332, row1_top, val("post_mile"))
    draw_txt(392, row1_top, val("ea"))
    draw_txt(448, row1_top, val("project_id"))
    draw_txt(530, row1_top, val("date_incident_reported"), 7)

    draw_txt(33, row2_top, val("latitude"))
    draw_txt(130, row2_top, val("longitude"))

    # District contact rows (from serialized JSON list)
    raw_contacts = val("district_contact")
    contacts: list[dict] = []
    if raw_contacts:
        try:
            parsed = json.loads(raw_contacts)
            if isinstance(parsed, list):
                contacts = [x for x in parsed if isinstance(x, dict)]
        except Exception:
            contacts = []
    c1 = contacts[0] if len(contacts) > 0 else {}
    c2 = contacts[1] if len(contacts) > 1 else {}
    draw_txt(300, row2_top, c1.get("last_name", ""))
    draw_txt(390, row2_top, c1.get("first_name", ""))
    draw_txt(518, row2_top, c1.get("s_number", ""))
    draw_txt(48, row3_top, c2.get("last_name", ""))
    draw_txt(146, row3_top, c2.get("first_name", ""))
    draw_txt(226, row3_top, c2.get("s_number", ""))
    draw_txt(366, row3_top, c2.get("phone", ""))
    draw_txt(500, row3_top, c2.get("cell_phone", ""))

    # Incident Type (left column)
    incident_rows = [
        ("failure_rock_fall", 108),
        ("failure_topple", 126),
        ("failure_slide", 144),
        ("failure_spread", 162),
        ("failure_flow", 180),
        ("failure_compound", 198),
        ("failure_erosion", 216),
        ("failure_surficial_failure", 234),
        ("failure_scoured_toe", 252),
        ("failure_washout", 270),
    ]
    for key, top in incident_rows:
        code_match = {
            "failure_rock_fall": "ROCK_FALL",
            "failure_topple": "TOPPLE",
            "failure_slide": "SLIDE",
            "failure_spread": "SPREAD",
            "failure_flow": "FLOW",
            "failure_compound": "COMPOUND",
            "failure_erosion": "EROSION",
            "failure_surficial_failure": "SURFICIAL_SLOUGHING",
            "failure_scoured_toe": "SCOURED_TOE",
            "failure_washout": "WASHOUT",
        }[key]
        draw_check(12, top, is_on(key) or (code_match in incident_type_codes))

    # Distribution (middle-left column)
    distribution_rows = [
        ("distribution_advancing", "ADVANCING", 108),
        ("distribution_retrogressive", "RETROGRESSING", 126),
        ("distribution_enlarging", "ENLARGING", 144),
        ("distribution_widening", "WIDENING", 162),
        ("distribution_moving", "MOVING", 180),
        ("distribution_confined", "CONFINED", 198),
    ]
    for key, code, top in distribution_rows:
        draw_check(138, top, is_on(key) or val("distribution_code") == code)

    # Highway status
    highway_code = val("highway_status_code")
    draw_check(266, 108, highway_code == "OPEN")
    draw_check(266, 126, highway_code == "SHOULDER_CLOSED")
    draw_check(266, 144, highway_code == "LANES_CLOSED")
    draw_txt(318, 145, val("lanes_closed_count"))
    draw_check(266, 162, highway_code == "ONE_WAY_CLOSED")
    draw_check(266, 180, highway_code == "TWO_WAY_CLOSED")

    # Material + Soil estimates
    draw_check(12, 292, is_on("material_rock"))
    draw_check(12, 310, is_on("material_bedding"))
    draw_check(12, 328, is_on("material_joints"))
    draw_check(12, 346, is_on("material_fractures"))
    draw_check(92, 292, is_on("material_soil"))
    draw_txt(108, 292, val("est_soil_pct"))
    draw_txt(108, 310, val("est_clay_pct"))
    draw_txt(108, 328, val("est_silt_pct"))
    draw_txt(108, 346, val("est_sand_pct"))
    draw_txt(108, 364, val("est_gravel_pct"))

    # Water content
    draw_check(188, 292, is_on("water_dry"))
    draw_check(188, 310, is_on("water_moist"))
    draw_check(188, 328, is_on("water_wet"))
    draw_check(188, 346, is_on("water_flowing"))
    draw_check(206, 364, is_on("water_seep"))
    draw_check(206, 382, is_on("water_spring"))

    # Pavement / Ground Status
    draw_check(266, 218, is_on("pavement_ground_cracks"))
    draw_txt(315, 218, val("crack_length_ft"))
    draw_txt(315, 236, val("crack_horizontal_in"))
    draw_txt(315, 254, val("crack_vertical_in"))
    draw_txt(315, 272, val("crack_depth_in"))
    draw_txt(315, 290, val("settlement_in"))
    draw_txt(315, 308, val("bulge_in"))
    draw_check(265, 326, is_on("indented_by_rocks"))

    # Vegetation on slope
    draw_txt(98, 419, val("vegetation_trees"))
    draw_txt(98, 447, val("vegetation_bushes_shrubs"))
    draw_txt(98, 475, val("vegetation_groundcover"))

    # Water / Drainage
    draw_check(266, 364, is_on("drainage_clogged_inlet"))
    draw_check(266, 382, is_on("drainage_compromised_drains"))
    draw_check(266, 400, is_on("drainage_surface_runoff"))
    draw_check(266, 418, is_on("drainage_torrent_surge_flood"))

    # Impacted / May be impacted matrix
    draw_check(266, 442, is_on("impact_impacted_adj_utilities"))
    draw_check(309, 442, is_on("impact_maybe_adj_utilities"))
    draw_check(266, 460, is_on("impact_impacted_adj_properties"))
    draw_check(309, 460, is_on("impact_maybe_adj_properties"))
    draw_check(266, 478, is_on("impact_impacted_adj_structure"))
    draw_check(309, 478, is_on("impact_maybe_adj_structure"))

    # Recommended actions matrix
    action_rows = [
        ("OPEN_HIGHWAY_TRAFFIC", True, True, 108),
        ("CLOSE_HIGHWAY_SHOULDER", True, True, 126),
        ("CLOSE_HIGHWAY_PARENT", True, False, 144),
        ("REMOVE_DEBRIS", True, False, 162),
        ("PLACE_K_RAIL", True, False, 180),
        ("COVER_SLOPE_PLASTIC", True, False, 198),
        ("DIVERT_SURFACE_WATER", True, False, 216),
        ("REMOVE_CULVERT_BLOCKAGE", True, False, 234),
        ("DEWATER", True, False, 252),
        ("DEWATER_HORIZONTAL_DRAINS", True, True, 270),
        ("TEMP_SHORING", True, True, 288),
        ("BUTTRESS_TOE", True, True, 306),
        ("PLACE_ROCK_SLOPE_PROTECTION", True, True, 324),
        ("ROUTINE_VISUAL_MONITOR", True, True, 342),
        ("RECONSTRUCT_SLOPE", True, True, 360),
        ("RECONSTRUCT_SLOPE_GEOSYNTHETICS", True, True, 378),
        ("REPAIR_CULVERT_DRAINAGE_PIPE", False, True, 396),
        ("EROSION_CONTROL", False, True, 414),
        ("SURVEY_SITE_DIST_SURVEY", False, True, 432),
        ("GEOLOGIC_MAPPING", False, True, 450),
        ("SUBSURFACE_EXPLORATION", False, True, 468),
        ("DETAILED_DESIGN_PLANS", False, True, 486),
    ]
    for code, allow_immediate, allow_follow, top in action_rows:
        imm_selected = False
        fol_selected = False
        if code == "CLOSE_HIGHWAY_PARENT":
            imm_selected = ("CLOSE_ONE_DIRECTION" in immediate) or ("CLOSE_BOTH_DIRECTIONS" in immediate)
        else:
            imm_selected = code in immediate
        if code != "CLOSE_HIGHWAY_PARENT":
            fol_selected = code in follow_up
        if allow_immediate:
            draw_check(442, top, imm_selected)
        if allow_follow:
            draw_check(468, top, fol_selected)

    # Child controls for unique actions
    draw_txt(540, 108, val("lanes_closed_count"))  # Open Highway Traffic lanes
    draw_check(542, 144, "CLOSE_ONE_DIRECTION" in immediate)
    draw_check(578, 144, "CLOSE_BOTH_DIRECTIONS" in immediate)

    # Measurements
    draw_txt(137, 564, val("measure_slope_height_ft"))
    draw_txt(137, 590, val("measure_original_slope_deg"))
    draw_txt(137, 616, val("measure_landslide_width_ft"))
    draw_txt(137, 642, val("measure_landslide_length_ft"))
    draw_txt(137, 668, val("measure_main_scarp_height_ft"))
    draw_txt(137, 694, val("measure_landslide_slope_deg"))
    draw_txt(170, 720, val("measure_roadway_length_ft"))
    draw_txt(170, 746, val("measure_roadway_width_ft"))

    # Notes
    draw_txt(18, 776, val("observations_notes"), 7)

    c.save()
    overlay_io.seek(0)
    overlay_page = PdfReader(overlay_io).pages[0]

    base_page.merge_page(overlay_page)
    out_writer = PdfWriter()
    for page in base_reader.pages:
        out_writer.add_page(page)
    out_io = BytesIO()
    out_writer.write(out_io)
    return out_io.getvalue()


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

class SubmissionPermissionsReplace(BaseModel):
    reader_user_ids: list[int] = []
    editor_user_ids: list[int] = []

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

    failure_rock_fall: bool | None = None
    failure_topple: bool | None = None
    failure_slide: bool | None = None
    failure_spread: bool | None = None
    failure_flow: bool | None = None
    failure_compound: bool | None = None
    failure_erosion: bool | None = None
    failure_surficial_failure: bool | None = None
    failure_scoured_toe: bool | None = None
    failure_washout: bool | None = None

    distribution_advancing: bool | None = None
    distribution_retrogressive: bool | None = None
    distribution_enlarging: bool | None = None
    distribution_widening: bool | None = None
    distribution_moving: bool | None = None
    distribution_confined: bool | None = None

    material_rock: bool | None = None
    material_soil: bool | None = None
    material_bedding: bool | None = None
    material_joints: bool | None = None
    material_fractures: bool | None = None

    est_soil_pct: float | None = None
    est_clay_pct: float | None = None
    est_silt_pct: float | None = None
    est_sand_pct: float | None = None
    est_gravel_pct: float | None = None

    water_dry: bool | None = None
    water_moist: bool | None = None
    water_wet: bool | None = None
    water_flowing: bool | None = None
    water_seep: bool | None = None
    water_spring: bool | None = None

    vegetation_trees: str | None = None
    vegetation_bushes_shrubs: str | None = None
    vegetation_groundcover: str | None = None

    drainage_clogged_inlet: bool | None = None
    drainage_compromised_drains: bool | None = None
    drainage_surface_runoff: bool | None = None
    drainage_torrent_surge_flood: bool | None = None

    impact_impacted_adj_utilities: bool | None = None
    impact_maybe_adj_utilities: bool | None = None
    impact_adj_utilities: str | None = None
    impact_impacted_adj_properties: bool | None = None
    impact_maybe_adj_properties: bool | None = None
    impact_adj_properties: str | None = None
    impact_impacted_adj_structure: bool | None = None
    impact_maybe_adj_structure: bool | None = None
    impact_adj_structure: str | None = None

    measure_slope_height_ft: float | None = None
    measure_original_slope_deg: float | None = None
    measure_landslide_width_ft: float | None = None
    measure_landslide_length_ft: float | None = None
    measure_main_scarp_height_ft: float | None = None
    measure_landslide_slope_deg: float | None = None
    measure_roadway_length_ft: float | None = None
    measure_roadway_width_ft: float | None = None

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


@app.get("/geo/enrich-point")
def enrich_point(
    lat: float,
    lon: float,
    user=Depends(get_current_user),
):
    if lat < -90 or lat > 90 or lon < -180 or lon > 180:
        raise HTTPException(status_code=422, detail="Invalid latitude/longitude range")

    reverse_info = _reverse_geocode_arcgis(lat, lon)
    layer_info = _query_postmile_layer(lat, lon)

    return {
        "latitude": lat,
        "longitude": lon,
        "district": layer_info.get("district"),
        "county": layer_info.get("county") or reverse_info.get("county"),
        "route": layer_info.get("route") or reverse_info.get("route"),
        "post_mile": layer_info.get("post_mile"),
        "source": {
            "reverse_geocode": reverse_info.get("source_reverse"),
            "postmile_layer": layer_info.get("source_postmile"),
            "requested_by_user_id": user["id"],
        },
    }


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
    where_clause = "WHERE s.created_by_user_id = :uid OR v.user_id IS NOT NULL OR e.user_id IS NOT NULL"
    if status:
        where_clause = f"{where_clause} AND s.status = :status"

    rows = db.execute(text("""
        SELECT DISTINCT s.id, s.created_by_user_id, s.status, s.client_submission_uuid, s.title,
               s.created_at, s.submitted_at, s.reviewed_at,
               g.district, g.county, g.route, g.post_mile
        FROM submissions s
        LEFT JOIN submission_visibility v
          ON v.submission_id = s.id AND v.user_id = :uid
        LEFT JOIN submission_editors e
          ON e.submission_id = s.id AND e.user_id = :uid
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
        "submission": {
            **dict(sub),
            "can_edit": can_edit_submission(db, user=user, submission_id=submission_id),
            "can_manage_permissions": can_manage_submission_permissions(db, user=user, submission_id=submission_id),
        },
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
    require_can_edit_submission(submission_id, db, user)
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
    current_status = get_submission_status(db, submission_id)
    if current_status != "DRAFT":
        raise HTTPException(
            status_code=409,
            detail="Only DRAFT submissions can be deleted",
        )

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
    require_can_edit_submission(submission_id, db, user)

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
    require_can_edit_submission(submission_id, db, user)

    current_status = get_submission_status(db, submission_id)
    if current_status not in {"DRAFT", "REJECTED"}:
        raise HTTPException(status_code=409, detail="Only DRAFT or REJECTED submissions can be edited")

    provided = payload.model_dump(exclude_unset=True)
    if not provided:
        return {"submission_id": submission_id, "gisa": get_gisa(db, submission_id)}

    # UI may send null for unchecked boolean chips; DB columns are NOT NULL TINYINT.
    # Normalize null -> False so "unchecked" persists safely.
    boolean_not_null_fields = {
        "pavement_ground_cracks",
        "indented_by_rocks",
        "failure_rock_fall",
        "failure_topple",
        "failure_slide",
        "failure_spread",
        "failure_flow",
        "failure_compound",
        "failure_erosion",
        "failure_surficial_failure",
        "failure_scoured_toe",
        "failure_washout",
        "distribution_advancing",
        "distribution_retrogressive",
        "distribution_enlarging",
        "distribution_widening",
        "distribution_moving",
        "distribution_confined",
        "material_rock",
        "material_soil",
        "material_bedding",
        "material_joints",
        "material_fractures",
        "water_dry",
        "water_moist",
        "water_wet",
        "water_flowing",
        "water_seep",
        "water_spring",
        "drainage_clogged_inlet",
        "drainage_compromised_drains",
        "drainage_surface_runoff",
        "drainage_torrent_surge_flood",
        "impact_impacted_adj_utilities",
        "impact_maybe_adj_utilities",
        "impact_impacted_adj_properties",
        "impact_maybe_adj_properties",
        "impact_impacted_adj_structure",
        "impact_maybe_adj_structure",
    }
    for key in boolean_not_null_fields:
        if key in provided and provided[key] is None:
            provided[key] = False

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
    require_can_edit_submission(submission_id, db, user)
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
    require_can_edit_submission(submission_id, db, user)
    if get_submission_status(db, submission_id) not in {"DRAFT", "REJECTED"}:
        raise HTTPException(status_code=409, detail="Only DRAFT or REJECTED submissions can be edited")

    def validate_action(code: str, group: str):
        row = db.execute(text("""
            SELECT 1 FROM gisa_action_lut WHERE code=:c LIMIT 1
        """), {"c": code}).scalar()
        if not row:
            raise HTTPException(status_code=400, detail=f"Invalid action: {code}")

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
    user=Depends(require_roles(["FIELD_WORKER", "ADMIN"]))
):
    require_can_manage_submission_permissions(submission_id, db, user)
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
    user=Depends(require_roles(["FIELD_WORKER", "ADMIN"]))
):
    require_can_manage_submission_permissions(submission_id, db, user)
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
    user=Depends(get_current_user)
):
    require_can_view_submission(submission_id, db, user)
    rows = db.execute(text("""
        SELECT v.user_id, u.email, u.full_name, v.granted_by_user_id, v.created_at
        FROM submission_visibility v
        JOIN users u ON u.id = v.user_id
        WHERE v.submission_id = :sid
        ORDER BY v.created_at ASC
    """), {"sid": submission_id}).mappings().all()

    return {"items": [dict(r) for r in rows]}


@app.get("/submissions/{submission_id}/permissions")
def get_submission_permissions(
    submission_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    require_can_view_submission(submission_id, db, user)
    owner = db.execute(text("""
        SELECT u.id, u.email, u.full_name
        FROM submissions s
        JOIN users u ON u.id = s.created_by_user_id
        WHERE s.id = :sid
        LIMIT 1
    """), {"sid": submission_id}).mappings().first()
    if not owner:
        raise HTTPException(status_code=404, detail="Submission not found")

    readers = db.execute(text("""
        SELECT v.user_id, u.email, u.full_name
        FROM submission_visibility v
        JOIN users u ON u.id = v.user_id
        WHERE v.submission_id = :sid
        ORDER BY u.full_name ASC, u.email ASC
    """), {"sid": submission_id}).mappings().all()

    editors = db.execute(text("""
        SELECT e.user_id, u.email, u.full_name
        FROM submission_editors e
        JOIN users u ON u.id = e.user_id
        WHERE e.submission_id = :sid
        ORDER BY u.full_name ASC, u.email ASC
    """), {"sid": submission_id}).mappings().all()

    can_manage = can_manage_submission_permissions(db, user=user, submission_id=submission_id)
    available_users: list[dict] = []
    if can_manage:
        available_users = [dict(r) for r in db.execute(text("""
            SELECT id, email, full_name
            FROM users
            WHERE is_active = 1 AND id <> :owner_id
            ORDER BY full_name ASC, email ASC
            LIMIT 500
        """), {"owner_id": int(owner["id"])}).mappings().all()]

    return {
        "owner": dict(owner),
        "readers": [dict(r) for r in readers],
        "editors": [dict(r) for r in editors],
        "can_manage": can_manage,
        "available_users": available_users,
    }


@app.put("/submissions/{submission_id}/permissions")
def replace_submission_permissions(
    submission_id: int = Path(..., ge=1),
    payload: SubmissionPermissionsReplace = ...,
    db: Session = Depends(get_db),
    user=Depends(require_roles(["FIELD_WORKER", "ADMIN"])),
):
    require_can_manage_submission_permissions(submission_id, db, user)

    owner_id = db.execute(text("""
        SELECT created_by_user_id
        FROM submissions
        WHERE id = :sid
        LIMIT 1
    """), {"sid": submission_id}).scalar()
    if owner_id is None:
        raise HTTPException(status_code=404, detail="Submission not found")

    reader_ids = sorted({int(x) for x in (payload.reader_user_ids or []) if int(x) > 0})
    editor_ids = sorted({int(x) for x in (payload.editor_user_ids or []) if int(x) > 0})

    if int(owner_id) in reader_ids:
        reader_ids.remove(int(owner_id))
    if int(owner_id) in editor_ids:
        editor_ids.remove(int(owner_id))

    target_ids = sorted(set(reader_ids + editor_ids))
    if target_ids:
        placeholders = ",".join([f":u{i}" for i in range(len(target_ids))])
        params = {f"u{i}": uid for i, uid in enumerate(target_ids)}
        rows = db.execute(text(f"""
            SELECT id
            FROM users
            WHERE is_active = 1 AND id IN ({placeholders})
        """), params).scalars().all()
        existing = {int(x) for x in rows}
        missing = [uid for uid in target_ids if uid not in existing]
        if missing:
            raise HTTPException(status_code=400, detail=f"Unknown or inactive user ids: {missing}")

    try:
        db.execute(text("DELETE FROM submission_visibility WHERE submission_id = :sid"), {"sid": submission_id})
        db.execute(text("DELETE FROM submission_editors WHERE submission_id = :sid"), {"sid": submission_id})

        for uid in reader_ids:
            db.execute(text("""
                INSERT INTO submission_visibility (submission_id, user_id, granted_by_user_id)
                VALUES (:sid, :uid, :granted_by)
            """), {"sid": submission_id, "uid": uid, "granted_by": user["id"]})

        for uid in editor_ids:
            db.execute(text("""
                INSERT INTO submission_editors (submission_id, user_id, granted_by_user_id)
                VALUES (:sid, :uid, :granted_by)
            """), {"sid": submission_id, "uid": uid, "granted_by": user["id"]})

        db.commit()
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))

    return {"ok": True, "reader_user_ids": reader_ids, "editor_user_ids": editor_ids}

# ----------------------------
# Attachment download URLs
# ----------------------------

@app.post("/submissions/{submission_id}/gisa/pdf")
def generate_submission_gisa_pdf(
    submission_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    require_can_view_submission(submission_id, db, user)

    try:
        pdf_bytes = _render_gisa_pdf_bytes(db, submission_id)
    except HTTPException as exc:
        logger.exception("GISA PDF render failed (HTTPException) submission_id=%s user_id=%s detail=%s", submission_id, user.get("id"), exc.detail)
        raise
    except Exception:
        logger.exception("GISA PDF render failed (unexpected) submission_id=%s user_id=%s", submission_id, user.get("id"))
        raise
    filename = f"gisa-{submission_id}.pdf"
    content_type = "application/pdf"
    bucket = settings.MINIO_BUCKET
    sha256 = hashlib.sha256(pdf_bytes).hexdigest()

    existing = db.execute(text("""
        SELECT a.id, a.storage_key, a.storage_bucket
        FROM attachment_links al
        JOIN attachments a ON a.id = al.attachment_id
        WHERE al.submission_id = :sid
          AND al.kind = 'DOC'
          AND a.file_name = :fname
        ORDER BY a.id DESC
        LIMIT 1
    """), {"sid": submission_id, "fname": filename}).mappings().first()

    try:
        if existing:
            attachment_id = int(existing["id"])
            object_key = str(existing["storage_key"] or "").strip() or make_object_key(filename)
            put_object_bytes(
                object_key=object_key,
                data=pdf_bytes,
                content_type=content_type,
                bucket=bucket,
            )
            db.execute(text("""
                UPDATE attachments
                SET created_by_user_id = :uid,
                    storage_provider = 'minio',
                    storage_bucket = :bucket,
                    storage_key = :storage_key,
                    file_name = :file_name,
                    mime_type = :mime_type,
                    file_size_bytes = :size_bytes,
                    sha256 = :sha256,
                    uploaded_at = NOW()
                WHERE id = :aid
            """), {
                "uid": user["id"],
                "bucket": bucket,
                "storage_key": object_key,
                "file_name": filename,
                "mime_type": content_type,
                "size_bytes": len(pdf_bytes),
                "sha256": sha256,
                "aid": attachment_id,
            })
        else:
            object_key = make_object_key(filename)
            put_object_bytes(
                object_key=object_key,
                data=pdf_bytes,
                content_type=content_type,
                bucket=bucket,
            )
            db.execute(text("""
                INSERT INTO attachments (
                    created_by_user_id, storage_provider, storage_bucket, storage_key,
                    file_name, mime_type, file_size_bytes, sha256, uploaded_at
                ) VALUES (
                    :uid, 'minio', :bucket, :storage_key,
                    :file_name, :mime_type, :size_bytes, :sha256, NOW()
                )
            """), {
                "uid": user["id"],
                "bucket": bucket,
                "storage_key": object_key,
                "file_name": filename,
                "mime_type": content_type,
                "size_bytes": len(pdf_bytes),
                "sha256": sha256,
            })
            attachment_id = int(db.execute(text("SELECT LAST_INSERT_ID()")).scalar())
            next_sort = db.execute(text("""
                SELECT COALESCE(MAX(sort_order), -1) + 1
                FROM attachment_links
                WHERE submission_id = :sid
            """), {"sid": submission_id}).scalar()
            db.execute(text("""
                INSERT INTO attachment_links (submission_id, attachment_id, kind, sort_order)
                VALUES (:sid, :aid, 'DOC', :sort_order)
            """), {"sid": submission_id, "aid": attachment_id, "sort_order": int(next_sort or 0)})

        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        logger.error(
            "Failed to store generated PDF submission_id=%s user_id=%s",
            submission_id,
            user.get("id"),
            exc_info=exc,
        )
        raise HTTPException(status_code=500, detail="Failed to generate PDF")

    return {
        "submission_id": submission_id,
        "attachment_id": attachment_id,
        "file_name": filename,
        "content_type": content_type,
        "file_size_bytes": len(pdf_bytes),
        "sha256": sha256,
        "download_url": presign_get(object_key, bucket=bucket, expires_seconds=900),
        "expires_seconds": 900,
    }


@app.get("/submissions/{submission_id}/gisa/pdf")
def get_submission_gisa_pdf(
    submission_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    require_can_view_submission(submission_id, db, user)
    filename = f"gisa-{submission_id}.pdf"

    row = db.execute(text("""
        SELECT a.id, a.file_name, a.mime_type, a.file_size_bytes, a.sha256, a.storage_bucket, a.storage_key, a.uploaded_at
        FROM attachment_links al
        JOIN attachments a ON a.id = al.attachment_id
        WHERE al.submission_id = :sid
          AND al.kind = 'DOC'
          AND a.file_name = :fname
        ORDER BY a.id DESC
        LIMIT 1
    """), {"sid": submission_id, "fname": filename}).mappings().first()

    if not row:
        raise HTTPException(status_code=404, detail="No generated GISA PDF found for this submission")

    return {
        "submission_id": submission_id,
        "attachment_id": int(row["id"]),
        "file_name": row["file_name"],
        "content_type": row["mime_type"],
        "file_size_bytes": row["file_size_bytes"],
        "sha256": row["sha256"],
        "uploaded_at": row["uploaded_at"],
        "download_url": presign_get(str(row["storage_key"]), bucket=row["storage_bucket"], expires_seconds=900),
        "expires_seconds": 900,
    }

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
    require_can_edit_submission(submission_id, db, user)
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

import logging
import math
from contextlib import asynccontextmanager
import json
import re
import hashlib
from io import BytesIO
from pathlib import Path as FilePath
from urllib.parse import urlencode
from urllib.request import urlopen

from fastapi import FastAPI, Depends, HTTPException, Path, status, Response, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session
from sqlalchemy import text
from reportlab.pdfgen import canvas
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ContentStream

from .db import get_db
from .config import settings
from .auth import decode_token
from .deps import get_current_user, require_roles
from .storage import ensure_bucket, ensure_bucket_exists, bucket_exists, make_object_key, put_object_stream, put_object_bytes, presign_get, get_object_bytes, object_access_url, stat_object, sha256_of_object
from .dev_routes import router as dev_router
from .admin_users import router as admin_users_router
from .photos import router as photos_router
from .routes.auth import router as auth_router
from .routes.arcgis import router as arcgis_router
from .routes.gisa import router as gisa_router
from .migrations_check import check_migration_head
from .routes.incidents import router as incidents_router
from .routes.assessments import router as assessments_router
from .routes.workflow_tree import router as workflow_tree_router
from .routes.road_inventory import router as road_inventory_router
from .permissions import is_admin, is_reviewer, is_operational_user, require_is_owner_or_admin
from .precision import normalize_post_mile, normalize_route, round_coordinate
from .user_metadata import parse_user_metadata
from .schemas.common import (
    ElevationProfileRequest,
    GeometryResponse,
    GeometryUpsert,
    GisaDraftPatch,
    NotifyCoordinatorAction,
    ReplaceActions,
    ReplaceIncidentTypes,
    ReviewAction,
    ShareRequest,
    SubmissionCreate,
    SubmissionPermissionsReplace,
    SubmissionTitlePatch,
    TerrainGridRequest,
    OfflineScenePackageRegister,
    WorkflowAction,
)
from .services import elevation_profile as elevation_profile_svc
from .services import offline_scene as offline_scene_svc
from .services import offline_scene_jobs as offline_scene_jobs_svc
from .services.offline_scene_catalog import register_ready_package, PackageRegistrationError
from .services import terrain_grid as terrain_grid_svc
from .services.gisa_validation import (
    validate_action_code_group,
    validate_distribution_code,
    validate_highway_status_code,
    validate_incident_type_codes,
)



logger = logging.getLogger("eris.api")
GENERIC_SERVER_ERROR_DETAIL = "Internal server error"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        ensure_bucket()
    except Exception as exc:
        if settings.ENV.lower() == "dev":
            logger.warning("MinIO not available during startup: %s", exc)
        else:
            raise
    check_migration_head()
    yield


app = FastAPI(title="ERIS React Native Prototype API", lifespan=lifespan)

if settings.ENV.lower() == "dev":
    app.include_router(dev_router)
app.include_router(admin_users_router)
app.include_router(photos_router)
app.include_router(auth_router)
app.include_router(arcgis_router)
app.include_router(gisa_router)
app.include_router(incidents_router)
app.include_router(assessments_router)
app.include_router(workflow_tree_router)
app.include_router(road_inventory_router)

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
        # 503 = dependency/service unavailable: pass through the controlled detail so
        # clients know which upstream service failed.  500/502/504 mask the detail.
        detail = exc.detail if exc.status_code == 503 else GENERIC_SERVER_ERROR_DETAIL
        return JSONResponse(status_code=exc.status_code, content={"detail": detail})
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


# ----------------------------
# Helpers: roles + visibility
# ----------------------------

def can_view_submission(db: Session, *, user: dict, submission_id: int) -> bool:
    # Broad visibility: any non-maintenance operational user (admin, coordinator,
    # office/branch chief, engineer, legacy reviewer) may READ submissions /
    # assessment technical forms. Maintenance field workers remain restricted to
    # records they own or were explicitly granted. Write access is unchanged.
    if is_admin(user) or is_reviewer(user) or is_operational_user(user):
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
        SELECT id, email, full_name, is_active, metadata_json
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
        "metadata": parse_user_metadata(user.get("metadata_json")),
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
    return normalize_route(m.group(1) if m else None)


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
        "route": normalize_route(route),
        "post_mile": normalize_post_mile(post_mile),
        "source_postmile": "arcgis_postmile_layer",
    }


def _safe_float(value) -> float | None:
    """Parse value to a finite float, or return None."""
    if value is None:
        return None
    try:
        f = float(value)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def _extract_arcgis_point_geometry(feature: dict) -> tuple[float, float] | None:
    """
    Extract (lat, lon) from an ArcGIS point feature geometry in outSR=4326.
    Returns None if geometry is missing or out-of-range.
    """
    geom = feature.get("geometry")
    if not isinstance(geom, dict):
        return None
    x = _safe_float(geom.get("x"))  # longitude in WGS84
    y = _safe_float(geom.get("y"))  # latitude in WGS84
    if x is None or y is None:
        return None
    if not (-180.0 <= x <= 180.0 and -90.0 <= y <= 90.0):
        return None
    return (y, x)  # (lat, lon)


def _initial_bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Geodesic initial bearing from (lat1, lon1) to (lat2, lon2), in degrees [0, 360).
    Uses the spherical haversine formula.
    """
    lat1r = math.radians(lat1)
    lat2r = math.radians(lat2)
    dlon = math.radians(lon2 - lon1)
    x = math.sin(dlon) * math.cos(lat2r)
    y = math.cos(lat1r) * math.sin(lat2r) - math.sin(lat1r) * math.cos(lat2r) * math.cos(dlon)
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


def _derive_road_bearing_from_postmile_layer(
    lat: float,
    lon: float,
    route: str | None,
    county: str | None,
    post_mile: float | None,
    district: str | None = None,
) -> float | None:
    """
    Derive road bearing (upstation / increasing-postmile direction) by querying the
    ArcGIS postmile feature layer for nearby postmile marker points, then computing
    the geodesic bearing from the nearest lower-PM point to the nearest higher-PM point.

    Returns None when:
    - POSTMILE_FEATURE_LAYER_URL is not configured
    - route, county, or post_mile are unavailable
    - fewer than two valid geometry points are found after filtering
    """
    base = (settings.POSTMILE_FEATURE_LAYER_URL or "").strip().rstrip("/")
    if not base:
        return None
    if route is None or county is None or post_mile is None:
        return None

    search_dist = max(settings.POSTMILE_SEARCH_DISTANCE_METERS, 3200)
    out_fields = ",".join([
        settings.POSTMILE_ROUTE_FIELD,
        settings.POSTMILE_PM_FIELD,
        settings.POSTMILE_COUNTY_FIELD,
        settings.POSTMILE_DISTRICT_FIELD,
    ])
    params = urlencode({
        "f": "pjson",
        "where": settings.POSTMILE_WHERE,
        "geometry": f"{lon},{lat}",
        "geometryType": "esriGeometryPoint",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "distance": str(search_dist),
        "units": "esriSRUnit_Meter",
        "outFields": out_fields,
        "returnGeometry": "true",
        "outSR": "4326",
        "resultRecordCount": "50",
    })
    data = _safe_json_get(f"{base}/query?{params}") or {}
    features = data.get("features")
    if not isinstance(features, list) or not features:
        return None

    norm_route = normalize_route(route) or ""
    norm_county = (_normalize_county(county) or "").lower()

    # Filter features to same route/county/district and extract (pm, lat, lon) triples.
    candidates: list[tuple[float, float, float]] = []
    for feat in features:
        attrs = feat.get("attributes") or {}

        feat_route = normalize_route(str(attrs.get(settings.POSTMILE_ROUTE_FIELD) or "")) or ""
        if feat_route != norm_route:
            continue

        feat_county_raw = attrs.get(settings.POSTMILE_COUNTY_FIELD)
        feat_county = (_normalize_county(str(feat_county_raw)) or "").lower() if feat_county_raw is not None else ""
        if feat_county and norm_county and feat_county != norm_county:
            continue

        if district:
            feat_dist_raw = attrs.get(settings.POSTMILE_DISTRICT_FIELD)
            if feat_dist_raw is not None:
                digits = re.sub(r"\D", "", str(feat_dist_raw))
                feat_dist_norm = digits.zfill(2) if digits else str(feat_dist_raw).strip()
                if feat_dist_norm != district:
                    continue

        feat_pm = _safe_float(attrs.get(settings.POSTMILE_PM_FIELD))
        if feat_pm is None:
            continue

        pt = _extract_arcgis_point_geometry(feat)
        if pt is None:
            continue

        candidates.append((feat_pm, pt[0], pt[1]))

    if len(candidates) < 2:
        return None

    # Choose the nearest lower-PM and nearest higher-PM points to straddle current PM.
    lower = sorted([(pm, plat, plon) for pm, plat, plon in candidates if pm <= post_mile],
                   key=lambda t: t[0], reverse=True)
    higher = sorted([(pm, plat, plon) for pm, plat, plon in candidates if pm > post_mile],
                    key=lambda t: t[0])

    if lower and higher:
        p1 = lower[0]   # nearest lower PM
        p2 = higher[0]  # nearest higher PM
    else:
        # All markers on one side — use the two with smallest and largest PM.
        candidates_sorted = sorted(candidates, key=lambda t: t[0])
        p1, p2 = candidates_sorted[0], candidates_sorted[-1]

    bearing = _initial_bearing_deg(p1[1], p1[2], p2[1], p2[2])
    return round(bearing, 2)


# ----------------------------
# GISA helpers
# ----------------------------

def get_gisa(db: Session, submission_id: int) -> dict | None:
    row = db.execute(text("""
        SELECT
          submission_id,
          location_id,
          report_date, district, county, route, post_mile, ea, project_id,
          date_incident_reported, district_contact,
          latitude, longitude,
          distribution_code, highway_status_cause, highway_status_code, lanes_closed_count, open_highway_traffic_lanes_count,
          pavement_ground_cracks,
          crack_length_ft, crack_horizontal_in, crack_vertical_in, crack_depth_in,
          settlement_in, bulge_in, indented_by_rocks,
          pavement_ground_annotation_layout_json,
          failure_rock_fall, failure_topple, failure_slide, failure_spread, failure_flow,
          failure_compound, failure_erosion, failure_surficial_failure, failure_scoured_toe, failure_washout,
          incident_type_description,
          distribution_advancing, distribution_retrogressive, distribution_enlarging, distribution_widening, distribution_moving, distribution_confined,
          material_rock, material_soil, material_bedding, material_joints, material_fractures, material_pavement_type,
          est_soil_pct, est_rock_pct, est_clay_pct, est_silt_pct, est_sand_pct, est_gravel_pct, est_boulder_pct,
          est_debris_clay_silt_pct, est_debris_sand_pct, est_debris_gravel_pct, est_debris_boulder_pct,
          water_dry, water_moist, water_wet, water_flowing, water_seep, water_spring,
          vegetation_trees, vegetation_bushes_shrubs, vegetation_groundcover,
          drainage_clogged_inlet, drainage_compromised_drains, drainage_surface_runoff, drainage_torrent_surge_flood,
          impact_impacted_adj_utilities, impact_maybe_adj_utilities, impact_adj_utilities,
          impact_impacted_adj_properties, impact_maybe_adj_properties, impact_adj_properties,
          impact_impacted_adj_structure, impact_maybe_adj_structure, impact_adj_structure,
          measure_slope_height_ft, measure_original_slope_deg, measure_landslide_width_ft, measure_landslide_length_ft,
          measure_main_scarp_height_ft, measure_landslide_slope_deg, measure_roadway_length_ft, measure_roadway_width_ft,
          record_of_event_notes, maintenance_history_notes, geotechnical_assessment_notes, recommendations_notes, sketchpad_notes,
          observations_notes, geometry_json,
          road_inventory_dataset_version_id, road_inventory_segment_id,
          road_inventory_snapshot_json, road_inventory_match_method, road_inventory_checked_at,
          elevation_profile_json, elevation_profile_source, elevation_profile_checked_at,
          elevation_profile_classification, elevation_profile_confidence, elevation_profile_error,
          elevation_terrain_grid_json, elevation_terrain_source, elevation_terrain_checked_at, elevation_terrain_error,
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
    if isinstance(d.get("pavement_ground_annotation_layout_json"), str):
        try:
            d["pavement_ground_annotation_layout_json"] = json.loads(d["pavement_ground_annotation_layout_json"])
        except Exception:
            pass

    # Build nested road_inventory_context from flat DB columns.
    ri_snapshot = d.pop("road_inventory_snapshot_json", None)
    if isinstance(ri_snapshot, str):
        try:
            ri_snapshot = json.loads(ri_snapshot)
        except Exception:
            ri_snapshot = None
    ri_dvid = d.pop("road_inventory_dataset_version_id", None)
    ri_sid = d.pop("road_inventory_segment_id", None)
    ri_method = d.pop("road_inventory_match_method", None)
    ri_at = d.pop("road_inventory_checked_at", None)
    if ri_dvid is not None:
        d["road_inventory_context"] = {
            "dataset_version_id": int(ri_dvid),
            "segment_id": int(ri_sid) if ri_sid is not None else None,
            "match_method": ri_method,
            "checked_at": ri_at,
            "snapshot": ri_snapshot,
        }
    else:
        d["road_inventory_context"] = None

    # Build nested elevation_profile from flat DB columns.
    ep_json_raw = d.pop("elevation_profile_json", None)
    if isinstance(ep_json_raw, str):
        try:
            ep_json_raw = json.loads(ep_json_raw)
        except Exception:
            ep_json_raw = None
    ep_source = d.pop("elevation_profile_source", None)
    ep_at = d.pop("elevation_profile_checked_at", None)
    ep_class = d.pop("elevation_profile_classification", None)
    ep_conf = d.pop("elevation_profile_confidence", None)
    ep_err = d.pop("elevation_profile_error", None)
    if ep_source is not None or ep_at is not None:
        ep_reason = None
        if isinstance(ep_json_raw, dict):
            ep_meta = ep_json_raw.get("metadata")
            if isinstance(ep_meta, dict):
                ep_reason = ep_meta.get("classification_reason")
        d["elevation_profile"] = {
            "source": ep_source,
            "checked_at": str(ep_at) if ep_at is not None else None,
            "classification": ep_class,
            "classification_reason": ep_reason,
            "confidence": float(ep_conf) if ep_conf is not None else None,
            "profile": ep_json_raw,
            "error": ep_err,
        }
    else:
        d["elevation_profile"] = None

    # Build nested elevation_terrain (3D Terrain grid) from flat DB columns.
    et_grid_raw = d.pop("elevation_terrain_grid_json", None)
    if isinstance(et_grid_raw, str):
        try:
            et_grid_raw = json.loads(et_grid_raw)
        except Exception:
            et_grid_raw = None
    et_source = d.pop("elevation_terrain_source", None)
    et_at = d.pop("elevation_terrain_checked_at", None)
    et_err = d.pop("elevation_terrain_error", None)
    if et_source is not None or et_at is not None:
        # The stored JSON already carries source/checked_at/grid/bearing/error; the
        # flat columns are a fast index. Return the full stored object when present.
        if isinstance(et_grid_raw, dict):
            d["elevation_terrain"] = et_grid_raw
        else:
            d["elevation_terrain"] = {
                "source": et_source,
                "checked_at": str(et_at) if et_at is not None else None,
                "error": et_err,
                "grid": None,
            }
    else:
        d["elevation_terrain"] = None

    # Normalize MySQL/MariaDB tinyint(1) values to JSON booleans for API consistency.
    bool_fields = {
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
    for key in bool_fields:
        if key in d and d[key] is not None:
            d[key] = bool(d[key])
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
    if not str(gisa.get("geotechnical_assessment_notes") or "").strip():
        missing.append("geotechnical_assessment")

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

    def validate_percent_total(pct_fields: list[str], missing_key: str) -> None:
        total = 0.0
        pct_invalid = False
        for key in pct_fields:
            raw = gisa.get(key)
            if raw is None or str(raw).strip() == "":
                value = 0.0
            else:
                try:
                    value = float(raw)
                except Exception:
                    pct_invalid = True
                    break
            total += value
        if pct_invalid:
            missing.append(f"{missing_key}(type)")
        elif abs(total - 100.0) > 0.0001:
            missing.append(f"{missing_key}_total({total:.2f})")

    # Submit-time business rule:
    # Drafts may keep partial percentages, but selected/filled material
    # composition groups must total exactly 100 at submit.
    material_soil_selected = bool(gisa.get("material_soil"))
    if material_soil_selected:
        validate_percent_total(["est_clay_pct", "est_silt_pct", "est_sand_pct", "est_gravel_pct", "est_boulder_pct"], "soil_pct")

    debris_pct_fields = [
        "est_debris_clay_silt_pct",
        "est_debris_sand_pct",
        "est_debris_gravel_pct",
        "est_debris_boulder_pct",
    ]
    debris_pct_entered = any(gisa.get(key) is not None and str(gisa.get(key)).strip() != "" for key in debris_pct_fields)
    if debris_pct_entered:
        validate_percent_total(debris_pct_fields, "debris_pct")

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

    # Body placement is calibrated against label anchors extracted from the template.
    # This avoids manual pixel nudging when template render characteristics vary.
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

    def draw_txt_pt(x: float, y: float, text_value, size: int = 8):
        s = str(text_value or "").strip()
        if not s:
            return
        if y < 0 or y > height:
            return
        c.setFont("Helvetica", size)
        c.drawString(x, y, s)

    def draw_check(x: float, top: float, checked: bool):
        if not checked:
            return
        px, py = map_xy(x, top)
        if py < 0 or py > height:
            return
        # Draw a geometric X centered in the checkbox to avoid font-baseline drift.
        # Coordinates are interpreted as checkbox top-left in template space.
        size = 10.0
        inset = 2.0
        top_y = py
        left_x = px
        right_x = left_x + size
        bottom_y = top_y - size
        c.setLineWidth(1.1)
        c.line(left_x + inset, top_y - inset, right_x - inset, bottom_y + inset)
        c.line(left_x + inset, bottom_y + inset, right_x - inset, top_y - inset)

    def draw_check_tight(
        x: float,
        top: float,
        checked: bool,
        *,
        size: float = 8.0,
        inset: float = 1.2,
    ):
        if not checked:
            return
        px, py = map_xy(x, top)
        if py < 0 or py > height:
            return
        right_x = px + size
        bottom_y = py - size
        c.setLineWidth(1.0)
        c.line(px + inset, py - inset, right_x - inset, bottom_y + inset)
        c.line(px + inset, bottom_y + inset, right_x - inset, py - inset)

    def draw_check_tight_pt(
        x: float,
        y_top: float,
        checked: bool,
        *,
        size: float = 8.0,
        inset: float = 1.2,
    ):
        if not checked:
            return
        if y_top < 0 or y_top > height:
            return
        right_x = x + size
        bottom_y = y_top - size
        c.setLineWidth(1.0)
        c.line(x + inset, y_top - inset, right_x - inset, bottom_y + inset)
        c.line(x + inset, bottom_y + inset, right_x - inset, y_top - inset)

    def draw_check_in_rect_pt(rect: tuple[float, float, float, float], checked: bool):
        if not checked:
            return
        rx, ry, rw, rh = rect
        if rw <= 0 or rh <= 0:
            return
        inset = max(1.0, min(rw, rh) * 0.18)
        c.setLineWidth(1.0)
        c.line(rx + inset, ry + inset, rx + rw - inset, ry + rh - inset)
        c.line(rx + inset, ry + rh - inset, rx + rw - inset, ry + inset)

    def extract_text_anchors(page) -> dict[str, list[tuple[float, float]]]:
        labels = {
            "Date",
            "District",
            "County",
            "Route",
            "Post Mile",
            "EA (6 digits)",
            "Project ID (10 digits)",
            "Date Incident Reported",
            "Latitude",
            "Longitude",
            "District Contact",
            "Last Name",
            "First Name",
            "S Number",
            "Phone",
            "Cell Phone",
            # Body calibration anchors
            "Incident Type",
            "Highway Status",
            "Measurements",
        }
        out: dict[str, list[tuple[float, float]]] = {k: [] for k in labels}

        def visitor(text, cm, tm, font_dict, font_size):
            raw = str(text or "").strip()
            if not raw:
                return
            norm = " ".join(raw.split())
            if norm not in labels:
                return
            # Convert text space to PDF user space (points)
            x = (tm[4] * cm[0]) + (tm[5] * cm[2]) + cm[4]
            y = (tm[4] * cm[1]) + (tm[5] * cm[3]) + cm[5]
            out[norm].append((float(x), float(y)))

        page.extract_text(visitor_text=visitor)
        for k, pts in out.items():
            # Top-most first; tie-break left-most first.
            out[k] = sorted(pts, key=lambda p: (-p[1], p[0]))
        return out

    def extract_all_text_positions(page) -> list[tuple[str, float, float]]:
        out: list[tuple[str, float, float]] = []

        def visitor(text, cm, tm, font_dict, font_size):
            raw = str(text or "").strip()
            if not raw:
                return
            norm = " ".join(raw.split())
            x = (tm[4] * cm[0]) + (tm[5] * cm[2]) + cm[4]
            y = (tm[4] * cm[1]) + (tm[5] * cm[3]) + cm[5]
            out.append((norm, float(x), float(y)))

        page.extract_text(visitor_text=visitor)
        out.sort(key=lambda t: (-t[2], t[1]))
        return out

    def extract_rects(page) -> list[tuple[float, float, float, float]]:
        """
        Extract checkbox rectangles from vector path ops.

        This template does not emit `re` operators for most checkboxes; instead it
        draws box outlines with path ops (`m/l/h`) followed by paint ops (`S`/`f`).
        We therefore parse path segments and recover axis-aligned rectangles.
        """
        rects: list[tuple[float, float, float, float]] = []
        try:
            content = ContentStream(page.get_contents(), page.pdf)

            subpaths: list[list[tuple[float, float]]] = []
            current_path: list[tuple[float, float]] = []
            # PDF CTM in affine form: [a b c d e f]
            ctm: tuple[float, float, float, float, float, float] = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
            ctm_stack: list[tuple[float, float, float, float, float, float]] = []

            def mul_affine(
                m1: tuple[float, float, float, float, float, float],
                m2: tuple[float, float, float, float, float, float],
            ) -> tuple[float, float, float, float, float, float]:
                a1, b1, c1, d1, e1, f1 = m1
                a2, b2, c2, d2, e2, f2 = m2
                return (
                    (a1 * a2) + (c1 * b2),
                    (b1 * a2) + (d1 * b2),
                    (a1 * c2) + (c1 * d2),
                    (b1 * c2) + (d1 * d2),
                    (a1 * e2) + (c1 * f2) + e1,
                    (b1 * e2) + (d1 * f2) + f1,
                )

            def tx_point(x: float, y: float) -> tuple[float, float]:
                a, b, c_, d, e, f = ctm
                return ((a * x) + (c_ * y) + e, (b * x) + (d * y) + f)

            def maybe_add_rect_from_points(points: list[tuple[float, float]]) -> None:
                if not points or len(points) < 4:
                    return
                pts = points[:]
                if pts[0] == pts[-1]:
                    pts = pts[:-1]
                xs = sorted({round(p[0], 3) for p in pts})
                ys = sorted({round(p[1], 3) for p in pts})
                if len(xs) != 2 or len(ys) != 2:
                    return
                w = float(abs(xs[1] - xs[0]))
                h = float(abs(ys[1] - ys[0]))
                # Keep plausible form boxes/frames; filter out lines.
                if w >= 6.0 and h >= 6.0:
                    rects.append((float(xs[0]), float(ys[0]), w, h))

            def flush_path(paint: bool) -> None:
                nonlocal subpaths, current_path
                if current_path:
                    subpaths.append(current_path)
                    current_path = []
                if paint:
                    for sp in subpaths:
                        maybe_add_rect_from_points(sp)
                subpaths = []

            for operands, operator in content.operations:
                if operator == b"q":
                    ctm_stack.append(ctm)
                    continue
                if operator == b"Q":
                    if ctm_stack:
                        ctm = ctm_stack.pop()
                    continue
                if operator == b"cm" and len(operands) == 6:
                    cm_op = tuple(float(v) for v in operands)
                    ctm = mul_affine(cm_op, ctm)
                    continue

                if operator == b"m" and len(operands) >= 2:
                    if current_path:
                        subpaths.append(current_path)
                    current_path = [tx_point(float(operands[0]), float(operands[1]))]
                elif operator == b"l" and len(operands) >= 2:
                    if current_path:
                        current_path.append(tx_point(float(operands[0]), float(operands[1])))
                elif operator == b"h":
                    if current_path:
                        current_path.append(current_path[0])
                elif operator == b"re" and len(operands) == 4:
                    x, y, w, h = [float(v) for v in operands]
                    # Transform all 4 corners through CTM then compute axis-aligned bbox.
                    p1 = tx_point(x, y)
                    p2 = tx_point(x + w, y)
                    p3 = tx_point(x + w, y + h)
                    p4 = tx_point(x, y + h)
                    xs = [p1[0], p2[0], p3[0], p4[0]]
                    ys = [p1[1], p2[1], p3[1], p4[1]]
                    rx = min(xs)
                    ry = min(ys)
                    rw = max(xs) - rx
                    rh = max(ys) - ry
                    if rw >= 6.0 and rh >= 6.0:
                        rects.append((rx, ry, rw, rh))
                elif operator in (b"S", b"s", b"f", b"F", b"f*", b"B", b"B*", b"b", b"b*"):
                    flush_path(paint=True)
                elif operator == b"n":
                    flush_path(paint=False)

        except Exception:
            return []

        # Deduplicate near-identical inner/outer outlines.
        dedup: dict[tuple[int, int, int, int], tuple[float, float, float, float]] = {}
        for x, y, w, h in rects:
            key = (int(round(x * 2)), int(round(y * 2)), int(round(w * 2)), int(round(h * 2)))
            # Keep the larger rectangle if nearly identical keys collide.
            prev = dedup.get(key)
            if not prev or (w * h) > (prev[2] * prev[3]):
                dedup[key] = (x, y, w, h)

        out = list(dedup.values())
        out.sort(key=lambda r: (r[1], r[0]))
        return out

    anchors = extract_text_anchors(base_page)
    all_text_positions = extract_all_text_positions(base_page)
    all_rects = extract_rects(base_page)
    checkbox_rects = [
        r for r in all_rects
        if 8.0 <= r[2] <= 25.0 and 8.0 <= r[3] <= 25.0
    ]
    text_rects = [
        r for r in all_rects
        # Include taller input rectangles (e.g., the OHT "Lanes" box can exceed 26pt high).
        if 9.0 <= r[3] <= 44.0 and 25.0 <= r[2] <= 260.0
    ]
    logger.info(
        "GISA rect extraction all=%d checkbox=%d text=%d",
        len(all_rects),
        len(checkbox_rects),
        len(text_rects),
    )

    def find_text_anchor_prefix(prefix: str) -> tuple[float, float] | None:
        p = prefix.strip().lower()
        for txt, x, y in all_text_positions:
            if txt.lower().startswith(p):
                return (x, y)
        return None

    def find_text_anchor_exact(text: str, *, occurrence: int = 0) -> tuple[float, float] | None:
        target = text.strip().lower()
        hits: list[tuple[float, float]] = []
        for txt, x, y in all_text_positions:
            if txt.strip().lower() == target:
                hits.append((x, y))
        if occurrence >= len(hits):
            return None
        return hits[occurrence]

    # Calibrate map_xy from real template anchors (fallback to defaults above).
    # Design coordinates are in the same top-origin coordinate space used below.
    def anchor_point(label: str, occurrence: int = 0) -> tuple[float, float] | None:
        pts = anchors.get(label) or []
        if occurrence >= len(pts):
            return None
        return pts[occurrence]

    # X calibration: Incident Type (left) -> Highway Status (middle)
    ax1 = anchor_point("Incident Type")
    ax2 = anchor_point("Highway Status")
    if ax1 and ax2 and abs(266.0 - 12.0) > 1e-6:
        x_scale = (ax2[0] - ax1[0]) / (266.0 - 12.0)
        x_offset = ax1[0] - (12.0 * x_scale)

    # Y calibration (top-from-page-top): Incident Type (upper body) -> Measurements (lower body)
    ay1 = anchor_point("Incident Type")
    ay2 = anchor_point("Measurements")
    if ay1 and ay2 and abs(555.0 - 96.0) > 1e-6:
        top1 = height - ay1[1]
        top2 = height - ay2[1]
        y_scale = (top2 - top1) / (555.0 - 96.0)
        y_offset = top1 - (96.0 * y_scale)
    logger.info(
        "GISA body calibration x_scale=%.6f x_offset=%.3f y_scale=%.6f y_offset=%.3f",
        x_scale,
        x_offset,
        y_scale,
        y_offset,
    )

    def draw_from_anchor(label: str, occurrence: int, x_pad: float, y_above_label: float, text_value, size: int = 8) -> bool:
        pts = anchors.get(label) or []
        if occurrence >= len(pts):
            return False
        ax, ay = pts[occurrence]
        draw_txt_pt(ax + x_pad, ay + y_above_label, text_value, size=size)
        return True

    def row_boxes_left_of_label(
        ax: float,
        ay: float,
        *,
        x_window: float = 120.0,
        y_tol: float = 8.0,
    ) -> list[tuple[float, float, float, float]]:
        # Match checkbox rectangles around the label baseline, then keep those to the left.
        cands: list[tuple[float, float, float, float]] = []
        for rx, ry, rw, rh in checkbox_rects:
            cy = ry + (rh * 0.5)
            if abs(cy - ay) <= y_tol and rx < ax and (ax - rx) <= x_window:
                cands.append((rx, ry, rw, rh))
        cands.sort(key=lambda r: r[0])
        return cands

    def row_boxes_by_y(
        ay: float,
        *,
        x_min: float,
        x_max: float,
        y_tol: float = 8.0,
    ) -> list[tuple[float, float, float, float]]:
        # Restrict to a horizontal band and x-range. Useful where label text is ambiguous.
        cands: list[tuple[float, float, float, float]] = []
        for rx, ry, rw, rh in checkbox_rects:
            cy = ry + (rh * 0.5)
            if abs(cy - ay) <= y_tol and x_min <= rx <= x_max:
                cands.append((rx, ry, rw, rh))
        cands.sort(key=lambda r: r[0])
        return cands

    def find_oht_lanes_rect(
        oht_anchor: tuple[float, float],
    ) -> tuple[float, float, float, float] | None:
        # Resolve the exact "Open Highway Traffic ... [box] Lanes" field using geometry, not hardcoded coords.
        ox, oy = oht_anchor
        lane_labels: list[tuple[float, float]] = []
        for txt, tx, ty in all_text_positions:
            if txt.strip().lower() == "lanes" and tx > (ox + 120.0) and abs(ty - oy) <= 16.0:
                lane_labels.append((tx, ty))
        if not lane_labels:
            return None
        lane_labels.sort(key=lambda p: (abs(p[1] - oy), p[0]))
        lx, ly = lane_labels[0]
        row_mid_x = ox + ((lx - ox) * 0.5)

        # Candidate input rectangles near the row, immediately left of the "Lanes" text.
        cands: list[tuple[float, tuple[float, float, float, float]]] = []
        for rx, ry, rw, rh in all_rects:
            cy = ry + (rh * 0.5)
            right = rx + rw
            gap = lx - right
            if not (35.0 <= rw <= 130.0 and 12.0 <= rh <= 44.0):
                continue
            if abs(cy - ly) > 14.0:
                continue
            if not (-4.0 <= gap <= 34.0):
                continue
            # Keep the match on the right side of the Open Highway Traffic row text.
            if rx < row_mid_x:
                continue
            score = (abs(cy - ly) * 4.0) + abs(gap)
            cands.append((score, (rx, ry, rw, rh)))
        if not cands:
            return None
        cands.sort(key=lambda t: t[0])
        return cands[0][1]

    def rect_center_x(rect: tuple[float, float, float, float]) -> float:
        return rect[0] + (rect[2] * 0.5)

    def pick_box_nearest_x(
        boxes: list[tuple[float, float, float, float]],
        target_x: float,
        *,
        exclude_idx: set[int] | None = None,
    ) -> tuple[int, tuple[float, float, float, float]] | None:
        ex = exclude_idx or set()
        cands: list[tuple[float, int, tuple[float, float, float, float]]] = []
        for i, b in enumerate(boxes):
            if i in ex:
                continue
            cands.append((abs(rect_center_x(b) - target_x), i, b))
        if not cands:
            return None
        cands.sort(key=lambda t: t[0])
        _, idx, rect = cands[0]
        return (idx, rect)

    def row_boxes_for_prefix(
        label_prefix: str,
        *,
        occurrence: int = 0,
        x_window: float = 140.0,
        y_tol: float = 8.0,
    ) -> list[tuple[float, float, float, float]]:
        p = label_prefix.strip().lower()
        matches: list[tuple[float, float]] = []
        for txt, x, y in all_text_positions:
            if txt.lower().startswith(p):
                matches.append((x, y))
        if occurrence >= len(matches):
            return []
        ax, ay = matches[occurrence]
        return row_boxes_left_of_label(ax, ay, x_window=x_window, y_tol=y_tol)

    def draw_check_for_prefix(
        label_prefix: str,
        checked: bool,
        *,
        occurrence: int = 0,
        from_right: int = 0,
        x_window: float = 140.0,
        y_tol: float = 8.0,
    ) -> bool:
        boxes = row_boxes_for_prefix(
            label_prefix,
            occurrence=occurrence,
            x_window=x_window,
            y_tol=y_tol,
        )
        if not boxes:
            return False
        idx = max(0, len(boxes) - 1 - from_right)
        draw_check_in_rect_pt(boxes[idx], checked)
        return True

    def draw_text_in_rect_pt(
        rect: tuple[float, float, float, float],
        text_value,
        *,
        size: int = 8,
        align: str = "left",
        pad: float = 2.0,
    ) -> bool:
        s = str(text_value or "").strip()
        if not s:
            return False
        rx, ry, rw, rh = rect
        if rw <= 0 or rh <= 0:
            return False
        c.setFont("Helvetica", size)
        baseline = ry + max(1.0, (rh - size) * 0.5)
        if align == "center":
            tw = c.stringWidth(s, "Helvetica", size)
            x = rx + max(pad, (rw - tw) * 0.5)
        elif align == "right":
            tw = c.stringWidth(s, "Helvetica", size)
            x = rx + max(pad, rw - tw - pad)
        else:
            x = rx + pad
        c.drawString(x, baseline, s)
        return True

    def nearest_text_rect_for_anchor(
        ax: float,
        ay: float,
        *,
        relation: str = "above",
        x_window: float = 180.0,
        y_window: float = 50.0,
    ) -> tuple[float, float, float, float] | None:
        cands: list[tuple[float, tuple[float, float, float, float]]] = []
        for r in text_rects:
            rx, ry, rw, rh = r
            cx = rx + (rw * 0.5)
            cy = ry + (rh * 0.5)
            ok = False
            dx = 0.0
            dy = 0.0
            if relation == "above":
                ok = (cy > ay) and (cy - ay <= y_window) and (abs(cx - ax) <= x_window)
                dx = abs(cx - ax)
                dy = (cy - ay) if cy > ay else 9999.0
            elif relation == "right":
                ok = (rx > ax) and (rx - ax <= x_window) and (abs(cy - ay) <= y_window)
                dx = (rx - ax) if rx > ax else 9999.0
                dy = abs(cy - ay)
            elif relation == "left":
                right = rx + rw
                ok = (right < ax) and (ax - right <= x_window) and (abs(cy - ay) <= y_window)
                dx = (ax - right) if right < ax else 9999.0
                dy = abs(cy - ay)
            elif relation == "same_row":
                ok = abs(cy - ay) <= y_window and abs(cx - ax) <= x_window
                dx = abs(cx - ax)
                dy = abs(cy - ay)
            if ok:
                cands.append(((dy * 4.0) + dx + (rw * 0.001), r))
        if not cands:
            return None
        cands.sort(key=lambda t: t[0])
        return cands[0][1]

    def draw_value_from_prefix_rect(
        prefix: str,
        text_value,
        *,
        occurrence: int = 0,
        relation: str = "above",
        align: str = "left",
        size: int = 8,
        x_window: float = 180.0,
        y_window: float = 50.0,
        pad: float = 2.0,
    ) -> bool:
        p = prefix.strip().lower()
        hits: list[tuple[float, float]] = []
        for txt, x, y in all_text_positions:
            if txt.lower().startswith(p):
                hits.append((x, y))
        if occurrence >= len(hits):
            return False
        ax, ay = hits[occurrence]
        rect = nearest_text_rect_for_anchor(
            ax,
            ay,
            relation=relation,
            x_window=x_window,
            y_window=y_window,
        )
        if not rect:
            return False
        return draw_text_in_rect_pt(rect, text_value, size=size, align=align, pad=pad)

    # Header/form top rows (prefer rectangle-based text placement).
    y_above = 14.0
    ok = True
    # Row 1
    ok &= (
        draw_value_from_prefix_rect("Date", val("report_date"), relation="above", align="center", size=7, x_window=70, y_window=34)
        or draw_from_anchor("Date", 0, -12, y_above, val("report_date"))
    )
    ok &= (
        draw_value_from_prefix_rect("District", val("district"), relation="above", align="center", x_window=70, y_window=34)
        or draw_from_anchor("District", 0, 2, y_above, val("district"))
    )
    ok &= (
        draw_value_from_prefix_rect("County", val("county"), relation="above", align="center", x_window=70, y_window=34)
        or draw_from_anchor("County", 0, 2, y_above, val("county"))
    )
    ok &= (
        draw_value_from_prefix_rect("Route", val("route"), relation="above", align="center", x_window=70, y_window=34)
        or draw_from_anchor("Route", 0, 2, y_above, val("route"))
    )
    ok &= (
        draw_value_from_prefix_rect("Post Mile", val("post_mile"), relation="above", align="center", x_window=70, y_window=34)
        or draw_from_anchor("Post Mile", 0, 2, y_above, val("post_mile"))
    )
    ok &= (
        draw_value_from_prefix_rect("EA (6 digits)", val("ea"), relation="above", align="center", size=7, x_window=90, y_window=34)
        or draw_from_anchor("EA (6 digits)", 0, 2, y_above, val("ea"))
    )
    ok &= (
        draw_value_from_prefix_rect("Project ID (10 digits)", val("project_id"), relation="above", align="center", size=7, x_window=95, y_window=34)
        or draw_from_anchor("Project ID (10 digits)", 0, 2, y_above, val("project_id"))
    )
    ok &= (
        draw_value_from_prefix_rect("Date Incident Reported", val("date_incident_reported"), relation="above", align="center", size=6, x_window=85, y_window=34)
        or draw_from_anchor("Date Incident Reported", 0, 2, y_above, val("date_incident_reported"), size=7)
    )

    # Row 2
    ok &= (
        draw_value_from_prefix_rect("Latitude", val("latitude"), relation="above", align="left", x_window=90, y_window=34)
        or draw_from_anchor("Latitude", 0, -10, y_above, val("latitude"))
    )
    ok &= (
        draw_value_from_prefix_rect("Longitude", val("longitude"), relation="above", align="left", x_window=90, y_window=34)
        or draw_from_anchor("Longitude", 0, 2, y_above, val("longitude"))
    )

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
    ok &= (
        draw_value_from_prefix_rect("Last Name", c1.get("last_name", ""), occurrence=0, relation="above", x_window=110, y_window=34)
        or draw_from_anchor("Last Name", 0, 2, y_above, c1.get("last_name", ""))
    )
    ok &= (
        draw_value_from_prefix_rect("First Name", c1.get("first_name", ""), occurrence=0, relation="above", x_window=110, y_window=34)
        or draw_from_anchor("First Name", 0, 2, y_above, c1.get("first_name", ""))
    )
    ok &= (
        draw_value_from_prefix_rect("S Number", c1.get("s_number", ""), occurrence=0, relation="above", align="center", x_window=110, y_window=34)
        or draw_from_anchor("S Number", 0, 2, y_above, c1.get("s_number", ""))
    )
    # Row 3 (second contact)
    ok &= (
        draw_value_from_prefix_rect("Last Name", c2.get("last_name", ""), occurrence=1, relation="above", x_window=120, y_window=34)
        or draw_from_anchor("Last Name", 1, 2, y_above, c2.get("last_name", ""))
    )
    ok &= (
        draw_value_from_prefix_rect("First Name", c2.get("first_name", ""), occurrence=1, relation="above", x_window=120, y_window=34)
        or draw_from_anchor("First Name", 1, 2, y_above, c2.get("first_name", ""))
    )
    ok &= (
        draw_value_from_prefix_rect("S Number", c2.get("s_number", ""), occurrence=1, relation="above", align="center", x_window=120, y_window=34)
        or draw_from_anchor("S Number", 1, 2, y_above, c2.get("s_number", ""))
    )
    c_phone = c1.get("phone", "")
    c_cell = c1.get("cell_phone", "")
    ok &= (
        draw_value_from_prefix_rect("Phone", c_phone, relation="above", x_window=120, y_window=34)
        or draw_from_anchor("Phone", 0, 2, y_above, c_phone)
    )
    ok &= (
        draw_value_from_prefix_rect("Cell Phone", c_cell, relation="above", x_window=120, y_window=34)
        or draw_from_anchor("Cell Phone", 0, 2, y_above, c_cell)
    )

    # Fallback: if anchors fail for any reason, keep approximate hardcoded placement.
    if not ok:
        row1_top = 24
        row2_top = 52
        row3_top = 81
        draw_txt(6, row1_top, val("report_date"))
        draw_txt(110, row1_top, val("district"))
        draw_txt(180, row1_top, val("county"))
        draw_txt(244, row1_top, val("route"))
        draw_txt(318, row1_top, val("post_mile"))
        draw_txt(378, row1_top, val("ea"))
        draw_txt(434, row1_top, val("project_id"))
        draw_txt(516, row1_top, val("date_incident_reported"), 7)
        draw_txt(24, row2_top, val("latitude"))
        draw_txt(130, row2_top, val("longitude"))
        draw_txt(300, row2_top, c1.get("last_name", ""))
        draw_txt(390, row2_top, c1.get("first_name", ""))
        draw_txt(518, row2_top, c1.get("s_number", ""))
        draw_txt(48, row3_top, c2.get("last_name", ""))
        draw_txt(146, row3_top, c2.get("first_name", ""))
        draw_txt(226, row3_top, c2.get("s_number", ""))
        draw_txt(366, row3_top, c1.get("phone", ""))
        draw_txt(500, row3_top, c1.get("cell_phone", ""))

    # Incident Type (left column) - rectangle detected checkboxes
    incident_rows = [
        ("failure_rock_fall", "ROCK_FALL", ["(Rock) Fall"]),
        ("failure_topple", "TOPPLE", ["Topple"]),
        ("failure_slide", "SLIDE", ["Slide"]),
        ("failure_spread", "SPREAD", ["Spread"]),
        ("failure_flow", "FLOW", ["Flow"]),
        ("failure_compound", "COMPOUND", ["Compound"]),
        ("failure_erosion", "EROSION", ["Erosion"]),
        # Template text can vary between "Surficial" and "Surfacial".
        ("failure_surficial_failure", "SURFICIAL_SLOUGHING", ["Surficial Sloughing", "Surfacial Sloughing"]),
        ("failure_scoured_toe", "SCOURED_TOE", ["Scoured Toe"]),
        ("failure_washout", "WASHOUT", ["Washout"]),
    ]
    for key, code_match, label_prefixes in incident_rows:
        checked = is_on(key) or (code_match in incident_type_codes)
        if not checked:
            continue
        placed = False
        for label_prefix in label_prefixes:
            placed = draw_check_for_prefix(label_prefix, True, x_window=160.0)
            if placed:
                break

    # Distribution (middle-left column) - rectangle detected checkboxes
    distribution_rows = [
        ("distribution_advancing", "ADVANCING", "Advancing"),
        ("distribution_retrogressive", "RETROGRESSING", "Retrogressing"),
        ("distribution_enlarging", "ENLARGING", "Enlarging"),
        ("distribution_widening", "WIDENING", "Widening"),
        ("distribution_moving", "MOVING", "Moving"),
        ("distribution_confined", "CONFINED", "Confined"),
    ]
    for key, code, label_prefix in distribution_rows:
        draw_check_for_prefix(
            label_prefix,
            is_on(key) or val("distribution_code") == code,
            x_window=170.0,
        )

    # Highway status - rectangle detected checkboxes
    highway_code = val("highway_status_code")
    draw_check_for_prefix("Open", highway_code == "OPEN", x_window=160.0)
    draw_check_for_prefix("Shoulder Closed", highway_code == "SHOULDER_CLOSED", x_window=160.0)
    draw_check_for_prefix("Lane(s) Closed", highway_code == "LANES_CLOSED", x_window=160.0)
    # Only render Highway Status lane count when Lane(s) Closed is selected.
    if highway_code == "LANES_CLOSED":
        (
            draw_value_from_prefix_rect("Lane(s) Closed", val("lanes_closed_count"), relation="right", align="center", x_window=120, y_window=14)
            or draw_txt(352, 146, val("lanes_closed_count"))
        )
    draw_check_for_prefix("One-way Closed", highway_code == "ONE_WAY_CLOSED", x_window=160.0)
    draw_check_for_prefix("Two-way Closed", highway_code == "TWO_WAY_CLOSED", x_window=160.0)

    # Material + Soil estimates (checkboxes via rectangle detection)
    draw_check_for_prefix("Rock", is_on("material_rock"), x_window=120.0)
    draw_check_for_prefix("Bedding", is_on("material_bedding"), x_window=120.0)
    draw_check_for_prefix("Joints", is_on("material_joints"), x_window=120.0)
    draw_check_for_prefix("Fractures", is_on("material_fractures"), x_window=120.0)
    draw_check_for_prefix("Soil", is_on("material_soil"), x_window=120.0)
    draw_txt(108, 292, val("est_soil_pct"))
    draw_txt(108, 310, val("est_clay_pct"))
    draw_txt(108, 328, val("est_silt_pct"))
    draw_txt(108, 346, val("est_sand_pct"))
    draw_txt(108, 364, val("est_gravel_pct"))

    # Water content (checkboxes via rectangle detection)
    draw_check_for_prefix("Dry", is_on("water_dry"), x_window=120.0)
    draw_check_for_prefix("Moist", is_on("water_moist"), x_window=120.0)
    draw_check_for_prefix("Wet", is_on("water_wet"), x_window=120.0)
    draw_check_for_prefix("Flowing", is_on("water_flowing"), x_window=120.0)
    draw_check_for_prefix("Seep", is_on("water_seep"), x_window=120.0)
    draw_check_for_prefix("Spring", is_on("water_spring"), x_window=120.0)

    # Pavement / Ground Status (checkboxes via rectangle detection)
    draw_check_for_prefix("Pavement/Ground Cracks", is_on("pavement_ground_cracks"), x_window=140.0)
    (
        draw_value_from_prefix_rect("feet, Length", val("crack_length_ft"), relation="left", align="center", x_window=100, y_window=12)
        or draw_txt(315, 218, val("crack_length_ft"))
    )
    (
        draw_value_from_prefix_rect("inches, Horizontal Disp.", val("crack_horizontal_in"), relation="left", align="center", x_window=120, y_window=12)
        or draw_txt(315, 236, val("crack_horizontal_in"))
    )
    (
        draw_value_from_prefix_rect("inches, Vertical Disp.", val("crack_vertical_in"), relation="left", align="center", x_window=120, y_window=12)
        or draw_txt(315, 254, val("crack_vertical_in"))
    )
    (
        draw_value_from_prefix_rect("inches, Depth of Crack", val("crack_depth_in"), relation="left", align="center", x_window=120, y_window=12)
        or draw_txt(315, 272, val("crack_depth_in"))
    )
    # Settlement/Bulge rows are one row lower than crack-depth on this template.
    (
        draw_value_from_prefix_rect("Settlement", val("settlement_in"), relation="right", align="center", x_window=100, y_window=14)
        or draw_txt(315, 308, val("settlement_in"))
    )
    (
        draw_value_from_prefix_rect("Bulge", val("bulge_in"), relation="right", align="center", x_window=100, y_window=14)
        or draw_txt(315, 326, val("bulge_in"))
    )
    draw_check_for_prefix("Indented by Rocks", is_on("indented_by_rocks"), x_window=140.0)

    # Vegetation on slope
    # Coverage values belong in the right-side "Coverage %" column boxes.
    (
        draw_value_from_prefix_rect("Trees", val("vegetation_trees"), relation="right", align="center", x_window=130, y_window=16)
        or draw_txt(145, 423, val("vegetation_trees"))
    )
    (
        draw_value_from_prefix_rect("Bushes/Shrubs", val("vegetation_bushes_shrubs"), relation="right", align="center", x_window=130, y_window=16)
        or draw_txt(145, 447, val("vegetation_bushes_shrubs"))
    )
    (
        draw_value_from_prefix_rect("Groundcover", val("vegetation_groundcover"), relation="right", align="center", x_window=130, y_window=16)
        or draw_txt(145, 471, val("vegetation_groundcover"))
    )

    # Water / Drainage (checkboxes via rectangle detection)
    draw_check_for_prefix("Clogged Inlet", is_on("drainage_clogged_inlet"), x_window=150.0)
    draw_check_for_prefix("Compromised Drains", is_on("drainage_compromised_drains"), x_window=150.0)
    draw_check_for_prefix("Surface Runoff", is_on("drainage_surface_runoff"), x_window=150.0)
    draw_check_for_prefix("Torrent, Surge, Flood", is_on("drainage_torrent_surge_flood"), x_window=150.0)

    # Impacted / May be impacted matrix (two checkboxes per row)
    draw_check_for_prefix("Adjacent Utilities", is_on("impact_impacted_adj_utilities"), from_right=1, x_window=170.0)
    draw_check_for_prefix("Adjacent Utilities", is_on("impact_maybe_adj_utilities"), from_right=0, x_window=170.0)
    draw_txt(338, 442, val("impact_adj_utilities"), 7)
    draw_check_for_prefix("Adjacent Properties", is_on("impact_impacted_adj_properties"), from_right=1, x_window=170.0)
    draw_check_for_prefix("Adjacent Properties", is_on("impact_maybe_adj_properties"), from_right=0, x_window=170.0)
    draw_txt(338, 460, val("impact_adj_properties"), 7)
    draw_check_for_prefix("Adjacent Structures", is_on("impact_impacted_adj_structure"), from_right=1, x_window=170.0)
    draw_check_for_prefix("Adjacent Structures", is_on("impact_maybe_adj_structure"), from_right=0, x_window=170.0)
    draw_txt(338, 478, val("impact_adj_structure"), 7)

    # Recommended actions matrix
    # Anchor checks to the printed row labels to prevent transform drift.
    action_rows = [
        ("OPEN_HIGHWAY_TRAFFIC", "Open Highway Traffic", True, True),
        ("CLOSE_HIGHWAY_SHOULDER", "Open Highway Shoulder", True, True),
        ("CLOSE_HIGHWAY_PARENT", "Close Highway", True, False),
        ("REMOVE_DEBRIS", "Remove Landslide Debris from the Highway", True, False),
        ("PLACE_K_RAIL", "Place K-Rail or Fence", True, False),
        ("COVER_SLOPE_PLASTIC", "Cover Slope with Plastic", True, False),
        ("DIVERT_SURFACE_WATER", "Divert Surface Water Runoff", True, False),
        ("REMOVE_CULVERT_BLOCKAGE", "Remove Culvert Blockage", True, False),
        ("DEWATER", "Dewater with Pump, Trench, etc.", True, False),
        ("DEWATER_HORIZONTAL_DRAINS", "Dewater with Horizontal Drains", True, True),
        ("TEMP_SHORING", "Construct Temporary Shoring", True, True),
        ("BUTTRESS_TOE", "Buttress Toe of Landslide", True, True),
        ("PLACE_ROCK_SLOPE_PROTECTION", "Place Rock Slope Protection", True, True),
        ("ROUTINE_VISUAL_MONITOR", "Routine Visual Monitor", True, True),
        ("RECONSTRUCT_SLOPE", "Reconstruct Slope to Original Condition", True, True),
        ("RECONSTRUCT_SLOPE_GEOSYNTHETICS", "Reconstruct Slope with Geosynthetics", True, True),
        ("REPAIR_CULVERT_DRAINAGE_PIPE", "Repair Culvert/Drainage Pipe", False, True),
        ("EROSION_CONTROL", "Install Erosion Control", False, True),
        ("SURVEY_SITE_DIST_SURVEY", "Survey the Site - by Dist. Survey", False, True),
        ("GEOLOGIC_MAPPING", "Perform Geological Mapping", False, True),
        ("SUBSURFACE_EXPLORATION", "Perform Subsurface Exploration", False, True),
        ("DETAILED_DESIGN_PLANS", "Perform Detailed Design & Produce Plans", False, True),
    ]
    # Calibrate action columns from the first action row when possible:
    # expected order is [Immediate, Follow-up] from left to right.
    action_immediate_x: float | None = None
    action_followup_x: float | None = None
    sample_anchor = find_text_anchor_prefix("Open Highway Traffic")
    if sample_anchor:
        sboxes = row_boxes_left_of_label(sample_anchor[0], sample_anchor[1], x_window=320.0, y_tol=10.0)
        if len(sboxes) >= 2:
            # Use the two rightmost boxes to avoid accidental captures from other sections.
            pair = sboxes[-2:]
            pair.sort(key=lambda r: r[0])
            action_immediate_x = rect_center_x(pair[0])
            action_followup_x = rect_center_x(pair[1])
    for code, label_prefix, allow_immediate, allow_follow in action_rows:
        imm_selected = False
        fol_selected = False
        if code == "CLOSE_HIGHWAY_PARENT":
            imm_selected = ("CLOSE_ONE_DIRECTION" in immediate) or ("CLOSE_BOTH_DIRECTIONS" in immediate)
        else:
            imm_selected = code in immediate
        if code != "CLOSE_HIGHWAY_PARENT":
            fol_selected = code in follow_up
        row_anchor = find_text_anchor_prefix(label_prefix)
        if not row_anchor:
            continue
        ax, ay = row_anchor
        boxes = row_boxes_left_of_label(ax, ay, x_window=320.0, y_tol=10.0)
        # Some long-label rows can miss one box with narrow window; retry wider.
        if allow_immediate and allow_follow and len(boxes) < 2:
            boxes = row_boxes_left_of_label(ax, ay, x_window=260.0, y_tol=10.0)
        # Some rows have two checkbox columns (immediate + follow-up),
        # while others have only one. Resolve rectangles per row type.
        if allow_immediate and allow_follow:
            immediate_rect = None
            follow_rect = None
            if boxes:
                if action_immediate_x is not None and action_followup_x is not None:
                    # Deterministic per-column routing.
                    used: set[int] = set()
                    pick_imm = pick_box_nearest_x(boxes, action_immediate_x, exclude_idx=used)
                    if pick_imm is not None:
                        used.add(pick_imm[0])
                        immediate_rect = pick_imm[1]
                    pick_fol = pick_box_nearest_x(boxes, action_followup_x, exclude_idx=used)
                    if pick_fol is not None:
                        used.add(pick_fol[0])
                        follow_rect = pick_fol[1]
                else:
                    # Fallback to positional ordering.
                    follow_rect = boxes[-1] if len(boxes) >= 1 else None
                    immediate_rect = boxes[-2] if len(boxes) >= 2 else None
        elif allow_immediate and not allow_follow:
            immediate_rect = boxes[-1] if len(boxes) >= 1 else None
            follow_rect = None
        elif allow_follow and not allow_immediate:
            follow_rect = boxes[-1] if len(boxes) >= 1 else None
            immediate_rect = None
        else:
            follow_rect = None
            immediate_rect = None
        if allow_immediate:
            if immediate_rect:
                draw_check_in_rect_pt(immediate_rect, imm_selected)
        if allow_follow:
            if follow_rect:
                draw_check_in_rect_pt(follow_rect, fol_selected)

    # Child controls for unique actions
    # Separate field from Highway Status lane closure count.
    # Open Highway Traffic lanes (strict row-level text-box detection).
    lanes_drawn = False
    oht_anchor = find_text_anchor_prefix("Open Highway Traffic")
    if oht_anchor:
        lane_box = find_oht_lanes_rect(oht_anchor)
        if lane_box is not None:
            lanes_drawn = draw_text_in_rect_pt(
                lane_box,
                val("open_highway_traffic_lanes_count"),
                align="center",
            )
    # No fallback: only draw when the correct Open Highway Traffic lanes box is detected.
    # Must match the "Close Highway" child options, not "One-way Closed" in Highway Status.
    one_anchor = find_text_anchor_exact("One")
    both_anchor = find_text_anchor_prefix("Both Directions")
    if one_anchor:
        # Exact anchor + left-of-label ensures we target the "One" option checkbox.
        oboxes = row_boxes_left_of_label(one_anchor[0], one_anchor[1], x_window=90.0, y_tol=8.0)
        if oboxes:
            draw_check_in_rect_pt(oboxes[-1], "CLOSE_ONE_DIRECTION" in immediate)
    if both_anchor:
        bboxes = row_boxes_left_of_label(both_anchor[0], both_anchor[1])
        if bboxes:
            draw_check_in_rect_pt(bboxes[-1], "CLOSE_BOTH_DIRECTIONS" in immediate)

    # Measurements
    (
        draw_value_from_prefix_rect("Slope Height, ft (H)", val("measure_slope_height_ft"), relation="right", align="center", x_window=170, y_window=14)
        or draw_txt(137, 564, val("measure_slope_height_ft"))
    )
    (
        draw_value_from_prefix_rect("Original Slope, deg", val("measure_original_slope_deg"), relation="right", align="center", x_window=170, y_window=14)
        or draw_txt(137, 590, val("measure_original_slope_deg"))
    )
    (
        draw_value_from_prefix_rect("Landslide Width, ft", val("measure_landslide_width_ft"), relation="right", align="center", x_window=170, y_window=14)
        or draw_txt(137, 616, val("measure_landslide_width_ft"))
    )
    (
        draw_value_from_prefix_rect("Landslide Length (ft", val("measure_landslide_length_ft"), relation="right", align="center", x_window=170, y_window=14)
        or draw_txt(137, 642, val("measure_landslide_length_ft"))
    )
    (
        draw_value_from_prefix_rect("Main Scarp Height, ft", val("measure_main_scarp_height_ft"), relation="right", align="center", x_window=170, y_window=14)
        or draw_txt(137, 668, val("measure_main_scarp_height_ft"))
    )
    (
        draw_value_from_prefix_rect("Landslide Slope, deg", val("measure_landslide_slope_deg"), relation="right", align="center", x_window=170, y_window=14)
        or draw_txt(137, 694, val("measure_landslide_slope_deg"))
    )
    (
        draw_value_from_prefix_rect("Length of Roadway Encroached, ft", val("measure_roadway_length_ft"), relation="right", align="center", x_window=220, y_window=14)
        or draw_txt(170, 720, val("measure_roadway_length_ft"))
    )
    (
        draw_value_from_prefix_rect("Width of Roadway Encroached, ft", val("measure_roadway_width_ft"), relation="right", align="center", x_window=220, y_window=14)
        or draw_txt(170, 746, val("measure_roadway_width_ft"))
    )

    # Notes
    (
        draw_value_from_prefix_rect("Notes:", val("observations_notes"), relation="right", align="left", size=7, x_window=520, y_window=18, pad=2.0)
        or draw_txt(18, 776, val("observations_notes"), 7)
    )

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


@app.get("/geo/enrich-point")
def enrich_point(
    lat: float,
    lon: float,
    user=Depends(get_current_user),
):
    if lat < -90 or lat > 90 or lon < -180 or lon > 180:
        raise HTTPException(status_code=422, detail="Invalid latitude/longitude range")
    rounded_lat = round_coordinate(lat)
    rounded_lon = round_coordinate(lon)
    if rounded_lat is None or rounded_lon is None:
        raise HTTPException(status_code=422, detail="Invalid latitude/longitude value")

    reverse_info = _reverse_geocode_arcgis(rounded_lat, rounded_lon)
    layer_info = _query_postmile_layer(rounded_lat, rounded_lon)

    return {
        "latitude": rounded_lat,
        "longitude": rounded_lon,
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
               al.kind, al.sort_order, al.section_key
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

    # PATCH semantics: treat null as "no change" for NOT NULL boolean fields.
    # Some clients send nullable booleans in draft payloads; coercing null->False
    # causes unintended checkbox wipes on Save Draft.
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
    for key in list(boolean_not_null_fields):
        if key in provided and provided[key] is None:
            provided.pop(key, None)

    def _to_bool(v):
        if v is True or v == 1 or v == "1":
            return True
        if v is False or v == 0 or v == "0":
            return False
        return None

    def normalize_single_choice(group: list[str]) -> None:
        touched = [k for k in group if k in provided]
        if not touched:
            return
        selected = [k for k in group if _to_bool(provided.get(k)) is True]
        keep = selected[0] if selected else None
        for k in group:
            provided[k] = (k == keep)

    # Material: Soil and Rock can both be selected. Rock subtypes are independent yes/no toggles.
    if any(k in provided for k in ["material_rock", "material_soil", "material_bedding", "material_joints", "material_fractures"]):
        rock_selected = _to_bool(provided.get("material_rock")) is True
        soil_selected = _to_bool(provided.get("material_soil")) is True
        if not rock_selected:
            provided["material_bedding"] = False
            provided["material_joints"] = False
            provided["material_fractures"] = False
            provided["est_rock_pct"] = None
        if not soil_selected:
            provided["est_soil_pct"] = None
            provided["est_clay_pct"] = None
            provided["est_silt_pct"] = None
            provided["est_sand_pct"] = None
            provided["est_gravel_pct"] = None
            provided["est_boulder_pct"] = None

    if "material_pavement_type" in provided:
        raw_pavement_type = provided.get("material_pavement_type")
        if raw_pavement_type is None or str(raw_pavement_type).strip() == "":
            provided["material_pavement_type"] = None
        else:
            pavement_type = str(raw_pavement_type).strip().upper()
            if pavement_type not in {"CONCRETE", "ASPHALT"}:
                raise HTTPException(status_code=400, detail="material_pavement_type must be CONCRETE or ASPHALT")
            provided["material_pavement_type"] = pavement_type

    # Water/Drainage: only one drainage option can be selected.
    normalize_single_choice([
        "drainage_clogged_inlet",
        "drainage_compromised_drains",
        "drainage_surface_runoff",
        "drainage_torrent_surge_flood",
    ])

    # Water Content: one of Dry/Moist/Wet/Flowing. If Flowing, then one of Seep/Spring.
    if any(k in provided for k in ["water_dry", "water_moist", "water_wet", "water_flowing", "water_seep", "water_spring"]):
        normalize_single_choice(["water_dry", "water_moist", "water_wet", "water_flowing"])
        flowing_selected = _to_bool(provided.get("water_flowing")) is True
        if flowing_selected:
            normalize_single_choice(["water_seep", "water_spring"])
        else:
            provided["water_seep"] = False
            provided["water_spring"] = False

    # NOTE:
    # `distribution_code` / `highway_status_code` must allow explicit clear.
    # Clients send null when user deselects a chip; dropping null here prevents
    # unselect from persisting and causes stale values to reappear on reload.

    if "geometry_json" in provided and provided["geometry_json"] is not None:
        provided["geometry_json"] = json.dumps(provided["geometry_json"])
    if "pavement_ground_annotation_layout_json" in provided and provided["pavement_ground_annotation_layout_json"] is not None:
        provided["pavement_ground_annotation_layout_json"] = json.dumps(provided["pavement_ground_annotation_layout_json"])

    if "post_mile" in provided:
        provided["post_mile"] = normalize_post_mile(provided.get("post_mile"))
    if "route" in provided:
        provided["route"] = normalize_route(provided.get("route"))
    if "latitude" in provided:
        provided["latitude"] = round_coordinate(provided.get("latitude"))
    if "longitude" in provided:
        provided["longitude"] = round_coordinate(provided.get("longitude"))

    if provided.get("distribution_code"):
        validate_distribution_code(provided["distribution_code"])
    if provided.get("highway_status_code"):
        validate_highway_status_code(provided["highway_status_code"])

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


def _resolve_gisa_road_bearing(
    lat: float, lon: float, row: dict, payload_bearing: float | None
) -> tuple[float | None, str | None]:
    """Resolve the road bearing for elevation/terrain sampling, in priority order:
    explicit request > road_inventory_snapshot > ArcGIS postmile geometry > None.

    Shared by the elevation-profile and terrain-grid endpoints so a derivable
    bearing reaches USGS sampling on a (forced) refresh in both. Returns
    (bearing_deg_or_None, source_or_None)."""
    if payload_bearing is not None:
        return float(payload_bearing), "request"

    ri_snap_raw = row.get("road_inventory_snapshot_json")
    ri_snap: dict | None = None
    if isinstance(ri_snap_raw, str):
        try:
            ri_snap = json.loads(ri_snap_raw)
        except Exception:
            ri_snap = None
    elif isinstance(ri_snap_raw, dict):
        ri_snap = ri_snap_raw
    if ri_snap:
        snap_bearing = ri_snap.get("road_bearing_deg")
        if snap_bearing is not None:
            try:
                bf = float(snap_bearing)
                if math.isfinite(bf) and 0.0 <= bf < 360.0:
                    return bf, "road_inventory_snapshot"
            except (TypeError, ValueError):
                pass

    # Auto-derive from ArcGIS postmile geometry when request and snapshot are missing.
    try:
        pm_float = _safe_float(row.get("post_mile"))
        auto_bearing = _derive_road_bearing_from_postmile_layer(
            lat=lat,
            lon=lon,
            route=row.get("route") or None,
            county=row.get("county") or None,
            post_mile=pm_float,
            district=row.get("district") or None,
        )
        if auto_bearing is not None:
            return auto_bearing, "arcgis_postmile_geometry"
    except Exception:
        pass  # Network/ArcGIS errors are non-fatal; bearing remains None
    return None, None


@app.post("/submissions/{submission_id}/gisa/elevation-profile")
def enrich_gisa_elevation_profile(
    submission_id: int = Path(..., ge=1),
    payload: ElevationProfileRequest = ElevationProfileRequest(),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    require_can_edit_submission(submission_id, db, user)

    # Read current GISA row for lat/lon, location fields, road inventory snapshot, and existing profile
    row = db.execute(text("""
        SELECT latitude, longitude,
               route, county, post_mile, district,
               road_inventory_snapshot_json,
               elevation_profile_source, elevation_profile_checked_at,
               elevation_profile_classification, elevation_profile_confidence,
               elevation_profile_json, elevation_profile_error
        FROM submission_gisa
        WHERE submission_id = :sid
        LIMIT 1
    """), {"sid": submission_id}).mappings().first()

    if not row:
        raise HTTPException(status_code=404, detail="GISA data not found for this submission")

    lat = row["latitude"]
    lon = row["longitude"]
    if lat is None or lon is None:
        raise HTTPException(
            status_code=400,
            detail="Cannot fetch elevation profile: GISA latitude/longitude are not set",
        )

    force = bool(payload.force) if payload.force is not None else False

    # Return existing profile if present and force not requested
    existing_source = row["elevation_profile_source"]
    if existing_source and not force:
        ep_json_raw = row["elevation_profile_json"]
        if isinstance(ep_json_raw, str):
            try:
                ep_json_raw = json.loads(ep_json_raw)
            except Exception:
                ep_json_raw = None
        ep_conf = row["elevation_profile_confidence"]
        cached_reason = None
        if isinstance(ep_json_raw, dict):
            meta = ep_json_raw.get("metadata")
            if isinstance(meta, dict):
                cached_reason = meta.get("classification_reason")
        return {
            "submission_id": submission_id,
            "elevation_profile": {
                "source": existing_source,
                "checked_at": str(row["elevation_profile_checked_at"]) if row["elevation_profile_checked_at"] else None,
                "classification": row["elevation_profile_classification"],
                "classification_reason": cached_reason,
                "confidence": float(ep_conf) if ep_conf is not None else None,
                "profile": ep_json_raw,
                "error": row["elevation_profile_error"],
            },
        }

    # Resolve road bearing: payload > road_inventory_snapshot > arcgis_postmile_geometry > None
    resolved_bearing, bearing_source = _resolve_gisa_road_bearing(
        float(lat), float(lon), dict(row), payload.road_bearing_deg
    )

    # Fetch from USGS EPQS
    result = elevation_profile_svc.fetch_elevation_profile(
        lat=float(lat),
        lon=float(lon),
        road_bearing_deg=resolved_bearing,
        half_width_m=float(payload.half_width_m) if payload.half_width_m is not None else 60.0,
        spacing_m=float(payload.spacing_m) if payload.spacing_m is not None else 10.0,
    )

    # Inject bearing source into profile metadata
    if isinstance(result.get("profile"), dict) and isinstance(result["profile"].get("metadata"), dict):
        result["profile"]["metadata"]["road_bearing_source"] = bearing_source
        if bearing_source == "arcgis_postmile_geometry":
            result["profile"]["metadata"]["road_bearing_derivation"] = {
                "method": "postmile_points_lower_to_higher",
                "source": settings.POSTMILE_FEATURE_LAYER_URL or "unconfigured",
            }

    profile_json_str = json.dumps(result.get("profile"))

    try:
        db.execute(text("""
            UPDATE submission_gisa
            SET elevation_profile_source         = :source,
                elevation_profile_checked_at     = :checked_at,
                elevation_profile_classification = :classification,
                elevation_profile_confidence     = :confidence,
                elevation_profile_json           = :profile_json,
                elevation_profile_error          = :error
            WHERE submission_id = :sid
        """), {
            "sid": submission_id,
            "source": result["source"],
            "checked_at": result["checked_at"],
            "classification": result["classification"],
            "confidence": result["confidence"],
            "profile_json": profile_json_str,
            "error": result["error"],
        })
        db.commit()
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

    return {
        "submission_id": submission_id,
        "elevation_profile": {
            "source": result["source"],
            "checked_at": result["checked_at"],
            "classification": result["classification"],
            "classification_reason": result.get("classification_reason"),
            "confidence": result["confidence"],
            "profile": result.get("profile"),
            "error": result["error"],
        },
    }


@app.post("/submissions/{submission_id}/gisa/terrain-grid")
def build_gisa_terrain_grid(
    submission_id: int = Path(..., ge=1),
    payload: TerrainGridRequest = TerrainGridRequest(),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Build (and cache) the road-aligned USGS 3DEP terrain elevation grid for
    the '3D Terrain' view. Mirrors the elevation-profile refresh: the grid is
    cached on submission_gisa and only re-queried from USGS when force=true."""
    require_can_edit_submission(submission_id, db, user)

    row = db.execute(text("""
        SELECT latitude, longitude,
               route, county, post_mile, district,
               road_inventory_snapshot_json,
               elevation_terrain_source, elevation_terrain_checked_at,
               elevation_terrain_grid_json, elevation_terrain_error
        FROM submission_gisa
        WHERE submission_id = :sid
        LIMIT 1
    """), {"sid": submission_id}).mappings().first()

    if not row:
        raise HTTPException(status_code=404, detail="GISA data not found for this submission")

    lat = row["latitude"]
    lon = row["longitude"]
    if lat is None or lon is None:
        raise HTTPException(
            status_code=400,
            detail="Cannot build terrain grid: GISA latitude/longitude are not set",
        )

    force = bool(payload.force) if payload.force is not None else False

    # Return the cached grid unless a rebuild is forced (do not re-query USGS).
    existing_source = row["elevation_terrain_source"]
    if existing_source and not force:
        grid_raw = row["elevation_terrain_grid_json"]
        if isinstance(grid_raw, str):
            try:
                grid_raw = json.loads(grid_raw)
            except Exception:
                grid_raw = None
        if isinstance(grid_raw, dict):
            return {"submission_id": submission_id, "terrain": grid_raw, "cached": True}

    resolved_bearing, bearing_source = _resolve_gisa_road_bearing(
        float(lat), float(lon), dict(row), payload.road_bearing_deg
    )

    try:
        result = terrain_grid_svc.fetch_terrain_grid(
            lat=float(lat),
            lon=float(lon),
            road_bearing_deg=resolved_bearing,
            rows=int(payload.rows) if payload.rows is not None else terrain_grid_svc.DEFAULT_ROWS,
            cols=int(payload.columns) if payload.columns is not None else terrain_grid_svc.DEFAULT_COLS,
            along_spacing_m=float(payload.along_spacing_m) if payload.along_spacing_m is not None else terrain_grid_svc.DEFAULT_ALONG_SPACING_M,
            cross_spacing_m=float(payload.cross_spacing_m) if payload.cross_spacing_m is not None else terrain_grid_svc.DEFAULT_CROSS_SPACING_M,
        )
    except terrain_grid_svc.TerrainBuildBusyError as busy:
        # Another terrain build is already sampling USGS EPQS process-wide. Fail
        # fast with a controlled 503 rather than waiting behind it.
        raise HTTPException(status_code=503, detail=str(busy))
    result["road_bearing_source"] = bearing_source

    grid_json_str = json.dumps(result)
    try:
        db.execute(text("""
            UPDATE submission_gisa
            SET elevation_terrain_grid_json  = :grid_json,
                elevation_terrain_source     = :source,
                elevation_terrain_checked_at = :checked_at,
                elevation_terrain_error      = :error
            WHERE submission_id = :sid
        """), {
            "sid": submission_id,
            "grid_json": grid_json_str,
            "source": result["source"],
            "checked_at": result["checked_at"],
            "error": result["error"],
        })
        db.commit()
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

    return {"submission_id": submission_id, "terrain": result, "cached": False}


def _newest_ready_scene_package(db: Session, submission_id: int) -> dict | None:
    """Newest READY catalog row for a submission (the descriptor's chosen package)."""
    row = db.execute(text("""
        SELECT * FROM offline_scene_packages
        WHERE submission_id = :sid AND status = 'READY'
        ORDER BY uploaded_at DESC, id DESC
        LIMIT 1
    """), {"sid": submission_id}).mappings().first()
    return dict(row) if row else None


def _scene_object_present(catalog: dict) -> bool:
    """True only when the exact MinIO object exists with the catalog's size AND a
    matching durable object identity (immutable version id, else etag). This
    detects any replacement/tamper of the object behind a registered package.
    Storage errors are treated as not-present (honest offline-unavailable)."""
    try:
        st = stat_object(object_key=catalog["object_key"], bucket=catalog["minio_bucket"])
    except Exception:
        return False
    if st is None or int(st["size"]) != int(catalog["size_bytes"]):
        return False
    cat_vid = catalog.get("object_version_id")
    if cat_vid:
        return str(st.get("version_id") or "") == str(cat_vid)
    cat_etag = catalog.get("object_etag")
    if cat_etag:
        return str(st.get("etag") or "") == str(cat_etag)
    return True  # legacy rows without a stored identity fall back to size-only


@app.get("/submissions/{submission_id}/gisa/offline-scene-package")
def get_gisa_offline_scene_package(
    submission_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Offline 3D scene-package descriptor for the mobile native viewer.

    available is True ONLY when ERIS has a READY catalog row AND the exact MinIO
    object is present with matching size + durable identity. Otherwise
    available=False with a precise reason ("no package prepared yet" / "missing
    from storage"). All values come from the catalog row — never from a base-URL
    string. The package is generated automatically by the ERIS worker from USGS
    3DEP (see the operator runbook); no manual ArcGIS Pro authoring is involved."""
    require_can_view_submission(submission_id, db, user)

    catalog = _newest_ready_scene_package(db, submission_id)
    object_present = _scene_object_present(catalog) if catalog else False
    download_path = (
        f"/submissions/{submission_id}/gisa/offline-scene-package/download"
        if (catalog and object_present)
        else None
    )
    return offline_scene_svc.descriptor_from_catalog(
        submission_id=submission_id,
        catalog=catalog,
        object_present=object_present,
        download_path=download_path,
    )


@app.get("/submissions/{submission_id}/gisa/offline-scene-package/download")
def download_gisa_offline_scene_package(
    submission_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Mint a SHORT-LIVED presigned URL for the newest READY package, only after
    a role/access check. Mobile never receives MinIO credentials; the bucket stays
    private. On expiry the app re-requests this to resume/retry the download."""
    require_can_view_submission(submission_id, db, user)

    catalog = _newest_ready_scene_package(db, submission_id)
    if catalog is None:
        raise HTTPException(status_code=404, detail="No offline 3D package prepared for this incident.")
    if not _scene_object_present(catalog):
        raise HTTPException(status_code=409, detail="The prepared package is missing or changed in storage.")
    # Enforce the max package-size policy before minting a download grant, so an
    # over-policy package (e.g. from a relaxed past config) is never downloadable.
    if offline_scene_svc.exceeds_size_limit(catalog.get("size_bytes"), settings.OFFLINE_SCENE_MAX_PACKAGE_MB):
        raise HTTPException(
            status_code=409,
            detail=f"The prepared package exceeds the {settings.OFFLINE_SCENE_MAX_PACKAGE_MB} MB download policy.",
        )

    ttl = int(settings.OFFLINE_SCENE_DOWNLOAD_TTL_SECONDS)
    try:
        url = presign_get(catalog["object_key"], bucket=catalog["minio_bucket"], expires_seconds=ttl)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Could not mint download URL: {e}")
    return {
        "submission_id": submission_id,
        "url": url,
        "expires_in_seconds": ttl,
        "object_key": catalog["object_key"],
        "sha256": catalog["sha256"],
        "size_bytes": int(catalog["size_bytes"]),
        "package_version": catalog["package_version"],
        "package_format": catalog.get("package_format") or "eristerrain",
        "content_signature": catalog["content_signature"],
    }


def _job_public(job: dict | None) -> dict | None:
    """Safe job projection for the mobile client (no worker internals)."""
    if not job:
        return None
    return {
        "id": job["id"],
        "submission_id": job["submission_id"],
        "status": job["status"],
        "progress_pct": job["progress_pct"],
        "status_message": job["status_message"],
        "retry_count": job["retry_count"],
        "error_details": job["error_details"],
        "result_package_version": job["result_package_version"],
        "area": {
            "center": {"lat": job["center_lat"], "lon": job["center_lon"]},
            "radius_m": job["radius_m"],
            "bounds": {
                "min_lat": job["min_lat"], "min_lon": job["min_lon"],
                "max_lat": job["max_lat"], "max_lon": job["max_lon"],
            },
        },
        "created_at": str(job["created_at"]) if job.get("created_at") is not None else None,
        "updated_at": str(job["updated_at"]) if job.get("updated_at") is not None else None,
    }


@app.post("/submissions/{submission_id}/gisa/offline-scene-package/generate", status_code=202)
def generate_offline_scene_package(
    submission_id: int = Path(..., ge=1),
    radius_m: float | None = None,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Request AUTOMATIC generation of a bounded offline 3D package. Confirms the
    incident has coordinates, enforces edit permission, computes a bounded AOI,
    prevents duplicate active jobs, creates a QUEUED job, and returns immediately.
    A separate worker fetches USGS 3DEP, builds + verifies + uploads + registers
    the package. No manual ArcGIS Pro authoring is involved."""
    require_can_edit_submission(submission_id, db, user)

    row = db.execute(text("SELECT latitude, longitude FROM submission_gisa WHERE submission_id=:s LIMIT 1"),
                     {"s": submission_id}).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="GISA data not found for this submission")
    lat, lon = row["latitude"], row["longitude"]
    if lat is None or lon is None:
        raise HTTPException(status_code=400, detail="Cannot prepare an offline area: incident has no coordinates.")

    # Bounded AOI (incident radius, never statewide). ONE authoritative maximum
    # (settings.OFFLINE_SCENE_MAX_RADIUS_M, itself capped by the absolute hard
    # ceiling) enforced here, at job creation, and again at worker execution.
    radius = offline_scene_svc.clamp_radius_m(radius_m, settings.OFFLINE_SCENE_MAX_RADIUS_M)
    bounds = offline_scene_svc.bounding_box(float(lat), float(lon), radius)
    aoi = {"center": {"lat": float(lat), "lon": float(lon)}, "radius_m": radius, "bounds": bounds}

    # Prevent duplicate active jobs for the same submission.
    active = offline_scene_jobs_svc.get_active_job(db, submission_id)
    if active:
        raise HTTPException(status_code=409, detail="A package-generation job is already in progress.")

    job = offline_scene_jobs_svc.create_job(db, submission_id=submission_id, requested_by=user["id"], aoi=aoi)
    return {"job": _job_public(job)}


@app.get("/submissions/{submission_id}/gisa/offline-scene-package/job")
def get_offline_scene_package_job(
    submission_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Latest generation job for the submission (for mobile progress polling)."""
    require_can_view_submission(submission_id, db, user)
    job = offline_scene_jobs_svc.get_latest_job(db, submission_id)
    return {"job": _job_public(job)}


@app.post("/submissions/{submission_id}/gisa/offline-scene-package/job/cancel")
def cancel_offline_scene_package_job(
    submission_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    require_can_edit_submission(submission_id, db, user)
    active = offline_scene_jobs_svc.get_active_job(db, submission_id)
    if not active:
        raise HTTPException(status_code=404, detail="No active generation job to cancel.")
    if not offline_scene_jobs_svc.can_cancel(active["status"]):
        raise HTTPException(status_code=409, detail="This job can no longer be cancelled.")
    job = offline_scene_jobs_svc.cancel_job(db, active["id"])
    return {"job": _job_public(job)}


@app.post("/submissions/{submission_id}/gisa/offline-scene-package/job/retry")
def retry_offline_scene_package_job(
    submission_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    require_can_edit_submission(submission_id, db, user)
    latest = offline_scene_jobs_svc.get_latest_job(db, submission_id)
    if not latest:
        raise HTTPException(status_code=404, detail="No generation job to retry.")
    if not offline_scene_jobs_svc.can_retry(latest["status"]):
        raise HTTPException(status_code=409, detail="Only a FAILED job can be retried.")
    job = offline_scene_jobs_svc.retry_job(db, latest["id"])
    return {"job": _job_public(job)}


@app.post("/admin/offline-scene-packages")
def register_offline_scene_package(
    payload: OfflineScenePackageRegister = ...,
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN"])),
):
    """ADMIN-only registration of an operator-uploaded .mspk.

    Verifies the MinIO object exists, its size matches, and its SHA-256 matches
    BEFORE marking READY. Rejects missing objects, size/hash mismatch, duplicate
    versions, and invalid bounds. Retires any prior READY package for the
    submission (kept for audit). Objects are immutable — never overwritten."""
    sub = db.execute(text("SELECT id FROM submissions WHERE id = :id"), {"id": payload.submission_id}).first()
    if not sub:
        raise HTTPException(status_code=404, detail="Submission not found")

    # Manual override path registers an operator-uploaded .mspk. The PRIMARY path
    # is automatic generation via .../offline-scene-package/generate.
    try:
        row = register_ready_package(
            db,
            submission_id=payload.submission_id,
            package_version=payload.package_version,
            sha256=payload.sha256,
            size_bytes=payload.size_bytes,
            min_lat=payload.min_lat, min_lon=payload.min_lon,
            max_lat=payload.max_lat, max_lon=payload.max_lon,
            center_lat=payload.center_lat, center_lon=payload.center_lon, radius_m=payload.radius_m,
            elevation_source=payload.elevation_source,
            elevation_dataset=payload.elevation_dataset,
            elevation_version=payload.elevation_version,
            elevation_resolution=payload.elevation_resolution,
            basemap_or_imagery_source=payload.basemap_or_imagery_source,
            content_signature=payload.content_signature,
            package_format="mspk",
            object_key=payload.object_key,
            uploaded_by=user["id"],
            notes=payload.notes,
        )
    except PackageRegistrationError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e))
    return {"registered": True, "package": row}


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

    items = list(dict.fromkeys(payload.items))

    validate_incident_type_codes(items)
    try:
        db.execute(text("DELETE FROM submission_gisa_incident_types WHERE submission_id=:sid"), {"sid": submission_id})
        for code in items:
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
        validate_action_code_group(code, group)

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

    _is_public = settings.STORAGE_URL_MODE == "public"
    return {
        "submission_id": submission_id,
        "attachment_id": attachment_id,
        "file_name": filename,
        "content_type": content_type,
        "file_size_bytes": len(pdf_bytes),
        "sha256": sha256,
        "download_url": object_access_url(bucket, object_key, expires_seconds=900),
        "expires_seconds": None if _is_public else 900,
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

    _is_public = settings.STORAGE_URL_MODE == "public"
    return {
        "submission_id": submission_id,
        "attachment_id": int(row["id"]),
        "file_name": row["file_name"],
        "content_type": row["mime_type"],
        "file_size_bytes": row["file_size_bytes"],
        "sha256": row["sha256"],
        "uploaded_at": row["uploaded_at"],
        "download_url": object_access_url(str(row["storage_bucket"]), str(row["storage_key"]), expires_seconds=900),
        "expires_seconds": None if _is_public else 900,
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

    _is_public = settings.STORAGE_URL_MODE == "public"
    url = object_access_url(str(row["storage_bucket"]), str(row["storage_key"]), expires_seconds=900)

    return {
        "attachment_id": row["id"],
        "storage_key": row["storage_key"],
        "download_url": url,
        "expires_seconds": None if _is_public else 900,
    }

@app.get("/photos/{photo_id}/download")
def photo_download(
    photo_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    return attachment_download_url(photo_id, db, user)


# FALLBACK / DEPRECATED (alpha): proxies attachment bytes through FastAPI.
# Clients should use /attachments/{id}/download-url and load files directly from storage.
# Kept for backward-compatibility during the alpha transition; remove after clients migrate.
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


# FALLBACK / DEPRECATED (alpha): proxies photo bytes through FastAPI.
# Clients should use /photos/{id}/download or /attachments/{id}/download-url instead.
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


@app.post("/submissions/{submission_id}/notify-coordinator")
def notify_coordinator(
    submission_id: int = Path(..., ge=1),
    payload: NotifyCoordinatorAction = ...,
    db: Session = Depends(get_db),
    user=Depends(require_roles(["FIELD_WORKER", "ADMIN"])),
):
    require_can_edit_submission(submission_id, db, user)
    current_status = get_submission_status(db, submission_id)
    if current_status not in {"DRAFT", "REJECTED"}:
        raise HTTPException(status_code=409, detail="Only DRAFT or REJECTED submissions can notify coordinator")

    gisa = get_gisa(db, submission_id)
    if not gisa:
        raise HTTPException(status_code=409, detail="GISA data missing. Save draft first.")

    missing: list[str] = []
    if not str(gisa.get("district") or "").strip():
        missing.append("district")
    if not str(gisa.get("county") or "").strip():
        missing.append("county")
    if not str(gisa.get("route") or "").strip():
        missing.append("route")
    if not str(gisa.get("post_mile") or "").strip():
        missing.append("post_mile")
    if gisa.get("latitude") is None:
        missing.append("latitude")
    if gisa.get("longitude") is None:
        missing.append("longitude")
    if missing:
        raise HTTPException(status_code=409, detail=f"Cannot notify coordinator: missing required fields [{', '.join(missing)}]")

    actions = get_gisa_actions(db, submission_id)
    immediate_actions = [str(x) for x in (actions.get("immediate") or []) if str(x).strip()]
    if not immediate_actions:
        raise HTTPException(status_code=409, detail="Select at least one Immediate Action before notifying coordinator.")

    message = str(payload.message or "").strip()
    if not message:
        raise HTTPException(status_code=422, detail="Notification message is required.")

    try:
        db.execute(text("""
            INSERT INTO workflow_events
              (submission_id, actor_user_id, event_type, from_status, to_status, comment)
            VALUES
              (:sid, :actor, 'COORDINATOR_NOTIFIED', :from_status, :to_status, :comment)
        """), {
            "sid": submission_id,
            "actor": user["id"],
            "from_status": current_status,
            "to_status": current_status,
            "comment": f"Immediate actions: {', '.join(immediate_actions)} | Message: {message}",
        })
        db.commit()
        return {
            "submission_id": submission_id,
            "notified": True,
            "status": current_status,
            "immediate_actions": immediate_actions,
            "message": message,
        }
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

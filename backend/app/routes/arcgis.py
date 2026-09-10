from datetime import datetime, timezone

from fastapi import APIRouter, Depends

from ..config import settings
from ..deps import require_roles
from ..roles import CALTRANS_VIEWER

router = APIRouter(tags=["arcgis"])


@router.get("/arcgis/runtime-config")
def get_arcgis_runtime_config(
    # This list enumerates role names instead of consulting OPERATIONAL_ROLES,
    # so GEOTECH_SENIOR_ENGINEER has to be added by hand: without it a
    # senior-engineer-only account is 403'd here and can load neither the map
    # nor the 3D terrain. CALTRANS_VIEWER is here because the base map is what
    # renders an approved record's location; the config grants no data by itself
    # (org model design §4.5).
    user=Depends(require_roles(["MAINTENANCE", "FIELD_WORKER", "MAINT_COORDINATOR", "OFFICE_CHIEF", "BRANCH_CHIEF", "REVIEWER", "GEOTECH_SENIOR_ENGINEER", CALTRANS_VIEWER, "ADMIN"])),
):
    now = datetime.now(timezone.utc)
    issued_at = now.isoformat()
    ttl_hours = max(1, int(settings.ARCGIS_CONFIG_OFFLINE_TTL_HOURS))

    return {
        "runtime_enabled": bool(settings.ARCGIS_RUNTIME_ENABLED),
        "api_key": settings.ARCGIS_API_KEY,
        "license_key": settings.ARCGIS_LICENSE_KEY,
        "license_expires_at": settings.ARCGIS_LICENSE_EXPIRES_AT,
        "mmpk_url": settings.ARCGIS_MMPK_URL,
        "offline_ttl_hours": ttl_hours,
        "issued_at": issued_at,
        "requested_by_user_id": user["id"],
    }

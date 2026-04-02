from datetime import datetime, timezone

from fastapi import APIRouter, Depends

from ..config import settings
from ..deps import require_roles

router = APIRouter(tags=["arcgis"])


@router.get("/arcgis/runtime-config")
def get_arcgis_runtime_config(
    user=Depends(require_roles(["MAINTENANCE", "FIELD_WORKER", "MAINT_COORDINATOR", "OFFICE_CHIEF", "BRANCH_CHIEF", "REVIEWER", "ADMIN"])),
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

from fastapi import APIRouter, Depends
from ..constants.gisa_lookups import (
    GISA_ACTION_LUT,
    GISA_DISTRIBUTION_LUT,
    GISA_HIGHWAY_STATUS_LUT,
    GISA_INCIDENT_TYPE_LUT,
)
from ..deps import get_current_user

router = APIRouter()


@router.get("/health")
def health():
    return {"ok": True}


@router.get("/gisa/lookups")
def get_gisa_lookups(
    user=Depends(get_current_user),
):
    distribution = [dict(x) for x in GISA_DISTRIBUTION_LUT]
    highway_status = [dict(x) for x in GISA_HIGHWAY_STATUS_LUT]
    incident_types = [dict(x) for x in GISA_INCIDENT_TYPE_LUT]
    immediate: list[dict] = [dict(x) for x in GISA_ACTION_LUT if x["action_group"] == "IMMEDIATE"]
    follow_up: list[dict] = [dict(x) for x in GISA_ACTION_LUT if x["action_group"] == "FOLLOW_UP"]

    return {
        "distribution": distribution,
        "highway_status": highway_status,
        "incident_types": incident_types,
        "actions": {
            "immediate": immediate,
            "follow_up": follow_up,
        },
        "requested_by_user_id": user["id"],
    }

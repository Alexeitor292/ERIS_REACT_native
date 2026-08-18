from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..constants.gisa_lookups import GISA_INCIDENT_TYPE_LUT
from ..db import get_db
from ..deps import require_roles
from ..roles import (
    MAINTENANCE_FIELD_WORKER,
    OPERATIONAL_ROLES,
    ROLE_ALIASES,
    is_maintenance_only,
)

router = APIRouter(tags=["incident-classification"])

CLASSIFICATION_READ_ROLES = sorted(OPERATIONAL_ROLES | ROLE_ALIASES[MAINTENANCE_FIELD_WORKER])
_LABEL_BY_CODE = {str(item["code"]): str(item["label"]) for item in GISA_INCIDENT_TYPE_LUT}
_OFFICIAL_STATES = {"SUBMITTED", "APPROVED", "FINALIZED"}
_CONFIRMED_STATES = {"APPROVED", "FINALIZED"}
_MAX_BATCH = 500


class IncidentClassificationQuery(BaseModel):
    incident_ids: list[int]


def _classification_view(assessment_state: str | None, codes: list[str]) -> dict:
    state = str(assessment_state or "").strip().upper() or None
    normalized_codes = [str(code).strip().upper() for code in codes if str(code).strip()]

    if state is None:
        return {
            "classification_status": "UNCLASSIFIED",
            "reason": "ASSESSMENT_NOT_STARTED",
            "confirmed": False,
            "codes": [],
        }

    if state not in _OFFICIAL_STATES:
        return {
            "classification_status": "UNCLASSIFIED",
            "reason": "ASSESSMENT_IN_PROGRESS",
            "confirmed": False,
            "codes": [],
        }

    if not normalized_codes:
        return {
            "classification_status": "UNCLASSIFIED",
            "reason": "NO_TYPE_RECORDED",
            "confirmed": state in _CONFIRMED_STATES,
            "codes": [],
        }

    return {
        "classification_status": "CLASSIFIED" if state in _CONFIRMED_STATES else "CLASSIFIED_PENDING_REVIEW",
        "reason": "ASSESSMENT_APPROVED" if state in _CONFIRMED_STATES else "ASSESSMENT_SUBMITTED",
        "confirmed": state in _CONFIRMED_STATES,
        "codes": [
            {"code": code, "label": _LABEL_BY_CODE.get(code, code.replace("_", " ").title())}
            for code in normalized_codes
        ],
    }


def _assigned_at(state: str | None, row: dict) -> object | None:
    if state == "FINALIZED":
        return row.get("finalized_at") or row.get("approved_at") or row.get("submitted_at")
    if state == "APPROVED":
        return row.get("approved_at") or row.get("submitted_at")
    if state == "SUBMITTED":
        return row.get("submitted_at")
    return None


def _classification_payload(incident_id: int, row: dict, codes: list[str]) -> dict:
    assessment_id = int(row["assessment_id"]) if row.get("assessment_id") is not None else None
    assessment_state = str(row["assessment_state"]).upper() if row.get("assessment_state") else None
    submission_id = int(row["submission_id"]) if row.get("submission_id") is not None else None
    return {
        "incident_id": incident_id,
        "source": "GISA_ASSESSMENT",
        "assessment_id": assessment_id,
        "assessment_state": assessment_state,
        "submission_id": submission_id,
        "assigned_at": _assigned_at(assessment_state, row),
        **_classification_view(assessment_state, codes),
    }


def _classification_batch(*, db: Session, user: dict, incident_ids: list[int]) -> list[dict]:
    ordered_ids: list[int] = []
    seen: set[int] = set()
    for raw_id in incident_ids:
        incident_id = int(raw_id)
        if incident_id < 1:
            raise HTTPException(status_code=422, detail="incident_ids must contain positive integers")
        if incident_id not in seen:
            ordered_ids.append(incident_id)
            seen.add(incident_id)

    if not ordered_ids:
        return []
    if len(ordered_ids) > _MAX_BATCH:
        raise HTTPException(status_code=422, detail=f"At most {_MAX_BATCH} Incident classifications may be requested at once")

    params: dict[str, object] = {f"iid_{index}": incident_id for index, incident_id in enumerate(ordered_ids)}
    placeholders = ", ".join(f":iid_{index}" for index in range(len(ordered_ids)))
    scope_sql = ""
    if is_maintenance_only(user):
        scope_sql = " AND i.reporter_user_id = :reporter_user_id"
        params["reporter_user_id"] = int(user["id"])

    rows = db.execute(
        text(
            f"""
            SELECT
              i.id AS incident_id,
              a.id AS assessment_id,
              a.state AS assessment_state,
              a.submission_id,
              a.submitted_at,
              a.approved_at,
              a.finalized_at,
              CASE
                WHEN a.state IN ('SUBMITTED', 'APPROVED', 'FINALIZED')
                THEN it.incident_type_code
                ELSE NULL
              END AS incident_type_code
            FROM incidents i
            LEFT JOIN assessments a ON a.incident_id = i.id
            LEFT JOIN submission_gisa_incident_types it
              ON it.submission_id = a.submission_id
             AND a.state IN ('SUBMITTED', 'APPROVED', 'FINALIZED')
            WHERE i.id IN ({placeholders}){scope_sql}
            ORDER BY i.id ASC, it.incident_type_code ASC
            """
        ),
        params,
    ).mappings().all()

    grouped: dict[int, dict] = {}
    for raw_row in rows:
        row = dict(raw_row)
        incident_id = int(row["incident_id"])
        entry = grouped.setdefault(incident_id, {"row": row, "codes": []})
        code = row.get("incident_type_code")
        if code is not None:
            entry["codes"].append(str(code))

    if set(grouped) != set(ordered_ids):
        if is_maintenance_only(user):
            raise HTTPException(status_code=403, detail="One or more Incidents are outside your reporting scope")
        raise HTTPException(status_code=404, detail="One or more Incidents were not found")

    return [
        _classification_payload(incident_id, grouped[incident_id]["row"], grouped[incident_id]["codes"])
        for incident_id in ordered_ids
    ]


@router.get("/incidents/{incident_id}/classification")
def get_incident_classification(
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(CLASSIFICATION_READ_ROLES)),
):
    return _classification_batch(db=db, user=user, incident_ids=[incident_id])[0]


@router.post("/incident-classifications/query")
def query_incident_classifications(
    payload: IncidentClassificationQuery,
    db: Session = Depends(get_db),
    user=Depends(require_roles(CLASSIFICATION_READ_ROLES)),
):
    """Return assessment-derived classifications for up to 500 Incidents in one
    scoped query. This is the list/detail API for Project workspaces and avoids an
    N+1 request pattern as Projects accumulate many Incidents."""
    return {"items": _classification_batch(db=db, user=user, incident_ids=payload.incident_ids)}

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..constants.gisa_lookups import GISA_INCIDENT_TYPE_LUT
from ..db import get_db
from ..deps import require_roles
from ..roles import MAINTENANCE_FIELD_WORKER, OPERATIONAL_ROLES, ROLE_ALIASES
from . import incidents as incidents_routes

router = APIRouter(tags=["incident-classification"])

CLASSIFICATION_READ_ROLES = sorted(OPERATIONAL_ROLES | ROLE_ALIASES[MAINTENANCE_FIELD_WORKER])
_LABEL_BY_CODE = {str(item["code"]): str(item["label"]) for item in GISA_INCIDENT_TYPE_LUT}
_OFFICIAL_STATES = {"SUBMITTED", "APPROVED", "FINALIZED"}
_CONFIRMED_STATES = {"APPROVED", "FINALIZED"}


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


@router.get("/incidents/{incident_id}/classification")
def get_incident_classification(
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(CLASSIFICATION_READ_ROLES)),
):
    incident = incidents_routes._incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    incidents_routes._ensure_incident_scope_access(user, dict(incident))

    assessment = db.execute(
        text(
            """
            SELECT
              a.id, a.state, a.submission_id,
              a.submitted_at, a.approved_at, a.finalized_at
            FROM assessments a
            WHERE a.incident_id = :iid
            LIMIT 1
            """
        ),
        {"iid": incident_id},
    ).mappings().first()

    assessment_state = str(assessment["state"]) if assessment else None
    submission_id = int(assessment["submission_id"]) if assessment and assessment["submission_id"] is not None else None

    codes: list[str] = []
    if submission_id is not None and assessment_state in _OFFICIAL_STATES:
        codes = [
            str(code)
            for code in db.execute(
                text(
                    """
                    SELECT incident_type_code
                    FROM submission_gisa_incident_types
                    WHERE submission_id = :sid
                    ORDER BY incident_type_code
                    """
                ),
                {"sid": submission_id},
            ).scalars().all()
        ]

    classification = _classification_view(assessment_state, codes)
    assigned_at = None
    if assessment:
        if assessment_state == "FINALIZED":
            assigned_at = assessment["finalized_at"] or assessment["approved_at"] or assessment["submitted_at"]
        elif assessment_state == "APPROVED":
            assigned_at = assessment["approved_at"] or assessment["submitted_at"]
        elif assessment_state == "SUBMITTED":
            assigned_at = assessment["submitted_at"]

    return {
        "incident_id": incident_id,
        "source": "GISA_ASSESSMENT",
        "assessment_id": int(assessment["id"]) if assessment else None,
        "assessment_state": assessment_state,
        "submission_id": submission_id,
        "assigned_at": assigned_at,
        **classification,
    }

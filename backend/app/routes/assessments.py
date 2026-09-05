"""Assessment Routing & Authority Model — API layer.

The Assessment is the user-facing concept for the technical work that follows an
approved incident report. It is an additive relational wrapper around the
existing incident + GISA-backed submission ("technical form"); none of the
legacy ``submissions`` / ``submission_gisa`` structures are renamed or replaced.

This module reuses the existing incident-workflow helpers from
``routes/incidents.py`` as an adapter so the incident stage machine, stage
assignments, and the linked GISA submission stay in sync with the Assessment
lifecycle. New code should drive the workflow through these Assessment
endpoints; the legacy incident endpoints remain for backward compatibility.

Authority model: broad visibility, narrow authority.
  * Any non-maintenance operational user may READ assessments (server enforced).
  * Maintenance field workers cannot read assessments at all (no operational
    role -> require_roles guard rejects them).
  * Write actions are gated by organization role AND, for review, by an
    assessment-level assignment (REVIEWER/APPROVER) verified server-side.
"""

from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import get_current_user, require_roles
from ..roles import (
    ADMIN,
    GEOTECH_BRANCH_CHIEF,
    GEOTECH_ENGINEER,
    GEOTECH_OFFICE_CHIEF,
    LEGACY_REVIEWER,
    MAINTENANCE_COORDINATOR,
    OPERATIONAL_ROLES,
    expand_roles,
    is_admin,
    is_maintenance_only,
    is_operational_user,
)
from ..schemas.common import (
    AssessmentAssignEngineerRequest,
    AssessmentAssignmentRequest,
    AssessmentCreateSubmissionRequest,
    AssessmentDelegateBranchRequest,
    AssessmentFinalizeRequest,
    AssessmentReviewRequest,
    AssessmentSubmitRequest,
    IncidentTriageRequest,
)
from ..services import office_routing
from ..user_metadata import normalize_office_code
from . import incidents as incidents_routes

router = APIRouter(tags=["assessments"])

# Guard role lists (canonical + legacy aliases).
TRIAGE_ROLES = expand_roles(MAINTENANCE_COORDINATOR) + [ADMIN]
OFFICE_CHIEF_ROLES = expand_roles(GEOTECH_OFFICE_CHIEF) + [ADMIN]
BRANCH_CHIEF_ROLES = expand_roles(GEOTECH_BRANCH_CHIEF) + [ADMIN]
ENGINEER_ROLES = expand_roles(GEOTECH_ENGINEER) + [ADMIN]
ASSIGN_REVIEWER_ROLES = expand_roles(GEOTECH_OFFICE_CHIEF, GEOTECH_BRANCH_CHIEF) + [ADMIN]
OPERATIONAL_READ_ROLES = sorted(OPERATIONAL_ROLES)

ASSESSMENT_STATES = {
    "PENDING_OFFICE_DELEGATION",
    "PENDING_ENGINEER_ASSIGNMENT",
    "DRAFT",
    "SUBMITTED",
    "REVISION_REQUESTED",
    "APPROVED",
    "FINALIZED",
}


# ---------------------------------------------------------------------------
# Serialization + small helpers
# ---------------------------------------------------------------------------


def _serialize_assessment(row: dict, submission_ids: list[int] | None = None) -> dict:
    """Serialize an assessment row.

    ``submission_id`` stays the latest/primary technical submission for backward
    compatibility; ``submission_ids`` lists every technical submission attached
    to the assessment (oldest first). Callers that already loaded the join rows
    pass them in; otherwise the single legacy id is echoed.
    """
    primary = int(row["submission_id"]) if row.get("submission_id") is not None else None
    if submission_ids is None:
        submission_ids = [primary] if primary is not None else []
    return {
        "id": int(row["id"]),
        "assessment_uuid": row["assessment_uuid"],
        "incident_id": int(row["incident_id"]),
        "submission_id": primary,
        "submission_ids": list(submission_ids),
        "district": row.get("district"),
        "office_code": row.get("office_code"),
        "office_override_reason": row.get("office_override_reason"),
        "branch_chief_user_id": int(row["branch_chief_user_id"]) if row.get("branch_chief_user_id") is not None else None,
        "assigned_engineer_user_id": int(row["assigned_engineer_user_id"]) if row.get("assigned_engineer_user_id") is not None else None,
        "state": row["state"],
        "triage_disposition": row.get("triage_disposition"),
        "notes": row.get("notes"),
        "created_by_user_id": int(row["created_by_user_id"]),
        "office_delegated_at": row.get("office_delegated_at"),
        "engineer_assigned_at": row.get("engineer_assigned_at"),
        "submitted_at": row.get("submitted_at"),
        "review_requested_at": row.get("review_requested_at"),
        "approved_at": row.get("approved_at"),
        "finalized_at": row.get("finalized_at"),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


_ASSESSMENT_COLUMNS = """
  a.id, a.assessment_uuid, a.incident_id, a.submission_id, a.district,
  a.office_code, a.office_override_reason, a.branch_chief_user_id,
  a.assigned_engineer_user_id, a.state, a.triage_disposition, a.notes,
  a.created_by_user_id, a.office_delegated_at, a.engineer_assigned_at,
  a.submitted_at, a.review_requested_at, a.approved_at, a.finalized_at,
  a.created_at, a.updated_at
"""


def _get_assessment(db: Session, assessment_id: int) -> dict | None:
    row = db.execute(
        text(f"SELECT {_ASSESSMENT_COLUMNS} FROM assessments a WHERE a.id = :aid LIMIT 1"),
        {"aid": assessment_id},
    ).mappings().first()
    return dict(row) if row else None


def _get_assessment_for_incident(db: Session, incident_id: int) -> dict | None:
    row = db.execute(
        text(f"SELECT {_ASSESSMENT_COLUMNS} FROM assessments a WHERE a.incident_id = :iid LIMIT 1"),
        {"iid": incident_id},
    ).mappings().first()
    return dict(row) if row else None


def _submission_ids_map(db: Session, assessment_ids: list[int]) -> dict[int, list[int]]:
    """Batch-load every technical submission attached to the given assessments
    (``assessment_submissions``), oldest first. Missing keys mean "none"."""
    out: dict[int, list[int]] = {int(aid): [] for aid in assessment_ids}
    if not out:
        return out
    params = {f"aid_{index}": aid for index, aid in enumerate(out)}
    placeholders = ", ".join(f":aid_{index}" for index in range(len(out)))
    rows = db.execute(
        text(
            f"""
            SELECT assessment_id, submission_id
            FROM assessment_submissions
            WHERE assessment_id IN ({placeholders})
            ORDER BY assessment_id ASC, id ASC
            """
        ),
        params,
    ).mappings().all()
    for row in rows:
        out.setdefault(int(row["assessment_id"]), []).append(int(row["submission_id"]))
    return out


def _submission_ids_for(db: Session, assessment: dict) -> list[int]:
    ids = _submission_ids_map(db, [int(assessment["id"])]).get(int(assessment["id"]), [])
    primary = assessment.get("submission_id")
    if primary is not None and int(primary) not in ids:
        ids.append(int(primary))
    return ids


def _assessment_payload(db: Session, assessment_id: int) -> dict:
    assessment = _get_assessment(db, assessment_id)
    if not assessment:
        raise HTTPException(status_code=404, detail="Assessment not found")
    return _serialize_assessment(assessment, _submission_ids_for(db, assessment))


def _link_assessment_submission(db: Session, *, assessment_id: int, submission_id: int, actor_user_id: int) -> None:
    """Attach a technical submission to an assessment (idempotent) and point the
    legacy ``assessments.submission_id`` at the newest attached submission."""
    db.execute(
        text(
            """
            INSERT INTO assessment_submissions (assessment_id, submission_id, created_by_user_id)
            VALUES (:aid, :sid, :actor)
            ON DUPLICATE KEY UPDATE assessment_id = VALUES(assessment_id)
            """
        ),
        {"aid": assessment_id, "sid": submission_id, "actor": actor_user_id},
    )
    db.execute(
        text("UPDATE assessments SET submission_id = :sid, updated_at = NOW() WHERE id = :aid"),
        {"sid": submission_id, "aid": assessment_id},
    )


def _record_event(
    db: Session,
    *,
    incident_id: int,
    actor_user_id: int,
    event_type: str,
    assessment_id: int | None = None,
    disposition: str | None = None,
    from_state: str | None = None,
    to_state: str | None = None,
    notes: str | None = None,
    target_incident_id: int | None = None,
    target_location_id: int | None = None,
    metadata: dict | None = None,
) -> None:
    """Append an immutable row to the assessment/triage timeline."""
    db.execute(
        text(
            """
            INSERT INTO assessment_events (
              assessment_id, incident_id, actor_user_id, event_type, disposition,
              from_state, to_state, notes, target_incident_id, target_location_id, metadata_json
            ) VALUES (
              :assessment_id, :incident_id, :actor, :event_type, :disposition,
              :from_state, :to_state, :notes, :target_incident_id, :target_location_id, :metadata_json
            )
            """
        ),
        {
            "assessment_id": assessment_id,
            "incident_id": incident_id,
            "actor": actor_user_id,
            "event_type": event_type,
            "disposition": disposition,
            "from_state": from_state,
            "to_state": to_state,
            "notes": notes,
            "target_incident_id": target_incident_id,
            "target_location_id": target_location_id,
            "metadata_json": json.dumps(metadata) if metadata is not None else None,
        },
    )


def _active_assignments(db: Session, assessment_id: int) -> list[dict]:
    rows = db.execute(
        text(
            """
            SELECT aa.id, aa.user_id, aa.assignment_role, aa.assigned_by_user_id,
                   aa.is_active, aa.notes, aa.created_at,
                   u.email, u.full_name
            FROM assessment_assignments aa
            JOIN users u ON u.id = aa.user_id
            WHERE aa.assessment_id = :aid AND aa.is_active = 1
            ORDER BY aa.assignment_role, aa.id
            """
        ),
        {"aid": assessment_id},
    ).mappings().all()
    return [
        {
            "id": int(r["id"]),
            "user_id": int(r["user_id"]),
            "assignment_role": r["assignment_role"],
            "assigned_by_user_id": int(r["assigned_by_user_id"]),
            "notes": r["notes"],
            "email": r["email"],
            "full_name": r["full_name"],
            "created_at": r["created_at"],
        }
        for r in rows
    ]


def _assessment_events(db: Session, assessment_id: int, incident_id: int) -> list[dict]:
    rows = db.execute(
        text(
            """
            SELECT e.id, e.assessment_id, e.incident_id, e.actor_user_id, e.event_type,
                   e.disposition, e.from_state, e.to_state, e.notes,
                   e.target_incident_id, e.target_location_id, e.created_at,
                   u.full_name AS actor_name, u.email AS actor_email
            FROM assessment_events e
            LEFT JOIN users u ON u.id = e.actor_user_id
            WHERE e.assessment_id = :aid OR e.incident_id = :iid
            ORDER BY e.created_at ASC, e.id ASC
            """
        ),
        {"aid": assessment_id, "iid": incident_id},
    ).mappings().all()
    return [
        {
            "id": int(r["id"]),
            "assessment_id": int(r["assessment_id"]) if r["assessment_id"] is not None else None,
            "incident_id": int(r["incident_id"]),
            "actor_user_id": int(r["actor_user_id"]),
            "actor_name": r["actor_name"],
            "actor_email": r["actor_email"],
            "event_type": r["event_type"],
            "disposition": r["disposition"],
            "from_state": r["from_state"],
            "to_state": r["to_state"],
            "notes": r["notes"],
            "target_incident_id": int(r["target_incident_id"]) if r["target_incident_id"] is not None else None,
            "target_location_id": int(r["target_location_id"]) if r["target_location_id"] is not None else None,
            "created_at": r["created_at"],
        }
        for r in rows
    ]


def _has_active_review_authority(db: Session, assessment_id: int, user: dict) -> bool:
    """Server-side check: the user holds an active REVIEWER or APPROVER
    assignment for THIS assessment (or is admin). Review authority is never a
    global role.
    """
    if is_admin(user):
        return True
    hit = db.execute(
        text(
            """
            SELECT 1
            FROM assessment_assignments
            WHERE assessment_id = :aid
              AND user_id = :uid
              AND is_active = 1
              AND assignment_role IN ('REVIEWER', 'APPROVER')
            LIMIT 1
            """
        ),
        {"aid": assessment_id, "uid": int(user["id"])},
    ).scalar()
    return bool(hit)


# ---------------------------------------------------------------------------
# Routing preview
# ---------------------------------------------------------------------------


@router.get("/assessments/routing/preview")
def assessment_routing_preview(
    district: str | None = Query(default=None),
    db: Session = Depends(get_db),
    user=Depends(require_roles(TRIAGE_ROLES)),
):
    """Coordinator-facing preview of the destination GeoTech office for a
    district, so the calculated routing is visible before triage."""
    return office_routing.routing_preview(db, district)


# ---------------------------------------------------------------------------
# Coordinator triage
# ---------------------------------------------------------------------------


@router.post("/incidents/{incident_id}/triage")
def triage_incident(
    payload: IncidentTriageRequest,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(TRIAGE_ROLES)),
):
    incident = incidents_routes._incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    incidents_routes._ensure_incident_district_access(user, incident.get("district"))
    if str(incident["status"]).upper() == "RESOLVED":
        raise HTTPException(status_code=409, detail="Resolved incidents cannot be triaged")
    # Triage is the single coordinator decision point: only allowed while the
    # incident is still in coordinator review. This prevents re-triaging an
    # incident that has already been routed/closed, and guarantees every
    # disposition produces a real, terminal-or-forwarded outcome.
    if str(incident["current_stage"]).upper() != "COORDINATOR_REVIEW":
        raise HTTPException(
            status_code=409,
            detail="Triage is only allowed while the incident is in coordinator review",
        )

    disposition = payload.disposition
    notes = (payload.notes or "").strip() or None
    actor_id = int(user["id"])

    try:
        if disposition == "ASSESSMENT_REQUIRED":
            result = _triage_assessment_required(db, incident, user, payload, notes)
        elif disposition == "NO_ASSESSMENT_REQUIRED":
            result = _triage_no_assessment(db, incident, actor_id, notes)
        elif disposition == "NEEDS_REPORTER_INFORMATION":
            result = _triage_needs_info(db, incident, actor_id, notes, payload.revision_fields)
        elif disposition == "DUPLICATE_OR_LINKED":
            result = _triage_duplicate(db, incident, actor_id, notes, payload)
        else:  # pragma: no cover - schema enum prevents this
            raise HTTPException(status_code=400, detail="Invalid disposition")
        db.commit()
        return result
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


def _set_incident_triage(
    db: Session,
    *,
    incident_id: int,
    disposition: str,
    actor_id: int,
    notes: str | None,
    duplicate_of_incident_id: int | None = None,
    duplicate_of_location_id: int | None = None,
) -> None:
    """Record the coordinator's triage decision in the dedicated triage columns.

    Deliberately does NOT touch ``location_match_metadata`` — that JSON belongs
    to the location-review / reporter-revision flows and must be preserved.
    """
    db.execute(
        text(
            """
            UPDATE incidents
            SET triage_disposition = :disposition,
                triage_decided_by_user_id = :actor,
                triage_decided_at = NOW(),
                triage_notes = :notes,
                duplicate_of_incident_id = :dup_incident,
                duplicate_of_location_id = :dup_location,
                updated_at = NOW()
            WHERE id = :iid
            """
        ),
        {
            "disposition": disposition,
            "actor": actor_id,
            "notes": notes,
            "dup_incident": duplicate_of_incident_id,
            "dup_location": duplicate_of_location_id,
            "iid": incident_id,
        },
    )


def _close_incident_at_triage(db: Session, *, incident_id: int, actor_id: int, comment: str | None) -> None:
    """Move a non-assessment incident to a terminal RESOLVED outcome so it leaves
    the coordinator-review queue, while preserving the report and its history.
    Mirrors the engineer resolve path (status + stage + resolved_* + deactivate
    any active assignments). No Assessment is created."""
    db.execute(
        text(
            """
            UPDATE incidents
            SET status = 'RESOLVED',
                current_stage = 'RESOLVED',
                resolved_at = NOW(),
                resolved_by_user_id = :actor,
                resolution_comment = :comment,
                updated_at = NOW()
            WHERE id = :iid
            """
        ),
        {"iid": incident_id, "actor": actor_id, "comment": comment},
    )
    db.execute(
        text(
            """
            UPDATE incident_assignments
            SET is_active = 0, updated_at = NOW()
            WHERE incident_id = :iid AND is_active = 1
            """
        ),
        {"iid": incident_id},
    )


def _merge_incident_location_metadata(db: Session, incident: dict, updates: dict) -> str:
    """Merge ``updates`` into the incident's existing ``location_match_metadata``
    instead of overwriting it, preserving any location-review fields. Returns the
    merged JSON string."""
    existing = incident.get("location_match_metadata")
    if isinstance(existing, str):
        try:
            existing = json.loads(existing)
        except Exception:
            existing = None
    base = dict(existing) if isinstance(existing, dict) else {}
    base.update(updates)
    return json.dumps(base)


def _triage_assessment_required(
    db: Session, incident: dict, user: dict, payload: IncidentTriageRequest, notes: str | None
) -> dict:
    incident_id = int(incident["id"])
    actor_id = int(user["id"])
    district = incident.get("district")

    # Resolve destination office: configurable routing, with optional audited
    # override (coordinator/admin only, which the guard already enforces).
    resolved = office_routing.routing_preview(db, district)
    office_code = resolved.get("office_code")
    override_reason = None
    if payload.office_code_override:
        override = normalize_office_code(payload.office_code_override)
        if not override:
            raise HTTPException(status_code=400, detail="Invalid office_code_override")
        if not (payload.override_reason or "").strip():
            raise HTTPException(status_code=400, detail="override_reason is required when overriding routing")
        office_code = override
        override_reason = payload.override_reason.strip()

    if not office_code:
        raise HTTPException(
            status_code=409,
            detail="No GeoTech office is configured for this incident's district",
        )

    # Create or activate the Assessment (one per incident).
    existing = _get_assessment_for_incident(db, incident_id)
    if existing is None:
        assessment_uuid = uuid.uuid4().hex
        db.execute(
            text(
                """
                INSERT INTO assessments (
                  assessment_uuid, incident_id, district, office_code,
                  office_routed_from_district, office_override_reason,
                  state, triage_disposition, notes, created_by_user_id,
                  office_delegated_at
                ) VALUES (
                  :uuid, :iid, :district, :office_code,
                  :routed_from, :override_reason,
                  'PENDING_OFFICE_DELEGATION', 'ASSESSMENT_REQUIRED', :notes, :actor,
                  NULL
                )
                """
            ),
            {
                "uuid": assessment_uuid,
                "iid": incident_id,
                "district": district,
                "office_code": office_code,
                "routed_from": resolved.get("district"),
                "override_reason": override_reason,
                "notes": notes,
                "actor": actor_id,
            },
        )
        assessment_id = int(db.execute(text("SELECT LAST_INSERT_ID()")).scalar())
    else:
        assessment_id = int(existing["id"])
        db.execute(
            text(
                """
                UPDATE assessments
                SET office_code = :office_code,
                    office_override_reason = COALESCE(:override_reason, office_override_reason),
                    triage_disposition = 'ASSESSMENT_REQUIRED',
                    state = CASE WHEN state = 'PENDING_OFFICE_DELEGATION' THEN state ELSE state END,
                    updated_at = NOW()
                WHERE id = :aid
                """
            ),
            {"office_code": office_code, "override_reason": override_reason, "aid": assessment_id},
        )

    # Keep the legacy incident stage machine in sync: route to office chief.
    db.execute(
        text(
            """
            UPDATE incidents
            SET current_stage = 'OFFICE_CHIEF_REVIEW',
                office_code = :office_code,
                updated_at = NOW()
            WHERE id = :iid
            """
        ),
        {"iid": incident_id, "office_code": office_code},
    )
    office_chief_ids = incidents_routes._routing_users_for(
        db=db, assignment_type="OFFICE_CHIEF", office_code=office_code
    )
    if office_chief_ids:
        incidents_routes._set_stage_assignment(
            db=db,
            incident_id=incident_id,
            assignee_user_id=office_chief_ids[0],
            assigned_by_user_id=actor_id,
            assignment_mode="ASSIGN",
            assignment_stage="OFFICE_CHIEF",
        )
        incidents_routes._queue_incident_notifications(
            db=db,
            incident_id=incident_id,
            recipient_user_ids=office_chief_ids,
            template_code="ASSESSMENT_OFFICE_DELEGATION",
            payload={"incident_id": incident_id, "office_code": office_code, "assessment_id": assessment_id},
        )

    _set_incident_triage(
        db,
        incident_id=incident_id,
        disposition="ASSESSMENT_REQUIRED",
        actor_id=actor_id,
        notes=notes,
    )
    _record_event(
        db,
        incident_id=incident_id,
        assessment_id=assessment_id,
        actor_user_id=actor_id,
        event_type="TRIAGE_DECISION",
        disposition="ASSESSMENT_REQUIRED",
        from_state=None,
        to_state="PENDING_OFFICE_DELEGATION",
        notes=notes,
        metadata={"office_code": office_code, "override": bool(override_reason)},
    )
    return {"assessment": _assessment_payload(db, assessment_id)}


def _triage_no_assessment(db: Session, incident: dict, actor_id: int, notes: str | None) -> dict:
    incident_id = int(incident["id"])
    # Explicit, auditable outcome: the report is closed (RESOLVED) at triage with
    # the "no assessment required" disposition. The report and its history are
    # preserved; it simply leaves the coordinator-review queue. No Assessment is
    # created. location_match_metadata is left untouched.
    _set_incident_triage(
        db, incident_id=incident_id, disposition="NO_ASSESSMENT_REQUIRED", actor_id=actor_id, notes=notes
    )
    _close_incident_at_triage(
        db,
        incident_id=incident_id,
        actor_id=actor_id,
        comment=f"Closed at triage — no assessment required.{(' ' + notes) if notes else ''}",
    )
    _record_event(
        db,
        incident_id=incident_id,
        actor_user_id=actor_id,
        event_type="TRIAGE_DECISION",
        disposition="NO_ASSESSMENT_REQUIRED",
        from_state="COORDINATOR_REVIEW",
        to_state="RESOLVED",
        notes=notes,
    )
    return {"incident_id": incident_id, "disposition": "NO_ASSESSMENT_REQUIRED", "status": "RESOLVED"}


def _triage_needs_info(
    db: Session, incident: dict, actor_id: int, notes: str | None, revision_fields: list[str]
) -> dict:
    incident_id = int(incident["id"])
    requested = []
    for raw in revision_fields or []:
        f = str(raw or "").strip().lower()
        if f in incidents_routes.REVISION_FIELDS_ALLOWED and f not in requested:
            requested.append(f)
    # Reuse the existing reporter-revision channel so the maintenance worker can
    # see the request and resubmit via the existing PATCH /incidents/{id} path.
    # Merge (do not overwrite) so any prior location-review fields are preserved.
    merged_metadata = _merge_incident_location_metadata(
        db,
        incident,
        {
            "mode": "REQUEST_REVISION",
            "triage_disposition": "NEEDS_REPORTER_INFORMATION",
            "comment": notes,
            "performed_by_user_id": actor_id,
            "revision_fields": requested,
        },
    )
    db.execute(
        text(
            """
            UPDATE incidents
            SET location_match_status = 'NEEDS_REVISION',
                location_reviewed_by_user_id = :actor,
                location_reviewed_at = NOW(),
                location_match_metadata = :metadata,
                updated_at = NOW()
            WHERE id = :iid
            """
        ),
        {"iid": incident_id, "actor": actor_id, "metadata": merged_metadata},
    )
    # Record the triage disposition in the dedicated columns too (the incident
    # stays in coordinator review pending the reporter's resubmission).
    _set_incident_triage(
        db, incident_id=incident_id, disposition="NEEDS_REPORTER_INFORMATION", actor_id=actor_id, notes=notes
    )
    _record_event(
        db,
        incident_id=incident_id,
        actor_user_id=actor_id,
        event_type="TRIAGE_DECISION",
        disposition="NEEDS_REPORTER_INFORMATION",
        notes=notes,
        metadata={"revision_fields": requested},
    )
    return {"incident_id": incident_id, "disposition": "NEEDS_REPORTER_INFORMATION", "revision_fields": requested}


def _triage_duplicate(
    db: Session, incident: dict, actor_id: int, notes: str | None, payload: IncidentTriageRequest
) -> dict:
    incident_id = int(incident["id"])
    target_incident_id = payload.target_incident_id
    target_location_id = payload.target_location_id

    if target_incident_id is not None:
        exists = db.execute(
            text("SELECT 1 FROM incidents WHERE id = :id LIMIT 1"), {"id": target_incident_id}
        ).scalar()
        if not exists:
            raise HTTPException(status_code=404, detail="target_incident_id not found")
    if target_location_id is not None:
        exists = db.execute(
            text("SELECT 1 FROM incident_locations WHERE id = :id LIMIT 1"), {"id": target_location_id}
        ).scalar()
        if not exists:
            raise HTTPException(status_code=404, detail="target_location_id not found")

    # Explicit, auditable outcome: the duplicate/linked report is closed
    # (RESOLVED) at triage and linked to its target via dedicated columns. The
    # original report and history are preserved; location_match_metadata is left
    # untouched. No Assessment is created.
    _set_incident_triage(
        db,
        incident_id=incident_id,
        disposition="DUPLICATE_OR_LINKED",
        actor_id=actor_id,
        notes=notes,
        duplicate_of_incident_id=target_incident_id,
        duplicate_of_location_id=target_location_id,
    )
    target_desc = []
    if target_incident_id is not None:
        target_desc.append(f"incident #{target_incident_id}")
    if target_location_id is not None:
        target_desc.append(f"location #{target_location_id}")
    target_phrase = (" Linked to " + ", ".join(target_desc) + ".") if target_desc else ""
    _close_incident_at_triage(
        db,
        incident_id=incident_id,
        actor_id=actor_id,
        comment=f"Closed at triage — duplicate or linked.{target_phrase}{(' ' + notes) if notes else ''}",
    )
    _record_event(
        db,
        incident_id=incident_id,
        actor_user_id=actor_id,
        event_type="TRIAGE_DECISION",
        disposition="DUPLICATE_OR_LINKED",
        from_state="COORDINATOR_REVIEW",
        to_state="RESOLVED",
        notes=notes,
        target_incident_id=target_incident_id,
        target_location_id=target_location_id,
    )
    return {
        "incident_id": incident_id,
        "disposition": "DUPLICATE_OR_LINKED",
        "status": "RESOLVED",
        "target_incident_id": target_incident_id,
        "target_location_id": target_location_id,
    }


# ---------------------------------------------------------------------------
# Read: list + detail (broad operational visibility)
# ---------------------------------------------------------------------------


@router.get("/assessments")
def list_assessments(
    state: str | None = Query(default=None),
    office_code: str | None = Query(default=None),
    queue: str | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=1000),
    db: Session = Depends(get_db),
    user=Depends(require_roles(OPERATIONAL_READ_ROLES)),
):
    """Broad read for non-maintenance operational users. Optional ``queue``
    narrows to the caller's work queue (office_chief | branch_chief | engineer |
    reviewer)."""
    # Defense in depth: maintenance-only users must never reach broad data even
    # if a future role mix slips past the guard.
    if is_maintenance_only(user):
        raise HTTPException(status_code=403, detail="Maintenance field workers cannot list assessments")

    params: dict[str, object] = {"limit": limit}
    where: list[str] = []
    if state:
        s = state.strip().upper()
        if s not in ASSESSMENT_STATES:
            raise HTTPException(status_code=400, detail="Invalid assessment state filter")
        where.append("a.state = :state")
        params["state"] = s
    if office_code:
        where.append("a.office_code = :office_code")
        params["office_code"] = normalize_office_code(office_code)

    q = (queue or "").strip().lower()
    if q == "office_chief":
        where.append("a.state = 'PENDING_OFFICE_DELEGATION'")
        _scope_office(user, where, params)
    elif q == "branch_chief":
        where.append("a.state = 'PENDING_ENGINEER_ASSIGNMENT'")
        if not is_admin(user):
            where.append("(a.branch_chief_user_id = :me OR a.branch_chief_user_id IS NULL)")
            params["me"] = int(user["id"])
        _scope_office(user, where, params)
    elif q == "engineer":
        where.append("a.assigned_engineer_user_id = :me")
        params["me"] = int(user["id"])
    elif q == "reviewer":
        where.append(
            "EXISTS (SELECT 1 FROM assessment_assignments aa "
            "WHERE aa.assessment_id = a.id AND aa.user_id = :me AND aa.is_active = 1 "
            "AND aa.assignment_role IN ('REVIEWER','APPROVER'))"
        )
        params["me"] = int(user["id"])
    elif q:
        raise HTTPException(status_code=400, detail="Invalid queue filter")

    where_sql = f"WHERE {' AND '.join(where)}" if where else ""
    rows = db.execute(
        text(
            f"""
            SELECT {_ASSESSMENT_COLUMNS}
            FROM assessments a
            {where_sql}
            ORDER BY a.updated_at DESC, a.id DESC
            LIMIT :limit
            """
        ),
        params,
    ).mappings().all()
    items = [dict(r) for r in rows]
    ids_map = _submission_ids_map(db, [int(item["id"]) for item in items])
    serialized = []
    for item in items:
        ids = ids_map.get(int(item["id"]), [])
        primary = item.get("submission_id")
        if primary is not None and int(primary) not in ids:
            ids = [*ids, int(primary)]
        serialized.append(_serialize_assessment(item, ids))
    return {"items": serialized, "requested_by_user_id": int(user["id"])}


def _scope_office(user: dict, where: list[str], params: dict) -> None:
    """Optionally narrow office-scoped queues to the caller's office. Admins are
    not scoped. Users without an office_code see the unscoped queue (broad read
    is allowed; the narrowing is a convenience, not a security boundary here)."""
    if is_admin(user):
        return
    office = normalize_office_code((user.get("metadata") or {}).get("office_code"))
    if office:
        where.append("(a.office_code = :scoped_office OR a.office_code IS NULL)")
        params["scoped_office"] = office


@router.get("/assessments/{assessment_id}")
def get_assessment(
    assessment_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(OPERATIONAL_READ_ROLES)),
):
    if is_maintenance_only(user):
        raise HTTPException(status_code=403, detail="Maintenance field workers cannot view assessments")
    assessment = _get_assessment(db, assessment_id)
    if not assessment:
        raise HTTPException(status_code=404, detail="Assessment not found")
    return {
        "assessment": _serialize_assessment(assessment, _submission_ids_for(db, assessment)),
        "assignments": _active_assignments(db, assessment_id),
        "events": _assessment_events(db, assessment_id, int(assessment["incident_id"])),
    }


@router.get("/incidents/{incident_id}/assessment")
def get_assessment_for_incident(
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(OPERATIONAL_READ_ROLES)),
):
    if is_maintenance_only(user):
        raise HTTPException(status_code=403, detail="Maintenance field workers cannot view assessments")
    assessment = _get_assessment_for_incident(db, incident_id)
    if not assessment:
        raise HTTPException(status_code=404, detail="No assessment for this incident")
    assessment_id = int(assessment["id"])
    return {
        "assessment": _serialize_assessment(assessment, _submission_ids_for(db, assessment)),
        "assignments": _active_assignments(db, assessment_id),
        "events": _assessment_events(db, assessment_id, incident_id),
    }


# ---------------------------------------------------------------------------
# Office chief: delegate to branch chief
# ---------------------------------------------------------------------------


@router.get("/assessments/{assessment_id}/branch-options")
def assessment_branch_options(
    assessment_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(OFFICE_CHIEF_ROLES)),
):
    assessment = _get_assessment(db, assessment_id)
    if not assessment:
        raise HTTPException(status_code=404, detail="Assessment not found")
    office_code = assessment.get("office_code")
    incidents_routes._ensure_incident_office_access(user, office_code)
    return {
        "assessment_id": assessment_id,
        "office_code": office_code,
        "items": incidents_routes._routing_user_options_for(
            db=db, assignment_type="BRANCH_CHIEF", office_code=office_code
        ),
    }


@router.post("/assessments/{assessment_id}/delegate-branch")
def delegate_branch(
    payload: AssessmentDelegateBranchRequest,
    assessment_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(OFFICE_CHIEF_ROLES)),
):
    assessment = _get_assessment(db, assessment_id)
    if not assessment:
        raise HTTPException(status_code=404, detail="Assessment not found")
    if assessment["state"] not in {"PENDING_OFFICE_DELEGATION", "PENDING_ENGINEER_ASSIGNMENT"}:
        raise HTTPException(status_code=409, detail=f"Cannot delegate from state {assessment['state']}")

    office_code = assessment.get("office_code")
    incidents_routes._ensure_incident_office_access(user, office_code)
    incident_id = int(assessment["incident_id"])

    allowed = set(
        incidents_routes._routing_users_for(db=db, assignment_type="BRANCH_CHIEF", office_code=office_code)
    )
    if int(payload.branch_chief_user_id) not in allowed:
        raise HTTPException(status_code=400, detail="Selected user is not a branch chief for this office")

    try:
        notes = (payload.notes or "").strip() or None
        db.execute(
            text(
                """
                UPDATE assessments
                SET branch_chief_user_id = :bc,
                    state = 'PENDING_ENGINEER_ASSIGNMENT',
                    office_delegated_at = NOW(),
                    updated_at = NOW()
                WHERE id = :aid
                """
            ),
            {"bc": int(payload.branch_chief_user_id), "aid": assessment_id},
        )
        # Keep legacy incident stage machine in sync.
        db.execute(
            text(
                """
                UPDATE incidents
                SET current_stage = 'BRANCH_CHIEF_REVIEW', updated_at = NOW()
                WHERE id = :iid
                """
            ),
            {"iid": incident_id},
        )
        incidents_routes._set_stage_assignment(
            db=db,
            incident_id=incident_id,
            assignee_user_id=int(payload.branch_chief_user_id),
            assigned_by_user_id=int(user["id"]),
            assignment_mode="ASSIGN",
            assignment_stage="BRANCH_CHIEF",
        )
        incidents_routes._queue_incident_notifications(
            db=db,
            incident_id=incident_id,
            recipient_user_ids=[int(payload.branch_chief_user_id)],
            template_code="ASSESSMENT_BRANCH_DELEGATION",
            payload={"assessment_id": assessment_id, "office_code": office_code},
        )
        _record_event(
            db,
            incident_id=incident_id,
            assessment_id=assessment_id,
            actor_user_id=int(user["id"]),
            event_type="OFFICE_DELEGATED",
            from_state=assessment["state"],
            to_state="PENDING_ENGINEER_ASSIGNMENT",
            notes=notes,
        )
        if payload.engineer_user_id is not None:
            # Office chief assigned the engineer at delegation time: the
            # assessment skips the branch-chief queue and goes straight to DRAFT.
            delegated = _get_assessment(db, assessment_id) or assessment
            _perform_engineer_assignment(
                db,
                assessment=delegated,
                engineer_user_id=int(payload.engineer_user_id),
                actor_user_id=int(user["id"]),
                notes=notes,
            )
        db.commit()
        return {"assessment": _assessment_payload(db, assessment_id)}
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


# ---------------------------------------------------------------------------
# Branch chief: assign / reassign engineer
# ---------------------------------------------------------------------------


def _perform_engineer_assignment(
    db: Session,
    *,
    assessment: dict,
    engineer_user_id: int,
    actor_user_id: int,
    notes: str | None,
) -> int | None:
    """Assign (or reassign) the engineer on an assessment.

    Reuses the legacy engineer-assignment flow: it sets the ENGINEER stage
    assignment, advances the incident, and creates/links the primary GISA draft
    (the technical assessment form). Offline draft behaviour is preserved. The
    linked draft is also attached to the assessment's submission list. Returns
    the linked submission id. Caller commits.
    """
    assessment_id = int(assessment["id"])
    incident_id = int(assessment["incident_id"])
    result = incidents_routes._assign_incident(
        db=db,
        incident_id=incident_id,
        assignee_user_id=engineer_user_id,
        assigned_by_user_id=actor_user_id,
        mode="ASSIGN",
    )
    linked_submission_id = result.get("linked_submission_id")
    prior_state = assessment["state"]
    db.execute(
        text(
            """
            UPDATE assessments
            SET assigned_engineer_user_id = :eng,
                submission_id = COALESCE(:sub, submission_id),
                state = CASE WHEN state IN ('PENDING_OFFICE_DELEGATION','PENDING_ENGINEER_ASSIGNMENT')
                             THEN 'DRAFT' ELSE state END,
                engineer_assigned_at = NOW(),
                updated_at = NOW()
            WHERE id = :aid
            """
        ),
        {"eng": engineer_user_id, "sub": linked_submission_id, "aid": assessment_id},
    )
    if linked_submission_id is not None:
        db.execute(
            text(
                """
                INSERT INTO assessment_submissions (assessment_id, submission_id, created_by_user_id)
                VALUES (:aid, :sid, :actor)
                ON DUPLICATE KEY UPDATE assessment_id = VALUES(assessment_id)
                """
            ),
            {"aid": assessment_id, "sid": int(linked_submission_id), "actor": actor_user_id},
        )
    # Mirror the engineer into the assessment-level assignment table.
    db.execute(
        text(
            """
            UPDATE assessment_assignments SET is_active = 0, updated_at = NOW()
            WHERE assessment_id = :aid AND assignment_role = 'ENGINEER' AND is_active = 1
            """
        ),
        {"aid": assessment_id},
    )
    db.execute(
        text(
            """
            INSERT INTO assessment_assignments (assessment_id, user_id, assignment_role, assigned_by_user_id, notes)
            VALUES (:aid, :uid, 'ENGINEER', :by, :notes)
            """
        ),
        {"aid": assessment_id, "uid": engineer_user_id, "by": actor_user_id, "notes": notes},
    )
    incidents_routes._notify_coordinator_engineer_assigned(db=db, incident_id=incident_id)
    _record_event(
        db,
        incident_id=incident_id,
        assessment_id=assessment_id,
        actor_user_id=actor_user_id,
        event_type="ENGINEER_ASSIGNED",
        from_state=prior_state,
        to_state="DRAFT",
        notes=notes,
        metadata={"engineer_user_id": engineer_user_id, "submission_id": linked_submission_id},
    )
    return int(linked_submission_id) if linked_submission_id is not None else None


@router.post("/assessments/{assessment_id}/assign-engineer")
def assign_engineer(
    payload: AssessmentAssignEngineerRequest,
    assessment_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(BRANCH_CHIEF_ROLES)),
):
    assessment = _get_assessment(db, assessment_id)
    if not assessment:
        raise HTTPException(status_code=404, detail="Assessment not found")
    if assessment["state"] in {"APPROVED", "FINALIZED"}:
        raise HTTPException(status_code=409, detail=f"Cannot assign engineer from state {assessment['state']}")
    office_code = assessment.get("office_code")
    incidents_routes._ensure_incident_office_access(user, office_code)

    try:
        _perform_engineer_assignment(
            db,
            assessment=assessment,
            engineer_user_id=int(payload.engineer_user_id),
            actor_user_id=int(user["id"]),
            notes=(payload.notes or "").strip() or None,
        )
        db.commit()
        return {"assessment": _assessment_payload(db, assessment_id)}
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


# ---------------------------------------------------------------------------
# Reviewer / approver / consulted assignment (assessment-level)
# ---------------------------------------------------------------------------


@router.post("/assessments/{assessment_id}/assignments")
def add_assignment(
    payload: AssessmentAssignmentRequest,
    assessment_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(ASSIGN_REVIEWER_ROLES)),
):
    assessment = _get_assessment(db, assessment_id)
    if not assessment:
        raise HTTPException(status_code=404, detail="Assessment not found")
    incidents_routes._ensure_incident_office_access(user, assessment.get("office_code"))

    target = db.execute(
        text("SELECT id, is_active, metadata_json FROM users WHERE id = :uid LIMIT 1"),
        {"uid": int(payload.user_id)},
    ).mappings().first()
    if not target or int(target["is_active"]) != 1:
        raise HTTPException(status_code=404, detail="Target user not found or inactive")

    # Any eligible non-maintenance operational user may be assigned as a
    # reviewer/approver — there is no permanent REVIEWER role requirement. But a
    # maintenance-only user is not eligible.
    target_roles = db.execute(
        text(
            """
            SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
            WHERE ur.user_id = :uid
            """
        ),
        {"uid": int(payload.user_id)},
    ).scalars().all()
    target_user = {"id": int(payload.user_id), "roles": list(target_roles)}
    if not is_operational_user(target_user):
        raise HTTPException(
            status_code=400,
            detail="Reviewer/approver must be a non-maintenance operational user",
        )

    try:
        db.execute(
            text(
                """
                INSERT INTO assessment_assignments (assessment_id, user_id, assignment_role, assigned_by_user_id, notes)
                VALUES (:aid, :uid, :role, :by, :notes)
                """
            ),
            {
                "aid": assessment_id,
                "uid": int(payload.user_id),
                "role": payload.assignment_role,
                "by": int(user["id"]),
                "notes": (payload.notes or "").strip() or None,
            },
        )
        _record_event(
            db,
            incident_id=int(assessment["incident_id"]),
            assessment_id=assessment_id,
            actor_user_id=int(user["id"]),
            event_type="ASSIGNMENT_ADDED",
            notes=(payload.notes or "").strip() or None,
            metadata={"user_id": int(payload.user_id), "assignment_role": payload.assignment_role},
        )
        db.commit()
        return {"assessment_id": assessment_id, "assignments": _active_assignments(db, assessment_id)}
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/assessments/{assessment_id}/assignments/{assignment_id}")
def remove_assignment(
    assessment_id: int = Path(..., ge=1),
    assignment_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(ASSIGN_REVIEWER_ROLES)),
):
    assessment = _get_assessment(db, assessment_id)
    if not assessment:
        raise HTTPException(status_code=404, detail="Assessment not found")
    incidents_routes._ensure_incident_office_access(user, assessment.get("office_code"))
    db.execute(
        text(
            """
            UPDATE assessment_assignments SET is_active = 0, updated_at = NOW()
            WHERE id = :id AND assessment_id = :aid AND assignment_role <> 'ENGINEER'
            """
        ),
        {"id": assignment_id, "aid": assessment_id},
    )
    db.commit()
    return {"assessment_id": assessment_id, "assignments": _active_assignments(db, assessment_id)}


# ---------------------------------------------------------------------------
# Engineer: supplemental technical submissions
# ---------------------------------------------------------------------------


@router.post("/assessments/{assessment_id}/submissions")
def create_assessment_submission(
    payload: AssessmentCreateSubmissionRequest,
    assessment_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(ENGINEER_ROLES)),
):
    """Create another DRAFT technical submission for this assessment.

    The draft is pre-filled from the incident (district / county / route /
    post mile / coordinates) and owned by the assigned engineer. The incident's
    primary ``incident_submission_links`` row is left untouched; the new form is
    attached through ``assessment_submissions`` and becomes the latest draft.
    """
    assessment = _get_assessment(db, assessment_id)
    if not assessment:
        raise HTTPException(status_code=404, detail="Assessment not found")
    if not is_admin(user) and (
        assessment.get("assigned_engineer_user_id") is None
        or int(assessment["assigned_engineer_user_id"]) != int(user["id"])
    ):
        raise HTTPException(status_code=403, detail="Only the assigned engineer can add technical submissions")
    if assessment["state"] not in {"DRAFT", "REVISION_REQUESTED"}:
        raise HTTPException(status_code=409, detail=f"Cannot add a technical submission in state {assessment['state']}")

    incident_id = int(assessment["incident_id"])
    incident = incidents_routes._incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")

    owner_id = (
        int(assessment["assigned_engineer_user_id"])
        if assessment.get("assigned_engineer_user_id") is not None
        else int(user["id"])
    )
    notes = (payload.notes or "").strip() or None
    try:
        has_primary_link = db.execute(
            text("SELECT 1 FROM incident_submission_links WHERE incident_id = :iid LIMIT 1"),
            {"iid": incident_id},
        ).scalar()
        submission_id = incidents_routes._create_linked_submission(
            db=db,
            incident_row=dict(incident),
            assignee_user_id=owner_id,
            actor_user_id=int(user["id"]),
            link_incident=not bool(has_primary_link),
        )
        _link_assessment_submission(
            db, assessment_id=assessment_id, submission_id=submission_id, actor_user_id=int(user["id"])
        )
        _record_event(
            db,
            incident_id=incident_id,
            assessment_id=assessment_id,
            actor_user_id=int(user["id"]),
            event_type="SUBMISSION_CREATED",
            notes=notes or f"Draft technical submission #{submission_id} created.",
            metadata={"submission_id": submission_id},
        )
        db.commit()
        return {"assessment": _assessment_payload(db, assessment_id), "submission_id": submission_id}
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


# ---------------------------------------------------------------------------
# Engineer: submit / resubmit for review
# ---------------------------------------------------------------------------


@router.post("/assessments/{assessment_id}/submit")
def submit_assessment(
    payload: AssessmentSubmitRequest,
    assessment_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(ENGINEER_ROLES)),
):
    assessment = _get_assessment(db, assessment_id)
    if not assessment:
        raise HTTPException(status_code=404, detail="Assessment not found")
    # Only the assigned engineer (or admin) may submit this assessment.
    if not is_admin(user) and (
        assessment.get("assigned_engineer_user_id") is None
        or int(assessment["assigned_engineer_user_id"]) != int(user["id"])
    ):
        raise HTTPException(status_code=403, detail="Only the assigned engineer can submit this assessment")
    if assessment["state"] not in {"DRAFT", "REVISION_REQUESTED"}:
        raise HTTPException(status_code=409, detail=f"Cannot submit from state {assessment['state']}")
    if not _submission_ids_for(db, assessment):
        raise HTTPException(
            status_code=409,
            detail="Attach at least one technical submission before submitting the assessment for review",
        )

    db.execute(
        text(
            """
            UPDATE assessments
            SET state = 'SUBMITTED', submitted_at = NOW(), updated_at = NOW()
            WHERE id = :aid
            """
        ),
        {"aid": assessment_id},
    )
    _record_event(
        db,
        incident_id=int(assessment["incident_id"]),
        assessment_id=assessment_id,
        actor_user_id=int(user["id"]),
        event_type="SUBMITTED",
        from_state=assessment["state"],
        to_state="SUBMITTED",
        notes=(payload.notes or "").strip() or None,
    )
    db.commit()
    return {"assessment": _assessment_payload(db, assessment_id)}


# ---------------------------------------------------------------------------
# Assigned reviewer/approver: approve or request revisions
# ---------------------------------------------------------------------------


@router.post("/assessments/{assessment_id}/review")
def review_assessment(
    payload: AssessmentReviewRequest,
    assessment_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(OPERATIONAL_READ_ROLES)),
):
    assessment = _get_assessment(db, assessment_id)
    if not assessment:
        raise HTTPException(status_code=404, detail="Assessment not found")
    # Authority is assignment-based, verified server-side — never a global role.
    if not _has_active_review_authority(db, assessment_id, user):
        raise HTTPException(
            status_code=403,
            detail="You are not an assigned reviewer/approver for this assessment",
        )
    if assessment["state"] != "SUBMITTED":
        raise HTTPException(status_code=409, detail=f"Cannot review from state {assessment['state']}")

    notes = (payload.notes or "").strip() or None
    if payload.action == "APPROVE":
        db.execute(
            text("UPDATE assessments SET state='APPROVED', approved_at=NOW(), updated_at=NOW() WHERE id=:aid"),
            {"aid": assessment_id},
        )
        _record_event(
            db,
            incident_id=int(assessment["incident_id"]),
            assessment_id=assessment_id,
            actor_user_id=int(user["id"]),
            event_type="APPROVED",
            from_state="SUBMITTED",
            to_state="APPROVED",
            notes=notes,
        )
        next_state = "APPROVED"
    else:  # REQUEST_REVISION
        db.execute(
            text(
                "UPDATE assessments SET state='REVISION_REQUESTED', review_requested_at=NOW(), updated_at=NOW() WHERE id=:aid"
            ),
            {"aid": assessment_id},
        )
        _record_event(
            db,
            incident_id=int(assessment["incident_id"]),
            assessment_id=assessment_id,
            actor_user_id=int(user["id"]),
            event_type="REVISION_REQUESTED",
            from_state="SUBMITTED",
            to_state="REVISION_REQUESTED",
            notes=notes,
        )
        next_state = "REVISION_REQUESTED"
    db.commit()
    return {"assessment": _assessment_payload(db, assessment_id), "state": next_state}


# ---------------------------------------------------------------------------
# Finalize (post-approval). Closure policy is intentionally minimal — see docs.
# ---------------------------------------------------------------------------


@router.post("/assessments/{assessment_id}/finalize")
def finalize_assessment(
    payload: AssessmentFinalizeRequest,
    assessment_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(OFFICE_CHIEF_ROLES)),
):
    assessment = _get_assessment(db, assessment_id)
    if not assessment:
        raise HTTPException(status_code=404, detail="Assessment not found")
    incidents_routes._ensure_incident_office_access(user, assessment.get("office_code"))
    if assessment["state"] != "APPROVED":
        raise HTTPException(status_code=409, detail="Only APPROVED assessments can be finalized")
    db.execute(
        text("UPDATE assessments SET state='FINALIZED', finalized_at=NOW(), updated_at=NOW() WHERE id=:aid"),
        {"aid": assessment_id},
    )
    _record_event(
        db,
        incident_id=int(assessment["incident_id"]),
        assessment_id=assessment_id,
        actor_user_id=int(user["id"]),
        event_type="FINALIZED",
        from_state="APPROVED",
        to_state="FINALIZED",
        notes=(payload.notes or "").strip() or None,
    )
    db.commit()
    return {"assessment": _assessment_payload(db, assessment_id)}

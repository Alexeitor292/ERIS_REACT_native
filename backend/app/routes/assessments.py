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
  * Write actions are gated by organization role AND, for review, by the
    assessment's own ROUTING PATH, verified server-side: on the branch route
    only the branch chief it was handed to may review; on the senior-specialist
    route only an office chief of that assessment's office may. Neither the
    legacy REVIEWER role nor a REVIEWER/APPROVER assignment row confers any
    authority (routing v2, design §4).
"""

from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Path, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import get_current_user, require_roles
from ..roles import (
    ADMIN,
    GEOTECH_BRANCH_CHIEF,
    GEOTECH_OFFICE_CHIEF,
    GISA_AUTHOR_ROLES,
    LEGACY_REVIEWER,
    MAINTENANCE_COORDINATOR,
    OPERATIONAL_ROLES,
    expand_roles,
    has_canonical_role,
    is_admin,
    is_maintenance_only,
    is_operational_user,
)
from ..schemas.common import (
    AssessmentAssignEngineerRequest,
    AssessmentAssignmentRequest,
    AssessmentAssignSpecialistRequest,
    AssessmentCreateSubmissionRequest,
    AssessmentDelegateBranchRequest,
    AssessmentFinalizeRequest,
    AssessmentReviewRequest,
    AssessmentSubmitRequest,
    IncidentTriageRequest,
)
from ..services import notifications as notifications_svc
from ..services import office_routing
from ..services import workflow_tree as workflow_tree_svc
from ..user_metadata import normalize_office_code
from . import incidents as incidents_routes

router = APIRouter(tags=["assessments"])

# Guard role lists (canonical + legacy aliases).
TRIAGE_ROLES = expand_roles(MAINTENANCE_COORDINATOR) + [ADMIN]
OFFICE_CHIEF_ROLES = expand_roles(GEOTECH_OFFICE_CHIEF) + [ADMIN]
BRANCH_CHIEF_ROLES = expand_roles(GEOTECH_BRANCH_CHIEF) + [ADMIN]
# Authoring the assessment (fill / submit / add a supplemental) is open to the
# senior specialist as well as the engineer — on the specialist route the
# specialist IS the assignee (design §2.1, §5.2). The identity check inside each
# endpoint stays the real gate.
ASSESSMENT_AUTHOR_ROLES = GISA_AUTHOR_ROLES
# CONSULTED is the only writable assignment role in v2: review authority follows
# the routing path, so nobody "adds a reviewer" any more (design §4.2). Same
# membership as the old ASSIGN_REVIEWER_ROLES.
ASSIGN_CONSULTED_ROLES = expand_roles(GEOTECH_OFFICE_CHIEF, GEOTECH_BRANCH_CHIEF) + [ADMIN]
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

# The route discriminator (assessments.routing_path). NULL means the office
# chief has not chosen yet; the two routes are mutually exclusive and the choice
# is not reversible. Swapping *people* within a route stays legal.
ROUTE_BRANCH = "BRANCH"
ROUTE_SENIOR_SPECIALIST = "SENIOR_SPECIALIST"

# assessment_assignments.assignment_role for the assessment's author, per route.
ROLE_ENGINEER = "ENGINEER"
ROLE_SENIOR_SPECIALIST = "SENIOR_SPECIALIST"

# Approval ends the assessment. FINALIZED is legacy history: nothing new enters
# it (the database refuses via trg_assessment_no_new_finalize), but existing
# rows stay valid and filterable.
TERMINAL_ASSESSMENT_STATES = {"APPROVED", "FINALIZED"}


# ---------------------------------------------------------------------------
# Serialization + small helpers
# ---------------------------------------------------------------------------


def _review_owner(row: dict) -> dict | None:
    """Who may review THIS assessment, by route (design §4.1).

    ``BRANCH`` names one person (``branch_chief_user_id``); ``SENIOR_SPECIALIST``
    names an office *function* — any active office chief of that office — so its
    ``user_id`` is null by design. NULL routing_path has no reviewer yet.
    """
    routing_path = row.get("routing_path")
    if routing_path == ROUTE_BRANCH:
        return {
            "kind": "BRANCH_CHIEF",
            "user_id": int(row["branch_chief_user_id"]) if row.get("branch_chief_user_id") is not None else None,
            "office_code": row.get("office_code"),
        }
    if routing_path == ROUTE_SENIOR_SPECIALIST:
        return {"kind": "OFFICE_CHIEF", "user_id": None, "office_code": row.get("office_code")}
    return None


def _serialize_assessment(row: dict, submission_ids: list[int] | None = None, *, user: dict | None = None) -> dict:
    """Serialize an assessment row.

    ``submission_id`` stays the latest/primary technical submission for backward
    compatibility; ``submission_ids`` lists every technical submission attached
    to the assessment (oldest first). Callers that already loaded the join rows
    pass them in; otherwise the single legacy id is echoed.

    ``assigned_user_id`` / ``assigned_user_kind`` are the route-neutral aliases
    over ``assigned_engineer_user_id`` (design §3.2), and ``can_review`` /
    ``review_owner`` let a client render the decision affordance without
    re-deriving authority from role strings. ``can_review`` is false whenever the
    caller is unknown.
    """
    primary = int(row["submission_id"]) if row.get("submission_id") is not None else None
    if submission_ids is None:
        submission_ids = [primary] if primary is not None else []
    routing_path = row.get("routing_path")
    assigned_user_id = (
        int(row["assigned_engineer_user_id"]) if row.get("assigned_engineer_user_id") is not None else None
    )
    assigned_user_kind = None
    if assigned_user_id is not None:
        assigned_user_kind = (
            "SENIOR_SPECIALIST" if routing_path == ROUTE_SENIOR_SPECIALIST else "ENGINEER"
        )
    can_review = bool(user) and _review_authority(None, row, user)[0] and row["state"] == "SUBMITTED"
    return {
        "id": int(row["id"]),
        "assessment_uuid": row["assessment_uuid"],
        "incident_id": int(row["incident_id"]),
        "submission_id": primary,
        "submission_ids": list(submission_ids),
        "district": row.get("district"),
        "office_code": row.get("office_code"),
        "office_override_reason": row.get("office_override_reason"),
        "routing_path": routing_path,
        "branch_chief_user_id": int(row["branch_chief_user_id"]) if row.get("branch_chief_user_id") is not None else None,
        "assigned_engineer_user_id": assigned_user_id,
        "assigned_user_id": assigned_user_id,
        "assigned_user_kind": assigned_user_kind,
        "can_review": can_review,
        "review_owner": _review_owner(row),
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


# The single SELECT list behind _get_assessment, _get_assessment_for_incident
# and list_assessments — every authority check, queue and serializer reads the
# assessment out of it, so a column added here is available everywhere.
#
# NOTE ``assigned_engineer_user_id`` holds the assignee on BOTH routes: on a
# ``routing_path = 'SENIOR_SPECIALIST'`` row it names a senior specialist, not an
# engineer. The column keeps its (now partly misleading) name because renaming
# it is destructive and would force a second branch into every reader — the
# queue SQL, the submit identity check, ``idx_assessment_engineer``,
# workflow_tree, incident_classification, web and mobile — for no gain, since
# ``routing_path`` already says which kind of person the id names. The API
# exposes the route-neutral aliases ``assigned_user_id`` / ``assigned_user_kind``.
_ASSESSMENT_COLUMNS = """
  a.id, a.assessment_uuid, a.incident_id, a.submission_id, a.district,
  a.office_code, a.office_override_reason, a.routing_path, a.branch_chief_user_id,
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


def _assessment_payload(db: Session, assessment_id: int, user: dict | None = None) -> dict:
    assessment = _get_assessment(db, assessment_id)
    if not assessment:
        raise HTTPException(status_code=404, detail="Assessment not found")
    return _serialize_assessment(assessment, _submission_ids_for(db, assessment), user=user)


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
            "is_active": int(r["is_active"]),
            # No assignment row confers review authority in v2 (design §4.2), so
            # this is always false — it is serialized rather than implied so a
            # client can render a historical REVIEWER/APPROVER row as "Former
            # reviewer — no approval authority" instead of current authority.
            "is_authority": False,
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


def _review_authority(db: Session | None, assessment: dict, user: dict) -> tuple[bool, str]:
    """Who may review THIS assessment — derived from its routing path (design §4.1).

    Replaces the assignment-based ``_has_active_review_authority``: an active
    REVIEWER/APPROVER assignment row confers nothing in v2, and neither does the
    legacy REVIEWER account role. On the branch route authority belongs to the
    one branch chief the assessment was handed to; on the senior-specialist route
    it belongs to the OFFICE — any active office chief whose ``office_code``
    matches the assessment's — because offices have more than one chief and
    binding to a person would strand the assessment whenever that person is away.
    Who assigned the specialist is preserved in the SPECIALIST_ASSIGNED event.

    Returns ``(allowed, reason)``; the reason is the 403 body and the serialized
    hint, so the two can never drift apart. ``db`` is accepted (and unused) so
    the signature reads like the other assessment helpers and a future rule that
    needs a query does not force every call site to change.
    """
    if is_admin(user):
        return True, "Admin"
    routing_path = assessment.get("routing_path")
    if routing_path == ROUTE_BRANCH:
        branch_chief_user_id = assessment.get("branch_chief_user_id")
        allowed = (
            branch_chief_user_id is not None
            and int(branch_chief_user_id) == int(user["id"])
            and has_canonical_role(user, GEOTECH_BRANCH_CHIEF)
        )
        return allowed, "Only the branch chief this assessment was handed to can review it"
    if routing_path == ROUTE_SENIOR_SPECIALIST:
        user_office = normalize_office_code((user.get("metadata") or {}).get("office_code"))
        assessment_office = normalize_office_code(assessment.get("office_code"))
        # Explicit falsy guard on BOTH offices, not a chained `!= ''`:
        # normalize_office_code returns None (never '') for blank input, so
        # `a == b != ''` would be satisfied by None == None and would hand review
        # of an office-less assessment to any unscoped chief.
        allowed = (
            has_canonical_role(user, GEOTECH_OFFICE_CHIEF)
            and bool(user_office)
            and bool(assessment_office)
            and user_office == assessment_office
        )
        return allowed, "Only an office chief of this assessment's GeoTech office can review it"
    return False, "This assessment has not been routed yet"


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
    return {"assessment": _assessment_payload(db, assessment_id, user)}


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
    """Broad read for non-maintenance operational users.

    Optional ``queue`` narrows to the caller's work queue (design §5.5):
    ``office_chief`` | ``office_chief_review`` | ``branch_chief`` |
    ``branch_chief_review`` | ``assignee`` | ``engineer`` (alias of ``assignee``)
    | ``reviewer`` (a permanent per-path alias, see below).
    """
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
        # To route: nothing has been chosen yet.
        where.append("a.state = 'PENDING_OFFICE_DELEGATION'")
        _scope_office(user, where, params)
    elif q == "office_chief_review":
        # To review, specialist route. STRICT office scoping: an office chief
        # with no office_code can review nothing (§4.1), so their review queue
        # must be empty rather than every office's.
        where.append(f"a.state = 'SUBMITTED' AND a.routing_path = '{ROUTE_SENIOR_SPECIALIST}'")
        _scope_office(user, where, params, strict=True)
    elif q == "branch_chief":
        # To assign an engineer. The old `OR branch_chief_user_id IS NULL` clause
        # is gone: a NULL branch chief now means the specialist route or an
        # unrouted assessment, neither of which belongs in a branch chief's
        # assignment queue.
        where.append(f"a.state = 'PENDING_ENGINEER_ASSIGNMENT' AND a.routing_path = '{ROUTE_BRANCH}'")
        if not is_admin(user):
            where.append("a.branch_chief_user_id = :me")
            params["me"] = int(user["id"])
        _scope_office(user, where, params)
    elif q == "branch_chief_review":
        # To review, branch route. Identity already narrows it, so office
        # scoping stays permissive.
        where.append(f"a.state = 'SUBMITTED' AND a.routing_path = '{ROUTE_BRANCH}'")
        if not is_admin(user):
            where.append("a.branch_chief_user_id = :me")
            params["me"] = int(user["id"])
        _scope_office(user, where, params)
    elif q in ("assignee", "engineer"):
        # Everything assigned to me, on either route: both store the assignee in
        # assigned_engineer_user_id (§3.2). No state filter, no office scope —
        # the same shape the `engineer` queue has always had, which is why
        # `engineer` survives as an alias.
        where.append("a.assigned_engineer_user_id = :me")
        params["me"] = int(user["id"])
    elif q == "reviewer":
        # PERMANENT alias, resolved per path — MyWorkPage requests it
        # unconditionally for every role inside one Promise.all, so a 400 here
        # would blank My Work for everyone. Admin sees every submitted
        # assessment, matching the review bypass.
        params["me"] = int(user["id"])
        if is_admin(user):
            where.append("a.state = 'SUBMITTED'")
        else:
            my_office = normalize_office_code((user.get("metadata") or {}).get("office_code"))
            specialist_half = "0"
            if has_canonical_role(user, GEOTECH_OFFICE_CHIEF) and my_office:
                # Strict on the specialist half: an unscoped chief matches nothing.
                specialist_half = f"(a.routing_path = '{ROUTE_SENIOR_SPECIALIST}' AND a.office_code = :my_office)"
                params["my_office"] = my_office
            where.append(
                "a.state = 'SUBMITTED' AND ("
                f"(a.routing_path = '{ROUTE_BRANCH}' AND a.branch_chief_user_id = :me)"
                f" OR {specialist_half})"
            )
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
        serialized.append(_serialize_assessment(item, ids, user=user))
    return {"items": serialized, "requested_by_user_id": int(user["id"])}


def _scope_office(user: dict, where: list[str], params: dict, *, strict: bool = False) -> None:
    """Optionally narrow office-scoped queues to the caller's office. Admins are
    not scoped.

    Permissive (the default): a user without an ``office_code`` sees the unscoped
    queue — broad read is allowed and the narrowing is a convenience, not a
    security boundary.

    ``strict=True`` is for the REVIEW queues (design §5.5). Review became
    office-scoped in v2, so a chief with no ``office_code`` can review nothing:
    their review queue must be empty (``1=0``), never every office's.
    """
    if is_admin(user):
        return
    office = normalize_office_code((user.get("metadata") or {}).get("office_code"))
    if office:
        if strict:
            # An office-less assessment has no office chief to review it either.
            where.append("a.office_code = :scoped_office")
        else:
            where.append("(a.office_code = :scoped_office OR a.office_code IS NULL)")
        params["scoped_office"] = office
    elif strict:
        where.append("1=0")


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
        "assessment": _serialize_assessment(assessment, _submission_ids_for(db, assessment), user=user),
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
        "assessment": _serialize_assessment(assessment, _submission_ids_for(db, assessment), user=user),
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
    """Hand the assessment off to a branch chief, and stamp the branch route.

    One of the office chief's two mutually exclusive choices; the other is
    ``POST /assessments/{id}/assign-specialist``. From the hand-off onward the
    branch chief owns the assessment: they assign the engineer, and they review
    what comes back.

    RE-DELEGATION is a first-class transition, not an escape hatch. It is
    accepted from any non-terminal branch-route state and rewrites only
    ``branch_chief_user_id``: ``fk_assessment_branch_chief ON DELETE SET NULL``
    means deleting a branch chief NULLs that column while the state stays
    wherever it was (deactivation and departure do the same in practice), and
    because review authority binds to that one id, an assessment sitting in
    SUBMITTED would otherwise be reviewable by admin only, with no supported
    repair. Re-delegating from SUBMITTED hands the pending decision to the new
    chief, which is the point. The office chief regains reach over a branch-route
    assessment ONLY for this one act — they still cannot assign the engineer,
    review, or approve.
    """
    assessment = _get_assessment(db, assessment_id)
    if not assessment:
        raise HTTPException(status_code=404, detail="Assessment not found")
    if payload.engineer_user_id is not None:
        # Rejected, not ignored: an old client gets an explanation instead of a
        # silent behaviour change. Chiefs assign specialists only; branch chiefs
        # assign engineers only.
        raise HTTPException(
            status_code=400,
            detail=(
                "The office chief can no longer assign staff directly. Hand off to a "
                "branch chief, or assign a senior specialist with "
                "POST /assessments/{id}/assign-specialist."
            ),
        )
    if assessment["state"] in TERMINAL_ASSESSMENT_STATES:
        raise HTTPException(status_code=409, detail="This assessment is complete; it cannot be re-routed.")
    if assessment.get("routing_path") == ROUTE_SENIOR_SPECIALIST:
        raise HTTPException(
            status_code=409,
            detail="This assessment was assigned to a senior specialist; the branch route is not available.",
        )

    office_code = assessment.get("office_code")
    incidents_routes._ensure_incident_office_access(user, office_code)
    incident_id = int(assessment["incident_id"])

    allowed = set(
        incidents_routes._routing_users_for(db=db, assignment_type="BRANCH_CHIEF", office_code=office_code)
    )
    if int(payload.branch_chief_user_id) not in allowed:
        raise HTTPException(status_code=400, detail="Selected user is not a branch chief for this office")

    # The first hand-off advances the workflow; a later one only swaps the
    # person. Re-delegation leaves the state, the engineer, the linked
    # submission and the incident stage exactly where they are, so a departed,
    # deactivated or deleted branch chief never strands a SUBMITTED assessment.
    first_handoff = assessment["state"] == "PENDING_OFFICE_DELEGATION"
    previous_branch_chief = (
        int(assessment["branch_chief_user_id"]) if assessment.get("branch_chief_user_id") is not None else None
    )
    to_state = "PENDING_ENGINEER_ASSIGNMENT" if first_handoff else assessment["state"]

    try:
        notes = (payload.notes or "").strip() or None
        db.execute(
            text(
                """
                UPDATE assessments
                SET routing_path = 'BRANCH',
                    branch_chief_user_id = :bc,
                    state = CASE WHEN state = 'PENDING_OFFICE_DELEGATION'
                                 THEN 'PENDING_ENGINEER_ASSIGNMENT' ELSE state END,
                    office_delegated_at = NOW(),
                    updated_at = NOW()
                WHERE id = :aid
                """
            ),
            {"bc": int(payload.branch_chief_user_id), "aid": assessment_id},
        )
        if first_handoff:
            # Keep legacy incident stage machine in sync. Only on the first
            # hand-off: a re-delegation must not drag the incident backwards out
            # of ENGINEER_ASSIGNED.
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
            to_state=to_state,
            notes=notes,
            metadata={
                "branch_chief_user_id": int(payload.branch_chief_user_id),
                "previous_branch_chief_user_id": previous_branch_chief,
                "routing_path": ROUTE_BRANCH,
            },
        )
        db.commit()
        return {"assessment": _assessment_payload(db, assessment_id, user)}
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
    assignment_role: str = ROLE_ENGINEER,
    event_type: str = "ENGINEER_ASSIGNED",
) -> int | None:
    """Assign (or reassign) the assessment's author.

    Reuses the legacy engineer-assignment flow: it sets the ENGINEER stage
    assignment, advances the incident, and creates/links the primary GISA draft
    (the technical assessment form). Offline draft behaviour is preserved. The
    linked draft is also attached to the assessment's submission list. Returns
    the linked submission id. Caller commits.

    ``assignment_role`` is the assessment-level assignment role written to
    ``assessment_assignments`` — ``ENGINEER`` on the branch route,
    ``SENIOR_SPECIALIST`` on the specialist route. Both the deactivation of the
    prior row and the insert are scoped to it, so reassigning a specialist
    retires the previous SENIOR_SPECIALIST row instead of leaving two rows
    active for ``idx_assessment_assign_lookup`` to return. The incident-level
    stage assignment stays ``ENGINEER`` on both routes.
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
    # Mirror the assignee into the assessment-level assignment table.
    db.execute(
        text(
            """
            UPDATE assessment_assignments SET is_active = 0, updated_at = NOW()
            WHERE assessment_id = :aid AND assignment_role = :role AND is_active = 1
            """
        ),
        {"aid": assessment_id, "role": assignment_role},
    )
    db.execute(
        text(
            """
            INSERT INTO assessment_assignments (assessment_id, user_id, assignment_role, assigned_by_user_id, notes)
            VALUES (:aid, :uid, :role, :by, :notes)
            """
        ),
        {
            "aid": assessment_id,
            "uid": engineer_user_id,
            "role": assignment_role,
            "by": actor_user_id,
            "notes": notes,
        },
    )
    incidents_routes._notify_coordinator_engineer_assigned(db=db, incident_id=incident_id)
    if assignment_role == ROLE_SENIOR_SPECIALIST:
        # There is no column recording WHO assigned the specialist, and the
        # specialist route's review authority is the office rather than the
        # assigner (design §4.1), so this event is the only record of it.
        event_metadata = {
            "specialist_user_id": engineer_user_id,
            "assigned_by_user_id": actor_user_id,
            "submission_id": linked_submission_id,
        }
    else:
        event_metadata = {"engineer_user_id": engineer_user_id, "submission_id": linked_submission_id}
    _record_event(
        db,
        incident_id=incident_id,
        assessment_id=assessment_id,
        actor_user_id=actor_user_id,
        event_type=event_type,
        from_state=prior_state,
        to_state="DRAFT",
        notes=notes,
        metadata=event_metadata,
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
    if assessment["state"] in TERMINAL_ASSESSMENT_STATES:
        raise HTTPException(status_code=409, detail=f"Cannot assign engineer from state {assessment['state']}")
    routing_path = assessment.get("routing_path")
    if routing_path == ROUTE_SENIOR_SPECIALIST:
        raise HTTPException(status_code=409, detail="This assessment took the senior specialist route")
    if routing_path != ROUTE_BRANCH:
        raise HTTPException(
            status_code=409,
            detail="This assessment has not been routed yet; the office chief must hand it off to a branch chief first",
        )
    # Only the branch chief this assessment was handed to. There was no identity
    # check here before, so any branch chief in the office could assign on an
    # assessment handed to a colleague — and in v2 that same person is the
    # reviewer, so ownership has to be exact. Admin bypasses.
    if not is_admin(user):
        branch_chief_user_id = assessment.get("branch_chief_user_id")
        if branch_chief_user_id is None or int(branch_chief_user_id) != int(user["id"]):
            raise HTTPException(
                status_code=403,
                detail="Only the branch chief this assessment was handed to can assign an engineer",
            )
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
        return {"assessment": _assessment_payload(db, assessment_id, user)}
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


# ---------------------------------------------------------------------------
# Office chief: assign a senior specialist directly (the second route)
# ---------------------------------------------------------------------------


@router.get("/assessments/{assessment_id}/specialist-options")
def assessment_specialist_options(
    assessment_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(OFFICE_CHIEF_ROLES)),
):
    """The senior specialists this office chief may assign (design §5.1).

    The assessment-scoped twin of ``/assessments/{id}/branch-options``: the two
    together are the office chief's two-choice route step.
    """
    assessment = _get_assessment(db, assessment_id)
    if not assessment:
        raise HTTPException(status_code=404, detail="Assessment not found")
    office_code = assessment.get("office_code")
    incidents_routes._ensure_incident_office_access(user, office_code)
    return {
        "assessment_id": assessment_id,
        "office_code": office_code,
        "items": incidents_routes._routing_user_options_for(
            db=db, assignment_type="SENIOR_SPECIALIST", office_code=office_code
        ),
    }


@router.post("/assessments/{assessment_id}/assign-specialist")
def assign_specialist(
    payload: AssessmentAssignSpecialistRequest,
    assessment_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(OFFICE_CHIEF_ROLES)),
):
    """Assign a GeoTech senior specialist directly — transition T4 (design §3.3).

    The office chief's other choice. The specialist fills the technical form
    exactly as a staff engineer does and reports back to the office chief, who
    reviews. Reassigning the specialist from DRAFT / REVISION_REQUESTED is legal;
    switching to the branch route is not.
    """
    assessment = _get_assessment(db, assessment_id)
    if not assessment:
        raise HTTPException(status_code=404, detail="Assessment not found")
    if assessment["state"] in TERMINAL_ASSESSMENT_STATES:
        raise HTTPException(status_code=409, detail="This assessment is complete; it cannot be re-routed.")
    if assessment.get("routing_path") == ROUTE_BRANCH:
        raise HTTPException(
            status_code=409,
            detail="This assessment was handed off to a branch chief; the senior specialist route is not available.",
        )
    if assessment["state"] not in {"PENDING_OFFICE_DELEGATION", "DRAFT", "REVISION_REQUESTED"}:
        raise HTTPException(status_code=409, detail=f"Cannot assign a senior specialist from state {assessment['state']}")

    office_code = assessment.get("office_code")
    incidents_routes._ensure_incident_office_access(user, office_code)
    allowed = set(
        incidents_routes._routing_users_for(
            db=db, assignment_type="SENIOR_SPECIALIST", office_code=office_code
        )
    )
    if int(payload.specialist_user_id) not in allowed:
        raise HTTPException(status_code=400, detail="Selected user is not a senior specialist for this office")

    try:
        notes = (payload.notes or "").strip() or None
        # The route is stamped FIRST, in its own statement, BEFORE the shared
        # assignment machinery runs: trg_incident_engineer_elig_bi reads
        # assessments.routing_path to decide which eligibility rule applies to
        # the incident_assignments row that _assign_incident writes, and that
        # write is the first thing _perform_engineer_assignment does. Reordering
        # these two statements would silently apply the ENGINEER rule to a
        # specialist and reject a valid assignment (design §7.3).
        db.execute(
            text(
                """
                UPDATE assessments
                SET routing_path = :route, updated_at = NOW()
                WHERE id = :aid
                """
            ),
            {"route": ROUTE_SENIOR_SPECIALIST, "aid": assessment_id},
        )
        assessment = _get_assessment(db, assessment_id) or assessment
        submission_id = _perform_engineer_assignment(
            db,
            assessment=assessment,
            engineer_user_id=int(payload.specialist_user_id),
            actor_user_id=int(user["id"]),
            notes=notes,
            assignment_role=ROLE_SENIOR_SPECIALIST,
            event_type="SPECIALIST_ASSIGNED",
        )
        incidents_routes._queue_incident_notifications(
            db=db,
            incident_id=int(assessment["incident_id"]),
            recipient_user_ids=[int(payload.specialist_user_id)],
            template_code="ASSESSMENT_SPECIALIST_ASSIGNMENT",
            payload={
                "assessment_id": assessment_id,
                "incident_id": int(assessment["incident_id"]),
                "office_code": office_code,
                "routing_path": ROUTE_SENIOR_SPECIALIST,
                "assigned_by_user_id": int(user["id"]),
            },
        )
        db.commit()
        return {
            "assessment": _assessment_payload(db, assessment_id, user),
            "submission_id": submission_id,
        }
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


# ---------------------------------------------------------------------------
# Consulted assignment (assessment-level; for information only)
# ---------------------------------------------------------------------------


@router.post("/assessments/{assessment_id}/assignments")
def add_assignment(
    payload: AssessmentAssignmentRequest,
    assessment_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(ASSIGN_CONSULTED_ROLES)),
):
    """Attach someone to the assessment FOR INFORMATION (CONSULTED).

    Reviewer assignment is retired: review authority follows the assessment's
    routing path (design §4.2), so CONSULTED — which never conferred authority —
    is the only writable assignment role left. The request schema narrows to it;
    this guard is the belt to that braces, and carries the explanation.
    """
    assessment = _get_assessment(db, assessment_id)
    if not assessment:
        raise HTTPException(status_code=404, detail="Assessment not found")
    if payload.assignment_role != "CONSULTED":
        raise HTTPException(
            status_code=400,
            detail="Reviewer assignment was retired. Review authority follows the assessment's routing path.",
        )
    incidents_routes._ensure_incident_office_access(user, assessment.get("office_code"))

    target = db.execute(
        text("SELECT id, is_active, metadata_json FROM users WHERE id = :uid LIMIT 1"),
        {"uid": int(payload.user_id)},
    ).mappings().first()
    if not target or int(target["is_active"]) != 1:
        raise HTTPException(status_code=404, detail="Target user not found or inactive")

    # Any non-maintenance operational user may be attached for information; a
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
            detail="Consulted user must be a non-maintenance operational user",
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
    user=Depends(require_roles(ASSIGN_CONSULTED_ROLES)),
):
    assessment = _get_assessment(db, assessment_id)
    if not assessment:
        raise HTTPException(status_code=404, detail="Assessment not found")
    incidents_routes._ensure_incident_office_access(user, assessment.get("office_code"))
    # The refusal widens from ENGINEER to the assignee row on EITHER route: the
    # author's assignment is written by assign-engineer / assign-specialist and
    # must be changed there, never detached here.
    db.execute(
        text(
            """
            UPDATE assessment_assignments SET is_active = 0, updated_at = NOW()
            WHERE id = :id AND assessment_id = :aid
              AND assignment_role NOT IN ('ENGINEER', 'SENIOR_SPECIALIST')
            """
        ),
        {"id": assignment_id, "aid": assessment_id},
    )
    db.commit()
    return {"assessment_id": assessment_id, "assignments": _active_assignments(db, assessment_id)}


# ---------------------------------------------------------------------------
# B1: keep the linked technical submissions in step with the assessment
# ---------------------------------------------------------------------------

# assessments.state and submissions.status used to be two independent machines,
# which is why an engineer could be told to fix a form the server had locked and
# a reviewer saw two Approve buttons. In v2 `submit` and `review` drive both in
# the SAME transaction (design §3.5).
#
# The plan is keyed by (assessment action, the row's CURRENT status) because
# transition_submission_concurrency_safe takes exactly one ``from_status`` and
# hard-fails on rowcount != 1: a single literal cannot survive a revision cycle,
# where the source is REJECTED rather than DRAFT. The mapping matches
# main.py's own submit/review vocabulary exactly.
_B1_PLAN: dict[str, dict[str, tuple[str, str]]] = {
    # action -> {current submission status: (workflow event_type, target status)}
    "submit": {"DRAFT": ("SUBMIT", "SUBMITTED"), "REJECTED": ("RESUBMIT", "SUBMITTED")},
    "APPROVE": {"SUBMITTED": ("APPROVE", "APPROVED")},
    "REQUEST_REVISION": {"SUBMITTED": ("REJECT", "REJECTED")},
}


def _drive_linked_submissions(
    db: Session,
    *,
    assessment: dict,
    action: str,
    actor_user_id: int,
    comment: str | None,
) -> tuple[list[int], list[dict]]:
    """Move every linked technical submission with the assessment.

    Returns ``(transitioned, skipped)``. A row already in the target state, or in
    any other state — a supplemental draft never submitted when the assessment is
    being approved, an APPROVED supplemental from a previous round — is skipped
    and never blocks the assessment, but it IS reported, so a desync is visible
    in the API instead of inferred from the database.

    The source status is read and passed PER ROW, so the helper's
    ``rowcount == 1 or 409`` guarantee stays intact and no new kwarg is added to
    it: a concurrent writer still produces a 409, which is the correct answer.
    The caller must therefore roll the assessment change back with it — hence the
    try/except wrappers on submit_assessment and review_assessment.
    """
    # Deferred import: app.main imports this router at module load, so a
    # top-level import here would be circular.
    from ..main import get_submission_status, transition_submission_concurrency_safe

    plan = _B1_PLAN.get(action, {})
    transitioned: list[int] = []
    skipped: list[dict] = []
    for submission_id in _submission_ids_for(db, assessment):
        current = get_submission_status(db, submission_id)
        step = plan.get(current)
        if step is None:
            skipped.append({"submission_id": submission_id, "status": current})
            continue
        event_type, to_status = step
        transition_submission_concurrency_safe(
            db=db,
            submission_id=submission_id,
            actor_user_id=actor_user_id,
            event_type=event_type,
            from_status=current,
            to_status=to_status,
            comment=comment,
        )
        transitioned.append(submission_id)
    return transitioned, skipped


# ---------------------------------------------------------------------------
# Assignee: supplemental technical submissions
# ---------------------------------------------------------------------------


@router.post("/assessments/{assessment_id}/submissions")
def create_assessment_submission(
    payload: AssessmentCreateSubmissionRequest,
    assessment_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(ASSESSMENT_AUTHOR_ROLES)),
):
    """Create another DRAFT technical submission for this assessment.

    The draft is pre-filled from the incident (district / county / route /
    post mile / coordinates) and owned by the assessment's assignee — the
    engineer on the branch route, the senior specialist on the specialist route.
    The incident's primary ``incident_submission_links`` row is left untouched;
    the new form is attached through ``assessment_submissions`` and becomes the
    latest draft.
    """
    assessment = _get_assessment(db, assessment_id)
    if not assessment:
        raise HTTPException(status_code=404, detail="Assessment not found")
    if not is_admin(user) and (
        assessment.get("assigned_engineer_user_id") is None
        or int(assessment["assigned_engineer_user_id"]) != int(user["id"])
    ):
        raise HTTPException(status_code=403, detail="Only the assessment's assignee can add technical submissions")
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
        return {"assessment": _assessment_payload(db, assessment_id, user), "submission_id": submission_id}
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


# ---------------------------------------------------------------------------
# Engineer: submit / resubmit for review
# ---------------------------------------------------------------------------


def _reviewer_recipients(db: Session, assessment: dict) -> list[int]:
    """The user ids that should be told an assessment is waiting for review.

    Branch route: the one branch chief it was handed to. Specialist route: every
    active office chief of the assessment's office, because authority there is
    the office function rather than one person (design §4.1, §6.1).
    """
    routing_path = assessment.get("routing_path")
    if routing_path == ROUTE_BRANCH:
        branch_chief_user_id = assessment.get("branch_chief_user_id")
        return [int(branch_chief_user_id)] if branch_chief_user_id is not None else []
    if routing_path == ROUTE_SENIOR_SPECIALIST:
        return incidents_routes._routing_users_for(
            db=db, assignment_type="OFFICE_CHIEF", office_code=assessment.get("office_code")
        )
    return []


@router.post("/assessments/{assessment_id}/submit")
def submit_assessment(
    payload: AssessmentSubmitRequest,
    assessment_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(ASSESSMENT_AUTHOR_ROLES)),
):
    """Send the assessment for review — transition T5 (design §3.3).

    Also drives every linked technical submission DRAFT/REJECTED -> SUBMITTED in
    the same transaction (B1, §3.5), so the form the reviewer opens is locked
    exactly when the assessment says it is.
    """
    assessment = _get_assessment(db, assessment_id)
    if not assessment:
        raise HTTPException(status_code=404, detail="Assessment not found")
    # Only the assignee (engineer or senior specialist), or admin, may submit.
    if not is_admin(user) and (
        assessment.get("assigned_engineer_user_id") is None
        or int(assessment["assigned_engineer_user_id"]) != int(user["id"])
    ):
        raise HTTPException(status_code=403, detail="Only the assessment's assignee can submit this assessment")
    if assessment["state"] not in {"DRAFT", "REVISION_REQUESTED"}:
        raise HTTPException(status_code=409, detail=f"Cannot submit from state {assessment['state']}")
    if not _submission_ids_for(db, assessment):
        raise HTTPException(
            status_code=409,
            detail="Attach at least one technical submission before submitting the assessment for review",
        )

    notes = (payload.notes or "").strip() or None
    # B1 puts a 409-raising helper inside this endpoint, which committed bare
    # before v2: without this wrapper a mid-loop conflict would leave a partially
    # transitioned set of submissions on the session (design §11).
    try:
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
        transitioned, skipped = _drive_linked_submissions(
            db,
            assessment=assessment,
            action="submit",
            actor_user_id=int(user["id"]),
            comment=notes,
        )
        _record_event(
            db,
            incident_id=int(assessment["incident_id"]),
            assessment_id=assessment_id,
            actor_user_id=int(user["id"]),
            event_type="SUBMITTED",
            from_state=assessment["state"],
            to_state="SUBMITTED",
            notes=notes,
            metadata={"submissions_transitioned": transitioned, "submissions_skipped": skipped},
        )
        incidents_routes._queue_incident_notifications(
            db=db,
            incident_id=int(assessment["incident_id"]),
            recipient_user_ids=_reviewer_recipients(db, assessment),
            template_code="ASSESSMENT_SUBMITTED_FOR_REVIEW",
            payload={
                "assessment_id": assessment_id,
                "incident_id": int(assessment["incident_id"]),
                "routing_path": assessment.get("routing_path"),
                "office_code": assessment.get("office_code"),
                "submitted_by_user_id": int(user["id"]),
            },
        )
        db.commit()
        return {
            "assessment": _assessment_payload(db, assessment_id, user),
            "submissions_transitioned": transitioned,
            "submissions_skipped": skipped,
        }
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


# ---------------------------------------------------------------------------
# The route's reviewer: approve (terminal) or request revisions
# ---------------------------------------------------------------------------

# Every notice except the coordinator's approval notice is in-app only: they tell
# one named person that a queue of theirs has something in it, and adding a
# delivery dependency to them would buy nothing (design §6.1).
_NOTIFICATION_CHANNELS = ("IN_APP",)
# Owner decision 6: the coordinator's approval notice also goes out by email. The
# EMAIL row is written INSIDE the approval transaction (the audit record that a
# notice was due) and delivered best-effort after commit; with SMTP_HOST unset
# nothing is sent and the row simply stays undelivered (design §6.3, §6.4).
_APPROVAL_COORDINATOR_CHANNELS = ("IN_APP", "EMAIL")

# The role the coordinator is told approved the work. Authority is the route's
# reviewer function, so the title comes from the ROUTE, not from whatever role
# strings the caller happens to hold; admin's bypass (decision 6 of §1) is the
# one case with no route role to name.
_ADMIN_ROLE_TITLE = "Administrator"


def _role_title(role_code: str) -> str:
    """The display title for a role code, from the workflow tree's one map.

    Sharing ``workflow_tree._ROLE_TITLES`` (design §6.5) keeps the email and the
    workflow tree from drifting into two spellings of the same role.
    """
    return workflow_tree_svc._ROLE_TITLES.get(role_code, role_code)


def _approver_role_title(assessment: dict, user: dict) -> str:
    routing_path = assessment.get("routing_path")
    if routing_path == ROUTE_BRANCH and has_canonical_role(user, GEOTECH_BRANCH_CHIEF):
        return _role_title(GEOTECH_BRANCH_CHIEF)
    if routing_path == ROUTE_SENIOR_SPECIALIST and has_canonical_role(user, GEOTECH_OFFICE_CHIEF):
        return _role_title(GEOTECH_OFFICE_CHIEF)
    for candidate in (GEOTECH_OFFICE_CHIEF, GEOTECH_BRANCH_CHIEF):
        if has_canonical_role(user, candidate):
            return _role_title(candidate)
    if is_admin(user):
        return _ADMIN_ROLE_TITLE
    return _role_title("ASSESSMENT_REVIEWER")


def _site_descriptor(row: dict | None) -> str | None:
    """"District 7 · Los Angeles · Route 101 · PM 12.30" — the site in one line.

    ``route_label`` in the approval email (design §6.5). Missing pieces are
    dropped rather than printed empty, so a sparse incident still reads.
    """
    if not row:
        return None
    district = str(row.get("district") or "").strip()
    county = str(row.get("county") or "").strip()
    route = str(row.get("route") or "").strip()
    post_mile = str(row.get("post_mile") or "").strip()
    pieces = [
        f"District {district}" if district else None,
        county or None,
        f"Route {route}" if route else None,
        f"PM {post_mile}" if post_mile else None,
    ]
    label = " · ".join(piece for piece in pieces if piece)
    return label or None


def _office_location(db: Session, office_code: str | None) -> str | None:
    """The human-readable name of a GeoTech office, or None.

    ``office_location`` lives on the office's own staff (``users.metadata_json``,
    which is what ``database/init/020_seed.sql`` writes) and, for offices with a
    routing row, on ``geotech_office_routing.office_name``. Both are consulted so
    the email can name the office even when only one of them is populated.
    """
    code = normalize_office_code(office_code)
    if not code:
        return None
    location = db.execute(
        text(
            """
            SELECT JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.office_location')) AS office_location
            FROM users
            WHERE COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.office_code')), '') = :office_code
              AND JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.office_location')) IS NOT NULL
            ORDER BY is_active DESC, id ASC
            LIMIT 1
            """
        ),
        {"office_code": code},
    ).scalar()
    if location:
        return str(location)
    try:
        # SAVEPOINT, not a bare try/except: this runs INSIDE the approval
        # transaction, so a failing statement would otherwise poison the session
        # and the next statement would raise PendingRollbackError — turning a
        # cosmetic lookup into a failed approval. Naming the office is optional;
        # approving is not.
        with db.begin_nested():
            name = db.execute(
                text(
                    """
                    SELECT office_name
                    FROM geotech_office_routing
                    WHERE office_code = :office_code AND office_name IS NOT NULL
                    ORDER BY is_active DESC, district ASC
                    LIMIT 1
                    """
                ),
                {"office_code": code},
            ).scalar()
    except Exception:
        # Table missing (pre-migration) or transient error: the office code alone
        # still identifies the office in the message.
        return None
    return str(name) if name else None


def _approval_notification_payload(db: Session, assessment: dict, user: dict) -> dict:
    """The facts the approval notice is rendered from (design §6.5).

    Written into ``incident_notifications.payload_json`` so the message a
    coordinator receives describes the assessment AS APPROVED, not as it looks
    whenever the sweeper happens to run — a retry days later must not silently
    report a different office or a different approver. The IN_APP row carries the
    same payload so a future in-app inbox renders identical facts.
    """
    assessment_id = int(assessment["id"])
    incident_id = int(assessment["incident_id"])
    incident = db.execute(
        text(
            """
            SELECT id, incident_key, district, county, route, post_mile, office_code
            FROM incidents
            WHERE id = :iid
            LIMIT 1
            """
        ),
        {"iid": incident_id},
    ).mappings().first()
    incident = dict(incident) if incident else {}
    office_code = assessment.get("office_code") or incident.get("office_code")
    return {
        "assessment_id": assessment_id,
        "incident_id": incident_id,
        # incident_key is NULL until the incident is grouped/approved, so the
        # renderer falls back to the id rather than printing an em dash for the
        # one field that identifies the report.
        "incident_key": incident.get("incident_key") or f"Incident #{incident_id}",
        "routing_path": assessment.get("routing_path"),
        "district": incident.get("district") or assessment.get("district"),
        "office_code": office_code,
        "office_location": _office_location(db, office_code),
        "route_label": _site_descriptor(incident),
        "approved_by_user_id": int(user["id"]),
        "approved_by_name": user.get("full_name") or user.get("email"),
        "approved_by_role": _approver_role_title(assessment, user),
        # Read back rather than re-clocked: the payload must agree with
        # assessments.approved_at exactly, including when a retry renders it days
        # later. The UPDATE has already run on this session, so this sees it.
        "approved_at": _isoformat(
            db.execute(
                text("SELECT approved_at FROM assessments WHERE id = :aid"), {"aid": assessment_id}
            ).scalar()
        ),
    }


def _isoformat(value) -> str | None:
    if value is None:
        return None
    return value.isoformat(sep=" ", timespec="seconds") if hasattr(value, "isoformat") else str(value)


def _approval_coordinator_recipients(db: Session, incident_id: int) -> list[int]:
    """District coordinators, plus the coordinator who actually triaged it.

    Resolving by district alone misses the person who routed the work whenever
    their district metadata differs from the incident's — and in tests resolves
    to nobody, so a "the coordinator was notified" assertion would pass
    vacuously (design §6.1).
    """
    row = db.execute(
        text("SELECT district, triage_decided_by_user_id FROM incidents WHERE id = :iid LIMIT 1"),
        {"iid": incident_id},
    ).mappings().first()
    if not row:
        return []
    recipients = list(
        incidents_routes._routing_users_for(
            db=db, assignment_type="DISTRICT_COORDINATOR", district=row.get("district")
        )
    )
    if row.get("triage_decided_by_user_id") is not None:
        recipients.append(int(row["triage_decided_by_user_id"]))
    return sorted({int(x) for x in recipients})


@router.post("/assessments/{assessment_id}/review")
def review_assessment(
    payload: AssessmentReviewRequest,
    background: BackgroundTasks,
    assessment_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(OPERATIONAL_READ_ROLES)),
):
    """Approve (T6 — terminal) or request a revision (T7). Design §3.3.

    Authority comes from the assessment's routing path, never from a role string
    or an assignment row, and APPROVE ENDS THE ASSESSMENT: there is no sign-off
    step after it. Linked technical submissions move with it (B1, §3.5).

    Notification rows are written INSIDE this transaction, so the intent to
    notify is atomic with the approval. Delivery is handed to ``BackgroundTasks``
    only once ``db.commit()`` has returned (design §6.3): a dead relay must not
    hold the reviewer's response, and it must never be able to roll back an
    approval the reviewer has already been told about.
    """
    assessment = _get_assessment(db, assessment_id)
    if not assessment:
        raise HTTPException(status_code=404, detail="Assessment not found")
    allowed, reason = _review_authority(db, assessment, user)
    if not allowed:
        raise HTTPException(status_code=403, detail=reason)
    if assessment["state"] != "SUBMITTED":
        raise HTTPException(status_code=409, detail=f"Cannot review from state {assessment['state']}")

    notes = (payload.notes or "").strip() or None
    if payload.action != "APPROVE" and not notes:
        # The assignee is the only person who can act on a returned assessment,
        # and the note is the only thing that tells them what to change.
        raise HTTPException(status_code=400, detail="notes are required when requesting a revision")

    incident_id = int(assessment["incident_id"])
    assignee_user_id = (
        int(assessment["assigned_engineer_user_id"])
        if assessment.get("assigned_engineer_user_id") is not None
        else None
    )
    # The outbox ids this request wrote, handed to BackgroundTasks after commit.
    notification_ids: list[int] = []
    # Same wrapper as submit, and for the same reason: B1's per-row helper raises
    # 409 on a concurrent writer, and a partially transitioned set of submissions
    # must never outlive the failed review (design §11).
    try:
        if payload.action == "APPROVE":
            db.execute(
                text("UPDATE assessments SET state='APPROVED', approved_at=NOW(), updated_at=NOW() WHERE id=:aid"),
                {"aid": assessment_id},
            )
            transitioned, skipped = _drive_linked_submissions(
                db,
                assessment=assessment,
                action="APPROVE",
                actor_user_id=int(user["id"]),
                comment=notes,
            )
            _record_event(
                db,
                incident_id=incident_id,
                assessment_id=assessment_id,
                actor_user_id=int(user["id"]),
                event_type="APPROVED",
                from_state="SUBMITTED",
                to_state="APPROVED",
                notes=notes,
                metadata={"submissions_transitioned": transitioned, "submissions_skipped": skipped},
            )
            next_state = "APPROVED"
            coordinator_ids = _approval_coordinator_recipients(db, incident_id)
            notification_payload = _approval_notification_payload(db, assessment, user)
            notification_ids += incidents_routes._queue_incident_notifications(
                db=db,
                incident_id=incident_id,
                recipient_user_ids=coordinator_ids,
                template_code="ASSESSMENT_APPROVED_COORDINATOR",
                payload=notification_payload,
                channels=_APPROVAL_COORDINATOR_CHANNELS,
            )
            notification_ids += incidents_routes._queue_incident_notifications(
                db=db,
                incident_id=incident_id,
                recipient_user_ids=[assignee_user_id] if assignee_user_id is not None else [],
                template_code="ASSESSMENT_APPROVED_AUTHOR",
                payload=notification_payload,
                channels=_NOTIFICATION_CHANNELS,
            )
            # What was actually queued, never what was planned: with no
            # coordinator resolvable there are no rows and no channels to report.
            notified = {
                "coordinators": coordinator_ids,
                "channels": list(_APPROVAL_COORDINATOR_CHANNELS) if coordinator_ids else [],
                "author": assignee_user_id,
            }
        else:  # REQUEST_REVISION
            db.execute(
                text(
                    "UPDATE assessments SET state='REVISION_REQUESTED', review_requested_at=NOW(), updated_at=NOW() WHERE id=:aid"
                ),
                {"aid": assessment_id},
            )
            transitioned, skipped = _drive_linked_submissions(
                db,
                assessment=assessment,
                action="REQUEST_REVISION",
                actor_user_id=int(user["id"]),
                comment=notes,
            )
            _record_event(
                db,
                incident_id=incident_id,
                assessment_id=assessment_id,
                actor_user_id=int(user["id"]),
                event_type="REVISION_REQUESTED",
                from_state="SUBMITTED",
                to_state="REVISION_REQUESTED",
                notes=notes,
                metadata={"submissions_transitioned": transitioned, "submissions_skipped": skipped},
            )
            next_state = "REVISION_REQUESTED"
            notification_ids += incidents_routes._queue_incident_notifications(
                db=db,
                incident_id=incident_id,
                recipient_user_ids=[assignee_user_id] if assignee_user_id is not None else [],
                template_code="ASSESSMENT_REVISION_REQUESTED",
                payload={
                    "assessment_id": assessment_id,
                    "incident_id": incident_id,
                    "routing_path": assessment.get("routing_path"),
                    "reviewed_by_user_id": int(user["id"]),
                    "notes": notes,
                },
                channels=_NOTIFICATION_CHANNELS,
            )
            notified = {
                "assignee": assignee_user_id,
                "channels": list(_NOTIFICATION_CHANNELS) if assignee_user_id is not None else [],
            }
        db.commit()
        # AFTER commit, and only after: the rows are durable, so the worst a dead
        # relay can now do is leave them undelivered for the sweeper. The task
        # body never raises (design §6.3, §6.6).
        if notification_ids:
            background.add_task(notifications_svc.flush_after_commit, notification_ids)
        return {
            "assessment": _assessment_payload(db, assessment_id, user),
            "state": next_state,
            "submissions_transitioned": transitioned,
            "submissions_skipped": skipped,
            "notified": notified,
        }
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


# ---------------------------------------------------------------------------
# Finalize — RETIRED (design §3.4). Approval completes the assessment.
# ---------------------------------------------------------------------------


@router.post("/assessments/{assessment_id}/finalize")
def finalize_assessment(
    payload: AssessmentFinalizeRequest,
    assessment_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(OFFICE_CHIEF_ROLES)),
):
    """410 Gone.

    Nothing new enters FINALIZED: approval by the branch chief (branch route) or
    the office chief (senior specialist route) completes the assessment, and the
    database enforces it through ``trg_assessment_no_new_finalize``. Existing
    FINALIZED rows stay valid, readable and filterable history.

    The route stays mounted — and ``AssessmentFinalizeRequest`` is kept so the
    signature still parses — so an old client gets this sentence, not a 404.
    """
    raise HTTPException(
        status_code=410,
        detail=(
            "Assessment finalization was retired: approval by the branch chief (branch route) "
            "or the office chief (senior specialist route) completes the assessment."
        ),
    )

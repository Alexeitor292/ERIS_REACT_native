"""Derived Incident Workflow Tree read model.

Builds a server-authoritative, operational workflow map for an incident from
EXISTING audit data — no new tables. It combines:

  * incidents (stage, status, triage disposition + decision fields, duplicate
    link fields, resolution fields, linked submission)
  * incident_assignments (per-stage active assignees)
  * assessments (lifecycle state + decision timestamps + branch/engineer)
  * assessment_assignments (engineer / reviewer / approver)
  * assessment_events (who performed each transition + when + notes)

The tree distinguishes the actor who PERFORMED a step (from the immutable event
log) from the person CURRENTLY assigned to an open step, an unassigned future
role, a not-yet-reached role, and a skipped/terminated branch.

User-facing terminology is "Assessment" / "Workflow" — never legacy "GISA".
"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.orm import Session

# Node statuses (display contract)
COMPLETED = "COMPLETED"
CURRENT = "CURRENT"
PENDING = "PENDING"
WAITING_ON_REPORTER = "WAITING_ON_REPORTER"
REVISION_REQUESTED = "REVISION_REQUESTED"
SKIPPED = "SKIPPED"
TERMINAL = "TERMINAL"
UNASSIGNED = "UNASSIGNED"

# Statuses that represent an open bottleneck needing someone to act.
_ACTIVE_STATUSES = {CURRENT, WAITING_ON_REPORTER, REVISION_REQUESTED, UNASSIGNED}

# Canonical role -> display title
_ROLE_TITLES = {
    "MAINTENANCE_FIELD_WORKER": "Maintenance Field Worker",
    "MAINTENANCE_COORDINATOR": "Maintenance Coordinator",
    "GEOTECH_OFFICE_CHIEF": "GeoTech Office Chief",
    "GEOTECH_BRANCH_CHIEF": "GeoTech Branch Chief",
    "GEOTECH_ENGINEER": "GeoTech Engineer",
    "REVIEWER_APPROVER": "Assigned Reviewer / Approver",
    "RESOLUTION": "Finalization / Resolution",
}

_ASSESSMENT_NODE_KEYS = {
    "OFFICE_DELEGATION",
    "BRANCH_ASSIGNMENT",
    "ENGINEER_ASSESSMENT",
    "ASSESSMENT_REVIEW",
    "FINALIZATION",
}


def _user_map(db: Session, ids: set[int]) -> dict[int, dict]:
    clean = sorted({int(i) for i in ids if i})
    if not clean:
        return {}
    params = {f"id_{idx}": uid for idx, uid in enumerate(clean)}
    tokens = ", ".join(f":id_{idx}" for idx in range(len(clean)))
    rows = db.execute(
        text(f"SELECT id, full_name, email FROM users WHERE id IN ({tokens})"),
        params,
    ).mappings().all()
    return {
        int(r["id"]): {"user_id": int(r["id"]), "full_name": r["full_name"], "email": r["email"]}
        for r in rows
    }


def _active_stage_assignees(db: Session, incident_id: int) -> dict[str, int]:
    """Active incident_assignments assignee per stage (COORDINATOR/OFFICE_CHIEF/
    BRANCH_CHIEF/ENGINEER)."""
    rows = db.execute(
        text(
            """
            SELECT assignment_stage, assignee_user_id
            FROM incident_assignments
            WHERE incident_id = :iid AND is_active = 1
            """
        ),
        {"iid": incident_id},
    ).mappings().all()
    return {str(r["assignment_stage"]): int(r["assignee_user_id"]) for r in rows}


def _events_by_type(events: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for ev in events:
        out.setdefault(str(ev["event_type"]), []).append(ev)
    return out


def _event_user(ev: dict | None) -> dict | None:
    if not ev or ev.get("actor_user_id") is None:
        return None
    return {
        "user_id": int(ev["actor_user_id"]),
        "full_name": ev.get("actor_name"),
        "email": ev.get("actor_email"),
    }


def build_workflow_tree(
    db: Session,
    *,
    incident: dict,
    assessment: dict | None,
    assignments: list[dict],
    events: list[dict],
) -> dict:
    """Construct the workflow tree for one incident from already-fetched data.

    `incident` is the row from incidents._incident_with_assignment (includes
    triage_* and duplicate_of_* columns). `assessment` is the assessments row or
    None. `assignments` are the ACTIVE assessment_assignments. `events` is the
    full assessment_events timeline (ascending).
    """
    incident_id = int(incident["id"])
    disposition = incident.get("triage_disposition")
    inc_status = str(incident.get("status") or "").upper()
    inc_resolved = inc_status == "RESOLVED"
    location_status = str(incident.get("location_match_status") or "").upper()
    a_state = str(assessment["state"]).upper() if assessment else None

    ev = _events_by_type(events)

    def latest(event_type: str) -> dict | None:
        items = ev.get(event_type)
        return items[-1] if items else None

    # Active reviewer/approver assignment (most recent active one).
    reviewer_assignment = next(
        (a for a in assignments if a.get("assignment_role") in ("REVIEWER", "APPROVER")),
        None,
    )

    stage_assignees = _active_stage_assignees(db, incident_id)

    # ----- path type -----
    if disposition == "NO_ASSESSMENT_REQUIRED":
        path_type = "NO_ASSESSMENT_REQUIRED"
    elif disposition == "DUPLICATE_OR_LINKED":
        path_type = "DUPLICATE_OR_LINKED"
    elif assessment is not None or disposition == "ASSESSMENT_REQUIRED":
        path_type = "ASSESSMENT_REQUIRED"
    elif disposition == "NEEDS_REPORTER_INFORMATION":
        path_type = "NEEDS_REPORTER_INFORMATION"
    else:
        path_type = "PENDING_TRIAGE"

    is_terminal_disposition = path_type in ("NO_ASSESSMENT_REQUIRED", "DUPLICATE_OR_LINKED")
    assessment_path = path_type == "ASSESSMENT_REQUIRED"

    # Collect user ids to resolve in one batch.
    needed_ids: set[int] = set()
    for key in ("reporter_user_id", "triage_decided_by_user_id", "resolved_by_user_id"):
        if incident.get(key) is not None:
            needed_ids.add(int(incident[key]))
    if assessment:
        for key in ("branch_chief_user_id", "assigned_engineer_user_id"):
            if assessment.get(key) is not None:
                needed_ids.add(int(assessment[key]))
    needed_ids.update(stage_assignees.values())
    if reviewer_assignment:
        needed_ids.add(int(reviewer_assignment["user_id"]))
    umap = _user_map(db, needed_ids)

    def user_of(uid: int | None) -> dict | None:
        if uid is None:
            return None
        return umap.get(int(uid)) or {"user_id": int(uid), "full_name": None, "email": None}

    nodes: list[dict] = []

    def node(key, role, label, status, *, user=None, completed_at=None, notes=None, event_type=None, extra=None):
        n = {
            "key": key,
            "role": role,
            "role_title": _ROLE_TITLES.get(role, role),
            "label": label,
            "status": status,
            "user": user,
            "completed_at": completed_at,
            "notes": notes,
            "event_type": event_type,
        }
        if extra:
            n.update(extra)
        nodes.append(n)
        return n

    # ----- Node 1: Reporter submission -----
    node(
        "REPORTER_SUBMISSION",
        "MAINTENANCE_FIELD_WORKER",
        "Incident report submitted",
        COMPLETED,
        user=user_of(incident.get("reporter_user_id")),
        completed_at=incident.get("created_at"),
        event_type="INCIDENT_CREATED",
    )

    # ----- Node 2: Coordinator triage -----
    triage_ev = latest("TRIAGE_DECISION")
    if disposition is None:
        # Not triaged yet.
        coord = stage_assignees.get("COORDINATOR")
        node(
            "COORDINATOR_TRIAGE",
            "MAINTENANCE_COORDINATOR",
            "Coordinator triage",
            CURRENT if coord else UNASSIGNED,
            user=user_of(coord),
            notes="Awaiting triage decision.",
        )
    elif disposition == "NEEDS_REPORTER_INFORMATION" and not assessment and not inc_resolved:
        if location_status == "NEEDS_REVISION":
            # Loop: coordinator requested info; the reporter must update.
            node(
                "COORDINATOR_TRIAGE",
                "MAINTENANCE_COORDINATOR",
                "More information requested",
                WAITING_ON_REPORTER,
                user=_event_user(triage_ev) or user_of(incident.get("triage_decided_by_user_id")),
                completed_at=triage_ev.get("created_at") if triage_ev else incident.get("triage_decided_at"),
                notes=(triage_ev.get("notes") if triage_ev else None) or incident.get("triage_notes"),
                event_type="NEEDS_REPORTER_INFORMATION",
            )
        else:
            # Reporter resubmitted; triage resumes.
            coord = stage_assignees.get("COORDINATOR")
            node(
                "COORDINATOR_TRIAGE",
                "MAINTENANCE_COORDINATOR",
                "Coordinator triage (resumed after reporter update)",
                CURRENT if coord else UNASSIGNED,
                user=user_of(coord),
                notes="Reporter resubmitted; triage resumes.",
            )
    else:
        # A real disposition was made (assessment-required or terminal).
        label = {
            "ASSESSMENT_REQUIRED": "Coordinator triage — assessment required",
            "NO_ASSESSMENT_REQUIRED": "Coordinator triage — no assessment required",
            "DUPLICATE_OR_LINKED": "Coordinator triage — duplicate / linked",
        }.get(disposition, "Coordinator triage")
        node(
            "COORDINATOR_TRIAGE",
            "MAINTENANCE_COORDINATOR",
            label,
            COMPLETED,
            user=_event_user(triage_ev) or user_of(incident.get("triage_decided_by_user_id")),
            completed_at=incident.get("triage_decided_at") or (triage_ev.get("created_at") if triage_ev else None),
            notes=incident.get("triage_notes"),
            event_type="TRIAGE_DECISION",
            extra={"disposition": disposition},
        )

    # ----- Node 3: Office delegation -----
    delegated_ev = latest("OFFICE_DELEGATED")
    if not assessment_path:
        node("OFFICE_DELEGATION", "GEOTECH_OFFICE_CHIEF", "Office chief delegation",
             SKIPPED if is_terminal_disposition else PENDING)
    elif assessment.get("office_delegated_at") is not None:
        node(
            "OFFICE_DELEGATION", "GEOTECH_OFFICE_CHIEF", "Delegated to branch chief", COMPLETED,
            user=_event_user(delegated_ev) or user_of(stage_assignees.get("OFFICE_CHIEF")),
            completed_at=assessment.get("office_delegated_at"),
            notes=delegated_ev.get("notes") if delegated_ev else None,
            event_type="OFFICE_DELEGATED",
        )
    elif a_state == "PENDING_OFFICE_DELEGATION":
        oc = stage_assignees.get("OFFICE_CHIEF")
        node("OFFICE_DELEGATION", "GEOTECH_OFFICE_CHIEF", "Office chief delegation",
             CURRENT if oc else UNASSIGNED, user=user_of(oc),
             notes="Office chief must delegate to a branch chief.")
    else:
        node("OFFICE_DELEGATION", "GEOTECH_OFFICE_CHIEF", "Office chief delegation", PENDING)

    # ----- Node 4: Branch engineer assignment -----
    engineer_assigned_ev = latest("ENGINEER_ASSIGNED")
    if not assessment_path:
        node("BRANCH_ASSIGNMENT", "GEOTECH_BRANCH_CHIEF", "Branch chief engineer assignment",
             SKIPPED if is_terminal_disposition else PENDING)
    elif assessment.get("engineer_assigned_at") is not None:
        node(
            "BRANCH_ASSIGNMENT", "GEOTECH_BRANCH_CHIEF", "Engineer assigned", COMPLETED,
            user=_event_user(engineer_assigned_ev) or user_of(assessment.get("branch_chief_user_id")),
            completed_at=assessment.get("engineer_assigned_at"),
            notes=engineer_assigned_ev.get("notes") if engineer_assigned_ev else None,
            event_type="ENGINEER_ASSIGNED",
        )
    elif a_state == "PENDING_ENGINEER_ASSIGNMENT":
        bc = assessment.get("branch_chief_user_id")
        node("BRANCH_ASSIGNMENT", "GEOTECH_BRANCH_CHIEF", "Branch chief engineer assignment",
             CURRENT if bc else UNASSIGNED, user=user_of(bc),
             notes="Branch chief must assign an engineer.")
    else:
        node("BRANCH_ASSIGNMENT", "GEOTECH_BRANCH_CHIEF", "Branch chief engineer assignment", PENDING)

    # ----- Node 5: Engineer assessment work -----
    submitted_ev = latest("SUBMITTED")
    revision_ev = latest("REVISION_REQUESTED")
    engineer_user = user_of(assessment.get("assigned_engineer_user_id")) if assessment else None
    if not assessment_path:
        node("ENGINEER_ASSESSMENT", "GEOTECH_ENGINEER", "Engineer assessment work",
             SKIPPED if is_terminal_disposition else PENDING)
    elif a_state == "REVISION_REQUESTED":
        node("ENGINEER_ASSESSMENT", "GEOTECH_ENGINEER", "Assessment revision requested",
             REVISION_REQUESTED, user=engineer_user,
             notes=(revision_ev.get("notes") if revision_ev else None) or "Engineer must revise and resubmit.",
             event_type="REVISION_REQUESTED")
    elif a_state in ("SUBMITTED", "APPROVED", "FINALIZED"):
        node("ENGINEER_ASSESSMENT", "GEOTECH_ENGINEER", "Assessment submitted", COMPLETED,
             user=_event_user(submitted_ev) or engineer_user,
             completed_at=assessment.get("submitted_at"),
             event_type="SUBMITTED")
    elif a_state == "DRAFT":
        node("ENGINEER_ASSESSMENT", "GEOTECH_ENGINEER", "Engineer assessment work",
             CURRENT if engineer_user else UNASSIGNED, user=engineer_user,
             notes="Engineer is completing the assessment.")
    else:
        node("ENGINEER_ASSESSMENT", "GEOTECH_ENGINEER", "Engineer assessment work", PENDING)

    # ----- Node 6: Assessment review -----
    approved_ev = latest("APPROVED")
    reviewer_user = None
    if reviewer_assignment:
        reviewer_user = {
            "user_id": int(reviewer_assignment["user_id"]),
            "full_name": reviewer_assignment.get("full_name"),
            "email": reviewer_assignment.get("email"),
        }
    if not assessment_path:
        node("ASSESSMENT_REVIEW", "REVIEWER_APPROVER", "Assessment review",
             SKIPPED if is_terminal_disposition else PENDING)
    elif a_state in ("APPROVED", "FINALIZED"):
        node("ASSESSMENT_REVIEW", "REVIEWER_APPROVER", "Assessment approved", COMPLETED,
             user=_event_user(approved_ev) or reviewer_user,
             completed_at=assessment.get("approved_at"),
             event_type="APPROVED")
    elif a_state == "SUBMITTED":
        node("ASSESSMENT_REVIEW", "REVIEWER_APPROVER", "Assessment review",
             CURRENT if reviewer_user else UNASSIGNED, user=reviewer_user,
             notes="Assigned reviewer/approver must review."
             if reviewer_user else "Awaiting reviewer assignment.")
    elif a_state == "REVISION_REQUESTED":
        node("ASSESSMENT_REVIEW", "REVIEWER_APPROVER", "Assessment review",
             PENDING, user=reviewer_user, notes="Paused — awaiting engineer revision.")
    else:
        node("ASSESSMENT_REVIEW", "REVIEWER_APPROVER", "Assessment review", PENDING)

    # ----- Node 7: Finalization -----
    finalized_ev = latest("FINALIZED")
    if not assessment_path:
        node("FINALIZATION", "GEOTECH_OFFICE_CHIEF", "Finalization",
             SKIPPED if is_terminal_disposition else PENDING)
    elif a_state == "FINALIZED":
        node("FINALIZATION", "GEOTECH_OFFICE_CHIEF", "Assessment finalized", COMPLETED,
             user=_event_user(finalized_ev) or user_of(stage_assignees.get("OFFICE_CHIEF")),
             completed_at=assessment.get("finalized_at"),
             event_type="FINALIZED")
    elif a_state == "APPROVED":
        oc = stage_assignees.get("OFFICE_CHIEF")
        node("FINALIZATION", "GEOTECH_OFFICE_CHIEF", "Finalization",
             CURRENT if oc else UNASSIGNED, user=user_of(oc),
             notes="Office chief must finalize the approved assessment.")
    else:
        node("FINALIZATION", "GEOTECH_OFFICE_CHIEF", "Finalization", PENDING)

    # ----- Node 8: Resolution (terminal) -----
    if inc_resolved:
        if path_type == "NO_ASSESSMENT_REQUIRED":
            res_label = "No assessment required"
        elif path_type == "DUPLICATE_OR_LINKED":
            res_label = "Linked / duplicate report"
        elif a_state == "FINALIZED":
            res_label = "Assessment finalized & incident resolved"
        else:
            res_label = "Incident resolved"
        extra = {}
        if path_type == "DUPLICATE_OR_LINKED":
            extra = {
                "linked_incident_id": int(incident["duplicate_of_incident_id"]) if incident.get("duplicate_of_incident_id") is not None else None,
                "linked_location_id": int(incident["duplicate_of_location_id"]) if incident.get("duplicate_of_location_id") is not None else None,
            }
        node("RESOLUTION", "RESOLUTION", res_label, TERMINAL,
             user=user_of(incident.get("resolved_by_user_id")),
             completed_at=incident.get("resolved_at"),
             notes=incident.get("resolution_comment"),
             event_type="INCIDENT_RESOLVED",
             extra=extra or None)
    elif assessment_path and a_state == "FINALIZED":
        # Finalized but not yet resolved: the assigned engineer (or admin)
        # resolves the incident. (Finalization<->resolution coupling is an
        # open policy; see docs.)
        node("RESOLUTION", "GEOTECH_ENGINEER", "Incident resolution",
             CURRENT if engineer_user else UNASSIGNED, user=engineer_user,
             notes="Assessment finalized; awaiting incident resolution.")
    else:
        node("RESOLUTION", "RESOLUTION", "Incident resolution", PENDING)

    # ----- Current owner / overall status -----
    current_node = next((n for n in nodes if n["status"] in _ACTIVE_STATUSES), None)
    if current_node is None:
        overall_status = TERMINAL if inc_resolved else COMPLETED
        current_owner = None
    else:
        overall_status = current_node["status"]
        if current_node["status"] == WAITING_ON_REPORTER:
            owner_user = user_of(incident.get("reporter_user_id"))
            current_owner = {
                "role": "MAINTENANCE_FIELD_WORKER",
                "role_title": _ROLE_TITLES["MAINTENANCE_FIELD_WORKER"],
                "user_id": owner_user["user_id"] if owner_user else None,
                "full_name": owner_user["full_name"] if owner_user else None,
                "email": owner_user["email"] if owner_user else None,
                "node_key": current_node["key"],
            }
        else:
            u = current_node.get("user")
            current_owner = {
                "role": current_node["role"],
                "role_title": current_node["role_title"],
                "user_id": u["user_id"] if u else None,
                "full_name": u["full_name"] if u else None,
                "email": u["email"] if u else None,
                "node_key": current_node["key"],
            }

    return {
        "incident_id": incident_id,
        "path_type": path_type,
        "overall_status": overall_status,
        "current_owner": current_owner,
        "assessment": {
            "id": int(assessment["id"]),
            "state": assessment["state"],
            "office_code": assessment.get("office_code"),
            "assigned_engineer_user_id": int(assessment["assigned_engineer_user_id"]) if assessment.get("assigned_engineer_user_id") is not None else None,
            "branch_chief_user_id": int(assessment["branch_chief_user_id"]) if assessment.get("branch_chief_user_id") is not None else None,
        }
        if assessment
        else None,
        "linked_incident_id": int(incident["duplicate_of_incident_id"]) if incident.get("duplicate_of_incident_id") is not None else None,
        "linked_location_id": int(incident["duplicate_of_location_id"]) if incident.get("duplicate_of_location_id") is not None else None,
        "nodes": nodes,
    }

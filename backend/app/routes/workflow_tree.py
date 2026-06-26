"""Incident Workflow Tree endpoint.

GET /incidents/{incident_id}/workflow-tree returns a derived, server-authoritative
workflow map for an incident (see services/workflow_tree.py). It reuses the
existing read helpers and the broad-visibility / narrow-authority access model:

  * Maintenance field workers may retrieve the tree only for their OWN reports.
  * Non-maintenance operational users may retrieve it for any incident.
  * Admin has full access.

All access is enforced server-side.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import get_current_user
from ..roles import is_admin, is_maintenance_only, is_operational_user
from ..services import workflow_tree as workflow_tree_svc
from . import assessments as assessments_routes
from . import incidents as incidents_routes

router = APIRouter(tags=["workflow-tree"])


def _ensure_workflow_tree_access(user: dict, incident_row: dict) -> None:
    if is_admin(user):
        return
    if is_maintenance_only(user):
        # Maintenance field workers: own reports only.
        if int(incident_row.get("reporter_user_id") or 0) != int(user["id"]):
            raise HTTPException(status_code=403, detail="You can only view your own incident reports")
        return
    if is_operational_user(user):
        # Broad read for any non-maintenance operational user.
        return
    raise HTTPException(status_code=403, detail="Not allowed to view this incident")


@router.get("/incidents/{incident_id}/workflow-tree")
def get_incident_workflow_tree(
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    incident = incidents_routes._incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    incident = dict(incident)
    _ensure_workflow_tree_access(user, incident)

    assessment = assessments_routes._get_assessment_for_incident(db, incident_id)
    if assessment is not None:
        assessment_id = int(assessment["id"])
        assignments = assessments_routes._active_assignments(db, assessment_id)
        events = assessments_routes._assessment_events(db, assessment_id, incident_id)
    else:
        assignments = []
        # No assessment yet — still surface any incident-scoped triage events.
        events = assessments_routes._assessment_events(db, -1, incident_id)

    tree = workflow_tree_svc.build_workflow_tree(
        db,
        incident=incident,
        assessment=assessment,
        assignments=assignments,
        events=events,
    )
    tree["requested_by_user_id"] = int(user["id"])
    return tree

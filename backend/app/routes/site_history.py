"""What else has happened at a technical form's site (``GET /submissions/{id}/site-history``).

One list for whoever is writing the assessment, the **Record of incidents**:
every earlier report at the same place, newest first. Incidents in the record
are marked as a recurrence of the same type, a different type, or not yet
classified; reports that never entered it (closed at triage, sent back to the
reporter, awaiting triage) are marked as such.

Under each one is its **maintenance** side: what the crew reported, what the
coordinator decided and wrote, the immediate and follow-up actions on its
technical forms, notes the maintenance team left in its history, and later
reports closed as duplicates of it (shown there rather than on their own).

"The same place" is the form's canonical location (``location_id``) or, failing
that, anything within ``radius_m`` of the form's coordinates (or, when the form
has none yet, its incident's). The form's own incidents are left out.

Operational roles only: the lists span other people's reports, which the
Maintenance Crew and Guests may not read.
"""

from __future__ import annotations

import math
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session

from ..constants.gisa_lookups import GISA_ACTION_LUT, GISA_INCIDENT_TYPE_LUT
from ..db import get_db
from ..deps import require_roles
from ..roles import MAINTENANCE_COORDINATOR, MAINTENANCE_CREW, OPERATIONAL_ROLES
from .event_groups import is_outside_record

router = APIRouter(tags=["site-history"])

_TYPE_LABELS = {row["code"]: row["label"] for row in GISA_INCIDENT_TYPE_LUT}
_ACTIONS = {row["code"]: row for row in GISA_ACTION_LUT}
_EARTH_RADIUS_M = 6_371_000.0


def _distance_m(lat1, lon1, lat2, lon2) -> float | None:
    if None in (lat1, lon1, lat2, lon2):
        return None
    p1, p2 = math.radians(float(lat1)), math.radians(float(lat2))
    dp = p2 - p1
    dl = math.radians(float(lon2) - float(lon1))
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * _EARTH_RADIUS_M * math.asin(math.sqrt(a))


def _types(codes) -> list[dict[str, str]]:
    return [{"code": code, "label": _TYPE_LABELS.get(code, code.replace("_", " ").title())} for code in sorted(codes)]


def _actions(codes) -> list[dict[str, str]]:
    ordered = sorted((_ACTIONS.get(code, {}).get("sort_order", 10_000), code) for code in codes)
    return [{"code": code, "label": _ACTIONS.get(code, {}).get("label", code)} for _, code in ordered]


def _text(value, limit: int = 2000) -> str | None:
    cleaned = str(value or "").strip()
    return cleaned[:limit] or None


def _iso(value) -> str | None:
    return value.isoformat() if value else None


@router.get("/submissions/{submission_id}/site-history")
def site_history(
    submission_id: int = Path(..., ge=1),
    radius_m: int = Query(150, ge=10, le=1000),
    db: Session = Depends(get_db),
    user=Depends(require_roles(sorted(OPERATIONAL_ROLES))),
) -> dict[str, Any]:
    from ..main import require_can_view_submission  # the app module imports this router

    require_can_view_submission(submission_id, db, user)

    form = db.execute(
        text("SELECT latitude, longitude, location_id FROM submission_gisa WHERE submission_id = :sid"),
        {"sid": submission_id},
    ).mappings().first()
    own_incidents = [
        int(row[0])
        for row in db.execute(
            text(
                """
                SELECT incident_id FROM incident_submission_links WHERE submission_id = :sid
                UNION SELECT incident_id FROM assessments WHERE submission_id = :sid
                UNION SELECT a.incident_id FROM assessment_submissions s
                  JOIN assessments a ON a.id = s.assessment_id WHERE s.submission_id = :sid
                """
            ),
            {"sid": submission_id},
        ).all()
        if row[0] is not None
    ]

    lat = form["latitude"] if form else None
    lon = form["longitude"] if form else None
    location_id = form["location_id"] if form else None
    source = "form"
    if (lat is None or lon is None) and own_incidents:
        incident = db.execute(
            text("SELECT latitude, longitude, location_id FROM incidents WHERE id = :id"),
            {"id": own_incidents[0]},
        ).mappings().first()
        if incident:
            lat, lon = incident["latitude"], incident["longitude"]
            location_id = location_id or incident["location_id"]
            source = "incident"
    if lat is None and lon is None and location_id is None:
        return {"anchor": None, "current_types": [], "incidents": []}

    clauses, params = [], {"excluded": own_incidents or [0]}
    if location_id is not None:
        clauses.append("i.location_id = :location_id")
        params["location_id"] = int(location_id)
    if lat is not None and lon is not None:
        dlat = radius_m / 111_320.0
        dlon = radius_m / (111_320.0 * max(math.cos(math.radians(float(lat))), 0.01))
        clauses.append("(i.latitude BETWEEN :lat_min AND :lat_max AND i.longitude BETWEEN :lon_min AND :lon_max)")
        params.update(lat_min=float(lat) - dlat, lat_max=float(lat) + dlat, lon_min=float(lon) - dlon, lon_max=float(lon) + dlon)

    rows = db.execute(
        text(
            f"""
            SELECT i.id, i.incident_key, i.title, i.description, i.incident_type, i.latitude, i.longitude,
                   i.location_id, i.status, i.current_stage, i.triage_disposition, i.triage_notes,
                   i.triage_decided_at, i.created_at, i.first_observed_at, i.event_group_id,
                   i.duplicate_of_incident_id,
                   eg.title AS event_group_title, a.id AS assessment_id, a.state AS assessment_state,
                   reporter.full_name AS reporter_name, decider.full_name AS decided_by_name
              FROM incidents i
              LEFT JOIN event_groups eg ON eg.id = i.event_group_id
              LEFT JOIN assessments a ON a.incident_id = i.id
              LEFT JOIN users reporter ON reporter.id = i.reporter_user_id
              LEFT JOIN users decider ON decider.id = i.triage_decided_by_user_id
             WHERE i.id NOT IN :excluded AND ({" OR ".join(clauses)})
             ORDER BY COALESCE(i.first_observed_at, i.created_at) DESC
             LIMIT 200
            """
        ).bindparams(bindparam("excluded", expanding=True)),
        params,
    ).mappings().all()

    # Distance filter (the bounding box is a square) and the incident types.
    near = []
    for row in rows:
        distance = _distance_m(lat, lon, row["latitude"], row["longitude"])
        same_location = location_id is not None and row["location_id"] == location_id
        if not same_location and (distance is None or distance > radius_m):
            continue
        near.append((row, distance, same_location))

    ids = [int(row["id"]) for row, _, _ in near]
    types: dict[int, set[str]] = {incident_id: set() for incident_id in ids + own_incidents}
    if types:
        for incident_id, code in db.execute(
            text(
                """
                SELECT l.incident_id, t.incident_type_code FROM incident_submission_links l
                  JOIN submission_gisa_incident_types t ON t.submission_id = l.submission_id
                 WHERE l.incident_id IN :ids
                UNION
                SELECT a.incident_id, t.incident_type_code FROM assessments a
                  JOIN submission_gisa_incident_types t ON t.submission_id = a.submission_id
                 WHERE a.incident_id IN :ids
                """
            ).bindparams(bindparam("ids", expanding=True)),
            {"ids": list(types)},
        ).all():
            types[int(incident_id)].add(str(code))
    for row, _, _ in near:
        if row["incident_type"]:
            types[int(row["id"])].add(str(row["incident_type"]))
    current = set(
        str(code)
        for (code,) in db.execute(
            text("SELECT incident_type_code FROM submission_gisa_incident_types WHERE submission_id = :sid"),
            {"sid": submission_id},
        ).all()
    )
    for incident_id in own_incidents:
        current |= types.get(incident_id, set())

    # Later reports closed as duplicates of a listed incident, wherever they were
    # reported from: they belong under it, not on their own.
    listed = sorted(int(row["id"]) for row, _, _ in near)
    duplicates: dict[int, list[dict]] = {}
    actions: dict[int, dict[str, set[str]]] = {}
    notes: dict[int, list[dict]] = {}
    if listed:
        for dup in db.execute(
            text(
                """
                SELECT d.id, d.duplicate_of_incident_id, d.description, d.first_observed_at, d.created_at,
                       d.triage_notes, d.triage_decided_at, reporter.full_name AS reporter_name,
                       decider.full_name AS decided_by_name
                  FROM incidents d
                  LEFT JOIN users reporter ON reporter.id = d.reporter_user_id
                  LEFT JOIN users decider ON decider.id = d.triage_decided_by_user_id
                 WHERE d.duplicate_of_incident_id IN :ids AND d.triage_disposition = 'DUPLICATE_OR_LINKED'
                 ORDER BY COALESCE(d.first_observed_at, d.created_at), d.id
                """
            ).bindparams(bindparam("ids", expanding=True)),
            {"ids": listed},
        ).mappings().all():
            duplicates.setdefault(int(dup["duplicate_of_incident_id"]), []).append(
                {
                    "incident_id": int(dup["id"]),
                    "observed_at": _iso(dup["first_observed_at"] or dup["created_at"]),
                    "reported_by": dup["reporter_name"],
                    "description": _text(dup["description"]),
                    "coordinator_notes": _text(dup["triage_notes"]),
                    "decided_by": dup["decided_by_name"],
                    "decided_at": _iso(dup["triage_decided_at"]),
                }
            )

        # Immediate and follow-up actions from each incident's technical forms.
        for incident_id, group, code in db.execute(
            text(
                """
                SELECT f.incident_id, g.action_group, g.action_code FROM (
                    SELECT incident_id, submission_id FROM incident_submission_links WHERE incident_id IN :ids
                    UNION SELECT incident_id, submission_id FROM assessments
                     WHERE incident_id IN :ids AND submission_id IS NOT NULL
                    UNION SELECT a.incident_id, s.submission_id FROM assessment_submissions s
                      JOIN assessments a ON a.id = s.assessment_id WHERE a.incident_id IN :ids
                ) f
                JOIN submission_gisa_actions g ON g.submission_id = f.submission_id
                """
            ).bindparams(bindparam("ids", expanding=True)),
            {"ids": listed},
        ).all():
            actions.setdefault(int(incident_id), {}).setdefault(str(group), set()).add(str(code))

        # Notes the maintenance team (coordinators and crew) left in its history.
        for note in db.execute(
            text(
                """
                SELECT e.incident_id, e.notes, e.created_at, u.full_name
                  FROM assessment_events e
                  JOIN users u ON u.id = e.actor_user_id
                 WHERE e.incident_id IN :ids AND e.notes IS NOT NULL AND TRIM(e.notes) <> ''
                   AND EXISTS (
                       SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                        WHERE ur.user_id = e.actor_user_id AND r.name IN :maintenance_roles
                   )
                 ORDER BY e.created_at, e.id
                """
            ).bindparams(bindparam("ids", expanding=True), bindparam("maintenance_roles", expanding=True)),
            {"ids": listed, "maintenance_roles": [MAINTENANCE_COORDINATOR, MAINTENANCE_CREW]},
        ).mappings().all():
            notes.setdefault(int(note["incident_id"]), []).append(
                {"text": _text(note["notes"]), "by": note["full_name"], "at": _iso(note["created_at"])}
            )
    nested = {item["incident_id"] for items in duplicates.values() for item in items}

    incidents = []
    for row, distance, same_location in near:
        incident_id = int(row["id"])
        if incident_id in nested:
            continue
        in_record = not is_outside_record(dict(row))
        theirs = types.get(incident_id, set())
        relation = "UNCLASSIFIED" if not theirs or not current else ("SAME_TYPE" if theirs & current else "DIFFERENT_TYPE")
        outcome = None
        if not in_record:
            outcome = row["triage_disposition"] or ("PENDING_TRIAGE" if row["current_stage"] == "COORDINATOR_REVIEW" else None)
        triage_notes = _text(row["triage_notes"])
        own_actions = actions.get(incident_id, {})
        incidents.append(
            {
                "incident_id": incident_id,
                "title": row["title"],
                "observed_at": _iso(row["first_observed_at"] or row["created_at"]),
                "distance_m": round(distance, 1) if distance is not None else None,
                "same_location": same_location,
                "in_record": in_record,
                "types": _types(theirs),
                "relation": relation,
                "stage": row["current_stage"],
                "status": row["status"],
                "outcome": outcome,
                "duplicate_of_incident_id": int(row["duplicate_of_incident_id"]) if row["duplicate_of_incident_id"] else None,
                "event_group": {"id": int(row["event_group_id"]), "title": row["event_group_title"]} if row["event_group_id"] else None,
                "assessment": {"id": int(row["assessment_id"]), "state": row["assessment_state"]} if row["assessment_id"] else None,
                "maintenance": {
                    "report": {
                        "description": _text(row["description"]),
                        "reported_by": row["reporter_name"],
                        "reported_at": _iso(row["created_at"]),
                    },
                    "triage": {
                        "disposition": row["triage_disposition"],
                        "notes": triage_notes,
                        "decided_by": row["decided_by_name"],
                        "decided_at": _iso(row["triage_decided_at"]),
                    } if row["triage_disposition"] else None,
                    "immediate_actions": _actions(own_actions.get("IMMEDIATE", ())),
                    "follow_up_actions": _actions(own_actions.get("FOLLOW_UP", ())),
                    # The triage decision's own notes are shown with the decision.
                    "notes": [note for note in notes.get(incident_id, []) if note["text"] != triage_notes],
                    "also_reported": duplicates.get(incident_id, []),
                },
            }
        )

    return {
        "anchor": {
            "latitude": float(lat) if lat is not None else None,
            "longitude": float(lon) if lon is not None else None,
            "location_id": int(location_id) if location_id is not None else None,
            "radius_m": radius_m,
            "source": source,
        },
        "current_types": _types(current),
        "incidents": incidents,
    }

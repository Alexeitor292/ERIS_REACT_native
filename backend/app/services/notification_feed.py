"""The notification feed: what each person is told, on the web and on the phone.

One row per person per event (``user_notifications``), written inside the
transaction that caused it, so a notice exists exactly when its event does. The
web portal's bell and the mobile app read the same rows (``/notifications``);
phones with ERIS installed also get them as push notifications
(``services/push.py``).

Two sources feed it:

* every incident and assessment event already queued for its recipients
  (``routes/incidents._queue_incident_notifications``) — a report to triage, an
  assessment to route, assign, review or revise, an approval;
* sharing a technical form (``services/sharing.py``) — approvals to give,
  notices to read, and the sharer and recipient told how it went.

Nobody is told about their own action.

A notice that asks its reader to take a step (triage a report, route, assign,
fill in, review, revise) records the report or assessment and the state the
step waits in. The feed compares that with the record when it is read: once
anybody has taken the step, the notice says who and when, and stops counting
as unread.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Iterable

from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session


def add(
    db: Session,
    user_ids: Iterable[int],
    *,
    kind: str,
    title: str,
    body: str | None = None,
    link: str | None = None,
    actor_id: int | None = None,
    incident_id: int | None = None,
    assessment_id: int | None = None,
    task_state: str | None = None,
) -> list[int]:
    """Tell each person once. Does NOT commit.

    ``task_state``: for a notice asking its reader to act, the state the step
    waits in (on the assessment, or ``COORDINATOR_REVIEW`` on the report).
    """
    recipients = sorted({int(uid) for uid in user_ids if uid is not None and int(uid) > 0} - ({int(actor_id)} if actor_id else set()))
    ids: list[int] = []
    for uid in recipients:
        result = db.execute(
            text(
                """
                INSERT INTO user_notifications (user_id, kind, title, body, link, incident_id, assessment_id, task_state, actor_user_id)
                VALUES (:uid, :kind, :title, :body, :link, :incident, :assessment, :task_state, :actor)
                """
            ),
            {
                "uid": uid,
                "kind": kind[:48],
                "title": title[:255],
                "body": (body or None) and body[:1000],
                "link": link,
                "incident": incident_id,
                "assessment": assessment_id,
                "task_state": task_state,
                "actor": actor_id,
            },
        )
        if result.lastrowid:
            ids.append(int(result.lastrowid))
    return ids


# --- incident and assessment events -------------------------------------------

def _incident(db: Session, incident_id: int) -> dict:
    row = db.execute(
        text("SELECT id, title, district FROM incidents WHERE id = :iid"), {"iid": int(incident_id)}
    ).mappings().first()
    return dict(row) if row else {"id": incident_id, "title": None, "district": None}


def _name(incident: dict) -> str:
    """The incident as people read it: its name (District-County-Route-Post mile and date)."""
    return incident.get("title") or f"Incident #{incident['id']}"


def _work_link(payload: dict, incident_id: int) -> str:
    assessment_id = payload.get("assessment_id")
    return f"/my-work?assessment={int(assessment_id)}" if assessment_id else f"/incidents/{int(incident_id)}"


def _record_link(payload: dict, incident_id: int) -> str:
    assessment_id = payload.get("assessment_id")
    return f"/assessments/{int(assessment_id)}" if assessment_id else f"/incidents/{int(incident_id)}"


# template code -> (title, body with {name} and {district}, link builder)
_EVENTS = {
    "INCIDENT_COORDINATOR_REVIEW": ("New field report to triage", "{name}, District {district}.", lambda p, i: "/my-work"),
    "INCIDENT_OFFICE_CHIEF_REVIEW": ("Assessment to route", "{name} needs a GeoTech assessment. Route it to a branch or a senior specialist.", _work_link),
    "INCIDENT_ENGINEER_ASSIGNED": ("Assessment assigned", "{name} was assigned for its GeoTech assessment.", _record_link),
    "ASSESSMENT_OFFICE_DELEGATION": ("Assessment to route", "{name} needs a GeoTech assessment. Route it to a branch or a senior specialist.", _work_link),
    "ASSESSMENT_BRANCH_DELEGATION": ("Assessment handed to your branch", "{name}: assign it to your staff.", _work_link),
    "ASSESSMENT_SENIOR_ENGINEER_ASSIGNMENT": ("Assessment assigned to you", "{name}: fill in its technical form.", _work_link),
    "ASSESSMENT_STAFF_ASSIGNMENT": ("Assessment assigned to you", "{name}: fill in its technical form.", _work_link),
    "ASSESSMENT_SUBMITTED_FOR_REVIEW": ("Assessment to review", "{name} was submitted for your review.", _work_link),
    "ASSESSMENT_REVISION_REQUESTED": ("Revision requested", "{name} came back to you for revision.", _work_link),
    "ASSESSMENT_APPROVED_AUTHOR": ("Your assessment was approved", "{name} is approved.", _record_link),
    "ASSESSMENT_APPROVED_COORDINATOR": ("GeoTech assessment approved", "{name}, District {district}, is approved.", _record_link),
}


# Notices that ask their reader to take a step -> the state that step waits in.
# Triage waits on the report (incidents.current_stage); the rest on the assessment.
TASK_STATES = {
    "INCIDENT_COORDINATOR_REVIEW": "COORDINATOR_REVIEW",
    "INCIDENT_OFFICE_CHIEF_REVIEW": "PENDING_OFFICE_DELEGATION",
    "ASSESSMENT_OFFICE_DELEGATION": "PENDING_OFFICE_DELEGATION",
    "ASSESSMENT_BRANCH_DELEGATION": "PENDING_ENGINEER_ASSIGNMENT",
    "ASSESSMENT_SENIOR_ENGINEER_ASSIGNMENT": "DRAFT",
    "ASSESSMENT_STAFF_ASSIGNMENT": "DRAFT",
    "ASSESSMENT_SUBMITTED_FOR_REVIEW": "SUBMITTED",
    "ASSESSMENT_REVISION_REQUESTED": "REVISION_REQUESTED",
}
TRIAGE_STATE = "COORDINATOR_REVIEW"


def for_incident_event(db: Session, *, incident_id: int, user_ids: Iterable[int], template_code: str, payload: dict | None) -> list[int]:
    """The feed side of an event queued in ``incident_notifications``. Does NOT commit."""
    payload = payload or {}
    title, body, link = _EVENTS.get(template_code, ("ERIS notification", "{name}.", _record_link))
    incident = _incident(db, incident_id)
    district = str(incident.get("district") or payload.get("district") or "—")
    actor = payload.get("assigned_by_user_id") or payload.get("actor_user_id")
    assessment_id = payload.get("assessment_id")
    task_state = TASK_STATES.get(template_code)
    if task_state and task_state != TRIAGE_STATE and not assessment_id:
        task_state = None  # a step on an assessment it does not name cannot be followed
    return add(
        db,
        user_ids,
        kind=template_code,
        title=title,
        body=body.format(name=_name(incident), district=district.lstrip("0") or district),
        link=link(payload, incident_id),
        actor_id=int(actor) if actor else None,
        incident_id=int(incident_id),
        assessment_id=int(assessment_id) if assessment_id else None,
        task_state=task_state,
    )


# --- is the step done? -----------------------------------------------------------

def _in(sql: str):
    """A query with an ``IN :ids`` list."""
    return text(sql).bindparams(bindparam("ids", expanding=True))


def task_status(db: Session, user_id: int, rows: list[dict]) -> dict[int, dict | None]:
    """For each notice asking a step, whether somebody took it: ``{id: done or None}``.

    ``done`` is ``{"at", "by", "by_you", "action", "state"}``: when and by whom the
    step was taken, what they did (an assessment event type, or the triage
    decision) and where the record stands now. A step still waiting on this
    reader — the same state, and for a named step (branch chief, author) still
    theirs — is not done.
    """
    tasks = [r for r in rows if r.get("task_state")]
    result: dict[int, dict | None] = {int(r["id"]): None for r in tasks}
    assessment_ids = {int(r["assessment_id"]) for r in tasks if r.get("assessment_id") and r["task_state"] != TRIAGE_STATE}
    incident_ids = {int(r["incident_id"]) for r in tasks if r.get("incident_id") and r["task_state"] == TRIAGE_STATE}

    assessments: dict[int, dict] = {}
    events: dict[int, list[dict]] = {}
    if assessment_ids:
        params = {"ids": sorted(assessment_ids)}
        for row in db.execute(
            _in("SELECT id, state, branch_chief_user_id, assigned_engineer_user_id FROM assessments WHERE id IN :ids"), params
        ).mappings():
            assessments[int(row["id"])] = dict(row)
        for row in db.execute(
            _in(
                """
                SELECT e.assessment_id, e.event_type, e.from_state, e.to_state, e.created_at, e.actor_user_id, u.full_name
                  FROM assessment_events e LEFT JOIN users u ON u.id = e.actor_user_id
                 WHERE e.assessment_id IN :ids
                 ORDER BY e.id
                """
            ),
            params,
        ).mappings():
            events.setdefault(int(row["assessment_id"]), []).append(dict(row))

    incidents: dict[int, dict] = {}
    if incident_ids:
        for row in db.execute(
            _in(
                """
                SELECT i.id, i.current_stage, i.triage_disposition, i.triage_decided_at, i.triage_decided_by_user_id, u.full_name
                  FROM incidents i LEFT JOIN users u ON u.id = i.triage_decided_by_user_id
                 WHERE i.id IN :ids
                """
            ),
            {"ids": sorted(incident_ids)},
        ).mappings():
            incidents[int(row["id"])] = dict(row)

    for r in tasks:
        nid, state, created = int(r["id"]), r["task_state"], r.get("created_at")
        if state == TRIAGE_STATE:
            incident = incidents.get(int(r["incident_id"])) if r.get("incident_id") else None
            if incident and incident["current_stage"] != TRIAGE_STATE:
                by = incident.get("triage_decided_by_user_id")
                result[nid] = _done(incident.get("triage_decided_at"), incident.get("full_name"), by, user_id,
                                    incident.get("triage_disposition"), incident["current_stage"])
            continue
        assessment = assessments.get(int(r["assessment_id"])) if r.get("assessment_id") else None
        if assessment is None:
            continue
        mine = {
            "PENDING_ENGINEER_ASSIGNMENT": assessment.get("branch_chief_user_id"),
            "DRAFT": assessment.get("assigned_engineer_user_id"),
            "REVISION_REQUESTED": assessment.get("assigned_engineer_user_id"),
        }
        still_theirs = state not in mine or mine[state] is None or int(mine[state]) == int(user_id)
        if assessment["state"] == state and still_theirs:
            continue
        taken = next(
            (
                e for e in events.get(int(assessment["id"]), [])
                if e["from_state"] == state and (created is None or e["created_at"] is None or e["created_at"] >= created)
            ),
            None,
        )
        if taken:
            result[nid] = _done(taken["created_at"], taken.get("full_name"), taken.get("actor_user_id"), user_id,
                                taken["event_type"], assessment["state"])
        else:
            result[nid] = _done(None, None, None, user_id, None, assessment["state"])
    return result


def _done(at: Any, by_name: str | None, by_id: Any, user_id: int, action: str | None, state: str | None) -> dict:
    return {
        "at": at.isoformat() if isinstance(at, datetime) else None,
        "by": by_name,
        "by_you": by_id is not None and int(by_id) == int(user_id),
        "action": action,
        "state": state,
    }


# --- reading -----------------------------------------------------------------

def feed(db: Session, user_id: int, *, limit: int = 30, before_id: int | None = None, unread_only: bool = False) -> dict:
    rows = db.execute(
        text(
            f"""
            SELECT n.id, n.kind, n.title, n.body, n.link, n.incident_id, n.assessment_id, n.task_state,
                   n.created_at, n.read_at, a.full_name AS actor_name
              FROM user_notifications n LEFT JOIN users a ON a.id = n.actor_user_id
             WHERE n.user_id = :uid {"AND n.id < :before" if before_id else ""} {"AND n.read_at IS NULL" if unread_only else ""}
             ORDER BY n.id DESC
             LIMIT :limit
            """
        ),
        {"uid": int(user_id), "before": before_id, "limit": int(limit)},
    ).mappings().all()
    done = task_status(db, user_id, [dict(row) for row in rows])
    return {
        "items": [
            {
                "id": int(row["id"]),
                "kind": row["kind"],
                "title": row["title"],
                "body": row["body"],
                "link": row["link"],
                "actor": row["actor_name"],
                "created_at": row["created_at"].isoformat() if row["created_at"] else None,
                "read": row["read_at"] is not None,
                "done": done.get(int(row["id"])),
            }
            for row in rows
        ],
        "unread": unread_count(db, user_id),
    }


def unread_count(db: Session, user_id: int) -> int:
    """Unread notices, leaving out steps somebody already took: those no longer need this reader."""
    rows = [
        dict(row)
        for row in db.execute(
            text(
                """
                SELECT id, incident_id, assessment_id, task_state, created_at
                  FROM user_notifications
                 WHERE user_id = :uid AND read_at IS NULL
                """
            ),
            {"uid": int(user_id)},
        ).mappings()
    ]
    done = task_status(db, user_id, rows)
    return sum(1 for row in rows if done.get(int(row["id"])) is None)


def mark_read(db: Session, user_id: int, ids: list[int] | None = None) -> None:
    """Mark some (or, with no ids, all) of this person's notifications read. Does NOT commit."""
    if ids is None:
        db.execute(text("UPDATE user_notifications SET read_at = NOW() WHERE user_id = :uid AND read_at IS NULL"), {"uid": int(user_id)})
        return
    if ids:
        db.execute(
            text("UPDATE user_notifications SET read_at = NOW() WHERE user_id = :uid AND read_at IS NULL AND id IN :ids").bindparams(
                bindparam("ids", expanding=True)
            ),
            {"uid": int(user_id), "ids": [int(i) for i in ids]},
        )

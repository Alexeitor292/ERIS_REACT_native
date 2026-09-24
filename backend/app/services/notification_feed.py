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
"""
from __future__ import annotations

from typing import Iterable

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
) -> list[int]:
    """Tell each person once. Does NOT commit."""
    recipients = sorted({int(uid) for uid in user_ids if uid is not None and int(uid) > 0} - ({int(actor_id)} if actor_id else set()))
    ids: list[int] = []
    for uid in recipients:
        result = db.execute(
            text(
                """
                INSERT INTO user_notifications (user_id, kind, title, body, link, actor_user_id)
                VALUES (:uid, :kind, :title, :body, :link, :actor)
                """
            ),
            {"uid": uid, "kind": kind[:48], "title": title[:255], "body": (body or None) and body[:1000], "link": link, "actor": actor_id},
        )
        if result.lastrowid:
            ids.append(int(result.lastrowid))
    return ids


# --- incident and assessment events -------------------------------------------

def _incident(db: Session, incident_id: int) -> dict:
    row = db.execute(
        text("SELECT id, incident_key, title, district FROM incidents WHERE id = :iid"), {"iid": int(incident_id)}
    ).mappings().first()
    return dict(row) if row else {"id": incident_id, "incident_key": None, "title": None, "district": None}


def _name(incident: dict) -> str:
    key = incident.get("incident_key")
    title = incident.get("title") or f"Incident #{incident['id']}"
    return f"{key} · {title}" if key else title


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


def for_incident_event(db: Session, *, incident_id: int, user_ids: Iterable[int], template_code: str, payload: dict | None) -> list[int]:
    """The feed side of an event queued in ``incident_notifications``. Does NOT commit."""
    payload = payload or {}
    title, body, link = _EVENTS.get(template_code, ("ERIS notification", "{name}.", _record_link))
    incident = _incident(db, incident_id)
    district = str(incident.get("district") or payload.get("district") or "—")
    actor = payload.get("assigned_by_user_id") or payload.get("actor_user_id")
    return add(
        db,
        user_ids,
        kind=template_code,
        title=title,
        body=body.format(name=_name(incident), district=district.lstrip("0") or district),
        link=link(payload, incident_id),
        actor_id=int(actor) if actor else None,
    )


# --- reading -----------------------------------------------------------------

def feed(db: Session, user_id: int, *, limit: int = 30, before_id: int | None = None, unread_only: bool = False) -> dict:
    rows = db.execute(
        text(
            f"""
            SELECT n.id, n.kind, n.title, n.body, n.link, n.created_at, n.read_at, a.full_name AS actor_name
              FROM user_notifications n LEFT JOIN users a ON a.id = n.actor_user_id
             WHERE n.user_id = :uid {"AND n.id < :before" if before_id else ""} {"AND n.read_at IS NULL" if unread_only else ""}
             ORDER BY n.id DESC
             LIMIT :limit
            """
        ),
        {"uid": int(user_id), "before": before_id, "limit": int(limit)},
    ).mappings().all()
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
            }
            for row in rows
        ],
        "unread": unread_count(db, user_id),
    }


def unread_count(db: Session, user_id: int) -> int:
    return int(
        db.execute(text("SELECT COUNT(*) FROM user_notifications WHERE user_id = :uid AND read_at IS NULL"), {"uid": int(user_id)}).scalar()
        or 0
    )


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

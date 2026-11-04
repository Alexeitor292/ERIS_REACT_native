"""The District Contact: who maintenance names when it sends a report to GeoTech.

They are kept informed of the assessment and hear about Immediate Actions, and
their name pre-fills the form's District Contact section. Being one gives no access
to a form still in draft.

A district may keep a default, which every hand-off starts from and may override.
A hand-off has to name someone, unless the district has nobody who could be named:
an emergency is never held up by a list nobody has filled in.

Who can be named: the district's coordinators and crew, and anyone in its workflow.
"""
from __future__ import annotations

import json
import uuid

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..roles import is_admin
from . import notification_feed, org_tree

# What the contact hears about. They are told; nothing is asked of them.
LOOP_EVENTS = {
    "OFFICE_DELEGATED": "handed to a branch chief",
    "SENIOR_ENGINEER_ASSIGNED": "assigned to a Senior Specialist",
    "ENGINEER_ASSIGNED": "assigned to Staff",
    "SUBMITTED": "submitted for review",
    "REVISION_REQUESTED": "returned for changes",
    "APPROVED": "approved",
}


def _district(value) -> str:
    from . import maintenance_workflows as mw  # imports the app's routes; deferred to avoid a cycle

    return mw.district_code(value)


def eligible_ids(db: Session, district: str) -> set[int]:
    from . import maintenance_workflows as mw  # imports the app's routes; deferred to avoid a cycle

    ids: set[int] = set()
    for table in ("org_coordinator_coverage", "org_district_crew"):
        ids.update(int(uid) for uid in db.execute(
            text(f"SELECT user_id FROM {table} WHERE is_active = 1 AND TRIM(district) = :d"), {"d": district}
        ).scalars())
    definition = db.execute(text("SELECT definition_json FROM maintenance_workflows WHERE district = :d"), {"d": district}).scalar()
    if definition:
        ids.update(int(uid) for uid in mw.participants(mw.unpack(definition)))
    if not ids:
        return ids
    active = db.execute(text("SELECT id FROM users WHERE is_active = 1")).scalars()
    return ids & {int(uid) for uid in active}


def default_for(db: Session, district: str) -> int | None:
    found = db.execute(text("SELECT contact_user_id FROM org_district_settings WHERE district = :d"), {"d": district}).scalar()
    return int(found) if found is not None else None


def choose(*, requested: int | None, default: int | None, eligible: set[int]) -> int | None:
    """Who a hand-off names: the person asked for, else the district's default.

    A default who has since left the district does not count, and neither does
    anyone else from outside it.
    """
    if requested is not None:
        if requested not in eligible:
            raise HTTPException(status_code=400, detail="Choose a District Contact from this district.")
        return requested
    if default in eligible:
        return default
    if eligible:
        raise HTTPException(status_code=400, detail="Choose a District Contact before sending this to GeoTech.")
    return None  # Nobody to name in this district: the emergency still goes through.


def overview(db: Session, user: dict, district_value) -> dict:
    district = _district(district_value)
    eligible = eligible_ids(db, district)
    rows = db.execute(text("SELECT id, COALESCE(full_name, email) AS name FROM users ORDER BY name")).mappings().all()
    default = default_for(db, district)
    return {
        "district": district,
        "default_user_id": default if default in eligible else None,
        "can_edit": can_set_default(db, user, district),
        "candidates": [{"id": int(r["id"]), "full_name": r["name"]} for r in rows if int(r["id"]) in eligible],
    }


def can_set_default(db: Session, user: dict, district: str) -> bool:
    if is_admin(user):
        return True
    from . import maintenance_workflows as mw  # imports the app's routes; deferred to avoid a cycle

    if district in org_tree.maintenance_places(db, int(user["id"]))["coordinator"]:
        return True
    definition = db.execute(text("SELECT definition_json FROM maintenance_workflows WHERE district = :d"), {"d": district}).scalar()
    return bool(definition) and int(user["id"]) in mw.unpack(definition)["manager_user_ids"]


def set_default(db: Session, user: dict, district_value, contact_id: int | None) -> None:
    """Does NOT commit."""
    district = _district(district_value)
    if not can_set_default(db, user, district):
        raise HTTPException(status_code=403, detail="Only this district's coordinators, workflow managers or an administrator can set this.")
    if contact_id is not None and contact_id not in eligible_ids(db, district):
        raise HTTPException(status_code=400, detail="Choose a District Contact from this district.")
    db.execute(
        text("""
            INSERT INTO org_district_settings (district, contact_user_id, updated_by_user_id)
            VALUES (:d, :c, :by)
            ON DUPLICATE KEY UPDATE contact_user_id = VALUES(contact_user_id), updated_by_user_id = VALUES(updated_by_user_id)
        """),
        {"d": district, "c": contact_id, "by": int(user["id"])},
    )


def _title(incident: dict) -> str:
    return str(incident.get("title") or f"Incident #{incident['id']}")


def assign(db: Session, incident: dict, requested: int | None, *, actor_id: int) -> int | None:
    """Records who a hand-off names, and tells them. Does NOT commit."""
    try:
        district = _district(incident.get("district"))
    except HTTPException:
        return None  # A report with no usable district has no list to choose from.
    contact = choose(requested=requested, default=default_for(db, district), eligible=eligible_ids(db, district))
    db.execute(
        text("UPDATE incidents SET district_contact_user_id = :c WHERE id = :i"),
        {"c": contact, "i": int(incident["id"])},
    )
    if contact is not None:
        notification_feed.add(
            db, [contact], kind="DISTRICT_CONTACT", actor_id=actor_id, incident_id=int(incident["id"]),
            title=f"You are the District Contact for {_title(incident)}",
            body="You will be told how the assessment goes, and about any Immediate Actions.",
        )
    return contact


def contact_of(db: Session, incident_id: int) -> int | None:
    found = db.execute(text("SELECT district_contact_user_id FROM incidents WHERE id = :i"), {"i": int(incident_id)}).scalar()
    return int(found) if found is not None else None


def tell_about_event(db: Session, *, incident_id: int, assessment_id: int | None, event_type: str, actor_id: int) -> None:
    """Keeps the contact informed of an assessment's milestones. Does NOT commit."""
    happened = LOOP_EVENTS.get(event_type)
    if not happened or assessment_id is None:
        return
    contact = contact_of(db, incident_id)
    if contact is None:
        return
    title = db.execute(text("SELECT title FROM incidents WHERE id = :i"), {"i": int(incident_id)}).scalar()
    notification_feed.add(
        db, [contact], kind="DISTRICT_CONTACT", actor_id=actor_id, incident_id=int(incident_id),
        title=f"Assessment #{assessment_id} {happened}",
        body=str(title) if title else f"Incident #{incident_id}",
    )


def form_contact(full_name: str) -> str:
    """The person as the form's District Contact section stores them."""
    first, _, last = full_name.strip().partition(" ")
    return json.dumps([{
        "id": str(uuid.uuid4()), "first_name": first, "last_name": last.strip(),
        "s_number": "", "phone": "", "cell_phone": "",
    }])


def prefill_form(db: Session, *, submission_id: int, incident_id: int) -> None:
    """Fills an empty District Contact section; what somebody typed stays. Does NOT commit."""
    contact = contact_of(db, incident_id)
    if contact is None:
        return
    name = db.execute(text("SELECT COALESCE(full_name, email) FROM users WHERE id = :u"), {"u": contact}).scalar()
    if not name:
        return
    db.execute(
        text("""
            UPDATE submission_gisa SET district_contact = :value
             WHERE submission_id = :sid AND (district_contact IS NULL OR TRIM(district_contact) = '')
        """),
        {"value": form_contact(str(name)), "sid": int(submission_id)},
    )

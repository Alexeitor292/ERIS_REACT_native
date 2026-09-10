# backend/app/permissions.py
from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import text

# Re-export the canonical role helpers so callers can use a single import.
# `is_operational_user`/`is_maintenance_only` understand both the new canonical
# role names and their legacy aliases (see app/roles.py).
from .roles import (  # noqa: F401
    is_maintenance_only,
    is_operational_user,
    is_public_only,
    is_public_viewer,
)

def is_admin(user: dict) -> bool:
    return "ADMIN" in user.get("roles", [])

def is_reviewer(user: dict) -> bool:
    """DEPRECATED — holds the legacy REVIEWER account role, nothing more.

    It is NOT review authority: routing v2 derives that from the assessment's
    routing path (see routes/assessments._review_authority), and REVIEWER keeps
    only broad operational READ. Every read shortcut that used to call this now
    calls is_operational_user(), which already includes REVIEWER — so an office
    chief reviewing on the senior engineer route has the same reach a legacy
    REVIEWER has. New code must not call this function.
    """
    return "REVIEWER" in user.get("roles", [])

def is_field_worker(user: dict) -> bool:
    return "FIELD_WORKER" in user.get("roles", [])

def require_is_owner_or_admin(db: Session, *, user: dict, submission_id: int) -> None:
    if is_admin(user):
        return

    owner = db.execute(text("""
        SELECT created_by_user_id
        FROM submissions
        WHERE id = :sid
        LIMIT 1
    """), {"sid": submission_id}).scalar()

    if owner is None:
        raise HTTPException(status_code=404, detail="Submission not found")

    if int(owner) != int(user["id"]):
        raise HTTPException(status_code=403, detail="Not allowed (owner/admin only)")

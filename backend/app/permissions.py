# backend/app/permissions.py
from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import text

# Re-export the role helpers so callers can use a single import (see app/roles.py).
from .roles import (  # noqa: F401
    is_maintenance_only,
    is_operational_user,
    is_public_only,
    is_public_viewer,
)

def is_admin(user: dict) -> bool:
    return "ADMIN" in user.get("roles", [])

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

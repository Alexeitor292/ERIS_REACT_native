# backend/app/permissions.py
from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import text

def is_admin(user: dict) -> bool:
    return "ADMIN" in user.get("roles", [])

def is_reviewer(user: dict) -> bool:
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

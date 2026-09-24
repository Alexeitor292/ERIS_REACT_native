"""Sharing a technical form, and the chiefs' side of it (services/sharing.py).

* ``POST /submissions/{id}/share`` — the owner (or an administrator) shares the
  form with one person: viewing and editing, granted at once or once every
  branch chief with a say approves.
* ``DELETE /submissions/{id}/share/{user_id}`` — the sharer withdraws it.
* ``GET /submissions/{id}/shares`` — the form's shares, where each stands, and
  who it can still be shared with (owner and administrators).
* ``GET /shares/reviews`` — shares waiting on the caller as a branch or office
  chief: approvals to give and notices to read.
* ``POST /shares/{share_id}/reviews/{review_id}`` — approve, reject (stop) or
  acknowledge.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require_roles
from ..roles import ADMIN, BRANCH_CHIEF, GISA_AUTHOR_ROLES, OFFICE_CHIEF
from ..schemas.common import ShareRequest
from ..services import sharing

router = APIRouter(tags=["sharing"])

CHIEF_ROLES = [OFFICE_CHIEF, BRANCH_CHIEF, ADMIN]


class ShareDecision(BaseModel):
    decision: str = Field(..., max_length=16)
    note: str | None = Field(default=None, max_length=1000)


def _owner(db: Session, submission_id: int) -> int:
    owner = db.execute(text("SELECT created_by_user_id FROM submissions WHERE id = :sid"), {"sid": submission_id}).scalar()
    if owner is None:
        raise HTTPException(status_code=404, detail="Submission not found")
    return int(owner)


@router.post("/submissions/{submission_id}/share")
def share_submission(
    submission_id: int = Path(..., ge=1),
    payload: ShareRequest = ...,
    db: Session = Depends(get_db),
    user=Depends(require_roles(GISA_AUTHOR_ROLES)),
) -> dict[str, Any]:
    from ..main import require_can_manage_submission_permissions  # the app module imports this router

    require_can_manage_submission_permissions(submission_id, db, user)
    owner_id = _owner(db, submission_id)
    target = db.execute(text("SELECT is_active FROM users WHERE id = :uid"), {"uid": payload.user_id}).scalar()
    if target is None:
        raise HTTPException(status_code=404, detail="Target user not found")
    if not target:
        raise HTTPException(status_code=400, detail="That account is not active")
    if int(payload.user_id) == owner_id:
        raise HTTPException(status_code=400, detail="The owner already has access")
    share_id = sharing.create(db, submission_id=submission_id, owner_id=owner_id, actor=user, recipient_id=int(payload.user_id))
    db.commit()
    share = next(item for item in sharing.for_submission(db, submission_id) if item["id"] == share_id)
    return {"submission_id": submission_id, "shared_with_user_id": int(payload.user_id), "share": share}


@router.delete("/submissions/{submission_id}/share/{user_id}")
def unshare_submission(
    submission_id: int = Path(..., ge=1),
    user_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(GISA_AUTHOR_ROLES)),
) -> dict[str, Any]:
    from ..main import require_can_manage_submission_permissions

    require_can_manage_submission_permissions(submission_id, db, user)
    sharing.withdraw(db, submission_id=submission_id, recipient_id=user_id, actor=user)
    db.commit()
    return {"submission_id": submission_id, "unshared_user_id": user_id}


@router.get("/submissions/{submission_id}/shares")
def submission_shares(
    submission_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(GISA_AUTHOR_ROLES)),
) -> dict[str, Any]:
    from ..main import require_can_manage_submission_permissions

    require_can_manage_submission_permissions(submission_id, db, user)
    owner_id = _owner(db, submission_id)
    shares = sharing.for_submission(db, submission_id)
    open_ids = {share["recipient"]["id"] for share in shares if share["status"] in sharing.OPEN}
    # Access given before shares needed approval (or by hand), not tied to a share.
    grants = [
        {"user_id": int(row["user_id"]), "full_name": row["full_name"], "email": row["email"], "can_edit": bool(row["can_edit"])}
        for row in db.execute(
            text(
                """
                SELECT g.user_id, u.full_name, u.email,
                       EXISTS (SELECT 1 FROM submission_editors e WHERE e.submission_id = :sid AND e.user_id = g.user_id) AS can_edit
                  FROM (SELECT user_id FROM submission_visibility WHERE submission_id = :sid
                        UNION SELECT user_id FROM submission_editors WHERE submission_id = :sid) g
                  JOIN users u ON u.id = g.user_id
                 ORDER BY u.full_name, u.email
                """
            ),
            {"sid": submission_id},
        ).mappings().all()
        if int(row["user_id"]) not in open_ids
    ]
    return {
        "shares": shares,
        "grants": grants,
        "candidates": sharing.candidates(db, submission_id=submission_id, owner_id=owner_id),
    }


@router.get("/shares/reviews")
def share_reviews(db: Session = Depends(get_db), user=Depends(require_roles(CHIEF_ROLES))) -> dict[str, Any]:
    return {"items": sharing.queue(db, user)}


@router.post("/shares/{share_id}/reviews/{review_id}")
def decide_share(
    share_id: int = Path(..., ge=1),
    review_id: int = Path(..., ge=1),
    payload: ShareDecision = ...,
    db: Session = Depends(get_db),
    user=Depends(require_roles(CHIEF_ROLES)),
) -> dict[str, Any]:
    share = sharing.decide(db, actor=user, share_id=share_id, review_id=review_id, decision=payload.decision, note=payload.note)
    db.commit()
    return {"share_id": share_id, "status": share["status"]}

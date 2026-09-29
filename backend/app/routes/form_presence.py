"""Who else has a technical form open (``services/form_presence.py``)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Path
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import deny_public_only
from ..roles import GISA_AUTHOR_ROLES, has_any_role
from ..services import form_presence

router = APIRouter(tags=["form-presence"])


class PresenceBeat(BaseModel):
    session_id: str = Field(min_length=8, max_length=64)
    area: str | None = Field(default=None, max_length=96)
    field: str | None = Field(default=None, max_length=160)
    memos: list[str] = Field(default_factory=list, max_length=8)
    typing: bool = False


@router.post("/submissions/{submission_id}/presence")
def presence_heartbeat(
    payload: PresenceBeat,
    submission_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(deny_public_only),
):
    from ..main import can_edit_submission, get_submission_status, require_can_view_submission  # the app module imports this router

    require_can_view_submission(submission_id, db, user)
    can_edit = (
        has_any_role(user, *GISA_AUTHOR_ROLES)
        and can_edit_submission(db, user=user, submission_id=submission_id)
        and get_submission_status(db, submission_id) in {"DRAFT", "REJECTED"}
    )
    return form_presence.heartbeat(
        db,
        submission_id=submission_id,
        user=user,
        session_id=payload.session_id,
        area=payload.area,
        field=payload.field,
        memos=payload.memos,
        typing=payload.typing,
        can_edit=can_edit,
    )


@router.delete("/submissions/{submission_id}/presence/{session_id}")
def presence_leave(
    submission_id: int = Path(..., ge=1),
    session_id: str = Path(..., min_length=8, max_length=64),
    db: Session = Depends(get_db),
    user=Depends(deny_public_only),
):
    form_presence.leave(db, submission_id=submission_id, user=user, session_id=session_id)
    return {"ok": True}

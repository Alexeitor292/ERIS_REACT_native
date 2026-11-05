"""Out of the office (services/delegations.py).

* ``GET /delegations`` — what the caller gave and was given, and whom they may
  switch to acting for now.
* ``GET /delegations/people`` — whom else the caller may set one for, as their supervisor.
* ``GET /delegations/candidates`` — whom this person may name.
* ``POST /delegations`` — name a delegate between two dates.
* ``POST /delegations/{id}/cancel`` — end it early, or before it starts.
* ``GET /delegations/{id}/actions`` — what was done under it.
"""
from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import deny_public_only
from ..services import delegations

router = APIRouter(tags=["delegations"])


class DelegationRequest(BaseModel):
    delegate_user_id: int = Field(..., ge=1)
    starts_on: date
    ends_on: date
    note: str | None = Field(default=None, max_length=500)
    # For someone away unexpectedly: their supervisor or an administrator sets it.
    for_user_id: int | None = Field(default=None, ge=1)


@router.get("/delegations")
def my_delegations(db: Session = Depends(get_db), user=Depends(deny_public_only)) -> dict[str, Any]:
    return delegations.overview(db, int(user["id"]))


@router.get("/delegations/people")
def delegation_people(db: Session = Depends(get_db), user=Depends(deny_public_only)) -> dict[str, Any]:
    return {"items": delegations.people_for(db, user)}


@router.get("/delegations/candidates")
def delegation_candidates(
    for_user_id: int | None = Query(default=None, ge=1),
    db: Session = Depends(get_db),
    user=Depends(deny_public_only),
) -> dict[str, Any]:
    person = int(for_user_id or user["id"])
    if not delegations.can_set_for(db, user, person):
        raise HTTPException(status_code=403, detail="Only this person, their supervisor or an administrator can set this.")
    return {"items": delegations.candidates(db, person_id=person)}


@router.post("/delegations")
def create_delegation(payload: DelegationRequest, db: Session = Depends(get_db), user=Depends(deny_public_only)) -> dict[str, Any]:
    delegation_id = delegations.create(
        db,
        actor=user,
        person_id=int(payload.for_user_id or user["id"]),
        delegate_id=payload.delegate_user_id,
        starts_on=payload.starts_on,
        ends_on=payload.ends_on,
        note=payload.note,
    )
    db.commit()
    return {"id": delegation_id, **delegations.overview(db, int(user["id"]))}


@router.post("/delegations/{delegation_id}/cancel")
def cancel_delegation(delegation_id: int = Path(..., ge=1), db: Session = Depends(get_db), user=Depends(deny_public_only)) -> dict[str, Any]:
    delegations.cancel(db, actor=user, delegation_id=delegation_id)
    db.commit()
    return delegations.overview(db, int(user["id"]))


@router.get("/delegations/{delegation_id}/actions")
def delegation_actions(delegation_id: int = Path(..., ge=1), db: Session = Depends(get_db), user=Depends(deny_public_only)) -> dict[str, Any]:
    return {"items": delegations.actions(db, actor=user, delegation_id=delegation_id)}

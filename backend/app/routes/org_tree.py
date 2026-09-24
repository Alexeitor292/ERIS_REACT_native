"""The organization as people see it: one tree per GeoTech office, and the
maintenance lists per district. Places give roles (services/org_tree.py).

Office and branch chiefs manage their own part of their office's tree;
administrators manage everything, including the maintenance lists and who is an
administrator. Office details (name, districts served) stay on /admin/org/offices.
"""
from __future__ import annotations

from contextlib import contextmanager

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require_roles
from ..services import org_tree
from ..services.org_tree import OrgTreeError

router = APIRouter(tags=["organization"])

TREE_VIEWERS = ["ADMIN", "OFFICE_CHIEF", "BRANCH_CHIEF"]
ADMIN_ONLY = ["ADMIN"]


class PersonIn(BaseModel):
    user_id: int = Field(..., ge=1)


class BranchIn(BaseModel):
    name: str = Field(default="", max_length=160)
    letter: str | None = Field(default=None, max_length=4)
    home_city: str | None = Field(default=None, max_length=64)
    home_district: str | None = Field(default=None, max_length=4)
    # A branch never exists without its chief.
    chief_user_id: int = Field(..., ge=1)


class BranchPatchIn(BaseModel):
    name: str | None = Field(default=None, max_length=160)
    letter: str | None = Field(default=None, max_length=4)
    home_city: str | None = Field(default=None, max_length=64)
    home_district: str | None = Field(default=None, max_length=4)


class AdminIn(BaseModel):
    is_admin: bool


@contextmanager
def _writing(db: Session):
    try:
        yield
        db.commit()
    except OrgTreeError as exc:
        db.rollback()
        raise HTTPException(status_code=exc.status, detail=exc.message)
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise


def _tree_payload(db: Session, actor: dict) -> dict:
    offices = []
    for office_id in org_tree.offices_visible_to(db, actor):
        tree = org_tree.office_tree(db, office_id)
        if not tree:
            continue
        manage_office = org_tree.can_manage_office(db, actor, office_id)
        tree["can_manage"] = manage_office
        tree["can_name_chiefs"] = org_tree.is_admin(actor)
        for branch in tree["branches"]:
            branch["can_manage"] = manage_office or org_tree.can_manage_branch(db, actor, {"id": branch["id"], "office_id": office_id})
        offices.append(tree)
    return {
        "offices": offices,
        "me": {"id": int(actor["id"]), "is_admin": org_tree.is_admin(actor), **org_tree.placement(db, int(actor["id"]))},
    }


@router.get("/org/tree")
def get_tree(db: Session = Depends(get_db), actor=Depends(require_roles(TREE_VIEWERS))):
    return _tree_payload(db, actor)


@router.get("/org/people")
def find_people(
    q: str = Query(default="", max_length=80),
    db: Session = Depends(get_db),
    _actor=Depends(require_roles(TREE_VIEWERS)),
):
    """Registered users to place, with where each one sits today."""
    return {"items": org_tree.search_people(db, q)}


@router.post("/org/offices/{office_id}/chiefs")
def add_office_chief(body: PersonIn, office_id: int = Path(..., ge=1), db: Session = Depends(get_db), actor=Depends(require_roles(ADMIN_ONLY))):
    with _writing(db):
        org_tree.add_office_chief(db, actor, office_id=office_id, user_id=body.user_id)
    return _tree_payload(db, actor)


@router.post("/org/offices/{office_id}/specialists")
def add_specialist(body: PersonIn, office_id: int = Path(..., ge=1), db: Session = Depends(get_db), actor=Depends(require_roles(TREE_VIEWERS))):
    with _writing(db):
        org_tree.add_specialist(db, actor, office_id=office_id, user_id=body.user_id)
    return _tree_payload(db, actor)


@router.post("/org/offices/{office_id}/branches", status_code=201)
def add_branch(body: BranchIn, office_id: int = Path(..., ge=1), db: Session = Depends(get_db), actor=Depends(require_roles(TREE_VIEWERS))):
    with _writing(db):
        org_tree.create_branch(
            db, actor, office_id=office_id, name=body.name, letter=body.letter,
            home_city=body.home_city, home_district=body.home_district, chief_user_id=body.chief_user_id,
        )
    return _tree_payload(db, actor)


@router.patch("/org/branches/{branch_id}")
def edit_branch(body: BranchPatchIn, branch_id: int = Path(..., ge=1), db: Session = Depends(get_db), actor=Depends(require_roles(TREE_VIEWERS))):
    with _writing(db):
        org_tree.update_branch(db, actor, branch_id=branch_id, fields=body.model_dump(exclude_unset=True))
    return _tree_payload(db, actor)


@router.post("/org/branches/{branch_id}/chief")
def set_branch_chief(body: PersonIn, branch_id: int = Path(..., ge=1), db: Session = Depends(get_db), actor=Depends(require_roles(TREE_VIEWERS))):
    with _writing(db):
        org_tree.set_branch_chief(db, actor, branch_id=branch_id, user_id=body.user_id)
    return _tree_payload(db, actor)


@router.post("/org/branches/{branch_id}/staff")
def add_staff(body: PersonIn, branch_id: int = Path(..., ge=1), db: Session = Depends(get_db), actor=Depends(require_roles(TREE_VIEWERS))):
    with _writing(db):
        org_tree.add_staff(db, actor, branch_id=branch_id, user_id=body.user_id)
    return _tree_payload(db, actor)


@router.post("/org/branches/{branch_id}/retire")
def retire_branch(branch_id: int = Path(..., ge=1), db: Session = Depends(get_db), actor=Depends(require_roles(TREE_VIEWERS))):
    with _writing(db):
        org_tree.retire_branch(db, actor, branch_id=branch_id)
    return _tree_payload(db, actor)


@router.delete("/org/tree/people/{user_id}")
def remove_person(user_id: int = Path(..., ge=1), db: Session = Depends(get_db), actor=Depends(require_roles(TREE_VIEWERS))):
    with _writing(db):
        org_tree.remove_from_tree(db, actor, user_id=user_id)
    return _tree_payload(db, actor)


class DetailsIn(BaseModel):
    classification_code: str | None = Field(default=None, max_length=8)
    classification_marker: str | None = Field(default=None, max_length=8)
    position_number: str | None = Field(default=None, max_length=32)
    job_title: str | None = Field(default=None, max_length=96)
    level_code: str | None = Field(default=None, max_length=8)
    home_city: str | None = Field(default=None, max_length=64)
    home_district: str | None = Field(default=None, max_length=4)
    availability: str | None = Field(default=None, max_length=16)
    available_until: str | None = Field(default=None, max_length=10)


@router.get("/org/tree/people/{user_id}/details")
def get_details(user_id: int = Path(..., ge=1), db: Session = Depends(get_db), actor=Depends(require_roles(TREE_VIEWERS))):
    if not org_tree.can_edit_details(db, actor, user_id):
        raise HTTPException(status_code=403, detail="You cannot see this person's details.")
    return org_tree.person_details(db, user_id)


@router.put("/org/tree/people/{user_id}/details")
def put_details(body: DetailsIn, user_id: int = Path(..., ge=1), db: Session = Depends(get_db), actor=Depends(require_roles(TREE_VIEWERS))):
    """Classification, position, home and availability. Never a place, never a role."""
    with _writing(db):
        org_tree.update_details(db, actor, user_id=user_id, fields=body.model_dump(exclude_unset=True))
    return org_tree.person_details(db, user_id)


# --- maintenance -------------------------------------------------------------

_KINDS = {"coordinators": "COORDINATOR", "crew": "CREW"}


def _maintenance_payload(db: Session) -> dict:
    return {"districts": org_tree.maintenance_lists(db)}


def _kind(value: str) -> str:
    kind = _KINDS.get(value)
    if not kind:
        raise HTTPException(status_code=404, detail="Unknown list")
    return kind


@router.get("/org/maintenance")
def get_maintenance(db: Session = Depends(get_db), _actor=Depends(require_roles(ADMIN_ONLY))):
    return _maintenance_payload(db)


@router.post("/org/maintenance/{district}/{kind}")
def add_maintenance(body: PersonIn, district: str = Path(..., max_length=4), kind: str = Path(...), db: Session = Depends(get_db), actor=Depends(require_roles(ADMIN_ONLY))):
    with _writing(db):
        org_tree.add_maintenance(db, actor, district=district, user_id=body.user_id, kind=_kind(kind))
    return _maintenance_payload(db)


@router.delete("/org/maintenance/{district}/{kind}/{user_id}")
def remove_maintenance(district: str = Path(..., max_length=4), kind: str = Path(...), user_id: int = Path(..., ge=1), db: Session = Depends(get_db), actor=Depends(require_roles(ADMIN_ONLY))):
    with _writing(db):
        org_tree.remove_maintenance(db, actor, district=district, user_id=user_id, kind=_kind(kind))
    return _maintenance_payload(db)


@router.post("/org/maintenance/{district}/coordinators/{user_id}/primary")
def make_primary(district: str = Path(..., max_length=4), user_id: int = Path(..., ge=1), db: Session = Depends(get_db), actor=Depends(require_roles(ADMIN_ONLY))):
    with _writing(db):
        org_tree.set_primary_coordinator(db, actor, district=district, user_id=user_id)
    return _maintenance_payload(db)


# --- administrators ----------------------------------------------------------


@router.put("/admin/users/{user_id}/admin")
def set_admin(body: AdminIn, user_id: int = Path(..., ge=1), db: Session = Depends(get_db), actor=Depends(require_roles(ADMIN_ONLY))):
    """The one role granted directly. Everything else follows from where people sit."""
    with _writing(db):
        roles = org_tree.set_admin(db, actor_id=int(actor["id"]), user_id=user_id, is_admin=body.is_admin)
    return {"user_id": user_id, "roles": sorted(roles)}


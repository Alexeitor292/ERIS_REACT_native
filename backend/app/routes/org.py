"""The organization as an admin surface: offices, branches, coverage, people.

Every organizational fact ERIS has is editable here, because owner decision 8
makes flexibility a goal in itself: nothing organizational is hard-coded, roles
are never bound to named people, and deactivating or renaming a unit must not
break history. The district -> office map that used to live in three hard-coded
copies is now ``org_office_districts`` rows an admin owns, and moving district 05
to another office takes effect on the next request with no deploy.

FOUR RULES this module is built around, each with its reason.

**Deactivate, never delete.** Offices and branches carry history: an assessment
routed to an office names it forever. Both tables keep ``is_active`` and every
"remove" endpoint sets it to 0. Nothing here issues a DELETE against an office,
a branch or a profile.

**The office code is immutable after creation.** ``assessments.office_code`` and
``incidents.office_code`` join on it as a string, so renaming a code would
silently re-point — or orphan — every historical record. ``PATCH`` answers 422
with that explanation rather than accepting the field (design §3.8).

**One district, one active office of a given type.** The database enforces it
through a generated unique key; this module catches the collision first and
answers 409 NAMING the other office, because "Duplicate entry" is not an answer
an admin can act on. A MAINTENANCE office covering district 04 while WEST also
covers it is legal — that is what scoping the key to ``org_type`` is for.

**Classification suggests, never grants.** ``PUT /admin/users/{id}/org`` returns
a ``role_suggestion`` and NEVER writes ``user_roles``. The charts show a vacant
office chief filled out of class and a senior specialist OOC-covered for eight
months; an admin must be able to grant a role that contradicts a classification
(design §6, §12).
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import deny_public_only, get_current_user, require_roles
from ..roles import ADMIN, ROLE_ALIASES
from ..services import org_directory
from ..user_metadata import normalize_district_code, normalize_office_code, normalize_profile_text

router = APIRouter(tags=["organization"])

# Every /admin/org/* endpoint is ADMIN-only. That is a property of THESE
# endpoints, not of the /admin router as a whole: GET /admin/assessment-assignment-options/{id}
# lives on the same prefix and is chiefs + ADMIN.
ADMIN_ONLY = [ADMIN]


# ---------------------------------------------------------------------------
# Request models. Every PATCH/PUT is a PER-FIELD MERGE: `model_dump(exclude_unset=True)`
# is what makes "omitted fields are untouched" true, rather than a blanket
# replace that would clear a field an admin never opened.
# ---------------------------------------------------------------------------


class OfficeCreateIn(BaseModel):
    code: str = Field(min_length=1, max_length=16)
    org_type: Literal["GEOTECH", "MAINTENANCE"] = "GEOTECH"
    unit_number: str | None = Field(default=None, max_length=16)
    name: str = Field(min_length=1, max_length=160)
    short_name: str | None = Field(default=None, max_length=64)
    home_city: str | None = Field(default=None, max_length=64)
    home_district: str | None = Field(default=None, max_length=8)
    home_location_label: str | None = Field(default=None, max_length=64)
    is_routing_target: bool = True
    sort_order: int = 0


class OfficePatchIn(BaseModel):
    # `code` is declared ONLY so the handler can answer 422 with the reason.
    # Leaving it undeclared would make FastAPI drop it silently and the admin
    # would believe a rename had happened.
    code: str | None = Field(default=None, max_length=16)
    unit_number: str | None = Field(default=None, max_length=16)
    name: str | None = Field(default=None, min_length=1, max_length=160)
    short_name: str | None = Field(default=None, max_length=64)
    home_city: str | None = Field(default=None, max_length=64)
    home_district: str | None = Field(default=None, max_length=8)
    home_location_label: str | None = Field(default=None, max_length=64)
    is_routing_target: bool | None = None
    is_active: bool | None = None
    sort_order: int | None = None


class OfficeDeactivateIn(BaseModel):
    reason: str | None = Field(default=None, max_length=255)


class OfficeDistrictsIn(BaseModel):
    districts: list[str] = Field(default_factory=list)
    primary_district: str | None = Field(default=None, max_length=8)


class BranchCreateIn(BaseModel):
    office_id: int = Field(ge=1)
    unit_type: Literal["BRANCH", "REGION", "AREA", "YARD"] = "BRANCH"
    letter: str | None = Field(default=None, max_length=4)
    name: str = Field(min_length=1, max_length=160)
    parent_branch_id: int | None = Field(default=None, ge=1)
    home_city: str | None = Field(default=None, max_length=64)
    home_district: str | None = Field(default=None, max_length=8)
    home_location_label: str | None = Field(default=None, max_length=64)
    chief_user_id: int | None = Field(default=None, ge=1)
    accepts_assignments: bool = True
    sort_order: int = 0


class BranchPatchIn(BaseModel):
    letter: str | None = Field(default=None, max_length=4)
    name: str | None = Field(default=None, min_length=1, max_length=160)
    parent_branch_id: int | None = Field(default=None, ge=1)
    home_city: str | None = Field(default=None, max_length=64)
    home_district: str | None = Field(default=None, max_length=8)
    home_location_label: str | None = Field(default=None, max_length=64)
    chief_user_id: int | None = Field(default=None, ge=1)
    accepts_assignments: bool | None = None
    is_active: bool | None = None
    sort_order: int | None = None


class BranchDistrictsIn(BaseModel):
    districts: list[str] = Field(default_factory=list)
    source: Literal["CHART", "INFERRED", "ADMIN"] = "ADMIN"
    notes: str | None = Field(default=None, max_length=255)


class ClassificationPutIn(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=96)
    level_code: str | None = Field(default=None, max_length=8)
    eris_role: str | None = Field(default=None, max_length=64)
    is_supervisor: bool | None = None
    is_active: bool | None = None
    notes: str | None = Field(default=None, max_length=255)


class CoverageCreateIn(BaseModel):
    district: str = Field(min_length=1, max_length=8)
    user_id: int = Field(ge=1)
    is_primary: bool = True


class UserOrgPutIn(BaseModel):
    office_id: int | None = Field(default=None, ge=1)
    branch_id: int | None = Field(default=None, ge=1)
    home_city: str | None = Field(default=None, max_length=64)
    home_district: str | None = Field(default=None, max_length=8)
    classification_code: str | None = Field(default=None, max_length=8)
    classification_marker: str | None = Field(default=None, max_length=8)
    position_number: str | None = Field(default=None, max_length=32)
    job_title: str | None = Field(default=None, max_length=96)
    level_code: str | None = Field(default=None, max_length=8)
    supervisor_user_id: int | None = Field(default=None, ge=1)
    availability: Literal["AVAILABLE", "ROTATION_OUT", "ACTING_ELSEWHERE", "UNAVAILABLE"] | None = None
    available_from: str | None = None
    available_until: str | None = None
    notes: str | None = Field(default=None, max_length=255)


# ---------------------------------------------------------------------------
# Small shared helpers
# ---------------------------------------------------------------------------


def _office_row(db: Session, office_id: int) -> dict | None:
    row = db.execute(
        text(
            """
            SELECT id, code, org_type, unit_number, name, short_name, home_city,
                   home_district, home_location_label, is_routing_target, is_active,
                   sort_order, created_at, updated_at
              FROM org_offices
             WHERE id = :oid
             LIMIT 1
            """
        ),
        {"oid": int(office_id)},
    ).mappings().first()
    return dict(row) if row else None


def _branch_row(db: Session, branch_id: int) -> dict | None:
    row = db.execute(
        text(
            """
            SELECT b.id, b.office_id, b.parent_branch_id, b.unit_type, b.letter, b.name,
                   b.home_city, b.home_district, b.home_location_label, b.chief_user_id,
                   b.accepts_assignments, b.is_active, b.sort_order,
                   o.code AS office_code, o.org_type
              FROM org_branches b
              JOIN org_offices o ON o.id = b.office_id
             WHERE b.id = :bid
             LIMIT 1
            """
        ),
        {"bid": int(branch_id)},
    ).mappings().first()
    return dict(row) if row else None


def _serialize_office(row: dict, *, districts: list[dict] | None = None, branches: list[dict] | None = None,
                      branch_count: int | None = None, member_count: int | None = None) -> dict:
    payload = {
        "id": int(row["id"]),
        "code": row["code"],
        "org_type": row["org_type"],
        "unit_number": row.get("unit_number"),
        "name": row.get("name"),
        "short_name": row.get("short_name"),
        "home_city": row.get("home_city"),
        "home_district": row.get("home_district"),
        "home_location_label": row.get("home_location_label"),
        "is_routing_target": bool(row.get("is_routing_target")),
        "is_active": bool(row.get("is_active")),
        "sort_order": int(row.get("sort_order") or 0),
    }
    if districts is not None:
        payload["districts"] = districts
    if branches is not None:
        payload["branches"] = branches
    if branch_count is not None:
        payload["branch_count"] = int(branch_count)
    if member_count is not None:
        payload["member_count"] = int(member_count)
    return payload


def _serialize_branch(row: dict, *, districts: list[dict] | None = None, chief: dict | None = None,
                      member_count: int | None = None) -> dict:
    payload = {
        "id": int(row["id"]),
        "office_id": int(row["office_id"]),
        "office_code": row.get("office_code"),
        "parent_branch_id": int(row["parent_branch_id"]) if row.get("parent_branch_id") is not None else None,
        "unit_type": row.get("unit_type"),
        "letter": row.get("letter"),
        "name": row.get("name"),
        "home_city": row.get("home_city"),
        "home_district": row.get("home_district"),
        "home_location_label": row.get("home_location_label"),
        "chief_user_id": int(row["chief_user_id"]) if row.get("chief_user_id") is not None else None,
        "accepts_assignments": bool(row.get("accepts_assignments")),
        "is_active": bool(row.get("is_active")),
        "sort_order": int(row.get("sort_order") or 0),
    }
    if districts is not None:
        payload["districts"] = districts
    payload["chief"] = chief
    if member_count is not None:
        payload["member_count"] = int(member_count)
    return payload


def _office_districts(db: Session, office_ids: list[int]) -> dict[int, list[dict]]:
    if not office_ids:
        return {}
    params = {f"oid_{index}": int(oid) for index, oid in enumerate(office_ids)}
    tokens = ", ".join(f":oid_{index}" for index in range(len(office_ids)))
    rows = db.execute(
        text(
            f"""
            SELECT id, office_id, district, is_primary, is_active
              FROM org_office_districts
             WHERE office_id IN ({tokens})
             ORDER BY district ASC
            """
        ),
        params,
    ).mappings().all()
    out: dict[int, list[dict]] = {}
    for row in rows:
        out.setdefault(int(row["office_id"]), []).append(
            {
                "id": int(row["id"]),
                "district": str(row["district"]).strip(),
                "is_primary": bool(row["is_primary"]),
                "is_active": bool(row["is_active"]),
            }
        )
    return out


def _branch_districts(db: Session, branch_ids: list[int]) -> dict[int, list[dict]]:
    if not branch_ids:
        return {}
    params = {f"bid_{index}": int(bid) for index, bid in enumerate(branch_ids)}
    tokens = ", ".join(f":bid_{index}" for index in range(len(branch_ids)))
    rows = db.execute(
        text(
            f"""
            SELECT id, branch_id, district, source, notes, is_active
              FROM org_branch_districts
             WHERE branch_id IN ({tokens})
             ORDER BY district ASC
            """
        ),
        params,
    ).mappings().all()
    out: dict[int, list[dict]] = {}
    for row in rows:
        out.setdefault(int(row["branch_id"]), []).append(
            {
                "id": int(row["id"]),
                "district": str(row["district"]).strip(),
                "source": row["source"],
                "notes": row["notes"],
                "is_active": bool(row["is_active"]),
            }
        )
    return out


def _normalized_districts(raw: list[str]) -> list[str]:
    """Normalize, de-duplicate and validate a district set. 422 on nonsense."""
    out: list[str] = []
    for raw_district in raw or []:
        code = normalize_district_code(raw_district)
        if not code or not code.isdigit() or len(code) != 2:
            raise HTTPException(status_code=422, detail=f"Invalid district code: {raw_district!r}")
        if code not in out:
            out.append(code)
    return sorted(out)


def _user_brief(db: Session, user_id: int | None) -> dict | None:
    if user_id is None:
        return None
    row = db.execute(
        text("SELECT id, email, full_name FROM users WHERE id = :uid LIMIT 1"),
        {"uid": int(user_id)},
    ).mappings().first()
    if not row:
        return None
    return {"id": int(row["id"]), "email": row["email"], "full_name": row["full_name"]}


# ---------------------------------------------------------------------------
# Read: any authenticated user (labels), then ADMIN (records)
# ---------------------------------------------------------------------------


@router.get("/org/offices")
def list_org_offices(
    include_inactive: bool = Query(default=False),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Offices and their branches, for LABELS. No personnel, no counts.

    Deliberately readable by every authenticated account, including a read-only
    viewer: an approved record names an office and a branch, and a client that
    cannot resolve those names renders codes at people (org model design §4.5,
    §8). Nothing here says who works where.
    """
    office_filter = "" if include_inactive else "WHERE o.is_active = 1"
    offices = db.execute(
        text(
            f"""
            SELECT o.id, o.code, o.org_type, o.unit_number, o.name, o.short_name,
                   o.home_city, o.home_district, o.home_location_label,
                   o.is_routing_target, o.is_active, o.sort_order
              FROM org_offices o
              {office_filter}
             ORDER BY o.sort_order ASC, o.code ASC
            """
        )
    ).mappings().all()
    office_ids = [int(row["id"]) for row in offices]
    districts = _office_districts(db, office_ids)
    branches_by_office: dict[int, list[dict]] = {}
    if office_ids:
        params = {f"oid_{index}": oid for index, oid in enumerate(office_ids)}
        tokens = ", ".join(f":oid_{index}" for index in range(len(office_ids)))
        branch_filter = "" if include_inactive else " AND b.is_active = 1"
        branch_rows = db.execute(
            text(
                f"""
                SELECT b.id, b.office_id, b.unit_type, b.letter, b.name, b.home_city,
                       b.home_district, b.accepts_assignments, b.is_active, b.sort_order
                  FROM org_branches b
                 WHERE b.office_id IN ({tokens}){branch_filter}
                 ORDER BY b.sort_order ASC, b.letter ASC, b.name ASC
                """
            ),
            params,
        ).mappings().all()
        for row in branch_rows:
            branches_by_office.setdefault(int(row["office_id"]), []).append(
                {
                    "id": int(row["id"]),
                    "unit_type": row["unit_type"],
                    "letter": row["letter"],
                    "name": row["name"],
                    "home_city": row["home_city"],
                    "home_district": row["home_district"],
                    "accepts_assignments": bool(row["accepts_assignments"]),
                    "is_active": bool(row["is_active"]),
                }
            )
    return {
        "offices": [
            _serialize_office(
                dict(row),
                districts=[d["district"] for d in districts.get(int(row["id"]), []) if d["is_active"]],
                branches=branches_by_office.get(int(row["id"]), []),
            )
            for row in offices
        ]
    }


@router.get("/org/districts/{district}/office")
def resolve_district_office(
    district: str = Path(..., max_length=8),
    db: Session = Depends(get_db),
    user=Depends(deny_public_only),
):
    """Which office serves this district, and WHERE THAT ANSWER CAME FROM.

    ``source`` is the point: ``routing_table`` means an admin-owned
    ``org_office_districts`` row answered, ``legacy_fallback`` means the hard-coded
    constant did — which is a misconfiguration to fix, not a normal answer
    (design §13.7).
    """
    resolved = org_directory.resolve_office_for_district(db, district)
    office = None
    if resolved.get("office_code"):
        office = {
            "id": resolved.get("office_id"),
            "code": resolved.get("office_code"),
            "name": resolved.get("office_name"),
            "short_name": resolved.get("office_short_name"),
        }
    return {"district": resolved.get("district"), "office": office, "source": resolved.get("source")}


@router.get("/admin/org/offices")
def admin_list_offices(
    include_inactive: bool = Query(default=False),
    org_type: str | None = Query(default=None),
    db: Session = Depends(get_db),
    _admin=Depends(require_roles(ADMIN_ONLY)),
):
    where: list[str] = []
    params: dict[str, Any] = {}
    if not include_inactive:
        where.append("o.is_active = 1")
    if org_type:
        where.append("o.org_type = :org_type")
        params["org_type"] = str(org_type).strip().upper()
    where_sql = f"WHERE {' AND '.join(where)}" if where else ""
    rows = db.execute(
        text(
            f"""
            SELECT o.id, o.code, o.org_type, o.unit_number, o.name, o.short_name,
                   o.home_city, o.home_district, o.home_location_label,
                   o.is_routing_target, o.is_active, o.sort_order,
                   (SELECT COUNT(*) FROM org_branches b
                     WHERE b.office_id = o.id AND b.is_active = 1) AS branch_count,
                   (SELECT COUNT(*) FROM org_user_profiles p
                     WHERE p.office_id = o.id) AS member_count
              FROM org_offices o
              {where_sql}
             ORDER BY o.sort_order ASC, o.code ASC
            """
        ),
        params,
    ).mappings().all()
    districts = _office_districts(db, [int(row["id"]) for row in rows])
    return {
        "items": [
            _serialize_office(
                dict(row),
                districts=districts.get(int(row["id"]), []),
                branch_count=row["branch_count"],
                member_count=row["member_count"],
            )
            for row in rows
        ]
    }


@router.post("/admin/org/offices", status_code=201)
def admin_create_office(
    body: OfficeCreateIn,
    db: Session = Depends(get_db),
    _admin=Depends(require_roles(ADMIN_ONLY)),
):
    code = normalize_office_code(body.code)
    if not code:
        raise HTTPException(status_code=422, detail="Office code is required")
    existing = db.execute(
        text("SELECT id FROM org_offices WHERE org_type = :org_type AND code = :code LIMIT 1"),
        {"org_type": body.org_type, "code": code},
    ).scalar()
    if existing:
        raise HTTPException(status_code=409, detail=f"An office with code {code} already exists")
    try:
        result = db.execute(
            text(
                """
                INSERT INTO org_offices
                  (code, org_type, unit_number, name, short_name, home_city, home_district,
                   home_location_label, is_routing_target, is_active, sort_order)
                VALUES
                  (:code, :org_type, :unit_number, :name, :short_name, :home_city, :home_district,
                   :home_location_label, :is_routing_target, 1, :sort_order)
                """
            ),
            {
                "code": code,
                "org_type": body.org_type,
                "unit_number": normalize_profile_text(body.unit_number),
                "name": normalize_profile_text(body.name),
                "short_name": normalize_profile_text(body.short_name),
                "home_city": normalize_profile_text(body.home_city),
                "home_district": normalize_district_code(body.home_district),
                "home_location_label": normalize_profile_text(body.home_location_label),
                "is_routing_target": 1 if body.is_routing_target else 0,
                "sort_order": int(body.sort_order),
            },
        )
        office_id = int(result.lastrowid)
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    return {"office": _serialize_office(_office_row(db, office_id) or {})}


@router.patch("/admin/org/offices/{office_id}")
def admin_patch_office(
    body: OfficePatchIn,
    office_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    _admin=Depends(require_roles(ADMIN_ONLY)),
):
    """Per-field merge. The office CODE is not editable, and says so.

    ``assessments.office_code`` and ``incidents.office_code`` join on the code as
    a string. Editing it would re-point or orphan every historical record that
    names it, silently — so the field is refused with an explanation rather than
    accepted or quietly dropped (design §3.8).
    """
    office = _office_row(db, office_id)
    if not office:
        raise HTTPException(status_code=404, detail="Office not found")
    provided = body.model_dump(exclude_unset=True)
    if "code" in provided:
        raise HTTPException(
            status_code=422,
            detail=(
                "Office code is immutable: assessments and incidents join on it, "
                "so changing it would rewrite history. Create a new office and "
                "deactivate this one instead."
            ),
        )

    fields: dict[str, Any] = {}
    if "unit_number" in provided:
        fields["unit_number"] = normalize_profile_text(body.unit_number)
    if "name" in provided:
        fields["name"] = normalize_profile_text(body.name)
    if "short_name" in provided:
        fields["short_name"] = normalize_profile_text(body.short_name)
    if "home_city" in provided:
        fields["home_city"] = normalize_profile_text(body.home_city)
    if "home_district" in provided:
        fields["home_district"] = normalize_district_code(body.home_district)
    if "home_location_label" in provided:
        fields["home_location_label"] = normalize_profile_text(body.home_location_label)
    if "is_routing_target" in provided:
        fields["is_routing_target"] = 1 if body.is_routing_target else 0
    if "is_active" in provided:
        fields["is_active"] = 1 if body.is_active else 0
    if "sort_order" in provided:
        fields["sort_order"] = int(body.sort_order or 0)
    if not fields:
        return {"office": _serialize_office(office)}

    sets = ", ".join(f"{key} = :{key}" for key in fields)
    fields["oid"] = int(office_id)
    try:
        db.execute(text(f"UPDATE org_offices SET {sets}, updated_at = NOW() WHERE id = :oid"), fields)
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    return {"office": _serialize_office(_office_row(db, office_id) or {})}


@router.post("/admin/org/offices/{office_id}/deactivate")
def admin_deactivate_office(
    body: OfficeDeactivateIn | None = None,
    office_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    _admin=Depends(require_roles(ADMIN_ONLY)),
):
    """Retire an office. Never a delete, and never a revocation.

    ``affected_assessments`` is 0 BY CONSTRUCTION: every assessment froze its
    office name at routing time, and ``resolve_user_org`` resolves an office
    regardless of ``is_active``. Deactivating means "not offered in any picker,
    not returned by district resolution" and nothing else — an office chief with
    open work keeps their review authority (design §3.8).
    """
    office = _office_row(db, office_id)
    if not office:
        raise HTTPException(status_code=404, detail="Office not found")
    try:
        db.execute(
            text("UPDATE org_offices SET is_active = 0, updated_at = NOW() WHERE id = :oid"),
            {"oid": int(office_id)},
        )
        # District rows follow the office: a retired office must stop receiving
        # new work. The legacy mirror follows too, for one release.
        rows = db.execute(
            text("SELECT district FROM org_office_districts WHERE office_id = :oid AND is_active = 1"),
            {"oid": int(office_id)},
        ).scalars().all()
        db.execute(
            text("UPDATE org_office_districts SET is_active = 0, updated_at = NOW() WHERE office_id = :oid"),
            {"oid": int(office_id)},
        )
        if str(office.get("org_type") or "") == org_directory.GEOTECH:
            for district in rows:
                org_directory.mirror_geotech_office_routing(
                    db, district=str(district), office_code=None, is_active=False
                )
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    return {"office": _serialize_office(_office_row(db, office_id) or {}), "affected_assessments": 0}


@router.put("/admin/org/offices/{office_id}/districts")
def admin_replace_office_districts(
    body: OfficeDistrictsIn,
    office_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    _admin=Depends(require_roles(ADMIN_ONLY)),
):
    """Replace the districts an office serves.

    409 — naming the other office — when a district is already served by another
    ACTIVE office OF THE SAME TYPE. The database would refuse it anyway through
    the generated unique key, but "Duplicate entry 'GEOTECH:05'" is not an answer
    an admin can act on. A MAINTENANCE office covering district 04 while WEST
    covers it is legal, which is why the check is scoped to ``org_type``.
    """
    office = _office_row(db, office_id)
    if not office:
        raise HTTPException(status_code=404, detail="Office not found")
    org_type = str(office["org_type"])
    wanted = _normalized_districts(body.districts)
    primary = normalize_district_code(body.primary_district)

    if wanted:
        params = {f"d_{index}": district for index, district in enumerate(wanted)}
        tokens = ", ".join(f":d_{index}" for index in range(len(wanted)))
        params.update({"oid": int(office_id), "org_type": org_type})
        conflict = db.execute(
            text(
                f"""
                SELECT d.district, o.id AS office_id, o.code, o.name
                  FROM org_office_districts d
                  JOIN org_offices o ON o.id = d.office_id
                 WHERE d.district IN ({tokens})
                   AND d.is_active = 1
                   AND d.org_type = :org_type
                   AND d.office_id <> :oid
                 ORDER BY d.district ASC
                 LIMIT 1
                """
            ),
            params,
        ).mappings().first()
        if conflict:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"District {str(conflict['district']).strip()} is already served by "
                    f"{conflict['name'] or conflict['code']}"
                ),
            )

    try:
        # Deactivate first, insert second: a district moving WITHIN this office's
        # set would otherwise collide with its own active generated key.
        previous = db.execute(
            text("SELECT district FROM org_office_districts WHERE office_id = :oid AND is_active = 1"),
            {"oid": int(office_id)},
        ).scalars().all()
        db.execute(
            text("UPDATE org_office_districts SET is_active = 0, updated_at = NOW() WHERE office_id = :oid"),
            {"oid": int(office_id)},
        )
        for district in wanted:
            db.execute(
                text(
                    """
                    INSERT INTO org_office_districts (office_id, org_type, district, is_primary, is_active)
                    VALUES (:oid, :org_type, :district, :is_primary, 1)
                    ON DUPLICATE KEY UPDATE
                      is_active = 1,
                      is_primary = VALUES(is_primary),
                      org_type = VALUES(org_type),
                      updated_at = NOW()
                    """
                ),
                {
                    "oid": int(office_id),
                    "org_type": org_type,
                    "district": district,
                    "is_primary": 1 if (primary is None or primary == district) else 0,
                },
            )
        if org_type == org_directory.GEOTECH:
            # services/org_directory is the ONLY writer of the legacy routing
            # table, and this is the call that keeps it true for one more
            # release (design §13.6).
            for district in wanted:
                org_directory.mirror_geotech_office_routing(
                    db,
                    district=district,
                    office_code=str(office["code"]),
                    office_name=office.get("name"),
                    is_active=True,
                )
            for district in previous:
                if str(district).strip() not in wanted:
                    org_directory.mirror_geotech_office_routing(
                        db, district=str(district), office_code=None, is_active=False
                    )
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    return {"districts": _office_districts(db, [int(office_id)]).get(int(office_id), [])}


# ---------------------------------------------------------------------------
# Branches
# ---------------------------------------------------------------------------


@router.get("/admin/org/branches")
def admin_list_branches(
    office_id: int | None = Query(default=None, ge=1),
    include_inactive: bool = Query(default=False),
    db: Session = Depends(get_db),
    _admin=Depends(require_roles(ADMIN_ONLY)),
):
    where: list[str] = []
    params: dict[str, Any] = {}
    if office_id is not None:
        where.append("b.office_id = :office_id")
        params["office_id"] = int(office_id)
    if not include_inactive:
        where.append("b.is_active = 1")
    where_sql = f"WHERE {' AND '.join(where)}" if where else ""
    rows = db.execute(
        text(
            f"""
            SELECT b.id, b.office_id, b.parent_branch_id, b.unit_type, b.letter, b.name,
                   b.home_city, b.home_district, b.home_location_label, b.chief_user_id,
                   b.accepts_assignments, b.is_active, b.sort_order,
                   o.code AS office_code,
                   (SELECT COUNT(*) FROM org_user_profiles p WHERE p.branch_id = b.id) AS member_count
              FROM org_branches b
              JOIN org_offices o ON o.id = b.office_id
              {where_sql}
             ORDER BY o.sort_order ASC, b.sort_order ASC, b.letter ASC, b.name ASC
            """
        ),
        params,
    ).mappings().all()
    districts = _branch_districts(db, [int(row["id"]) for row in rows])
    return {
        "items": [
            _serialize_branch(
                dict(row),
                districts=districts.get(int(row["id"]), []),
                chief=_user_brief(db, row["chief_user_id"]),
                member_count=row["member_count"],
            )
            for row in rows
        ]
    }


@router.post("/admin/org/branches", status_code=201)
def admin_create_branch(
    body: BranchCreateIn,
    db: Session = Depends(get_db),
    _admin=Depends(require_roles(ADMIN_ONLY)),
):
    office = _office_row(db, body.office_id)
    if not office:
        raise HTTPException(status_code=404, detail="Office not found")
    letter = (normalize_profile_text(body.letter) or "").upper() or None
    if letter:
        clash = db.execute(
            text(
                """
                SELECT id FROM org_branches
                 WHERE office_id = :oid AND letter = :letter AND is_active = 1
                 LIMIT 1
                """
            ),
            {"oid": int(body.office_id), "letter": letter},
        ).scalar()
        if clash:
            raise HTTPException(
                status_code=409,
                detail=f"Branch {letter} already exists in this office",
            )
    try:
        result = db.execute(
            text(
                """
                INSERT INTO org_branches
                  (office_id, parent_branch_id, unit_type, letter, name, home_city, home_district,
                   home_location_label, chief_user_id, accepts_assignments, is_active, sort_order)
                VALUES
                  (:office_id, :parent_branch_id, :unit_type, :letter, :name, :home_city, :home_district,
                   :home_location_label, :chief_user_id, :accepts_assignments, 1, :sort_order)
                """
            ),
            {
                "office_id": int(body.office_id),
                "parent_branch_id": body.parent_branch_id,
                "unit_type": body.unit_type,
                "letter": letter,
                "name": normalize_profile_text(body.name),
                "home_city": normalize_profile_text(body.home_city),
                "home_district": normalize_district_code(body.home_district),
                "home_location_label": normalize_profile_text(body.home_location_label),
                "chief_user_id": body.chief_user_id,
                "accepts_assignments": 1 if body.accepts_assignments else 0,
                "sort_order": int(body.sort_order),
            },
        )
        branch_id = int(result.lastrowid)
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    row = _branch_row(db, branch_id) or {}
    return {"branch": _serialize_branch(row, chief=_user_brief(db, row.get("chief_user_id")))}


@router.patch("/admin/org/branches/{branch_id}")
def admin_patch_branch(
    body: BranchPatchIn,
    branch_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    _admin=Depends(require_roles(ADMIN_ONLY)),
):
    """Per-field merge; deactivation is one of the fields.

    A deactivated branch disappears from every picker and changes NO history:
    assessments routed through it keep the branch name they froze (design §3.5).
    """
    branch = _branch_row(db, branch_id)
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")
    provided = body.model_dump(exclude_unset=True)
    fields: dict[str, Any] = {}
    if "letter" in provided:
        fields["letter"] = (normalize_profile_text(body.letter) or "").upper() or None
    if "name" in provided:
        fields["name"] = normalize_profile_text(body.name)
    if "parent_branch_id" in provided:
        fields["parent_branch_id"] = body.parent_branch_id
    if "home_city" in provided:
        fields["home_city"] = normalize_profile_text(body.home_city)
    if "home_district" in provided:
        fields["home_district"] = normalize_district_code(body.home_district)
    if "home_location_label" in provided:
        fields["home_location_label"] = normalize_profile_text(body.home_location_label)
    if "chief_user_id" in provided:
        fields["chief_user_id"] = body.chief_user_id
    if "accepts_assignments" in provided:
        fields["accepts_assignments"] = 1 if body.accepts_assignments else 0
    if "is_active" in provided:
        fields["is_active"] = 1 if body.is_active else 0
    if "sort_order" in provided:
        fields["sort_order"] = int(body.sort_order or 0)
    if not fields:
        return {"branch": _serialize_branch(branch, chief=_user_brief(db, branch.get("chief_user_id")))}

    letter = fields.get("letter", branch.get("letter"))
    is_active = fields.get("is_active", 1 if branch.get("is_active") else 0)
    if letter and int(is_active) == 1:
        clash = db.execute(
            text(
                """
                SELECT id FROM org_branches
                 WHERE office_id = :oid AND letter = :letter AND is_active = 1 AND id <> :bid
                 LIMIT 1
                """
            ),
            {"oid": int(branch["office_id"]), "letter": letter, "bid": int(branch_id)},
        ).scalar()
        if clash:
            raise HTTPException(status_code=409, detail=f"Branch {letter} already exists in this office")

    sets = ", ".join(f"{key} = :{key}" for key in fields)
    fields["bid"] = int(branch_id)
    try:
        db.execute(text(f"UPDATE org_branches SET {sets}, updated_at = NOW() WHERE id = :bid"), fields)
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    row = _branch_row(db, branch_id) or {}
    return {"branch": _serialize_branch(row, chief=_user_brief(db, row.get("chief_user_id")))}


@router.put("/admin/org/branches/{branch_id}/districts")
def admin_replace_branch_districts(
    body: BranchDistrictsIn,
    branch_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    _admin=Depends(require_roles(ADMIN_ONLY)),
):
    """Replace the districts a branch covers, each row carrying its provenance.

    ``source`` exists because NO chart states branch-to-district coverage for any
    office. Every row here was somebody's judgement, and ``INFERRED`` has to stay
    distinguishable from ``CHART`` or the guess becomes a fact (design §10, open
    question 1). Unlike office coverage there is no uniqueness rule: two branches
    may both work in district 04.
    """
    branch = _branch_row(db, branch_id)
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")
    wanted = _normalized_districts(body.districts)
    try:
        db.execute(
            text("UPDATE org_branch_districts SET is_active = 0, updated_at = NOW() WHERE branch_id = :bid"),
            {"bid": int(branch_id)},
        )
        for district in wanted:
            db.execute(
                text(
                    """
                    INSERT INTO org_branch_districts (branch_id, district, source, notes, is_active)
                    VALUES (:bid, :district, :source, :notes, 1)
                    ON DUPLICATE KEY UPDATE
                      is_active = 1,
                      source = VALUES(source),
                      notes = VALUES(notes),
                      updated_at = NOW()
                    """
                ),
                {
                    "bid": int(branch_id),
                    "district": district,
                    "source": body.source,
                    "notes": normalize_profile_text(body.notes),
                },
            )
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    return {"districts": _branch_districts(db, [int(branch_id)]).get(int(branch_id), [])}


# ---------------------------------------------------------------------------
# Classification rules
# ---------------------------------------------------------------------------


@router.get("/admin/org/classifications")
def admin_list_classifications(
    include_inactive: bool = Query(default=True),
    db: Session = Depends(get_db),
    _admin=Depends(require_roles(ADMIN_ONLY)),
):
    """The derivation table as data: fourteen CLASS rows and two PATTERN rules."""
    return {"items": org_directory.classification_rules(db, include_inactive=include_inactive)}


@router.put("/admin/org/classifications/{classification_id}")
def admin_update_classification(
    body: ClassificationPutIn,
    classification_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    _admin=Depends(require_roles(ADMIN_ONLY)),
):
    """Edit one rule, addressed BY ID.

    By id and not by class code, because a rule may be a PATTERN row with no
    class code at all; the natural key is the five-part
    ``(rule_kind, class_code, marker, title_pattern, level_code)`` tuple and it
    is not something a UI should have to reassemble (design §7).
    """
    existing = db.execute(
        text("SELECT id FROM org_classifications WHERE id = :cid LIMIT 1"),
        {"cid": int(classification_id)},
    ).scalar()
    if not existing:
        raise HTTPException(status_code=404, detail="Classification rule not found")
    provided = body.model_dump(exclude_unset=True)
    fields: dict[str, Any] = {}
    if "title" in provided:
        fields["title"] = normalize_profile_text(body.title)
    if "level_code" in provided:
        fields["level_code"] = (normalize_profile_text(body.level_code) or "").upper()
    if "eris_role" in provided:
        # NULL is a legitimate value: "no suggestion" is different from "no role".
        fields["eris_role"] = (normalize_profile_text(body.eris_role) or None)
    if "is_supervisor" in provided:
        fields["is_supervisor"] = 1 if body.is_supervisor else 0
    if "is_active" in provided:
        fields["is_active"] = 1 if body.is_active else 0
    if "notes" in provided:
        fields["notes"] = normalize_profile_text(body.notes)
    if not fields:
        rules = [r for r in org_directory.classification_rules(db, include_inactive=True)
                 if int(r["id"]) == int(classification_id)]
        return {"classification": rules[0] if rules else None}
    sets = ", ".join(f"{key} = :{key}" for key in fields)
    fields["cid"] = int(classification_id)
    try:
        db.execute(text(f"UPDATE org_classifications SET {sets}, updated_at = NOW() WHERE id = :cid"), fields)
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    rules = [r for r in org_directory.classification_rules(db, include_inactive=True)
             if int(r["id"]) == int(classification_id)]
    return {"classification": rules[0] if rules else None}


# ---------------------------------------------------------------------------
# Coordinator coverage
# ---------------------------------------------------------------------------


@router.get("/admin/org/coverage")
def admin_list_coverage(
    district: str | None = Query(default=None, max_length=8),
    db: Session = Depends(get_db),
    _admin=Depends(require_roles(ADMIN_ONLY)),
):
    """Who covers each district — and which districts nobody covers.

    ``uncovered_districts`` is the point of the endpoint: a district with no
    active coordinator silently drops every notification for the incidents
    reported in it, and that is invisible until somebody asks why nobody was
    told (design §3.6).
    """
    params: dict[str, Any] = {}
    where = "WHERE c.is_active = 1"
    wanted = normalize_district_code(district) if district else None
    if wanted:
        where += " AND c.district = :district"
        params["district"] = wanted
    rows = db.execute(
        text(
            f"""
            SELECT c.id, c.district, c.user_id, c.is_primary, u.email, u.full_name, u.is_active AS user_is_active
              FROM org_coordinator_coverage c
              JOIN users u ON u.id = c.user_id
              {where}
             ORDER BY c.district ASC, c.is_primary DESC, u.full_name ASC
            """
        ),
        params,
    ).mappings().all()
    by_district: dict[str, list[dict]] = {}
    for row in rows:
        by_district.setdefault(str(row["district"]).strip(), []).append(
            {
                "coverage_id": int(row["id"]),
                "id": int(row["user_id"]),
                "email": row["email"],
                "full_name": row["full_name"],
                "is_primary": bool(row["is_primary"]),
                "user_is_active": bool(row["user_is_active"]),
            }
        )
    covered = set(by_district)
    served = db.execute(
        text(
            """
            SELECT DISTINCT district FROM org_office_districts
             WHERE is_active = 1 AND org_type = :org_type
             ORDER BY district ASC
            """
        ),
        {"org_type": org_directory.GEOTECH},
    ).scalars().all()
    all_districts = sorted({str(d).strip() for d in served} | set(org_directory.LEGACY_OFFICE_BY_DISTRICT))
    return {
        "items": [{"district": key, "users": by_district[key]} for key in sorted(by_district)],
        "uncovered_districts": [d for d in all_districts if d not in covered],
    }


@router.post("/admin/org/coverage", status_code=201)
def admin_create_coverage(
    body: CoverageCreateIn,
    db: Session = Depends(get_db),
    _admin=Depends(require_roles(ADMIN_ONLY)),
):
    district = normalize_district_code(body.district)
    if not district:
        raise HTTPException(status_code=422, detail="A district is required")
    user_row = db.execute(
        text("SELECT id FROM users WHERE id = :uid LIMIT 1"), {"uid": int(body.user_id)}
    ).scalar()
    if not user_row:
        raise HTTPException(status_code=404, detail="User not found")
    try:
        db.execute(
            text(
                """
                INSERT INTO org_coordinator_coverage (district, user_id, is_primary, is_active)
                VALUES (:district, :user_id, :is_primary, 1)
                ON DUPLICATE KEY UPDATE
                  is_primary = VALUES(is_primary),
                  is_active = 1,
                  updated_at = NOW()
                """
            ),
            {"district": district, "user_id": int(body.user_id), "is_primary": 1 if body.is_primary else 0},
        )
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    row = db.execute(
        text(
            """
            SELECT id, district, user_id, is_primary, is_active
              FROM org_coordinator_coverage
             WHERE district = :district AND user_id = :user_id
             LIMIT 1
            """
        ),
        {"district": district, "user_id": int(body.user_id)},
    ).mappings().first()
    return {
        "coverage": {
            "id": int(row["id"]),
            "district": str(row["district"]).strip(),
            "user_id": int(row["user_id"]),
            "is_primary": bool(row["is_primary"]),
            "is_active": bool(row["is_active"]),
        }
    }


@router.delete("/admin/org/coverage/{coverage_id}", status_code=204)
def admin_delete_coverage(
    coverage_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    _admin=Depends(require_roles(ADMIN_ONLY)),
):
    """Deactivate a coverage row. The row stays: it is who was told, and when."""
    existing = db.execute(
        text("SELECT id FROM org_coordinator_coverage WHERE id = :cid LIMIT 1"),
        {"cid": int(coverage_id)},
    ).scalar()
    if not existing:
        raise HTTPException(status_code=404, detail="Coverage not found")
    try:
        db.execute(
            text("UPDATE org_coordinator_coverage SET is_active = 0, updated_at = NOW() WHERE id = :cid"),
            {"cid": int(coverage_id)},
        )
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# One person's place in the organization
# ---------------------------------------------------------------------------


def _role_suggestion(db: Session, user_id: int, org: dict) -> dict | None:
    """What the stored rules SUGGEST for this classification, and whether it is held.

    ``matches_granted`` is the whole point of returning it: the admin UI renders
    "Classification 3161 (Sup) suggests Branch Chief — this account holds Staff"
    and the human decides. Nothing here writes ``user_roles``.
    """
    suggestion = org_directory.suggest_role_for_classification(
        db,
        class_code=org.get("classification_code"),
        marker=org.get("classification_marker"),
        title=org.get("job_title"),
        level_code=org.get("level_code"),
    )
    if not suggestion:
        return None
    granted = set(
        db.execute(
            text(
                """
                SELECT r.name FROM user_roles ur
                  JOIN roles r ON r.id = ur.role_id
                 WHERE ur.user_id = :uid
                """
            ),
            {"uid": int(user_id)},
        ).scalars().all()
    )
    suggested = suggestion.get("suggested_role")
    accepted = ROLE_ALIASES.get(suggested, {suggested} if suggested else set())
    suggestion["matches_granted"] = bool(suggested) and bool(granted & accepted)
    suggestion["granted_roles"] = sorted(granted)
    return suggestion


def _user_org_payload(db: Session, user_id: int) -> dict:
    org = org_directory.resolve_user_org(db, int(user_id), use_cache=False)
    return {
        "user_id": int(user_id),
        "org": {
            "office_id": org.get("office_id"),
            "office_code": org.get("office_code"),
            "office_name": org.get("office_name"),
            "branch_id": org.get("branch_id"),
            "branch_letter": org.get("branch_letter"),
            "branch_name": org.get("branch_name"),
            "home_city": org.get("home_city"),
            "home_district": org.get("home_district"),
            "classification_code": org.get("classification_code"),
            "classification_marker": org.get("classification_marker"),
            "position_number": org.get("position_number"),
            "job_title": org.get("job_title"),
            "level_code": org.get("level_code"),
            "supervisor_user_id": org.get("supervisor_user_id"),
            "availability": org.get("availability"),
            "available_from": org.get("available_from"),
            "available_until": org.get("available_until"),
            "source": org.get("source"),
            "has_profile": org.get("has_profile"),
        },
        "role_suggestion": _role_suggestion(db, int(user_id), org),
    }


@router.get("/admin/users/{user_id}/org")
def admin_get_user_org(
    user_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    _admin=Depends(require_roles(ADMIN_ONLY)),
):
    exists = db.execute(text("SELECT id FROM users WHERE id = :uid LIMIT 1"), {"uid": int(user_id)}).scalar()
    if not exists:
        raise HTTPException(status_code=404, detail="User not found")
    return _user_org_payload(db, int(user_id))


@router.put("/admin/users/{user_id}/org")
def admin_put_user_org(
    body: UserOrgPutIn,
    user_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    _admin=Depends(require_roles(ADMIN_ONLY)),
):
    """Where this person sits, as a PER-FIELD MERGE. Grants nothing.

    Omitted fields are untouched — an admin editing a branch must not silently
    clear a classification somebody else recorded. The write goes to
    ``org_user_profiles`` and then re-renders the ``users.metadata_json`` mirror
    in the SAME transaction, because for one release both are read: a chief whose
    profile moved but whose mirror did not would lose their review queue
    (design §3.2, §13.3).

    ``user_roles`` is NEVER written here. The response carries a
    ``role_suggestion`` for the admin to act on, or not.
    """
    exists = db.execute(text("SELECT id FROM users WHERE id = :uid LIMIT 1"), {"uid": int(user_id)}).scalar()
    if not exists:
        raise HTTPException(status_code=404, detail="User not found")
    provided = body.model_dump(exclude_unset=True)

    if body.office_id is not None and "office_id" in provided:
        if not _office_row(db, body.office_id):
            raise HTTPException(status_code=422, detail="Office not found")
    branch = None
    if body.branch_id is not None and "branch_id" in provided:
        branch = _branch_row(db, body.branch_id)
        if not branch:
            raise HTTPException(status_code=422, detail="Branch not found")

    # A branch belongs to exactly one office; a profile naming both must agree,
    # or the pickers and the review-authority check would disagree about where
    # this person is.
    if branch is not None:
        office_id = body.office_id if "office_id" in provided else None
        if office_id is None:
            current = org_directory.resolve_user_org(db, int(user_id), use_cache=False)
            office_id = current.get("office_id")
        if office_id is not None and int(branch["office_id"]) != int(office_id):
            raise HTTPException(
                status_code=422,
                detail="That branch belongs to a different office",
            )

    fields: dict[str, Any] = {}
    if "office_id" in provided:
        fields["office_id"] = body.office_id
    if "branch_id" in provided:
        fields["branch_id"] = body.branch_id
    if "home_city" in provided:
        fields["home_city"] = normalize_profile_text(body.home_city)
    if "home_district" in provided:
        fields["home_district"] = normalize_district_code(body.home_district)
    if "classification_code" in provided:
        fields["classification_code"] = normalize_profile_text(body.classification_code)
    if "classification_marker" in provided:
        fields["classification_marker"] = org_directory.normalize_classification_marker(body.classification_marker)
    if "position_number" in provided:
        fields["position_number"] = normalize_profile_text(body.position_number)
    if "job_title" in provided:
        fields["job_title"] = normalize_profile_text(body.job_title)
    if "level_code" in provided:
        fields["level_code"] = (normalize_profile_text(body.level_code) or "").upper() or None
    if "supervisor_user_id" in provided:
        fields["supervisor_user_id"] = body.supervisor_user_id
    if "availability" in provided:
        fields["availability"] = body.availability or "AVAILABLE"
    if "available_from" in provided:
        fields["available_from"] = body.available_from
    if "available_until" in provided:
        fields["available_until"] = body.available_until
    if "notes" in provided:
        fields["notes"] = normalize_profile_text(body.notes)

    try:
        # An UPSERT, because a user created before the org model may have no
        # profile row at all and an admin editing them must not 404.
        columns = ["user_id", "source"] + list(fields)
        placeholders = ", ".join(f":{column}" for column in columns)
        updates = ", ".join(f"{column} = VALUES({column})" for column in fields) or "user_id = VALUES(user_id)"
        params = {"user_id": int(user_id), "source": "MANUAL", **fields}
        db.execute(
            text(
                f"""
                INSERT INTO org_user_profiles ({", ".join(columns)})
                VALUES ({placeholders})
                ON DUPLICATE KEY UPDATE {updates}, source = 'MANUAL', updated_at = NOW()
                """
            ),
            params,
        )
        org_directory.mirror_metadata_from_profile(db, int(user_id))
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    return _user_org_payload(db, int(user_id))

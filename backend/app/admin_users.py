from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status, Path, Query
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .deps import require_roles
from .auth import hash_password
from .roles import (
    ADMIN,
    GEOTECH_BRANCH_CHIEF,
    GEOTECH_ENGINEER,
    GEOTECH_OFFICE_CHIEF,
    GEOTECH_SENIOR_SPECIALIST,
    OPERATIONAL_ROLES,
    expand_roles,
)
from .user_metadata import normalize_office_code, parse_user_metadata, user_metadata_json

router = APIRouter(prefix="/admin", tags=["admin"])

ASSESSMENT_ASSIGNMENT_DIRECTORY_ROLES = expand_roles(GEOTECH_OFFICE_CHIEF, GEOTECH_BRANCH_CHIEF) + [ADMIN]


# -----------------------------
# Pydantic models
# -----------------------------
class UserMetadataIn(BaseModel):
    district: str | None = Field(default=None, max_length=64)
    office_code: str | None = Field(default=None, max_length=32)
    office_location: str | None = Field(default=None, max_length=255)


class CreateUserIn(BaseModel):
    email: str
    full_name: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=8, max_length=200)
    roles: List[str] = Field(default_factory=list)
    metadata: UserMetadataIn | None = None


class UpdateUserIn(BaseModel):
    full_name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    is_active: Optional[bool] = None
    metadata: UserMetadataIn | None = None


class SetRolesIn(BaseModel):
    roles: List[str] = Field(default_factory=list)


class ResetPasswordIn(BaseModel):
    password: str = Field(min_length=8, max_length=200)


# -----------------------------
# Helpers
# -----------------------------
def _get_all_roles(db: Session) -> list[str]:
    return db.execute(text("SELECT name FROM roles ORDER BY name")).scalars().all()


def _ensure_roles_exist(db: Session, roles: list[str]) -> None:
    if not roles:
        return
    existing = set(_get_all_roles(db))
    missing = [r for r in roles if r not in existing]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown role(s): {missing}",
        )


def _get_user_row(db: Session, user_id: int):
    u = db.execute(
        text(
            """
            SELECT id, email, full_name, is_active, metadata_json
            FROM users
            WHERE id = :id
            """
        ),
        {"id": user_id},
    ).mappings().first()
    return u


def _get_user_roles(db: Session, user_id: int) -> list[str]:
    return db.execute(
        text(
            """
            SELECT r.name
            FROM user_roles ur
            JOIN roles r ON r.id = ur.role_id
            WHERE ur.user_id = :id
            ORDER BY r.name
            """
        ),
        {"id": user_id},
    ).scalars().all()


def _user_with_roles(db: Session, user_id: int) -> dict:
    u = _get_user_row(db, user_id)
    if not u:
        raise HTTPException(status_code=404, detail="User not found")

    roles = _get_user_roles(db, user_id)
    return {
        "id": int(u["id"]),
        "email": u["email"],
        "full_name": u["full_name"],
        "is_active": bool(int(u["is_active"])),
        "metadata": parse_user_metadata(u.get("metadata_json")),
        "roles": list(roles),
    }


def _set_roles(db: Session, user_id: int, roles: list[str]) -> None:
    _ensure_roles_exist(db, roles)

    # Remove old roles
    db.execute(text("DELETE FROM user_roles WHERE user_id = :id"), {"id": user_id})

    if not roles:
        return

    # Insert new roles
    db.execute(
        text(
            """
            INSERT INTO user_roles (user_id, role_id)
            SELECT :uid, r.id
            FROM roles r
            WHERE r.name IN :names
            """
        ),
        {"uid": user_id, "names": tuple(roles)},
    )


def _role_predicate_params(roles: list[str] | set[str]) -> tuple[str, dict[str, str]]:
    ordered = sorted({str(role) for role in roles})
    params = {f"role_{index}": role for index, role in enumerate(ordered)}
    placeholders = ", ".join(f":role_{index}" for index in range(len(ordered)))
    return placeholders, params


# -----------------------------
# Assessment assignment directory
# -----------------------------
@router.get("/assessment-assignment-options/{assessment_id}")
def assessment_assignment_options(
    assessment_id: int = Path(..., ge=1),
    # REVIEWER stays IN the pattern on purpose: routing v2 retired the kind, and
    # the handler below answers with an explanatory 400. Dropping it from the
    # pattern would make FastAPI return a bare 422 before the handler runs and
    # the explanation would be unreachable.
    kind: str = Query(..., pattern="^(ENGINEER|SENIOR_SPECIALIST|CONSULTED|REVIEWER)$"),
    db: Session = Depends(get_db),
    user=Depends(require_roles(ASSESSMENT_ASSIGNMENT_DIRECTORY_ROLES)),
):
    """Return active identities eligible for assessment assignment UI.

    This exposes only names and routing metadata. Existing assessment write
    endpoints remain authoritative for every assignment action.
    """
    if kind == "REVIEWER":
        raise HTTPException(status_code=400, detail="kind=REVIEWER was retired; use CONSULTED")

    assessment = db.execute(
        text("SELECT id, office_code FROM assessments WHERE id = :aid LIMIT 1"),
        {"aid": assessment_id},
    ).mappings().first()
    if not assessment:
        raise HTTPException(status_code=404, detail="Assessment not found")

    assessment_office = normalize_office_code(assessment.get("office_code"))
    user_roles = set(user.get("roles") or [])
    if ADMIN not in user_roles:
        user_office = normalize_office_code((user.get("metadata") or {}).get("office_code"))
        if not user_office or (assessment_office and user_office != assessment_office):
            raise HTTPException(status_code=403, detail="Assessment is outside your assigned office")

    if kind == "ENGINEER":
        eligible_roles = set(expand_roles(GEOTECH_ENGINEER)) | {ADMIN}
    elif kind == "SENIOR_SPECIALIST":
        eligible_roles = set(expand_roles(GEOTECH_SENIOR_SPECIALIST)) | {ADMIN}
    else:
        # CONSULTED reproduces the previous REVIEWER behaviour: any operational
        # user may be attached for information. CONSULTED never conferred
        # authority, which is why it is the only writable assignment role left.
        eligible_roles = set(OPERATIONAL_ROLES)

    role_placeholders, params = _role_predicate_params(eligible_roles)
    params["office_code"] = assessment_office or ""

    office_filter = ""
    if kind == "ENGINEER" and assessment_office:
        office_filter = """
          AND (
            COALESCE(JSON_UNQUOTE(JSON_EXTRACT(u.metadata_json, '$.office_code')), '') = :office_code
            OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(u.metadata_json, '$.office_code')), '') = ''
          )
        """
    elif kind == "SENIOR_SPECIALIST":
        # STRICT office filter, unlike the ENGINEER kind above: a specialist with
        # no office_code is not assignable at all, and an assessment with no
        # office_code has no specialist to offer — hence the `:office_code <> ''`
        # guard rather than a blank-office fallback. ADMIN is exempt so the
        # picker keeps its admin escape hatch, matching the ENGINEER kind's
        # `| {ADMIN}` union.
        office_filter = """
          AND (
            (
              :office_code <> ''
              AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(u.metadata_json, '$.office_code')), '') = :office_code
            )
            OR r.name = 'ADMIN'
          )
        """

    rows = db.execute(
        text(
            f"""
            SELECT DISTINCT u.id, u.email, u.full_name, u.metadata_json
            FROM users u
            JOIN user_roles ur ON ur.user_id = u.id
            JOIN roles r ON r.id = ur.role_id
            WHERE u.is_active = 1
              AND r.name IN ({role_placeholders})
              {office_filter}
            ORDER BY
              CASE
                WHEN COALESCE(JSON_UNQUOTE(JSON_EXTRACT(u.metadata_json, '$.office_code')), '') = :office_code
                THEN 0 ELSE 1
              END,
              u.full_name ASC,
              u.id ASC
            """
        ),
        params,
    ).mappings().all()

    items = []
    for row in rows:
        uid = int(row["id"])
        items.append(
            {
                "id": uid,
                "email": row["email"],
                "full_name": row["full_name"],
                "metadata": parse_user_metadata(row.get("metadata_json")),
                "roles": _get_user_roles(db, uid),
            }
        )

    return {
        "assessment_id": assessment_id,
        "kind": kind,
        "office_code": assessment_office,
        "items": items,
    }


# -----------------------------
# Routes (ADMIN-only)
# -----------------------------
@router.get("/notifications/undelivered")
def undelivered_notifications(
    limit: int = Query(default=200, ge=1, le=1000),
    db: Session = Depends(get_db),
    _admin=Depends(require_roles(["ADMIN"])),
):
    """The EMAIL outbox backlog — every notice that was due and never sent.

    Email delivery is best-effort by design (design §6.3): the row is written in
    the approval transaction and the relay is talked to afterwards, so a relay
    that is down, a `From` domain that is refused, or a recipient with no mailbox
    produces silence rather than an error anybody sees. This endpoint is that
    silence made visible, and it is the rollout's acceptance signal for owner
    decision 6: it should be empty once SMTP is enabled.

    ``IN_APP`` rows are excluded: nothing delivers them, so they would be
    permanently "undelivered" and would bury the rows that matter.
    ``is_exhausted`` marks a row past ``SMTP_MAX_ATTEMPTS`` — no sweeper will try
    it again, so it needs a person (design §6.6).
    """
    rows = db.execute(
        text(
            """
            SELECT id, incident_id, recipient_user_id, channel, template_code,
                   created_at, delivery_attempts, last_error, last_attempt_at
            FROM incident_notifications
            WHERE channel = 'EMAIL' AND delivered_at IS NULL
            ORDER BY id DESC
            LIMIT :limit
            """
        ),
        {"limit": int(limit)},
    ).mappings().all()
    total = db.execute(
        text(
            """
            SELECT COUNT(*)
            FROM incident_notifications
            WHERE channel = 'EMAIL' AND delivered_at IS NULL
            """
        )
    ).scalar()
    max_attempts = int(settings.SMTP_MAX_ATTEMPTS)
    items = []
    for row in rows:
        attempts = int(row["delivery_attempts"] or 0)
        items.append(
            {
                "id": int(row["id"]),
                "incident_id": int(row["incident_id"]) if row["incident_id"] is not None else None,
                "recipient_user_id": (
                    int(row["recipient_user_id"]) if row["recipient_user_id"] is not None else None
                ),
                "channel": row["channel"],
                "template_code": row["template_code"],
                "created_at": row["created_at"],
                "delivery_attempts": attempts,
                "last_error": row["last_error"],
                "last_attempt_at": row["last_attempt_at"],
                "is_exhausted": attempts >= max_attempts,
            }
        )
    return {"items": items, "total": int(total or 0)}


@router.get("/roles")
def list_roles(
    db: Session = Depends(get_db),
    _admin=Depends(require_roles(["ADMIN"])),
):
    return {"items": _get_all_roles(db)}


@router.get("/users")
def list_users(
    q: str | None = None,
    limit: int = 200,
    db: Session = Depends(get_db),
    _admin=Depends(require_roles(["ADMIN"])),
):
    # Basic search by email/name (optional)
    if q:
        rows = db.execute(
            text(
                """
                SELECT id, email, full_name, is_active, metadata_json
                FROM users
                WHERE email LIKE :q OR full_name LIKE :q
                ORDER BY id DESC
                LIMIT :limit
                """
            ),
            {"q": f"%{q}%", "limit": int(limit)},
        ).mappings().all()
    else:
        rows = db.execute(
            text(
                """
                SELECT id, email, full_name, is_active, metadata_json
                FROM users
                ORDER BY id DESC
                LIMIT :limit
                """
            ),
            {"limit": int(limit)},
        ).mappings().all()

    items: list[dict] = []
    for r in rows:
        uid = int(r["id"])
        items.append(
            {
                "id": uid,
                "email": r["email"],
                "full_name": r["full_name"],
                "is_active": bool(int(r["is_active"])),
                "metadata": parse_user_metadata(r.get("metadata_json")),
                "roles": _get_user_roles(db, uid),
            }
        )

    return {"items": items}


@router.get("/users/{user_id}")
def get_user(
    user_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    _admin=Depends(require_roles(["ADMIN"])),
):
    return _user_with_roles(db, user_id)


@router.post("/users", status_code=201)
def create_user(
    body: CreateUserIn,
    db: Session = Depends(get_db),
    _admin=Depends(require_roles(["ADMIN"])),
):
    email = body.email.lower().strip()

    exists = db.execute(
        text("SELECT id FROM users WHERE email = :email"),
        {"email": email},
    ).scalar()

    if exists:
        raise HTTPException(status_code=409, detail="Email already exists")

    _ensure_roles_exist(db, body.roles)

    pw_hash = hash_password(body.password)

    try:
        res = db.execute(
            text(
                """
                INSERT INTO users (email, full_name, password_hash, metadata_json, is_active)
                VALUES (:email, :full_name, :password_hash, :metadata_json, 1)
                """
            ),
            {
                "email": email,
                "full_name": body.full_name,
                "password_hash": pw_hash,
                "metadata_json": user_metadata_json(body.metadata.model_dump() if body.metadata else None),
            },
        )
        user_id = int(res.lastrowid)

        if body.roles:
            _set_roles(db, user_id, body.roles)

        db.commit()
        return _user_with_roles(db, user_id)
    except Exception:
        db.rollback()
        raise


@router.patch("/users/{user_id}")
def update_user(
    user_id: int = Path(..., ge=1),
    body: UpdateUserIn = ...,
    db: Session = Depends(get_db),
    _admin=Depends(require_roles(["ADMIN"])),
):
    u = _get_user_row(db, user_id)
    if not u:
        raise HTTPException(status_code=404, detail="User not found")

    fields = {}
    if body.full_name is not None:
        fields["full_name"] = body.full_name
    if body.is_active is not None:
        fields["is_active"] = 1 if body.is_active else 0
    if body.metadata is not None:
        fields["metadata_json"] = user_metadata_json(body.metadata.model_dump())

    if not fields:
        return _user_with_roles(db, user_id)

    sets = ", ".join([f"{k} = :{k}" for k in fields.keys()])
    fields["id"] = user_id

    try:
        db.execute(text(f"UPDATE users SET {sets} WHERE id = :id"), fields)
        db.commit()
        return _user_with_roles(db, user_id)
    except Exception:
        db.rollback()
        raise


@router.put("/users/{user_id}/roles")
def replace_roles(
    user_id: int = Path(..., ge=1),
    body: SetRolesIn = ...,
    db: Session = Depends(get_db),
    _admin=Depends(require_roles(["ADMIN"])),
):
    u = _get_user_row(db, user_id)
    if not u:
        raise HTTPException(status_code=404, detail="User not found")

    try:
        _set_roles(db, user_id, body.roles)
        db.commit()
        return _user_with_roles(db, user_id)
    except Exception:
        db.rollback()
        raise


@router.post("/users/{user_id}/reset-password")
def reset_password(
    user_id: int = Path(..., ge=1),
    body: ResetPasswordIn = ...,
    db: Session = Depends(get_db),
    _admin=Depends(require_roles(["ADMIN"])),
):
    u = _get_user_row(db, user_id)
    if not u:
        raise HTTPException(status_code=404, detail="User not found")

    pw_hash = hash_password(body.password)

    try:
        db.execute(
            text("UPDATE users SET password_hash = :ph WHERE id = :id"),
            {"ph": pw_hash, "id": user_id},
        )
        db.commit()
        return {"ok": True}
    except Exception:
        db.rollback()
        raise

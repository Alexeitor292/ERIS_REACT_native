from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status, Path
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from .db import get_db
from .deps import require_roles
from .auth import hash_password

router = APIRouter(prefix="/admin", tags=["admin"])


# -----------------------------
# Pydantic models
# -----------------------------
class CreateUserIn(BaseModel):
    email: str
    full_name: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=8, max_length=200)
    roles: List[str] = Field(default_factory=list)


class UpdateUserIn(BaseModel):
    full_name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    is_active: Optional[bool] = None


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
            SELECT id, email, full_name, is_active
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


# -----------------------------
# Routes (ADMIN-only)
# -----------------------------
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
                SELECT id, email, full_name, is_active
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
                SELECT id, email, full_name, is_active
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
                INSERT INTO users (email, full_name, password_hash, is_active)
                VALUES (:email, :full_name, :password_hash, 1)
                """
            ),
            {"email": email, "full_name": body.full_name, "password_hash": pw_hash},
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

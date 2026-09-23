from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..auth import create_access_token, verify_password
from ..config import settings
from ..db import get_db
from ..deps import get_current_user
from ..schemas.common import LoginRequest
from ..services import org_directory

router = APIRouter()


@router.post("/auth/login")
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    row = db.execute(text("""
        SELECT id, email, password_hash, is_active
        FROM users
        WHERE email = :email
        LIMIT 1
    """), {"email": payload.email.strip().lower()}).mappings().first()

    if not row or int(row["is_active"]) != 1:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    # An account without a password signs in through single sign-on only. It
    # gets the same answer as a wrong password, so this endpoint never tells a
    # caller which accounts exist or how they sign in.
    if not row["password_hash"] or not verify_password(payload.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    db.execute(text("UPDATE users SET last_login_at = NOW(), updated_at = updated_at WHERE id = :id"), {"id": int(row["id"])})
    db.commit()

    token = create_access_token(
        subject=str(int(row["id"])),
        secret=settings.JWT_SECRET,
        alg=settings.JWT_ALG,
        expires_minutes=settings.JWT_EXPIRES_MINUTES,
    )
    return {"access_token": token, "token_type": "bearer"}


@router.get("/auth/me")
def me(user=Depends(get_current_user), db: Session = Depends(get_db)):
    """Own identity, plus where this person sits in the organization.

    ``org`` is the resolved record — ``org_user_profiles`` first, the
    ``users.metadata_json`` mirror second — so a client can render "Office of
    Geotechnical Design West · Branch C · Oakland D4" without re-deriving it
    from the legacy three-key blob. ``metadata`` STAYS beside it, unchanged, as
    that mirror: this release has two writers and the clients migrate after it
    (org model design §3.2, §7).
    """
    org = org_directory.resolve_user_org(db, user)
    return {
        **user,
        "org": {
            "office_id": org.get("office_id"),
            "office_code": org.get("office_code"),
            "office_name": org.get("office_name"),
            "office_short_name": org.get("office_short_name"),
            "office_unit_number": org.get("office_unit_number"),
            "office_is_active": org.get("office_is_active"),
            "branch_id": org.get("branch_id"),
            "branch_letter": org.get("branch_letter"),
            "branch_name": org.get("branch_name"),
            "branch_is_active": org.get("branch_is_active"),
            "home_city": org.get("home_city"),
            "home_district": org.get("home_district"),
            "classification_code": org.get("classification_code"),
            "classification_marker": org.get("classification_marker"),
            "position_number": org.get("position_number"),
            "job_title": org.get("job_title"),
            "level_code": org.get("level_code"),
            "availability": org.get("availability"),
            "available_from": org.get("available_from"),
            "available_until": org.get("available_until"),
        },
    }

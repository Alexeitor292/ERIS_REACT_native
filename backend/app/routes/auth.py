from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..auth import create_access_token, verify_password
from ..config import settings
from ..db import get_db
from ..deps import get_current_user
from ..schemas.common import LoginRequest

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

    if not verify_password(payload.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token = create_access_token(
        subject=str(int(row["id"])),
        secret=settings.JWT_SECRET,
        alg=settings.JWT_ALG,
        expires_minutes=settings.JWT_EXPIRES_MINUTES,
    )
    return {"access_token": token, "token_type": "bearer"}


@router.get("/auth/me")
def me(user=Depends(get_current_user)):
    return user

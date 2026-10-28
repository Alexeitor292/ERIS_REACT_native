import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..auth import verify_password
from ..config import settings
from ..db import get_db
from ..rate_limit import limit_sign_in
from ..deps import current_session, get_current_user
from ..schemas.common import LoginRequest
from ..services import org_directory
from ..services import maintenance_workflows
from ..sessions import (
    CLIENT_BEARER,
    CLIENT_WEB,
    clear_session_cookies,
    create_session,
    hash_token,
    is_browser,
    revoke_all,
    revoke_session,
    session_cookie_name,
    set_session_cookies,
)

router = APIRouter()
# Sign-in, sign-out and revocation events for the host's log collector. Never
# log passwords, tokens or authorization codes.
audit = logging.getLogger("eris.auth")


@router.get("/auth/config")
def auth_config():
    """Which sign-in methods this deployment offers. Public, and secret-free.

    The web reads this at run time, so the login page follows the API's
    settings without a web rebuild.
    """
    return {
        "local_login_enabled": bool(settings.LOCAL_LOGIN_ENABLED),
        "entra_enabled": bool(settings.ENTRA_ENABLED),
        "session_idle_minutes": int(settings.SESSION_IDLE_MINUTES),
        "session_absolute_minutes": int(settings.SESSION_ABSOLUTE_MINUTES),
        # Public client settings for the mobile app's own Entra sign-in, or null.
        "entra_mobile": _entra_mobile_configuration(),
    }


def _entra_mobile_configuration():
    from ..entra import mobile_configuration  # entra imports this module

    return mobile_configuration()


def start_session(db, request: Request, *, user_id: int, auth_method: str,
                  client: str | None = None) -> tuple[str, str, object]:
    """New session for a verified sign-in; ends this browser's previous one. Commits."""
    browser = client == CLIENT_WEB if client else is_browser(request)
    previous = request.cookies.get(session_cookie_name()) if browser else None
    if previous:
        db.execute(text("""UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(), revoked_reason = 'replaced'
                           WHERE token_hash = :hash AND revoked_at IS NULL"""), {"hash": hash_token(previous)})
    client = CLIENT_WEB if browser else CLIENT_BEARER
    token, expires_at = create_session(db, user_id=user_id, client=client, auth_method=auth_method, request=request)
    db.execute(text("UPDATE users SET last_login_at = NOW(), updated_at = updated_at WHERE id = :id"), {"id": int(user_id)})
    db.commit()
    return token, client, expires_at


@router.post("/auth/login", dependencies=[Depends(limit_sign_in)])
def login(payload: LoginRequest, request: Request, db: Session = Depends(get_db)):
    """Password sign-in, for development and the Campos Labs rehearsal only.

    Caltrans production signs in through Entra (LOCAL_LOGIN_ENABLED=false).
    A browser gets HttpOnly cookies and never sees the session credential;
    a native client gets it once in the body, for its Authorization header.
    """
    if not settings.LOCAL_LOGIN_ENABLED:
        raise HTTPException(status_code=404, detail="Password sign-in is disabled")
    row = db.execute(text("""
        SELECT id, email, password_hash, is_active
        FROM users
        WHERE email = :email
        LIMIT 1
    """), {"email": payload.email.strip().lower()}).mappings().first()

    if not row or int(row["is_active"]) != 1:
        audit.warning("password_sign_in_failed reason=unknown_or_inactive")
        raise HTTPException(status_code=401, detail="Invalid credentials")

    # An account without a password signs in through single sign-on only. It
    # gets the same answer as a wrong password, so this endpoint never tells a
    # caller which accounts exist or how they sign in.
    if not row["password_hash"] or not verify_password(payload.password, row["password_hash"]):
        audit.warning("password_sign_in_failed reason=bad_password user_id=%s", int(row["id"]))
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token, client, expires_at = start_session(db, request, user_id=int(row["id"]), auth_method="password")
    audit.info("password_sign_in user_id=%s client=%s", int(row["id"]), client)
    if client == CLIENT_WEB:
        response = JSONResponse({"ok": True})
        set_session_cookies(response, token)
        return response
    return {"access_token": token, "token_type": "bearer", "expires_at": expires_at.isoformat() + "Z"}


@router.post("/auth/logout")
def logout(signed_in=Depends(current_session), db: Session = Depends(get_db)):
    """End this session only; the account's other devices stay signed in."""
    user, session = signed_in
    revoke_session(db, session.id, reason="sign_out")
    db.commit()
    audit.info("sign_out user_id=%s client=%s", int(user["id"]), session.client)
    response = JSONResponse({"ok": True})
    clear_session_cookies(response)
    return response


@router.post("/auth/sessions/revoke-all")
def revoke_my_sessions(signed_in=Depends(current_session), db: Session = Depends(get_db)):
    """Sign out everywhere: every browser and device this account is signed in on."""
    user, _session = signed_in
    revoke_all(db, int(user["id"]), reason="sign_out_all")
    db.commit()
    audit.info("sign_out_everywhere user_id=%s", int(user["id"]))
    response = JSONResponse({"ok": True})
    clear_session_cookies(response)
    return response


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
        "maintenance_districts": maintenance_workflows.summary(db, int(user["id"])),
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

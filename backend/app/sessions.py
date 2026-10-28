"""Server-side ERIS sessions.

Every sign-in creates one row in ``user_sessions``. The credential is 256
random bits; only its SHA-256 is stored, so a database copy cannot be replayed.

* Browsers get the credential in an HttpOnly, Secure, SameSite=Strict cookie
  (``__Host-eris_session`` over HTTPS). Page scripts never see it, so a
  cross-site-scripting bug cannot steal a session.
* Native clients (the mobile app, scripts, tests) get it once in the login
  response and send ``Authorization: Bearer``. Browsers are recognised by the
  ``Sec-Fetch-*`` headers they always send and scripts cannot remove, so a
  browser never receives a bearer token.
* Cookie-authenticated writes need ``X-CSRF-Token``: an HMAC of the session,
  delivered in a readable ``__Host-eris_csrf`` cookie (signed double-submit,
  OWASP). A cross-site page can neither read that cookie nor set the header.
* A web session ends after SESSION_IDLE_MINUTES without a request, and every
  session after SESSION_ABSOLUTE_MINUTES. Sign-out ends one session;
  disabling an account, a password reset or "sign out everywhere" ends all.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from fastapi import HTTPException, Request, Response, status
from sqlalchemy import text

from .config import settings

audit = logging.getLogger("eris.auth")

CLIENT_WEB = "web"
CLIENT_BEARER = "bearer"
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
CSRF_HEADER = "X-CSRF-Token"
# last_seen_at is written at most this often, not on every request.
_TOUCH_EVERY = timedelta(seconds=60)


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def cookies_secure() -> bool:
    return settings.ENV.strip().lower() == "prod" or urlparse(settings.WEB_BASE_URL).scheme == "https"


def session_cookie_name() -> str:
    # __Host- requires Secure, Path=/ and no Domain: the browser itself then
    # refuses a cookie planted by a sibling subdomain or over plain HTTP.
    return "__Host-eris_session" if cookies_secure() else "eris_session"


def csrf_cookie_name() -> str:
    return "__Host-eris_csrf" if cookies_secure() else "eris_csrf"


def csrf_token_for(token_hash: str) -> str:
    return hmac.new(settings.JWT_SECRET.encode("utf-8"), f"csrf:{token_hash}".encode(), hashlib.sha256).hexdigest()


def is_browser(request: Request) -> bool:
    # Modern browsers always send Sec-Fetch-* and scripts cannot remove them;
    # the web also says so explicitly, for browsers too old to send them.
    return bool(request.headers.get("sec-fetch-mode") or request.headers.get("sec-fetch-site")
                or request.headers.get("x-eris-client") == "web")


def allowed_origins() -> set[str]:
    origins = {o.rstrip("/") for o in settings.cors_origins_list()}
    web = urlparse(settings.WEB_BASE_URL)
    if web.scheme and web.netloc:
        origins.add(f"{web.scheme}://{web.netloc}")
    return origins


@dataclass
class Session:
    id: int
    user_id: int
    client: str
    token_hash: str


def create_session(db, *, user_id: int, client: str, auth_method: str, request: Request | None) -> tuple[str, datetime]:
    """Insert a session and return (credential, absolute expiry). The caller commits."""
    token = secrets.token_urlsafe(32)
    now = _now()
    expires_at = now + timedelta(minutes=settings.SESSION_ABSOLUTE_MINUTES)
    agent = (request.headers.get("user-agent") or "")[:255] if request else ""
    address = (request.client.host if request and request.client else "")[:45]
    # Keep 90 days of ended sessions for audit, then let them go.
    db.execute(text("DELETE FROM user_sessions WHERE user_id = :uid AND expires_at < :cutoff"),
               {"uid": int(user_id), "cutoff": now - timedelta(days=90)})
    db.execute(text("""
        INSERT INTO user_sessions
            (user_id, token_hash, client, auth_method, created_at, last_seen_at, expires_at, user_agent, created_ip)
        VALUES (:uid, :hash, :client, :method, :now, :now, :expires, :agent, :ip)
    """), {"uid": int(user_id), "hash": hash_token(token), "client": client, "method": auth_method,
           "now": now, "expires": expires_at, "agent": agent or None, "ip": address or None})
    return token, expires_at


def set_session_cookies(response: Response, token: str) -> None:
    """Session cookies, not persistent: closing the browser drops them too."""
    secure = cookies_secure()
    response.set_cookie(session_cookie_name(), token, httponly=True, secure=secure, samesite="strict", path="/")
    response.set_cookie(csrf_cookie_name(), csrf_token_for(hash_token(token)), httponly=False,
                        secure=secure, samesite="strict", path="/")


def clear_session_cookies(response: Response) -> None:
    secure = cookies_secure()
    for name, http_only in ((session_cookie_name(), True), (csrf_cookie_name(), False)):
        response.delete_cookie(name, path="/", secure=secure, httponly=http_only, samesite="strict")


def _credential(request: Request, bearer_token: str | None) -> tuple[str | None, str | None]:
    if bearer_token:
        return bearer_token, CLIENT_BEARER
    cookie = request.cookies.get(session_cookie_name())
    return (cookie, CLIENT_WEB) if cookie else (None, None)


def authenticate(request: Request, db, bearer_token: str | None) -> tuple[dict, Session]:
    """The signed-in user and their session, or 401. Enforces CSRF on cookie writes."""
    token, transport = _credential(request, bearer_token)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not signed in")
    token_hash = hash_token(token)
    row = db.execute(text("""
        SELECT s.id, s.user_id, s.client, s.last_seen_at, s.expires_at, s.revoked_at,
               u.email, u.full_name, u.is_active, u.metadata_json
          FROM user_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = :hash
    """), {"hash": token_hash}).mappings().first()
    now = _now()
    if not row or row["revoked_at"] is not None or row["expires_at"] <= now:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired")
    # A cookie only authenticates a web session and a bearer token only a
    # native one, so a leaked cookie value cannot be replayed as a header.
    if (row["client"] == CLIENT_WEB) != (transport == CLIENT_WEB):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired")
    if row["client"] == CLIENT_WEB and row["last_seen_at"] + timedelta(minutes=settings.SESSION_IDLE_MINUTES) <= now:
        revoke_session(db, int(row["id"]), reason="idle")
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired")
    if int(row["is_active"]) != 1:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User inactive or not found")
    if transport == CLIENT_WEB and request.method.upper() in UNSAFE_METHODS:
        supplied = request.headers.get(CSRF_HEADER) or ""
        if not hmac.compare_digest(supplied, csrf_token_for(token_hash)):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Missing or invalid CSRF token")
    if now - row["last_seen_at"] >= _TOUCH_EVERY:
        db.execute(text("UPDATE user_sessions SET last_seen_at = :now WHERE id = :id"), {"now": now, "id": int(row["id"])})
        db.commit()
    user = {"id": int(row["user_id"]), "email": row["email"], "full_name": row["full_name"],
            "metadata_json": row["metadata_json"]}
    return user, Session(id=int(row["id"]), user_id=int(row["user_id"]), client=row["client"], token_hash=token_hash)


def revoke_session(db, session_id: int, *, reason: str) -> None:
    db.execute(text("""UPDATE user_sessions SET revoked_at = :now, revoked_reason = :reason
                       WHERE id = :id AND revoked_at IS NULL"""), {"now": _now(), "reason": reason[:32], "id": int(session_id)})


def revoke_all(db, user_id: int, *, reason: str) -> None:
    """End every session the account holds. The caller commits."""
    db.execute(text("""UPDATE user_sessions SET revoked_at = :now, revoked_reason = :reason
                       WHERE user_id = :uid AND revoked_at IS NULL"""), {"now": _now(), "reason": reason[:32], "uid": int(user_id)})


def check_origin(request: Request) -> None:
    """Refuse a state-changing request that a browser says came from another site."""
    if request.method.upper() not in UNSAFE_METHODS:
        return
    origin = request.headers.get("origin")
    # "null" (sandboxed frames, some redirects) is refused too: it names no site.
    if origin and origin.rstrip("/") not in allowed_origins():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Cross-origin request refused")
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Cross-origin request refused")

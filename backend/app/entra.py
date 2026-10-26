"""Single-tenant Entra OIDC sign-in. Entra proves identity; ERIS grants roles."""

from __future__ import annotations

import base64
import hashlib
import secrets
import time
from urllib.parse import urlencode, urlparse
from uuid import UUID

import httpx
from fastapi import APIRouter, Cookie, HTTPException, Query
from fastapi.responses import RedirectResponse, JSONResponse
from jose import JWTError, jwt
from sqlalchemy import text

from .auth import create_access_token
from .config import settings
from .db import SessionLocal

router = APIRouter(prefix="/auth/entra", tags=["auth"])
_COOKIE_PATH = "/api/auth/entra"


def _authority_host() -> str:
    host = settings.ENTRA_AUTHORITY_HOST.lower().strip()
    if host not in {"login.microsoftonline.com", "login.microsoftonline.us"}:
        raise HTTPException(503, "Unsupported Entra authority host")
    return host


def _configuration() -> tuple[str, str, str, str]:
    if not settings.ENTRA_ENABLED:
        raise HTTPException(404, "Entra sign-in is not enabled")
    _authority_host()
    try:
        tenant = str(UUID(settings.ENTRA_TENANT_ID or ""))
        client = str(UUID(settings.ENTRA_CLIENT_ID or ""))
    except ValueError as exc:
        raise HTTPException(503, "Entra tenant/client configuration is invalid") from exc
    secret = settings.ENTRA_CLIENT_SECRET or ""
    redirect = settings.ENTRA_REDIRECT_URI or ""
    if not secret or not redirect or not redirect.endswith("/api/auth/entra/callback"):
        raise HTTPException(503, "Entra client secret or callback is missing")
    if urlparse(redirect).netloc != urlparse(settings.WEB_BASE_URL).netloc:
        raise HTTPException(503, "Entra callback must use the web origin")
    if settings.ENV.lower() == "prod" and (urlparse(redirect).scheme != "https" or urlparse(settings.WEB_BASE_URL).scheme != "https"):
        raise HTTPException(503, "Entra requires HTTPS in production")
    return tenant, client, secret, redirect


def _challenge(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


def _validate_id_token(token: str, *, tenant: str, client: str, nonce: str) -> dict:
    host = _authority_host()
    issuer = f"https://{host}/{tenant}/v2.0"
    try:
        with httpx.Client(timeout=10) as http:
            metadata = http.get(f"{issuer}/.well-known/openid-configuration")
            metadata.raise_for_status()
            info = metadata.json()
            if info.get("issuer") != issuer:
                raise ValueError("unexpected issuer metadata")
            jwks_uri = info.get("jwks_uri", "")
            parsed = urlparse(jwks_uri)
            if parsed.scheme != "https" or parsed.netloc != host:
                raise ValueError("unexpected signing-key endpoint")
            keys_response = http.get(jwks_uri)
            keys_response.raise_for_status()
            keys = keys_response.json().get("keys", [])
        header = jwt.get_unverified_header(token)
        matches = [key for key in keys if key.get("kid") == header.get("kid") and key.get("kty") == "RSA"]
        if len(matches) != 1 or header.get("alg") != "RS256":
            raise ValueError("unknown signing key")
        key_issuer = matches[0].get("issuer")
        if key_issuer and key_issuer.replace("{tenantid}", tenant) != issuer:
            raise ValueError("signing key issuer mismatch")
        claims = jwt.decode(token, matches[0], algorithms=["RS256"], audience=client, issuer=issuer)
        if str(claims.get("tid") or "").lower() != tenant or claims.get("nonce") != nonce:
            raise ValueError("tenant or nonce mismatch")
        object_id = str(UUID(claims.get("oid", "")))
        claims["oid"] = object_id
        return claims
    except (httpx.HTTPError, JWTError, ValueError, TypeError, KeyError) as exc:
        raise HTTPException(401, "Entra identity could not be verified") from exc


@router.get("/start")
def start():
    tenant, client, _, redirect = _configuration()
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    cookie = jwt.encode({"state": state, "nonce": nonce, "verifier": verifier, "exp": int(time.time()) + 300}, settings.JWT_SECRET, algorithm="HS256")
    params = {
        "client_id": client, "response_type": "code", "redirect_uri": redirect,
        "response_mode": "query", "scope": "openid profile email", "state": state,
        "nonce": nonce, "code_challenge": _challenge(verifier), "code_challenge_method": "S256",
    }
    response = RedirectResponse(f"https://{_authority_host()}/{tenant}/oauth2/v2.0/authorize?{urlencode(params)}")
    response.set_cookie("eris_entra_state", cookie, max_age=300, httponly=True, secure=urlparse(redirect).scheme == "https", samesite="lax", path=_COOKIE_PATH)
    return response


@router.get("/callback")
def callback(code: str | None = Query(default=None), state: str | None = Query(default=None),
             error: str | None = Query(default=None), eris_entra_state: str | None = Cookie(default=None)):
    tenant, client, secret, redirect = _configuration()
    if error or not code or not state:
        return RedirectResponse(f"{settings.WEB_BASE_URL.rstrip('/')}/login?entra=cancelled", status_code=303)
    try:
        payload = jwt.decode(eris_entra_state or "", settings.JWT_SECRET, algorithms=["HS256"], options={"verify_aud": False})
        if not secrets.compare_digest(payload.get("state", ""), state):
            raise ValueError("state mismatch")
        verifier, nonce = payload["verifier"], payload["nonce"]
        with httpx.Client(timeout=15) as http:
            token_response = http.post(
                f"https://{_authority_host()}/{tenant}/oauth2/v2.0/token",
                data={"client_id": client, "client_secret": secret, "grant_type": "authorization_code", "code": code,
                      "redirect_uri": redirect, "code_verifier": verifier, "scope": "openid profile email"},
            )
            token_response.raise_for_status()
            id_token = token_response.json()["id_token"]
        identity = _validate_id_token(id_token, tenant=tenant, client=client, nonce=nonce)
    except (JWTError, ValueError, KeyError, httpx.HTTPError) as exc:
        raise HTTPException(401, "Entra sign-in failed") from exc

    with SessionLocal() as db:
        user = db.execute(text("""
            SELECT u.id, u.is_active FROM user_external_identities i
            JOIN users u ON u.id = i.user_id
            WHERE i.provider = 'ENTRA_ID' AND i.tenant_id = :tid AND i.object_id = :oid
        """), {"tid": tenant, "oid": identity["oid"]}).mappings().first()
        if not user or not bool(user["is_active"]):
            raise HTTPException(403, "No active ERIS account is linked to this Entra identity")
        db.execute(text("UPDATE users SET last_login_at = NOW() WHERE id = :id"), {"id": user["id"]})
        db.execute(text("""UPDATE user_external_identities SET last_login_at = NOW(), user_principal_name = :upn
            WHERE provider = 'ENTRA_ID' AND tenant_id = :tid AND object_id = :oid"""),
            {"upn": identity.get("preferred_username"), "tid": tenant, "oid": identity["oid"]})
        db.commit()
        access = create_access_token(subject=str(user["id"]), secret=settings.JWT_SECRET,
                                     alg=settings.JWT_ALG, expires_minutes=settings.JWT_EXPIRES_MINUTES)
    response = RedirectResponse(f"{settings.WEB_BASE_URL.rstrip('/')}/auth/entra/complete", status_code=303)
    response.delete_cookie("eris_entra_state", path=_COOKIE_PATH)
    # Short-lived, HttpOnly handoff keeps the bearer token out of the URL and browser history.
    response.set_cookie("eris_entra_handoff", access, max_age=60, httponly=True,
                        secure=urlparse(redirect).scheme == "https", samesite="strict", path=f"{_COOKIE_PATH}/session")
    return response


@router.post("/session")
def session(eris_entra_handoff: str | None = Cookie(default=None)):
    _configuration()
    if not eris_entra_handoff:
        raise HTTPException(401, "Sign-in handoff expired")
    try:
        claims = jwt.decode(eris_entra_handoff, settings.JWT_SECRET, algorithms=[settings.JWT_ALG])
        if not claims.get("sub"):
            raise JWTError("handoff is not an access token")
    except JWTError as exc:
        raise HTTPException(401, "Sign-in handoff expired") from exc
    response = JSONResponse({"access_token": eris_entra_handoff, "token_type": "bearer"})
    response.delete_cookie("eris_entra_handoff", path=f"{_COOKIE_PATH}/session")
    return response

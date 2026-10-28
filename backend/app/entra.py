"""Single-tenant Entra OIDC sign-in. Entra proves identity; ERIS grants roles.

Web: authorization code + PKCE run by the API as a confidential client that
authenticates with a certificate (``entra_credential``). The resulting ERIS
session goes into HttpOnly cookies.

Mobile: the app is a separate *public* client. It signs in through the system
browser (authorization code + PKCE, no secret), asks Entra for an access token
to the ERIS API scope, and exchanges that token here for an ERIS bearer session.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import secrets
import time
from urllib.parse import urlencode, urlparse
from uuid import UUID

import httpx
from fastapi import APIRouter, Cookie, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from jose import JWTError, jwt
from pydantic import BaseModel, Field
from sqlalchemy import text

from . import entra_credential
from .config import settings
from .db import SessionLocal
from .routes.auth import start_session
from .sessions import CLIENT_BEARER, CLIENT_WEB, is_browser, set_session_cookies

router = APIRouter(prefix="/auth/entra", tags=["auth"])
_COOKIE_PATH = "/api/auth/entra"
audit = logging.getLogger("eris.auth")


def _login_redirect(reason: str) -> RedirectResponse:
    """Send the browser back to the sign-in page with a reason it can explain.

    /start and /callback are top-level browser navigations: a JSON error there
    strands the person on a raw API page. Reasons are a fixed vocabulary and
    never echo Entra's error text.
    """
    response = RedirectResponse(f"{settings.WEB_BASE_URL.rstrip('/')}/login?entra={reason}", status_code=303)
    response.delete_cookie("eris_entra_state", path=_COOKIE_PATH)
    return response


def _authority_host() -> str:
    host = settings.ENTRA_AUTHORITY_HOST.lower().strip()
    if host not in {"login.microsoftonline.com", "login.microsoftonline.us"}:
        raise HTTPException(503, "Unsupported Entra authority host")
    return host


def _tenant_and_client() -> tuple[str, str]:
    if not settings.ENTRA_ENABLED:
        raise HTTPException(404, "Entra sign-in is not enabled")
    _authority_host()
    try:
        return str(UUID(settings.ENTRA_TENANT_ID or "")), str(UUID(settings.ENTRA_CLIENT_ID or ""))
    except ValueError as exc:
        raise HTTPException(503, "Entra tenant/client configuration is invalid") from exc


def _client_credential(tenant: str, client: str) -> dict[str, str]:
    """Token-request parameters proving the web app's identity to Entra."""
    token_endpoint = f"https://{_authority_host()}/{tenant}/oauth2/v2.0/token"
    if settings.ENTRA_CLIENT_CERT_FILE and settings.ENTRA_CLIENT_KEY_FILE:
        try:
            credential = entra_credential.load_credential(settings.ENTRA_CLIENT_CERT_FILE, settings.ENTRA_CLIENT_KEY_FILE)
            assertion = entra_credential.client_assertion(credential, client_id=client, token_endpoint=token_endpoint)
        except entra_credential.CredentialError as exc:
            raise HTTPException(503, f"Entra client certificate unusable: {exc}") from exc
        return {"client_assertion_type": entra_credential.ASSERTION_TYPE, "client_assertion": assertion}
    if settings.ENTRA_CLIENT_SECRET and settings.ENV.strip().lower() != "prod":
        return {"client_secret": settings.ENTRA_CLIENT_SECRET}
    raise HTTPException(503, "Entra client certificate is not configured")


def _configuration() -> tuple[str, str, str]:
    tenant, client = _tenant_and_client()
    redirect = settings.ENTRA_REDIRECT_URI or ""
    if not redirect.endswith("/api/auth/entra/callback"):
        raise HTTPException(503, "Entra callback is missing")
    if urlparse(redirect).netloc != urlparse(settings.WEB_BASE_URL).netloc:
        raise HTTPException(503, "Entra callback must use the web origin")
    if settings.ENV.lower() == "prod" and (urlparse(redirect).scheme != "https" or urlparse(settings.WEB_BASE_URL).scheme != "https"):
        raise HTTPException(503, "Entra requires HTTPS in production")
    # Fail now, before sending anyone to Entra, if the credential is unusable.
    _client_credential(tenant, client)
    return tenant, client, redirect


def _challenge(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


def _verify_entra_jwt(token: str, *, tenant: str, audiences: set[str]) -> dict:
    """Signature, issuer, audience, expiry and tenant of an Entra v2.0 token."""
    host = _authority_host()
    issuer = f"https://{host}/{tenant}/v2.0"
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
    claims = jwt.decode(token, matches[0], algorithms=["RS256"], issuer=issuer, options={"verify_aud": False})
    audience = claims.get("aud")
    if not isinstance(audience, str) or audience not in audiences:
        raise ValueError("unexpected audience")
    if str(claims.get("tid") or "").lower() != tenant:
        raise ValueError("tenant mismatch")
    claims["oid"] = str(UUID(claims.get("oid", "")))
    return claims


def _validate_id_token(token: str, *, tenant: str, client: str, nonce: str) -> dict:
    try:
        claims = _verify_entra_jwt(token, tenant=tenant, audiences={client})
        if claims.get("nonce") != nonce:
            raise ValueError("nonce mismatch")
        return claims
    except (httpx.HTTPError, JWTError, ValueError, TypeError, KeyError) as exc:
        raise HTTPException(401, "Entra identity could not be verified") from exc


def _api_scope(client: str) -> str:
    return settings.ENTRA_API_SCOPE or f"api://{client}/access_as_user"


def mobile_configuration() -> dict | None:
    """What the mobile app needs to start its own sign-in; public, no secrets."""
    if not settings.ENTRA_ENABLED or not settings.ENTRA_MOBILE_CLIENT_ID:
        return None
    try:
        tenant, client = _tenant_and_client()
        mobile = str(UUID(settings.ENTRA_MOBILE_CLIENT_ID))
    except (HTTPException, ValueError):
        return None
    return {"authority": f"https://{_authority_host()}/{tenant}", "client_id": mobile, "scopes": [_api_scope(client)]}


def _validate_mobile_access_token(token: str) -> dict:
    """An access token Entra issued to the ERIS mobile app for the ERIS API."""
    tenant, client = _tenant_and_client()
    try:
        mobile = str(UUID(settings.ENTRA_MOBILE_CLIENT_ID or ""))
    except ValueError as exc:
        raise HTTPException(404, "Mobile Entra sign-in is not enabled") from exc
    scope = _api_scope(client)
    resource, _, scope_name = scope.rpartition("/")
    try:
        claims = _verify_entra_jwt(token, tenant=tenant, audiences={client, f"api://{client}", resource})
        # The app the token was issued to (v2 "azp") must be the ERIS mobile
        # client, so a token another app obtained for ERIS is not accepted.
        if str(claims.get("azp") or "").lower() != mobile:
            raise ValueError("token was not issued to the ERIS mobile app")
        if scope_name not in str(claims.get("scp") or "").split():
            raise ValueError("token lacks the ERIS API scope")
        return claims
    except (httpx.HTTPError, JWTError, ValueError, TypeError, KeyError) as exc:
        raise HTTPException(401, "Entra identity could not be verified") from exc


def _linked_active_user(db, tenant: str, identity: dict) -> dict | None:
    user = db.execute(text("""
        SELECT u.id, u.is_active FROM user_external_identities i
        JOIN users u ON u.id = i.user_id
        WHERE i.provider = 'ENTRA_ID' AND i.tenant_id = :tid AND i.object_id = :oid
    """), {"tid": tenant, "oid": identity["oid"]}).mappings().first()
    if not user or not bool(user["is_active"]):
        audit.warning("entra_sign_in_refused reason=%s tenant=%s oid=%s",
                      "inactive" if user else "not_linked", tenant, identity["oid"])
        return None
    db.execute(text("""UPDATE user_external_identities SET last_login_at = NOW(), user_principal_name = :upn
        WHERE provider = 'ENTRA_ID' AND tenant_id = :tid AND object_id = :oid"""),
        {"upn": identity.get("preferred_username"), "tid": tenant, "oid": identity["oid"]})
    return user


@router.get("/start")
def start():
    try:
        tenant, client, redirect = _configuration()
    except HTTPException as exc:
        if exc.status_code != 503:
            raise
        audit.error("entra_sign_in_unavailable detail=%s", exc.detail)
        return _login_redirect("unavailable")
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
def callback(request: Request, code: str | None = Query(default=None), state: str | None = Query(default=None),
             error: str | None = Query(default=None), eris_entra_state: str | None = Cookie(default=None)):
    try:
        tenant, client, redirect = _configuration()
    except HTTPException as exc:
        if exc.status_code != 503:
            raise
        audit.error("entra_sign_in_unavailable detail=%s", exc.detail)
        return _login_redirect("unavailable")
    if error or not code or not state:
        # Entra's own error code (e.g. access_denied, a Conditional Access
        # block) is safe to log; its free-text description is not echoed.
        audit.info("entra_sign_in_cancelled error=%s", (error or "missing_code")[:64])
        return _login_redirect("cancelled")
    try:
        payload = jwt.decode(eris_entra_state or "", settings.JWT_SECRET, algorithms=["HS256"], options={"verify_aud": False})
        if not secrets.compare_digest(payload.get("state", ""), state):
            raise ValueError("state mismatch")
        verifier, nonce = payload["verifier"], payload["nonce"]
        with httpx.Client(timeout=15) as http:
            token_response = http.post(
                f"https://{_authority_host()}/{tenant}/oauth2/v2.0/token",
                data={"client_id": client, "grant_type": "authorization_code", "code": code,
                      "redirect_uri": redirect, "code_verifier": verifier, "scope": "openid profile email",
                      **_client_credential(tenant, client)},
            )
            token_response.raise_for_status()
            id_token = token_response.json()["id_token"]
        identity = _validate_id_token(id_token, tenant=tenant, client=client, nonce=nonce)
    except (JWTError, ValueError, KeyError, httpx.HTTPError, HTTPException) as exc:
        audit.warning("entra_sign_in_failed reason=%s", type(exc).__name__)
        return _login_redirect("failed")

    with SessionLocal() as db:
        user = _linked_active_user(db, tenant, identity)
        if not user:
            return _login_redirect("not_linked")
        token, _client, _expires = start_session(db, request, user_id=int(user["id"]), auth_method="entra",
                                                   client=CLIENT_WEB)
    audit.info("entra_sign_in user_id=%s client=web", int(user["id"]))
    # The session goes straight into HttpOnly cookies: it never appears in a
    # URL, in browser history, or in reach of page scripts.
    response = RedirectResponse(f"{settings.WEB_BASE_URL.rstrip('/')}/auth/entra/complete", status_code=303)
    response.delete_cookie("eris_entra_state", path=_COOKIE_PATH)
    set_session_cookies(response, token)
    return response


class NativeSignIn(BaseModel):
    access_token: str = Field(min_length=20, max_length=16384)


@router.post("/native")
def native(body: NativeSignIn, request: Request):
    """Exchange the mobile app's Entra access token for an ERIS bearer session.

    The Entra token is verified and then discarded; the app keeps only the ERIS
    session, which ERIS can expire and revoke. Browsers are refused: the web
    signs in through /start and never holds a bearer credential.
    """
    if is_browser(request):
        raise HTTPException(403, "Browsers sign in through /auth/entra/start")
    tenant, _client = _tenant_and_client()
    try:
        identity = _validate_mobile_access_token(body.access_token)
    except HTTPException:
        audit.warning("entra_mobile_sign_in_failed reason=unverified")
        raise
    with SessionLocal() as db:
        user = _linked_active_user(db, tenant, identity)
        if not user:
            raise HTTPException(403, "No active ERIS account is linked to this Entra identity")
        token, _kind, expires_at = start_session(db, request, user_id=int(user["id"]), auth_method="entra",
                                                 client=CLIENT_BEARER)
    audit.info("entra_sign_in user_id=%s client=mobile", int(user["id"]))
    return {"access_token": token, "token_type": "bearer", "expires_at": expires_at.isoformat() + "Z"}

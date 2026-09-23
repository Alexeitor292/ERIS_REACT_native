from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from sqlalchemy import text

from .db import get_db
from .config import settings
from .auth import decode_token
from .roles import is_public_only
from .user_metadata import parse_user_metadata

bearer = HTTPBearer(auto_error=False)

def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
):
    if creds is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing Authorization header")

    token = creds.credentials
    try:
        payload = decode_token(token, settings.JWT_SECRET, settings.JWT_ALG)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    sub = payload.get("sub")
    if not sub:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token payload")

    # sub is user id as string
    user = db.execute(text("""
        SELECT id, email, full_name, is_active, metadata_json
        FROM users
        WHERE id = :id
    """), {"id": int(sub)}).mappings().first()

    if not user or int(user["is_active"]) != 1:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User inactive or not found")

    roles = db.execute(text("""
        SELECT r.name
        FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = :id
    """), {"id": int(sub)}).scalars().all()

    return {
        "id": int(user["id"]),
        "email": user["email"],
        "full_name": user["full_name"],
        "metadata": parse_user_metadata(user.get("metadata_json")),
        "roles": list(roles),
    }

def deny_public_only(user=Depends(get_current_user)):
    """Refuse a read-only Viewer, and nobody else.

    The explicit half of the viewer gate (org model design §4.3b). ``require_roles``
    is a flat any-of set intersection with no notion of record state, so it can
    say "these roles" but never "approved records only" — and 39 of the 137
    routes under ``backend/app`` carry no ``require_roles`` at all. Rather than
    invent a role list for each of them, every authenticated-only route that is
    NOT in ``services/public_visibility.VIEWER_READABLE_ROUTES`` carries this
    dependency, and ``tests/test_route_guards.py`` fails the build on any route
    carrying none of the three.

    It fires only for an account whose ONLY role is Viewer: a chief who also
    holds Viewer keeps every chief endpoint.
    """
    if is_public_only(user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient permissions for this operation",
        )
    return user


def require_roles(required: list[str]):
    def _guard(user=Depends(get_current_user)):
        have = set(user["roles"])
        need = set(required)

        if have.isdisjoint(need):
            # Don’t leak internal roles in prod-style APIs
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient permissions for this operation",
            )
        return user
    return _guard

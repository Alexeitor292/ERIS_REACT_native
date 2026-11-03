from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from sqlalchemy import text

from .db import get_db
from .roles import ADMIN, is_public_only
from .services import delegations
from .services.app_access import APP_ACCESS_DETAIL, OPEN_PATHS, may_use_app
from .sessions import CLIENT_BEARER, authenticate
from .user_metadata import parse_user_metadata

bearer = HTTPBearer(auto_error=False)


def user_with_roles(db, user: dict) -> dict:
    roles = db.execute(text("""
        SELECT r.name
        FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = :id
    """), {"id": int(user["id"])}).scalars().all()
    return {
        "id": int(user["id"]),
        "email": user["email"],
        "full_name": user["full_name"],
        "metadata": parse_user_metadata(user.get("metadata_json")),
        "roles": list(roles),
    }


def _acting_for(request: Request, db, real: dict, requested: str) -> dict:
    """Judges this request as the person ``real`` stands in for (services/delegations.py)."""
    try:
        person_id = int(requested)
    except ValueError:
        person_id = 0
    delegation_id = delegations.running(db, delegate_id=int(real["id"]), delegator_id=person_id)
    if delegation_id is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=delegations.ACTING_ENDED_DETAIL)
    if delegations.blocked_while_acting(request.method, request.url.path):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=delegations.ACTING_BLOCKED_DETAIL)
    row = db.execute(
        text("SELECT id, email, full_name, metadata_json FROM users WHERE id = :uid AND is_active = 1"), {"uid": person_id}
    ).mappings().first()
    if row is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=delegations.ACTING_ENDED_DETAIL)
    who = {"delegation_id": delegation_id, "user_id": int(real["id"]), "full_name": real["full_name"] or real["email"]}
    db.info["acting"] = who
    if request.method.upper() in delegations.UNSAFE_METHODS:
        delegations.record_action(
            db, delegation_id=delegation_id, actor_id=int(real["id"]), acting_for=person_id,
            method=request.method.upper(), path=request.url.path,
        )
    person = user_with_roles(db, row)
    person["roles"] = [role for role in person["roles"] if role != ADMIN]  # the work, not the keys
    person["acting"] = who
    return person


def current_session(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
):
    """(user, session) from the session cookie or a native client's bearer token.

    Roles and the active flag are read from the database on every request, so
    a role change or a disabled account takes effect at once. A native client
    also has to belong to the organization (``services/app_access.py``).
    """
    user, session = authenticate(request, db, creds.credentials if creds else None)
    with_roles = user_with_roles(db, user)
    if (
        session.client == CLIENT_BEARER
        and not request.url.path.endswith(OPEN_PATHS)
        and not may_use_app(db, with_roles)
    ):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=APP_ACCESS_DETAIL)
    requested = request.headers.get(delegations.ACTING_HEADER)
    if requested:
        with_roles = _acting_for(request, db, with_roles, requested)
    return with_roles, session


def get_current_user(signed_in=Depends(current_session)):
    return signed_in[0]


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


def deny_public_only_unless_maintenance_reporter(user=Depends(get_current_user), db: Session = Depends(get_db)):
    """``deny_public_only``, except for someone who reports for a district
    maintenance workflow.

    Reporting duties come from a district's workflow, not from a role, so an
    account can be Viewer-only by role and still file maintenance reports. The
    road data its app needs to find a highway post mile without a connection
    (road inventory manifest and mobile package) is opened to it; nothing else.
    """
    if is_public_only(user):
        from .services import maintenance_workflows  # imports the app's routes; deferred to avoid a cycle

        if not any(item["report"] for item in maintenance_workflows.summary(db, int(user["id"]))):
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

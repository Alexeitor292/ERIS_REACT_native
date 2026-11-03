"""Who may use the phone apps: anyone placed in the organization, or an administrator.

A person's place decides their roles (``services/org_tree.py``), and somebody
placed nowhere is a Guest. Maintenance duties come from a district's workflow
rather than from a role, so an account can be Guest by role and still have a
step to do: those people keep the app. Everyone else reads ERIS on the web.

Judged on every request from a native client, so a change of place takes effect
at once, as every other permission does.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from ..roles import is_maintenance_only, is_operational_user

APP_ACCESS_DETAIL = (
    "ERIS Mobile is for people placed in an office or on a district's maintenance list. "
    "Ask your chief or an ERIS administrator to place you, or use ERIS on the web."
)

# Leaving must always work: the session ends and this device stops getting notices.
OPEN_PATHS = ("/auth/logout", "/notifications/devices/unregister")


def may_use_app(db: Session, user: dict) -> bool:
    if is_operational_user(user) or is_maintenance_only(user):
        return True
    from . import maintenance_workflows  # imports the app's routes; deferred to avoid a cycle

    return bool(maintenance_workflows.summary(db, int(user["id"])))

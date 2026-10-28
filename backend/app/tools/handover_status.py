"""Report whether administrator handover is complete. Read-only.

Handover (docs/caltrans-podman.md, "Entra sign-in and handover") ends when:

  * at least two active administrators sign in through Entra (one for
    recovery), so losing one person does not lock the deployment;
  * the bootstrap administrator is disabled, or has become an Entra-only
    account with no password;
  * no active administrator still holds a password; and
  * password sign-in is switched off (LOCAL_LOGIN_ENABLED=false).

Exit 0 when every item holds, 1 while any is outstanding, 2 when the database
cannot be read. Prints counts and user IDs only: no emails, names or secrets,
so the output can be pasted into a change record.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass, field

from sqlalchemy import text

MIN_ENTRA_ADMINS = 2


@dataclass
class Snapshot:
    local_login_enabled: bool
    entra_enabled: bool
    # One entry per ACTIVE administrator.
    admins: list[dict] = field(default_factory=list)
    # The deployment_bootstrap initial admin, if the marker exists.
    bootstrap_admin: dict | None = None
    bootstrap_marker: bool = False


def evaluate(snapshot: Snapshot) -> list[str]:
    """Outstanding handover items; an empty list means handover is complete."""
    outstanding: list[str] = []
    if not snapshot.bootstrap_marker:
        outstanding.append("No bootstrap marker: run eris-pod.sh up (or adopt_existing_admin) first.")
    if not snapshot.entra_enabled:
        outstanding.append("ENTRA_ENABLED is false: administrators cannot sign in through Entra.")
    entra_admins = [a for a in snapshot.admins if a["entra_linked"]]
    if len(entra_admins) < MIN_ENTRA_ADMINS:
        outstanding.append(
            f"{len(entra_admins)} active Entra-linked administrator(s); at least {MIN_ENTRA_ADMINS} are required "
            "(one for recovery). Each must have signed in through Entra at least once."
        )
    else:
        never = [a["id"] for a in entra_admins if not a["entra_signed_in"]]
        if len(entra_admins) - len(never) < MIN_ENTRA_ADMINS:
            outstanding.append(
                f"Entra-linked administrators that have never signed in through Entra: user IDs {never}. "
                "Have them sign in to prove the object ID is correct."
            )
    boot = snapshot.bootstrap_admin
    if boot and boot["is_active"] and (boot["has_password"] or not boot["entra_linked"]):
        outstanding.append(
            f"Bootstrap administrator (user ID {boot['id']}) is still active with a password or without Entra: "
            "disable it in Administration > Users."
        )
    with_password = [a["id"] for a in snapshot.admins if a["has_password"]]
    if with_password:
        outstanding.append(
            f"Active administrators that still hold a password: user IDs {with_password}. "
            "Disable them or make them Entra-only before turning password sign-in off."
        )
    if snapshot.local_login_enabled:
        outstanding.append("LOCAL_LOGIN_ENABLED is true: set it false in app.env and recreate the API container.")
    return outstanding


def collect(db, *, local_login_enabled: bool, entra_enabled: bool) -> Snapshot:
    rows = db.execute(text("""
        SELECT u.id, u.is_active, u.password_hash IS NOT NULL AS has_password,
               i.id IS NOT NULL AS entra_linked, i.last_login_at IS NOT NULL AS entra_signed_in,
               EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                        WHERE ur.user_id = u.id AND r.name = 'ADMIN') AS is_admin
          FROM users u
          LEFT JOIN user_external_identities i ON i.user_id = u.id AND i.provider = 'ENTRA_ID'
    """)).mappings().all()
    users = {
        int(r["id"]): {
            "id": int(r["id"]),
            "is_active": bool(int(r["is_active"])),
            "has_password": bool(r["has_password"]),
            "entra_linked": bool(r["entra_linked"]),
            "entra_signed_in": bool(r["entra_signed_in"]),
            "is_admin": bool(r["is_admin"]),
        }
        for r in rows
    }
    marker = db.execute(text(
        "SELECT user_id FROM deployment_bootstrap WHERE name = 'initial_admin'"
    )).first()
    boot_id = int(marker[0]) if marker and marker[0] is not None else None
    return Snapshot(
        local_login_enabled=local_login_enabled,
        entra_enabled=entra_enabled,
        admins=[u for u in users.values() if u["is_admin"] and u["is_active"]],
        bootstrap_admin=users.get(boot_id) if boot_id is not None else None,
        bootstrap_marker=marker is not None,
    )


def main() -> int:
    from ..config import settings
    from ..db import SessionLocal

    try:
        with SessionLocal() as db:
            snapshot = collect(db, local_login_enabled=bool(settings.LOCAL_LOGIN_ENABLED),
                               entra_enabled=bool(settings.ENTRA_ENABLED))
    except Exception as exc:  # noqa: BLE001 - report, do not trace secrets
        print(f"handover_status: cannot read the database ({type(exc).__name__})", file=sys.stderr)
        return 2
    entra_admins = sum(1 for a in snapshot.admins if a["entra_linked"])
    print(f"Active administrators: {len(snapshot.admins)} ({entra_admins} Entra-linked)")
    print(f"Password sign-in enabled: {snapshot.local_login_enabled}")
    print(f"Entra sign-in enabled: {snapshot.entra_enabled}")
    outstanding = evaluate(snapshot)
    if not outstanding:
        print("Administrator handover: COMPLETE")
        return 0
    print("Administrator handover: OUTSTANDING")
    for item in outstanding:
        print(f"  - {item}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

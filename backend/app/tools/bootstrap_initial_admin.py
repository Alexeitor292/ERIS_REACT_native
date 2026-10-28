"""Seed exactly one initial administrator. Never re-enable it on later runs."""
from __future__ import annotations

import os
import sys
from uuid import UUID

from sqlalchemy import text

from ..auth import hash_password
from ..db import SessionLocal
from .create_admin import AdminSetupError, normalize_email, check_password


def bootstrap(db, *, email: str, name: str, password: str | None, tenant_id: str | None,
              object_id: str | None, allow_password: bool = True) -> bool:
    # Check first so later releases do not require keeping bootstrap secrets.
    if db.execute(text("SELECT 1 FROM deployment_bootstrap WHERE name = 'initial_admin' FOR UPDATE")).first():
        return False
    email = normalize_email(email)
    if not name.strip():
        raise AdminSetupError("ERIS_BOOTSTRAP_ADMIN_NAME is required")
    if object_id and not tenant_id:
        raise AdminSetupError("Entra object ID requires ENTRA_TENANT_ID")
    if object_id:
        tenant_id, object_id = str(UUID(tenant_id)), str(UUID(object_id))
    if password and not allow_password:
        raise AdminSetupError("LOCAL_LOGIN_ENABLED is false: remove ERIS_BOOTSTRAP_ADMIN_PASSWORD and set "
                              "ERIS_BOOTSTRAP_ADMIN_ENTRA_OBJECT_ID")
    if not password and not object_id:
        raise AdminSetupError("initial admin needs a password or a prelinked Entra object ID")
    # The row is a permanent guard, including after the initial account is disabled.
    if db.execute(text("SELECT 1 FROM users LIMIT 1")).first():
        raise AdminSetupError("database already has users but no bootstrap marker; inspect manually")
    pw_hash = hash_password(check_password(password)) if password else None
    result = db.execute(text("""INSERT INTO users (email, full_name, password_hash, is_active)
        VALUES (:email, :name, :password_hash, 1)"""),
        {"email": email, "name": name.strip(), "password_hash": pw_hash})
    user_id = int(result.lastrowid)
    granted = db.execute(text("""INSERT INTO user_roles (user_id, role_id)
        SELECT :uid, id FROM roles WHERE name = 'ADMIN'"""), {"uid": user_id})
    if granted.rowcount != 1:
        raise AdminSetupError("ADMIN role missing; seed database roles first")
    if object_id:
        db.execute(text("""INSERT INTO user_external_identities
            (user_id, provider, tenant_id, object_id, email_at_link)
            VALUES (:uid, 'ENTRA_ID', :tid, :oid, :email)"""),
            {"uid": user_id, "tid": tenant_id, "oid": object_id, "email": email})
    db.execute(text("INSERT INTO deployment_bootstrap (name, user_id) VALUES ('initial_admin', :uid)"), {"uid": user_id})
    return True


def main() -> int:
    from ..config import settings

    try:
        with SessionLocal() as db:
            with db.begin():
                created = bootstrap(
                    db,
                    email=os.environ.get("ERIS_BOOTSTRAP_ADMIN_EMAIL", ""),
                    name=os.environ.get("ERIS_BOOTSTRAP_ADMIN_NAME", ""),
                    password=os.environ.get("ERIS_BOOTSTRAP_ADMIN_PASSWORD"),
                    tenant_id=os.environ.get("ENTRA_TENANT_ID"),
                    object_id=os.environ.get("ERIS_BOOTSTRAP_ADMIN_ENTRA_OBJECT_ID"),
                    allow_password=bool(settings.LOCAL_LOGIN_ENABLED),
                )
        print("Initial administrator created." if created else "Initial administrator already seeded; no changes made.")
        return 0
    except (AdminSetupError, ValueError) as exc:
        print(f"bootstrap_initial_admin: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

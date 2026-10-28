"""Mark a verified existing administrator as the one-time deployment admin.

Use only when migrating a populated ERIS database. The explicit email is a
guard against silently accepting an unrelated account or database.
"""

from __future__ import annotations

import os
import sys

from sqlalchemy import text

from ..db import SessionLocal


def main() -> int:
    email = os.environ.get("ERIS_ADOPT_ADMIN_EMAIL", "").strip().lower()
    if not email:
        return 0
    try:
        with SessionLocal() as db:
            with db.begin():
                admin = db.execute(text("""
                    SELECT u.id, u.is_active FROM users u
                    JOIN user_roles ur ON ur.user_id = u.id
                    JOIN roles r ON r.id = ur.role_id
                    WHERE LOWER(u.email) = :email AND r.name = 'ADMIN'
                """), {"email": email}).mappings().one_or_none()
                if admin is None or not int(admin["is_active"]):
                    raise ValueError("named account is not an active ERIS administrator")
                existing = db.execute(text("""
                    SELECT user_id FROM deployment_bootstrap
                    WHERE name = 'initial_admin' FOR UPDATE
                """)).mappings().one_or_none()
                if existing is not None:
                    if existing["user_id"] is None or int(existing["user_id"]) != int(admin["id"]):
                        raise ValueError("bootstrap marker belongs to another user")
                    print("Existing administrator already adopted; no changes made.")
                    return 0
                db.execute(text("""
                    INSERT INTO deployment_bootstrap (name, user_id)
                    VALUES ('initial_admin', :id)
                """), {"id": int(admin["id"])})
        print(f"Existing administrator adopted: user id {admin['id']}.")
        return 0
    except ValueError as exc:
        print(f"adopt_existing_admin: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

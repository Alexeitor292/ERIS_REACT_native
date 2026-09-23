"""Create the first administrator, or make an existing account one.

A production database starts with no accounts at all: ``database/init`` seeds
the roles and the organization structure only, and the mock accounts live in
``database/dev``, which production never loads. This is how the first person
gets in; everyone after them is added from the admin pages.

    python -m app.tools.create_admin --email jane.doe@dot.ca.gov --name "Jane Doe"
    python -m app.tools.create_admin --email jane.doe@dot.ca.gov --name "Jane Doe" --sso-only

Contract:
  * The password is read from a hidden prompt (asked twice), or from
    ``ERIS_ADMIN_PASSWORD`` for a non-interactive run. It is never a
    command-line argument, so it never lands in shell history or the process
    list, and it is never printed.
  * ``--sso-only`` creates the account with no password: password login refuses
    it, and it signs in through Entra ID once that is enabled.
  * Idempotent. An existing account is granted ADMIN and reactivated, its
    password changes only when one is given, and no other role is touched.
  * Refuses a ``mock.*`` address outside ``ENV=dev``: those are the development
    accounts, and one with administrator rights has no place in production.
"""

from __future__ import annotations

import argparse
import getpass
import os
import sys

from sqlalchemy import text

from ..auth import hash_password
from ..config import settings
from ..db import SessionLocal
from ..roles import ADMIN

MIN_PASSWORD_LENGTH = 12
PASSWORD_ENV = "ERIS_ADMIN_PASSWORD"


class AdminSetupError(Exception):
    """A refusal the operator can act on; printed without a traceback."""


def normalize_email(email: str) -> str:
    address = (email or "").strip().lower()
    local, at, domain = address.partition("@")
    if not local or not at or "." not in domain or " " in address:
        raise AdminSetupError(f"not an email address: {email!r}")
    return address


def check_password(password: str) -> str:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise AdminSetupError(f"the password must be at least {MIN_PASSWORD_LENGTH} characters")
    return password


def ensure_admin(db, *, email: str, full_name: str | None, password_hash: str | None) -> tuple[int, bool]:
    """Create the account or promote it, and grant ADMIN. Returns ``(user_id, created)``."""
    row = db.execute(text("SELECT id FROM users WHERE email = :e"), {"e": email}).first()
    created = row is None
    if created:
        if not (full_name or "").strip():
            raise AdminSetupError("--name is required to create a new account")
        db.execute(
            text("INSERT INTO users (email, full_name, password_hash, is_active) VALUES (:e, :n, :h, 1)"),
            {"e": email, "n": full_name.strip(), "h": password_hash},
        )
        user_id = int(db.execute(text("SELECT id FROM users WHERE email = :e"), {"e": email}).scalar())
    else:
        user_id = int(row[0])
        params = {"id": user_id}
        sets = ["is_active = 1"]
        if password_hash:
            sets.append("password_hash = :h")
            params["h"] = password_hash
        if (full_name or "").strip():
            sets.append("full_name = :n")
            params["n"] = full_name.strip()
        db.execute(text(f"UPDATE users SET {', '.join(sets)} WHERE id = :id"), params)

    db.execute(
        text("INSERT IGNORE INTO user_roles (user_id, role_id) SELECT :u, id FROM roles WHERE name = :r"),
        {"u": user_id, "r": ADMIN},
    )
    granted = db.execute(
        text(
            "SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id "
            "WHERE ur.user_id = :u AND r.name = :r"
        ),
        {"u": user_id, "r": ADMIN},
    ).first()
    if not granted:
        db.rollback()
        raise AdminSetupError("the ADMIN role does not exist: is the database at Alembic head?")
    db.commit()
    return user_id, created


def _read_password() -> str:
    from_env = os.environ.get(PASSWORD_ENV)
    if from_env is not None:
        return check_password(from_env)
    if not sys.stdin.isatty():
        raise AdminSetupError(f"no terminal to prompt on: set {PASSWORD_ENV}, or pass --sso-only")
    first = check_password(getpass.getpass("Password: "))
    if getpass.getpass("Repeat it: ") != first:
        raise AdminSetupError("the passwords do not match")
    return first


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m app.tools.create_admin",
        description="Create the first ERIS administrator, or make an existing account one.",
    )
    parser.add_argument("--email", required=True, help="the administrator's work email")
    parser.add_argument("--name", help="full name (required when the account is new)")
    parser.add_argument(
        "--sso-only",
        action="store_true",
        help="no password: the account signs in through Entra ID only",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    db = None
    try:
        email = normalize_email(args.email)
        if email.startswith("mock.") and settings.ENV.lower() != "dev":
            raise AdminSetupError("a mock.* account is a development account; refusing outside ENV=dev")
        password_hash = None if args.sso_only else hash_password(_read_password())
        db = SessionLocal()
        user_id, created = ensure_admin(db, email=email, full_name=args.name, password_hash=password_hash)
    except AdminSetupError as exc:
        print(f"create_admin: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001 - one line for the operator, not a traceback
        print(f"create_admin failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    finally:
        if db is not None:
            db.close()

    action = "Created" if created else "Updated"
    sign_in = "Entra ID only" if args.sso_only else "password"
    print(f"{action} administrator {email} (user {user_id}; sign-in: {sign_in}).")
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI entry
    raise SystemExit(main())

"""Seed a FICTIONAL demo roster into the org model. Never in CI, never in production.

`database/init/020_seed.sql` and Alembic revision `20260911_org_model` seed the
organization's STRUCTURE — offices, districts served, branches — and no people at
all, because no real employee name from any org chart may be stored (owner
decision 6). That leaves a demo with an empty picker: correct, and useless for
showing anyone what the org model does.

This script fills that gap with people who plainly do not exist. Every account is
a mock address, ``mock.demo.<name>@dot.ca.gov`` — the ``mock.`` prefix is what
keeps the notification service from ever handing one to a live relay — every
name is unambiguously invented, every position number uses the reserved ``9xx``
sequence so it cannot collide with a real one, and every profile row carries
``source = 'MANUAL'`` and ``notes = 'demo'`` so one DELETE finds them all:

    DELETE FROM users WHERE email LIKE 'mock.demo.%@dot.ca.gov';

Two guards, both deliberate: the flag has to be typed out in full, and the script
refuses outright when ``ENV`` is ``production``. It is idempotent — an account
that already exists is updated, never duplicated — and it grants ROLES, which is
the one thing the classification rules deliberately never do.

Usage, from ``backend/``::

    python scripts/seed_demo_org_roster.py --i-understand-this-is-demo-data
    python scripts/seed_demo_org_roster.py --i-understand-this-is-demo-data --password demo1234
    python scripts/seed_demo_org_roster.py --remove --i-understand-this-is-demo-data

The roster follows the design's enumeration (design §10): four office chiefs, six
branch chiefs, four Senior Specialists, eight Staff, one coordinator per WEST
district, one Maintenance Crew member and one Guest. That is 27 accounts —
the design's summary line says "twenty-four", which does not match its own
enumeration; the enumeration is what is implemented here, and the count is
printed at the end so nobody has to guess.
"""

from __future__ import annotations

import argparse
import os
import sys

# Run from backend/ (or anywhere): make `app` importable the way the tests do.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text  # noqa: E402

from app.auth import hash_password  # noqa: E402
from app.config import settings  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.roles import (  # noqa: E402
    BRANCH_CHIEF,
    GUEST,
    MAINTENANCE_COORDINATOR,
    MAINTENANCE_CREW,
    OFFICE_CHIEF,
    SENIOR_SPECIALIST,
    STAFF,
)
from app.services import org_directory  # noqa: E402
from app.user_metadata import user_metadata_json  # noqa: E402

DEMO_DOMAIN = "dot.ca.gov"
DEMO_PREFIX = "mock.demo."
DEMO_NOTE = "demo"

# name, role, office code, branch letter (None = no branch), home city,
# home district, classification code, marker, level, position sequence (9xx)
#
# The names are invented outright — no chart, no directory, no real person. The
# distribution mirrors the charts' SHAPE (a chief per office, branch chiefs in
# WEST and SOUTH, specialists sitting away from their office's home city) without
# reproducing anything from them.
_ROSTER: list[tuple] = [
    # -- Office chiefs: 3155 Supervising TE, level M09 -----------------------
    ("Ada Kessler", OFFICE_CHIEF, "WEST", None, "Oakland", "04", "3155", None, "M09", 901),
    ("Bo Nakamura", OFFICE_CHIEF, "NORTH", None, "Sacramento", None, "3155", None, "M09", 902),
    ("Cleo Ferrand", OFFICE_CHIEF, "SOUTH", None, "Los Angeles", "07", "3155", None, "M09", 903),
    ("Dov Ilyushin", OFFICE_CHIEF, "POLICY", None, "Sacramento", None, "3155", None, "M09", 904),
    # -- Branch chiefs: (Sup)-marked Senior TE / EG, level S09 --------------
    ("Esme Varga", BRANCH_CHIEF, "WEST", "A", "Oakland", "04", "3161", "SUP", "S09", 911),
    ("Faris Odum", BRANCH_CHIEF, "WEST", "C", "Oakland", "04", "3751", "SUP", "S09", 912),
    ("Greta Lindqvist", BRANCH_CHIEF, "WEST", "F", "Eureka", "01", "3161", "SUP", "S09", 913),
    ("Hana Bertoli", BRANCH_CHIEF, "SOUTH", "B", "San Diego", "11", "3161", "SUP", "S09", 914),
    ("Ivo Mkhize", BRANCH_CHIEF, "SOUTH", "C", "Santa Ana", "12", "3751", "SUP", "S09", 915),
    ("Juno Alvarado", BRANCH_CHIEF, "NORTH", "B", "Sacramento", None, "3161", "SUP", "S09", 916),
    # -- Senior specialists: (Spec), no branch, often away from home city ---
    ("Kai Lindstrom", SENIOR_SPECIALIST, "WEST", None, "San Luis Obispo", "05", "3161", "SPEC", "R09", 921),
    ("Lena Osei", SENIOR_SPECIALIST, "NORTH", None, "Redding", "02", "3751", "SPEC", "R09", 922),
    ("Mika Ferreira", SENIOR_SPECIALIST, "SOUTH", None, "San Bernardino", "08", "3375", "SPEC", "R09", 923),
    ("Nils Auberon", SENIOR_SPECIALIST, "POLICY", None, "Sacramento", None, "3185", "SPEC", "R09", 924),
    # -- Staff: everyone under a branch chief -------------------------------
    ("Orla Petrosyan", STAFF, "WEST", "A", "Oakland", "04", "3135", None, "R09", 931),
    ("Pax Redgrave", STAFF, "WEST", "A", "Orinda", "04", "3756", None, "R09", 932),
    ("Quill Baptiste", STAFF, "WEST", "C", "Oakland", "04", "3175", None, "R11", 933),
    ("Rina Solheim", STAFF, "WEST", "F", "Eureka", "01", "3135", None, "R09", 934),
    ("Soren Achebe", STAFF, "SOUTH", "B", "San Diego", "11", "3135", None, "R09", 935),
    ("Tova Marchetti", STAFF, "SOUTH", "C", "Santa Ana", "12", "3381", None, "R11", 936),
    ("Ues Kowalczyk", STAFF, "NORTH", "B", "Sacramento", None, "3756", None, "R09", 937),
    ("Vero Tanaka", STAFF, "NORTH", "B", "Sacramento", None, "3135", None, "R09", 938),
    # -- Maintenance: one coordinator per district WEST serves, one reporter -
    ("Wren Oduya", MAINTENANCE_COORDINATOR, None, None, "Eureka", "01", None, None, None, 941),
    ("Xan Belova", MAINTENANCE_COORDINATOR, None, None, "Oakland", "04", None, None, None, 942),
    ("Yara Quintero", MAINTENANCE_COORDINATOR, None, None, "San Luis Obispo", "05", None, None, None, 943),
    ("Zeno Halloran", MAINTENANCE_CREW, None, None, "Oakland", "04", None, None, None, 944),
    # -- Guest: read-only, statewide, no org link --------------------------
    ("Ines Vanterpool", GUEST, None, None, None, None, "5393", None, "R01", 951),
]


def _email_for(full_name: str) -> str:
    slug = full_name.lower().replace(" ", ".")
    return f"{DEMO_PREFIX}{slug}@{DEMO_DOMAIN}"


def _position_number(office_code: str | None, class_code: str | None, sequence: int) -> str | None:
    """A position number shaped like the charts' but in the reserved 9xx range."""
    if not class_code:
        return None
    unit = {"WEST": "559-315", "NORTH": "559-323", "SOUTH": "559-324", "POLICY": "559-325"}.get(
        office_code or "", "559-000"
    )
    return f"{unit}-{class_code}-{sequence}"


def _remove(db) -> int:
    result = db.execute(
        text("DELETE FROM users WHERE email LIKE :pattern"),
        {"pattern": f"{DEMO_PREFIX}%@{DEMO_DOMAIN}"},
    )
    db.commit()
    return int(result.rowcount or 0)


def _seed(db, password: str) -> int:
    password_hash = hash_password(password)
    count = 0
    for (full_name, role, office_code, branch_letter, home_city, home_district,
         class_code, marker, level_code, sequence) in _ROSTER:
        email = _email_for(full_name)
        metadata = user_metadata_json({"office_code": office_code, "district": home_district})
        db.execute(
            text(
                """
                INSERT INTO users (email, full_name, password_hash, metadata_json, is_active)
                VALUES (:email, :full_name, :password_hash, :metadata, 1)
                ON DUPLICATE KEY UPDATE
                  full_name = VALUES(full_name),
                  password_hash = VALUES(password_hash),
                  metadata_json = VALUES(metadata_json),
                  is_active = VALUES(is_active)
                """
            ),
            {
                "email": email,
                "full_name": full_name,
                "password_hash": password_hash,
                "metadata": metadata,
            },
        )
        user_id = int(
            db.execute(text("SELECT id FROM users WHERE email = :email"), {"email": email}).scalar()
        )
        db.execute(
            text(
                """
                INSERT IGNORE INTO user_roles (user_id, role_id)
                SELECT :uid, r.id FROM roles r WHERE r.name = :role
                """
            ),
            {"uid": user_id, "role": role},
        )
        office = org_directory.office_by_code(db, office_code) if office_code else None
        branch_id = None
        if office and branch_letter:
            branch_id = db.execute(
                text(
                    """
                    SELECT id FROM org_branches
                     WHERE office_id = :oid AND unit_type = 'BRANCH' AND letter = :letter
                     LIMIT 1
                    """
                ),
                {"oid": office["id"], "letter": branch_letter},
            ).scalar()
        db.execute(
            text(
                """
                INSERT INTO org_user_profiles
                  (user_id, office_id, branch_id, home_city, home_district,
                   classification_code, classification_marker, position_number,
                   job_title, level_code, availability, source, notes)
                VALUES
                  (:uid, :office_id, :branch_id, :home_city, :home_district,
                   :class_code, :marker, :position_number,
                   :job_title, :level_code, 'AVAILABLE', 'MANUAL', :note)
                ON DUPLICATE KEY UPDATE
                  office_id = VALUES(office_id),
                  branch_id = VALUES(branch_id),
                  home_city = VALUES(home_city),
                  home_district = VALUES(home_district),
                  classification_code = VALUES(classification_code),
                  classification_marker = VALUES(classification_marker),
                  position_number = VALUES(position_number),
                  job_title = VALUES(job_title),
                  level_code = VALUES(level_code),
                  source = VALUES(source),
                  notes = VALUES(notes)
                """
            ),
            {
                "uid": user_id,
                "office_id": office["id"] if office else None,
                "branch_id": int(branch_id) if branch_id is not None else None,
                "home_city": home_city,
                "home_district": home_district,
                "class_code": class_code,
                "marker": marker,
                "position_number": _position_number(office_code, class_code, sequence),
                "job_title": _job_title(db, class_code, marker),
                "level_code": level_code,
                "note": DEMO_NOTE,
            },
        )
        # A branch chief who is nobody's chief demonstrates nothing, so the demo
        # data — and ONLY the demo data — names one per branch. The structural
        # seed never does: roles are never bound to named people (decision 8).
        if role == BRANCH_CHIEF and branch_id is not None:
            db.execute(
                text("UPDATE org_branches SET chief_user_id = :uid WHERE id = :bid"),
                {"uid": user_id, "bid": int(branch_id)},
            )
        if role == MAINTENANCE_COORDINATOR and home_district:
            db.execute(
                text(
                    """
                    INSERT INTO org_coordinator_coverage (district, user_id, is_primary, is_active)
                    VALUES (:district, :uid, 1, 1)
                    ON DUPLICATE KEY UPDATE is_primary = VALUES(is_primary), is_active = VALUES(is_active)
                    """
                ),
                {"district": home_district, "uid": user_id},
            )
        count += 1
    db.commit()
    return count


def _job_title(db, class_code: str | None, marker: str | None) -> str | None:
    """The printed title for a classification, read from the seeded rules.

    Titles live in ``org_classifications`` because the classification -> role
    rules are data (decision 8); duplicating them here would be a fourth copy of
    a fact that already has a home.
    """
    if not class_code:
        return None
    return db.execute(
        text(
            """
            SELECT title FROM org_classifications
             WHERE rule_kind = 'CLASS' AND class_code = :code AND marker = :marker
             LIMIT 1
            """
        ),
        {"code": class_code, "marker": marker or ""},
    ).scalar()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--i-understand-this-is-demo-data",
        dest="acknowledged",
        action="store_true",
        help="required: this writes invented accounts into the database",
    )
    parser.add_argument("--password", default="password", help="password for every demo account")
    parser.add_argument(
        "--remove",
        action="store_true",
        help=f"delete every {DEMO_PREFIX}*@{DEMO_DOMAIN} account instead of seeding",
    )
    args = parser.parse_args()

    if str(getattr(settings, "ENV", "")).strip().lower() in {"production", "prod"}:
        print("REFUSING: ENV is production. This script seeds invented people.", file=sys.stderr)
        return 2
    if not args.acknowledged:
        print(
            "REFUSING: pass --i-understand-this-is-demo-data. Every account this "
            f"creates is fictional and lives at {DEMO_PREFIX}*@{DEMO_DOMAIN}.",
            file=sys.stderr,
        )
        return 2

    db = SessionLocal()
    try:
        if args.remove:
            removed = _remove(db)
            print(f"Removed {removed} demo account(s) at {DEMO_PREFIX}*@{DEMO_DOMAIN}.")
            return 0
        seeded = _seed(db, args.password)
        print(
            f"Seeded {seeded} fictional account(s) at {DEMO_PREFIX}*@{DEMO_DOMAIN} "
            f"(password: {args.password!r}). Remove them with --remove, or:\n"
            f"  DELETE FROM users WHERE email LIKE '{DEMO_PREFIX}%@{DEMO_DOMAIN}';"
        )
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())

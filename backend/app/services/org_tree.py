"""Where people sit, and the roles that follow from it.

Each GeoTech office is a tree: office chief(s) at the top; under them senior
specialists (leaves) and branches; under each branch its chief and staff.
Maintenance is a list per district: coordinators and crew.

A person's work roles are DERIVED from those places and written to
``user_roles`` whenever a place changes (``sync_roles``), so every guard and
scope in the system keeps reading ``user_roles`` exactly as before:

- tree position OFFICE_CHIEF / SENIOR_SPECIALIST / BRANCH_CHIEF / STAFF -> that role;
- an active coordinator row in any district -> MAINTENANCE_COORDINATOR;
- an active crew row in any district -> MAINTENANCE_CREW;
- ADMIN is the one role granted directly (Users page), and kept;
- nobody placed anywhere, and not an administrator -> GUEST.

Who may change what (``can_*``): administrators everything; an office chief
their own office's tree, except its office chiefs; a branch chief the staff of
their own branch. Moving somebody out of another office, or moving an office
chief, is for administrators. Callers commit.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session

from ..user_metadata import normalize_district_code
from . import org_directory

POSITIONS = ("OFFICE_CHIEF", "SENIOR_SPECIALIST", "BRANCH_CHIEF", "STAFF")
POSITION_LABELS = {
    "OFFICE_CHIEF": "Office Chief",
    "SENIOR_SPECIALIST": "Senior Specialist",
    "BRANCH_CHIEF": "Branch Chief",
    "STAFF": "Staff",
}
DISTRICTS = tuple(f"{n:02d}" for n in range(1, 13))
TREE_ROLES = set(POSITIONS) | {"MAINTENANCE_COORDINATOR", "MAINTENANCE_CREW"}


class OrgTreeError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------------------
# Roles
# ---------------------------------------------------------------------------


def _roles_held(db: Session, user_id: int) -> set[str]:
    return set(
        db.execute(
            text("SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = :uid"),
            {"uid": int(user_id)},
        ).scalars().all()
    )


def derived_roles(db: Session, user_id: int) -> set[str]:
    """The roles this person's places give them (ADMIN kept if already held)."""
    roles: set[str] = set()
    position = db.execute(
        text("SELECT tree_position FROM org_user_profiles WHERE user_id = :uid AND office_id IS NOT NULL"),
        {"uid": int(user_id)},
    ).scalar()
    if position in POSITIONS:
        roles.add(str(position))
    if db.execute(
        text("SELECT 1 FROM org_coordinator_coverage WHERE user_id = :uid AND is_active = 1 LIMIT 1"),
        {"uid": int(user_id)},
    ).scalar():
        roles.add("MAINTENANCE_COORDINATOR")
    if db.execute(
        text("SELECT 1 FROM org_district_crew WHERE user_id = :uid AND is_active = 1 LIMIT 1"),
        {"uid": int(user_id)},
    ).scalar():
        roles.add("MAINTENANCE_CREW")
    if "ADMIN" in _roles_held(db, user_id):
        roles.add("ADMIN")
    if not roles:
        roles.add("GUEST")
    return roles


def sync_roles(db: Session, user_id: int) -> set[str]:
    """Rewrite ``user_roles`` to exactly the derived set. Caller commits."""
    roles = derived_roles(db, user_id)
    ids = db.execute(
        text("SELECT id, name FROM roles WHERE name IN :names").bindparams(bindparam("names", expanding=True)),
        {"names": sorted(roles)},
    ).mappings().all()
    missing = roles - {row["name"] for row in ids}
    if missing:
        raise OrgTreeError(500, f"Roles missing from the roles table: {', '.join(sorted(missing))}")
    db.execute(text("DELETE FROM user_roles WHERE user_id = :uid"), {"uid": int(user_id)})
    for row in ids:
        db.execute(
            text("INSERT INTO user_roles (user_id, role_id) VALUES (:uid, :rid)"),
            {"uid": int(user_id), "rid": int(row["id"])},
        )
    return roles


def set_admin(db: Session, *, actor_id: int, user_id: int, is_admin: bool) -> set[str]:
    """Grant or remove ADMIN, then re-derive. Refuses to strand the system without one."""
    if not db.execute(text("SELECT 1 FROM users WHERE id = :uid"), {"uid": int(user_id)}).scalar():
        raise OrgTreeError(404, "User not found.")
    held = _roles_held(db, user_id)
    if not is_admin and "ADMIN" in held:
        if int(user_id) == int(actor_id):
            raise OrgTreeError(409, "You cannot remove your own administrator access.")
        others = db.execute(
            text(
                """
                SELECT COUNT(*) FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                  JOIN users u ON u.id = ur.user_id
                 WHERE r.name = 'ADMIN' AND u.is_active = 1 AND u.id <> :uid
                """
            ),
            {"uid": int(user_id)},
        ).scalar()
        if not others:
            raise OrgTreeError(409, "This is the last administrator.")
    admin_id = db.execute(text("SELECT id FROM roles WHERE name = 'ADMIN'")).scalar()
    db.execute(
        text("DELETE FROM user_roles WHERE user_id = :uid AND role_id = :rid"),
        {"uid": int(user_id), "rid": int(admin_id)},
    )
    if is_admin:
        db.execute(
            text("INSERT INTO user_roles (user_id, role_id) VALUES (:uid, :rid)"),
            {"uid": int(user_id), "rid": int(admin_id)},
        )
    return sync_roles(db, user_id)


# ---------------------------------------------------------------------------
# Reading places
# ---------------------------------------------------------------------------


def placement(db: Session, user_id: int) -> dict[str, Any]:
    """Where one person sits in the office trees (all None when nowhere)."""
    row = db.execute(
        text(
            """
            SELECT p.tree_position, p.office_id, p.branch_id,
                   o.code AS office_code, o.name AS office_name, o.short_name AS office_short_name,
                   b.letter AS branch_letter, b.name AS branch_name
              FROM org_user_profiles p
              LEFT JOIN org_offices o ON o.id = p.office_id
              LEFT JOIN org_branches b ON b.id = p.branch_id
             WHERE p.user_id = :uid
            """
        ),
        {"uid": int(user_id)},
    ).mappings().first()
    if not row or not row["tree_position"] or row["office_id"] is None:
        return {"position": None, "office_id": None, "branch_id": None, "office_code": None, "label": None}
    where = row["office_short_name"] or row["office_name"] or row["office_code"]
    if row["branch_id"]:
        where = f"{where} › {row['branch_name'] or 'Branch ' + str(row['branch_letter'])}"
    return {
        "position": row["tree_position"],
        "office_id": int(row["office_id"]),
        "branch_id": int(row["branch_id"]) if row["branch_id"] else None,
        "office_code": row["office_code"],
        "label": f"{POSITION_LABELS[row['tree_position']]} · {where}",
    }


def maintenance_places(db: Session, user_id: int) -> dict[str, list[str]]:
    coordinator = db.execute(
        text("SELECT district FROM org_coordinator_coverage WHERE user_id = :uid AND is_active = 1 ORDER BY district"),
        {"uid": int(user_id)},
    ).scalars().all()
    crew = db.execute(
        text("SELECT district FROM org_district_crew WHERE user_id = :uid AND is_active = 1 ORDER BY district"),
        {"uid": int(user_id)},
    ).scalars().all()
    return {"coordinator": [str(d).strip() for d in coordinator], "crew": [str(d).strip() for d in crew]}


def places_for_users(db: Session, user_ids: list[int]) -> dict[int, list[str]]:
    """Every place each person sits, as short labels: "Staff · West › Branch A", "Crew · D4"."""
    if not user_ids:
        return {}
    out: dict[int, list[str]] = {}
    ids = bindparam("ids", expanding=True)
    rows = db.execute(
        text(
            """
            SELECT p.user_id, p.tree_position, o.code, o.short_name, o.name, b.letter, b.name AS branch_name
              FROM org_user_profiles p
              JOIN org_offices o ON o.id = p.office_id
              LEFT JOIN org_branches b ON b.id = p.branch_id
             WHERE p.tree_position IS NOT NULL AND p.user_id IN :ids
            """
        ).bindparams(ids),
        {"ids": list(user_ids)},
    ).mappings().all()
    for row in rows:
        where = row["short_name"] or row["name"] or row["code"]
        if row["branch_name"] or row["letter"]:
            where = f"{where} › {row['branch_name'] or 'Branch ' + str(row['letter'])}"
        out.setdefault(int(row["user_id"]), []).append(f"{POSITION_LABELS[row['tree_position']]} · {where}")
    for table, label in (("org_coordinator_coverage", "Coordinator"), ("org_district_crew", "Crew")):
        rows = db.execute(
            text(f"SELECT user_id, district FROM {table} WHERE is_active = 1 AND user_id IN :ids ORDER BY district").bindparams(
                bindparam("ids", expanding=True)
            ),
            {"ids": list(user_ids)},
        ).mappings().all()
        by_user: dict[int, list[str]] = {}
        for row in rows:
            by_user.setdefault(int(row["user_id"]), []).append(f"D{int(str(row['district']).strip())}")
        for uid, districts in by_user.items():
            out.setdefault(uid, []).append(f"{label} · {', '.join(districts)}")
    return out


def _person_rows(db: Session, where: str, params: dict) -> list[dict]:
    rows = db.execute(
        text(
            f"""
            SELECT u.id, u.full_name, u.email, u.is_active,
                   p.tree_position, p.office_id, p.branch_id, p.availability, p.available_until
              FROM users u
              JOIN org_user_profiles p ON p.user_id = u.id
             WHERE {where}
             ORDER BY u.full_name, u.id
            """
        ),
        params,
    ).mappings().all()
    return [_person(dict(row)) for row in rows]


def _person(row: dict) -> dict:
    until = row.get("available_until")
    return {
        "id": int(row["id"]),
        "full_name": row.get("full_name") or row.get("email"),
        "email": row.get("email"),
        "is_active": bool(row.get("is_active", 1)),
        "position": row.get("tree_position"),
        "availability": row.get("availability") or "AVAILABLE",
        "available_until": until.isoformat() if hasattr(until, "isoformat") else until,
    }


def office_tree(db: Session, office_id: int) -> dict[str, Any] | None:
    office = db.execute(
        text(
            """
            SELECT id, code, name, short_name, unit_number, home_city, home_district,
                   is_routing_target, is_active, sort_order
              FROM org_offices WHERE id = :oid AND org_type = 'GEOTECH'
            """
        ),
        {"oid": int(office_id)},
    ).mappings().first()
    if not office:
        return None
    districts = db.execute(
        text("SELECT district FROM org_office_districts WHERE office_id = :oid AND is_active = 1 ORDER BY district"),
        {"oid": int(office_id)},
    ).scalars().all()
    people = _person_rows(db, "p.office_id = :oid AND p.tree_position IS NOT NULL AND u.is_active = 1", {"oid": int(office_id)})
    branches = db.execute(
        text(
            """
            SELECT id, letter, name, home_city, home_district, chief_user_id, accepts_assignments, sort_order
              FROM org_branches
             WHERE office_id = :oid AND is_active = 1
             ORDER BY sort_order, letter, name
            """
        ),
        {"oid": int(office_id)},
    ).mappings().all()
    branch_ids = {int(b["id"]) for b in branches}
    by_id = {p["id"]: p for p in people}
    raw_positions = db.execute(
        text("SELECT user_id, branch_id FROM org_user_profiles WHERE office_id = :oid AND tree_position IS NOT NULL"),
        {"oid": int(office_id)},
    ).mappings().all()
    branch_of = {int(r["user_id"]): (int(r["branch_id"]) if r["branch_id"] else None) for r in raw_positions}

    def branch_node(b) -> dict:
        bid = int(b["id"])
        chief = next((p for p in people if p["position"] == "BRANCH_CHIEF" and branch_of.get(p["id"]) == bid), None)
        if chief is None and b["chief_user_id"] and int(b["chief_user_id"]) in by_id:
            chief = by_id[int(b["chief_user_id"])]
        return {
            "id": bid,
            "letter": b["letter"],
            "name": b["name"],
            "home_city": b["home_city"],
            "home_district": (str(b["home_district"]).strip() if b["home_district"] else None),
            "accepts_assignments": bool(b["accepts_assignments"]),
            "chief": chief,
            "staff": [p for p in people if p["position"] == "STAFF" and branch_of.get(p["id"]) == bid],
        }

    return {
        "office": {
            "id": int(office["id"]),
            "code": office["code"],
            "name": office["name"],
            "short_name": office["short_name"],
            "unit_number": office["unit_number"],
            "home_city": office["home_city"],
            "home_district": (str(office["home_district"]).strip() if office["home_district"] else None),
            "is_routing_target": bool(office["is_routing_target"]),
            "is_active": bool(office["is_active"]),
            "districts": [str(d).strip() for d in districts],
        },
        "chiefs": [p for p in people if p["position"] == "OFFICE_CHIEF"],
        "specialists": [p for p in people if p["position"] == "SENIOR_SPECIALIST"],
        "branches": [branch_node(b) for b in branches],
        # Staff and branch chiefs whose branch is missing or retired: shown so they can be placed.
        "unbranched": [
            p for p in people
            if p["position"] in ("STAFF", "BRANCH_CHIEF") and branch_of.get(p["id"]) not in branch_ids
        ],
    }


def unplaced_role_holders(db: Session) -> dict[str, list[dict]]:
    """People who hold a place-derived role but sit nowhere that gives it (pre-tree data)."""
    geotech = db.execute(
        text(
            """
            SELECT DISTINCT u.id, u.full_name, u.email, r.name AS role
              FROM users u
              JOIN user_roles ur ON ur.user_id = u.id
              JOIN roles r ON r.id = ur.role_id
              LEFT JOIN org_user_profiles p ON p.user_id = u.id
             WHERE u.is_active = 1
               AND r.name IN ('OFFICE_CHIEF','SENIOR_SPECIALIST','BRANCH_CHIEF','STAFF')
               AND (p.tree_position IS NULL OR p.office_id IS NULL)
             ORDER BY u.full_name
            """
        )
    ).mappings().all()
    maintenance = db.execute(
        text(
            """
            SELECT DISTINCT u.id, u.full_name, u.email, r.name AS role
              FROM users u
              JOIN user_roles ur ON ur.user_id = u.id
              JOIN roles r ON r.id = ur.role_id
             WHERE u.is_active = 1
               AND ((r.name = 'MAINTENANCE_COORDINATOR'
                     AND NOT EXISTS (SELECT 1 FROM org_coordinator_coverage c WHERE c.user_id = u.id AND c.is_active = 1))
                 OR (r.name = 'MAINTENANCE_CREW'
                     AND NOT EXISTS (SELECT 1 FROM org_district_crew c WHERE c.user_id = u.id AND c.is_active = 1)))
             ORDER BY u.full_name
            """
        )
    ).mappings().all()
    as_list = lambda rows: [{"id": int(r["id"]), "full_name": r["full_name"] or r["email"], "email": r["email"], "role": r["role"]} for r in rows]  # noqa: E731
    return {"geotech": as_list(geotech), "maintenance": as_list(maintenance)}


def maintenance_lists(db: Session) -> list[dict]:
    rows = db.execute(
        text(
            """
            SELECT 'COORDINATOR' AS kind, c.district, c.is_primary, u.id, u.full_name, u.email, u.is_active
              FROM org_coordinator_coverage c JOIN users u ON u.id = c.user_id
             WHERE c.is_active = 1 AND u.is_active = 1
            UNION ALL
            SELECT 'CREW' AS kind, w.district, 0 AS is_primary, u.id, u.full_name, u.email, u.is_active
              FROM org_district_crew w JOIN users u ON u.id = w.user_id
             WHERE w.is_active = 1 AND u.is_active = 1
            ORDER BY full_name
            """
        )
    ).mappings().all()
    by_district = {d: {"district": d, "coordinators": [], "crew": []} for d in DISTRICTS}
    for row in rows:
        district = str(row["district"]).strip()
        entry = by_district.setdefault(district, {"district": district, "coordinators": [], "crew": []})
        person = {"id": int(row["id"]), "full_name": row["full_name"] or row["email"], "email": row["email"]}
        if row["kind"] == "COORDINATOR":
            entry["coordinators"].append({**person, "is_primary": bool(row["is_primary"])})
        else:
            entry["crew"].append(person)
    return [by_district[d] for d in sorted(by_district)]


def search_people(db: Session, query: str, limit: int = 20) -> list[dict]:
    like = f"%{(query or '').strip()}%"
    rows = db.execute(
        text(
            """
            SELECT u.id, u.full_name, u.email
              FROM users u
             WHERE u.is_active = 1 AND (u.full_name LIKE :q OR u.email LIKE :q)
             ORDER BY u.full_name, u.email
             LIMIT :lim
            """
        ),
        {"q": like, "lim": int(limit)},
    ).mappings().all()
    out = []
    for row in rows:
        uid = int(row["id"])
        out.append({
            "id": uid,
            "full_name": row["full_name"] or row["email"],
            "email": row["email"],
            "placement": placement(db, uid),
            "maintenance": maintenance_places(db, uid),
            "roles": sorted(_roles_held(db, uid)),
            "is_admin": "ADMIN" in _roles_held(db, uid),
        })
    return out


# ---------------------------------------------------------------------------
# Permissions
# ---------------------------------------------------------------------------


def is_admin(actor: dict) -> bool:
    return "ADMIN" in set(actor.get("roles") or [])


def _office(db: Session, office_id: int) -> dict | None:
    row = db.execute(
        text("SELECT id, code, name, short_name, is_active FROM org_offices WHERE id = :oid AND org_type = 'GEOTECH'"),
        {"oid": int(office_id)},
    ).mappings().first()
    return dict(row) if row else None


def _branch(db: Session, branch_id: int) -> dict | None:
    row = db.execute(
        text("SELECT id, office_id, letter, name, chief_user_id, is_active FROM org_branches WHERE id = :bid"),
        {"bid": int(branch_id)},
    ).mappings().first()
    return dict(row) if row else None


def can_manage_office(db: Session, actor: dict, office_id: int) -> bool:
    if is_admin(actor):
        return True
    mine = placement(db, int(actor["id"]))
    return mine["position"] == "OFFICE_CHIEF" and mine["office_id"] == int(office_id)


def can_manage_branch(db: Session, actor: dict, branch: dict) -> bool:
    if can_manage_office(db, actor, int(branch["office_id"])):
        return True
    mine = placement(db, int(actor["id"]))
    return mine["position"] == "BRANCH_CHIEF" and mine["branch_id"] == int(branch["id"])


def offices_visible_to(db: Session, actor: dict) -> list[int]:
    """Administrators see every office; chiefs see their own."""
    if is_admin(actor):
        return [int(i) for i in db.execute(
            text("SELECT id FROM org_offices WHERE org_type = 'GEOTECH' AND is_active = 1 ORDER BY sort_order, name")
        ).scalars().all()]
    mine = placement(db, int(actor["id"]))
    if mine["position"] in ("OFFICE_CHIEF", "BRANCH_CHIEF") and mine["office_id"]:
        return [mine["office_id"]]
    return []


def _check_movable(db: Session, actor: dict, user_id: int, *, office_id: int, branch_chief_adding: bool = False) -> dict:
    """The person may be (re)placed in `office_id` by this actor; returns their current place."""
    if not db.execute(text("SELECT 1 FROM users WHERE id = :uid AND is_active = 1"), {"uid": int(user_id)}).scalar():
        raise OrgTreeError(404, "That person is not an active ERIS user.")
    current = placement(db, int(user_id))
    if current["position"] is None or is_admin(actor):
        return current
    if current["office_id"] != int(office_id):
        raise OrgTreeError(409, f"{current['label']}. Only an administrator can move people between offices.")
    if current["position"] == "OFFICE_CHIEF":
        raise OrgTreeError(409, "Only an administrator can move an office chief.")
    if branch_chief_adding:
        raise OrgTreeError(409, f"{current['label']}. Ask your office chief to move them into your branch.")
    return current


# ---------------------------------------------------------------------------
# Changing places
# ---------------------------------------------------------------------------


def _set_place(db: Session, user_id: int, *, office_id: int | None, branch_id: int | None, position: str | None) -> set[int]:
    """Write one person's place; returns everybody whose roles need re-deriving."""
    touched = {int(user_id)}
    # Leaving a branch they led empties its chief slot.
    db.execute(
        text("UPDATE org_branches SET chief_user_id = NULL WHERE chief_user_id = :uid AND (:bid IS NULL OR id <> :bid OR :pos <> 'BRANCH_CHIEF')"),
        {"uid": int(user_id), "bid": branch_id, "pos": position or ""},
    )
    if position == "BRANCH_CHIEF" and branch_id is not None:
        previous = db.execute(
            text("SELECT chief_user_id FROM org_branches WHERE id = :bid"), {"bid": int(branch_id)}
        ).scalar()
        if previous and int(previous) != int(user_id):
            # The chief being replaced stays in the branch, as staff.
            db.execute(
                text("UPDATE org_user_profiles SET tree_position = 'STAFF' WHERE user_id = :prev AND branch_id = :bid"),
                {"prev": int(previous), "bid": int(branch_id)},
            )
            touched.add(int(previous))
        db.execute(
            text("UPDATE org_branches SET chief_user_id = :uid WHERE id = :bid"),
            {"uid": int(user_id), "bid": int(branch_id)},
        )
    db.execute(
        text("INSERT IGNORE INTO org_user_profiles (user_id, source) VALUES (:uid, 'MANUAL')"), {"uid": int(user_id)}
    )
    db.execute(
        text(
            """
            UPDATE org_user_profiles
               SET office_id = :oid, branch_id = :bid, tree_position = :pos, source = 'MANUAL', updated_at = NOW()
             WHERE user_id = :uid
            """
        ),
        {"oid": office_id, "bid": branch_id, "pos": position, "uid": int(user_id)},
    )
    org_directory.mirror_metadata_from_profile(db, int(user_id), clear_office=office_id is None)
    return touched


def _sync(db: Session, users: set[int]) -> None:
    for uid in users:
        sync_roles(db, uid)


def add_office_chief(db: Session, actor: dict, *, office_id: int, user_id: int) -> None:
    if not is_admin(actor):
        raise OrgTreeError(403, "Only an administrator can name an office chief.")
    if not _office(db, office_id):
        raise OrgTreeError(404, "Office not found.")
    _check_movable(db, actor, user_id, office_id=office_id)
    _sync(db, _set_place(db, user_id, office_id=office_id, branch_id=None, position="OFFICE_CHIEF"))


def add_specialist(db: Session, actor: dict, *, office_id: int, user_id: int) -> None:
    if not _office(db, office_id):
        raise OrgTreeError(404, "Office not found.")
    if not can_manage_office(db, actor, office_id):
        raise OrgTreeError(403, "Only this office's chief or an administrator can add a senior specialist.")
    _check_movable(db, actor, user_id, office_id=office_id)
    _sync(db, _set_place(db, user_id, office_id=office_id, branch_id=None, position="SENIOR_SPECIALIST"))


def set_branch_chief(db: Session, actor: dict, *, branch_id: int, user_id: int) -> None:
    branch = _branch(db, branch_id)
    if not branch or not branch["is_active"]:
        raise OrgTreeError(404, "Branch not found.")
    if not can_manage_office(db, actor, int(branch["office_id"])):
        raise OrgTreeError(403, "Only this office's chief or an administrator can name a branch chief.")
    _check_movable(db, actor, user_id, office_id=int(branch["office_id"]))
    _sync(db, _set_place(db, user_id, office_id=int(branch["office_id"]), branch_id=int(branch_id), position="BRANCH_CHIEF"))


def add_staff(db: Session, actor: dict, *, branch_id: int, user_id: int) -> None:
    branch = _branch(db, branch_id)
    if not branch or not branch["is_active"]:
        raise OrgTreeError(404, "Branch not found.")
    if not can_manage_branch(db, actor, branch):
        raise OrgTreeError(403, "Only this branch's chief, the office chief or an administrator can add staff here.")
    office_level = can_manage_office(db, actor, int(branch["office_id"]))
    _check_movable(db, actor, user_id, office_id=int(branch["office_id"]), branch_chief_adding=not office_level)
    _sync(db, _set_place(db, user_id, office_id=int(branch["office_id"]), branch_id=int(branch_id), position="STAFF"))


def remove_from_tree(db: Session, actor: dict, *, user_id: int) -> None:
    current = placement(db, user_id)
    if current["position"] is None:
        raise OrgTreeError(404, "That person is not in an office tree.")
    allowed = is_admin(actor)
    if not allowed and current["position"] != "OFFICE_CHIEF":
        if can_manage_office(db, actor, current["office_id"]):
            allowed = True
        elif current["position"] == "STAFF" and current["branch_id"]:
            branch = _branch(db, current["branch_id"])
            allowed = bool(branch) and can_manage_branch(db, actor, branch) and int(user_id) != int(actor["id"])
    if not allowed:
        raise OrgTreeError(403, "You cannot remove this person from the tree.")
    _sync(db, _set_place(db, user_id, office_id=None, branch_id=None, position=None))


def create_branch(db: Session, actor: dict, *, office_id: int, name: str, letter: str | None, home_city: str | None, home_district: str | None) -> int:
    if not _office(db, office_id):
        raise OrgTreeError(404, "Office not found.")
    if not can_manage_office(db, actor, office_id):
        raise OrgTreeError(403, "Only this office's chief or an administrator can add a branch.")
    letter = (letter or "").strip().upper() or None
    name = (name or "").strip() or (f"Branch {letter}" if letter else "")
    if not name:
        raise OrgTreeError(422, "A branch needs a name or a letter.")
    if letter and db.execute(
        text("SELECT 1 FROM org_branches WHERE office_id = :oid AND letter = :letter AND is_active = 1"),
        {"oid": int(office_id), "letter": letter},
    ).scalar():
        raise OrgTreeError(409, f"Branch {letter} already exists in this office.")
    order = db.execute(
        text("SELECT COALESCE(MAX(sort_order), 0) + 10 FROM org_branches WHERE office_id = :oid"), {"oid": int(office_id)}
    ).scalar()
    result = db.execute(
        text(
            """
            INSERT INTO org_branches (office_id, unit_type, letter, name, home_city, home_district, accepts_assignments, is_active, sort_order)
            VALUES (:oid, 'BRANCH', :letter, :name, :city, :district, 1, 1, :order)
            """
        ),
        {"oid": int(office_id), "letter": letter, "name": name, "city": (home_city or "").strip() or None,
         "district": normalize_district_code(home_district), "order": int(order)},
    )
    return int(result.lastrowid)


def update_branch(db: Session, actor: dict, *, branch_id: int, fields: dict) -> None:
    branch = _branch(db, branch_id)
    if not branch or not branch["is_active"]:
        raise OrgTreeError(404, "Branch not found.")
    if not can_manage_office(db, actor, int(branch["office_id"])):
        raise OrgTreeError(403, "Only this office's chief or an administrator can change a branch.")
    sets, params = [], {"bid": int(branch_id)}
    if "letter" in fields:
        letter = (fields["letter"] or "").strip().upper() or None
        if letter and db.execute(
            text("SELECT 1 FROM org_branches WHERE office_id = :oid AND letter = :letter AND is_active = 1 AND id <> :bid"),
            {"oid": int(branch["office_id"]), "letter": letter, "bid": int(branch_id)},
        ).scalar():
            raise OrgTreeError(409, f"Branch {letter} already exists in this office.")
        sets.append("letter = :letter")
        params["letter"] = letter
    if "name" in fields:
        name = (fields["name"] or "").strip()
        if not name:
            raise OrgTreeError(422, "A branch needs a name.")
        sets.append("name = :name")
        params["name"] = name
    if "home_city" in fields:
        sets.append("home_city = :city")
        params["city"] = (fields["home_city"] or "").strip() or None
    if "home_district" in fields:
        sets.append("home_district = :district")
        params["district"] = normalize_district_code(fields["home_district"])
    if sets:
        db.execute(text(f"UPDATE org_branches SET {', '.join(sets)}, updated_at = NOW() WHERE id = :bid"), params)


def retire_branch(db: Session, actor: dict, *, branch_id: int) -> None:
    branch = _branch(db, branch_id)
    if not branch or not branch["is_active"]:
        raise OrgTreeError(404, "Branch not found.")
    if not can_manage_office(db, actor, int(branch["office_id"])):
        raise OrgTreeError(403, "Only this office's chief or an administrator can retire a branch.")
    members = db.execute(
        text("SELECT COUNT(*) FROM org_user_profiles WHERE branch_id = :bid AND tree_position IS NOT NULL"),
        {"bid": int(branch_id)},
    ).scalar()
    if members:
        raise OrgTreeError(409, f"Move or remove the {members} {'person' if members == 1 else 'people'} in this branch first.")
    db.execute(
        text("UPDATE org_branches SET is_active = 0, chief_user_id = NULL, updated_at = NOW() WHERE id = :bid"),
        {"bid": int(branch_id)},
    )


# --- maintenance -------------------------------------------------------------


def _district(value: str) -> str:
    district = normalize_district_code(value)
    if district not in DISTRICTS:
        raise OrgTreeError(422, "Districts are 01 to 12.")
    return district


def add_maintenance(db: Session, actor: dict, *, district: str, user_id: int, kind: str) -> None:
    if not is_admin(actor):
        raise OrgTreeError(403, "Only an administrator can change the maintenance lists.")
    district = _district(district)
    if not db.execute(text("SELECT 1 FROM users WHERE id = :uid AND is_active = 1"), {"uid": int(user_id)}).scalar():
        raise OrgTreeError(404, "That person is not an active ERIS user.")
    if kind == "COORDINATOR":
        db.execute(
            text(
                """
                INSERT INTO org_coordinator_coverage (district, user_id, is_primary, is_active)
                VALUES (:d, :uid, CASE WHEN EXISTS (SELECT 1 FROM org_coordinator_coverage c
                                                     WHERE c.district = :d AND c.is_active = 1 AND c.is_primary = 1)
                                       THEN 0 ELSE 1 END, 1)
                ON DUPLICATE KEY UPDATE is_active = 1, updated_at = NOW()
                """
            ),
            {"d": district, "uid": int(user_id)},
        )
    elif kind == "CREW":
        db.execute(
            text(
                """
                INSERT INTO org_district_crew (district, user_id, is_active) VALUES (:d, :uid, 1)
                ON DUPLICATE KEY UPDATE is_active = 1, updated_at = NOW()
                """
            ),
            {"d": district, "uid": int(user_id)},
        )
    else:
        raise OrgTreeError(422, "Unknown list.")
    sync_roles(db, user_id)


def remove_maintenance(db: Session, actor: dict, *, district: str, user_id: int, kind: str) -> None:
    if not is_admin(actor):
        raise OrgTreeError(403, "Only an administrator can change the maintenance lists.")
    district = _district(district)
    table = {"COORDINATOR": "org_coordinator_coverage", "CREW": "org_district_crew"}.get(kind)
    if not table:
        raise OrgTreeError(422, "Unknown list.")
    result = db.execute(
        text(f"UPDATE {table} SET is_active = 0, updated_at = NOW() WHERE district = :d AND user_id = :uid AND is_active = 1"),
        {"d": district, "uid": int(user_id)},
    )
    if not result.rowcount:
        raise OrgTreeError(404, "That person is not on this list.")
    if kind == "COORDINATOR":
        # Keep a deterministic first recipient: promote the earliest remaining coordinator.
        if not db.execute(
            text("SELECT 1 FROM org_coordinator_coverage WHERE district = :d AND is_active = 1 AND is_primary = 1"),
            {"d": district},
        ).scalar():
            db.execute(
                text(
                    """
                    UPDATE org_coordinator_coverage SET is_primary = 1
                     WHERE district = :d AND is_active = 1
                     ORDER BY created_at, id LIMIT 1
                    """
                ),
                {"d": district},
            )
    sync_roles(db, user_id)


def set_primary_coordinator(db: Session, actor: dict, *, district: str, user_id: int) -> None:
    if not is_admin(actor):
        raise OrgTreeError(403, "Only an administrator can change the maintenance lists.")
    district = _district(district)
    if not db.execute(
        text("SELECT 1 FROM org_coordinator_coverage WHERE district = :d AND user_id = :uid AND is_active = 1"),
        {"d": district, "uid": int(user_id)},
    ).scalar():
        raise OrgTreeError(404, "That person is not a coordinator here.")
    db.execute(
        text("UPDATE org_coordinator_coverage SET is_primary = (user_id = :uid) WHERE district = :d AND is_active = 1"),
        {"d": district, "uid": int(user_id)},
    )


# --- a person's details ------------------------------------------------------

DETAIL_FIELDS = (
    "classification_code", "classification_marker", "position_number", "job_title", "level_code",
    "home_city", "home_district", "availability", "available_until",
)
AVAILABILITY = ("AVAILABLE", "ROTATION_OUT", "ACTING_ELSEWHERE", "UNAVAILABLE")


def can_edit_details(db: Session, actor: dict, user_id: int) -> bool:
    """Administrators; the person; their office chief; their branch chief."""
    if is_admin(actor) or int(actor["id"]) == int(user_id):
        return True
    current = placement(db, user_id)
    if current["position"] is None:
        return False
    if can_manage_office(db, actor, current["office_id"]):
        return True
    if current["branch_id"]:
        branch = _branch(db, current["branch_id"])
        return bool(branch) and can_manage_branch(db, actor, branch)
    return False


def person_details(db: Session, user_id: int) -> dict:
    org = org_directory.resolve_user_org(db, int(user_id), use_cache=False)
    until = org.get("available_until")
    return {
        "user_id": int(user_id),
        **{field: org.get(field) for field in DETAIL_FIELDS if field != "available_until"},
        "available_until": until.isoformat() if hasattr(until, "isoformat") else until,
        "availability": org.get("availability") or "AVAILABLE",
    }


def update_details(db: Session, actor: dict, *, user_id: int, fields: dict) -> None:
    if not db.execute(text("SELECT 1 FROM users WHERE id = :uid"), {"uid": int(user_id)}).scalar():
        raise OrgTreeError(404, "User not found.")
    if not can_edit_details(db, actor, user_id):
        raise OrgTreeError(403, "You cannot change this person's details.")
    clean: dict[str, Any] = {}
    for key, value in fields.items():
        if key not in DETAIL_FIELDS:
            continue
        text_value = (str(value).strip() if value is not None else "") or None
        if key == "home_district":
            text_value = normalize_district_code(text_value)
        elif key == "classification_marker":
            text_value = org_directory.normalize_classification_marker(text_value)
        elif key == "level_code" and text_value:
            text_value = text_value.upper()
        elif key == "availability":
            text_value = (text_value or "AVAILABLE").upper()
            if text_value not in AVAILABILITY:
                raise OrgTreeError(422, "Unknown availability.")
        clean[key] = text_value
    if not clean:
        return
    db.execute(text("INSERT IGNORE INTO org_user_profiles (user_id, source) VALUES (:uid, 'MANUAL')"), {"uid": int(user_id)})
    assignments = ", ".join(f"{key} = :{key}" for key in clean)
    db.execute(
        text(f"UPDATE org_user_profiles SET {assignments}, source = 'MANUAL', updated_at = NOW() WHERE user_id = :uid"),
        {**clean, "uid": int(user_id)},
    )
    org_directory.mirror_metadata_from_profile(
        db, int(user_id), clear_district="home_district" in clean and clean["home_district"] is None,
    )

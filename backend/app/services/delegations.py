"""Out of the office: someone names a colleague to act for them, between two dates.

Almost every rule in ERIS is tied to one person's id (the branch chief named on
an assessment, the assignee, a district workflow's step), so a delegate does not
gain anything of their own. While a delegation runs they may *switch to acting
for* the absent person: the request carries ``X-ERIS-Acting-For`` and
``deps.current_session`` then judges it as that person. So every queue, scope
and step follows with nothing to keep in step, and a request without the header
is judged as the delegate themself.

What keeps that honest:

* **Dates.** Each request checks the delegation is running today; it ends on its
  own at the end of ``ends_on``, and either person can cancel it sooner.
* **The record says who.** Every write while acting goes in ``delegated_actions``;
  an assessment's timeline and a share's decision name both people.
* **No powers beyond the work.** Administrator does not pass, and accounts, the
  organization and delegations themselves cannot be changed while acting.
* **Nobody signs off their own work.** Acting for a chief does not let someone
  review a form assigned to them, or decide a share of their own.

Who may be named: someone in the same office tree, or on the same district's
lists or workflow. Who may set it: the person, or for someone away unexpectedly,
their direct supervisor (Staff: their branch chief; a branch chief or Senior
Specialist: their office chief) or an administrator.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from fastapi import HTTPException
from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session

from ..roles import is_admin
from . import org_tree

ACTING_HEADER = "x-eris-acting-for"
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
# Changed only as oneself. Signing out is always allowed.
BLOCKED_WHILE_ACTING = ("/admin", "/org", "/auth", "/delegations", "/notifications/devices")
OPEN_WHILE_ACTING = ("/auth/logout",)
LONGEST = timedelta(days=366)
ACTING_ENDED_DETAIL = "You are no longer acting for this person: the delegation has ended. Switch back to your own work."
ACTING_BLOCKED_DETAIL = "Accounts, the organization and delegations can only be changed as yourself. Switch back to your own work first."

_RUNNING = """d.cancelled_at IS NULL AND d.starts_on <= CURDATE() AND d.ends_on >= CURDATE()"""


@dataclass(frozen=True)
class Reach:
    """Where someone works, for deciding who they may name."""

    office_id: int | None = None
    districts: frozenset[str] = field(default_factory=frozenset)

    @property
    def placed(self) -> bool:
        return self.office_id is not None or bool(self.districts)


def may_name(delegator: Reach, delegate: Reach) -> bool:
    """The same office tree, or a district in common."""
    if delegator.office_id is not None and delegator.office_id == delegate.office_id:
        return True
    return bool(delegator.districts & delegate.districts)


def blocked_while_acting(method: str, path: str) -> bool:
    if method.upper() not in UNSAFE_METHODS or path.endswith(OPEN_WHILE_ACTING):
        return False
    return any(path == prefix or path.startswith(prefix + "/") or path.startswith(prefix + "-") for prefix in BLOCKED_WHILE_ACTING)


def check_dates(starts_on: date, ends_on: date, today: date) -> None:
    if ends_on < starts_on:
        raise HTTPException(status_code=400, detail="The last day cannot be before the first day.")
    if ends_on < today:
        raise HTTPException(status_code=400, detail="The last day has already passed.")
    if ends_on - starts_on > LONGEST:
        raise HTTPException(status_code=400, detail="A delegation can run for at most a year. Set a new one after that.")


def reach(db: Session, user_id: int) -> Reach:
    from . import maintenance_workflows  # imports the app's routes; deferred to avoid a cycle

    place = org_tree.placement(db, int(user_id))
    lists = org_tree.maintenance_places(db, int(user_id))
    districts = {*lists["coordinator"], *lists["crew"]}
    districts |= {str(item["district"]).strip() for item in maintenance_workflows.summary(db, int(user_id))}
    return Reach(office_id=place["office_id"], districts=frozenset(districts))


def supervises(mine: dict, place: dict, *, branch_has_chief: bool) -> bool:
    """A person's direct supervisor, and nobody further up.

    Staff answer to their branch chief, or to the office chief while the branch has
    none; branch chiefs and Senior Specialists answer to their office chief.
    """
    if place["office_id"] is None:
        return False
    if mine["position"] == "BRANCH_CHIEF":
        return place["position"] == "STAFF" and mine["branch_id"] == place["branch_id"]
    if mine["position"] != "OFFICE_CHIEF" or mine["office_id"] != place["office_id"]:
        return False
    return place["position"] in {"BRANCH_CHIEF", "SENIOR_SPECIALIST"} or (place["position"] == "STAFF" and not branch_has_chief)


def can_set_for(db: Session, actor: dict, person_id: int) -> bool:
    """The person themself or, for someone away unexpectedly, their supervisor or an administrator."""
    if int(actor["id"]) == int(person_id) or is_admin(actor):
        return True
    place = org_tree.placement(db, int(person_id))
    chief = place["branch_id"] and db.execute(
        text("SELECT chief_user_id FROM org_branches WHERE id = :bid"), {"bid": place["branch_id"]}
    ).scalar()
    return supervises(org_tree.placement(db, int(actor["id"])), place, branch_has_chief=bool(chief))


def _name(db: Session, user_id: int) -> str:
    row = db.execute(text("SELECT COALESCE(full_name, email) FROM users WHERE id = :uid"), {"uid": int(user_id)}).scalar()
    return str(row) if row else "Someone"


def running(db: Session, *, delegate_id: int, delegator_id: int) -> int | None:
    """The delegation letting this person act for that one today, if any."""
    found = db.execute(
        text(f"""
            SELECT d.id FROM user_delegations d JOIN users u ON u.id = d.delegator_user_id AND u.is_active = 1
             WHERE d.delegate_user_id = :delegate AND d.delegator_user_id = :delegator AND {_RUNNING}
             LIMIT 1
        """),
        {"delegate": int(delegate_id), "delegator": int(delegator_id)},
    ).scalar()
    return int(found) if found is not None else None


def acting_options(db: Session, user_id: int) -> list[dict]:
    """Whom this person may switch to acting for right now."""
    rows = db.execute(
        text(f"""
            SELECT d.id, d.delegator_user_id, d.ends_on, COALESCE(u.full_name, u.email) AS name
              FROM user_delegations d JOIN users u ON u.id = d.delegator_user_id AND u.is_active = 1
             WHERE d.delegate_user_id = :uid AND {_RUNNING}
             ORDER BY name
        """),
        {"uid": int(user_id)},
    ).mappings().all()
    return [
        {"delegation_id": int(r["id"]), "user_id": int(r["delegator_user_id"]), "full_name": r["name"], "ends_on": r["ends_on"].isoformat()}
        for r in rows
    ]


def record_action(db: Session, *, delegation_id: int, actor_id: int, acting_for: int, method: str, path: str) -> None:
    """Written in the request's own transaction: what did not happen is not recorded."""
    db.execute(
        text("""
            INSERT INTO delegated_actions (delegation_id, actor_user_id, acting_for_user_id, method, path)
            VALUES (:delegation, :actor, :acting_for, :method, :path)
        """),
        {"delegation": int(delegation_id), "actor": int(actor_id), "acting_for": int(acting_for), "method": method[:8], "path": path[:255]},
    )


def acting(db: Session) -> dict | None:
    """Who really is behind this request, when someone is acting for another."""
    return db.info.get("acting")


def stamp(db: Session, metadata: dict | None) -> dict | None:
    """An assessment event's metadata, naming who really acted."""
    who = acting(db)
    if not who:
        return metadata
    return {**(metadata or {}), "acted_by": {"user_id": who["user_id"], "full_name": who["full_name"]}}


def signed_note(db: Session, note: str | None, acting_for_name: str | None) -> str | None:
    who = acting(db)
    if not who:
        return note
    signature = f"{who['full_name']}, acting for {acting_for_name or 'the person away'}"
    return f"{note} ({signature})"[:1000] if note else signature


def refuse_own_work(db: Session, *authors: Any) -> None:
    """Acting for a chief does not let someone decide on their own work."""
    who = acting(db)
    if who and int(who["user_id"]) in {int(a) for a in authors if a is not None}:
        raise HTTPException(
            status_code=403,
            detail="This is your own work. While acting for someone else you cannot decide on it: ask their office chief or an administrator.",
        )


def delegates_of(db: Session, user_ids: list[int]) -> dict[int, list[tuple[int, str]]]:
    """Who stands in today for each of these people, and the absent person's name."""
    if not user_ids:
        return {}
    rows = db.execute(
        text(f"""
            SELECT d.delegator_user_id, d.delegate_user_id, COALESCE(u.full_name, u.email) AS name
              FROM user_delegations d JOIN users u ON u.id = d.delegator_user_id
             WHERE d.delegator_user_id IN :ids AND {_RUNNING}
        """).bindparams(bindparam("ids", expanding=True)),
        {"ids": list(user_ids)},
    ).mappings().all()
    found: dict[int, list[tuple[int, str]]] = {}
    for row in rows:
        found.setdefault(int(row["delegator_user_id"]), []).append((int(row["delegate_user_id"]), str(row["name"])))
    return found


def _payload(row: Any) -> dict:
    today = date.today()
    cancelled = row["cancelled_at"] is not None
    status = "CANCELLED" if cancelled else "ENDED" if row["ends_on"] < today else "SCHEDULED" if row["starts_on"] > today else "ACTIVE"
    return {
        "id": int(row["id"]),
        "delegator": {"id": int(row["delegator_user_id"]), "full_name": row["delegator_name"]},
        "delegate": {"id": int(row["delegate_user_id"]), "full_name": row["delegate_name"]},
        "starts_on": row["starts_on"].isoformat(),
        "ends_on": row["ends_on"].isoformat(),
        "note": row["note"],
        "status": status,
        "action_count": int(row["action_count"] or 0),
    }


_SELECT = """
    SELECT d.*, COALESCE(g.full_name, g.email) AS delegator_name, COALESCE(t.full_name, t.email) AS delegate_name,
           (SELECT COUNT(*) FROM delegated_actions x WHERE x.delegation_id = d.id) AS action_count
      FROM user_delegations d
      JOIN users g ON g.id = d.delegator_user_id
      JOIN users t ON t.id = d.delegate_user_id
"""


def overview(db: Session, user_id: int) -> dict:
    """What this person gave and was given, recent first; long-past ones drop off."""
    rows = db.execute(
        text(f"""{_SELECT}
             WHERE (d.delegator_user_id = :uid OR d.delegate_user_id = :uid) AND d.ends_on >= CURDATE() - INTERVAL 90 DAY
             ORDER BY d.starts_on DESC, d.id DESC
        """),
        {"uid": int(user_id)},
    ).mappings().all()
    return {
        "given": [_payload(r) for r in rows if int(r["delegator_user_id"]) == int(user_id)],
        "received": [_payload(r) for r in rows if int(r["delegate_user_id"]) == int(user_id)],
        "acting_options": acting_options(db, user_id),
    }


def people_for(db: Session, actor: dict) -> list[dict]:
    """Whom else this person may set a delegation for: whoever reports directly to them."""
    if is_admin(actor):
        where, params = "p.tree_position IS NOT NULL", {}
    else:
        mine = org_tree.placement(db, int(actor["id"]))
        if mine["position"] == "OFFICE_CHIEF":
            where = """p.office_id = :office AND (p.tree_position IN ('BRANCH_CHIEF', 'SENIOR_SPECIALIST')
                       OR (p.tree_position = 'STAFF' AND EXISTS (
                           SELECT 1 FROM org_branches b WHERE b.id = p.branch_id AND b.chief_user_id IS NULL)))"""
            params = {"office": mine["office_id"]}
        elif mine["position"] == "BRANCH_CHIEF":
            where, params = "p.branch_id = :branch AND p.tree_position = 'STAFF'", {"branch": mine["branch_id"]}
        else:
            return []
    rows = db.execute(
        text(f"""
            SELECT u.id, COALESCE(u.full_name, u.email) AS name
              FROM org_user_profiles p JOIN users u ON u.id = p.user_id AND u.is_active = 1
             WHERE {where} AND u.id <> :me ORDER BY name
        """),
        {**params, "me": int(actor["id"])},
    ).mappings().all()
    return [{"id": int(r["id"]), "full_name": r["name"]} for r in rows]


def candidates(db: Session, *, person_id: int) -> list[dict]:
    """Everyone this person may name, with where they sit."""
    from . import maintenance_workflows  # imports the app's routes; deferred to avoid a cycle

    mine = reach(db, person_id)
    ids: set[int] = set()
    if mine.office_id is not None:
        ids.update(db.execute(
            text("SELECT user_id FROM org_user_profiles WHERE office_id = :office AND tree_position IS NOT NULL"),
            {"office": mine.office_id},
        ).scalars())
    if mine.districts:
        districts = {"districts": sorted(mine.districts)}
        for table in ("org_coordinator_coverage", "org_district_crew"):
            ids.update(db.execute(
                text(f"SELECT user_id FROM {table} WHERE is_active = 1 AND TRIM(district) IN :districts").bindparams(
                    bindparam("districts", expanding=True)),
                districts,
            ).scalars())
        for definition in db.execute(
            text("SELECT definition_json FROM maintenance_workflows WHERE TRIM(district) IN :districts").bindparams(
                bindparam("districts", expanding=True)),
            districts,
        ).scalars():
            ids.update(maintenance_workflows.participants(maintenance_workflows.unpack(definition)))
    ids.discard(int(person_id))
    if not ids:
        return []
    rows = db.execute(
        text("SELECT id, COALESCE(full_name, email) AS name, email FROM users WHERE is_active = 1 AND id IN :ids ORDER BY name").bindparams(
            bindparam("ids", expanding=True)),
        {"ids": sorted(int(i) for i in ids)},
    ).mappings().all()
    return [
        {"id": int(row["id"]), "full_name": row["name"], "email": row["email"],
         "placement": org_tree.placement(db, int(row["id"]))["label"] or "District maintenance"}
        for row in rows
    ]


def create(db: Session, *, actor: dict, person_id: int, delegate_id: int, starts_on: date, ends_on: date, note: str | None) -> int:
    """Names a delegate. Does NOT commit."""
    from . import notification_feed

    if not can_set_for(db, actor, person_id):
        raise HTTPException(status_code=403, detail="Only this person, their supervisor or an administrator can set this.")
    if int(person_id) == int(delegate_id):
        raise HTTPException(status_code=400, detail="Choose someone else to act for you.")
    today = db.execute(text("SELECT CURDATE()")).scalar()
    check_dates(starts_on, ends_on, today)
    mine = reach(db, person_id)
    if not mine.placed:
        raise HTTPException(status_code=409, detail="Only someone placed in an office or on a district's lists has work to delegate.")
    if not db.execute(text("SELECT 1 FROM users WHERE id = :uid AND is_active = 1"), {"uid": int(delegate_id)}).scalar():
        raise HTTPException(status_code=404, detail="That person is not an active ERIS user.")
    if not may_name(mine, reach(db, delegate_id)):
        raise HTTPException(status_code=400, detail="Choose someone in the same office, or on the same district's lists.")
    clash = db.execute(
        text("""
            SELECT 1 FROM user_delegations
             WHERE delegator_user_id = :uid AND cancelled_at IS NULL AND starts_on <= :ends AND ends_on >= :starts
             LIMIT 1
        """),
        {"uid": int(person_id), "starts": starts_on, "ends": ends_on},
    ).scalar()
    if clash:
        raise HTTPException(status_code=409, detail="These dates overlap a delegation already set. Cancel it first.")
    result = db.execute(
        text("""
            INSERT INTO user_delegations (delegator_user_id, delegate_user_id, starts_on, ends_on, note, created_by_user_id)
            VALUES (:person, :delegate, :starts, :ends, :note, :actor)
        """),
        {"person": int(person_id), "delegate": int(delegate_id), "starts": starts_on, "ends": ends_on,
         "note": (note or "").strip()[:500] or None, "actor": int(actor["id"])},
    )
    name = _name(db, person_id)
    notification_feed.add(
        db, [delegate_id, person_id], kind="DELEGATION_SET", actor_id=int(actor["id"]), link="/settings",
        title=f"{_name(db, delegate_id)} will act for {name}",
        body=f"From {starts_on:%b} {starts_on.day} to {ends_on:%b} {ends_on.day}, {ends_on.year}. Switch to acting for {name} to see and do their work.",
    )
    return int(result.lastrowid)


def cancel(db: Session, *, actor: dict, delegation_id: int) -> None:
    """Ends it early, or before it starts. Does NOT commit."""
    from . import notification_feed

    row = db.execute(text("SELECT * FROM user_delegations WHERE id = :did FOR UPDATE"), {"did": int(delegation_id)}).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Delegation not found")
    if int(actor["id"]) != int(row["delegate_user_id"]) and not can_set_for(db, actor, int(row["delegator_user_id"])):
        raise HTTPException(status_code=403, detail="Only the two people involved, a supervisor or an administrator can cancel this.")
    if row["cancelled_at"] is not None:
        return
    db.execute(
        text("UPDATE user_delegations SET cancelled_at = NOW(), cancelled_by_user_id = :by WHERE id = :did"),
        {"by": int(actor["id"]), "did": int(delegation_id)},
    )
    notification_feed.add(
        db, [row["delegate_user_id"], row["delegator_user_id"]], kind="DELEGATION_ENDED", actor_id=int(actor["id"]), link="/settings",
        title=f"{_name(db, int(row['delegate_user_id']))} no longer acts for {_name(db, int(row['delegator_user_id']))}",
    )


def actions(db: Session, *, actor: dict, delegation_id: int) -> list[dict]:
    """What was done under a delegation: for the two people, a supervisor or an administrator."""
    row = db.execute(text("SELECT * FROM user_delegations WHERE id = :did"), {"did": int(delegation_id)}).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Delegation not found")
    if int(actor["id"]) != int(row["delegate_user_id"]) and not can_set_for(db, actor, int(row["delegator_user_id"])):
        raise HTTPException(status_code=403, detail="Only the two people involved, a supervisor or an administrator can read this.")
    rows = db.execute(
        text("""
            SELECT x.method, x.path, x.created_at, COALESCE(u.full_name, u.email) AS actor_name
              FROM delegated_actions x JOIN users u ON u.id = x.actor_user_id
             WHERE x.delegation_id = :did ORDER BY x.created_at DESC, x.id DESC LIMIT 500
        """),
        {"did": int(delegation_id)},
    ).mappings().all()
    return [
        {"method": r["method"], "path": r["path"], "actor_name": r["actor_name"], "created_at": r["created_at"].isoformat()}
        for r in rows
    ]

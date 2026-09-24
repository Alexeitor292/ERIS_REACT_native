"""Sharing a technical form: requests, the chiefs' decisions, and the grants.

The rule for who approves and who is told lives in ``share_rules``; this module
applies it. A share is one request to give one person viewing and editing on
one form. It is granted (the person gets the form's reader and editor grants)
once every APPROVAL review is approved, straight away when there is none, and
it ends when anyone with a say rejects it or the sharer withdraws it.

Who decides for a unit: a branch's chief (or, while the branch has no chief,
its office chiefs); an office's chiefs; and administrators, for any unit. A
chief who shares, or is shared with, is not asked about their own unit's
notice, and a chief who shares approves their own branch's gate by sharing.
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session

from . import org_tree
from .share_rules import APPROVAL, BRANCH, NOTICE, OFFICE, Place, Review, reviews_for

OPEN = ("PENDING", "ACTIVE")


# --- Where people sit ---------------------------------------------------------

def places(db: Session, user_ids: list[int]) -> dict[int, Place]:
    if not user_ids:
        return {}
    rows = db.execute(
        text(
            """
            SELECT user_id, tree_position, office_id, branch_id FROM org_user_profiles
             WHERE user_id IN :ids AND tree_position IS NOT NULL AND office_id IS NOT NULL
            """
        ).bindparams(bindparam("ids", expanding=True)),
        {"ids": sorted({int(uid) for uid in user_ids})},
    ).mappings().all()
    found = {
        int(row["user_id"]): Place(row["tree_position"], int(row["office_id"]), int(row["branch_id"]) if row["branch_id"] else None)
        for row in rows
    }
    return {int(uid): found.get(int(uid), Place()) for uid in user_ids}


class Units:
    """Names of offices and branches, and who leads them."""

    def __init__(self, db: Session):
        self.offices = {
            int(row["id"]): row["short_name"] or row["name"] or row["code"]
            for row in db.execute(text("SELECT id, code, name, short_name FROM org_offices")).mappings().all()
        }
        self.branches: dict[int, dict] = {
            int(row["id"]): dict(row)
            for row in db.execute(text("SELECT id, office_id, letter, name, chief_user_id FROM org_branches")).mappings().all()
        }

    def label(self, unit_type: str, unit_id: int) -> str:
        if unit_type == OFFICE:
            return self.offices.get(int(unit_id), f"Office #{unit_id}")
        branch = self.branches.get(int(unit_id))
        if not branch:
            return f"Branch #{unit_id}"
        name = branch["name"] or f"Branch {branch['letter']}"
        office = self.offices.get(int(branch["office_id"])) if branch["office_id"] else None
        return f"{office} › {name}" if office else name


def decided_units(db: Session, user_id: int) -> set[tuple[str, int]]:
    """The branches and offices this person decides for (without admin rights)."""
    units: set[tuple[str, int]] = set()
    for (branch_id,) in db.execute(
        text("SELECT id FROM org_branches WHERE chief_user_id = :uid"), {"uid": int(user_id)}
    ).all():
        units.add((BRANCH, int(branch_id)))
    offices = [
        int(office_id)
        for (office_id,) in db.execute(
            text("SELECT office_id FROM org_user_profiles WHERE user_id = :uid AND tree_position = 'OFFICE_CHIEF' AND office_id IS NOT NULL"),
            {"uid": int(user_id)},
        ).all()
    ]
    for office_id in offices:
        units.add((OFFICE, office_id))
        # A branch with no chief is decided by its office chiefs.
        for (branch_id,) in db.execute(
            text("SELECT id FROM org_branches WHERE office_id = :oid AND chief_user_id IS NULL"), {"oid": office_id}
        ).all():
            units.add((BRANCH, int(branch_id)))
    return units


def can_decide(db: Session, user: dict, unit_type: str, unit_id: int) -> bool:
    return org_tree.is_admin(user) or (unit_type, int(unit_id)) in decided_units(db, int(user["id"]))


# --- The plan -----------------------------------------------------------------

def plan(db: Session, owner_id: int, recipient_id: int) -> list[Review]:
    found = places(db, [owner_id, recipient_id])
    return reviews_for(found[int(owner_id)], found[int(recipient_id)])


def describe(reviews: list[Review], units: Units) -> dict[str, Any]:
    approvals = [units.label(r.unit_type, r.unit_id) for r in reviews if r.kind == APPROVAL]
    notices = [units.label(r.unit_type, r.unit_id) for r in reviews if r.kind == NOTICE]
    return {"immediate": not approvals, "approvals": approvals, "notices": notices}


# --- Grants -------------------------------------------------------------------

def _grant(db: Session, submission_id: int, user_id: int, granted_by: int) -> None:
    for table in ("submission_visibility", "submission_editors"):
        db.execute(
            text(
                f"""
                INSERT INTO {table} (submission_id, user_id, granted_by_user_id) VALUES (:sid, :uid, :by)
                ON DUPLICATE KEY UPDATE granted_by_user_id = VALUES(granted_by_user_id)
                """
            ),
            {"sid": int(submission_id), "uid": int(user_id), "by": int(granted_by)},
        )


def _remove_grants(db: Session, submission_id: int, user_id: int) -> None:
    for table in ("submission_visibility", "submission_editors"):
        db.execute(text(f"DELETE FROM {table} WHERE submission_id = :sid AND user_id = :uid"), {"sid": int(submission_id), "uid": int(user_id)})


def _activate(db: Session, share: dict) -> None:
    db.execute(text("UPDATE submission_shares SET status = 'ACTIVE', activated_at = NOW() WHERE id = :id"), {"id": int(share["id"])})
    _grant(db, int(share["submission_id"]), int(share["recipient_user_id"]), int(share["sharer_user_id"]))


def _end(db: Session, share: dict, status: str, actor_id: int, note: str | None) -> None:
    db.execute(
        text(
            """
            UPDATE submission_shares
               SET status = :status, ended_at = NOW(), ended_by_user_id = :actor, end_note = :note
             WHERE id = :id
            """
        ),
        {"status": status, "actor": int(actor_id), "note": note, "id": int(share["id"])},
    )
    if share["status"] == "ACTIVE":
        _remove_grants(db, int(share["submission_id"]), int(share["recipient_user_id"]))


def _share(db: Session, share_id: int, *, lock: bool = False) -> dict | None:
    row = db.execute(
        text(f"SELECT * FROM submission_shares WHERE id = :id{' FOR UPDATE' if lock else ''}"), {"id": int(share_id)}
    ).mappings().first()
    return dict(row) if row else None


def open_share(db: Session, submission_id: int, recipient_id: int) -> dict | None:
    row = db.execute(
        text(
            """
            SELECT * FROM submission_shares
             WHERE submission_id = :sid AND recipient_user_id = :uid AND status IN ('PENDING', 'ACTIVE')
             ORDER BY id DESC LIMIT 1
            """
        ),
        {"sid": int(submission_id), "uid": int(recipient_id)},
    ).mappings().first()
    return dict(row) if row else None


# --- Sharing, deciding, withdrawing -------------------------------------------

def create(db: Session, *, submission_id: int, owner_id: int, actor: dict, recipient_id: int) -> int:
    """Ask to share; granted at once when nobody has to approve. Does NOT commit."""
    existing = open_share(db, submission_id, recipient_id)
    if existing:
        return int(existing["id"])
    share_id = int(
        db.execute(
            text(
                """
                INSERT INTO submission_shares (submission_id, sharer_user_id, recipient_user_id, status)
                VALUES (:sid, :actor, :uid, 'PENDING')
                """
            ),
            {"sid": int(submission_id), "actor": int(actor["id"]), "uid": int(recipient_id)},
        ).lastrowid
    )
    actor_units = decided_units(db, int(actor["id"]))
    recipient_units = decided_units(db, int(recipient_id))
    for review in plan(db, owner_id, recipient_id):
        unit = (review.unit_type, review.unit_id)
        decision, decided_by = "PENDING", None
        if unit in actor_units:
            decision, decided_by = ("APPROVED" if review.kind == APPROVAL else "ACKNOWLEDGED"), int(actor["id"])
        elif review.kind == NOTICE and unit in recipient_units:
            decision, decided_by = "ACKNOWLEDGED", int(recipient_id)
        db.execute(
            text(
                """
                INSERT INTO submission_share_reviews (share_id, unit_type, unit_id, kind, decision, decided_by_user_id, decided_at)
                VALUES (:share, :unit_type, :unit_id, :kind, :decision, :by, CASE WHEN :by IS NULL THEN NULL ELSE NOW() END)
                """
            ),
            {"share": share_id, "unit_type": review.unit_type, "unit_id": review.unit_id, "kind": review.kind, "decision": decision, "by": decided_by},
        )
    _activate_if_approved(db, share_id)
    return share_id


def _activate_if_approved(db: Session, share_id: int) -> None:
    share = _share(db, share_id)
    if not share or share["status"] != "PENDING":
        return
    waiting = db.execute(
        text("SELECT COUNT(*) FROM submission_share_reviews WHERE share_id = :id AND kind = 'APPROVAL' AND decision <> 'APPROVED'"),
        {"id": int(share_id)},
    ).scalar()
    if not waiting:
        _activate(db, share)


def decide(db: Session, *, actor: dict, share_id: int, review_id: int, decision: str, note: str | None) -> dict:
    """A chief approves, rejects (stops) or acknowledges. Does NOT commit."""
    share = _share(db, share_id, lock=True)
    review = db.execute(
        text("SELECT * FROM submission_share_reviews WHERE id = :rid AND share_id = :sid"), {"rid": int(review_id), "sid": int(share_id)}
    ).mappings().first()
    if not share or not review:
        raise HTTPException(status_code=404, detail="Share not found")
    if not can_decide(db, actor, review["unit_type"], int(review["unit_id"])):
        raise HTTPException(status_code=403, detail="Only the chief of this branch or office can decide this")
    if share["status"] not in OPEN:
        raise HTTPException(status_code=409, detail="This share has already ended")
    choice = str(decision or "").strip().upper()
    note = (note or "").strip()[:1000] or None

    def record(value: str) -> None:
        db.execute(
            text("UPDATE submission_share_reviews SET decision = :d, decided_by_user_id = :by, decided_at = NOW(), note = :note WHERE id = :rid"),
            {"d": value, "by": int(actor["id"]), "note": note, "rid": int(review_id)},
        )

    if choice == "REJECT":
        record("REJECTED")
        _end(db, share, "REJECTED" if share["status"] == "PENDING" else "REVOKED", int(actor["id"]), note)
    elif choice == "APPROVE":
        if review["kind"] != APPROVAL:
            raise HTTPException(status_code=400, detail="Nothing to approve: you are told about this share, and may stop it")
        if review["decision"] != "PENDING":
            raise HTTPException(status_code=409, detail="Already decided")
        record("APPROVED")
        _activate_if_approved(db, int(share_id))
    elif choice == "ACKNOWLEDGE":
        if review["kind"] != NOTICE:
            raise HTTPException(status_code=400, detail="This share waits on your approval: approve or reject it")
        if review["decision"] == "PENDING":
            record("ACKNOWLEDGED")
    else:
        raise HTTPException(status_code=400, detail="Decision must be APPROVE, REJECT or ACKNOWLEDGE")
    return _share(db, share_id) or share


def withdraw(db: Session, *, submission_id: int, recipient_id: int, actor: dict) -> None:
    """The sharer (owner or administrator) stops sharing with one person. Does NOT commit."""
    share = open_share(db, submission_id, recipient_id)
    if share:
        _end(db, share, "CANCELLED" if share["status"] == "PENDING" else "REVOKED", int(actor["id"]), None)
    # Grants made before approvals existed, or by hand, go too.
    _remove_grants(db, submission_id, recipient_id)


# --- Reading ------------------------------------------------------------------

def _reviews(db: Session, share_ids: list[int], units: Units) -> dict[int, list[dict]]:
    if not share_ids:
        return {}
    out: dict[int, list[dict]] = {}
    for row in db.execute(
        text(
            """
            SELECT r.*, u.full_name AS decided_by_name FROM submission_share_reviews r
              LEFT JOIN users u ON u.id = r.decided_by_user_id
             WHERE r.share_id IN :ids ORDER BY r.id
            """
        ).bindparams(bindparam("ids", expanding=True)),
        {"ids": share_ids},
    ).mappings().all():
        out.setdefault(int(row["share_id"]), []).append(
            {
                "id": int(row["id"]),
                "unit_type": row["unit_type"],
                "unit_id": int(row["unit_id"]),
                "unit_label": units.label(row["unit_type"], int(row["unit_id"])),
                "kind": row["kind"],
                "decision": row["decision"],
                "decided_by": row["decided_by_name"],
                "decided_at": row["decided_at"].isoformat() if row["decided_at"] else None,
                "note": row["note"],
            }
        )
    return out


def _person(user_id, name, email) -> dict:
    return {"id": int(user_id), "full_name": name, "email": email}


def for_submission(db: Session, submission_id: int) -> list[dict]:
    rows = db.execute(
        text(
            """
            SELECT s.*, r.full_name AS recipient_name, r.email AS recipient_email,
                   g.full_name AS sharer_name, g.email AS sharer_email, e.full_name AS ended_by_name
              FROM submission_shares s
              JOIN users r ON r.id = s.recipient_user_id
              JOIN users g ON g.id = s.sharer_user_id
              LEFT JOIN users e ON e.id = s.ended_by_user_id
             WHERE s.submission_id = :sid
             ORDER BY s.id DESC
            """
        ),
        {"sid": int(submission_id)},
    ).mappings().all()
    units = Units(db)
    reviews = _reviews(db, [int(row["id"]) for row in rows], units)
    return [
        {
            "id": int(row["id"]),
            "status": row["status"],
            "recipient": _person(row["recipient_user_id"], row["recipient_name"], row["recipient_email"]),
            "sharer": _person(row["sharer_user_id"], row["sharer_name"], row["sharer_email"]),
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            "activated_at": row["activated_at"].isoformat() if row["activated_at"] else None,
            "ended_at": row["ended_at"].isoformat() if row["ended_at"] else None,
            "ended_by": row["ended_by_name"],
            "end_note": row["end_note"],
            "reviews": reviews.get(int(row["id"]), []),
        }
        for row in rows
    ]


def candidates(db: Session, *, submission_id: int, owner_id: int) -> list[dict]:
    """Everybody the form can be shared with, where they sit, and what sharing would take."""
    rows = db.execute(
        text(
            """
            SELECT u.id, u.email, u.full_name FROM users u
             WHERE u.is_active = 1 AND u.id <> :owner
               AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                            WHERE ur.user_id = u.id AND r.name <> 'GUEST')
             ORDER BY u.full_name, u.email
             LIMIT 1000
            """
        ),
        {"owner": int(owner_id)},
    ).mappings().all()
    ids = [int(row["id"]) for row in rows]
    found = places(db, ids + [int(owner_id)])
    units = Units(db)
    owner_place = found[int(owner_id)]
    out = []
    for row in rows:
        place = found[int(row["id"])]
        where = None
        if place.position:
            where = units.label(BRANCH, place.branch_id) if place.branch else units.label(OFFICE, place.office_id)
            where = f"{org_tree.POSITION_LABELS[place.position]} · {where}"
        out.append(
            {
                "id": int(row["id"]),
                "email": row["email"],
                "full_name": row["full_name"],
                "placement": where,
                "route": describe(reviews_for(owner_place, place), units),
            }
        )
    return out


def queue(db: Session, actor: dict) -> list[dict]:
    """Shares waiting on this person: approvals to give, and notices to read."""
    units = decided_units(db, int(actor["id"]))
    if not units:
        return []
    clauses, params = [], {}
    for index, (unit_type, unit_id) in enumerate(sorted(units)):
        clauses.append(f"(r.unit_type = :t{index} AND r.unit_id = :u{index})")
        params[f"t{index}"], params[f"u{index}"] = unit_type, unit_id
    rows = db.execute(
        text(
            f"""
            SELECT r.id AS review_id, r.kind, r.unit_type, r.unit_id, s.id AS share_id, s.status, s.created_at,
                   s.submission_id, sub.title AS submission_title, sub.created_by_user_id AS owner_id,
                   s.sharer_user_id, g.full_name AS sharer_name, g.email AS sharer_email,
                   s.recipient_user_id, t.full_name AS recipient_name, t.email AS recipient_email,
                   o.full_name AS owner_name
              FROM submission_share_reviews r
              JOIN submission_shares s ON s.id = r.share_id
              JOIN submissions sub ON sub.id = s.submission_id
              JOIN users g ON g.id = s.sharer_user_id
              JOIN users t ON t.id = s.recipient_user_id
              JOIN users o ON o.id = sub.created_by_user_id
             WHERE r.decision = 'PENDING' AND s.status IN ('PENDING', 'ACTIVE') AND ({" OR ".join(clauses)})
             ORDER BY s.created_at DESC, r.id DESC
            """
        ),
        params,
    ).mappings().all()
    labels = Units(db)
    reviews = _reviews(db, sorted({int(row["share_id"]) for row in rows}), labels)
    people = {uid: org_tree.placement(db, uid)["label"] for uid in {int(row["owner_id"]) for row in rows} | {int(row["recipient_user_id"]) for row in rows}}
    return [
        {
            "review_id": int(row["review_id"]),
            "share_id": int(row["share_id"]),
            "kind": row["kind"],
            "unit_label": labels.label(row["unit_type"], int(row["unit_id"])),
            "status": row["status"],
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            "submission": {"id": int(row["submission_id"]), "title": row["submission_title"]},
            "owner": {**_person(row["owner_id"], row["owner_name"], None), "placement": people.get(int(row["owner_id"]))},
            "sharer": _person(row["sharer_user_id"], row["sharer_name"], row["sharer_email"]),
            "recipient": {**_person(row["recipient_user_id"], row["recipient_name"], row["recipient_email"]), "placement": people.get(int(row["recipient_user_id"]))},
            "reviews": reviews.get(int(row["share_id"]), []),
        }
        for row in rows
    ]

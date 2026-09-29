"""Who else has a technical form open, where they are in it, and the memos they are writing.

Each open copy of a form (a browser tab, ``session_id``) sends a heartbeat every
few seconds naming the card and field it is in and the memos it is writing.
Everyone else in the form sees that, and a memo being written is locked for
them: another person cannot type in it until the writer saves it, leaves the
form, or stops typing for :data:`MEMO_IDLE_S`.

Fields are not locked. Saves send only the fields a person changed, and the
save refuses a field someone else changed since that person opened the form
(``main.patch_gisa``), so two people can work in one card at once. Memos are
locked because two people's paragraphs in one document cannot be merged field
by field.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

# A copy of the form that has not sent a heartbeat for this long has left.
PRESENCE_TTL_S = 45
# A memo lock lapses after this long without typing, so nobody who walked away blocks the others.
MEMO_IDLE_S = 600

MEMO_KEYS = ("observations_notes", "geotechnical_assessment_notes", "recommendations_notes", "sketchpad_notes")
MEMO_LABELS = {
    "observations_notes": "Observations",
    "geotechnical_assessment_notes": "Geotechnical assessment",
    "recommendations_notes": "Recommendations",
    "sketchpad_notes": "Sketch notes",
}

_ALIVE = f"p.seen_at >= NOW() - INTERVAL {PRESENCE_TTL_S} SECOND"
_WRITING = f"p.memo_keys IS NOT NULL AND p.memo_active_at >= NOW() - INTERVAL {MEMO_IDLE_S} SECOND"


def _name(row: Any) -> str:
    return row["full_name"] or row["email"] or "Someone"


def memo_holders(db: Session, submission_id: int, *, except_user_id: int) -> dict[str, dict]:
    """The memos someone other than ``except_user_id`` is writing: key -> {user_id, name}."""
    rows = db.execute(
        text(
            f"""
            SELECT p.user_id, p.memo_keys, u.full_name, u.email
              FROM submission_presence p JOIN users u ON u.id = p.user_id
             WHERE p.submission_id = :sid AND p.user_id <> :uid AND {_ALIVE} AND {_WRITING}
             ORDER BY p.memo_active_at
            """
        ),
        {"sid": int(submission_id), "uid": int(except_user_id)},
    ).mappings().all()
    held: dict[str, dict] = {}
    for row in rows:
        for key in str(row["memo_keys"]).split(","):
            if key and key not in held:
                held[key] = {"user_id": int(row["user_id"]), "name": _name(row)}
    return held


def heartbeat(
    db: Session,
    *,
    submission_id: int,
    user: dict,
    session_id: str,
    area: str | None,
    field: str | None,
    memos: list[str],
    typing: bool,
    can_edit: bool,
) -> dict:
    """Record where this copy of the form is, take the memo locks it may, and say who else is here."""
    sid, uid = int(submission_id), int(user["id"])
    # One heartbeat at a time per form, so two people cannot both take a free memo.
    db.execute(text("SELECT id FROM submissions WHERE id = :sid FOR UPDATE"), {"sid": sid})
    wanted = [key for key in dict.fromkeys(memos or []) if key in MEMO_KEYS] if can_edit else []
    held = memo_holders(db, sid, except_user_id=uid)
    granted = [key for key in wanted if key not in held]
    denied = {key: held[key] for key in wanted if key in held}

    previous = db.execute(
        text("SELECT memo_keys FROM submission_presence WHERE submission_id = :sid AND session_id = :session"),
        {"sid": sid, "session": session_id},
    ).scalar()
    newly_taken = set(granted) - set(str(previous or "").split(","))
    keys = ",".join(granted) or None
    db.execute(
        text(
            """
            INSERT INTO submission_presence (submission_id, session_id, user_id, area, field, memo_keys, memo_active_at, seen_at)
            VALUES (:sid, :session, :uid, :area, :field, :keys, CASE WHEN :keys IS NULL THEN NULL ELSE NOW() END, NOW())
            ON DUPLICATE KEY UPDATE
              user_id = VALUES(user_id), area = VALUES(area), field = VALUES(field),
              memo_active_at = CASE
                WHEN VALUES(memo_keys) IS NULL THEN NULL
                WHEN :touch = 1 OR memo_active_at IS NULL THEN NOW()
                ELSE memo_active_at END,
              memo_keys = VALUES(memo_keys),
              seen_at = NOW()
            """
        ),
        {
            "sid": sid,
            "session": session_id,
            "uid": uid,
            "area": (area or "")[:96] or None,
            "field": (field or "")[:160] or None,
            "keys": keys,
            "touch": 1 if (typing or newly_taken) else 0,
        },
    )
    # Copies of the form closed without saying goodbye.
    db.execute(
        text("DELETE FROM submission_presence WHERE submission_id = :sid AND seen_at < NOW() - INTERVAL 1 DAY"),
        {"sid": sid},
    )
    others = db.execute(
        text(
            f"""
            SELECT p.session_id, p.user_id, p.area, p.field, u.full_name, u.email,
                   CASE WHEN {_WRITING} THEN p.memo_keys END AS memos
              FROM submission_presence p JOIN users u ON u.id = p.user_id
             WHERE p.submission_id = :sid AND p.user_id <> :uid AND {_ALIVE}
             ORDER BY p.seen_at
            """
        ),
        {"sid": sid, "uid": uid},
    ).mappings().all()
    saved = db.execute(
        text(
            """
            SELECT g.revision, g.updated_at, u.full_name, u.email, g.updated_by_user_id
              FROM submission_gisa g LEFT JOIN users u ON u.id = g.updated_by_user_id
             WHERE g.submission_id = :sid
            """
        ),
        {"sid": sid},
    ).mappings().first()
    db.commit()
    return {
        "others": [
            {
                "session_id": row["session_id"],
                "user_id": int(row["user_id"]),
                "name": _name(row),
                "area": row["area"],
                "field": row["field"],
                "memos": [key for key in str(row["memos"] or "").split(",") if key],
            }
            for row in others
        ],
        "granted": granted,
        "denied": denied,
        "revision": int(saved["revision"]) if saved else 0,
        "saved_by": (
            {"user_id": int(saved["updated_by_user_id"]), "name": _name(saved)}
            if saved and saved["updated_by_user_id"] is not None
            else None
        ),
        "saved_at": saved["updated_at"].isoformat() if saved and saved["updated_at"] else None,
    }


def leave(db: Session, *, submission_id: int, user: dict, session_id: str) -> None:
    """This copy of the form closed: its place and its memo locks go at once."""
    db.execute(
        text("DELETE FROM submission_presence WHERE submission_id = :sid AND session_id = :session AND user_id = :uid"),
        {"sid": int(submission_id), "session": session_id, "uid": int(user["id"])},
    )
    db.commit()

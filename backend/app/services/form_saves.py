"""Saving a technical form that several people may have open.

The web form sends only the fields a person changed, each with the value it
had when they opened the form (``base``). A field someone else changed since
is refused with 409 and both values, so nobody's work is overwritten without
their say; every other field saves. Memos being written by someone else
(``form_presence``) are refused the same way. A save without ``base`` (the
mobile app, older pages) behaves as before.
"""
from __future__ import annotations

import json
import math
from typing import Any, Iterable

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder
from sqlalchemy import text
from sqlalchemy.orm import Session

from . import form_presence

# Fields whose rules read each other (one of a kind, or percentages kept only
# while their material is selected): a save touching one is judged against the
# saved values of the rest.
LINKED_GROUPS: tuple[tuple[str, ...], ...] = (
    (
        "material_rock", "material_soil", "material_bedding", "material_joints", "material_fractures",
        "est_rock_pct", "est_soil_pct", "est_clay_pct", "est_silt_pct", "est_sand_pct", "est_gravel_pct", "est_boulder_pct",
    ),
    ("water_dry", "water_moist", "water_wet", "water_flowing", "water_seep", "water_spring"),
    ("drainage_clogged_inlet", "drainage_compromised_drains", "drainage_surface_runoff", "drainage_torrent_surge_flood"),
)


def _norm(value: Any) -> Any:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        stripped = value.strip()
        try:
            number = float(stripped)
            if math.isfinite(number):
                return number
        except ValueError:
            pass
        return stripped
    if isinstance(value, (dict, list)):
        return json.dumps(value, sort_keys=True)
    return str(value)


def same(a: Any, b: Any) -> bool:
    """Equal as saved: numbers by value, blanks as nothing, JSON by content."""
    return _norm(jsonable_encoder(a)) == _norm(jsonable_encoder(b))


def _last_save(db: Session, submission_id: int) -> dict:
    row = db.execute(
        text(
            """
            SELECT g.revision, g.updated_at, u.full_name, u.email
              FROM submission_gisa g LEFT JOIN users u ON u.id = g.updated_by_user_id
             WHERE g.submission_id = :sid
            """
        ),
        {"sid": int(submission_id)},
    ).mappings().first()
    if not row:
        return {"saved_by": None, "saved_at": None, "revision": 0}
    return {
        "saved_by": row["full_name"] or row["email"],
        "saved_at": row["updated_at"].isoformat() if row["updated_at"] else None,
        "revision": int(row["revision"] or 0),
    }


def refuse_changed_since(db: Session, submission_id: int, base: dict, current: dict | None) -> None:
    """409 when any field in ``base`` no longer holds the value the person started from."""
    saved = jsonable_encoder(current or {})
    conflicts = [
        {"field": key, "theirs": saved.get(key)}
        for key, started_from in base.items()
        if not same(started_from, saved.get(key))
    ]
    if conflicts:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "Someone else saved changes to the same fields after you opened this form.",
                "conflicts": conflicts,
                **_last_save(db, submission_id),
            },
        )


def refuse_locked_memos(db: Session, submission_id: int, user: dict, keys: Iterable[str]) -> None:
    """409 when this save changes a memo someone else is writing."""
    memos = {key.removesuffix("_html") for key in keys} & set(form_presence.MEMO_KEYS)
    if not memos:
        return
    held = form_presence.memo_holders(db, submission_id, except_user_id=int(user["id"]))
    locked = {key: held[key] for key in sorted(memos) if key in held}
    if locked:
        first_key, holder = next(iter(locked.items()))
        raise HTTPException(
            status_code=409,
            detail={
                "message": f"{holder['name']} is writing {form_presence.MEMO_LABELS[first_key]}. It opens again once they save or stop.",
                "locked": locked,
                **_last_save(db, submission_id),
            },
        )


def fill_linked_groups(provided: dict, current: dict | None) -> None:
    """Complete each linked group this save touches from the saved values."""
    if not current:
        return
    for group in LINKED_GROUPS:
        if any(key in provided for key in group):
            for key in group:
                if key not in provided:
                    provided[key] = current.get(key)


def refuse_changed_list(db: Session, submission_id: int, field: str, base: list[str] | None, current: list[str]) -> None:
    """The same rule for a whole list (incident types, actions): refuse it if it moved since."""
    if base is None or sorted(set(base)) == sorted(set(current)):
        return
    raise HTTPException(
        status_code=409,
        detail={
            "message": "Someone else saved changes to the same fields after you opened this form.",
            "conflicts": [{"field": field, "theirs": sorted(set(current))}],
            **_last_save(db, submission_id),
        },
    )


def lock_form(db: Session, submission_id: int) -> None:
    """Hold the form's saved row until this save commits, so two saves cannot interleave."""
    db.execute(text("SELECT submission_id FROM submission_gisa WHERE submission_id = :sid FOR UPDATE"), {"sid": int(submission_id)})


def bump_revision(db: Session, submission_id: int, user: dict) -> None:
    db.execute(
        text("UPDATE submission_gisa SET revision = revision + 1, updated_by_user_id = :uid WHERE submission_id = :sid"),
        {"sid": int(submission_id), "uid": int(user["id"])},
    )

"""A person's saved screen layouts (``/me/layouts``).

Today there is one scope, ``submission_canvas``: the arrangement of the cards on
a technical form's GISA sheet. Each person keeps their own named layouts and may
mark one as the layout forms open with. A layout is presentation only — the
server stores what the client sends (bounded in size) and never reads it.

Every route acts on the caller's own layouts; another person's layout answers
404. Guests have no editable forms, so they are refused like every other
write-capable surface (``deny_public_only``).
"""

from __future__ import annotations

import json
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import deny_public_only

router = APIRouter(tags=["user-layouts"])

LayoutScope = Literal["submission_canvas"]
MAX_LAYOUTS_PER_SCOPE = 20
MAX_LAYOUT_BYTES = 20_000


class LayoutCreateIn(BaseModel):
    scope: LayoutScope
    name: str = Field(min_length=1, max_length=80)
    layout: dict[str, Any]
    is_default: bool = False


class LayoutUpdateIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    layout: dict[str, Any] | None = None
    is_default: bool | None = None


def _clean_name(name: str) -> str:
    cleaned = " ".join(name.split())
    if not cleaned:
        raise HTTPException(status_code=422, detail="Give the layout a name")
    return cleaned


def _layout_json(layout: dict[str, Any]) -> str:
    encoded = json.dumps(layout, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > MAX_LAYOUT_BYTES:
        raise HTTPException(status_code=413, detail="Layout is too large to save")
    return encoded


def _row_out(row) -> dict[str, Any]:
    layout = row["layout_json"]
    if isinstance(layout, (str, bytes)):
        layout = json.loads(layout)
    return {
        "id": int(row["id"]),
        "scope": row["scope"],
        "name": row["name"],
        "layout": layout,
        "is_default": bool(row["is_default"]),
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
    }


def _own_layout(db: Session, user_id: int, layout_id: int):
    row = db.execute(
        text(
            "SELECT id, scope, name, layout_json, is_default, updated_at FROM user_saved_layouts "
            "WHERE id = :id AND user_id = :uid"
        ),
        {"id": layout_id, "uid": user_id},
    ).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Layout not found")
    return row


def _clear_other_defaults(db: Session, user_id: int, scope: str, keep_id: int) -> None:
    db.execute(
        text(
            "UPDATE user_saved_layouts SET is_default = 0 "
            "WHERE user_id = :uid AND scope = :scope AND id <> :keep AND is_default = 1"
        ),
        {"uid": user_id, "scope": scope, "keep": keep_id},
    )


@router.get("/me/layouts")
def list_my_layouts(
    scope: LayoutScope = Query(...),
    db: Session = Depends(get_db),
    user=Depends(deny_public_only),
):
    rows = db.execute(
        text(
            "SELECT id, scope, name, layout_json, is_default, updated_at FROM user_saved_layouts "
            "WHERE user_id = :uid AND scope = :scope ORDER BY name"
        ),
        {"uid": int(user["id"]), "scope": scope},
    ).mappings().all()
    return {"items": [_row_out(row) for row in rows]}


@router.post("/me/layouts", status_code=201)
def create_my_layout(
    payload: LayoutCreateIn,
    db: Session = Depends(get_db),
    user=Depends(deny_public_only),
):
    user_id = int(user["id"])
    name = _clean_name(payload.name)
    count = db.execute(
        text("SELECT COUNT(*) FROM user_saved_layouts WHERE user_id = :uid AND scope = :scope"),
        {"uid": user_id, "scope": payload.scope},
    ).scalar()
    if int(count or 0) >= MAX_LAYOUTS_PER_SCOPE:
        raise HTTPException(status_code=409, detail=f"You can keep up to {MAX_LAYOUTS_PER_SCOPE} layouts; delete one first")
    try:
        db.execute(
            text(
                "INSERT INTO user_saved_layouts (user_id, scope, name, layout_json, is_default) "
                "VALUES (:uid, :scope, :name, :layout, :is_default)"
            ),
            {
                "uid": user_id,
                "scope": payload.scope,
                "name": name,
                "layout": _layout_json(payload.layout),
                "is_default": 1 if payload.is_default else 0,
            },
        )
        layout_id = int(db.execute(text("SELECT LAST_INSERT_ID()")).scalar())
        if payload.is_default:
            _clear_other_defaults(db, user_id, payload.scope, layout_id)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=f"You already have a layout named “{name}”")
    return _row_out(_own_layout(db, user_id, layout_id))


@router.put("/me/layouts/{layout_id}")
def update_my_layout(
    payload: LayoutUpdateIn,
    layout_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(deny_public_only),
):
    user_id = int(user["id"])
    current = _own_layout(db, user_id, layout_id)
    sets: list[str] = []
    params: dict[str, Any] = {"id": layout_id, "uid": user_id}
    if payload.name is not None:
        sets.append("name = :name")
        params["name"] = _clean_name(payload.name)
    if payload.layout is not None:
        sets.append("layout_json = :layout")
        params["layout"] = _layout_json(payload.layout)
    if payload.is_default is not None:
        sets.append("is_default = :is_default")
        params["is_default"] = 1 if payload.is_default else 0
    if not sets:
        return _row_out(current)
    try:
        db.execute(text(f"UPDATE user_saved_layouts SET {', '.join(sets)} WHERE id = :id AND user_id = :uid"), params)
        if payload.is_default:
            _clear_other_defaults(db, user_id, current["scope"], layout_id)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=f"You already have a layout named “{params.get('name')}”")
    return _row_out(_own_layout(db, user_id, layout_id))


@router.delete("/me/layouts/{layout_id}", status_code=204)
def delete_my_layout(
    layout_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(deny_public_only),
):
    user_id = int(user["id"])
    _own_layout(db, user_id, layout_id)
    db.execute(text("DELETE FROM user_saved_layouts WHERE id = :id AND user_id = :uid"), {"id": layout_id, "uid": user_id})
    db.commit()

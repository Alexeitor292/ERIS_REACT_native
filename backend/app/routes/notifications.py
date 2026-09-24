"""The notification feed, for the web portal's bell and the mobile app.

* ``GET /notifications`` — the newest first (``before_id`` pages back), with the
  unread count.
* ``GET /notifications/unread`` — just the count, for the badge.
* ``POST /notifications/read`` — mark some read (``ids``), or all of them.
* ``POST /notifications/devices`` / ``POST /notifications/devices/unregister`` —
  the phone's Expo push token, registered at sign-in and dropped at sign-out.

Everybody with a work role has a feed; a guest-only account has nothing to be told and is refused.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import deny_public_only
from ..services import notification_feed

router = APIRouter(tags=["notifications"])


class ReadIn(BaseModel):
    ids: list[int] | None = None  # omitted: all of them


class DeviceIn(BaseModel):
    token: str = Field(..., min_length=10, max_length=255)
    platform: str | None = Field(default=None, max_length=16)


@router.get("/notifications")
def list_notifications(
    limit: int = Query(30, ge=1, le=100),
    before_id: int | None = Query(None, ge=1),
    unread_only: bool = Query(False),
    db: Session = Depends(get_db),
    user=Depends(deny_public_only),
) -> dict[str, Any]:
    return notification_feed.feed(db, int(user["id"]), limit=limit, before_id=before_id, unread_only=unread_only)


@router.get("/notifications/unread")
def unread(db: Session = Depends(get_db), user=Depends(deny_public_only)) -> dict[str, int]:
    return {"unread": notification_feed.unread_count(db, int(user["id"]))}


@router.post("/notifications/read")
def mark_read(payload: ReadIn, db: Session = Depends(get_db), user=Depends(deny_public_only)) -> dict[str, int]:
    notification_feed.mark_read(db, int(user["id"]), payload.ids)
    db.commit()
    return {"unread": notification_feed.unread_count(db, int(user["id"]))}


@router.post("/notifications/devices")
def register_device(payload: DeviceIn, db: Session = Depends(get_db), user=Depends(deny_public_only)) -> dict[str, bool]:
    # A phone belongs to whoever signed in on it last.
    db.execute(
        text(
            """
            INSERT INTO push_devices (user_id, token, platform, is_active, last_seen_at)
            VALUES (:uid, :token, :platform, 1, NOW())
            ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), platform = VALUES(platform), is_active = 1, last_seen_at = NOW()
            """
        ),
        {"uid": int(user["id"]), "token": payload.token.strip(), "platform": (payload.platform or "").strip() or None},
    )
    db.commit()
    return {"registered": True}


@router.post("/notifications/devices/unregister")
def unregister_device(payload: DeviceIn, db: Session = Depends(get_db), user=Depends(deny_public_only)) -> dict[str, bool]:
    db.execute(
        text("UPDATE push_devices SET is_active = 0 WHERE token = :token AND user_id = :uid"),
        {"token": payload.token.strip(), "uid": int(user["id"])},
    )
    db.commit()
    return {"registered": False}

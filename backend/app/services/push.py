"""Push notifications to the ERIS mobile app, through Expo's push service.

The feed (``services/notification_feed.py``) is the record; push is only the
phone's lock-screen alert for it. A background loop started with the API sends
every new feed row to the phones its person has registered
(``push_devices``), marks the row SENT (or NONE when the person has no phone,
FAILED when Expo refused it), and retires a token Expo reports as no longer
registered.

Like email, it is off by default (``EXPO_PUSH_ENABLED``), never raises into a
request, and never logs a token or a message body.
"""
from __future__ import annotations

import json
import logging
import threading
import time
import urllib.request

from sqlalchemy import bindparam, text

from ..config import settings

logger = logging.getLogger("eris.push")

_BATCH = 100  # Expo accepts up to 100 messages per request
_INTERVAL_S = 10
_MAX_AGE_HOURS = 24  # an alert older than this is history, not news
_started = False


def enabled() -> bool:
    return bool(settings.EXPO_PUSH_ENABLED)


def _post(messages: list[dict]) -> list[dict]:
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if settings.EXPO_ACCESS_TOKEN:
        headers["Authorization"] = f"Bearer {settings.EXPO_ACCESS_TOKEN}"
    request = urllib.request.Request(settings.EXPO_PUSH_URL, data=json.dumps(messages).encode("utf-8"), headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=15) as response:  # noqa: S310 - fixed https endpoint
        return json.loads(response.read().decode("utf-8")).get("data") or []


def send_pending(db) -> dict:
    """Send the feed rows not pushed yet. Returns counts; never raises."""
    rows = db.execute(
        text(
            """
            SELECT id, user_id, title, body, link FROM user_notifications
             WHERE push_state IS NULL AND created_at >= NOW() - INTERVAL :hours HOUR
             ORDER BY id LIMIT :limit
            """
        ),
        {"hours": _MAX_AGE_HOURS, "limit": _BATCH},
    ).mappings().all()
    if not rows:
        return {"sent": 0, "none": 0, "failed": 0}
    users = sorted({int(row["user_id"]) for row in rows})
    tokens: dict[int, list[str]] = {}
    for user_id, token in db.execute(
        text("SELECT user_id, token FROM push_devices WHERE is_active = 1 AND user_id IN :ids").bindparams(bindparam("ids", expanding=True)),
        {"ids": users},
    ).all():
        tokens.setdefault(int(user_id), []).append(str(token))

    messages, owners = [], []
    states: dict[int, str] = {}
    for row in rows:
        mine = tokens.get(int(row["user_id"]), [])
        if not mine:
            states[int(row["id"])] = "NONE"
            continue
        for token in mine:
            messages.append({"to": token, "title": row["title"], "body": row["body"] or "", "sound": "default", "data": {"link": row["link"], "id": int(row["id"])}})
            owners.append((int(row["id"]), token))
        states[int(row["id"])] = "SENT"

    retired: set[str] = set()
    failed = 0
    for start in range(0, len(messages), _BATCH):
        chunk, chunk_owners = messages[start:start + _BATCH], owners[start:start + _BATCH]
        try:
            tickets = _post(chunk)
        except Exception as exc:  # network, Expo down: try again next round
            logger.warning("push delivery failed for %d messages: %s", len(chunk), type(exc).__name__)
            for notification_id, _ in chunk_owners:
                states.pop(notification_id, None)
            continue
        for (notification_id, token), ticket in zip(chunk_owners, tickets):
            if ticket.get("status") == "error":
                if (ticket.get("details") or {}).get("error") == "DeviceNotRegistered":
                    retired.add(token)
                states[notification_id] = "FAILED"
                failed += 1

    for state in ("SENT", "NONE", "FAILED"):
        ids = [nid for nid, s in states.items() if s == state]
        if ids:
            db.execute(
                text("UPDATE user_notifications SET push_state = :state WHERE id IN :ids").bindparams(bindparam("ids", expanding=True)),
                {"state": state, "ids": ids},
            )
    if retired:
        db.execute(
            text("UPDATE push_devices SET is_active = 0 WHERE token IN :tokens").bindparams(bindparam("tokens", expanding=True)),
            {"tokens": sorted(retired)},
        )
    db.commit()
    return {
        "sent": sum(1 for s in states.values() if s == "SENT"),
        "none": sum(1 for s in states.values() if s == "NONE"),
        "failed": failed,
    }


def _loop() -> None:
    from ..db import SessionLocal

    while True:
        try:
            db = SessionLocal()
            try:
                send_pending(db)
            finally:
                db.close()
        except Exception as exc:  # the loop must outlive any one bad round
            logger.warning("push round failed: %s", type(exc).__name__)
        time.sleep(_INTERVAL_S)


def start() -> None:
    """Start the sender once, when push is enabled."""
    global _started
    if _started or not enabled():
        return
    _started = True
    threading.Thread(target=_loop, name="eris-push", daemon=True).start()

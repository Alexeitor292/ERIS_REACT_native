"""The server's time zone, for times clients send.

``DATETIME`` columns carry no zone. The database and API run in the deploy's
``TZ`` (America/Los_Angeles; ``NOW()`` and every ``created_at`` are Pacific),
so a stored time without a zone is Pacific: the web sends ``datetime-local``
values that way. A client that sends a zoned time (the iPhone sends UTC with
``Z``) must be converted to that clock before it is stored; otherwise its UTC
clock reading is saved as if it were Pacific and the time is off by 7-8 hours.
"""

from __future__ import annotations

import os
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DEFAULT_ZONE = "America/Los_Angeles"


def server_zone() -> ZoneInfo:
    name = (os.environ.get("TZ") or DEFAULT_ZONE).lstrip(":")
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo(DEFAULT_ZONE)


def server_naive(value: datetime | None) -> datetime | None:
    """A zoned time as the server's clock reads it, without a zone; a naive one as sent."""
    if value is None or value.tzinfo is None:
        return value
    return value.astimezone(server_zone()).replace(tzinfo=None)

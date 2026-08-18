from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require_roles
from ..roles import OPERATIONAL_ROLES
from . import event_groups as event_group_routes

router = APIRouter(tags=["mission-center", "event-groups"])


@router.get("/mission-center/event-groups")
def mission_center_event_groups(
    after_id: int | None = Query(default=None, ge=1),
    limit: int = Query(default=1000, ge=1, le=1000),
    db: Session = Depends(get_db),
    _user=Depends(require_roles(sorted(OPERATIONAL_ROLES))),
):
    params: dict[str, object] = {"limit": limit + 1}
    where = ""
    if after_id is not None:
        where = "WHERE eg.id > :after_id"
        params["after_id"] = after_id

    rows = db.execute(
        text(
            f"""
            SELECT
              eg.id, eg.event_group_key, eg.title, eg.description, eg.status,
              eg.anchor_location_id, eg.anchor_latitude, eg.anchor_longitude,
              eg.district, eg.county, eg.route, eg.post_mile,
              eg.created_from_incident_id, eg.created_by_user_id, eg.source,
              eg.closed_at, eg.closed_by_user_id, eg.created_at, eg.updated_at,
              COUNT(i.id) AS incident_count,
              SUM(CASE WHEN i.status <> 'RESOLVED' THEN 1 ELSE 0 END) AS open_incident_count,
              MAX(i.updated_at) AS latest_incident_activity_at,
              AVG(i.latitude) AS centroid_latitude,
              AVG(i.longitude) AS centroid_longitude
            FROM event_groups eg
            LEFT JOIN incidents i ON i.event_group_id = eg.id
            {where}
            GROUP BY eg.id
            ORDER BY eg.id ASC
            LIMIT :limit
            """
        ),
        params,
    ).mappings().all()

    has_more = len(rows) > limit
    page_rows = rows[:limit]
    items = [event_group_routes._serialize_event_group(dict(row)) for row in page_rows]
    next_cursor = int(page_rows[-1]["id"]) if has_more and page_rows else None
    return {
        "items": items,
        "has_more": has_more,
        "next_cursor": next_cursor,
    }

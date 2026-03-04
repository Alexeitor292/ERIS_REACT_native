from __future__ import annotations

import hashlib
import json
import re

from fastapi import APIRouter, Depends, File, HTTPException, Path, Query, UploadFile
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import get_current_user, require_roles
from ..schemas.common import (
    IncidentAssignBranchChiefRequest,
    IncidentAssignEngineerRequest,
    IncidentAssignRequest,
    IncidentCoordinatorForwardRequest,
    IncidentCreate,
    IncidentResolveRequest,
)
from ..storage import make_object_key, put_object_bytes

router = APIRouter(tags=["incidents"])
OFFICE_BY_DISTRICT: dict[str, str] = {
    "1": "WEST",
    "2": "NORTH",
    "3": "NORTH",
    "4": "WEST",
    "5": "WEST",
    "6": "NORTH",
    "7": "SOUTH",
    "8": "SOUTH",
    "9": "NORTH",
    "10": "NORTH",
    "11": "SOUTH",
    "12": "SOUTH",
}


def _normalized_district_code(raw_district: str | None) -> str | None:
    value = (raw_district or "").strip()
    if not value:
        return None
    m = re.search(r"(\d{1,2})", value)
    return m.group(1) if m else value


def _office_for_district(raw_district: str | None) -> str | None:
    code = _normalized_district_code(raw_district)
    if not code:
        return None
    return OFFICE_BY_DISTRICT.get(code)


def _queue_incident_notifications(
    *,
    db: Session,
    incident_id: int,
    recipient_user_ids: list[int],
    template_code: str,
    payload: dict | None = None,
) -> None:
    unique_ids = sorted({int(x) for x in recipient_user_ids if int(x) > 0})
    if not unique_ids:
        return
    payload_json = json.dumps(payload or {})
    for uid in unique_ids:
        db.execute(
            text(
                """
                INSERT INTO incident_notifications
                  (incident_id, recipient_user_id, channel, template_code, payload_json)
                VALUES
                  (:iid, :uid, 'IN_APP', :template_code, CAST(:payload_json AS JSON))
                """
            ),
            {
                "iid": incident_id,
                "uid": uid,
                "template_code": template_code,
                "payload_json": payload_json,
            },
        )


def _routing_users_for(
    *,
    db: Session,
    assignment_type: str,
    district: str | None = None,
    office_code: str | None = None,
) -> list[int]:
    rows = db.execute(
        text(
            """
            SELECT user_id
            FROM incident_routing_assignments
            WHERE assignment_type = :assignment_type
              AND is_active = 1
              AND (:district IS NULL OR district = :district)
              AND (:office_code IS NULL OR office_code = :office_code)
            ORDER BY id ASC
            """
        ),
        {
            "assignment_type": assignment_type,
            "district": district,
            "office_code": office_code,
        },
    ).scalars().all()
    return [int(x) for x in rows]


def _active_assignment_for_stage(db: Session, incident_id: int, stage: str) -> dict | None:
    row = db.execute(
        text(
            """
            SELECT a.id, a.assignee_user_id, a.assigned_by_user_id, a.assignment_mode, a.created_at
            FROM incident_assignments a
            WHERE a.incident_id = :iid
              AND a.assignment_stage = :stage
              AND a.is_active = 1
            ORDER BY a.id DESC
            LIMIT 1
            """
        ),
        {"iid": incident_id, "stage": stage},
    ).mappings().first()
    return dict(row) if row else None


def _set_stage_assignment(
    *,
    db: Session,
    incident_id: int,
    assignee_user_id: int,
    assigned_by_user_id: int,
    assignment_mode: str,
    assignment_stage: str,
) -> None:
    db.execute(
        text(
            """
            UPDATE incident_assignments
            SET is_active = 0, updated_at = NOW()
            WHERE incident_id = :iid AND assignment_stage = :stage AND is_active = 1
            """
        ),
        {"iid": incident_id, "stage": assignment_stage},
    )
    db.execute(
        text(
            """
            INSERT INTO incident_assignments (
              incident_id, assignee_user_id, assigned_by_user_id, assignment_stage, assignment_mode, is_active
            ) VALUES (
              :iid, :assignee, :assigned_by, :stage, :mode, 1
            )
            """
        ),
        {
            "iid": incident_id,
            "assignee": assignee_user_id,
            "assigned_by": assigned_by_user_id,
            "stage": assignment_stage,
            "mode": assignment_mode,
        },
    )


def ensure_incident_runtime_schema(db: Session) -> None:
    ddl_statements = [
        """
        ALTER TABLE incidents
          ADD COLUMN IF NOT EXISTS first_observed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        """,
        """
        ALTER TABLE incidents
          ADD COLUMN IF NOT EXISTS first_occurred_at DATETIME NULL
        """,
        """
        ALTER TABLE incidents
          ADD COLUMN IF NOT EXISTS office_code VARCHAR(16) NULL
        """,
        """
        ALTER TABLE incidents
          ADD COLUMN IF NOT EXISTS current_stage VARCHAR(32) NOT NULL DEFAULT 'COORDINATOR_REVIEW'
        """,
        """
        ALTER TABLE incident_assignments
          ADD COLUMN IF NOT EXISTS assignment_stage VARCHAR(32) NOT NULL DEFAULT 'ENGINEER'
        """,
        """
        CREATE TABLE IF NOT EXISTS incident_routing_assignments (
          id BIGINT PRIMARY KEY AUTO_INCREMENT,
          assignment_type VARCHAR(32) NOT NULL,
          district VARCHAR(64) NULL,
          office_code VARCHAR(16) NULL,
          user_id BIGINT NOT NULL,
          is_active TINYINT NOT NULL DEFAULT 1,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          CONSTRAINT fk_inc_route_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE KEY uk_inc_route_unique (assignment_type, district, office_code, user_id),
          INDEX idx_inc_route_lookup (assignment_type, district, office_code, is_active)
        ) ENGINE=InnoDB
        """,
        """
        CREATE TABLE IF NOT EXISTS incident_notifications (
          id BIGINT PRIMARY KEY AUTO_INCREMENT,
          incident_id BIGINT NOT NULL,
          recipient_user_id BIGINT NOT NULL,
          channel VARCHAR(16) NOT NULL DEFAULT 'IN_APP',
          template_code VARCHAR(64) NOT NULL,
          payload_json JSON NULL,
          delivered_at DATETIME NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT fk_inc_notify_incident FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE,
          CONSTRAINT fk_inc_notify_recipient FOREIGN KEY (recipient_user_id) REFERENCES users(id) ON DELETE CASCADE,
          INDEX idx_inc_notify_incident (incident_id),
          INDEX idx_inc_notify_recipient (recipient_user_id),
          INDEX idx_inc_notify_created (created_at)
        ) ENGINE=InnoDB
        """,
    ]
    for sql in ddl_statements:
        db.execute(text(sql))


def _incident_with_assignment(db: Session, incident_id: int):
    row = db.execute(
        text(
            """
            SELECT
              i.id, i.title, i.incident_type, i.description,
              i.first_observed_at, i.first_occurred_at,
              i.latitude, i.longitude, i.district, i.county, i.route, i.post_mile,
              i.office_code, i.current_stage,
              i.status, i.reporter_user_id, i.created_at, i.updated_at,
              i.resolved_at, i.resolved_by_user_id, i.resolution_comment,
              a.id AS assignment_id, a.assignee_user_id, a.assigned_by_user_id,
              a.assignment_mode, a.assignment_stage, a.created_at AS assigned_at,
              u.email AS assignee_email, u.full_name AS assignee_name,
              isl.submission_id
            FROM incidents i
            LEFT JOIN incident_assignments a
              ON a.incident_id = i.id AND a.assignment_stage = 'ENGINEER' AND a.is_active = 1
            LEFT JOIN users u
              ON u.id = a.assignee_user_id
            LEFT JOIN incident_submission_links isl
              ON isl.incident_id = i.id
            WHERE i.id = :iid
            LIMIT 1
            """
        ),
        {"iid": incident_id},
    ).mappings().first()
    return row


def _mobile_scope_filters(db: Session, user: dict) -> tuple[list[str], dict[str, object]]:
    roles = set(user.get("roles") or [])
    uid = int(user["id"])
    if "ADMIN" in roles:
        return [], {}

    role_filters: list[str] = []
    params: dict[str, object] = {"mobile_uid": uid}

    if "MAINT_COORDINATOR" in roles:
        my_districts = db.execute(
            text(
                """
                SELECT district
                FROM incident_routing_assignments
                WHERE assignment_type = 'DISTRICT_COORDINATOR'
                  AND user_id = :uid
                  AND is_active = 1
                """
            ),
            {"uid": uid},
        ).scalars().all()
        normalized = sorted({str(x).strip() for x in my_districts if str(x).strip()})
        if normalized:
            district_clauses: list[str] = []
            for i, d in enumerate(normalized):
                k = f"coord_d_{i}"
                params[k] = d
                district_clauses.append(f"i.district = :{k}")
                district_clauses.append(f"i.district = CONCAT('District ', :{k})")
            role_filters.append(f"({' OR '.join(district_clauses)})")

    if "OFFICE_CHIEF" in roles:
        my_offices = db.execute(
            text(
                """
                SELECT office_code
                FROM incident_routing_assignments
                WHERE assignment_type = 'OFFICE_CHIEF'
                  AND user_id = :uid
                  AND is_active = 1
                """
            ),
            {"uid": uid},
        ).scalars().all()
        offices = sorted({str(x).strip().upper() for x in my_offices if str(x).strip()})
        if offices:
            office_tokens = []
            for i, o in enumerate(offices):
                k = f"oc_o_{i}"
                params[k] = o
                office_tokens.append(f":{k}")
            role_filters.append(
                f"(i.office_code IN ({', '.join(office_tokens)}) AND i.current_stage <> 'COORDINATOR_REVIEW')"
            )

    if "BRANCH_CHIEF" in roles:
        my_offices = db.execute(
            text(
                """
                SELECT office_code
                FROM incident_routing_assignments
                WHERE assignment_type = 'BRANCH_CHIEF'
                  AND user_id = :uid
                  AND is_active = 1
                """
            ),
            {"uid": uid},
        ).scalars().all()
        offices = sorted({str(x).strip().upper() for x in my_offices if str(x).strip()})
        if offices:
            office_tokens = []
            for i, o in enumerate(offices):
                k = f"bc_o_{i}"
                params[k] = o
                office_tokens.append(f":{k}")
            role_filters.append(
                f"(i.office_code IN ({', '.join(office_tokens)}) AND i.current_stage IN ('BRANCH_CHIEF_REVIEW','ENGINEER_ASSIGNED','RESOLVED'))"
            )

    if "FIELD_WORKER" in roles:
        role_filters.append(
            "EXISTS (SELECT 1 FROM incident_assignments ia WHERE ia.incident_id = i.id AND ia.assignment_stage = 'ENGINEER' AND ia.is_active = 1 AND ia.assignee_user_id = :mobile_uid)"
        )

    if "MAINTENANCE" in roles:
        role_filters.append("i.reporter_user_id = :mobile_uid")

    if not role_filters:
        return ["1=0"], params
    return [f"({' OR '.join(role_filters)})"], params


def _serialize_incident(row: dict) -> dict:
    return {
        "id": int(row["id"]),
        "title": row["title"],
        "incident_type": row["incident_type"],
        "description": row["description"],
        "first_observed_at": row["first_observed_at"],
        "first_occurred_at": row["first_occurred_at"],
        "latitude": float(row["latitude"]),
        "longitude": float(row["longitude"]),
        "district": row["district"],
        "county": row["county"],
        "route": row["route"],
        "post_mile": row["post_mile"],
        "office_code": row["office_code"],
        "current_stage": row["current_stage"],
        "status": row["status"],
        "reporter_user_id": int(row["reporter_user_id"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "resolved_at": row["resolved_at"],
        "resolved_by_user_id": row["resolved_by_user_id"],
        "resolution_comment": row["resolution_comment"],
        "linked_submission_id": int(row["submission_id"]) if row["submission_id"] is not None else None,
        "assignment": (
            {
                "assignment_id": int(row["assignment_id"]),
                "assignee_user_id": int(row["assignee_user_id"]),
                "assigned_by_user_id": int(row["assigned_by_user_id"]),
                "assignment_mode": row["assignment_mode"],
                "assignment_stage": row["assignment_stage"],
                "assigned_at": row["assigned_at"],
                "assignee_email": row["assignee_email"],
                "assignee_name": row["assignee_name"],
            }
            if row["assignment_id"] is not None
            else None
        ),
    }


def _ensure_linked_submission(
    *,
    db: Session,
    incident_row: dict,
    assignee_user_id: int,
    actor_user_id: int,
) -> int:
    existing = db.execute(
        text(
            """
            SELECT submission_id
            FROM incident_submission_links
            WHERE incident_id = :iid
            LIMIT 1
            """
        ),
        {"iid": int(incident_row["id"])},
    ).scalar()
    if existing is not None:
        db.execute(
            text(
                """
                INSERT INTO submission_editors (submission_id, user_id, granted_by_user_id)
                VALUES (:sid, :uid, :granted_by)
                ON DUPLICATE KEY UPDATE granted_by_user_id = VALUES(granted_by_user_id)
                """
            ),
            {"sid": int(existing), "uid": assignee_user_id, "granted_by": actor_user_id},
        )
        return int(existing)

    title = f"Incident #{int(incident_row['id'])}: {incident_row['title']}"
    db.execute(
        text(
            """
            INSERT INTO submissions (created_by_user_id, status, client_submission_uuid, title)
            VALUES (:uid, 'DRAFT', UUID(), :title)
            """
        ),
        {"uid": assignee_user_id, "title": title},
    )
    submission_id = int(db.execute(text("SELECT LAST_INSERT_ID()")).scalar())

    db.execute(
        text(
            """
            INSERT INTO workflow_events
              (submission_id, actor_user_id, event_type, from_status, to_status, comment)
            VALUES
              (:sid, :actor, 'CREATE', NULL, 'DRAFT', :comment)
            """
        ),
        {
            "sid": submission_id,
            "actor": actor_user_id,
            "comment": f"Draft created from incident #{int(incident_row['id'])}",
        },
    )

    db.execute(
        text(
            """
            INSERT INTO submission_gisa (
              submission_id,
              report_date,
              date_incident_reported,
              district,
              county,
              route,
              post_mile,
              latitude,
              longitude,
              updated_by_user_id
            ) VALUES (
              :sid,
              :date_incident_reported,
              CURDATE(),
              :district,
              :county,
              :route,
              :post_mile,
              :lat,
              :lon,
              :updated_by
            )
            """
        ),
        {
            "sid": submission_id,
            "district": incident_row["district"],
            "county": incident_row["county"],
            "route": incident_row["route"],
            "post_mile": incident_row["post_mile"],
            "date_incident_reported": (
                incident_row["first_observed_at"].date()
                if incident_row.get("first_observed_at") is not None
                else None
            ),
            "lat": incident_row["latitude"],
            "lon": incident_row["longitude"],
            "updated_by": actor_user_id,
        },
    )

    db.execute(
        text(
            """
            INSERT INTO incident_submission_links (incident_id, submission_id, linked_by_user_id)
            VALUES (:iid, :sid, :uid)
            """
        ),
        {"iid": int(incident_row["id"]), "sid": submission_id, "uid": actor_user_id},
    )
    reporter_uid = int(incident_row["reporter_user_id"])
    if reporter_uid != assignee_user_id:
        db.execute(
            text(
                """
                INSERT INTO submission_visibility (submission_id, user_id, granted_by_user_id)
                VALUES (:sid, :uid, :granted_by)
                ON DUPLICATE KEY UPDATE granted_by_user_id = VALUES(granted_by_user_id)
                """
            ),
            {"sid": submission_id, "uid": reporter_uid, "granted_by": actor_user_id},
        )
    return submission_id


def _assign_incident(
    *,
    db: Session,
    incident_id: int,
    assignee_user_id: int,
    assigned_by_user_id: int,
    mode: str,
    require_unclaimed: bool = False,
) -> dict:
    incident = _incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    if str(incident["status"]).upper() == "RESOLVED":
        raise HTTPException(status_code=409, detail="Resolved incidents cannot be reassigned")
    if require_unclaimed and incident["assignee_user_id"] is not None and int(incident["assignee_user_id"]) != assignee_user_id:
        raise HTTPException(status_code=409, detail="Incident is already assigned")

    assignee = db.execute(
        text("SELECT id, is_active FROM users WHERE id = :uid LIMIT 1"),
        {"uid": assignee_user_id},
    ).mappings().first()
    if not assignee or int(assignee["is_active"]) != 1:
        raise HTTPException(status_code=404, detail="Assignee not found or inactive")

    _set_stage_assignment(
        db=db,
        incident_id=incident_id,
        assignee_user_id=assignee_user_id,
        assigned_by_user_id=assigned_by_user_id,
        assignment_mode=mode,
        assignment_stage="ENGINEER",
    )

    db.execute(
        text(
            """
            UPDATE incidents
            SET status = 'IN_PROGRESS',
                current_stage = 'ENGINEER_ASSIGNED',
                updated_at = NOW()
            WHERE id = :iid
            """
        ),
        {"iid": incident_id},
    )

    linked_submission_id = _ensure_linked_submission(
        db=db,
        incident_row=incident,
        assignee_user_id=assignee_user_id,
        actor_user_id=assigned_by_user_id,
    )
    return {
        "incident_id": incident_id,
        "assignee_user_id": assignee_user_id,
        "assignment_mode": mode,
        "assignment_stage": "ENGINEER",
        "linked_submission_id": linked_submission_id,
    }


def _notify_coordinator_engineer_assigned(*, db: Session, incident_id: int) -> None:
    incident = db.execute(
        text("SELECT district, office_code FROM incidents WHERE id = :iid LIMIT 1"),
        {"iid": incident_id},
    ).mappings().first()
    if not incident:
        return
    district_code = _normalized_district_code(incident["district"])
    recipients = _routing_users_for(
        db=db,
        assignment_type="DISTRICT_COORDINATOR",
        district=district_code,
    )
    _queue_incident_notifications(
        db=db,
        incident_id=incident_id,
        recipient_user_ids=recipients,
        template_code="INCIDENT_ENGINEER_ASSIGNED",
        payload={"incident_id": incident_id, "district": district_code, "office_code": incident["office_code"]},
    )


@router.post("/incidents")
def create_incident(
    payload: IncidentCreate,
    db: Session = Depends(get_db),
    user=Depends(require_roles(["MAINTENANCE", "FIELD_WORKER", "ADMIN"])),
):
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title is required")
    district_code = _normalized_district_code(payload.district)
    office_code = _office_for_district(payload.district)
    try:
        db.execute(
            text(
                """
                INSERT INTO incidents (
                  title, incident_type, description, latitude, longitude,
                  first_observed_at, first_occurred_at,
                  district, county, route, post_mile, office_code, current_stage,
                  status, reporter_user_id
                ) VALUES (
                  :title, :incident_type, :description, :lat, :lon,
                  :first_observed_at, :first_occurred_at,
                  :district, :county, :route, :post_mile, :office_code, 'COORDINATOR_REVIEW',
                  'NEW', :uid
                )
                """
            ),
            {
                "title": title,
                "incident_type": (payload.incident_type or "").strip() or None,
                "description": (payload.description or "").strip() or None,
                "lat": payload.latitude,
                "lon": payload.longitude,
                "first_observed_at": payload.first_observed_at,
                "first_occurred_at": payload.first_occurred_at,
                "district": (payload.district or "").strip() or None,
                "county": (payload.county or "").strip() or None,
                "route": (payload.route or "").strip() or None,
                "post_mile": (payload.post_mile or "").strip() or None,
                "office_code": office_code,
                "uid": user["id"],
            },
        )
        new_id = int(db.execute(text("SELECT LAST_INSERT_ID()")).scalar())
        coordinator_ids = _routing_users_for(
            db=db,
            assignment_type="DISTRICT_COORDINATOR",
            district=district_code,
        )
        if coordinator_ids:
            _set_stage_assignment(
                db=db,
                incident_id=new_id,
                assignee_user_id=coordinator_ids[0],
                assigned_by_user_id=int(user["id"]),
                assignment_mode="ASSIGN",
                assignment_stage="COORDINATOR",
            )
            _queue_incident_notifications(
                db=db,
                incident_id=new_id,
                recipient_user_ids=coordinator_ids,
                template_code="INCIDENT_COORDINATOR_REVIEW",
                payload={"incident_id": new_id, "district": district_code, "office_code": office_code},
            )
        db.commit()
        row = _incident_with_assignment(db, new_id)
        return {"incident": _serialize_incident(dict(row))}
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/incidents")
def list_incidents(
    status: str | None = Query(default=None),
    unclaimed_only: bool = Query(default=False),
    scope: str | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=1000),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["MAINTENANCE", "FIELD_WORKER", "REVIEWER", "ADMIN"])),
):
    params: dict[str, object] = {"limit": limit}
    where_parts: list[str] = []
    if status:
        status_u = status.strip().upper()
        if status_u not in {"NEW", "IN_PROGRESS", "RESOLVED"}:
            raise HTTPException(status_code=400, detail="Invalid incident status filter")
        where_parts.append("i.status = :status")
        params["status"] = status_u
    if unclaimed_only:
        where_parts.append("a.id IS NULL")
    if (scope or "").strip().lower() == "mobile":
        mobile_filters, mobile_params = _mobile_scope_filters(db, user)
        where_parts.extend(mobile_filters)
        params.update(mobile_params)
    where_sql = f"WHERE {' AND '.join(where_parts)}" if where_parts else ""
    rows = db.execute(
        text(
            f"""
            SELECT
              i.id, i.title, i.incident_type, i.description,
              i.first_observed_at, i.first_occurred_at,
              i.latitude, i.longitude, i.district, i.county, i.route, i.post_mile,
              i.office_code, i.current_stage,
              i.status, i.reporter_user_id, i.created_at, i.updated_at,
              i.resolved_at, i.resolved_by_user_id, i.resolution_comment,
              a.id AS assignment_id, a.assignee_user_id, a.assigned_by_user_id,
              a.assignment_mode, a.assignment_stage, a.created_at AS assigned_at,
              u.email AS assignee_email, u.full_name AS assignee_name,
              isl.submission_id
            FROM incidents i
            LEFT JOIN incident_assignments a
              ON a.incident_id = i.id AND a.assignment_stage = 'ENGINEER' AND a.is_active = 1
            LEFT JOIN users u
              ON u.id = a.assignee_user_id
            LEFT JOIN incident_submission_links isl
              ON isl.incident_id = i.id
            {where_sql}
            ORDER BY i.created_at DESC, i.id DESC
            LIMIT :limit
            """
        ),
        params,
    ).mappings().all()
    return {"items": [_serialize_incident(dict(r)) for r in rows], "requested_by_user_id": user["id"]}


@router.get("/incidents/{incident_id}")
def get_incident(
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["MAINTENANCE", "FIELD_WORKER", "REVIEWER", "ADMIN"])),
):
    row = _incident_with_assignment(db, incident_id)
    if not row:
        raise HTTPException(status_code=404, detail="Incident not found")
    return {"incident": _serialize_incident(dict(row)), "requested_by_user_id": user["id"]}


@router.post("/incidents/{incident_id}/claim")
def claim_incident(
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["MAINTENANCE", "FIELD_WORKER", "ADMIN"])),
):
    raise HTTPException(status_code=409, detail="Claim is disabled. Incidents must follow coordinator/office/branch workflow.")


@router.post("/incidents/{incident_id}/assign")
def assign_incident(
    payload: IncidentAssignRequest,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN"])),
):
    try:
        result = _assign_incident(
            db=db,
            incident_id=incident_id,
            assignee_user_id=int(payload.assignee_user_id),
            assigned_by_user_id=int(user["id"]),
            mode="ASSIGN",
        )
        _notify_coordinator_engineer_assigned(db=db, incident_id=incident_id)
        db.commit()
        return result
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/incidents/{incident_id}/coordinator/forward")
def coordinator_forward_incident(
    payload: IncidentCoordinatorForwardRequest,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["MAINT_COORDINATOR", "ADMIN"])),
):
    incident = _incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    if str(incident["status"]).upper() == "RESOLVED":
        raise HTTPException(status_code=409, detail="Resolved incidents cannot be forwarded")

    office_code = incident.get("office_code")
    if not office_code:
        office_code = _office_for_district(incident.get("district"))

    office_chief_ids = _routing_users_for(
        db=db,
        assignment_type="OFFICE_CHIEF",
        office_code=office_code,
    )
    if not office_chief_ids:
        raise HTTPException(status_code=400, detail="No office chief routing configured for this office")

    try:
        db.execute(
            text(
                """
                UPDATE incidents
                SET current_stage = 'OFFICE_CHIEF_REVIEW',
                    office_code = :office_code,
                    updated_at = NOW()
                WHERE id = :iid
                """
            ),
            {"iid": incident_id, "office_code": office_code},
        )
        _set_stage_assignment(
            db=db,
            incident_id=incident_id,
            assignee_user_id=office_chief_ids[0],
            assigned_by_user_id=int(user["id"]),
            assignment_mode="ASSIGN",
            assignment_stage="OFFICE_CHIEF",
        )
        _queue_incident_notifications(
            db=db,
            incident_id=incident_id,
            recipient_user_ids=office_chief_ids,
            template_code="INCIDENT_OFFICE_CHIEF_REVIEW",
            payload={
                "incident_id": incident_id,
                "office_code": office_code,
                "comment": (payload.comment or "").strip() or None,
            },
        )
        db.commit()
        return {"incident_id": incident_id, "current_stage": "OFFICE_CHIEF_REVIEW", "office_code": office_code}
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/incidents/{incident_id}/office-chief/assign-branch")
def office_chief_assign_branch(
    payload: IncidentAssignBranchChiefRequest,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["OFFICE_CHIEF", "ADMIN"])),
):
    incident = _incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    if str(incident["status"]).upper() == "RESOLVED":
        raise HTTPException(status_code=409, detail="Resolved incidents cannot be reassigned")

    office_code = incident.get("office_code") or _office_for_district(incident.get("district"))
    allowed_branch_ids = _routing_users_for(
        db=db,
        assignment_type="BRANCH_CHIEF",
        office_code=office_code,
    )
    if int(payload.branch_chief_user_id) not in set(allowed_branch_ids):
        raise HTTPException(status_code=400, detail="Selected user is not configured as a branch chief for this office")

    try:
        db.execute(
            text(
                """
                UPDATE incidents
                SET current_stage = 'BRANCH_CHIEF_REVIEW',
                    office_code = :office_code,
                    updated_at = NOW()
                WHERE id = :iid
                """
            ),
            {"iid": incident_id, "office_code": office_code},
        )
        _set_stage_assignment(
            db=db,
            incident_id=incident_id,
            assignee_user_id=int(payload.branch_chief_user_id),
            assigned_by_user_id=int(user["id"]),
            assignment_mode="ASSIGN",
            assignment_stage="BRANCH_CHIEF",
        )
        _queue_incident_notifications(
            db=db,
            incident_id=incident_id,
            recipient_user_ids=[int(payload.branch_chief_user_id)],
            template_code="INCIDENT_BRANCH_CHIEF_ASSIGNMENT",
            payload={"incident_id": incident_id, "office_code": office_code},
        )
        db.commit()
        return {"incident_id": incident_id, "current_stage": "BRANCH_CHIEF_REVIEW"}
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/incidents/{incident_id}/branch-chief/assign-engineer")
def branch_chief_assign_engineer(
    payload: IncidentAssignEngineerRequest,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["BRANCH_CHIEF", "ADMIN"])),
):
    try:
        result = _assign_incident(
            db=db,
            incident_id=incident_id,
            assignee_user_id=int(payload.engineer_user_id),
            assigned_by_user_id=int(user["id"]),
            mode="ASSIGN",
        )
        _notify_coordinator_engineer_assigned(db=db, incident_id=incident_id)
        db.commit()
        return result
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/incidents/routing/assignments")
def list_incident_routing_assignments(
    assignment_type: str | None = Query(default=None),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN"])),
):
    params: dict[str, object] = {}
    where = ""
    if assignment_type:
        where = "WHERE assignment_type = :assignment_type"
        params["assignment_type"] = assignment_type.strip().upper()
    rows = db.execute(
        text(
            f"""
            SELECT
              ra.id, ra.assignment_type, ra.district, ra.office_code, ra.user_id, ra.is_active,
              u.email, u.full_name
            FROM incident_routing_assignments ra
            JOIN users u ON u.id = ra.user_id
            {where}
            ORDER BY ra.assignment_type, ra.district, ra.office_code, ra.id
            """
        ),
        params,
    ).mappings().all()
    return {
        "items": [
            {
                "id": int(r["id"]),
                "assignment_type": r["assignment_type"],
                "district": r["district"],
                "office_code": r["office_code"],
                "user_id": int(r["user_id"]),
                "is_active": bool(r["is_active"]),
                "email": r["email"],
                "full_name": r["full_name"],
            }
            for r in rows
        ],
        "requested_by_user_id": user["id"],
    }


@router.post("/incidents/routing/assignments")
def create_incident_routing_assignment(
    payload: dict,
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN"])),
):
    assignment_type = str(payload.get("assignment_type") or "").strip().upper()
    district = _normalized_district_code(payload.get("district"))
    office_code = str(payload.get("office_code") or "").strip().upper() or None
    user_id = int(payload.get("user_id") or 0)
    is_active = 1 if bool(payload.get("is_active", True)) else 0
    if assignment_type not in {"DISTRICT_COORDINATOR", "OFFICE_CHIEF", "BRANCH_CHIEF"}:
        raise HTTPException(status_code=400, detail="Invalid assignment_type")
    if user_id <= 0:
        raise HTTPException(status_code=400, detail="user_id is required")
    if assignment_type == "DISTRICT_COORDINATOR" and not district:
        raise HTTPException(status_code=400, detail="district is required for DISTRICT_COORDINATOR")
    if assignment_type in {"OFFICE_CHIEF", "BRANCH_CHIEF"} and not office_code:
        raise HTTPException(status_code=400, detail="office_code is required for this assignment_type")
    try:
        db.execute(
            text(
                """
                INSERT INTO incident_routing_assignments
                  (assignment_type, district, office_code, user_id, is_active)
                VALUES
                  (:assignment_type, :district, :office_code, :user_id, :is_active)
                ON DUPLICATE KEY UPDATE
                  is_active = VALUES(is_active),
                  updated_at = NOW()
                """
            ),
            {
                "assignment_type": assignment_type,
                "district": district,
                "office_code": office_code,
                "user_id": user_id,
                "is_active": is_active,
            },
        )
        db.commit()
        return {"ok": True, "assignment_type": assignment_type, "district": district, "office_code": office_code, "user_id": user_id}
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/incidents/routing/assignments/{assignment_id}")
def delete_incident_routing_assignment(
    assignment_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN"])),
):
    db.execute(text("DELETE FROM incident_routing_assignments WHERE id = :id"), {"id": assignment_id})
    db.commit()
    return {"ok": True, "assignment_id": assignment_id, "deleted_by_user_id": user["id"]}


@router.post("/incidents/{incident_id}/unassign")
def unassign_incident(
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN"])),
):
    incident = _incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    if str(incident["status"]).upper() == "RESOLVED":
        raise HTTPException(status_code=409, detail="Resolved incidents cannot be unassigned")
    try:
        db.execute(
            text(
                """
                UPDATE incident_assignments
                SET is_active = 0, updated_at = NOW()
                WHERE incident_id = :iid AND assignment_stage = 'ENGINEER' AND is_active = 1
                """
            ),
            {"iid": incident_id},
        )
        db.execute(
            text(
                """
                UPDATE incidents
                SET status = 'NEW',
                    current_stage = 'BRANCH_CHIEF_REVIEW',
                    updated_at = NOW()
                WHERE id = :iid
                """
            ),
            {"iid": incident_id},
        )
        db.commit()
        return {"incident_id": incident_id, "status": "NEW"}
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/incidents/{incident_id}/resolve")
def resolve_incident(
    payload: IncidentResolveRequest,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["FIELD_WORKER", "ADMIN"])),
):
    incident = _incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    assignee_user_id = incident["assignee_user_id"]
    if not ("ADMIN" in set(user["roles"]) or (assignee_user_id is not None and int(assignee_user_id) == int(user["id"]))):
        raise HTTPException(status_code=403, detail="Only assigned engineer or admin can resolve")
    try:
        db.execute(
            text(
                """
                UPDATE incidents
                SET status = 'RESOLVED',
                    current_stage = 'RESOLVED',
                    resolved_at = NOW(),
                    resolved_by_user_id = :uid,
                    resolution_comment = :comment,
                    updated_at = NOW()
                WHERE id = :iid
                """
            ),
            {
                "iid": incident_id,
                "uid": user["id"],
                "comment": (payload.comment or "").strip() or None,
            },
        )
        db.execute(
            text(
                """
                UPDATE incident_assignments
                SET is_active = 0, updated_at = NOW()
                WHERE incident_id = :iid AND is_active = 1
                """
            ),
            {"iid": incident_id},
        )
        db.commit()
        return {"incident_id": incident_id, "status": "RESOLVED"}
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/mission-center/incidents")
def mission_center_incident_feed(
    scope: str | None = Query(default=None),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["MAINTENANCE", "FIELD_WORKER", "REVIEWER", "ADMIN"])),
):
    where_parts: list[str] = []
    params: dict[str, object] = {}
    if (scope or "").strip().lower() == "mobile":
        mobile_filters, mobile_params = _mobile_scope_filters(db, user)
        where_parts.extend(mobile_filters)
        params.update(mobile_params)
    where_sql = f"WHERE {' AND '.join(where_parts)}" if where_parts else ""
    rows = db.execute(
        text(
            f"""
            SELECT
              i.id,
              i.title,
              i.incident_type,
              i.current_stage,
              i.status,
              i.latitude,
              i.longitude,
              i.created_at,
              i.updated_at,
              a.assignee_user_id,
              u.full_name AS assignee_name,
              isl.submission_id
            FROM incidents i
            LEFT JOIN incident_assignments a
              ON a.incident_id = i.id AND a.is_active = 1
            LEFT JOIN users u
              ON u.id = a.assignee_user_id
            LEFT JOIN incident_submission_links isl
              ON isl.incident_id = i.id
            {where_sql}
            ORDER BY i.created_at DESC, i.id DESC
            """
        ),
        params,
    ).mappings().all()
    return {
        "items": [
            {
                "id": int(r["id"]),
                "title": r["title"],
                "incident_type": r["incident_type"],
                "current_stage": r["current_stage"],
                "status": r["status"],
                "latitude": float(r["latitude"]),
                "longitude": float(r["longitude"]),
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
                "assignee_user_id": int(r["assignee_user_id"]) if r["assignee_user_id"] is not None else None,
                "assignee_name": r["assignee_name"],
                "linked_submission_id": int(r["submission_id"]) if r["submission_id"] is not None else None,
            }
            for r in rows
        ],
        "requested_by_user_id": user["id"],
    }


@router.post("/incidents/{incident_id}/attachments")
async def upload_incident_attachment(
    incident_id: int = Path(..., ge=1),
    file: UploadFile = File(...),
    kind: str = Query(default="PHOTO", max_length=16),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["MAINTENANCE", "FIELD_WORKER", "ADMIN"])),
):
    incident = db.execute(
        text(
            """
            SELECT
              i.id,
              i.reporter_user_id,
              a.assignee_user_id
            FROM incidents i
            LEFT JOIN incident_assignments a
              ON a.incident_id = i.id AND a.is_active = 1
            WHERE i.id = :iid
            LIMIT 1
            """
        ),
        {"iid": incident_id},
    ).mappings().first()
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    user_roles = set(user["roles"])
    if "ADMIN" not in user_roles:
        is_reporter = int(incident["reporter_user_id"]) == int(user["id"])
        is_assignee = incident["assignee_user_id"] is not None and int(incident["assignee_user_id"]) == int(user["id"])
        if not (is_reporter or is_assignee):
            raise HTTPException(status_code=403, detail="Not allowed to attach files to this incident")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")

    mime_type = file.content_type or "application/octet-stream"
    normalized_kind = (kind or "").strip().upper()
    if normalized_kind not in {"PHOTO", "VIDEO", "DOC", "SKETCH"}:
        if mime_type.lower().startswith("image/"):
            normalized_kind = "PHOTO"
        elif mime_type.lower().startswith("video/"):
            normalized_kind = "VIDEO"
        else:
            normalized_kind = "DOC"

    object_key = make_object_key(file.filename or "incident_attachment.bin")
    put_object_bytes(
        object_key=object_key,
        data=content,
        content_type=mime_type,
        bucket=settings.MINIO_BUCKET,
    )
    sha = hashlib.sha256(content).hexdigest()

    try:
        db.execute(
            text(
                """
                INSERT INTO attachments (
                  created_by_user_id, storage_provider, storage_bucket, storage_key,
                  file_name, mime_type, file_size_bytes, sha256, uploaded_at
                ) VALUES (
                  :uid, 'minio', :bucket, :key, :fname, :mime, :size, :sha, NOW()
                )
                """
            ),
            {
                "uid": user["id"],
                "bucket": settings.MINIO_BUCKET,
                "key": object_key,
                "fname": file.filename or "incident_attachment",
                "mime": mime_type,
                "size": len(content),
                "sha": sha,
            },
        )
        attachment_id = int(db.execute(text("SELECT LAST_INSERT_ID()")).scalar())
        next_sort = db.execute(
            text(
                """
                SELECT COALESCE(MAX(sort_order), -1) + 1
                FROM incident_attachments
                WHERE incident_id = :iid
                """
            ),
            {"iid": incident_id},
        ).scalar()
        db.execute(
            text(
                """
                INSERT INTO incident_attachments (incident_id, attachment_id, kind, sort_order)
                VALUES (:iid, :aid, :kind, :sort_order)
                """
            ),
            {
                "iid": incident_id,
                "aid": attachment_id,
                "kind": normalized_kind,
                "sort_order": int(next_sort or 0),
            },
        )
        db.commit()
        return {
            "incident_id": incident_id,
            "attachment_id": attachment_id,
            "kind": normalized_kind,
            "mime_type": mime_type,
        }
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))

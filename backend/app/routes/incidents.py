from __future__ import annotations

import decimal
import hashlib
import json
import re
from datetime import datetime

from fastapi import APIRouter, Depends, File, HTTPException, Path, Query, UploadFile
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import get_current_user, require_roles
from ..roles import (
    ADMIN,
    ALL_ROLE_NAMES,
    FIELD_REPORTING_ROLES,
    GUEST,
    BRANCH_CHIEF,
    STAFF,
    OFFICE_CHIEF,
    SENIOR_SPECIALIST,
    GISA_AUTHOR_ROLES,
    MAINTENANCE_COORDINATOR,
    MAINTENANCE_CREW,
    MAINTENANCE_REPORTING_ROLES,
    OPERATIONAL_ROLES,
    has_role,
    is_maintenance_only,
    is_public_only,
)
from ..services import org_directory
from ..services.incident_name import incident_name
from ..services import public_visibility
from ..precision import coordinates_differ, normalize_post_mile, normalize_route, round_coordinate
from ..schemas.common import (
    IncidentAssignBranchChiefRequest,
    IncidentAssignEngineerRequest,
    IncidentAssignRequest,
    IncidentCoordinatorForwardRequest,
    IncidentCreate,
    IncidentRequestRevision,
    IncidentResolveRequest,
    IncidentLocationLinkRequest,
    RoadInventoryIncidentContext,
)
from ..storage import make_object_key, object_access_url, put_object_bytes
from ..user_metadata import normalize_district_code, normalize_office_code, normalize_profile_text, parse_user_metadata

router = APIRouter(tags=["incidents"])
# OFFICE_BY_DISTRICT and _office_for_district were deleted with the org model.
# They were a second, admin-invisible copy of the district map that WON on the
# four paths that used them — incident creation, resubmission, coordinator
# forward and the office-chief branch options — so an admin moving district 05 to
# NORTH changed nothing on exactly those paths. The answer now comes from
# services/org_directory.office_for_district(db, district), which reads the
# admin-editable org_office_districts rows and keeps the legacy constant as its
# documented fallback (design §13.5).
# Who may read a field report's evidence. Built from the role sets rather than
# spelled out, so an account holding only a canonical name (OFFICE_CHIEF
# rather than the legacy OFFICE_CHIEF) is not silently locked out the way the
# hand-written lists elsewhere in this module lock it out. GUEST is in
# the list because the owner made the ENTIRE approved record public, photos
# included (org model decision 4); the handler narrows a viewer to approved
# records with public_visibility.ensure_public_incident, exactly as the incident
# detail endpoint does.
INCIDENT_EVIDENCE_READ_ROLES: list[str] = sorted(
    OPERATIONAL_ROLES | MAINTENANCE_REPORTING_ROLES | {GUEST}
)

REVISION_FIELDS_ALLOWED = {
    "district",
    "county",
    "route",
    "post_mile",
    "latitude",
    "longitude",
    "first_observed_at",
    "first_occurred_at",
    "description",
}


def _normalized_district_code(raw_district: str | None) -> str | None:
    return normalize_district_code(raw_district)


def _normalize_text(raw: str | None) -> str | None:
    return normalize_profile_text(raw)


def _location_display_name(
    district: str | None,
    county: str | None,
    route: str | None,
    post_mile: str | None,
) -> str | None:
    d = _normalize_text(district)
    c = _normalize_text(county)
    r = normalize_route(route)
    pm = normalize_post_mile(post_mile)
    parts = [p for p in [d, c, r, pm] if p]
    if not parts:
        return None
    if d and c and r and pm:
        return f"D{d} {c} R{r} PM {pm}"
    return " / ".join(parts)


def _queue_incident_notifications(
    *,
    db: Session,
    incident_id: int,
    recipient_user_ids: list[int],
    template_code: str,
    payload: dict | None = None,
    channels: tuple[str, ...] = ("IN_APP",),
) -> list[int]:
    """Write one outbox row per (recipient, channel) and return the new ids.

    Rows are written INSIDE the caller's transaction, so the intent to notify is
    atomic with the state change that caused it. Delivery is a separate, later
    concern: ``services/notifications.py`` flushes the EMAIL rows after commit
    and a sweeper retries whatever is left (design §6.2, §6.3).

    The returned ids are what an endpoint hands to ``BackgroundTasks``; IN_APP
    ids may be included freely because the flush filters on the EMAIL channel.
    """
    unique_ids = sorted({int(x) for x in recipient_user_ids if int(x) > 0})
    wanted_channels = tuple(dict.fromkeys(str(c).strip().upper() for c in channels if str(c).strip()))
    if not unique_ids or not wanted_channels:
        return []
    payload_json = json.dumps(payload or {})
    inserted: list[int] = []
    for uid in unique_ids:
        for channel in wanted_channels:
            result = db.execute(
                text(
                    """
                    INSERT INTO incident_notifications
                      (incident_id, recipient_user_id, channel, template_code, payload_json)
                    VALUES
                      (:iid, :uid, :channel, :template_code, :payload_json)
                    """
                ),
                {
                    "iid": incident_id,
                    "uid": uid,
                    "channel": channel,
                    "template_code": template_code,
                    "payload_json": payload_json,
                },
            )
            if result.lastrowid:
                inserted.append(int(result.lastrowid))
    # The same event, in each recipient's notification feed (web bell, mobile app).
    from ..services import notification_feed

    notification_feed.for_incident_event(db, incident_id=incident_id, user_ids=unique_ids, template_code=template_code, payload=payload)
    return inserted


def _create_or_select_location(
    *,
    db: Session,
    district: str | None,
    county: str | None,
    route: str | None,
    post_mile: str | None,
    latitude: float,
    longitude: float,
) -> int:
    normalized_district = _normalize_text(district)
    normalized_county = _normalize_text(county)
    normalized_route = normalize_route(route)
    normalized_post_mile = normalize_post_mile(post_mile)
    rounded_latitude = round_coordinate(latitude)
    rounded_longitude = round_coordinate(longitude)

    existing = db.execute(
        text(
            """
            SELECT id
            FROM incident_locations
            WHERE COALESCE(district, '') = COALESCE(:district, '')
              AND COALESCE(county, '') = COALESCE(:county, '')
              AND COALESCE(route, '') = COALESCE(:route, '')
              AND COALESCE(post_mile_norm, '') = COALESCE(:post_mile_norm, '')
            LIMIT 1
            """
        ),
        {
            "district": normalized_district,
            "county": normalized_county,
            "route": normalized_route,
            "post_mile_norm": normalized_post_mile,
        },
    ).scalars().first()
    if existing is not None:
        return int(existing)

    db.execute(
        text(
            """
            INSERT INTO incident_locations
              (display_name, district, county, route, post_mile_raw, post_mile_norm, latitude, longitude)
            VALUES
              (:display_name, :district, :county, :route, :post_mile_raw, :post_mile_norm, :latitude, :longitude)
            """
        ),
        {
            "display_name": _location_display_name(district, county, route, post_mile),
            "district": normalized_district,
            "county": normalized_county,
            "route": normalized_route,
            "post_mile_raw": _normalize_text(post_mile),
            "post_mile_norm": normalized_post_mile,
            "latitude": rounded_latitude,
            "longitude": rounded_longitude,
        },
    )
    return int(db.execute(text("SELECT LAST_INSERT_ID()")).scalar())


def _incident_location_candidates(
    *,
    db: Session,
    district: str | None,
    county: str | None,
    route: str | None,
    post_mile: str | None,
    latitude: float,
    longitude: float,
    limit: int = 8,
) -> list[dict]:
    normalized_district = (_normalize_text(district) or "").lower()
    normalized_county = (_normalize_text(county) or "").lower()
    normalized_route = (normalize_route(route) or "").lower()
    normalized_pm = (normalize_post_mile(post_mile) or "").lower()
    rounded_latitude = round_coordinate(latitude)
    rounded_longitude = round_coordinate(longitude)
    rows = db.execute(
        text(
            """
            SELECT
              il.id,
              il.display_name,
              il.district,
              il.county,
              il.route,
              il.post_mile_raw,
              il.post_mile_norm,
              il.latitude,
              il.longitude,
              il.created_at,
              il.updated_at,
              (
                (LOWER(COALESCE(il.district, '')) = :district) +
                (LOWER(COALESCE(il.county, '')) = :county) +
                (LOWER(COALESCE(il.route, '')) = :route) +
                (COALESCE(il.post_mile_norm, '') = :post_mile_norm)
              ) AS match_score,
              (POW(COALESCE(il.latitude, :lat) - :lat, 2) + POW(COALESCE(il.longitude, :lon) - :lon, 2)) AS coordinate_distance
            FROM incident_locations il
            WHERE
              il.is_active = 1
              AND (
                :district = ''
                OR LOWER(COALESCE(il.district, '')) = :district
                OR LOWER(COALESCE(il.county, '')) = :county
                OR LOWER(COALESCE(il.route, '')) = :route
              )
            ORDER BY
              match_score DESC,
              coordinate_distance ASC,
              il.updated_at DESC
            LIMIT :limit
            """
        ),
        {
            "district": normalized_district,
            "county": normalized_county,
            "route": normalized_route,
            "post_mile_norm": normalized_pm,
            "lat": rounded_latitude,
            "lon": rounded_longitude,
            "limit": limit,
        },
    ).mappings().all()

    return [
        {
            "id": int(r["id"]),
            "display_name": r["display_name"],
            "district": r["district"],
            "county": r["county"],
            "route": r["route"],
            "post_mile": r["post_mile_raw"],
            "post_mile_norm": r["post_mile_norm"],
            "latitude": float(r["latitude"]) if r["latitude"] is not None else None,
            "longitude": float(r["longitude"]) if r["longitude"] is not None else None,
            "created_at": r["created_at"],
            "updated_at": r["updated_at"],
            "match_score": int(r["match_score"] or 0),
            "coordinate_distance": float(r["coordinate_distance"] or 0.0),
        }
        for r in rows
    ]


def _location_timeline(
    *,
    db: Session,
    location_id: int,
    limit: int = 20,
    public_only: bool = False,
) -> dict:
    """Everything recorded at one site.

    ``public_only`` is the viewer's row set (org model design §4.5): this
    endpoint returns EVERY incident at a location, approved or not, so the
    viewer's version filters the rows rather than simply adding a role to the
    guard — otherwise the site history would leak the in-flight work the
    incident list itself hides.
    """
    incident_public_sql = ""
    submission_public_sql = ""
    if public_only:
        incident_public_sql = f" AND {public_visibility.public_incident_sql('inc')}"
        submission_public_sql = """
              AND EXISTS (
                SELECT 1 FROM assessments pa
                WHERE pa.state IN ('APPROVED','FINALIZED')
                  AND (
                    pa.submission_id = s.id
                    OR EXISTS (
                      SELECT 1 FROM assessment_submissions ps
                      WHERE ps.assessment_id = pa.id AND ps.submission_id = s.id
                    )
                  )
              )
        """
    location_row = db.execute(
        text(
            """
            SELECT
              id,
              display_name,
              district,
              county,
              route,
              post_mile_raw,
              post_mile_norm,
              latitude,
              longitude,
              created_at,
              updated_at
            FROM incident_locations
            WHERE id = :location_id
            LIMIT 1
            """
        ),
        {"location_id": int(location_id)},
    ).mappings().first()
    if not location_row:
        raise HTTPException(status_code=404, detail="Location not found")

    incident_rows = db.execute(
        text(
            f"""
            SELECT
              i.id,
              i.status,
              i.current_stage,
              i.description,
              i.first_observed_at,
              i.first_occurred_at,
              i.created_at,
              i.updated_at,
              i.linked_submission_id
            FROM (
              SELECT
                inc.id,
                inc.status,
                inc.current_stage,
                inc.description,
                inc.first_observed_at,
                inc.first_occurred_at,
                inc.created_at,
                inc.updated_at,
                isl.submission_id AS linked_submission_id
              FROM incidents inc
              LEFT JOIN incident_submission_links isl
                ON isl.incident_id = inc.id
              WHERE inc.location_id = :location_id{incident_public_sql}
              ORDER BY inc.first_observed_at DESC, inc.id DESC
              LIMIT :limit
            ) i
            ORDER BY i.first_observed_at DESC, i.id DESC
            """
        ),
        {"location_id": int(location_id), "limit": limit},
    ).mappings().all()

    submission_rows = db.execute(
        text(
            f"""
            SELECT
              s.id,
              s.status,
              s.title,
              s.created_at,
              s.updated_at,
              s.submitted_at,
              s.reviewed_at,
              g.date_incident_reported,
              g.report_date
            FROM submissions s
            JOIN submission_gisa g
              ON g.submission_id = s.id
            WHERE g.location_id = :location_id{submission_public_sql}
            ORDER BY s.created_at DESC, s.id DESC
            LIMIT :limit
            """
        ),
        {"location_id": int(location_id), "limit": limit},
    ).mappings().all()

    return {
        "location": {
            "id": int(location_row["id"]),
            "display_name": location_row["display_name"],
            "district": location_row["district"],
            "county": location_row["county"],
            "route": location_row["route"],
            "post_mile": location_row["post_mile_raw"],
            "post_mile_norm": location_row["post_mile_norm"],
            "latitude": float(location_row["latitude"]) if location_row["latitude"] is not None else None,
            "longitude": float(location_row["longitude"]) if location_row["longitude"] is not None else None,
            "created_at": location_row["created_at"],
            "updated_at": location_row["updated_at"],
        },
        "incident_count": len(incident_rows),
        "submission_count": len(submission_rows),
        "incidents": [
            {
                "id": int(r["id"]),
                "status": r["status"],
                "current_stage": r["current_stage"],
                "description": r["description"],
                "first_observed_at": r["first_observed_at"],
                "first_occurred_at": r["first_occurred_at"],
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
                "linked_submission_id": int(r["linked_submission_id"]) if r["linked_submission_id"] is not None else None,
            }
            for r in incident_rows
        ],
        "submissions": [
            {
                "id": int(r["id"]),
                "status": r["status"],
                "title": r["title"],
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
                "submitted_at": r["submitted_at"],
                "reviewed_at": r["reviewed_at"],
                "date_incident_reported": r["date_incident_reported"],
                "report_date": r["report_date"],
            }
            for r in submission_rows
        ],
    }


# Routing lookups match the canonical role name AND its legacy alias. Matching
# only the legacy name (the pre-v2 behaviour) made a user who holds just
# MAINTENANCE_COORDINATOR or OFFICE_CHIEF invisible to routing and to
# every notification it drives. SENIOR_ENGINEER has no legacy alias.
_ROUTING_ROLE_NAMES: dict[str, list[str]] = {
    "DISTRICT_COORDINATOR": [MAINTENANCE_COORDINATOR],
    "OFFICE_CHIEF": [OFFICE_CHIEF],
    "BRANCH_CHIEF": [BRANCH_CHIEF],
    "SENIOR_ENGINEER": [SENIOR_SPECIALIST],
}


def _routing_users_for(
    *,
    db: Session,
    assignment_type: str,
    district: str | None = None,
    office_code: str | None = None,
) -> list[int]:
    assignment_key = assignment_type.strip().upper()
    role_names = _ROUTING_ROLE_NAMES.get(assignment_key)
    if not role_names:
        return []

    params: dict[str, object] = {f"role_{idx}": name for idx, name in enumerate(role_names)}
    role_tokens = ", ".join(f":role_{idx}" for idx in range(len(role_names)))
    where_parts = ["u.is_active = 1", f"r.name IN ({role_tokens})"]
    if assignment_key == "DISTRICT_COORDINATOR":
        district_code = _normalized_district_code(district)
        if not district_code:
            return []
        params["district"] = district_code
        # Coverage rows FIRST, the org profile / metadata mirror second. The
        # table is what makes multi-district coverage expressible (design §5) and
        # the mirror half is what stops a coordinator created after the backfill
        # — by the legacy PATCH, which writes a district and no coverage row —
        # from silently dropping out of every notification list.
        where_parts.append(
            """(
              EXISTS (
                SELECT 1 FROM org_coordinator_coverage c
                 WHERE c.user_id = u.id AND c.district = :district AND c.is_active = 1
              )
              OR """
            + org_directory.USER_DISTRICT_SQL
            + " = :district)"
        )
    else:
        normalized_office = normalize_office_code(office_code)
        if not normalized_office:
            return []
        params["office_code"] = normalized_office
        office_sql = org_directory.USER_OFFICE_CODE_SQL
        if assignment_key in {"BRANCH_CHIEF", "SENIOR_ENGINEER"}:
            # Accounts created before office scoping have no office at all.
            # Excluding those otherwise-valid users leaves the office chief's
            # routing pickers empty and strands the assessment, so a named
            # branch chief or senior specialist with NO office is admitted as a
            # compatibility fallback (PR #125); one scoped to another office is
            # not. Their authority stays limited to the assessment that names them.
            where_parts.append(f"({office_sql} = :office_code OR {office_sql} = '')")
        else:
            # Office chiefs own every assessment in their office, so unlike a
            # named branch/senior assignee they must always be explicitly scoped.
            where_parts.append(f"{office_sql} = :office_code")

    rows = db.execute(
        text(
            f"""
            SELECT DISTINCT u.id
            FROM users u
            JOIN user_roles ur ON ur.user_id = u.id
            JOIN roles r ON r.id = ur.role_id
            {org_directory.USER_ORG_JOIN_SQL}
            WHERE {' AND '.join(where_parts)}
            ORDER BY u.id ASC
            """
        ),
        params,
    ).scalars().all()
    return [int(x) for x in rows]


# ---------------------------------------------------------------------------
# Picker annotations — inform, never choose (design §5)
# ---------------------------------------------------------------------------
#
# THE GOVERNING RULE for everything below: no picker response carries a default,
# a recommendation, a `selected` flag, or a sort key that reads as a ranking
# (owner decision 7). Groups are ordered by the office's own sort order and
# items by name; the two workload counts are RENDERED, never sorted on. An
# availability marking is returned like any other field — nobody is filtered out
# and nobody is moved, because filtering a rotated-out person out of a picker IS
# the picker choosing.

# Terminal states: work that is finished is not open work.
_PICKER_TERMINAL_STATES = "('APPROVED','FINALIZED')"

# The trailing group for people whose branch nobody has recorded. They are shown,
# not hidden: a picker that silently drops a chief is worse than one that admits
# a gap in the data.
PICKER_UNASSIGNED_GROUP_KEY = "UNASSIGNED"
PICKER_UNASSIGNED_GROUP_LABEL = "Branch not recorded"
PICKER_UNKNOWN_LOCATION_GROUP_KEY = "loc:UNKNOWN"
PICKER_UNKNOWN_LOCATION_GROUP_LABEL = "Location not recorded"


def _branch_group_key(branch_id: int | None) -> str:
    return f"b:{int(branch_id)}" if branch_id is not None else PICKER_UNASSIGNED_GROUP_KEY


def _location_group_key(home_city: str | None, home_district: str | None) -> str:
    city = (home_city or "").strip()
    district = (home_district or "").strip()
    if not city and not district:
        return PICKER_UNKNOWN_LOCATION_GROUP_KEY
    return f"loc:{city}:{district}"


def _location_group_label(home_city: str | None, home_district: str | None) -> str:
    city = (home_city or "").strip()
    district = (home_district or "").strip()
    if city and district:
        return f"{city}, D{district}"
    return city or (f"District {district}" if district else PICKER_UNKNOWN_LOCATION_GROUP_LABEL)


def _picker_workload_counts(db: Session, user_ids: list[int]) -> dict[int, dict[str, int]]:
    """Two counts per person, because one number cannot answer the question.

    ``open_assessment_count`` is every non-terminal assessment this person owns —
    as the branch chief it was handed to, or as its assignee. ``awaiting_action_count``
    is the SUBSET whose next action is theirs: a hand-off waiting to be assigned
    or a submission waiting for their review (chief), or a form waiting to be
    filled (assignee). The client renders "4 open · 2 waiting on them"; neither
    number is a sort key here or on the wire.

    ``COUNT(DISTINCT ...)`` rather than a sum: the same assessment can name one
    person as both chief and assignee, and it is still one piece of open work.
    """
    if not user_ids:
        return {}
    params = {f"pid_{idx}": int(user_id) for idx, user_id in enumerate(user_ids)}
    tokens = ", ".join(f":pid_{idx}" for idx in range(len(user_ids)))
    rows = db.execute(
        text(
            f"""
            SELECT
              w.owner_id,
              COUNT(DISTINCT w.assessment_id) AS open_assessment_count,
              COUNT(DISTINCT CASE WHEN w.awaiting = 1 THEN w.assessment_id END) AS awaiting_action_count
            FROM (
              SELECT
                a.branch_chief_user_id AS owner_id,
                a.id AS assessment_id,
                CASE WHEN a.state IN ('PENDING_ENGINEER_ASSIGNMENT', 'SUBMITTED') THEN 1 ELSE 0 END AS awaiting
              FROM assessments a
              WHERE a.state NOT IN {_PICKER_TERMINAL_STATES}
                AND a.branch_chief_user_id IN ({tokens})
              UNION ALL
              SELECT
                a.assigned_engineer_user_id AS owner_id,
                a.id AS assessment_id,
                CASE WHEN a.state IN ('DRAFT', 'REVISION_REQUESTED') THEN 1 ELSE 0 END AS awaiting
              FROM assessments a
              WHERE a.state NOT IN {_PICKER_TERMINAL_STATES}
                AND a.assigned_engineer_user_id IN ({tokens})
            ) w
            GROUP BY w.owner_id
            """
        ),
        params,
    ).mappings().all()
    return {
        int(r["owner_id"]): {
            "open_assessment_count": int(r["open_assessment_count"] or 0),
            "awaiting_action_count": int(r["awaiting_action_count"] or 0),
        }
        for r in rows
        if r["owner_id"] is not None
    }


def _picker_people(db: Session, user_ids: list[int], *, office_code: str | None = None) -> list[dict]:
    """The picker's item rows: identity, where they sit, and their two counts.

    ONE query for the org facts rather than ``resolve_user_org`` per person: a
    picker asks about everyone in an office at once. The office code and district
    resolve exactly as they do everywhere else — the profile row first, the
    ``metadata_json`` mirror second — through the shared SQL fragments in
    services/org_directory, so a picker and an authority check can never disagree.

    ``home_city`` / ``home_district`` are the PERSON's first, then their branch's,
    then their office's: a senior specialist sits away from the office home city
    more often than not, and their own recorded location is the true one.
    """
    if not user_ids:
        return []
    params = {f"user_id_{idx}": int(user_id) for idx, user_id in enumerate(user_ids)}
    params["option_office_code"] = normalize_office_code(office_code) or ""
    tokens = ", ".join(f":user_id_{idx}" for idx in range(len(user_ids)))
    rows = db.execute(
        text(
            f"""
            SELECT
              u.id, u.email, u.full_name, u.metadata_json,
              {org_directory.USER_OFFICE_CODE_SQL} AS resolved_office_code,
              {org_directory.USER_DISTRICT_SQL} AS resolved_district,
              oo.id AS office_id, oo.name AS office_name, oo.home_city AS office_home_city,
              oup.branch_id, oup.home_city AS profile_home_city,
              oup.availability, oup.available_from, oup.available_until,
              ob.letter AS branch_letter, ob.name AS branch_name,
              ob.home_city AS branch_home_city, ob.home_district AS branch_home_district,
              ob.is_active AS branch_is_active, ob.accepts_assignments AS branch_accepts_assignments,
              ob.sort_order AS branch_sort_order
            FROM users u
            {org_directory.USER_ORG_JOIN_SQL}
              LEFT JOIN org_branches ob ON ob.id = oup.branch_id
            WHERE u.id IN ({tokens})
            ORDER BY
              CASE WHEN {org_directory.USER_OFFICE_CODE_SQL} = :option_office_code THEN 0 ELSE 1 END,
              u.full_name ASC,
              u.id ASC
            """
        ),
        params,
    ).mappings().all()
    counts = _picker_workload_counts(db, [int(r["id"]) for r in rows])
    items: list[dict] = []
    for r in rows:
        uid = int(r["id"])
        branch_id = int(r["branch_id"]) if r["branch_id"] is not None else None
        home_city = _normalize_text(r["profile_home_city"]) or _normalize_text(r["branch_home_city"]) or _normalize_text(r["office_home_city"])
        home_district = _normalized_district_code(r["resolved_district"]) or _normalized_district_code(r["branch_home_district"])
        workload = counts.get(uid, {"open_assessment_count": 0, "awaiting_action_count": 0})
        items.append(
            {
                "id": uid,
                "email": r["email"],
                "full_name": r["full_name"],
                # The legacy three-key blob stays on the wire for one release:
                # clients that have not moved to the typed org fields still read
                # it (design §3.2).
                "metadata": parse_user_metadata(r.get("metadata_json")),
                "office_code": normalize_office_code(r["resolved_office_code"]),
                "office_name": _normalize_text(r["office_name"]),
                "branch_id": branch_id,
                "branch_letter": _normalize_text(r["branch_letter"]),
                "branch_name": _normalize_text(r["branch_name"]),
                "home_city": home_city,
                "home_district": home_district,
                "open_assessment_count": workload["open_assessment_count"],
                "awaiting_action_count": workload["awaiting_action_count"],
                # Rendered beside the name ("Rotation out — back 2/5/27"), never
                # used to hide or reorder anybody (design §5, open question 9).
                "availability": _normalize_text(r["availability"]) or "AVAILABLE",
                "available_from": r["available_from"],
                "available_until": r["available_until"],
                # Present so a client can render a person whose branch has since
                # been retired without a second lookup.
                "branch_is_active": bool(r["branch_is_active"]) if r["branch_is_active"] is not None else None,
                "_branch_accepts_assignments": (
                    bool(r["branch_accepts_assignments"]) if r["branch_accepts_assignments"] is not None else None
                ),
                "_branch_sort_order": int(r["branch_sort_order"]) if r["branch_sort_order"] is not None else None,
            }
        )
    return items


def _branch_groups_for_office(db: Session, office_code: str | None) -> list[dict]:
    """Every ACTIVE branch of an office, as picker groups, in the office's order.

    Ordered by ``sort_order`` then letter — NEVER by load, which would turn the
    group headings into a recommendation. A branch with ``accepts_assignments = 0``
    is RETURNED with the flag set, so the client can render it disabled with the
    reason instead of silently omitting a branch that exists on the chart.
    """
    code = normalize_office_code(office_code)
    if not code:
        return []
    rows = db.execute(
        text(
            """
            SELECT b.id, b.letter, b.name, b.home_city, b.home_district,
                   b.accepts_assignments, b.is_active, b.sort_order
              FROM org_branches b
              JOIN org_offices o ON o.id = b.office_id AND o.org_type = 'GEOTECH'
             WHERE o.code = :code
               AND b.unit_type = 'BRANCH'
               AND b.is_active = 1
             ORDER BY b.sort_order ASC, b.letter ASC, b.name ASC, b.id ASC
            """
        ),
        {"code": code},
    ).mappings().all()
    branch_ids = [int(r["id"]) for r in rows]
    coverage = _branch_district_coverage(db, branch_ids)
    return [
        {
            "group_key": _branch_group_key(int(r["id"])),
            "label": _normalize_text(r["name"]) or f"Branch {r['letter']}",
            "branch_id": int(r["id"]),
            "branch_letter": _normalize_text(r["letter"]),
            "branch_name": _normalize_text(r["name"]),
            "home_city": _normalize_text(r["home_city"]),
            "home_district": _normalized_district_code(r["home_district"]),
            "districts_covered": coverage.get(int(r["id"]), []),
            "accepts_assignments": bool(r["accepts_assignments"]),
            "is_active": bool(r["is_active"]),
        }
        for r in rows
    ]


def _branch_district_coverage(db: Session, branch_ids: list[int]) -> dict[int, list[str]]:
    """Districts each branch covers. Empty until an admin enters them.

    No chart states branch-to-district coverage for any office, so the table is
    seeded empty and every row a deployment has was entered by a person and
    carries its ``source`` (design §10, open question 1).
    """
    if not branch_ids:
        return {}
    params = {f"bid_{idx}": int(bid) for idx, bid in enumerate(branch_ids)}
    tokens = ", ".join(f":bid_{idx}" for idx in range(len(branch_ids)))
    rows = db.execute(
        text(
            f"""
            SELECT branch_id, district
              FROM org_branch_districts
             WHERE branch_id IN ({tokens}) AND is_active = 1
             ORDER BY district ASC
            """
        ),
        params,
    ).mappings().all()
    out: dict[int, list[str]] = {}
    for r in rows:
        out.setdefault(int(r["branch_id"]), []).append(str(r["district"]).strip())
    return out


def _picker_payload_by_branch(db: Session, items: list[dict], office_code: str | None) -> tuple[list[dict], list[dict]]:
    """Group picker items by branch; return ``(groups, items)``.

    Groups come from the office's branch ROWS, not from the people present, so a
    staffed branch and an empty one both appear. A branch referenced by a person
    but missing from that list (deactivated after they were placed in it) is
    appended rather than dropped — an item must never point at a group the client
    was not given.
    """
    groups = _branch_groups_for_office(db, office_code)
    known = {group["group_key"] for group in groups}
    extra: list[dict] = []
    needs_unassigned = False
    for item in items:
        group_key = _branch_group_key(item.get("branch_id"))
        item["group_key"] = group_key
        if group_key == PICKER_UNASSIGNED_GROUP_KEY:
            needs_unassigned = True
        elif group_key not in known and not any(g["group_key"] == group_key for g in extra):
            extra.append(
                {
                    "group_key": group_key,
                    "label": item.get("branch_name") or f"Branch {item.get('branch_letter') or ''}".strip(),
                    "branch_id": item.get("branch_id"),
                    "branch_letter": item.get("branch_letter"),
                    "branch_name": item.get("branch_name"),
                    "home_city": item.get("home_city"),
                    "home_district": item.get("home_district"),
                    "districts_covered": [],
                    "accepts_assignments": bool(item.get("_branch_accepts_assignments", True)),
                    "is_active": bool(item.get("branch_is_active")),
                }
            )
    groups = groups + extra
    if needs_unassigned:
        groups = groups + [
            {
                "group_key": PICKER_UNASSIGNED_GROUP_KEY,
                "label": PICKER_UNASSIGNED_GROUP_LABEL,
                "branch_id": None,
                "branch_letter": None,
                "branch_name": PICKER_UNASSIGNED_GROUP_LABEL,
                "home_city": None,
                "home_district": None,
                "districts_covered": [],
                "accepts_assignments": True,
                "is_active": True,
            }
        ]
    return groups, _ordered_picker_items(groups, items)


def _picker_payload_by_location(items: list[dict]) -> tuple[list[dict], list[dict]]:
    """Group picker items by home city and district; return ``(groups, items)``.

    The senior specialist's grouping: a ``(Spec)`` position has no branch and
    sits away from the office home city more often than not, so the branch
    heading would be empty for every one of them (design §5).
    """
    groups: list[dict] = []
    seen: set[str] = set()
    for item in sorted(items, key=lambda i: ((i.get("home_city") or "~"), (i.get("home_district") or ""), i["full_name"] or "")):
        group_key = _location_group_key(item.get("home_city"), item.get("home_district"))
        if group_key in seen:
            continue
        seen.add(group_key)
        groups.append(
            {
                "group_key": group_key,
                "label": _location_group_label(item.get("home_city"), item.get("home_district")),
                "branch_id": None,
                "branch_letter": None,
                "branch_name": None,
                "home_city": item.get("home_city"),
                "home_district": item.get("home_district"),
                "districts_covered": [],
                "accepts_assignments": True,
                "is_active": True,
            }
        )
    for item in items:
        item["group_key"] = _location_group_key(item.get("home_city"), item.get("home_district"))
    return groups, _ordered_picker_items(groups, items)


def _ordered_picker_items(groups: list[dict], items: list[dict]) -> list[dict]:
    """Items in group order, then by name inside a group. Never by load.

    The private ``_``-prefixed keys collected for grouping are stripped here, so
    the response carries only the documented contract.
    """
    order = {group["group_key"]: index for index, group in enumerate(groups)}
    ordered = sorted(
        items,
        key=lambda i: (order.get(i.get("group_key"), len(order)), (i.get("full_name") or "").lower(), i["id"]),
    )
    return [{k: v for k, v in item.items() if not k.startswith("_")} for item in ordered]


def _routing_user_options_for(
    *,
    db: Session,
    assignment_type: str,
    district: str | None = None,
    office_code: str | None = None,
) -> list[dict]:
    """The eligible people for one routing role, annotated for a picker.

    The item shape is a SUPERSET of the pre-org-model one — ``id``, ``email``,
    ``full_name`` and the legacy ``metadata`` blob are all still there — so a
    client that has not adopted the typed org fields keeps working.
    """
    user_ids = _routing_users_for(db=db, assignment_type=assignment_type, district=district, office_code=office_code)
    return _picker_people(db, user_ids, office_code=office_code)


# The caller's district and office come from services/org_directory, which reads
# org_user_profiles first and users.metadata_json (the mirror) second. ``db`` is
# keyword-only and optional so no existing call site breaks: without it the
# helper uses the org record already resolved on this request's user dict, and
# the mirror when there is none. Every call site inside the assessment and
# incident flows passes it.
def _caller_district(user: dict, db: Session | None) -> str | None:
    if db is not None:
        return org_directory.user_home_district(db, user)
    cached = user.get("org")
    if isinstance(cached, dict):
        return _normalized_district_code(cached.get("home_district"))
    return _normalized_district_code((user.get("metadata") or {}).get("district"))


def _caller_office_code(user: dict, db: Session | None) -> str | None:
    if db is not None:
        return org_directory.user_office_code(db, user)
    cached = user.get("org")
    if isinstance(cached, dict):
        return normalize_office_code(cached.get("office_code"))
    return normalize_office_code((user.get("metadata") or {}).get("office_code"))


def _caller_districts(user: dict, db: Session | None) -> set[str]:
    """Every district this person covers: the districts whose coordinator list
    they are on (Organization > Maintenance), and their home district. One rule
    for the triage queue, the mobile list and the access check, so a report a
    coordinator is shown is always one they may open."""
    districts: set[str] = set()
    home = _caller_district(user, db)
    if home:
        districts.add(home)
    if db is not None and user.get("id") is not None:
        covered = db.execute(
            text("SELECT district FROM org_coordinator_coverage WHERE user_id = :uid AND is_active = 1"),
            {"uid": int(user["id"])},
        ).scalars().all()
        districts |= {d for d in (_normalized_district_code(value) for value in covered) if d}
    return districts


def _district_filter(column: str, districts: set[str], params: dict, prefix: str) -> str:
    """SQL matching any of `districts` in the stored forms ('04', '4', 'District 04')."""
    parts = []
    for index, district in enumerate(sorted(districts)):
        key = f"{prefix}{index}"
        params[key] = district
        params[f"{key}p"] = district.lstrip("0") or district
        parts.append(
            f"{column} = :{key} OR {column} = :{key}p OR "
            f"{column} = CONCAT('District ', :{key}) OR {column} = CONCAT('District ', :{key}p)"
        )
    return "(" + " OR ".join(parts) + ")" if parts else "1=0"


def _ensure_incident_district_access(user: dict, district: str | None, *, db: Session | None = None) -> None:
    if "ADMIN" in set(user.get("roles") or []):
        return
    incident_district = _normalized_district_code(district)
    if not incident_district or incident_district not in _caller_districts(user, db):
        raise HTTPException(status_code=403, detail="Incident is outside your assigned district")


def _ensure_incident_office_access(user: dict, office_code: str | None, *, db: Session | None = None) -> None:
    if "ADMIN" in set(user.get("roles") or []):
        return
    user_office = _caller_office_code(user, db)
    incident_office = normalize_office_code(office_code)
    if not user_office or user_office != incident_office:
        raise HTTPException(status_code=403, detail="Incident is outside your assigned office")


def _ensure_incident_scope_access(user: dict, incident_row: dict, *, db: Session | None = None) -> None:
    """Narrow incident detail to the caller's district or office.

    The role tests are CANONICAL (``has_role``), not the raw legacy
    strings they used to be. An account holding only ``MAINTENANCE_COORDINATOR``,
    ``OFFICE_CHIEF`` or ``BRANCH_CHIEF`` — which is what the org
    model and every new deployment issue — matched none of the old strings and
    therefore got NO narrowing at all: the reverse of the intended bug, an
    unscoped read rather than a refusal (design §5, B20).
    """
    if "ADMIN" in set(user.get("roles") or []):
        return
    # Maintenance Crew members may only read their own reports.
    if is_maintenance_only(user):
        if int(incident_row.get("reporter_user_id") or 0) != int(user["id"]):
            raise HTTPException(status_code=403, detail="You can only view your own incident reports")
        return
    if has_role(user, MAINTENANCE_COORDINATOR):
        _ensure_incident_district_access(user, incident_row.get("district"), db=db)
    if has_role(user, OFFICE_CHIEF) or has_role(user, BRANCH_CHIEF):
        office_code = incident_row.get("office_code")
        if not office_code and db is not None:
            office_code = org_directory.office_for_district(db, incident_row.get("district"))
        _ensure_incident_office_access(user, office_code, db=db)


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



def _json_safe(val: object) -> object:
    if isinstance(val, (int, float, str, bool, type(None))):
        return val
    if isinstance(val, decimal.Decimal):
        return float(val)
    return str(val)


def _validate_road_inventory_context(
    db: Session,
    context: RoadInventoryIncidentContext | None,
) -> dict | None:
    if context is None:
        return None

    dataset_id = int(context.dataset_version_id)
    segment_id = int(context.segment_id)

    if not db.execute(
        text("SELECT 1 FROM road_inventory_datasets WHERE id = :id LIMIT 1"),
        {"id": dataset_id},
    ).scalar():
        raise HTTPException(
            status_code=400,
            detail=f"Road inventory dataset {dataset_id} not found",
        )

    seg = db.execute(
        text(
            """
            SELECT id, dataset_version_id,
                   district_code, county_code, route_name, route_suffix_code,
                   pm_prefix_code, begin_pm, end_pm, length_miles,
                   left_lanes, right_lanes, left_surface_type, right_surface_type,
                   median_type, median_width, terrain_code, design_speed,
                   adt, landmark_short_desc
            FROM road_segments WHERE id = :id LIMIT 1
            """
        ),
        {"id": segment_id},
    ).mappings().first()
    if not seg:
        raise HTTPException(
            status_code=400,
            detail=f"Road segment {segment_id} not found",
        )
    if int(seg["dataset_version_id"]) != dataset_id:
        raise HTTPException(
            status_code=400,
            detail=f"Segment {segment_id} belongs to dataset {int(seg['dataset_version_id'])}, not {dataset_id}",
        )

    if context.snapshot is not None:
        snapshot = context.snapshot
    else:
        skip = {"id", "dataset_version_id"}
        snapshot = {
            k: _json_safe(v)
            for k, v in dict(seg).items()
            if k not in skip and v is not None
        }

    method = ((context.match_method or "") or "MOBILE_OFFLINE").strip().upper()[:32]
    return {
        "ri_dataset_version_id": dataset_id,
        "ri_segment_id": segment_id,
        "ri_snapshot_json": json.dumps(snapshot),
        "ri_match_method": method,
    }


def _incident_with_assignment(db: Session, incident_id: int):
    row = db.execute(
        text(
            """
            SELECT
              i.id, i.title, i.incident_type, i.description,
              i.location_id, i.location_match_status, i.location_reviewed_by_user_id, i.location_match_metadata, i.location_reviewed_at,
              i.first_observed_at, i.first_occurred_at,
              i.latitude, i.longitude, i.district, i.county, i.route, i.post_mile,
              i.road_inventory_dataset_version_id, i.road_inventory_segment_id,
              i.road_inventory_snapshot_json, i.road_inventory_match_method, i.road_inventory_checked_at,
              i.office_code, i.current_stage, i.event_group_id, i.incident_key,
              i.status, i.reporter_user_id, i.created_at, i.updated_at,
              i.resolved_at, i.resolved_by_user_id, i.resolution_comment,
              i.triage_disposition, i.triage_decided_by_user_id, i.triage_decided_at,
              i.triage_notes, i.duplicate_of_incident_id, i.duplicate_of_location_id,
              a.id AS assignment_id, a.assignee_user_id, a.assigned_by_user_id,
              a.assignment_mode, a.assignment_stage, a.created_at AS assigned_at,
              u.email AS assignee_email, u.full_name AS assignee_name,
              ru.full_name AS reporter_name, ru.email AS reporter_email,
              tu.full_name AS triage_decided_by_name,
              rsu.full_name AS resolved_by_name,
              isl.submission_id
            FROM incidents i
            LEFT JOIN incident_assignments a
              ON a.incident_id = i.id AND a.assignment_stage = 'ENGINEER' AND a.is_active = 1
            LEFT JOIN users u
              ON u.id = a.assignee_user_id
            -- The reporter by name. Coordinator triage has to say who filed a
            -- report before it can be judged, and "User #7" is not an answer
            -- (redesign plan B5).
            LEFT JOIN users ru
              ON ru.id = i.reporter_user_id
            LEFT JOIN users tu
              ON tu.id = i.triage_decided_by_user_id
            LEFT JOIN users rsu
              ON rsu.id = i.resolved_by_user_id
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
    """The mobile feed's per-role row filters.

    Every branch tests CANONICAL role names now. Four of them — coordinator,
    office chief, branch chief and maintenance reporter — used to test the legacy
    strings only, so an account holding just ``MAINTENANCE_COORDINATOR`` matched
    nothing, fell through to ``['1=0']`` below and saw an EMPTY feed. That is a
    regression blocker the moment org accounts are seeded canonically, and it is
    fixed here rather than on the client (design §9.3, B20).

    District and office come from ``org_directory`` (profile first, metadata
    mirror second) instead of straight off ``metadata_json``.
    """
    roles = set(user.get("roles") or [])
    uid = int(user["id"])
    if "ADMIN" in roles:
        return [], {}

    role_filters: list[str] = []
    params: dict[str, object] = {"mobile_uid": uid}
    org = org_directory.resolve_user_org(db, user)

    if has_role(user, MAINTENANCE_COORDINATOR):
        districts = _caller_districts(user, db)
        if districts:
            role_filters.append(
                "(i.current_stage = 'COORDINATOR_REVIEW' AND "
                + _district_filter("i.district", districts, params, "coord_district_")
                + ")"
            )

    if has_role(user, OFFICE_CHIEF):
        office_code = normalize_office_code(org.get("office_code"))
        if office_code:
            params["office_chief_office"] = office_code
            role_filters.append(
                "(i.office_code = :office_chief_office AND i.location_id IS NOT NULL AND i.current_stage IN ('OFFICE_CHIEF_REVIEW','BRANCH_CHIEF_REVIEW','ENGINEER_ASSIGNED','RESOLVED'))"
            )

    if has_role(user, BRANCH_CHIEF):
        office_code = normalize_office_code(org.get("office_code"))
        if office_code:
            params["branch_chief_office"] = office_code
            role_filters.append(
                "(i.office_code = :branch_chief_office AND i.location_id IS NOT NULL AND i.current_stage IN ('BRANCH_CHIEF_REVIEW','ENGINEER_ASSIGNED','RESOLVED'))"
            )

    # The Senior Specialist holds the SAME active ENGINEER-stage assignment row as
    # a Staff member does (the Senior Specialist route reuses stage ENGINEER), so
    # the EXISTS below is correct for them unchanged — only the role guard in
    # front of it has to widen, or a senior-engineer-only account sees no
    # incidents at all.
    if has_role(user, STAFF) or has_role(user, SENIOR_SPECIALIST):
        role_filters.append(
            "EXISTS (SELECT 1 FROM incident_assignments ia WHERE ia.incident_id = i.id AND ia.assignment_stage = 'ENGINEER' AND ia.is_active = 1 AND ia.assignee_user_id = :mobile_uid)"
        )

    if has_role(user, MAINTENANCE_CREW):
        role_filters.append("i.reporter_user_id = :mobile_uid")

    if not role_filters:
        return ["1=0"], params
    return [f"({' OR '.join(role_filters)})"], params


def _serialize_incident(row: dict) -> dict:
    ri_snapshot = row.get("road_inventory_snapshot_json")
    if isinstance(ri_snapshot, str):
        try:
            ri_snapshot = json.loads(ri_snapshot)
        except Exception:
            ri_snapshot = None
    ri_context: dict | None = None
    if row.get("road_inventory_dataset_version_id") is not None:
        ri_context = {
            "dataset_version_id": int(row["road_inventory_dataset_version_id"]),
            "segment_id": int(row["road_inventory_segment_id"]) if row.get("road_inventory_segment_id") is not None else None,
            "match_method": row.get("road_inventory_match_method"),
            "checked_at": row.get("road_inventory_checked_at"),
            "snapshot": ri_snapshot,
        }
    # location_match_metadata is a JSON column; the driver may hand it back as a
    # raw string. Parse it to an object so clients (and the reporter-revision
    # flow) can read fields like `revision_fields` directly.
    location_metadata = row.get("location_match_metadata")
    if isinstance(location_metadata, str):
        try:
            location_metadata = json.loads(location_metadata)
        except Exception:
            location_metadata = None
    return {
        "id": int(row["id"]),
        "title": row["title"],
        "incident_type": row["incident_type"],
        "description": row["description"],
        "location_id": int(row["location_id"]) if row["location_id"] is not None else None,
        "location_match_status": row["location_match_status"],
        "location_reviewed_by_user_id": int(row["location_reviewed_by_user_id"]) if row["location_reviewed_by_user_id"] is not None else None,
        "location_match_metadata": location_metadata,
        "location_reviewed_at": row["location_reviewed_at"],
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
        "event_group_id": int(row["event_group_id"]) if row.get("event_group_id") is not None else None,
        "incident_key": row.get("incident_key"),
        "status": row["status"],
        "reporter_user_id": int(row["reporter_user_id"]),
        "reporter_name": row.get("reporter_name"),
        "reporter_email": row.get("reporter_email"),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "resolved_at": row["resolved_at"],
        "resolved_by_user_id": row["resolved_by_user_id"],
        "resolved_by_name": row.get("resolved_by_name"),
        "resolution_comment": row["resolution_comment"],
        "triage_decided_by_name": row.get("triage_decided_by_name"),
        "triage_disposition": row.get("triage_disposition"),
        "triage_decided_by_user_id": int(row["triage_decided_by_user_id"]) if row.get("triage_decided_by_user_id") is not None else None,
        "triage_decided_at": row.get("triage_decided_at"),
        "triage_notes": row.get("triage_notes"),
        "duplicate_of_incident_id": int(row["duplicate_of_incident_id"]) if row.get("duplicate_of_incident_id") is not None else None,
        "duplicate_of_location_id": int(row["duplicate_of_location_id"]) if row.get("duplicate_of_location_id") is not None else None,
        "linked_submission_id": int(row["submission_id"]) if row["submission_id"] is not None else None,
        "road_inventory_context": ri_context,
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

    ri_dvid = incident_row.get("road_inventory_dataset_version_id")

    if existing is not None:
        db.execute(
            text(
                """
                INSERT INTO submission_gisa (submission_id, location_id, updated_by_user_id)
                VALUES (:sid, :location_id, :updated_by)
                ON DUPLICATE KEY UPDATE
                  location_id = VALUES(location_id),
                  updated_by_user_id = VALUES(updated_by_user_id)
                """
            ),
            {
                "sid": int(existing),
                "location_id": incident_row["location_id"],
                "updated_by": actor_user_id,
            },
        )
        # Copy RI context into the existing GISA draft only when it has none yet.
        if ri_dvid is not None:
            db.execute(
                text(
                    """
                    UPDATE submission_gisa
                    SET
                      road_inventory_dataset_version_id = :ri_dvid,
                      road_inventory_segment_id         = :ri_sid,
                      road_inventory_snapshot_json      = :ri_snapshot_json,
                      road_inventory_match_method       = :ri_method,
                      road_inventory_checked_at         = :ri_at
                    WHERE submission_id = :sid
                      AND road_inventory_dataset_version_id IS NULL
                    """
                ),
                {
                    "sid": int(existing),
                    "ri_dvid": ri_dvid,
                    "ri_sid": incident_row.get("road_inventory_segment_id"),
                    "ri_snapshot_json": incident_row.get("road_inventory_snapshot_json"),
                    "ri_method": incident_row.get("road_inventory_match_method"),
                    "ri_at": incident_row.get("road_inventory_checked_at"),
                },
            )
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

    return _create_linked_submission(
        db=db,
        incident_row=incident_row,
        assignee_user_id=assignee_user_id,
        actor_user_id=actor_user_id,
    )



def _create_linked_submission(
    *,
    db: Session,
    incident_row: dict,
    assignee_user_id: int,
    actor_user_id: int,
    link_incident: bool = True,
) -> int:
    """Create a DRAFT technical submission pre-filled from an incident.

    ``link_incident`` records the incident's primary ``incident_submission_links``
    row (one per incident). Supplemental submissions created for an assessment
    pass ``link_incident=False`` and are linked through ``assessment_submissions``
    instead, so an assessment can carry several technical forms.
    """
    ri_dvid = incident_row.get("road_inventory_dataset_version_id")
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

    ri_cols = ""
    ri_vals = ""
    ri_params: dict = {}
    if ri_dvid is not None:
        ri_cols = """,
              road_inventory_dataset_version_id,
              road_inventory_segment_id,
              road_inventory_snapshot_json,
              road_inventory_match_method,
              road_inventory_checked_at"""
        ri_vals = """,
              :ri_dvid, :ri_sid, :ri_snapshot_json, :ri_method, :ri_at"""
        ri_params = {
            "ri_dvid": ri_dvid,
            "ri_sid": incident_row.get("road_inventory_segment_id"),
            "ri_snapshot_json": incident_row.get("road_inventory_snapshot_json"),
            "ri_method": incident_row.get("road_inventory_match_method"),
            "ri_at": incident_row.get("road_inventory_checked_at"),
        }

    db.execute(
        text(
            f"""
            INSERT INTO submission_gisa (
              submission_id,
              location_id,
              report_date,
              date_incident_reported,
              district,
              county,
              route,
              post_mile,
              latitude,
              longitude,
              updated_by_user_id{ri_cols}
            ) VALUES (
              :sid,
              :location_id,
              :date_incident_reported,
              CURDATE(),
              :district,
              :county,
              :route,
              :post_mile,
              :lat,
              :lon,
              :updated_by{ri_vals}
            )
            """
        ),
        {
            "sid": submission_id,
            "location_id": incident_row["location_id"],
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
            **ri_params,
        },
    )

    if link_incident:
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
    user=Depends(require_roles(FIELD_REPORTING_ROLES)),
):
    district = _normalize_text(payload.district)
    county = _normalize_text(payload.county)
    route = normalize_route(payload.route)
    post_mile = normalize_post_mile(payload.post_mile)
    # Named by where and when, not by a typed title (any title sent is ignored).
    title = incident_name(district=district, county=county, route=route, post_mile=post_mile, observed_at=payload.first_observed_at)
    latitude = round_coordinate(payload.latitude)
    longitude = round_coordinate(payload.longitude)
    if not (district and county and route and post_mile):
        raise HTTPException(
            status_code=400,
            detail="district, county, route, and post_mile are required location fields",
        )
    if latitude is None or longitude is None:
        raise HTTPException(status_code=400, detail="latitude and longitude are required")

    district_code = _normalized_district_code(district)
    # The admin-editable org_office_districts rows, with the legacy constant as
    # the documented fallback for a district nobody has configured yet.
    office_code = org_directory.office_for_district(db, district)
    ri = _validate_road_inventory_context(db, payload.road_inventory_context)
    try:
        db.execute(
            text(
                """
                INSERT INTO incidents (
                  title, incident_type, description, location_id, location_match_status,
                  latitude, longitude,
                  first_observed_at, first_occurred_at,
                  district, county, route, post_mile, office_code, current_stage,
                  status, reporter_user_id,
                  road_inventory_dataset_version_id, road_inventory_segment_id,
                  road_inventory_snapshot_json, road_inventory_match_method, road_inventory_checked_at
                ) VALUES (
                :title, :incident_type, :description, NULL, 'PENDING_REVIEW', :lat, :lon,
                  :first_observed_at, :first_occurred_at,
                  :district, :county, :route, :post_mile, :office_code, 'COORDINATOR_REVIEW',
                  'NEW', :uid,
                  :ri_dataset_version_id, :ri_segment_id,
                  :ri_snapshot_json, :ri_match_method, :ri_checked_at
                )
                """
            ),
            {
                "title": title,
                "incident_type": (payload.incident_type or "").strip() or None,
                "description": (payload.description or "").strip() or None,
                "lat": latitude,
                "lon": longitude,
                "first_observed_at": payload.first_observed_at,
                "first_occurred_at": payload.first_occurred_at,
                "district": district,
                "county": county,
                "route": route,
                "post_mile": post_mile,
                "office_code": office_code,
                "uid": user["id"],
                "ri_dataset_version_id": ri["ri_dataset_version_id"] if ri else None,
                "ri_segment_id": ri["ri_segment_id"] if ri else None,
                "ri_snapshot_json": ri["ri_snapshot_json"] if ri else None,
                "ri_match_method": ri["ri_match_method"] if ri else None,
                "ri_checked_at": datetime.utcnow() if ri else None,
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


@router.get("/incidents/{incident_id}/location-candidates")
def list_incident_location_candidates(
    incident_id: int = Path(..., ge=1),
    limit: int = Query(default=8, ge=1, le=20),
    db: Session = Depends(get_db),
    user=Depends(require_roles([MAINTENANCE_COORDINATOR, ADMIN])),
):
    incident = _incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    _ensure_incident_district_access(user, incident.get("district"), db=db)
    if incident["latitude"] is None or incident["longitude"] is None:
        raise HTTPException(status_code=409, detail="Incident coordinates are required for location matching")
    candidates = _incident_location_candidates(
        db=db,
        district=incident["district"],
        county=incident["county"],
        route=incident["route"],
        post_mile=incident["post_mile"],
        latitude=float(incident["latitude"]),
        longitude=float(incident["longitude"]),
        limit=limit,
    )
    return {
        "incident_id": int(incident["id"]),
        "location_id": int(incident["location_id"]) if incident["location_id"] is not None else None,
        "location_match_status": incident["location_match_status"],
        "items": candidates,
    }


@router.get("/incident-locations/{location_id}/timeline")
def get_incident_location_timeline(
    location_id: int = Path(..., ge=1),
    limit: int = Query(default=20, ge=1, le=50),
    db: Session = Depends(get_db),
    # The viewer is added to the guard AND the row set is narrowed below: this
    # endpoint returns every incident at a site regardless of state, so the role
    # alone would hand a viewer exactly the in-flight work the rest of §4.5
    # hides (design §4.5).
    user=Depends(require_roles([MAINTENANCE_COORDINATOR, OFFICE_CHIEF, BRANCH_CHIEF, GUEST, ADMIN])),
):
    return _location_timeline(
        db=db,
        location_id=location_id,
        limit=limit,
        public_only=is_public_only(user),
    )


@router.post("/incidents/{incident_id}/location-link")
def link_incident_location(
    payload: IncidentLocationLinkRequest,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles([MAINTENANCE_COORDINATOR, ADMIN])),
):
    incident = _incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    _ensure_incident_district_access(user, incident.get("district"), db=db)
    if str(incident["status"]).upper() == "RESOLVED":
        raise HTTPException(status_code=409, detail="Resolved incidents cannot be relinked")

    mode = (payload.mode or "").strip().upper()
    if mode == "EXISTING":
        if not payload.location_id:
            raise HTTPException(status_code=400, detail="location_id is required for EXISTING mode")
        chosen_location_id = int(payload.location_id)
        exists = db.execute(
            text(
                """
                SELECT id
                FROM incident_locations
                WHERE id = :location_id
                LIMIT 1
                """
            ),
            {"location_id": chosen_location_id},
        ).scalar()
        if not exists:
            raise HTTPException(status_code=404, detail="Location was not found")
        new_status = "LINKED_EXISTING"
    elif mode == "CREATE_NEW":
        chosen_location_id = _create_or_select_location(
            db=db,
            district=incident["district"],
            county=incident["county"],
            route=incident["route"],
            post_mile=incident["post_mile"],
            latitude=float(incident["latitude"]),
            longitude=float(incident["longitude"]),
        )
        new_status = "NEW_LOCATION_CREATED"
    else:
        raise HTTPException(status_code=400, detail="Invalid mode. Use EXISTING or CREATE_NEW.")

    metadata = {
        "mode": mode,
        "comment": (payload.comment or "").strip() or None,
        "performed_by_user_id": int(user["id"]),
    }
    try:
        db.execute(
            text(
                """
                UPDATE incidents
                SET location_id = :location_id,
                    location_match_status = :status,
                    location_reviewed_by_user_id = :reviewer,
                    location_reviewed_at = NOW(),
                    location_match_metadata = :metadata,
                    updated_at = NOW()
                WHERE id = :iid
                """
            ),
            {
                "iid": incident_id,
                "location_id": chosen_location_id,
                "status": new_status,
                "reviewer": int(user["id"]),
                "metadata": json.dumps(metadata),
            },
        )
        db.commit()
        return {
            "incident_id": int(incident_id),
            "location_id": chosen_location_id,
            "location_match_status": new_status,
        }
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/incidents/{incident_id}/coordinator/request-revision")
def coordinator_request_revision(
    payload: IncidentRequestRevision,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles([MAINTENANCE_COORDINATOR, ADMIN])),
):
    incident = _incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    _ensure_incident_district_access(user, incident.get("district"), db=db)
    if str(incident["status"]).upper() == "RESOLVED":
        raise HTTPException(status_code=409, detail="Resolved incidents cannot be revised")
    if str(incident["current_stage"]).upper() != "COORDINATOR_REVIEW":
        raise HTTPException(status_code=409, detail="Revision request is only allowed during coordinator review")

    requested_fields = []
    for raw_field in payload.revision_fields or []:
        normalized = str(raw_field or "").strip().lower()
        if normalized and normalized in REVISION_FIELDS_ALLOWED and normalized not in requested_fields:
            requested_fields.append(normalized)

    metadata = {
        "mode": "REQUEST_REVISION",
        "comment": (payload.comment or "").strip() or None,
        "performed_by_user_id": int(user["id"]),
        "revision_fields": requested_fields,
    }
    try:
        db.execute(
            text(
                """
                UPDATE incidents
                SET location_match_status = 'NEEDS_REVISION',
                    location_reviewed_by_user_id = :reviewer,
                    location_reviewed_at = NOW(),
                    location_match_metadata = :metadata,
                    updated_at = NOW()
                WHERE id = :iid
                """
            ),
            {
                "iid": incident_id,
                "reviewer": int(user["id"]),
                "metadata": json.dumps(metadata),
            },
        )
        db.commit()
        return {"incident_id": int(incident_id), "location_match_status": "NEEDS_REVISION"}
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.patch("/incidents/{incident_id}")
def maintenance_resubmit_incident(
    payload: IncidentCreate,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(FIELD_REPORTING_ROLES)),
):
    incident = _incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    if str(incident["status"]).upper() == "RESOLVED":
        raise HTTPException(status_code=409, detail="Resolved incidents cannot be edited")

    user_roles = set(user.get("roles") or [])
    is_admin = "ADMIN" in user_roles
    if not is_admin and int(incident["reporter_user_id"]) != int(user["id"]):
        raise HTTPException(status_code=403, detail="Only the reporting maintenance worker can resubmit this incident")
    if str(incident["current_stage"]).upper() != "COORDINATOR_REVIEW":
        raise HTTPException(status_code=409, detail="This incident is no longer in coordinator review")
    if str(incident["location_match_status"] or "").upper() != "NEEDS_REVISION":
        raise HTTPException(status_code=409, detail="This incident is not marked for revision")

    district = _normalize_text(payload.district)
    county = _normalize_text(payload.county)
    route = normalize_route(payload.route)
    post_mile = normalize_post_mile(payload.post_mile)
    latitude = round_coordinate(payload.latitude)
    longitude = round_coordinate(payload.longitude)
    if not (district and county and route and post_mile):
        raise HTTPException(
            status_code=400,
            detail="district, county, route, and post_mile are required location fields",
        )
    if latitude is None or longitude is None:
        raise HTTPException(status_code=400, detail="latitude and longitude are required")

    metadata_obj = incident.get("location_match_metadata") or {}
    requested_fields_raw = metadata_obj.get("revision_fields") if isinstance(metadata_obj, dict) else None
    requested_fields = {
        str(x or "").strip().lower()
        for x in (requested_fields_raw or [])
        if str(x or "").strip().lower() in REVISION_FIELDS_ALLOWED
    }
    if requested_fields:
        old_first_observed = str(incident.get("first_observed_at") or "")[:10]
        old_first_occurred = str(incident.get("first_occurred_at") or "")[:10]
        changed_fields: set[str] = set()
        if _normalize_text(incident.get("district")) != district:
            changed_fields.add("district")
        if _normalize_text(incident.get("county")) != county:
            changed_fields.add("county")
        if _normalize_text(incident.get("route")) != route:
            changed_fields.add("route")
        if _normalize_text(incident.get("post_mile")) != post_mile:
            changed_fields.add("post_mile")
        if coordinates_differ(incident.get("latitude"), latitude):
            changed_fields.add("latitude")
        if coordinates_differ(incident.get("longitude"), longitude):
            changed_fields.add("longitude")
        if old_first_observed != str(payload.first_observed_at)[:10]:
            changed_fields.add("first_observed_at")
        if old_first_occurred != str(payload.first_occurred_at or "")[:10]:
            changed_fields.add("first_occurred_at")
        if _normalize_text(incident.get("description")) != _normalize_text(payload.description):
            changed_fields.add("description")
        disallowed_changes = sorted([f for f in changed_fields if f not in requested_fields])
        if disallowed_changes:
            raise HTTPException(
                status_code=400,
                detail=f"Only requested revision fields may be changed: {', '.join(sorted(requested_fields))}",
            )

    office_code = org_directory.office_for_district(db, district)
    ri = _validate_road_inventory_context(db, payload.road_inventory_context)
    metadata = {
        "mode": "RESUBMITTED_BY_MAINTENANCE",
        "performed_by_user_id": int(user["id"]),
    }
    ri_set_sql = ""
    ri_params: dict = {}
    if ri:
        ri_set_sql = (
            "road_inventory_dataset_version_id = :ri_dataset_version_id, "
            "road_inventory_segment_id = :ri_segment_id, "
            "road_inventory_snapshot_json = :ri_snapshot_json, "
            "road_inventory_match_method = :ri_match_method, "
            "road_inventory_checked_at = :ri_checked_at, "
        )
        ri_params = {
            "ri_dataset_version_id": ri["ri_dataset_version_id"],
            "ri_segment_id": ri["ri_segment_id"],
            "ri_snapshot_json": ri["ri_snapshot_json"],
            "ri_match_method": ri["ri_match_method"],
            "ri_checked_at": datetime.utcnow(),
        }
    try:
        db.execute(
            text(
                f"""
                UPDATE incidents
                SET title = :title,
                    incident_type = :incident_type,
                    description = :description,
                    latitude = :lat,
                    longitude = :lon,
                    first_observed_at = :first_observed_at,
                    first_occurred_at = :first_occurred_at,
                    district = :district,
                    county = :county,
                    route = :route,
                    post_mile = :post_mile,
                    office_code = :office_code,
                    {ri_set_sql}
                    location_id = NULL,
                    location_match_status = 'PENDING_REVIEW',
                    location_reviewed_by_user_id = NULL,
                    location_reviewed_at = NULL,
                    location_match_metadata = :metadata,
                    updated_at = NOW()
                WHERE id = :iid
                """
            ),
            {
                "iid": incident_id,
                "title": incident_name(district=district, county=county, route=route, post_mile=post_mile, observed_at=payload.first_observed_at),
                "incident_type": (payload.incident_type or "").strip() or None,
                "description": (payload.description or "").strip() or None,
                "lat": latitude,
                "lon": longitude,
                "first_observed_at": payload.first_observed_at,
                "first_occurred_at": payload.first_occurred_at,
                "district": district,
                "county": county,
                "route": route,
                "post_mile": post_mile,
                "office_code": office_code,
                "metadata": json.dumps(metadata),
                **ri_params,
            },
        )
        db.commit()
        row = _incident_with_assignment(db, incident_id)
        return {"incident": _serialize_incident(dict(row))}
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/incidents")
def list_incidents(
    status: str | None = Query(default=None),
    unclaimed_only: bool = Query(default=False),
    scope: str | None = Query(default=None),
    queue: str | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=1000),
    db: Session = Depends(get_db),
    # This list enumerates role names instead of consulting OPERATIONAL_ROLES,
    # so SENIOR_SPECIALIST has to be added by hand: without it a
    # senior-engineer-only account is 403'd from the incident behind their own
    # assessment. GUEST is here for the opposite reason — it is NOT an
    # operational role — and the row predicate below is what makes the addition
    # safe (design §4.5).
    user=Depends(require_roles(ALL_ROLE_NAMES)),
):
    params: dict[str, object] = {"limit": limit}
    where_parts: list[str] = []
    # A viewer sees only incidents carrying an approved assessment. A no-op for
    # every other account.
    public_visibility.scope_public_incidents(user, where_parts, params)
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
    # Broad visibility, narrow authority: Maintenance Crew members are scoped
    # to their OWN reports server-side regardless of the requested scope. This
    # is enforced here (not only in the mobile filter) so the WebUI cannot be
    # used to enumerate statewide incidents.
    if is_maintenance_only(user):
        where_parts.append("i.reporter_user_id = :self_uid")
        params["self_uid"] = int(user["id"])
    # queue=triage is a WORK queue, not the broad list: reports waiting for a
    # coordinator in the districts the caller covers. Anyone who is not a
    # coordinator (or an administrator) has nothing to triage.
    work_queue = (queue or "").strip().lower()
    if work_queue == "triage":
        where_parts.append("i.current_stage = 'COORDINATOR_REVIEW' AND i.status <> 'RESOLVED'")
        if "ADMIN" not in set(user.get("roles") or []):
            if has_role(user, MAINTENANCE_COORDINATOR):
                where_parts.append(_district_filter("i.district", _caller_districts(user, db), params, "triage_district_"))
            else:
                where_parts.append("1=0")
    elif work_queue:
        raise HTTPException(status_code=400, detail="Invalid queue filter")
    where_sql = f"WHERE {' AND '.join(where_parts)}" if where_parts else ""
    rows = db.execute(
        text(
            f"""
            SELECT
              i.id, i.title, i.incident_type, i.description,
              i.location_id, i.location_match_status, i.location_reviewed_by_user_id, i.location_match_metadata, i.location_reviewed_at,
              i.first_observed_at, i.first_occurred_at,
              i.latitude, i.longitude, i.district, i.county, i.route, i.post_mile,
              i.road_inventory_dataset_version_id, i.road_inventory_segment_id,
              i.road_inventory_snapshot_json, i.road_inventory_match_method, i.road_inventory_checked_at,
              i.office_code, i.current_stage, i.event_group_id, i.incident_key,
              i.status, i.reporter_user_id, i.created_at, i.updated_at,
              i.resolved_at, i.resolved_by_user_id, i.resolution_comment,
              i.triage_disposition, i.triage_decided_by_user_id, i.triage_decided_at,
              i.triage_notes, i.duplicate_of_incident_id, i.duplicate_of_location_id,
              a.id AS assignment_id, a.assignee_user_id, a.assigned_by_user_id,
              a.assignment_mode, a.assignment_stage, a.created_at AS assigned_at,
              u.email AS assignee_email, u.full_name AS assignee_name,
              ru.full_name AS reporter_name, ru.email AS reporter_email,
              tu.full_name AS triage_decided_by_name,
              rsu.full_name AS resolved_by_name,
              isl.submission_id
            FROM incidents i
            LEFT JOIN incident_assignments a
              ON a.incident_id = i.id AND a.assignment_stage = 'ENGINEER' AND a.is_active = 1
            LEFT JOIN users u
              ON u.id = a.assignee_user_id
            -- The reporter by name. Coordinator triage has to say who filed a
            -- report before it can be judged, and "User #7" is not an answer
            -- (redesign plan B5).
            LEFT JOIN users ru
              ON ru.id = i.reporter_user_id
            LEFT JOIN users tu
              ON tu.id = i.triage_decided_by_user_id
            LEFT JOIN users rsu
              ON rsu.id = i.resolved_by_user_id
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
    # This list enumerates role names instead of consulting OPERATIONAL_ROLES,
    # so SENIOR_SPECIALIST has to be added by hand: without it a
    # senior-engineer-only account is 403'd from the incident behind their own
    # assessment. GUEST is here for the opposite reason — it is NOT an
    # operational role — and ensure_public_incident below is what makes the
    # addition safe (design §4.5).
    user=Depends(require_roles(ALL_ROLE_NAMES)),
):
    row = _incident_with_assignment(db, incident_id)
    if not row:
        raise HTTPException(status_code=404, detail="Incident not found")
    incident = dict(row)
    # 404, not 403, for a non-public incident: a viewer must not be able to
    # enumerate in-flight work by probing ids (design §4.3).
    public_visibility.ensure_public_incident(db, user, incident_id)
    _ensure_incident_scope_access(user, incident, db=db)
    return {"incident": _serialize_incident(incident), "requested_by_user_id": user["id"]}


@router.post("/incidents/{incident_id}/claim")
def claim_incident(
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(FIELD_REPORTING_ROLES)),
):
    raise HTTPException(status_code=409, detail="Claim is disabled. Incidents must follow coordinator/office/branch workflow.")


@router.post("/incidents/{incident_id}/assign")
def assign_incident(
    payload: IncidentAssignRequest,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN"])),
):
    # Backward-compatible endpoint for older Admin clients. Fail at the API
    # boundary with a controlled workflow response instead of leaking the
    # MariaDB trigger/SQL text when a pre-Project Incident is assigned.
    project_row = db.execute(
        text("SELECT project_id FROM incidents WHERE id = :iid LIMIT 1"),
        {"iid": incident_id},
    ).mappings().first()
    if not project_row:
        raise HTTPException(status_code=404, detail="Incident not found")
    if project_row["project_id"] is None:
        raise HTTPException(
            status_code=409,
            detail="Choose or create a Project for this Incident before engineering assignment.",
        )
    # Admin recovery tool, but never a way around the routing decision: on the
    # Senior Specialist route the assignee is a Senior Specialist chosen by the
    # office chief, and dropping a Staff member into the incident's ENGINEER
    # stage here would contradict the assessment and trip the route-aware
    # eligibility trigger with a database message instead of an explanation
    # (design §5.3).
    senior_engineer_route = db.execute(
        text(
            """
            SELECT 1 FROM assessments
            WHERE incident_id = :iid AND routing_path = 'SENIOR_ENGINEER'
            LIMIT 1
            """
        ),
        {"iid": incident_id},
    ).scalar()
    if senior_engineer_route:
        raise HTTPException(
            status_code=409,
            detail="This incident's assessment was assigned to a Senior Specialist",
        )

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
    user=Depends(require_roles([MAINTENANCE_COORDINATOR, ADMIN])),
):
    incident = _incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    _ensure_incident_district_access(user, incident.get("district"), db=db)
    if str(incident["status"]).upper() == "RESOLVED":
        raise HTTPException(status_code=409, detail="Resolved incidents cannot be forwarded")
    if incident["location_id"] is None:
        raise HTTPException(
            status_code=409,
            detail="Select or create a location record before forwarding this incident.",
        )

    office_code = incident.get("office_code")
    if not office_code:
        office_code = org_directory.office_for_district(db, incident.get("district"))

    office_chief_ids = _routing_users_for(
        db=db,
        assignment_type="OFFICE_CHIEF",
        office_code=office_code,
    )
    if not office_chief_ids:
        raise HTTPException(status_code=400, detail="No office chief routing configured for this office")

    try:
        linked_submission_id = _ensure_linked_submission(
            db=db,
            incident_row=incident,
            assignee_user_id=int(user["id"]),
            actor_user_id=int(user["id"]),
        )
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
        return {
            "incident_id": incident_id,
            "current_stage": "OFFICE_CHIEF_REVIEW",
            "office_code": office_code,
            "linked_submission_id": linked_submission_id,
        }
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/incidents/{incident_id}/office-chief/branch-options")
def office_chief_branch_options(
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles([OFFICE_CHIEF, ADMIN])),
):
    incident = _incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    office_code = incident.get("office_code") or org_directory.office_for_district(db, incident.get("district"))
    _ensure_incident_office_access(user, office_code, db=db)
    people = _routing_user_options_for(
        db=db,
        assignment_type="BRANCH_CHIEF",
        office_code=office_code,
    )
    # The same grouped, annotated payload the assessment-scoped picker returns,
    # so the mobile branch half and the web one render identically (design §5).
    groups, items = _picker_payload_by_branch(db, people, office_code)
    return {
        "incident_id": int(incident_id),
        "office_code": office_code,
        "groups": groups,
        "items": items,
    }


# Routing v2 retired both incident-stage routing endpoints below (design §5.3).
# They moved incident stages and created ENGINEER-stage assignments WITHOUT
# touching assessments.state or assessments.routing_path — exactly the bypass
# that could put a Staff member on a senior-engineer-route assessment, or
# advance the incident while the assessment stayed behind. Routing now happens
# on the assessment, which drives the incident stage machine as a consequence.
#
# They stay mounted, and keep their request models, so an old client gets this
# explanation rather than a 404. The GET sibling
# /incidents/{id}/office-chief/branch-options is deliberately still live: it is
# a read, it enforces office access, and it is the branch half of the
# two-choice picker on mobile until the mobile minimum ships.
_LEGACY_ROUTING_RETIRED_DETAIL = (
    "Routing moved to the assessment: POST /assessments/{aid}/delegate-branch or /assign-senior-engineer"
)


@router.post("/incidents/{incident_id}/office-chief/assign-branch")
def office_chief_assign_branch(
    payload: IncidentAssignBranchChiefRequest,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles([OFFICE_CHIEF, ADMIN])),
):
    """410 Gone — hand off on the assessment (design §5.3)."""
    raise HTTPException(status_code=410, detail=_LEGACY_ROUTING_RETIRED_DETAIL)


@router.post("/incidents/{incident_id}/branch-chief/assign-engineer")
def branch_chief_assign_engineer(
    payload: IncidentAssignEngineerRequest,
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles([BRANCH_CHIEF, ADMIN])),
):
    """410 Gone — assign the Staff member on the assessment (design §5.3)."""
    raise HTTPException(status_code=410, detail=_LEGACY_ROUTING_RETIRED_DETAIL)


# The org model retired the routing-assignment table as an ADMIN SURFACE (design
# §7). It stored coordinator coverage as one row per (type, district, office,
# user) with no notion of primacy, no multi-district coverage and no relation to
# the office structure; `org_coordinator_coverage` and the office/branch tables
# answer all three. The rows and the table stay as history — nothing is dropped
# here — but every reader has moved: _routing_users_for reads the coverage table,
# and Administration > Organization is where an admin edits it.
#
# All three endpoints stay mounted, with their guards, so an old Admin client
# gets this explanation rather than a 404 (the same choice §5.3 made for the two
# retired incident-routing writes above).
_ROUTING_ASSIGNMENTS_RETIRED_DETAIL = (
    "Routing assignments moved to /admin/org/coverage in the organization model release"
)


@router.get("/incidents/routing/assignments")
def list_incident_routing_assignments(
    assignment_type: str | None = Query(default=None),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN"])),
):
    """410 Gone — coordinator coverage now lives at /admin/org/coverage."""
    raise HTTPException(status_code=410, detail=_ROUTING_ASSIGNMENTS_RETIRED_DETAIL)


@router.post("/incidents/routing/assignments")
def create_incident_routing_assignment(
    payload: dict,
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN"])),
):
    """410 Gone — POST /admin/org/coverage."""
    raise HTTPException(status_code=410, detail=_ROUTING_ASSIGNMENTS_RETIRED_DETAIL)


@router.delete("/incidents/routing/assignments/{assignment_id}")
def delete_incident_routing_assignment(
    assignment_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(["ADMIN"])),
):
    """410 Gone — DELETE /admin/org/coverage/{id}."""
    raise HTTPException(status_code=410, detail=_ROUTING_ASSIGNMENTS_RETIRED_DETAIL)


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
    # The real gate is the identity check below (assignee_user_id == user.id).
    # On the Senior Specialist route the Senior Specialist IS the incident's active
    # ENGINEER-stage assignee, so a Staff-only guard would 403 them before that
    # check ever ran. Resolution policy is unchanged: it stays
    # with the assignee.
    user=Depends(require_roles(GISA_AUTHOR_ROLES)),
):
    incident = _incident_with_assignment(db, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    assignee_user_id = incident["assignee_user_id"]
    if not ("ADMIN" in set(user["roles"]) or (assignee_user_id is not None and int(assignee_user_id) == int(user["id"]))):
        raise HTTPException(
            status_code=403,
            detail="Only the assignee (Staff or Senior Specialist) or admin can resolve",
        )
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
    # This list enumerates role names instead of consulting OPERATIONAL_ROLES,
    # so SENIOR_SPECIALIST has to be added by hand: without it a
    # senior-engineer-only account is 403'd from the incident behind their own
    # assessment. GUEST carries the same public row predicate as
    # GET /incidents (design §4.5).
    user=Depends(require_roles(ALL_ROLE_NAMES)),
):
    where_parts: list[str] = []
    params: dict[str, object] = {}
    public_visibility.scope_public_incidents(user, where_parts, params)
    if (scope or "").strip().lower() == "mobile":
        mobile_filters, mobile_params = _mobile_scope_filters(db, user)
        where_parts.extend(mobile_filters)
        params.update(mobile_params)
    # Maintenance Crew members only ever see their own reports (server-side).
    if is_maintenance_only(user):
        where_parts.append("i.reporter_user_id = :self_uid")
        params["self_uid"] = int(user["id"])
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


@router.get("/incidents/{incident_id}/attachments")
def list_incident_attachments(
    incident_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    user=Depends(require_roles(INCIDENT_EVIDENCE_READ_ROLES)),
):
    """Everything the reporter attached to a field report, with access URLs.

    Coordinator triage could not see the evidence before this endpoint existed:
    the only read path for a report's files was the Mission Center map, which
    returns ``kind = 'PHOTO'`` rows alone, so a report whose evidence was a video
    or a document looked empty. A coordinator is being asked whether a report is
    a real incident, so they get every attachment, in upload order, with the
    capture metadata recorded by the device.

    Row-level scope is the incident's own rule (``_ensure_incident_scope_access``):
    a maintenance field reporter sees their own report and nobody else's. A
    read-only viewer sees the evidence of an APPROVED record only, and gets 404
    — not 403 — for anything in flight, so in-progress work cannot be enumerated
    by probing ids (org model design §4.3).
    """
    incident = db.execute(
        text("SELECT id, reporter_user_id, office_code, district FROM incidents WHERE id = :iid LIMIT 1"),
        {"iid": incident_id},
    ).mappings().first()
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    public_visibility.ensure_public_incident(db, user, incident_id)
    _ensure_incident_scope_access(user, dict(incident), db=db)

    rows = db.execute(
        text(
            """
            SELECT
              ia.attachment_id, ia.kind, ia.sort_order,
              a.file_name, a.mime_type, a.file_size_bytes,
              a.storage_bucket, a.storage_key, a.uploaded_at,
              COALESCE(cm.captured_at, a.captured_at) AS captured_at,
              cm.latitude, cm.longitude, cm.horizontal_accuracy_m,
              cm.camera_heading_deg, cm.heading_reference, cm.location_source
            FROM incident_attachments ia
            JOIN attachments a ON a.id = ia.attachment_id
            LEFT JOIN attachment_capture_metadata cm ON cm.attachment_id = a.id
            WHERE ia.incident_id = :iid
            ORDER BY ia.sort_order ASC, ia.attachment_id ASC
            """
        ),
        {"iid": incident_id},
    ).mappings().all()

    items = []
    for row in rows:
        items.append(
            {
                "attachment_id": int(row["attachment_id"]),
                "kind": row["kind"],
                "file_name": row["file_name"],
                "mime_type": row["mime_type"],
                "file_size_bytes": int(row["file_size_bytes"]) if row["file_size_bytes"] is not None else None,
                "uploaded_at": row["uploaded_at"],
                "captured_at": row["captured_at"],
                "latitude": float(row["latitude"]) if row["latitude"] is not None else None,
                "longitude": float(row["longitude"]) if row["longitude"] is not None else None,
                "horizontal_accuracy_m": (
                    float(row["horizontal_accuracy_m"]) if row["horizontal_accuracy_m"] is not None else None
                ),
                "camera_heading_deg": (
                    float(row["camera_heading_deg"]) if row["camera_heading_deg"] is not None else None
                ),
                "heading_reference": row["heading_reference"],
                "location_source": row["location_source"],
                "download_url": object_access_url(
                    str(row["storage_bucket"] or settings.MINIO_BUCKET),
                    str(row["storage_key"]),
                    expires_seconds=900,
                ),
            }
        )
    return {"incident_id": incident_id, "items": items}


@router.post("/incidents/{incident_id}/attachments")
async def upload_incident_attachment(
    incident_id: int = Path(..., ge=1),
    file: UploadFile = File(...),
    kind: str = Query(default="PHOTO", max_length=16),
    db: Session = Depends(get_db),
    user=Depends(require_roles(FIELD_REPORTING_ROLES)),
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

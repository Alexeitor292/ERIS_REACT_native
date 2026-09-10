"""The organization, as data: offices, branches, membership and district routing.

One module answers the two questions the rest of the backend keeps asking:

    "which office serves this district?"   -> :func:`office_for_district`
    "which office and branch is this person in?" -> :func:`resolve_user_org`

Before the org model both answers were guesses spread across the codebase. The
district map existed in THREE places — ``routes/incidents.OFFICE_BY_DISTRICT``,
``services/office_routing.LEGACY_OFFICE_BY_DISTRICT`` and the twelve rows
migration 0008 seeded into ``geotech_office_routing`` — and the two hard-coded
copies won on exactly the paths that bypassed the table, invisibly to any admin.
Membership was a free-text string in ``users.metadata_json``. Both are now rows
an admin can edit (owner decision 8), and this module is the only reader.

Two rules the callers depend on, stated once here so they cannot drift:

**The mirror, never the source.** ``users.metadata_json`` keeps its three-key
whitelist and becomes a DERIVED MIRROR of the profile row. ``resolve_user_org``
prefers ``org_user_profiles`` and falls back to the mirror when there is no
profile row OR the row's ``office_id IS NULL`` — keying on row absence alone
would be wrong, because the migration gives EVERY active user a profile row,
including users with no office. :func:`mirror_metadata_from_profile` writes the
mirror back from the profile so a partially-migrated deployment, or a client
still reading ``metadata``, cannot strand a chief's review queue (design §3.2).

**Deactivation does not revoke in-flight authority.** Office and branch resolve
REGARDLESS of ``is_active``, and their flags come back so the UI can badge them
*Retired*. Filtering inside the resolver would make one admin click strip review
authority from every open assessment in that office — the exact failure owner
decision 8 forbids. ``is_active = 0`` means "not offered in any picker, not
returned by district resolution", and nothing more (design §3.8).
"""

from __future__ import annotations

import logging
import re
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..user_metadata import (
    normalize_district_code,
    normalize_office_code,
    normalize_profile_text,
    parse_user_metadata,
    user_metadata_json,
)

logger = logging.getLogger(__name__)

# Every office lookup driven by an incident or an assessment passes this type.
# ``org_offices.code`` is unique only WITHIN an org type, so a future maintenance
# office may reuse WEST/NORTH/SOUTH (design §3.3).
GEOTECH = "GEOTECH"

# The legacy fallback map — the one surviving copy of the constant that used to
# live in three places. It is consulted ONLY when the org tables answer nothing:
# a district nobody has configured yet, or a pre-migration database. Pinned by
# backend/tests/test_roles_and_routing.py::TestOfficeRoutingFallback.
LEGACY_OFFICE_BY_DISTRICT: dict[str, str] = {
    "01": "WEST",
    "02": "NORTH",
    "03": "NORTH",
    "04": "WEST",
    "05": "WEST",
    "06": "NORTH",
    "07": "SOUTH",
    "08": "SOUTH",
    "09": "NORTH",
    "10": "NORTH",
    "11": "SOUTH",
    "12": "SOUTH",
}

# ---------------------------------------------------------------------------
# SQL fragments — so every "which office is this user in?" query answers the
# same way, in the database, as resolve_user_org() answers in Python.
# ---------------------------------------------------------------------------
# Join these against a query that already aliases ``users`` as ``u``. The office
# code is the profile row's office FIRST and the metadata mirror second, which is
# what lets an account created before the org model and an account created by the
# org admin API both resolve while the two write paths overlap (design §13.3).
USER_ORG_JOIN_SQL = """
  LEFT JOIN org_user_profiles oup ON oup.user_id = u.id
  LEFT JOIN org_offices oo ON oo.id = oup.office_id AND oo.org_type = 'GEOTECH'
"""

#
# JSON_VALUE, not JSON_UNQUOTE(JSON_EXTRACT(...)): in MariaDB the latter answers
# the four-character STRING 'null' for a JSON null, and a JSON null is exactly
# what ``user_metadata_json`` writes for every key the admin form left blank. The
# unquoting form therefore reports an account with no office as being in an
# office called NULL — which drops it out of the blank-office picker fallback and
# shows "null" as a district in every picker. JSON_VALUE answers SQL NULL.
USER_OFFICE_CODE_SQL = """
  COALESCE(
    NULLIF(oo.code, ''),
    NULLIF(UPPER(TRIM(COALESCE(JSON_VALUE(u.metadata_json, '$.office_code'), ''))), ''),
    ''
  )
"""

USER_DISTRICT_SQL = """
  COALESCE(
    NULLIF(RTRIM(COALESCE(oup.home_district, '')), ''),
    NULLIF(TRIM(COALESCE(JSON_VALUE(u.metadata_json, '$.district'), '')), ''),
    ''
  )
"""


def _empty_org(user_id: int | None = None) -> dict[str, Any]:
    return {
        "user_id": int(user_id) if user_id is not None else None,
        "has_profile": False,
        "office_id": None,
        "office_code": None,
        "office_name": None,
        "office_short_name": None,
        "office_unit_number": None,
        "office_is_active": None,
        "branch_id": None,
        "branch_letter": None,
        "branch_name": None,
        "branch_is_active": None,
        "home_city": None,
        "home_district": None,
        "classification_code": None,
        "classification_marker": None,
        "position_number": None,
        "job_title": None,
        "level_code": None,
        "supervisor_user_id": None,
        "availability": "AVAILABLE",
        "available_from": None,
        "available_until": None,
        "source": None,
    }


def _int_or_none(value: Any) -> int | None:
    return int(value) if value is not None else None


def _text_or_none(value: Any) -> str | None:
    if value is None:
        return None
    trimmed = str(value).strip()
    return trimmed or None


# ---------------------------------------------------------------------------
# District -> office
# ---------------------------------------------------------------------------


def resolve_office_for_district(db: Session, raw_district: str | None) -> dict[str, Any]:
    """Resolve a district to the GeoTech office that serves it.

    Returns ``district``, ``office_id``, ``office_code``, ``office_name``,
    ``office_short_name`` and ``source``. ``source`` keeps the three values the
    web and mobile clients already type: ``routing_table`` (an
    ``org_office_districts`` row — the admin-editable table), ``legacy_fallback``
    (the constant above) or ``none``.

    Only ACTIVE rows of ACTIVE routing-target offices are returned: deactivating
    an office must stop new work arriving without touching the work already
    there.
    """
    code = normalize_district_code(raw_district)
    if not code:
        return {
            "district": None,
            "office_id": None,
            "office_code": None,
            "office_name": None,
            "office_short_name": None,
            "source": "none",
        }
    row = None
    try:
        # SAVEPOINT, not a bare try/except: this runs inside request and approval
        # transactions, so a failing statement would otherwise poison the session
        # and the NEXT statement would raise PendingRollbackError — turning a
        # missing table into a failed write.
        with db.begin_nested():
            row = db.execute(
                text(
                    """
                    SELECT o.id, o.code, o.name, o.short_name
                      FROM org_office_districts d
                      JOIN org_offices o ON o.id = d.office_id AND o.org_type = :org_type
                     WHERE d.org_type = :org_type
                       AND d.district = :district
                       AND d.is_active = 1
                       AND o.is_active = 1
                       AND o.is_routing_target = 1
                     ORDER BY d.is_primary DESC, o.sort_order ASC, o.id ASC
                     LIMIT 1
                    """
                ),
                {"district": code, "org_type": GEOTECH},
            ).mappings().first()
    except Exception:
        # Pre-migration database, or a transient error. Falling back keeps
        # routing working, but it is a misconfiguration either way, so it is
        # logged at ERROR rather than swallowed (design §13.7).
        logger.exception("org_office_districts lookup failed for district %s", code)
        row = None
    if row:
        return {
            "district": code,
            "office_id": int(row["id"]),
            "office_code": str(row["code"]),
            "office_name": _text_or_none(row["name"]),
            "office_short_name": _text_or_none(row["short_name"]),
            "source": "routing_table",
        }
    fallback = LEGACY_OFFICE_BY_DISTRICT.get(code)
    if not fallback:
        return {
            "district": code,
            "office_id": None,
            "office_code": None,
            "office_name": None,
            "office_short_name": None,
            "source": "none",
        }
    logger.error(
        "No active org_office_districts row for district %s; falling back to the "
        "legacy constant (%s). Enter the coverage in Administration > Organization.",
        code,
        fallback,
    )
    office = office_by_code(db, fallback)
    return {
        "district": code,
        "office_id": office.get("id") if office else None,
        "office_code": fallback,
        "office_name": office.get("name") if office else None,
        "office_short_name": office.get("short_name") if office else None,
        "source": "legacy_fallback",
    }


def office_for_district(db: Session, raw_district: str | None) -> str | None:
    """Return the GeoTech office_code for a district, or None if unknown.

    The replacement for ``incidents.OFFICE_BY_DISTRICT`` and its four bypassing
    call sites. Never raises.
    """
    return resolve_office_for_district(db, raw_district).get("office_code")


def routing_preview(db: Session, raw_district: str | None) -> dict[str, Any]:
    """Coordinator-facing preview of where a district's work will be routed.

    Same shape the clients already consume (``district``, ``office_code``,
    ``office_name``, ``source``) plus ``office_id`` and ``office_short_name``, so
    triage can freeze the office snapshot from the same lookup that chose it.
    """
    resolved = resolve_office_for_district(db, raw_district)
    return {
        "district": resolved["district"],
        "office_id": resolved["office_id"],
        "office_code": resolved["office_code"],
        "office_name": resolved["office_name"],
        "office_short_name": resolved["office_short_name"],
        "source": resolved["source"],
    }


def office_by_code(db: Session, raw_code: str | None, *, org_type: str = GEOTECH) -> dict[str, Any] | None:
    """One office by its immutable code, active or not.

    Not filtered on ``is_active``: an assessment routed to an office that has
    since been retired must still be able to name it (design §3.8 rule 3).
    """
    code = normalize_office_code(raw_code)
    if not code:
        return None
    try:
        with db.begin_nested():
            row = db.execute(
                text(
                    """
                    SELECT id, code, org_type, unit_number, name, short_name,
                           home_city, home_district, home_location_label,
                           is_routing_target, is_active, sort_order
                      FROM org_offices
                     WHERE org_type = :org_type AND code = :code
                     LIMIT 1
                    """
                ),
                {"code": code, "org_type": org_type},
            ).mappings().first()
    except Exception:
        logger.exception("org_offices lookup failed for code %s", code)
        return None
    if not row:
        return None
    record = dict(row)
    record["id"] = int(record["id"])
    record["is_active"] = bool(record.get("is_active"))
    record["is_routing_target"] = bool(record.get("is_routing_target"))
    return record


def branch_by_id(db: Session, branch_id: int | None) -> dict[str, Any] | None:
    """One branch by id, active or not — the same deactivation rule as offices."""
    if branch_id is None:
        return None
    try:
        with db.begin_nested():
            row = db.execute(
                text(
                    """
                    SELECT b.id, b.office_id, b.unit_type, b.letter, b.name,
                           b.home_city, b.home_district, b.home_location_label,
                           b.chief_user_id, b.accepts_assignments, b.is_active,
                           o.code AS office_code
                      FROM org_branches b
                      JOIN org_offices o ON o.id = b.office_id
                     WHERE b.id = :bid
                     LIMIT 1
                    """
                ),
                {"bid": int(branch_id)},
            ).mappings().first()
    except Exception:
        logger.exception("org_branches lookup failed for id %s", branch_id)
        return None
    if not row:
        return None
    record = dict(row)
    record["id"] = int(record["id"])
    record["office_id"] = int(record["office_id"])
    record["is_active"] = bool(record.get("is_active"))
    record["accepts_assignments"] = bool(record.get("accepts_assignments"))
    return record


# ---------------------------------------------------------------------------
# User -> office / branch
# ---------------------------------------------------------------------------


def _metadata_for(db: Session, user_or_id: Any) -> tuple[int | None, dict[str, Any]]:
    """The user id and the metadata MIRROR, for the fallback half of the resolve.

    A dict caller (the request user) already carries its parsed metadata; an int
    caller means a lookup.
    """
    if isinstance(user_or_id, dict):
        user_id = _int_or_none(user_or_id.get("id"))
        metadata = user_or_id.get("metadata") or {}
        return user_id, dict(metadata)
    user_id = _int_or_none(user_or_id)
    if user_id is None:
        return None, {}
    try:
        with db.begin_nested():
            raw = db.execute(
                text("SELECT metadata_json FROM users WHERE id = :uid LIMIT 1"),
                {"uid": user_id},
            ).scalar()
    except Exception:
        logger.exception("users.metadata_json lookup failed for user %s", user_id)
        return user_id, {}
    return user_id, parse_user_metadata(raw)


def resolve_user_org(db: Session, user_or_id: Any, *, use_cache: bool = True) -> dict[str, Any]:
    """Where this person sits in the organization.

    Accepts the request user dict (from ``get_current_user``) or a bare user id.

    THE FALLBACK RULE, exactly: fall back to ``metadata_json.office_code`` when
    there is no profile row OR the profile row's ``office_id IS NULL``; likewise
    fall back to ``metadata_json.district`` when ``home_district`` is NULL. Row
    absence alone is the wrong test — the migration gives every active user a
    row, including users with no office.

    THE DEACTIVATION RULE, exactly: office and branch resolve REGARDLESS of
    ``is_active``, and ``office_is_active`` / ``branch_is_active`` come back so
    the caller can badge them.

    When ``user_or_id`` is the request user dict the answer is cached on it under
    ``"org"``, because a single request asks this question several times (the
    review-authority check, the queue scope, the picker). The cache lives exactly
    as long as the request; a handler that has just WRITTEN a profile row must
    pass the user id, or ``use_cache=False``, to see its own write.
    """
    if use_cache and isinstance(user_or_id, dict):
        cached = user_or_id.get("org")
        if isinstance(cached, dict):
            return cached

    user_id, metadata = _metadata_for(db, user_or_id)
    record = _empty_org(user_id)
    if user_id is None:
        return record

    row = None
    try:
        with db.begin_nested():
            row = db.execute(
                text(
                    """
                    SELECT p.user_id, p.office_id, p.branch_id, p.home_city, p.home_district,
                           p.classification_code, p.classification_marker, p.position_number,
                           p.job_title, p.level_code, p.supervisor_user_id, p.availability,
                           p.available_from, p.available_until, p.source,
                           o.code AS office_code, o.name AS office_name,
                           o.short_name AS office_short_name, o.unit_number AS office_unit_number,
                           o.is_active AS office_is_active,
                           b.letter AS branch_letter, b.name AS branch_name,
                           b.is_active AS branch_is_active
                      FROM org_user_profiles p
                      LEFT JOIN org_offices o ON o.id = p.office_id
                      LEFT JOIN org_branches b ON b.id = p.branch_id
                     WHERE p.user_id = :uid
                     LIMIT 1
                    """
                ),
                {"uid": user_id},
            ).mappings().first()
    except Exception:
        # Pre-migration database or a transient error: the mirror still answers
        # every question the readers ask, which is why the rollout can move the
        # migration and the readers in separate steps (design §13.2).
        logger.exception("org_user_profiles lookup failed for user %s", user_id)
        row = None

    if row:
        record.update(
            {
                "has_profile": True,
                "office_id": _int_or_none(row["office_id"]),
                "office_code": _text_or_none(row["office_code"]),
                "office_name": _text_or_none(row["office_name"]),
                "office_short_name": _text_or_none(row["office_short_name"]),
                "office_unit_number": _text_or_none(row["office_unit_number"]),
                "office_is_active": bool(row["office_is_active"]) if row["office_is_active"] is not None else None,
                "branch_id": _int_or_none(row["branch_id"]),
                "branch_letter": _text_or_none(row["branch_letter"]),
                "branch_name": _text_or_none(row["branch_name"]),
                "branch_is_active": bool(row["branch_is_active"]) if row["branch_is_active"] is not None else None,
                "home_city": _text_or_none(row["home_city"]),
                "home_district": _text_or_none(row["home_district"]),
                "classification_code": _text_or_none(row["classification_code"]),
                "classification_marker": _text_or_none(row["classification_marker"]),
                "position_number": _text_or_none(row["position_number"]),
                "job_title": _text_or_none(row["job_title"]),
                "level_code": _text_or_none(row["level_code"]),
                "supervisor_user_id": _int_or_none(row["supervisor_user_id"]),
                "availability": _text_or_none(row["availability"]) or "AVAILABLE",
                "available_from": row["available_from"],
                "available_until": row["available_until"],
                "source": _text_or_none(row["source"]),
            }
        )

    # The mirror fills the two facts it carries, and only where the profile is
    # silent. office_id IS NULL — not "no row" — is the trigger.
    if record["office_id"] is None:
        mirror_code = normalize_office_code(metadata.get("office_code"))
        if mirror_code:
            office = office_by_code(db, mirror_code)
            record["office_code"] = office["code"] if office else mirror_code
            if office:
                record["office_id"] = office["id"]
                record["office_name"] = _text_or_none(office.get("name"))
                record["office_short_name"] = _text_or_none(office.get("short_name"))
                record["office_unit_number"] = _text_or_none(office.get("unit_number"))
                record["office_is_active"] = office["is_active"]
    if record["home_district"] is None:
        record["home_district"] = normalize_district_code(metadata.get("district"))

    if use_cache and isinstance(user_or_id, dict):
        user_or_id["org"] = record
    return record


def user_office_code(db: Session, user_or_id: Any) -> str | None:
    """The caller's GeoTech office code, profile first and mirror second.

    The single replacement for ``normalize_office_code(user["metadata"]["office_code"])``
    in ``_review_authority``, ``_scope_office``, ``_ensure_incident_office_access``
    and the assignment-options handler. Two readers of the same fact are a bug.
    """
    return normalize_office_code(resolve_user_org(db, user_or_id).get("office_code"))


def user_home_district(db: Session, user_or_id: Any) -> str | None:
    """The caller's district, profile first and mirror second."""
    return normalize_district_code(resolve_user_org(db, user_or_id).get("home_district"))


# ---------------------------------------------------------------------------
# Keeping the mirror true
# ---------------------------------------------------------------------------


def mirror_metadata_from_profile(db: Session, user_id: int) -> None:
    """Re-render ``users.metadata_json`` from the profile row. Caller commits.

    The mirror exists so a partially-migrated deployment, an old client, or a
    reader this design has not moved yet cannot strand a chief's review queue. It
    is written FROM the org row and is never read as truth.

    ``office_location`` is preserved rather than recomputed: it is free display
    text an admin typed, the org model has a better answer for it
    (``org_offices.name``), and overwriting it here would be a silent edit of a
    field this function does not own. The whitelist itself is unchanged —
    widening it is a data-loss path, because the admin PATCH replaces the blob
    wholesale (design §3.2).
    """
    org = resolve_user_org(db, int(user_id), use_cache=False)
    existing = db.execute(
        text("SELECT metadata_json FROM users WHERE id = :uid LIMIT 1"),
        {"uid": int(user_id)},
    ).scalar()
    metadata = parse_user_metadata(existing)
    metadata["office_code"] = normalize_office_code(org.get("office_code"))
    metadata["district"] = normalize_district_code(org.get("home_district"))
    db.execute(
        text("UPDATE users SET metadata_json = :metadata, updated_at = NOW() WHERE id = :uid"),
        {"metadata": user_metadata_json(metadata), "uid": int(user_id)},
    )


def mirror_geotech_office_routing(
    db: Session,
    *,
    district: str,
    office_code: str | None,
    office_name: str | None = None,
    is_active: bool = True,
) -> None:
    """Mirror one district's routing into the legacy ``geotech_office_routing``.

    ``org_office_districts`` is authoritative from this release; the legacy table
    survives one more so a rollback to the previous backend still routes
    correctly. THIS FUNCTION IS ITS ONLY WRITER — the org admin API calls it when
    a district moves — and the FOLLOW-UP revision
    ``20260912_drop_geotech_office_routing`` (not in this release) deletes both
    the table and this function. Two writable copies of the same
    fact with no named owner is how the district map ended up in three places
    (design §13.6). Caller commits.
    """
    code = normalize_district_code(district)
    if not code:
        return
    target = normalize_office_code(office_code)
    if not target:
        db.execute(
            text("UPDATE geotech_office_routing SET is_active = 0 WHERE district = :district"),
            {"district": code},
        )
        return
    db.execute(
        text(
            """
            INSERT INTO geotech_office_routing (district, office_code, office_name, is_active)
            VALUES (:district, :office_code, :office_name, :is_active)
            ON DUPLICATE KEY UPDATE
              office_code = VALUES(office_code),
              office_name = VALUES(office_name),
              is_active = VALUES(is_active)
            """
        ),
        {
            "district": code,
            "office_code": target,
            "office_name": office_name,
            "is_active": 1 if is_active else 0,
        },
    )


# ---------------------------------------------------------------------------
# Classification -> role: a SUGGESTION, never a grant
# ---------------------------------------------------------------------------
#
# The rules live in ``org_classifications`` as DATA — fourteen concrete classes
# and two general PATTERN rules — so a new discipline needs a row, not a release
# (owner decision 8). Nothing here writes ``user_roles``: the charts themselves
# show why enforcement would be wrong, with a vacant office chief filled out of
# class and a senior specialist OOC-covered for eight months. An admin must be
# able to grant a role that contradicts a stored classification (design §6).

# The two markers the charts print, normalized. Everything else is None.
CLASSIFICATION_MARKERS = ("SUP", "SPEC")

_MARKER_IN_TITLE_RE = re.compile(r"\(\s*(SUP|SPEC)\s*\)?", re.IGNORECASE)


def normalize_classification_title(raw: Any) -> str:
    """Upper-case and collapse whitespace, so a LIKE pattern can be trusted.

    ``'Senior TE  (Sup)'`` and ``'senior te (sup)'`` are the same title; the
    charts print both, and a raw string compare would miss one of them.
    """
    value = normalize_profile_text(raw)
    return value.upper() if value else ""


def normalize_classification_marker(raw: Any) -> str | None:
    """``(Sup)`` / ``Senior TE(Spec)`` / ``Sr TE/Sr EG (SUP`` -> ``SUP`` / ``SPEC``.

    Case, whitespace AND a missing closing parenthesis all vary on the charts —
    ``Senior TE(Sup)``, ``Senior TE (Sup)`` and ``Sr TE/Sr EG (SUP`` are three
    spellings of one fact — so an exact string match would fail on real data
    (design §6, org-extract note 1). Accepts either a bare marker or a whole
    title to pull the marker out of.
    """
    value = normalize_profile_text(raw)
    if not value:
        return None
    upper = value.upper().strip()
    stripped = upper.strip("()[] \t")
    if stripped in CLASSIFICATION_MARKERS:
        return stripped
    match = _MARKER_IN_TITLE_RE.search(upper)
    if match:
        return match.group(1).upper()
    return None


def _like_matches(pattern: str, value: str) -> bool:
    """SQL ``LIKE`` semantics for the two wildcards, evaluated in Python.

    The rules are a handful of rows read once per save, so they are matched here
    rather than in SQL: the same function then answers in a unit test with no
    database, which is what §12's ``test_org_model.py`` needs.
    """
    if not pattern:
        return False
    regex = "".join(
        ".*" if char == "%" else "." if char == "_" else re.escape(char)
        for char in pattern
    )
    return re.fullmatch(regex, value or "", flags=re.IGNORECASE) is not None


def suggest_role_from_rules(
    rules: list[dict],
    *,
    class_code: str | None = None,
    marker: str | None = None,
    title: str | None = None,
    level_code: str | None = None,
) -> dict | None:
    """The first rule that matches, or None. Pure; takes the rows as data.

    Resolution order is ``priority`` then ``rule_kind``, so an exact CLASS row
    (priority 100) always wins over the two general PATTERN rules (500) — and
    the PATTERN rules only ever answer for a classification nobody has entered
    yet. A rule whose ``eris_role`` is NULL (class 5758, still undecided) is a
    match that suggests NOTHING, which is different from no match at all.
    """
    wanted_code = normalize_profile_text(class_code)
    wanted_marker = normalize_classification_marker(marker) or normalize_classification_marker(title)
    wanted_title = normalize_classification_title(title)
    wanted_level = (normalize_profile_text(level_code) or "").upper()

    ordered = sorted(
        [rule for rule in rules if rule.get("is_active", 1)],
        key=lambda r: (int(r.get("priority") or 100), str(r.get("rule_kind") or ""), int(r.get("id") or 0)),
    )
    for rule in ordered:
        rule_marker = (str(rule.get("marker") or "")).upper()
        rule_level = (str(rule.get("level_code") or "")).upper()
        if rule_marker and rule_marker != (wanted_marker or ""):
            continue
        if rule_level and wanted_level and rule_level != wanted_level:
            continue
        if str(rule.get("rule_kind") or "CLASS").upper() == "CLASS":
            # A CLASS row is addressed by its code. Its level is part of its
            # identity but not required of the caller: the level check above
            # already refused a stated level that disagrees, and refusing a
            # profile that simply has no level recorded would suggest nothing
            # for most of a freshly imported directory.
            rule_code = normalize_profile_text(rule.get("class_code"))
            if not rule_code or not wanted_code or rule_code != wanted_code:
                continue
        else:
            if rule_level and not wanted_level:
                continue
            if not _like_matches(str(rule.get("title_pattern") or ""), wanted_title):
                continue
        return {
            "suggested_role": rule.get("eris_role"),
            "rule_kind": str(rule.get("rule_kind") or "CLASS").upper(),
            "rule_id": int(rule["id"]) if rule.get("id") is not None else None,
            "title": rule.get("title"),
            "is_supervisor": bool(rule.get("is_supervisor")),
            "notes": rule.get("notes"),
        }
    return None


def classification_rules(db: Session, *, include_inactive: bool = False) -> list[dict]:
    """Every derivation rule, in resolution order."""
    where = "" if include_inactive else "WHERE is_active = 1"
    rows = db.execute(
        text(
            f"""
            SELECT id, rule_kind, class_code, marker, title_pattern, level_code,
                   title, eris_role, is_supervisor, priority, notes, is_active
              FROM org_classifications
              {where}
             ORDER BY priority ASC, rule_kind ASC, class_code ASC, id ASC
            """
        )
    ).mappings().all()
    return [dict(row) for row in rows]


def suggest_role_for_classification(
    db: Session,
    *,
    class_code: str | None = None,
    marker: str | None = None,
    title: str | None = None,
    level_code: str | None = None,
) -> dict | None:
    """``suggest_role_from_rules`` against the stored rules. Never writes."""
    try:
        with db.begin_nested():
            rules = classification_rules(db)
    except Exception:
        logger.exception("org_classifications lookup failed")
        return None
    return suggest_role_from_rules(
        rules, class_code=class_code, marker=marker, title=title, level_code=level_code
    )

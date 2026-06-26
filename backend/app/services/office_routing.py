"""District -> GeoTech Office routing.

Replaces the hardcoded ``OFFICE_BY_DISTRICT`` map that previously lived inside
``routes/incidents.py``. Routing is now data-backed by the
``geotech_office_routing`` table (seeded by migration 0008), with the legacy
constant retained as a deterministic fallback so behaviour is unchanged when the
table is empty or a district is not yet configured.

This keeps California district -> office mapping out of route handlers and gives
a clear migration path to an administration UI (the table is editable).
"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..user_metadata import normalize_district_code

# Legacy fallback map (identical to the historical incidents.OFFICE_BY_DISTRICT).
# Used only when the geotech_office_routing table has no active row for a
# district — e.g. a brand-new district added before its routing row is seeded.
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


def office_for_district(db: Session, raw_district: str | None) -> str | None:
    """Return the GeoTech office_code for a district, or None if unknown.

    Looks up the configurable routing table first, then falls back to the
    legacy constant. Never raises; returns None when nothing matches.
    """
    code = normalize_district_code(raw_district)
    if not code:
        return None
    try:
        row = db.execute(
            text(
                """
                SELECT office_code
                FROM geotech_office_routing
                WHERE district = :district AND is_active = 1
                LIMIT 1
                """
            ),
            {"district": code},
        ).scalar()
        if row:
            return str(row)
    except Exception:
        # Table missing (pre-migration) or transient error: fall back below.
        pass
    return LEGACY_OFFICE_BY_DISTRICT.get(code)


def routing_preview(db: Session, raw_district: str | None) -> dict:
    """Resolve a district to its destination office for coordinator UI preview.

    Returns the office_code, a human-readable office_name (when the table has
    one), and the source so callers can show whether the value came from the
    configurable table or the legacy fallback.
    """
    code = normalize_district_code(raw_district)
    if not code:
        return {"district": None, "office_code": None, "office_name": None, "source": "none"}
    try:
        row = db.execute(
            text(
                """
                SELECT office_code, office_name
                FROM geotech_office_routing
                WHERE district = :district AND is_active = 1
                LIMIT 1
                """
            ),
            {"district": code},
        ).mappings().first()
        if row:
            return {
                "district": code,
                "office_code": str(row["office_code"]),
                "office_name": row["office_name"],
                "source": "routing_table",
            }
    except Exception:
        pass
    fallback = LEGACY_OFFICE_BY_DISTRICT.get(code)
    return {
        "district": code,
        "office_code": fallback,
        "office_name": None,
        "source": "legacy_fallback" if fallback else "none",
    }


def list_routing(db: Session) -> list[dict]:
    rows = db.execute(
        text(
            """
            SELECT district, office_code, office_name, is_active
            FROM geotech_office_routing
            ORDER BY district
            """
        )
    ).mappings().all()
    return [
        {
            "district": r["district"],
            "office_code": r["office_code"],
            "office_name": r["office_name"],
            "is_active": bool(r["is_active"]),
        }
        for r in rows
    ]

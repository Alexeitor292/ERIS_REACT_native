"""District -> GeoTech Office routing (compatibility shim).

The routing answer now comes from ``services/org_directory.py``, which reads the
admin-editable ``org_office_districts`` rows and falls back to the legacy
constant. This module stays as the name the existing callers and tests import,
and forwards every call there: two readers of the same fact are a bug, and
leaving a second implementation here is exactly how the district map ended up in
three places (design §3.4, §13.5).

``LEGACY_OFFICE_BY_DISTRICT`` is re-exported, not re-declared, so there is one
copy of the constant in the codebase. It is the documented fallback for a
district nobody has configured yet, and
``backend/tests/test_roles_and_routing.py::TestOfficeRoutingFallback`` pins it.

``geotech_office_routing`` — the table this module used to read — is now written
only by ``org_directory.mirror_geotech_office_routing`` and read by nothing; the
FOLLOW-UP revision ``20260912_drop_geotech_office_routing`` (not in this release:
the table survives one release so a rollback still routes) drops it (design
§13.6).
"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.orm import Session

from . import org_directory
from .org_directory import LEGACY_OFFICE_BY_DISTRICT  # noqa: F401  (re-exported)


def office_for_district(db: Session, raw_district: str | None) -> str | None:
    """Return the GeoTech office_code for a district, or None if unknown."""
    return org_directory.office_for_district(db, raw_district)


def routing_preview(db: Session, raw_district: str | None) -> dict:
    """Resolve a district to its destination office for coordinator UI preview."""
    return org_directory.routing_preview(db, raw_district)


def list_routing(db: Session) -> list[dict]:
    """Every configured district -> office row, for an administration view.

    Reads ``org_office_districts`` now. The shape is unchanged, so a caller that
    rendered the legacy table renders the new one without a change.
    """
    rows = db.execute(
        text(
            """
            SELECT d.district, o.code AS office_code, o.name AS office_name, d.is_active
              FROM org_office_districts d
              JOIN org_offices o ON o.id = d.office_id AND o.org_type = d.org_type
             WHERE d.org_type = 'GEOTECH'
             ORDER BY d.district
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

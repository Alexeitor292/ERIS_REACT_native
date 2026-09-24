"""The GeoTech offices go by their abbreviations.

Revision ID: 20261002_office_abbreviations
Revises: 20261001_notification_feed
Create Date: 2026-10-02

Wherever ERIS shows an office's short name ("West GeoTech Office" until now) it
shows the abbreviation Caltrans uses:

  OGDN   Office of Geotechnical Design North
  OGDS   Office of Geotechnical Design South
  OGDW   Office of Geotechnical Design West
  OGS    Office of Geotechnical Support
  OGDPP  Office of Geotechnical Design Policy and Practice

Full names are unchanged. Assessments already routed keep the office name they
froze. The legacy district routing table's display name follows too.

Idempotent: re-running changes nothing.
"""

from alembic import op
from sqlalchemy import text

revision = "20261002_office_abbreviations"
down_revision = "20261001_notification_feed"
branch_labels = None
depends_on = None

ABBREVIATIONS = {"NORTH": "OGDN", "SOUTH": "OGDS", "WEST": "OGDW", "SUPPORT": "OGS", "POLICY": "OGDPP"}
PREVIOUS = {"NORTH": "North GeoTech Office", "SOUTH": "South GeoTech Office", "WEST": "West GeoTech Office", "SUPPORT": None, "POLICY": None}


def _has_table(bind, name: str) -> bool:
    return bool(
        bind.execute(
            text("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = :t"), {"t": name}
        ).scalar()
    )


def upgrade() -> None:
    bind = op.get_bind()
    routing = _has_table(bind, "geotech_office_routing")
    for code, abbreviation in ABBREVIATIONS.items():
        bind.execute(
            text("UPDATE org_offices SET short_name = :abbr WHERE org_type = 'GEOTECH' AND code = :code"),
            {"abbr": abbreviation, "code": code},
        )
        if routing:
            bind.execute(
                text("UPDATE geotech_office_routing SET office_name = :abbr WHERE office_code = :code"),
                {"abbr": abbreviation, "code": code},
            )


def downgrade() -> None:
    bind = op.get_bind()
    for code, previous in PREVIOUS.items():
        bind.execute(
            text("UPDATE org_offices SET short_name = :name WHERE org_type = 'GEOTECH' AND code = :code"),
            {"name": previous, "code": code},
        )

"""add terrain grid columns to submission_gisa

Revision ID: 0010_gisa_terrain_grid
Revises: 0009_incident_triage_fields
Create Date: 2026-06-26

Adds four nullable columns to submission_gisa so the road-aligned USGS 3DEP /
EPQS terrain elevation grid (the "3D Terrain" view) can be cached/persisted
alongside each GISA draft. This avoids re-querying USGS (121 points by default)
every time an incident is opened.

  elevation_terrain_grid_json   -- full road-aligned grid + provenance (JSON)
  elevation_terrain_source      -- e.g. "USGS_EPQS_3DEP"
  elevation_terrain_checked_at  -- when the grid was built
  elevation_terrain_error       -- error message if the build failed

These columns are write-once from the terrain-grid build endpoint and are
intentionally not touched by the GISA PATCH endpoint. This mirrors the
elevation_profile_* columns added in 0007.

NOTE: Following the established convention (see 0001_baseline), post-baseline
schema lives only in migrations; database/init/010_schema.sql is the frozen
baseline and is intentionally NOT modified here.
"""

from alembic import op

revision = "0010_gisa_terrain_grid"
down_revision = "0009_incident_triage_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE submission_gisa
          ADD COLUMN elevation_terrain_grid_json  JSON         NULL,
          ADD COLUMN elevation_terrain_source     VARCHAR(64)  NULL,
          ADD COLUMN elevation_terrain_checked_at DATETIME     NULL,
          ADD COLUMN elevation_terrain_error      TEXT         NULL
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE submission_gisa
          DROP COLUMN elevation_terrain_grid_json,
          DROP COLUMN elevation_terrain_source,
          DROP COLUMN elevation_terrain_checked_at,
          DROP COLUMN elevation_terrain_error
        """
    )

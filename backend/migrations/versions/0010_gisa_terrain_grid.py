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

NOTE: ERIS treats database/init/010_schema.sql as the authoritative fresh-install
schema, so these columns are ALSO declared there. The fresh-install bootstrap is
init SQL -> `alembic stamp 0001_baseline` -> `alembic upgrade head`, which replays
this migration over a schema that already has the columns. To keep both the
fresh-init path and the existing-database upgrade path conflict-free, this
migration uses ADD COLUMN IF NOT EXISTS / DROP COLUMN IF EXISTS (MariaDB), so it
is a safe no-op when the columns already exist and still adds them to older DBs.
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
          ADD COLUMN IF NOT EXISTS elevation_terrain_grid_json  JSON         NULL,
          ADD COLUMN IF NOT EXISTS elevation_terrain_source     VARCHAR(64)  NULL,
          ADD COLUMN IF NOT EXISTS elevation_terrain_checked_at DATETIME     NULL,
          ADD COLUMN IF NOT EXISTS elevation_terrain_error      TEXT         NULL
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE submission_gisa
          DROP COLUMN IF EXISTS elevation_terrain_grid_json,
          DROP COLUMN IF EXISTS elevation_terrain_source,
          DROP COLUMN IF EXISTS elevation_terrain_checked_at,
          DROP COLUMN IF EXISTS elevation_terrain_error
        """
    )

"""add elevation profile columns to submission_gisa

Revision ID: 0007_gisa_elevation_profile
Revises: 0006_submission_gisa_ri_context
Create Date: 2026-06-10

Adds six nullable columns to submission_gisa so USGS 3DEP cross-section
elevation data can be persisted alongside each GISA draft.

  elevation_profile_json           -- full cross-section profile (JSON)
  elevation_profile_source         -- e.g. "USGS_EPQS_3DEP"
  elevation_profile_checked_at     -- when the profile was fetched
  elevation_profile_classification -- terrain shape: LEFT_HIGH/RIGHT_HIGH/BOWL/CROWN/FLAT/UNKNOWN
  elevation_profile_confidence     -- float 0-1, null when classification is UNKNOWN
  elevation_profile_error          -- error message if the fetch failed

These columns are write-once from the elevation-profile enrichment endpoint and
are intentionally not touched by the GISA PATCH endpoint.
"""

from alembic import op

revision = "0007_gisa_elevation_profile"
down_revision = "0006_submission_gisa_ri_context"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE submission_gisa
          ADD COLUMN elevation_profile_json           JSON         NULL,
          ADD COLUMN elevation_profile_source         VARCHAR(64)  NULL,
          ADD COLUMN elevation_profile_checked_at     DATETIME     NULL,
          ADD COLUMN elevation_profile_classification VARCHAR(32)  NULL,
          ADD COLUMN elevation_profile_confidence     FLOAT        NULL,
          ADD COLUMN elevation_profile_error          TEXT         NULL
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE submission_gisa
          DROP COLUMN elevation_profile_json,
          DROP COLUMN elevation_profile_source,
          DROP COLUMN elevation_profile_checked_at,
          DROP COLUMN elevation_profile_classification,
          DROP COLUMN elevation_profile_confidence,
          DROP COLUMN elevation_profile_error
    """)

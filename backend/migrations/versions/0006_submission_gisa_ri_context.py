"""add road inventory context columns to submission_gisa

Revision ID: 0006_submission_gisa_ri_context
Revises: 0005_incidents_ri_context
Create Date: 2026-06-10

Adds five nullable columns to submission_gisa so the road inventory segment
matched during incident creation flows into the GISA draft and powers the
measurement diagram on mobile and web.

  road_inventory_dataset_version_id  -- FK → road_inventory_datasets.id
  road_inventory_segment_id          -- FK → road_segments.id
  road_inventory_snapshot_json       -- compact JSON snapshot of the segment
  road_inventory_match_method        -- e.g. "MOBILE_OFFLINE"
  road_inventory_checked_at          -- when the lookup ran on the device

FK constraints use ON DELETE SET NULL so submission_gisa rows survive if road
inventory data is deleted or superseded.
"""

from alembic import op

revision = "0006_submission_gisa_ri_context"
down_revision = "0005_incidents_ri_context"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE submission_gisa
          ADD COLUMN road_inventory_dataset_version_id BIGINT UNSIGNED NULL,
          ADD COLUMN road_inventory_segment_id         BIGINT UNSIGNED NULL,
          ADD COLUMN road_inventory_snapshot_json      JSON            NULL,
          ADD COLUMN road_inventory_match_method       VARCHAR(32)     NULL,
          ADD COLUMN road_inventory_checked_at         DATETIME        NULL,
          ADD INDEX idx_submission_gisa_ri_dataset_version_id (road_inventory_dataset_version_id),
          ADD INDEX idx_submission_gisa_ri_segment_id (road_inventory_segment_id),
          ADD CONSTRAINT fk_submission_gisa_ri_dataset FOREIGN KEY (road_inventory_dataset_version_id)
            REFERENCES road_inventory_datasets(id) ON DELETE SET NULL,
          ADD CONSTRAINT fk_submission_gisa_ri_segment FOREIGN KEY (road_inventory_segment_id)
            REFERENCES road_segments(id) ON DELETE SET NULL
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE submission_gisa
          DROP FOREIGN KEY fk_submission_gisa_ri_dataset,
          DROP FOREIGN KEY fk_submission_gisa_ri_segment,
          DROP INDEX idx_submission_gisa_ri_dataset_version_id,
          DROP INDEX idx_submission_gisa_ri_segment_id,
          DROP COLUMN road_inventory_dataset_version_id,
          DROP COLUMN road_inventory_segment_id,
          DROP COLUMN road_inventory_snapshot_json,
          DROP COLUMN road_inventory_match_method,
          DROP COLUMN road_inventory_checked_at
    """)

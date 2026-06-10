"""add road inventory context columns to incidents

Revision ID: 0005_incidents_ri_context
Revises: 0004_ri_packages_json_gz
Create Date: 2026-06-09

Adds five nullable columns to incidents so field workers can persist the
offline road inventory segment that was matched during incident creation:

  road_inventory_dataset_version_id  -- FK → road_inventory_datasets.id
  road_inventory_segment_id          -- FK → road_segments.id
  road_inventory_snapshot_json       -- compact JSON snapshot of the segment
  road_inventory_match_method        -- e.g. "MOBILE_OFFLINE"
  road_inventory_checked_at          -- when the lookup ran on the device

FK constraints use ON DELETE SET NULL so incident records survive if road
inventory data is deleted or superseded.
"""

from alembic import op

revision = "0005_incidents_ri_context"
down_revision = "0004_ri_packages_json_gz"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE incidents
          ADD COLUMN road_inventory_dataset_version_id BIGINT UNSIGNED NULL,
          ADD COLUMN road_inventory_segment_id         BIGINT UNSIGNED NULL,
          ADD COLUMN road_inventory_snapshot_json      JSON            NULL,
          ADD COLUMN road_inventory_match_method       VARCHAR(32)     NULL,
          ADD COLUMN road_inventory_checked_at         DATETIME        NULL,
          ADD INDEX idx_incidents_ri_dataset_version_id (road_inventory_dataset_version_id),
          ADD INDEX idx_incidents_ri_segment_id (road_inventory_segment_id),
          ADD CONSTRAINT fk_incidents_ri_dataset FOREIGN KEY (road_inventory_dataset_version_id)
            REFERENCES road_inventory_datasets(id) ON DELETE SET NULL,
          ADD CONSTRAINT fk_incidents_ri_segment FOREIGN KEY (road_inventory_segment_id)
            REFERENCES road_segments(id) ON DELETE SET NULL
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE incidents
          DROP FOREIGN KEY fk_incidents_ri_dataset,
          DROP FOREIGN KEY fk_incidents_ri_segment,
          DROP INDEX idx_incidents_ri_dataset_version_id,
          DROP INDEX idx_incidents_ri_segment_id,
          DROP COLUMN road_inventory_dataset_version_id,
          DROP COLUMN road_inventory_segment_id,
          DROP COLUMN road_inventory_snapshot_json,
          DROP COLUMN road_inventory_match_method,
          DROP COLUMN road_inventory_checked_at
    """)

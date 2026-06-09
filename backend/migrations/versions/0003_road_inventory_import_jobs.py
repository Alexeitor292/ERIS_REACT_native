"""add road_inventory_import_jobs table

Revision ID: 0003_road_inventory_import_jobs
Revises: 0002_road_inventory
Create Date: 2026-06-09

Adds a single table that tracks async Excel import jobs.  The import flow
stores the raw Excel in MinIO immediately and returns HTTP 202, then a
background thread parses the file and inserts road_segments rows.

Lifecycle:  queued → processing → succeeded | failed
Stages within processing: storing, parsing, importing, succeeded/failed
"""

from alembic import op
import sqlalchemy as sa

revision = "0003_road_inventory_import_jobs"
down_revision = "0002_road_inventory"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS road_inventory_import_jobs (
            id                      BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
            job_uuid                CHAR(36)         NOT NULL,
            status                  ENUM('queued','processing','succeeded','failed')
                                                     NOT NULL DEFAULT 'queued',
            stage                   VARCHAR(64)      NOT NULL DEFAULT 'queued',
            message                 VARCHAR(512)     NULL,
            upload_filename         VARCHAR(512)     NOT NULL,
            requested_version_tag   VARCHAR(64)      NULL,
            storage_key             VARCHAR(512)     NULL,
            file_size_bytes         BIGINT UNSIGNED  NULL,
            dataset_version_id      BIGINT UNSIGNED  NULL,
            row_count               INT UNSIGNED     NOT NULL DEFAULT 0,
            skipped_count           INT UNSIGNED     NOT NULL DEFAULT 0,
            warnings_json           JSON             NULL,
            error_message           TEXT             NULL,
            created_by              BIGINT UNSIGNED  NOT NULL,
            created_at              DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
            started_at              DATETIME         NULL,
            finished_at             DATETIME         NULL,
            updated_at              DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP
                                                     ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_rij_uuid (job_uuid),
            INDEX idx_rij_status (status),
            INDEX idx_rij_created (created_at),
            INDEX idx_rij_dataset (dataset_version_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS road_inventory_import_jobs")

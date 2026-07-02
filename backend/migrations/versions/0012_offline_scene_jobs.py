"""offline 3D scene-package generation jobs

Revision ID: 0012_offline_scene_jobs
Revises: 0011_offline_scene_packages
Create Date: 2026-06-27

Durable job model for the AUTOMATIC offline 3D package-generation pipeline. An
authorized user requests a bounded package; ERIS queues a job; a separate worker
fetches USGS 3DEP terrain, builds + validates a bounded offline package, uploads
it to private MinIO, and registers it in the catalog (offline_scene_packages).
No manual ArcGIS Pro authoring is involved.

Also adds package_format to the catalog so the auto-generated ERIS terrain bundle
('eristerrain') and an Esri '.mspk' can coexist.

NOTE: ERIS treats database/init/010_schema.sql as authoritative; this table +
column are ALSO declared there. CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT
EXISTS keep the fresh-init and upgrade paths conflict-free.
"""

from alembic import op

revision = "0012_offline_scene_jobs"
down_revision = "0011_offline_scene_packages"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE offline_scene_packages
          ADD COLUMN IF NOT EXISTS package_format VARCHAR(32) NOT NULL DEFAULT 'mspk'
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS offline_scene_jobs (
            id BIGINT NOT NULL AUTO_INCREMENT,
            submission_id BIGINT NOT NULL,
            requested_by BIGINT NULL,
            status VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
            progress_pct INT NOT NULL DEFAULT 0,
            status_message VARCHAR(255) NULL,
            center_lat DOUBLE NULL,
            center_lon DOUBLE NULL,
            radius_m DOUBLE NULL,
            min_lat DOUBLE NULL,
            min_lon DOUBLE NULL,
            max_lat DOUBLE NULL,
            max_lon DOUBLE NULL,
            retry_count INT NOT NULL DEFAULT 0,
            error_details TEXT NULL,
            result_package_id BIGINT NULL,
            result_package_version VARCHAR(64) NULL,
            usgs_source_metadata JSON NULL,
            basemap_source_metadata JSON NULL,
            worker_id VARCHAR(64) NULL,
            worker_log_ref VARCHAR(255) NULL,
            claimed_at DATETIME NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            CONSTRAINT fk_osj_submission
              FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
            CONSTRAINT fk_osj_requested_by
              FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL,
            INDEX idx_osj_submission_status (submission_id, status),
            INDEX idx_osj_status (status),
            CONSTRAINT chk_osj_status CHECK (status IN (
              'QUEUED','FETCHING_USGS_3DEP','BUILDING_TERRAIN','BUILDING_BASEMAP',
              'PACKAGING','VERIFYING','UPLOADING','REGISTERING','READY','FAILED','CANCELLED'
            ))
        ) ENGINE=InnoDB
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS offline_scene_jobs")
    op.execute("ALTER TABLE offline_scene_packages DROP COLUMN IF EXISTS package_format")

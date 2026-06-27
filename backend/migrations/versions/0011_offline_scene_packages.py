"""offline 3D scene-package catalog

Revision ID: 0011_offline_scene_packages
Revises: 0010_gisa_terrain_grid
Create Date: 2026-06-27

Authoritative catalog of operator-authored, MinIO-stored Mobile Scene Packages
(.mspk) for the mobile native 3D terrain viewer. A submission is offline-available
ONLY when a READY row here exists AND its MinIO object is present with matching
size. Objects are immutable; a replacement is a NEW package_version and the prior
READY row is RETIRED (kept for audit).

NOTE: ERIS treats database/init/010_schema.sql as the authoritative fresh-install
schema, so this table is ALSO declared there. The fresh-install bootstrap is
init SQL -> `alembic stamp 0001_baseline` -> `alembic upgrade head`, which replays
this migration over a schema that already has the table. CREATE TABLE IF NOT
EXISTS keeps both the fresh-init path and the existing-database upgrade path
conflict-free.
"""

from alembic import op

revision = "0011_offline_scene_packages"
down_revision = "0010_gisa_terrain_grid"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS offline_scene_packages (
            id BIGINT NOT NULL AUTO_INCREMENT,
            submission_id BIGINT NOT NULL,
            status VARCHAR(16) NOT NULL DEFAULT 'READY',
            package_version VARCHAR(64) NOT NULL,
            minio_bucket VARCHAR(128) NOT NULL,
            object_key VARCHAR(512) NOT NULL,
            sha256 CHAR(64) NOT NULL,
            size_bytes BIGINT NOT NULL,
            object_version_id VARCHAR(128) NULL,
            object_etag VARCHAR(128) NULL,
            min_lat DOUBLE NOT NULL,
            min_lon DOUBLE NOT NULL,
            max_lat DOUBLE NOT NULL,
            max_lon DOUBLE NOT NULL,
            center_lat DOUBLE NOT NULL,
            center_lon DOUBLE NOT NULL,
            radius_m DOUBLE NOT NULL,
            elevation_source VARCHAR(64) NOT NULL DEFAULT 'USGS_3DEP',
            elevation_dataset VARCHAR(128) NULL,
            elevation_version VARCHAR(64) NULL,
            elevation_resolution VARCHAR(64) NULL,
            basemap_or_imagery_source VARCHAR(255) NULL,
            content_signature VARCHAR(64) NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            uploaded_at DATETIME NULL,
            uploaded_by BIGINT NULL,
            retired_at DATETIME NULL,
            notes TEXT NULL,
            PRIMARY KEY (id),
            CONSTRAINT uq_osp_submission_version UNIQUE (submission_id, package_version),
            CONSTRAINT uq_osp_object_key UNIQUE (object_key),
            CONSTRAINT fk_osp_submission
              FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
            CONSTRAINT fk_osp_uploaded_by
              FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL,
            INDEX idx_osp_submission_status (submission_id, status),
            CONSTRAINT chk_osp_status
              CHECK (status IN ('READY', 'RETIRED', 'FAILED'))
        ) ENGINE=InnoDB
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS offline_scene_packages")

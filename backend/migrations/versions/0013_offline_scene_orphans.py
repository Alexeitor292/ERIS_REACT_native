"""offline 3D scene-package orphaned-object audit

Revision ID: 0013_offline_scene_orphans
Revises: 0012_offline_scene_jobs
Create Date: 2026-06-28

Audit trail for immutable MinIO objects that were uploaded but intentionally NOT
registered as a READY package — e.g. a generation job was CANCELLED between the
object upload and catalog registration. Such objects are never referenced by a
READY catalog row (so ERIS never presents them as downloadable); operators
reconcile/clean them up out-of-band, respecting MinIO retention/versioning.

NOTE: ERIS treats database/init/010_schema.sql as authoritative; this table is
ALSO declared there. CREATE TABLE IF NOT EXISTS keeps fresh-init and upgrade
paths conflict-free.
"""

from alembic import op

revision = "0013_offline_scene_orphans"
down_revision = "0012_offline_scene_jobs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS offline_scene_orphaned_objects (
            id BIGINT NOT NULL AUTO_INCREMENT,
            submission_id BIGINT NOT NULL,
            job_id BIGINT NULL,
            minio_bucket VARCHAR(255) NOT NULL,
            object_key VARCHAR(1024) NOT NULL,
            sha256 CHAR(64) NULL,
            size_bytes BIGINT NULL,
            reason VARCHAR(255) NOT NULL DEFAULT 'cancelled_before_registration',
            resolved TINYINT(1) NOT NULL DEFAULT 0,
            resolved_by BIGINT NULL,
            resolution_notes VARCHAR(512) NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            resolved_at DATETIME NULL,
            PRIMARY KEY (id),
            INDEX idx_osoo_submission (submission_id),
            INDEX idx_osoo_resolved (resolved),
            INDEX idx_osoo_job (job_id)
        ) ENGINE=InnoDB
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS offline_scene_orphaned_objects")

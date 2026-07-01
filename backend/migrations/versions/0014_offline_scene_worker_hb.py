"""offline 3D scene-package worker heartbeats

Revision ID: 0014_offline_scene_worker_hb
Revises: 0013_offline_scene_orphans
Create Date: 2026-06-28

Durable worker liveness signal: each worker upserts its heartbeat every poll, so
operations can see whether a worker is alive even when the queue is idle. Exposed
via the admin ops health endpoint.

NOTE: also declared in database/init/010_schema.sql (authoritative). CREATE TABLE
IF NOT EXISTS keeps fresh-init and upgrade paths conflict-free.
"""

from alembic import op

revision = "0014_offline_scene_worker_hb"
down_revision = "0013_offline_scene_orphans"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS offline_scene_worker_heartbeats (
            worker_id VARCHAR(64) NOT NULL,
            last_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            jobs_processed BIGINT NOT NULL DEFAULT 0,
            last_stage VARCHAR(48) NULL,
            PRIMARY KEY (worker_id),
            INDEX idx_oswh_last_seen (last_seen)
        ) ENGINE=InnoDB
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS offline_scene_worker_heartbeats")

"""Detach legacy one-Incident placeholders from provisional coordinator review.

Revision ID: 20260818_event_group_provisional_cleanup
Revises: 20260818_event_group_domain
Create Date: 2026-08-18
"""

from alembic import op

revision = "20260818_event_group_provisional_cleanup"
down_revision = "20260818_event_group_domain"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE incidents i
        JOIN event_groups eg ON eg.id = i.event_group_id
        SET i.event_group_id = NULL,
            i.project_id = NULL,
            i.updated_at = i.updated_at
        WHERE i.current_stage = 'COORDINATOR_REVIEW'
          AND i.incident_key IS NULL
          AND eg.source = 'LEGACY_BACKFILL'
        """
    )
    op.execute(
        """
        UPDATE event_groups eg
        SET eg.status = 'ARCHIVED', eg.updated_at = NOW()
        WHERE eg.source = 'LEGACY_BACKFILL'
          AND NOT EXISTS (
            SELECT 1 FROM incidents i WHERE i.event_group_id = eg.id
          )
        """
    )


def downgrade() -> None:
    # This correction deliberately does not guess a previous synthetic group for
    # a provisional Incident. Reconstructing that association would reintroduce
    # the parent-shaped semantics this migration removes.
    pass

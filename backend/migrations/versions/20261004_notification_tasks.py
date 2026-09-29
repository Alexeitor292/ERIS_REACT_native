"""Notifications that ask for a step know when the step is done.

Revision ID: 20261004_notification_tasks
Revises: 20261003_drone_surveys
Create Date: 2026-10-04

1. ``user_notifications`` gains ``incident_id``, ``assessment_id`` and
   ``task_state``: the report or assessment a notice is about, and — for a
   notice asking its reader to act — the state that step waits in. The feed
   compares it with the record now, so a notice whose step someone already
   took reads as done instead of as a to-do.
2. Existing rows are backfilled: the assessment from the notice's link, the
   incident from the assessment, the step from the kind of notice.
3. Notices open with the incident's name: the internal incident key that used
   to precede it is dropped from existing rows.

Idempotent: re-running changes nothing.
"""

from alembic import op
from sqlalchemy import text

revision = "20261004_notification_tasks"
down_revision = "20261003_drone_surveys"
branch_labels = None
depends_on = None

# The kind of notice -> the state its step waits in (the same map as services/notification_feed.py).
_TASK_STATES = {
    "INCIDENT_COORDINATOR_REVIEW": "COORDINATOR_REVIEW",
    "INCIDENT_OFFICE_CHIEF_REVIEW": "PENDING_OFFICE_DELEGATION",
    "ASSESSMENT_OFFICE_DELEGATION": "PENDING_OFFICE_DELEGATION",
    "ASSESSMENT_BRANCH_DELEGATION": "PENDING_ENGINEER_ASSIGNMENT",
    "ASSESSMENT_SENIOR_ENGINEER_ASSIGNMENT": "DRAFT",
    "ASSESSMENT_STAFF_ASSIGNMENT": "DRAFT",
    "ASSESSMENT_SUBMITTED_FOR_REVIEW": "SUBMITTED",
    "ASSESSMENT_REVISION_REQUESTED": "REVISION_REQUESTED",
}

_UUID_PREFIX = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12} · "


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        text(
            """
            ALTER TABLE user_notifications
              ADD COLUMN IF NOT EXISTS incident_id BIGINT NULL AFTER link,
              ADD COLUMN IF NOT EXISTS assessment_id BIGINT NULL AFTER incident_id,
              ADD COLUMN IF NOT EXISTS task_state VARCHAR(40) NULL AFTER assessment_id,
              ADD INDEX IF NOT EXISTS idx_user_notification_assessment (assessment_id)
            """
        )
    )
    bind.execute(
        text(
            """
            UPDATE user_notifications
               SET assessment_id = CAST(SUBSTRING_INDEX(link, '=', -1) AS UNSIGNED)
             WHERE assessment_id IS NULL AND link REGEXP '^/my-work\\\\?assessment=[0-9]+$'
            """
        )
    )
    bind.execute(
        text(
            """
            UPDATE user_notifications
               SET assessment_id = CAST(SUBSTRING_INDEX(link, '/', -1) AS UNSIGNED)
             WHERE assessment_id IS NULL AND link REGEXP '^/assessments/[0-9]+$'
            """
        )
    )
    bind.execute(
        text(
            """
            UPDATE user_notifications n JOIN assessments a ON a.id = n.assessment_id
               SET n.incident_id = a.incident_id
             WHERE n.incident_id IS NULL
            """
        )
    )
    for kind, state in _TASK_STATES.items():
        bind.execute(
            text("UPDATE user_notifications SET task_state = :state WHERE kind = :kind AND task_state IS NULL"),
            {"kind": kind, "state": state},
        )
    bind.execute(
        text("UPDATE user_notifications SET body = REGEXP_REPLACE(body, :prefix, '') WHERE body REGEXP :prefix"),
        {"prefix": _UUID_PREFIX},
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        text(
            """
            ALTER TABLE user_notifications
              DROP INDEX IF EXISTS idx_user_notification_assessment,
              DROP COLUMN IF EXISTS task_state,
              DROP COLUMN IF EXISTS assessment_id,
              DROP COLUMN IF EXISTS incident_id
            """
        )
    )

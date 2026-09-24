"""The notification feed, on the web and on the phone.

Revision ID: 20261001_notification_feed
Revises: 20260930_roles_from_org
Create Date: 2026-10-01

1. ``user_notifications``: one row per person per event — what they were told,
   where it leads (``link``, a web path the mobile app maps to its screens),
   when they read it, and whether it was pushed to their phone
   (``push_state``: NULL not yet, SENT, NONE for nobody's phone, FAILED).
2. ``push_devices``: the phones a person signed in to the ERIS app on, by their
   Expo push token.

Idempotent: re-running changes nothing.
"""

from alembic import op
from sqlalchemy import text

revision = "20261001_notification_feed"
down_revision = "20260930_roles_from_org"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS user_notifications (
              id BIGINT PRIMARY KEY AUTO_INCREMENT,
              user_id BIGINT NOT NULL,
              kind VARCHAR(48) NOT NULL,
              title VARCHAR(255) NOT NULL,
              body VARCHAR(1000) NULL,
              link VARCHAR(255) NULL,
              actor_user_id BIGINT NULL,
              created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              read_at DATETIME NULL,
              push_state VARCHAR(12) NULL,
              CONSTRAINT fk_user_notification_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
              CONSTRAINT fk_user_notification_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
              INDEX idx_user_notification_feed (user_id, id),
              INDEX idx_user_notification_unread (user_id, read_at),
              INDEX idx_user_notification_push (push_state, created_at),
              CONSTRAINT chk_user_notification_push CHECK (push_state IS NULL OR push_state IN ('SENT', 'NONE', 'FAILED'))
            ) ENGINE=InnoDB
            """
        )
    )
    bind.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS push_devices (
              id BIGINT PRIMARY KEY AUTO_INCREMENT,
              user_id BIGINT NOT NULL,
              token VARCHAR(255) NOT NULL,
              platform VARCHAR(16) NULL,
              is_active TINYINT NOT NULL DEFAULT 1,
              created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              CONSTRAINT fk_push_device_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
              UNIQUE KEY uq_push_device_token (token),
              INDEX idx_push_device_user (user_id, is_active)
            ) ENGINE=InnoDB
            """
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("DROP TABLE IF EXISTS push_devices"))
    bind.execute(text("DROP TABLE IF EXISTS user_notifications"))

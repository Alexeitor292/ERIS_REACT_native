"""Several people in one technical form: a revision per form, and who is where.

Revision ID: 20261006_form_presence
Revises: 20261005_survey_baseline_codes
Create Date: 2026-10-06

1. ``submission_gisa.revision``: counts the form's saves. A page that opened
   the form at one revision knows when someone else has saved since.
2. ``submission_presence``: one row per open copy of a form (a browser tab):
   who it is, the card and field they are in, and the memos they are writing
   (a memo being written is locked for everyone else). Rows not refreshed for
   45 seconds are ignored and old ones are cleared as people come and go.

Idempotent: re-running changes nothing.
"""

from alembic import op
from sqlalchemy import text

revision = "20261006_form_presence"
down_revision = "20261005_survey_baseline_codes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        text(
            """
            ALTER TABLE submission_gisa
              ADD COLUMN IF NOT EXISTS revision INT NOT NULL DEFAULT 0 AFTER updated_by_user_id
            """
        )
    )
    bind.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS submission_presence (
              submission_id BIGINT NOT NULL,
              session_id VARCHAR(64) NOT NULL,
              user_id BIGINT NOT NULL,
              area VARCHAR(96) NULL,
              field VARCHAR(160) NULL,
              memo_keys VARCHAR(255) NULL,
              memo_active_at DATETIME NULL,
              seen_at DATETIME NOT NULL,
              PRIMARY KEY (submission_id, session_id),
              INDEX idx_submission_presence_seen (submission_id, seen_at),
              CONSTRAINT fk_submission_presence_submission FOREIGN KEY (submission_id)
                REFERENCES submissions(id) ON DELETE CASCADE,
              CONSTRAINT fk_submission_presence_user FOREIGN KEY (user_id)
                REFERENCES users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
            """
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("DROP TABLE IF EXISTS submission_presence"))
    bind.execute(text("ALTER TABLE submission_gisa DROP COLUMN IF EXISTS revision"))

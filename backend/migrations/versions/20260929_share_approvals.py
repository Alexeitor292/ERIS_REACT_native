"""Sharing a technical form goes through the branch and office chiefs.

Revision ID: 20260929_share_approvals
Revises: 20260928_incident_groups
Create Date: 2026-09-29

A share gives viewing and editing. Branch chiefs approve anything going into or
out of their branch (a share inside one branch goes through, and its chief is
told); office chiefs are told when a share leaves their office or involves one
of their Senior Specialists, and may stop it (services/share_rules.py).

1. ``submission_shares``: one request to share a form with one person, and
   where it stands: PENDING (waiting on an approval), ACTIVE (granted),
   REJECTED (refused before it took effect), REVOKED (stopped after), or
   CANCELLED (withdrawn by the sharer before it took effect).
2. ``submission_share_reviews``: each branch or office that has a say, and its
   decision. APPROVAL reviews must all be APPROVED before the share is granted;
   NOTICE reviews are told, and are ACKNOWLEDGED or REJECTED (which stops it).

While a share is ACTIVE the person holds the form's reader and editor grants
(``submission_visibility`` and ``submission_editors``). Grants made before this
revision stay as they were.

Idempotent: re-running changes nothing.
"""

from alembic import op
from sqlalchemy import text

revision = "20260929_share_approvals"
down_revision = "20260928_incident_groups"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS submission_shares (
              id BIGINT PRIMARY KEY AUTO_INCREMENT,
              submission_id BIGINT NOT NULL,
              sharer_user_id BIGINT NOT NULL,
              recipient_user_id BIGINT NOT NULL,
              status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
              created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              activated_at DATETIME NULL,
              ended_at DATETIME NULL,
              ended_by_user_id BIGINT NULL,
              end_note VARCHAR(1000) NULL,
              CONSTRAINT fk_share_submission FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
              CONSTRAINT fk_share_sharer FOREIGN KEY (sharer_user_id) REFERENCES users(id) ON DELETE RESTRICT,
              CONSTRAINT fk_share_recipient FOREIGN KEY (recipient_user_id) REFERENCES users(id) ON DELETE CASCADE,
              CONSTRAINT fk_share_ended_by FOREIGN KEY (ended_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
              INDEX idx_share_submission (submission_id, status),
              INDEX idx_share_recipient (recipient_user_id, status),
              CONSTRAINT chk_share_status CHECK (status IN ('PENDING', 'ACTIVE', 'REJECTED', 'REVOKED', 'CANCELLED'))
            ) ENGINE=InnoDB
            """
        )
    )
    bind.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS submission_share_reviews (
              id BIGINT PRIMARY KEY AUTO_INCREMENT,
              share_id BIGINT NOT NULL,
              unit_type VARCHAR(8) NOT NULL,
              unit_id BIGINT NOT NULL,
              kind VARCHAR(8) NOT NULL,
              decision VARCHAR(16) NOT NULL DEFAULT 'PENDING',
              decided_by_user_id BIGINT NULL,
              decided_at DATETIME NULL,
              note VARCHAR(1000) NULL,
              created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              CONSTRAINT fk_share_review_share FOREIGN KEY (share_id) REFERENCES submission_shares(id) ON DELETE CASCADE,
              CONSTRAINT fk_share_review_decider FOREIGN KEY (decided_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
              UNIQUE KEY uq_share_review_unit (share_id, unit_type, unit_id),
              INDEX idx_share_review_unit (unit_type, unit_id, decision),
              CONSTRAINT chk_share_review_unit CHECK (unit_type IN ('BRANCH', 'OFFICE')),
              CONSTRAINT chk_share_review_kind CHECK (kind IN ('APPROVAL', 'NOTICE')),
              CONSTRAINT chk_share_review_decision CHECK (decision IN ('PENDING', 'APPROVED', 'REJECTED', 'ACKNOWLEDGED'))
            ) ENGINE=InnoDB
            """
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("DROP TABLE IF EXISTS submission_share_reviews"))
    bind.execute(text("DROP TABLE IF EXISTS submission_shares"))

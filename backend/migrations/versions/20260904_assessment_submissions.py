"""Assessment ↔ technical submissions join table.

Revision ID: 20260904_assessment_subs
Revises: 20260818_xsection_projects
Create Date: 2026-09-04

An incident's assessment can carry more than one technical submission (for
example the original GISA form plus a supplemental form written after a
revision request). ``assessments.submission_id`` is kept as the *latest* /
primary submission for backward compatibility; ``assessment_submissions`` is
the authoritative many-to-one link that the API exposes as
``submission_ids[]``.

Idempotent overlay: safe to re-run over a database that already has the table
and backfilled rows.
"""

from alembic import op

revision = "20260904_assessment_subs"
down_revision = "20260818_xsection_projects"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS assessment_submissions (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            assessment_id BIGINT NOT NULL,
            submission_id BIGINT NOT NULL,
            created_by_user_id BIGINT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

            CONSTRAINT fk_assessment_subs_assessment FOREIGN KEY (assessment_id)
              REFERENCES assessments(id) ON DELETE CASCADE,
            CONSTRAINT fk_assessment_subs_submission FOREIGN KEY (submission_id)
              REFERENCES submissions(id) ON DELETE CASCADE,
            CONSTRAINT fk_assessment_subs_created_by FOREIGN KEY (created_by_user_id)
              REFERENCES users(id) ON DELETE SET NULL,

            UNIQUE KEY uk_assessment_subs_submission (submission_id),
            INDEX idx_assessment_subs_assessment (assessment_id, id)
        ) ENGINE=InnoDB
        """
    )

    # Backfill: the single legacy link on the assessment row.
    op.execute(
        """
        INSERT INTO assessment_submissions (assessment_id, submission_id, created_by_user_id, created_at)
        SELECT a.id, a.submission_id, a.created_by_user_id, a.created_at
        FROM assessments a
        WHERE a.submission_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM assessment_submissions s WHERE s.submission_id = a.submission_id
          )
        """
    )

    # Backfill: incidents whose primary linked submission predates the
    # assessment row (legacy engineer-assignment path).
    op.execute(
        """
        INSERT INTO assessment_submissions (assessment_id, submission_id, created_by_user_id, created_at)
        SELECT a.id, isl.submission_id, isl.linked_by_user_id, isl.created_at
        FROM assessments a
        JOIN incident_submission_links isl ON isl.incident_id = a.incident_id
        WHERE NOT EXISTS (
          SELECT 1 FROM assessment_submissions s WHERE s.submission_id = isl.submission_id
        )
        """
    )

    # Keep the denormalized latest-submission pointer honest for legacy rows.
    op.execute(
        """
        UPDATE assessments a
        JOIN incident_submission_links isl ON isl.incident_id = a.incident_id
        SET a.submission_id = isl.submission_id
        WHERE a.submission_id IS NULL
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS assessment_submissions")

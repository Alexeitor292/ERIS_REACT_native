"""Formatted memos on the GISA form.

Revision ID: 20260925_gisa_rich_memos
Revises: 20260924_user_saved_layouts
Create Date: 2026-09-25

Observations, Geotechnical assessment, Recommendations and Sketch notes become
formatted documents in the web app. Each gains a ``<field>_html`` column for the
sanitized document; the existing plain-text column stays and is rewritten from
it on every save, so the GISA PDF and the mobile app keep working unchanged.
Idempotent: a fresh install already has the columns from 010_schema.sql.
"""

from alembic import op
from sqlalchemy import text

revision = "20260925_gisa_rich_memos"
down_revision = "20260924_user_saved_layouts"
branch_labels = None
depends_on = None

COLUMNS = (
    "observations_notes_html",
    "geotechnical_assessment_notes_html",
    "recommendations_notes_html",
    "sketchpad_notes_html",
)


def _has_column(column: str) -> bool:
    return bool(
        op.get_bind().execute(
            text(
                "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() "
                "AND TABLE_NAME = 'submission_gisa' AND COLUMN_NAME = :c"
            ),
            {"c": column},
        ).scalar()
    )


def upgrade() -> None:
    for column in COLUMNS:
        if not _has_column(column):
            op.execute(f"ALTER TABLE submission_gisa ADD COLUMN {column} MEDIUMTEXT NULL")


def downgrade() -> None:
    for column in COLUMNS:
        if _has_column(column):
            op.execute(f"ALTER TABLE submission_gisa DROP COLUMN {column}")

"""Event Groups are now called Incident Groups.

Revision ID: 20260928_incident_groups
Revises: 20260927_incident_names
Create Date: 2026-09-28

Only the words people read change: group titles that ERIS generated (or that
somebody typed) with "Event Group" in them now say "Incident Group". Tables,
columns and API paths keep their event_group names, and history notes are left
as they were written.

Idempotent: re-running changes nothing.
"""

from alembic import op
from sqlalchemy import text

revision = "20260928_incident_groups"
down_revision = "20260927_incident_names"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.get_bind().execute(
        text(
            "UPDATE event_groups SET title = REPLACE(title, 'Event Group', 'Incident Group') "
            "WHERE title LIKE BINARY '%Event Group%'"
        )
    )


def downgrade() -> None:
    op.get_bind().execute(
        text(
            "UPDATE event_groups SET title = REPLACE(title, 'Incident Group', 'Event Group') "
            "WHERE title LIKE BINARY '%Incident Group%'"
        )
    )

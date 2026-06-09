"""baseline

Revision ID: 0001_baseline
Revises:
Create Date: 2026-06-08

Schema baseline for ERIS.

This revision corresponds to the schema defined in
database/init/010_schema.sql as of git commit ce447ab
("Add GISA material fields, pavement annotations, and staged uploads").

The 19 tables established by that init SQL are:

  Identity:    users, roles, user_roles
  Submission:  submissions, workflow_events,
               submission_visibility, submission_editors
  Attachment:  attachments, attachment_links
  Incident:    incident_locations, incidents, incident_attachments,
               incident_assignments, incident_routing_assignments,
               incident_notifications, incident_submission_links
  GISA:        submission_gisa, submission_gisa_incident_types,
               submission_gisa_actions

This migration intentionally contains NO DDL. It is a checkpoint only.

--- STAMPING EXISTING DATABASES ---

Existing databases (local dev, Proxmox) should be stamped to this revision
ONCE, after the backend has been started at least once on that database
(so the runtime compatibility shims in main.py and
ensure_incident_runtime_schema() have been applied and the schema matches
010_schema.sql). Stamping does not alter the schema.

From backend/ directory:
  alembic stamp 0001_baseline
  alembic current               # should show: 0001_baseline (head)

See docs/MIGRATIONS.md for full procedures.

--- FUTURE CHANGES ---

All schema changes after this baseline must be made as new Alembic
revisions. Do NOT add new columns to database/init/010_schema.sql;
that file represents the state at this baseline only.

To create a new migration:
  alembic revision -m "add_column_foo_to_bar"
"""

from alembic import op  # noqa: F401 — imported for consistency with future migrations

# revision identifiers, used by Alembic.
revision = "0001_baseline"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # No DDL. Schema is established by database/init/010_schema.sql.
    pass


def downgrade() -> None:
    # No DDL to reverse.
    pass

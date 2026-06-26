"""incident triage decision fields

Revision ID: 0009_incident_triage_fields
Revises: 0008_assessment_domain
Create Date: 2026-06-25

Adds dedicated, first-class triage columns to `incidents` so a coordinator's
triage disposition is recorded WITHOUT overwriting the location-review JSON in
`location_match_metadata` (which the reporter-revision/location-link flows own).

  triage_disposition          ASSESSMENT_REQUIRED | NO_ASSESSMENT_REQUIRED
                              | NEEDS_REPORTER_INFORMATION | DUPLICATE_OR_LINKED
  triage_decided_by_user_id   coordinator/admin who made the decision
  triage_decided_at           when the decision was made
  triage_notes                free-text decision notes
  duplicate_of_incident_id    DUPLICATE_OR_LINKED: linked-to incident (self FK)
  duplicate_of_location_id    DUPLICATE_OR_LINKED: linked-to location

All columns are nullable and additive; FKs use ON DELETE SET NULL so triaged
incidents survive deletion of the linked target. No existing column is changed.
"""

from alembic import op

revision = "0009_incident_triage_fields"
down_revision = "0008_assessment_domain"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE incidents
          ADD COLUMN triage_disposition        VARCHAR(32) NULL,
          ADD COLUMN triage_decided_by_user_id BIGINT      NULL,
          ADD COLUMN triage_decided_at         DATETIME    NULL,
          ADD COLUMN triage_notes              TEXT        NULL,
          ADD COLUMN duplicate_of_incident_id  BIGINT      NULL,
          ADD COLUMN duplicate_of_location_id  BIGINT      NULL,
          ADD INDEX idx_incidents_triage_disposition (triage_disposition),
          ADD CONSTRAINT fk_incidents_triage_decided_by
            FOREIGN KEY (triage_decided_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
          ADD CONSTRAINT fk_incidents_duplicate_of_incident
            FOREIGN KEY (duplicate_of_incident_id) REFERENCES incidents(id) ON DELETE SET NULL,
          ADD CONSTRAINT fk_incidents_duplicate_of_location
            FOREIGN KEY (duplicate_of_location_id) REFERENCES incident_locations(id) ON DELETE SET NULL,
          ADD CONSTRAINT chk_incidents_triage_disposition
            CHECK (triage_disposition IS NULL OR triage_disposition IN (
              'ASSESSMENT_REQUIRED',
              'NO_ASSESSMENT_REQUIRED',
              'NEEDS_REPORTER_INFORMATION',
              'DUPLICATE_OR_LINKED'
            ))
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE incidents
          DROP CONSTRAINT chk_incidents_triage_disposition,
          DROP FOREIGN KEY fk_incidents_triage_decided_by,
          DROP FOREIGN KEY fk_incidents_duplicate_of_incident,
          DROP FOREIGN KEY fk_incidents_duplicate_of_location,
          DROP INDEX idx_incidents_triage_disposition,
          DROP COLUMN triage_disposition,
          DROP COLUMN triage_decided_by_user_id,
          DROP COLUMN triage_decided_at,
          DROP COLUMN triage_notes,
          DROP COLUMN duplicate_of_incident_id,
          DROP COLUMN duplicate_of_location_id
        """
    )

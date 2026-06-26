"""assessment routing and authority model

Revision ID: 0008_assessment_domain
Revises: 0007_gisa_elevation_profile
Create Date: 2026-06-25

Adds the additive Assessment domain layer on top of the existing
incident + GISA-backed submission model. Nothing in the legacy
`submissions` / `submission_gisa` schema is renamed or dropped — the
Assessment is a new relational wrapper around the existing technical form.

New tables
----------
  geotech_office_routing   District -> GeoTech Office routing (configurable,
                           replaces the hardcoded OFFICE_BY_DISTRICT map).
  assessments              One Assessment per incident: links the incident to
                           its technical submission, carries the destination
                           office, branch/engineer assignment, lifecycle state,
                           and decision timestamps.
  assessment_assignments   Assessment-level role assignments
                           (ENGINEER | REVIEWER | APPROVER | CONSULTED).
                           Review is an assessment-level assignment, NOT a
                           permanent global role.
  assessment_events        Append-only timeline of triage dispositions,
                           routing/delegation, assignment, and review events.

New organization roles (additive, backward compatible)
------------------------------------------------------
  MAINTENANCE_FIELD_WORKER, MAINTENANCE_COORDINATOR, GEOTECH_OFFICE_CHIEF,
  GEOTECH_BRANCH_CHIEF, GEOTECH_ENGINEER

Existing legacy roles (MAINTENANCE, MAINT_COORDINATOR, OFFICE_CHIEF,
BRANCH_CHIEF, FIELD_WORKER, REVIEWER, ADMIN) are left untouched. The
application maps the new canonical roles onto the legacy ones via
app/roles.py so existing user_role rows keep working. See
docs/assessment-routing-authority-model.md for the migration plan.
"""

from alembic import op

revision = "0008_assessment_domain"
down_revision = "0007_gisa_elevation_profile"
branch_labels = None
depends_on = None


# District -> GeoTech Office seed. Mirrors the legacy OFFICE_BY_DISTRICT map in
# routes/incidents.py so existing routing behaviour is preserved exactly, but is
# now data-backed and editable instead of hardcoded in a route handler.
_OFFICE_BY_DISTRICT = {
    "01": ("WEST", "West GeoTech Office"),
    "02": ("NORTH", "North GeoTech Office"),
    "03": ("NORTH", "North GeoTech Office"),
    "04": ("WEST", "West GeoTech Office"),
    "05": ("WEST", "West GeoTech Office"),
    "06": ("NORTH", "North GeoTech Office"),
    "07": ("SOUTH", "South GeoTech Office"),
    "08": ("SOUTH", "South GeoTech Office"),
    "09": ("NORTH", "North GeoTech Office"),
    "10": ("NORTH", "North GeoTech Office"),
    "11": ("SOUTH", "South GeoTech Office"),
    "12": ("SOUTH", "South GeoTech Office"),
}

_NEW_ROLES = [
    ("MAINTENANCE_FIELD_WORKER", "Maintenance field worker: creates and follows own incident reports"),
    ("MAINTENANCE_COORDINATOR", "Maintenance coordinator: triages incident reports and routes assessments"),
    ("GEOTECH_OFFICE_CHIEF", "GeoTech office chief: delegates assessments to branch chiefs"),
    ("GEOTECH_BRANCH_CHIEF", "GeoTech branch chief: assigns engineers to assessments"),
    ("GEOTECH_ENGINEER", "GeoTech engineer: completes assessments / technical form"),
]


def upgrade() -> None:
    # --- District -> GeoTech Office routing ---------------------------------
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS geotech_office_routing (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            district VARCHAR(8) NOT NULL,
            office_code VARCHAR(16) NOT NULL,
            office_name VARCHAR(128) NULL,
            is_active TINYINT NOT NULL DEFAULT 1,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uk_geotech_routing_district (district),
            INDEX idx_geotech_routing_office (office_code, is_active)
        ) ENGINE=InnoDB
        """
    )
    for district, (office_code, office_name) in _OFFICE_BY_DISTRICT.items():
        op.execute(
            """
            INSERT INTO geotech_office_routing (district, office_code, office_name)
            VALUES ('%s', '%s', '%s')
            ON DUPLICATE KEY UPDATE
              office_code = VALUES(office_code),
              office_name = VALUES(office_name)
            """
            % (district, office_code, office_name)
        )

    # --- Assessments --------------------------------------------------------
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS assessments (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            assessment_uuid VARCHAR(64) NOT NULL UNIQUE,
            incident_id BIGINT NOT NULL,
            submission_id BIGINT NULL,
            district VARCHAR(64) NULL,
            office_code VARCHAR(16) NULL,
            office_routed_from_district VARCHAR(8) NULL,
            office_override_reason TEXT NULL,
            branch_chief_user_id BIGINT NULL,
            assigned_engineer_user_id BIGINT NULL,
            state VARCHAR(32) NOT NULL DEFAULT 'PENDING_OFFICE_DELEGATION',
            triage_disposition VARCHAR(32) NULL,
            notes TEXT NULL,
            created_by_user_id BIGINT NOT NULL,
            office_delegated_at DATETIME NULL,
            engineer_assigned_at DATETIME NULL,
            submitted_at DATETIME NULL,
            review_requested_at DATETIME NULL,
            approved_at DATETIME NULL,
            finalized_at DATETIME NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

            CONSTRAINT fk_assessment_incident FOREIGN KEY (incident_id)
              REFERENCES incidents(id) ON DELETE CASCADE,
            CONSTRAINT fk_assessment_submission FOREIGN KEY (submission_id)
              REFERENCES submissions(id) ON DELETE SET NULL,
            CONSTRAINT fk_assessment_branch_chief FOREIGN KEY (branch_chief_user_id)
              REFERENCES users(id) ON DELETE SET NULL,
            CONSTRAINT fk_assessment_engineer FOREIGN KEY (assigned_engineer_user_id)
              REFERENCES users(id) ON DELETE SET NULL,
            CONSTRAINT fk_assessment_created_by FOREIGN KEY (created_by_user_id)
              REFERENCES users(id) ON DELETE RESTRICT,

            UNIQUE KEY uk_assessment_incident (incident_id),
            INDEX idx_assessment_state (state),
            INDEX idx_assessment_office (office_code, state),
            INDEX idx_assessment_engineer (assigned_engineer_user_id, state),
            INDEX idx_assessment_branch_chief (branch_chief_user_id, state),
            INDEX idx_assessment_submission (submission_id),
            CONSTRAINT chk_assessment_state CHECK (state IN (
              'PENDING_OFFICE_DELEGATION',
              'PENDING_ENGINEER_ASSIGNMENT',
              'DRAFT',
              'SUBMITTED',
              'REVISION_REQUESTED',
              'APPROVED',
              'FINALIZED'
            )),
            CONSTRAINT chk_assessment_disposition CHECK (
              triage_disposition IS NULL OR triage_disposition IN (
                'ASSESSMENT_REQUIRED',
                'NO_ASSESSMENT_REQUIRED',
                'NEEDS_REPORTER_INFORMATION',
                'DUPLICATE_OR_LINKED'
              )
            )
        ) ENGINE=InnoDB
        """
    )

    # --- Assessment-level assignments (review is an assignment, not a role) --
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS assessment_assignments (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            assessment_id BIGINT NOT NULL,
            user_id BIGINT NOT NULL,
            assignment_role VARCHAR(16) NOT NULL,
            assigned_by_user_id BIGINT NOT NULL,
            is_active TINYINT NOT NULL DEFAULT 1,
            notes VARCHAR(255) NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

            CONSTRAINT fk_assessment_assign_assessment FOREIGN KEY (assessment_id)
              REFERENCES assessments(id) ON DELETE CASCADE,
            CONSTRAINT fk_assessment_assign_user FOREIGN KEY (user_id)
              REFERENCES users(id) ON DELETE CASCADE,
            CONSTRAINT fk_assessment_assign_assigned_by FOREIGN KEY (assigned_by_user_id)
              REFERENCES users(id) ON DELETE RESTRICT,

            INDEX idx_assessment_assign_lookup (assessment_id, assignment_role, is_active),
            INDEX idx_assessment_assign_user (user_id, is_active),
            CONSTRAINT chk_assessment_assign_role CHECK (
              assignment_role IN ('ENGINEER', 'REVIEWER', 'APPROVER', 'CONSULTED')
            )
        ) ENGINE=InnoDB
        """
    )

    # --- Append-only assessment / triage timeline ---------------------------
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS assessment_events (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            assessment_id BIGINT NULL,
            incident_id BIGINT NOT NULL,
            actor_user_id BIGINT NOT NULL,
            event_type VARCHAR(48) NOT NULL,
            disposition VARCHAR(32) NULL,
            from_state VARCHAR(32) NULL,
            to_state VARCHAR(32) NULL,
            notes TEXT NULL,
            target_incident_id BIGINT NULL,
            target_location_id BIGINT NULL,
            metadata_json JSON NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

            CONSTRAINT fk_assessment_event_incident FOREIGN KEY (incident_id)
              REFERENCES incidents(id) ON DELETE CASCADE,
            CONSTRAINT fk_assessment_event_assessment FOREIGN KEY (assessment_id)
              REFERENCES assessments(id) ON DELETE SET NULL,
            CONSTRAINT fk_assessment_event_actor FOREIGN KEY (actor_user_id)
              REFERENCES users(id) ON DELETE RESTRICT,
            CONSTRAINT fk_assessment_event_target_incident FOREIGN KEY (target_incident_id)
              REFERENCES incidents(id) ON DELETE SET NULL,
            CONSTRAINT fk_assessment_event_target_location FOREIGN KEY (target_location_id)
              REFERENCES incident_locations(id) ON DELETE SET NULL,

            INDEX idx_assessment_event_incident (incident_id, created_at),
            INDEX idx_assessment_event_assessment (assessment_id, created_at),
            CONSTRAINT chk_assessment_event_disposition CHECK (
              disposition IS NULL OR disposition IN (
                'ASSESSMENT_REQUIRED',
                'NO_ASSESSMENT_REQUIRED',
                'NEEDS_REPORTER_INFORMATION',
                'DUPLICATE_OR_LINKED'
              )
            )
        ) ENGINE=InnoDB
        """
    )

    # --- New canonical organization roles (additive) ------------------------
    for name, description in _NEW_ROLES:
        op.execute(
            """
            INSERT INTO roles (name, description)
            VALUES ('%s', '%s')
            ON DUPLICATE KEY UPDATE description = VALUES(description)
            """
            % (name, description.replace("'", "''"))
        )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS assessment_events")
    op.execute("DROP TABLE IF EXISTS assessment_assignments")
    op.execute("DROP TABLE IF EXISTS assessments")
    op.execute("DROP TABLE IF EXISTS geotech_office_routing")
    # New roles are additive; remove them on downgrade. user_roles rows that
    # reference them (if any were assigned) are removed via ON DELETE CASCADE.
    names = ", ".join("'%s'" % name for name, _ in _NEW_ROLES)
    op.execute("DELETE FROM roles WHERE name IN (%s)" % names)

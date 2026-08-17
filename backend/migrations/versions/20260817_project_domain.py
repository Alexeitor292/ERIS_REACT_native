"""Add Project as the operational parent above Incidents.

Revision ID: 20260817_project_domain
Revises: 20260817_engineer_elig
Create Date: 2026-08-17

Projects are classification-neutral operational containers. An incident may be
created without a project while it is still in coordinator review, but it may
not advance beyond COORDINATOR_REVIEW until a project is associated.

Historical incidents are backfilled one-project-per-incident. This preserves
all existing workflow state without guessing which historical incidents belong
together; authorized coordinators can regroup them later through the Project
association workflow. created_from_incident_id is intentionally indexed rather
than unique so regrouping can create a durable replacement Project while the
archived legacy Project still retains its provenance.
"""

from alembic import op

revision = "20260817_project_domain"
down_revision = "20260817_engineer_elig"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS projects (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            project_uuid VARCHAR(64) NOT NULL UNIQUE,
            title VARCHAR(255) NOT NULL,
            description TEXT NULL,
            status VARCHAR(24) NOT NULL DEFAULT 'OPEN',
            anchor_location_id BIGINT NULL,
            anchor_latitude DECIMAL(10,6) NOT NULL,
            anchor_longitude DECIMAL(10,6) NOT NULL,
            district VARCHAR(64) NULL,
            county VARCHAR(64) NULL,
            route VARCHAR(64) NULL,
            post_mile VARCHAR(64) NULL,
            created_from_incident_id BIGINT NULL,
            created_by_user_id BIGINT NOT NULL,
            source VARCHAR(32) NOT NULL DEFAULT 'COORDINATOR_CREATED',
            closed_at DATETIME NULL,
            closed_by_user_id BIGINT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

            CONSTRAINT fk_project_anchor_location FOREIGN KEY (anchor_location_id)
              REFERENCES incident_locations(id) ON DELETE SET NULL,
            CONSTRAINT fk_project_created_from_incident FOREIGN KEY (created_from_incident_id)
              REFERENCES incidents(id) ON DELETE SET NULL,
            CONSTRAINT fk_project_created_by FOREIGN KEY (created_by_user_id)
              REFERENCES users(id) ON DELETE RESTRICT,
            CONSTRAINT fk_project_closed_by FOREIGN KEY (closed_by_user_id)
              REFERENCES users(id) ON DELETE SET NULL,

            INDEX idx_project_created_from_incident (created_from_incident_id),
            INDEX idx_projects_status_updated (status, updated_at),
            INDEX idx_projects_geo (anchor_latitude, anchor_longitude),
            INDEX idx_projects_route (district, county, route, post_mile),
            CONSTRAINT chk_project_status CHECK (status IN ('OPEN', 'CLOSED', 'ARCHIVED')),
            CONSTRAINT chk_project_source CHECK (source IN ('COORDINATOR_CREATED', 'LEGACY_BACKFILL', 'ADMIN_CREATED')),
            CONSTRAINT chk_project_lat CHECK (anchor_latitude >= -90 AND anchor_latitude <= 90),
            CONSTRAINT chk_project_lon CHECK (anchor_longitude >= -180 AND anchor_longitude <= 180)
        ) ENGINE=InnoDB
        """
    )

    op.execute(
        """
        ALTER TABLE incidents
          ADD COLUMN project_id BIGINT NULL AFTER id,
          ADD INDEX idx_incidents_project (project_id),
          ADD CONSTRAINT fk_incident_project
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS project_events (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            project_id BIGINT NOT NULL,
            incident_id BIGINT NULL,
            actor_user_id BIGINT NULL,
            event_type VARCHAR(48) NOT NULL,
            notes TEXT NULL,
            metadata_json JSON NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

            CONSTRAINT fk_project_event_project FOREIGN KEY (project_id)
              REFERENCES projects(id) ON DELETE CASCADE,
            CONSTRAINT fk_project_event_incident FOREIGN KEY (incident_id)
              REFERENCES incidents(id) ON DELETE SET NULL,
            CONSTRAINT fk_project_event_actor FOREIGN KEY (actor_user_id)
              REFERENCES users(id) ON DELETE SET NULL,

            INDEX idx_project_events_project_created (project_id, created_at),
            INDEX idx_project_events_incident_created (incident_id, created_at),
            CONSTRAINT chk_project_event_type CHECK (event_type IN (
              'PROJECT_CREATED',
              'INCIDENT_LINKED',
              'INCIDENT_MOVED_IN',
              'INCIDENT_MOVED_OUT',
              'PROJECT_UPDATED',
              'PROJECT_CLOSED',
              'PROJECT_REOPENED',
              'LEGACY_BACKFILL'
            ))
        ) ENGINE=InnoDB
        """
    )

    # Preserve all existing incident workflows without guessing historical
    # grouping. Each existing incident receives a neutral legacy Project that
    # can later be consolidated by a coordinator/admin with an audited move.
    op.execute(
        """
        INSERT INTO projects (
          project_uuid,
          title,
          status,
          anchor_location_id,
          anchor_latitude,
          anchor_longitude,
          district,
          county,
          route,
          post_mile,
          created_from_incident_id,
          created_by_user_id,
          source,
          closed_at,
          closed_by_user_id,
          created_at,
          updated_at
        )
        SELECT
          UUID(),
          CONCAT('Legacy Incident #', i.id),
          CASE WHEN i.status = 'RESOLVED' THEN 'CLOSED' ELSE 'OPEN' END,
          i.location_id,
          i.latitude,
          i.longitude,
          i.district,
          i.county,
          i.route,
          i.post_mile,
          i.id,
          i.reporter_user_id,
          'LEGACY_BACKFILL',
          i.resolved_at,
          i.resolved_by_user_id,
          i.created_at,
          i.updated_at
        FROM incidents i
        WHERE i.project_id IS NULL
        """
    )

    op.execute(
        """
        UPDATE incidents i
        JOIN projects p ON p.created_from_incident_id = i.id
        SET i.project_id = p.id
        WHERE i.project_id IS NULL
          AND p.source = 'LEGACY_BACKFILL'
        """
    )

    op.execute(
        """
        INSERT INTO project_events (
          project_id,
          incident_id,
          actor_user_id,
          event_type,
          notes,
          metadata_json,
          created_at
        )
        SELECT
          p.id,
          i.id,
          i.reporter_user_id,
          'LEGACY_BACKFILL',
          'Historical incident preserved as a one-incident Project during Project-domain migration.',
          JSON_OBJECT('migration', '20260817_project_domain'),
          p.created_at
        FROM projects p
        JOIN incidents i ON i.project_id = p.id
        WHERE p.source = 'LEGACY_BACKFILL'
        """
    )

    # Fail closed at the data boundary: coordinator intake may be temporarily
    # projectless, but every route beyond coordinator review requires a Project.
    # A Project owns one district in this domain model, so member incidents must
    # stay in that same district. Legacy clients may still send an intake
    # incident_type; discard that premature classification instead of breaking
    # the report because type authority belongs to the completed Assessment.
    op.execute("DROP TRIGGER IF EXISTS trg_incident_project_required_bi")
    op.execute(
        """
        CREATE TRIGGER trg_incident_project_required_bi
        BEFORE INSERT ON incidents
        FOR EACH ROW
        BEGIN
          IF NEW.current_stage <> 'COORDINATOR_REVIEW' AND NEW.project_id IS NULL THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Incident must belong to a Project before leaving coordinator review';
          END IF;

          IF NEW.project_id IS NOT NULL AND EXISTS (
            SELECT 1
            FROM projects p
            WHERE p.id = NEW.project_id
              AND COALESCE(CAST(p.district AS UNSIGNED), 0) <> COALESCE(CAST(NEW.district AS UNSIGNED), 0)
          ) THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Incident and Project must belong to the same district';
          END IF;

          SET NEW.incident_type = NULL;
        END
        """
    )

    op.execute("DROP TRIGGER IF EXISTS trg_incident_project_required_bu")
    op.execute(
        """
        CREATE TRIGGER trg_incident_project_required_bu
        BEFORE UPDATE ON incidents
        FOR EACH ROW
        BEGIN
          IF NEW.current_stage <> 'COORDINATOR_REVIEW' AND NEW.project_id IS NULL THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Incident must belong to a Project before leaving coordinator review';
          END IF;

          IF NEW.project_id IS NOT NULL AND EXISTS (
            SELECT 1
            FROM projects p
            WHERE p.id = NEW.project_id
              AND COALESCE(CAST(p.district AS UNSIGNED), 0) <> COALESCE(CAST(NEW.district AS UNSIGNED), 0)
          ) THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Incident and Project must belong to the same district';
          END IF;

          IF NOT (NEW.incident_type <=> OLD.incident_type)
             AND NEW.incident_type IS NOT NULL
             AND NOT EXISTS (
               SELECT 1
               FROM assessments a
               WHERE a.incident_id = NEW.id
                 AND a.state IN ('APPROVED', 'FINALIZED')
             )
          THEN
            SET NEW.incident_type = OLD.incident_type;
          END IF;
        END
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_incident_project_required_bu")
    op.execute("DROP TRIGGER IF EXISTS trg_incident_project_required_bi")
    op.execute("DROP TABLE IF EXISTS project_events")
    op.execute("ALTER TABLE incidents DROP FOREIGN KEY fk_incident_project")
    op.execute("ALTER TABLE incidents DROP INDEX idx_incidents_project")
    op.execute("ALTER TABLE incidents DROP COLUMN project_id")
    op.execute("DROP TABLE IF EXISTS projects")

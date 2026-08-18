"""Replace Project-parent semantics with Event Group attributes and permanent Incident identity.

Revision ID: 20260818_event_group_domain
Revises: 20260818_project_lifecycle
Create Date: 2026-08-18

Incident is the operational root. Event Group is a shared grouping attribute.
A coordinator-review Incident is provisional until coordinator approval mints
an immutable incident_key and finalizes an event_group_id.
"""

from alembic import op

revision = "20260818_event_group_domain"
down_revision = "20260818_project_lifecycle"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Remove Project-era triggers before moving the data model.
    for trigger in (
        "trg_project_close_active_incidents_bu",
        "trg_incident_project_open_bu",
        "trg_incident_project_open_bi",
        "trg_incident_project_required_bu",
        "trg_incident_project_required_bi",
    ):
        op.execute(f"DROP TRIGGER IF EXISTS {trigger}")

    op.execute(
        """
        CREATE TABLE event_groups (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            event_group_key VARCHAR(64) NOT NULL UNIQUE,
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

            CONSTRAINT fk_event_group_anchor_location FOREIGN KEY (anchor_location_id)
              REFERENCES incident_locations(id) ON DELETE SET NULL,
            CONSTRAINT fk_event_group_created_from_incident FOREIGN KEY (created_from_incident_id)
              REFERENCES incidents(id) ON DELETE SET NULL,
            CONSTRAINT fk_event_group_created_by FOREIGN KEY (created_by_user_id)
              REFERENCES users(id) ON DELETE RESTRICT,
            CONSTRAINT fk_event_group_closed_by FOREIGN KEY (closed_by_user_id)
              REFERENCES users(id) ON DELETE SET NULL,

            INDEX idx_event_group_created_from_incident (created_from_incident_id),
            INDEX idx_event_groups_status_updated (status, updated_at),
            INDEX idx_event_groups_geo (anchor_latitude, anchor_longitude),
            INDEX idx_event_groups_route (district, county, route, post_mile),
            CONSTRAINT chk_event_group_status CHECK (status IN ('OPEN', 'CLOSED', 'ARCHIVED')),
            CONSTRAINT chk_event_group_source CHECK (source IN ('COORDINATOR_CREATED', 'LEGACY_BACKFILL', 'ADMIN_CREATED')),
            CONSTRAINT chk_event_group_lat CHECK (anchor_latitude >= -90 AND anchor_latitude <= 90),
            CONSTRAINT chk_event_group_lon CHECK (anchor_longitude >= -180 AND anchor_longitude <= 180)
        ) ENGINE=InnoDB
        """
    )

    # Preserve numeric IDs so every existing association and audit reference can
    # be migrated deterministically without inventing new group identity.
    op.execute(
        """
        INSERT INTO event_groups (
          id, event_group_key, title, description, status,
          anchor_location_id, anchor_latitude, anchor_longitude,
          district, county, route, post_mile,
          created_from_incident_id, created_by_user_id, source,
          closed_at, closed_by_user_id, created_at, updated_at
        )
        SELECT
          id, project_uuid, title, description, status,
          anchor_location_id, anchor_latitude, anchor_longitude,
          district, county, route, post_mile,
          created_from_incident_id, created_by_user_id, source,
          closed_at, closed_by_user_id, created_at, updated_at
        FROM projects
        """
    )

    op.execute(
        """
        CREATE TABLE event_group_events (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            event_group_id BIGINT NOT NULL,
            incident_id BIGINT NULL,
            actor_user_id BIGINT NULL,
            event_type VARCHAR(64) NOT NULL,
            notes TEXT NULL,
            metadata_json JSON NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

            CONSTRAINT fk_event_group_event_group FOREIGN KEY (event_group_id)
              REFERENCES event_groups(id) ON DELETE CASCADE,
            CONSTRAINT fk_event_group_event_incident FOREIGN KEY (incident_id)
              REFERENCES incidents(id) ON DELETE SET NULL,
            CONSTRAINT fk_event_group_event_actor FOREIGN KEY (actor_user_id)
              REFERENCES users(id) ON DELETE SET NULL,

            INDEX idx_event_group_events_group_created (event_group_id, created_at),
            INDEX idx_event_group_events_incident_created (incident_id, created_at),
            CONSTRAINT chk_event_group_event_type CHECK (event_type IN (
              'EVENT_GROUP_CREATED',
              'INCIDENT_LINKED',
              'INCIDENT_MOVED_IN',
              'INCIDENT_MOVED_OUT',
              'EVENT_GROUP_UPDATED',
              'EVENT_GROUP_CLOSED',
              'EVENT_GROUP_REOPENED',
              'LEGACY_BACKFILL'
            ))
        ) ENGINE=InnoDB
        """
    )

    op.execute(
        """
        INSERT INTO event_group_events (
          id, event_group_id, incident_id, actor_user_id,
          event_type, notes, metadata_json, created_at
        )
        SELECT
          id, project_id, incident_id, actor_user_id,
          CASE event_type
            WHEN 'PROJECT_CREATED' THEN 'EVENT_GROUP_CREATED'
            WHEN 'PROJECT_UPDATED' THEN 'EVENT_GROUP_UPDATED'
            WHEN 'PROJECT_CLOSED' THEN 'EVENT_GROUP_CLOSED'
            WHEN 'PROJECT_REOPENED' THEN 'EVENT_GROUP_REOPENED'
            ELSE event_type
          END,
          notes, metadata_json, created_at
        FROM project_events
        """
    )

    op.execute(
        """
        ALTER TABLE incidents
          ADD COLUMN event_group_id BIGINT NULL AFTER id,
          ADD COLUMN incident_key VARCHAR(64) NULL AFTER event_group_id,
          ADD COLUMN approved_at DATETIME NULL AFTER incident_key,
          ADD COLUMN approved_by_user_id BIGINT NULL AFTER approved_at,
          ADD UNIQUE INDEX uq_incidents_incident_key (incident_key),
          ADD INDEX idx_incidents_event_group (event_group_id),
          ADD INDEX idx_incidents_approved_at (approved_at),
          ADD CONSTRAINT fk_incident_event_group
            FOREIGN KEY (event_group_id) REFERENCES event_groups(id) ON DELETE RESTRICT,
          ADD CONSTRAINT fk_incident_approved_by
            FOREIGN KEY (approved_by_user_id) REFERENCES users(id) ON DELETE SET NULL
        """
    )

    op.execute("UPDATE incidents SET event_group_id = project_id")

    # The prior migration created one LEGACY_BACKFILL Project for every historical
    # Incident. A still-provisional coordinator-review Incident must not inherit a
    # placeholder as an implicit grouping decision. Explicit coordinator-created
    # associations are preserved.
    op.execute(
        """
        UPDATE incidents i
        JOIN event_groups eg ON eg.id = i.event_group_id
        SET i.event_group_id = NULL
        WHERE i.current_stage = 'COORDINATOR_REVIEW'
          AND eg.source = 'LEGACY_BACKFILL'
        """
    )

    # Existing Incidents that already advanced beyond coordinator review are
    # historical records. Mint permanent identities while preserving their current
    # Event Group. Exact legacy approval actor/time was not stored, so approved_at
    # uses the best available historical activity timestamp and actor stays NULL.
    op.execute(
        """
        UPDATE incidents
        SET incident_key = UUID(),
            approved_at = COALESCE(updated_at, created_at)
        WHERE current_stage <> 'COORDINATOR_REVIEW'
          AND incident_key IS NULL
        """
    )

    op.execute(
        """
        UPDATE event_groups eg
        SET eg.status = 'ARCHIVED', eg.updated_at = NOW()
        WHERE eg.source = 'LEGACY_BACKFILL'
          AND NOT EXISTS (
            SELECT 1 FROM incidents i WHERE i.event_group_id = eg.id
          )
        """
    )

    # Remove the old parent-shaped schema after all data has been copied.
    op.execute("DROP TABLE project_events")
    op.execute("ALTER TABLE incidents DROP FOREIGN KEY fk_incident_project")
    op.execute("ALTER TABLE incidents DROP INDEX idx_incidents_project")
    op.execute("ALTER TABLE incidents DROP COLUMN project_id")
    op.execute("DROP TABLE projects")

    # Group assignment remains constrained to active groups, but the Event Group
    # is an Incident attribute rather than an ownership/parent relationship.
    op.execute(
        """
        CREATE TRIGGER trg_incident_event_group_open_bi
        BEFORE INSERT ON incidents
        FOR EACH ROW
        BEGIN
          IF NEW.event_group_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM event_groups eg
               WHERE eg.id = NEW.event_group_id AND eg.status = 'OPEN'
             )
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Incident may only be associated with an open Event Group';
          END IF;
        END
        """
    )

    op.execute(
        """
        CREATE TRIGGER trg_incident_event_group_open_bu
        BEFORE UPDATE ON incidents
        FOR EACH ROW
        BEGIN
          IF NOT (NEW.event_group_id <=> OLD.event_group_id)
             AND NEW.event_group_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM event_groups eg
               WHERE eg.id = NEW.event_group_id AND eg.status = 'OPEN'
             )
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Incident may only be associated with an open Event Group';
          END IF;
        END
        """
    )

    # Preserve the assessment-derived incident classification invariant from the
    # Project-era trigger while enforcing the new approval identity boundary.
    op.execute(
        """
        CREATE TRIGGER trg_incident_identity_bi
        BEFORE INSERT ON incidents
        FOR EACH ROW
        BEGIN
          IF NEW.current_stage <> 'COORDINATOR_REVIEW'
             AND (NEW.event_group_id IS NULL OR NEW.incident_key IS NULL)
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Incident must be coordinator-approved and grouped before leaving coordinator review';
          END IF;
          IF NEW.incident_key IS NOT NULL AND NEW.approved_at IS NULL THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Permanent Incident identity requires approval provenance';
          END IF;
          SET NEW.incident_type = NULL;
        END
        """
    )

    op.execute(
        """
        CREATE TRIGGER trg_incident_identity_bu
        BEFORE UPDATE ON incidents
        FOR EACH ROW
        BEGIN
          IF OLD.incident_key IS NOT NULL
             AND NOT (NEW.incident_key <=> OLD.incident_key)
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Permanent Incident key is immutable';
          END IF;

          IF NEW.current_stage <> 'COORDINATOR_REVIEW'
             AND (NEW.event_group_id IS NULL OR NEW.incident_key IS NULL)
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Incident must be coordinator-approved and grouped before leaving coordinator review';
          END IF;

          IF NEW.incident_key IS NOT NULL AND NEW.approved_at IS NULL THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Permanent Incident identity requires approval provenance';
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

    op.execute(
        """
        CREATE TRIGGER trg_incident_permanent_delete_bd
        BEFORE DELETE ON incidents
        FOR EACH ROW
        BEGIN
          IF OLD.incident_key IS NOT NULL THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Coordinator-approved Incidents are historical and cannot be hard-deleted';
          END IF;
        END
        """
    )

    op.execute(
        """
        CREATE TRIGGER trg_event_group_close_active_incidents_bu
        BEFORE UPDATE ON event_groups
        FOR EACH ROW
        BEGIN
          IF NEW.status = 'CLOSED'
             AND OLD.status <> 'CLOSED'
             AND EXISTS (
               SELECT 1
               FROM incidents i
               WHERE i.event_group_id = OLD.id
                 AND i.status <> 'RESOLVED'
             )
          THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT = 'Event Group cannot close while active Incidents remain';
          END IF;
        END
        """
    )


def downgrade() -> None:
    for trigger in (
        "trg_event_group_close_active_incidents_bu",
        "trg_incident_permanent_delete_bd",
        "trg_incident_identity_bu",
        "trg_incident_identity_bi",
        "trg_incident_event_group_open_bu",
        "trg_incident_event_group_open_bi",
    ):
        op.execute(f"DROP TRIGGER IF EXISTS {trigger}")

    op.execute(
        """
        CREATE TABLE projects (
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
            CONSTRAINT fk_project_anchor_location FOREIGN KEY (anchor_location_id) REFERENCES incident_locations(id) ON DELETE SET NULL,
            CONSTRAINT fk_project_created_from_incident FOREIGN KEY (created_from_incident_id) REFERENCES incidents(id) ON DELETE SET NULL,
            CONSTRAINT fk_project_created_by FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
            CONSTRAINT fk_project_closed_by FOREIGN KEY (closed_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
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
        INSERT INTO projects (
          id, project_uuid, title, description, status,
          anchor_location_id, anchor_latitude, anchor_longitude,
          district, county, route, post_mile,
          created_from_incident_id, created_by_user_id, source,
          closed_at, closed_by_user_id, created_at, updated_at
        )
        SELECT
          id, event_group_key, title, description, status,
          anchor_location_id, anchor_latitude, anchor_longitude,
          district, county, route, post_mile,
          created_from_incident_id, created_by_user_id, source,
          closed_at, closed_by_user_id, created_at, updated_at
        FROM event_groups
        """
    )

    op.execute(
        """
        CREATE TABLE project_events (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            project_id BIGINT NOT NULL,
            incident_id BIGINT NULL,
            actor_user_id BIGINT NULL,
            event_type VARCHAR(48) NOT NULL,
            notes TEXT NULL,
            metadata_json JSON NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_project_event_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
            CONSTRAINT fk_project_event_incident FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE SET NULL,
            CONSTRAINT fk_project_event_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
            INDEX idx_project_events_project_created (project_id, created_at),
            INDEX idx_project_events_incident_created (incident_id, created_at),
            CONSTRAINT chk_project_event_type CHECK (event_type IN (
              'PROJECT_CREATED', 'INCIDENT_LINKED', 'INCIDENT_MOVED_IN', 'INCIDENT_MOVED_OUT',
              'PROJECT_UPDATED', 'PROJECT_CLOSED', 'PROJECT_REOPENED', 'LEGACY_BACKFILL'
            ))
        ) ENGINE=InnoDB
        """
    )

    op.execute(
        """
        INSERT INTO project_events (
          id, project_id, incident_id, actor_user_id,
          event_type, notes, metadata_json, created_at
        )
        SELECT
          id, event_group_id, incident_id, actor_user_id,
          CASE event_type
            WHEN 'EVENT_GROUP_CREATED' THEN 'PROJECT_CREATED'
            WHEN 'EVENT_GROUP_UPDATED' THEN 'PROJECT_UPDATED'
            WHEN 'EVENT_GROUP_CLOSED' THEN 'PROJECT_CLOSED'
            WHEN 'EVENT_GROUP_REOPENED' THEN 'PROJECT_REOPENED'
            ELSE event_type
          END,
          notes, metadata_json, created_at
        FROM event_group_events
        """
    )

    op.execute(
        """
        ALTER TABLE incidents
          ADD COLUMN project_id BIGINT NULL AFTER id,
          ADD INDEX idx_incidents_project (project_id),
          ADD CONSTRAINT fk_incident_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
        """
    )
    op.execute("UPDATE incidents SET project_id = event_group_id")

    op.execute("ALTER TABLE incidents DROP FOREIGN KEY fk_incident_approved_by")
    op.execute("ALTER TABLE incidents DROP FOREIGN KEY fk_incident_event_group")
    op.execute("ALTER TABLE incidents DROP INDEX uq_incidents_incident_key")
    op.execute("ALTER TABLE incidents DROP INDEX idx_incidents_event_group")
    op.execute("ALTER TABLE incidents DROP INDEX idx_incidents_approved_at")
    op.execute(
        """
        ALTER TABLE incidents
          DROP COLUMN approved_by_user_id,
          DROP COLUMN approved_at,
          DROP COLUMN incident_key,
          DROP COLUMN event_group_id
        """
    )
    op.execute("DROP TABLE event_group_events")
    op.execute("DROP TABLE event_groups")

    op.execute(
        """
        CREATE TRIGGER trg_incident_project_required_bi
        BEFORE INSERT ON incidents
        FOR EACH ROW
        BEGIN
          IF NEW.current_stage <> 'COORDINATOR_REVIEW' AND NEW.project_id IS NULL THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Incident must belong to a Project before leaving coordinator review';
          END IF;
          SET NEW.incident_type = NULL;
        END
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_incident_project_required_bu
        BEFORE UPDATE ON incidents
        FOR EACH ROW
        BEGIN
          IF NEW.current_stage <> 'COORDINATOR_REVIEW' AND NEW.project_id IS NULL THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Incident must belong to a Project before leaving coordinator review';
          END IF;
          IF NOT (NEW.incident_type <=> OLD.incident_type)
             AND NEW.incident_type IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM assessments a
               WHERE a.incident_id = NEW.id AND a.state IN ('APPROVED', 'FINALIZED')
             )
          THEN
            SET NEW.incident_type = OLD.incident_type;
          END IF;
        END
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_incident_project_open_bi
        BEFORE INSERT ON incidents
        FOR EACH ROW
        BEGIN
          IF NEW.project_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = NEW.project_id AND p.status = 'OPEN')
          THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Incident may only be associated with an open Project';
          END IF;
        END
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_incident_project_open_bu
        BEFORE UPDATE ON incidents
        FOR EACH ROW
        BEGIN
          IF NOT (NEW.project_id <=> OLD.project_id)
             AND NEW.project_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = NEW.project_id AND p.status = 'OPEN')
          THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Incident may only be associated with an open Project';
          END IF;
        END
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_project_close_active_incidents_bu
        BEFORE UPDATE ON projects
        FOR EACH ROW
        BEGIN
          IF NEW.status = 'CLOSED'
             AND OLD.status <> 'CLOSED'
             AND EXISTS (SELECT 1 FROM incidents i WHERE i.project_id = OLD.id AND i.status <> 'RESOLVED')
          THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Project cannot close while active Incidents remain';
          END IF;
        END
        """
    )

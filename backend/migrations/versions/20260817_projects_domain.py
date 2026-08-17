"""Add the Project domain above incident intake.

Revision ID: 20260817_projects
Revises: 20260817_engineer_elig
Create Date: 2026-08-17

Projects are the durable operational container for one or more incidents. An
incident may remain temporarily unassociated while it is still in maintenance
coordinator review, but routing/terminal triage decisions are expected to occur
only after a project association is established.
"""

from __future__ import annotations

from alembic import op
from sqlalchemy import text

revision = "20260817_projects"
down_revision = "20260817_engineer_elig"
branch_labels = None
depends_on = None


def _schema_name() -> str:
    value = op.get_bind().execute(text("SELECT DATABASE()" )).scalar()
    if not value:
        raise RuntimeError("No active database selected")
    return str(value)


def _column_exists(table_name: str, column_name: str) -> bool:
    return bool(
        op.get_bind().execute(
            text(
                """
                SELECT 1
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = :schema
                  AND TABLE_NAME = :table_name
                  AND COLUMN_NAME = :column_name
                LIMIT 1
                """
            ),
            {"schema": _schema_name(), "table_name": table_name, "column_name": column_name},
        ).scalar()
    )


def _index_exists(table_name: str, index_name: str) -> bool:
    return bool(
        op.get_bind().execute(
            text(
                """
                SELECT 1
                FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA = :schema
                  AND TABLE_NAME = :table_name
                  AND INDEX_NAME = :index_name
                LIMIT 1
                """
            ),
            {"schema": _schema_name(), "table_name": table_name, "index_name": index_name},
        ).scalar()
    )


def _constraint_exists(table_name: str, constraint_name: str) -> bool:
    return bool(
        op.get_bind().execute(
            text(
                """
                SELECT 1
                FROM information_schema.TABLE_CONSTRAINTS
                WHERE CONSTRAINT_SCHEMA = :schema
                  AND TABLE_NAME = :table_name
                  AND CONSTRAINT_NAME = :constraint_name
                LIMIT 1
                """
            ),
            {"schema": _schema_name(), "table_name": table_name, "constraint_name": constraint_name},
        ).scalar()
    )


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS projects (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            project_uuid VARCHAR(64) NOT NULL UNIQUE,
            name VARCHAR(255) NOT NULL,
            description TEXT NULL,
            status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
            district VARCHAR(64) NULL,
            county VARCHAR(64) NULL,
            route VARCHAR(64) NULL,
            post_mile VARCHAR(64) NULL,
            latitude DECIMAL(10,6) NULL,
            longitude DECIMAL(10,6) NULL,
            created_from_incident_id BIGINT NULL,
            created_by_user_id BIGINT NOT NULL,
            closed_at DATETIME NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

            CONSTRAINT fk_projects_created_from_incident FOREIGN KEY (created_from_incident_id)
              REFERENCES incidents(id) ON DELETE SET NULL,
            CONSTRAINT fk_projects_created_by FOREIGN KEY (created_by_user_id)
              REFERENCES users(id) ON DELETE RESTRICT,

            INDEX idx_projects_status (status),
            INDEX idx_projects_district_status (district, status),
            INDEX idx_projects_route_status (route, status),
            INDEX idx_projects_geo (latitude, longitude),
            CONSTRAINT chk_projects_status CHECK (status IN ('ACTIVE', 'CLOSED', 'ARCHIVED')),
            CONSTRAINT chk_projects_lat CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90)),
            CONSTRAINT chk_projects_lon CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180))
        ) ENGINE=InnoDB
        """
    )

    columns = [
        ("project_id", "BIGINT NULL"),
        ("project_assigned_by_user_id", "BIGINT NULL"),
        ("project_assigned_at", "DATETIME NULL"),
        ("project_association_notes", "TEXT NULL"),
    ]
    for column_name, definition in columns:
        if not _column_exists("incidents", column_name):
            op.execute(f"ALTER TABLE incidents ADD COLUMN {column_name} {definition}")

    if not _index_exists("incidents", "idx_incidents_project"):
        op.execute("ALTER TABLE incidents ADD INDEX idx_incidents_project (project_id)")
    if not _index_exists("incidents", "idx_incidents_project_stage"):
        op.execute("ALTER TABLE incidents ADD INDEX idx_incidents_project_stage (project_id, current_stage, status)")

    if not _constraint_exists("incidents", "fk_incidents_project"):
        op.execute(
            """
            ALTER TABLE incidents
              ADD CONSTRAINT fk_incidents_project FOREIGN KEY (project_id)
                REFERENCES projects(id) ON DELETE SET NULL
            """
        )
    if not _constraint_exists("incidents", "fk_incidents_project_assigned_by"):
        op.execute(
            """
            ALTER TABLE incidents
              ADD CONSTRAINT fk_incidents_project_assigned_by FOREIGN KEY (project_assigned_by_user_id)
                REFERENCES users(id) ON DELETE SET NULL
            """
        )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS project_events (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            project_id BIGINT NOT NULL,
            incident_id BIGINT NULL,
            actor_user_id BIGINT NOT NULL,
            event_type VARCHAR(48) NOT NULL,
            notes TEXT NULL,
            metadata_json JSON NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

            CONSTRAINT fk_project_events_project FOREIGN KEY (project_id)
              REFERENCES projects(id) ON DELETE CASCADE,
            CONSTRAINT fk_project_events_incident FOREIGN KEY (incident_id)
              REFERENCES incidents(id) ON DELETE SET NULL,
            CONSTRAINT fk_project_events_actor FOREIGN KEY (actor_user_id)
              REFERENCES users(id) ON DELETE RESTRICT,

            INDEX idx_project_events_project (project_id, created_at),
            INDEX idx_project_events_incident (incident_id, created_at),
            INDEX idx_project_events_type (event_type, created_at)
        ) ENGINE=InnoDB
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS project_events")
    if _constraint_exists("incidents", "fk_incidents_project_assigned_by"):
        op.execute("ALTER TABLE incidents DROP FOREIGN KEY fk_incidents_project_assigned_by")
    if _constraint_exists("incidents", "fk_incidents_project"):
        op.execute("ALTER TABLE incidents DROP FOREIGN KEY fk_incidents_project")
    if _index_exists("incidents", "idx_incidents_project_stage"):
        op.execute("ALTER TABLE incidents DROP INDEX idx_incidents_project_stage")
    if _index_exists("incidents", "idx_incidents_project"):
        op.execute("ALTER TABLE incidents DROP INDEX idx_incidents_project")
    for column_name in [
        "project_association_notes",
        "project_assigned_at",
        "project_assigned_by_user_id",
        "project_id",
    ]:
        if _column_exists("incidents", column_name):
            op.execute(f"ALTER TABLE incidents DROP COLUMN {column_name}")
    op.execute("DROP TABLE IF EXISTS projects")

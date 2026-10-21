"""District-owned maintenance duties and versioned incident review paths."""
from alembic import op
from sqlalchemy import text

revision = "20261007_maintenance_workflows"
down_revision = "20261006_form_presence"
branch_labels = None
depends_on = None


def upgrade():
    for statement in (
        """CREATE TABLE maintenance_workflows (
            district VARCHAR(4) PRIMARY KEY,
            revision INT NOT NULL,
            definition_json LONGTEXT NOT NULL,
            updated_by_user_id BIGINT NOT NULL,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB""",
        """CREATE TABLE maintenance_workflow_runs (
            incident_id BIGINT PRIMARY KEY,
            district VARCHAR(4) NOT NULL,
            revision INT NOT NULL,
            definition_json LONGTEXT NOT NULL,
            state_json LONGTEXT NOT NULL,
            version INT NOT NULL DEFAULT 1,
            outcome VARCHAR(32) NULL,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_maintenance_runs_district (district, outcome),
            FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE
        ) ENGINE=InnoDB""",
        """CREATE TABLE maintenance_workflow_events (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            district VARCHAR(4) NOT NULL,
            incident_id BIGINT NULL,
            actor_user_id BIGINT NOT NULL,
            action VARCHAR(48) NOT NULL,
            step_index INT NULL,
            notes TEXT NULL,
            metadata_json LONGTEXT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_maintenance_events_incident (incident_id, id),
            FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE
        ) ENGINE=InnoDB""",
    ):
        op.get_bind().execute(text(statement))


def downgrade():
    for table in ("maintenance_workflow_events", "maintenance_workflow_runs", "maintenance_workflows"):
        op.get_bind().execute(text(f"DROP TABLE {table}"))

"""Remember that the deployment administrator was seeded once."""
from alembic import op

revision = "20261025_bootstrap_marker"
down_revision = "20261007_maintenance_workflows"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""CREATE TABLE IF NOT EXISTS deployment_bootstrap (
        name VARCHAR(64) PRIMARY KEY,
        completed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        user_id BIGINT NULL
    ) ENGINE=InnoDB""")


def downgrade():
    op.execute("DROP TABLE IF EXISTS deployment_bootstrap")

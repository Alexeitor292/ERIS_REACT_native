"""add json_gz to road_inventory_packages package_type enum

Revision ID: 0004_ri_packages_json_gz
Revises: 0003_road_inventory_import_jobs
Create Date: 2026-06-09

Extends the package_type ENUM so the package generation service can store
gzip-compressed JSON packages (json_gz) alongside the future sqlite_gz type.
"""

from alembic import op

revision = "0004_ri_packages_json_gz"
down_revision = "0003_road_inventory_import_jobs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE road_inventory_packages
        MODIFY COLUMN package_type ENUM('sqlite_gz', 'json_gz') NOT NULL
    """)


def downgrade() -> None:
    # Remove any json_gz rows first to avoid constraint violation on downgrade.
    op.execute("DELETE FROM road_inventory_packages WHERE package_type = 'json_gz'")
    op.execute("""
        ALTER TABLE road_inventory_packages
        MODIFY COLUMN package_type ENUM('sqlite_gz') NOT NULL
    """)

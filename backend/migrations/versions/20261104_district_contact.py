"""District contacts and immediate action deliveries.

Revision ID: 20261104_district_contact
Revises: 20261103_delegations
Create Date: 2026-11-04

When maintenance sends a report to GeoTech it names a District Contact, who is
kept informed and pre-fills the form's District Contact section. A district can
keep a default (``org_district_settings``). ``immediate_action_deliveries`` holds
what Staff delivered from a form still in draft; its ``client_uuid`` makes a resend
from a phone that lost its connection harmless.
"""

from alembic import op
from sqlalchemy import text

revision = "20261104_district_contact"
down_revision = "20261103_delegations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    # The fresh-install SQL already has all of this.
    has_column = bind.execute(text("""
        SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'incidents' AND COLUMN_NAME = 'district_contact_user_id'
    """)).first()
    if not has_column:
        op.execute("ALTER TABLE incidents ADD COLUMN district_contact_user_id BIGINT NULL")
        op.execute("""
            ALTER TABLE incidents ADD CONSTRAINT fk_incident_district_contact
            FOREIGN KEY (district_contact_user_id) REFERENCES users(id) ON DELETE SET NULL
        """)
    op.execute("""
        CREATE TABLE IF NOT EXISTS org_district_settings (
            district VARCHAR(8) PRIMARY KEY,
            contact_user_id BIGINT NULL,
            updated_by_user_id BIGINT NULL,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            CONSTRAINT fk_district_setting_contact FOREIGN KEY (contact_user_id) REFERENCES users(id) ON DELETE SET NULL,
            CONSTRAINT fk_district_setting_editor FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
        ) ENGINE=InnoDB
    """)
    op.execute("""
        CREATE TABLE IF NOT EXISTS immediate_action_deliveries (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            submission_id BIGINT NOT NULL,
            actor_user_id BIGINT NOT NULL,
            client_uuid CHAR(36) NOT NULL,
            actions_json JSON NOT NULL,
            description TEXT NOT NULL,
            written_at DATETIME NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT uq_immediate_delivery_client UNIQUE (client_uuid),
            CONSTRAINT fk_immediate_delivery_submission FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
            CONSTRAINT fk_immediate_delivery_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
            INDEX ix_immediate_delivery_submission (submission_id, created_at)
        ) ENGINE=InnoDB
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS immediate_action_deliveries")
    op.execute("DROP TABLE IF EXISTS org_district_settings")
    op.execute("ALTER TABLE incidents DROP FOREIGN KEY fk_incident_district_contact")
    op.execute("ALTER TABLE incidents DROP COLUMN district_contact_user_id")

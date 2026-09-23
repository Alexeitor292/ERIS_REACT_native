"""Saved screen layouts, per person.

Revision ID: 20260924_user_saved_layouts
Revises: 20260923_entra_identity
Create Date: 2026-09-24

Each person can save named arrangements of a screen — today the cards of a
technical form's GISA sheet (scope ``submission_canvas``) — and mark one as the
layout that screen opens with. Presentation only: nothing reads the stored JSON
but the web app. A person's layouts go when their account does.
"""

from alembic import op

revision = "20260924_user_saved_layouts"
down_revision = "20260923_entra_identity"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS user_saved_layouts (
          id BIGINT PRIMARY KEY AUTO_INCREMENT,
          user_id BIGINT NOT NULL,
          scope VARCHAR(40) NOT NULL,
          name VARCHAR(80) NOT NULL,
          layout_json JSON NOT NULL,
          is_default TINYINT(1) NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          CONSTRAINT uq_user_saved_layout_name UNIQUE (user_id, scope, name),
          CONSTRAINT fk_user_saved_layout_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          CONSTRAINT chk_user_saved_layout_scope CHECK (scope IN ('submission_canvas'))
        ) ENGINE=InnoDB
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS user_saved_layouts")

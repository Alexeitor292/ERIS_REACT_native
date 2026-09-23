"""Get the database ready for Entra ID sign-in — authentication only.

Revision ID: 20260923_entra_identity
Revises: 20260923_roles_consolidated
Create Date: 2026-09-23

The owner's decision (2026-09-22): Caltrans' Microsoft Entra ID will
AUTHENTICATE people — prove who is signing in — and nothing else. Which ERIS
roles a person holds and where they sit in the organization stay assigned in
ERIS by an administrator; no Entra group, app role or claim grants either.

Schema only; no sign-in flow is switched on here.

  * ``users.password_hash`` becomes nullable. An account without one can only
    sign in through single sign-on; the password endpoint refuses it with the
    same "Invalid credentials" as a wrong password, so it reveals nothing.
  * ``users.last_login_at`` records the last successful sign-in of any kind.
  * ``user_external_identities`` links an ERIS account to its Entra identity.
    The key is the pair Microsoft documents as stable and unique for a person:
    the directory (``tenant_id``, the token's ``tid``) and the object ID
    (``object_id``, the token's ``oid``). The email address and user principal
    name are kept only as they read at link time and last sign-in — they can
    change and must never identify anyone. One Entra identity per account, and
    one account per Entra identity.

The intended flow, for when it is built: an administrator creates the account
(email, name, roles, org placement) — with or without a password. At the
person's first Entra sign-in ERIS validates the ID token for the configured
tenant, finds the pre-created account by its verified email, records the
tenant and object ID here, and from then on matches on those alone. A person
Entra knows but no administrator has created gets no ERIS access.
"""

from alembic import op
from sqlalchemy import text

revision = "20260923_entra_identity"
down_revision = "20260923_roles_consolidated"
branch_labels = None
depends_on = None


def _column_exists(bind, table: str, column: str) -> bool:
    return bool(bind.execute(
        text("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c"),
        {"t": table, "c": column},
    ).scalar())


def upgrade() -> None:
    bind = op.get_bind()
    op.execute("ALTER TABLE users MODIFY password_hash VARCHAR(255) NULL")
    if not _column_exists(bind, "users", "last_login_at"):
        op.execute("ALTER TABLE users ADD COLUMN last_login_at DATETIME NULL AFTER is_active")
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS user_external_identities (
          id BIGINT PRIMARY KEY AUTO_INCREMENT,
          user_id BIGINT NOT NULL,
          provider VARCHAR(32) NOT NULL,
          tenant_id CHAR(36) NOT NULL,
          object_id CHAR(36) NOT NULL,
          user_principal_name VARCHAR(255) NULL,
          email_at_link VARCHAR(255) NULL,
          linked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          linked_by_user_id BIGINT NULL,
          last_login_at DATETIME NULL,
          CONSTRAINT fk_user_external_identities_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          CONSTRAINT fk_user_external_identities_linked_by FOREIGN KEY (linked_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
          CONSTRAINT uq_user_external_identities_subject UNIQUE (provider, tenant_id, object_id),
          CONSTRAINT uq_user_external_identities_user_provider UNIQUE (user_id, provider),
          CONSTRAINT chk_user_external_identities_provider CHECK (provider IN ('ENTRA_ID'))
        ) ENGINE=InnoDB
        """
    )


def downgrade() -> None:
    bind = op.get_bind()
    op.execute("DROP TABLE IF EXISTS user_external_identities")
    if _column_exists(bind, "users", "last_login_at"):
        op.execute("ALTER TABLE users DROP COLUMN last_login_at")
    # An account created without a password cannot survive the NOT NULL: it is
    # given an unusable hash (no password verifies against it) rather than lost.
    bind.execute(text("UPDATE users SET password_hash = '!sso-only' WHERE password_hash IS NULL"))
    op.execute("ALTER TABLE users MODIFY password_hash VARCHAR(255) NOT NULL")

"""Server-side sign-in sessions: user_sessions.

Revision ID: 20261028_user_sessions
Revises: 20261025_bootstrap_marker
Create Date: 2026-10-28

ERIS stops issuing self-contained JWTs. Every sign-in creates a row here;
browsers hold the random credential in an HttpOnly cookie and native clients
send it as a bearer token. Only its SHA-256 is stored. A row is ended by
sign-out (that session), idle or absolute timeout, or by disabling the
account, a password reset or "sign out everywhere" (all of its rows).

Tokens issued before this revision are not rows here, so everyone signs in
again once after the upgrade.
"""

from alembic import op

revision = "20261028_user_sessions"
down_revision = "20261025_bootstrap_marker"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # IF NOT EXISTS: the fresh-install SQL already creates it.
    op.execute("""
        CREATE TABLE IF NOT EXISTS user_sessions (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            user_id BIGINT NOT NULL,
            token_hash CHAR(64) NOT NULL,
            client VARCHAR(16) NOT NULL,
            auth_method VARCHAR(16) NOT NULL,
            created_at DATETIME NOT NULL,
            last_seen_at DATETIME NOT NULL,
            expires_at DATETIME NOT NULL,
            revoked_at DATETIME NULL,
            revoked_reason VARCHAR(32) NULL,
            user_agent VARCHAR(255) NULL,
            created_ip VARCHAR(45) NULL,
            CONSTRAINT uq_user_sessions_token UNIQUE (token_hash),
            CONSTRAINT fk_user_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            CONSTRAINT chk_user_sessions_client CHECK (client IN ('web', 'bearer')),
            INDEX ix_user_sessions_user (user_id, revoked_at),
            INDEX ix_user_sessions_expiry (expires_at)
        ) ENGINE=InnoDB
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS user_sessions")

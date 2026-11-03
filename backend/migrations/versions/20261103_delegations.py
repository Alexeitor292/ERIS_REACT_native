"""Out of the office: user_delegations and delegated_actions.

Revision ID: 20261103_delegations
Revises: 20261029_submission_cracks
Create Date: 2026-11-03

Someone away names a colleague for a run of dates. While it runs, that colleague
may switch to acting for them and sees and does what they could
(``services/delegations.py``). ``delegated_actions`` answers afterwards who
really did what: records written while acting carry the absent person's id.
"""

from alembic import op

revision = "20261103_delegations"
down_revision = "20261029_submission_cracks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # IF NOT EXISTS: the fresh-install SQL already creates them.
    op.execute("""
        CREATE TABLE IF NOT EXISTS user_delegations (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            delegator_user_id BIGINT NOT NULL,
            delegate_user_id BIGINT NOT NULL,
            starts_on DATE NOT NULL,
            ends_on DATE NOT NULL,
            note VARCHAR(500) NULL,
            created_by_user_id BIGINT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            cancelled_at DATETIME NULL,
            cancelled_by_user_id BIGINT NULL,
            CONSTRAINT fk_delegation_delegator FOREIGN KEY (delegator_user_id) REFERENCES users(id) ON DELETE CASCADE,
            CONSTRAINT fk_delegation_delegate FOREIGN KEY (delegate_user_id) REFERENCES users(id) ON DELETE CASCADE,
            CONSTRAINT fk_delegation_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
            CONSTRAINT fk_delegation_canceller FOREIGN KEY (cancelled_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
            CONSTRAINT chk_delegation_dates CHECK (starts_on <= ends_on),
            CONSTRAINT chk_delegation_people CHECK (delegator_user_id <> delegate_user_id),
            INDEX ix_delegation_delegate (delegate_user_id, starts_on, ends_on),
            INDEX ix_delegation_delegator (delegator_user_id, starts_on, ends_on)
        ) ENGINE=InnoDB
    """)
    op.execute("""
        CREATE TABLE IF NOT EXISTS delegated_actions (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            delegation_id BIGINT NOT NULL,
            actor_user_id BIGINT NOT NULL,
            acting_for_user_id BIGINT NOT NULL,
            method VARCHAR(8) NOT NULL,
            path VARCHAR(255) NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_delegated_action_delegation FOREIGN KEY (delegation_id) REFERENCES user_delegations(id) ON DELETE CASCADE,
            CONSTRAINT fk_delegated_action_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE CASCADE,
            CONSTRAINT fk_delegated_action_for FOREIGN KEY (acting_for_user_id) REFERENCES users(id) ON DELETE CASCADE,
            INDEX ix_delegated_action_delegation (delegation_id, created_at)
        ) ENGINE=InnoDB
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS delegated_actions")
    op.execute("DROP TABLE IF EXISTS user_delegations")

"""Alembic env.py for ERIS.

Run alembic commands from the backend/ directory so that pydantic-settings
can locate backend/.env and inject the real database URL.
"""

import os
import sys
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

# Ensure `app` is importable when running alembic from backend/
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Import settings directly rather than from app.db so that importing this
# module does not create a SQLAlchemy engine or connection pool as a side
# effect. app.db creates `engine` and `SessionLocal` at module level — those
# are not needed here and would be wasted overhead for offline commands like
# `alembic history` and `alembic heads`.
from app.config import settings  # noqa: E402 — import after sys.path setup


def _db_url() -> str:
    """Build the database URL from app settings, matching app/db.py exactly."""
    return (
        f"mysql+pymysql://{settings.DB_USER}:{settings.DB_PASS}"
        f"@{settings.DB_HOST}:{settings.DB_PORT}/{settings.DB_NAME}"
    )


# Alembic Config object, providing access to values in alembic.ini
config = context.config

# Inject the real DB URL from backend app settings (reads backend/.env).
# This keeps credentials out of alembic.ini and out of version control.
config.set_main_option("sqlalchemy.url", _db_url())

# Configure Python logging from the [loggers] section of alembic.ini.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# No SQLAlchemy ORM models exist in this codebase — all queries use raw
# text(). Autogenerate is therefore disabled. Migrations must be written
# as explicit op.execute() / op.add_column() / etc. calls.
target_metadata = None


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    Emits the SQL that would be executed to stdout without connecting to
    the database. Useful for reviewing a migration before running it, or
    for generating a SQL script to pass to a DBA.

    Invoked when `alembic upgrade --sql` is used.
    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode.

    Connects to the database and applies DDL directly.
    Called for `alembic upgrade head`, `alembic stamp`, etc.

    NOTE: MariaDB DDL is non-transactional. If a migration fails mid-way,
    applied DDL cannot be automatically rolled back. Always take a
    mysqldump backup before running upgrades on real databases.
    See docs/MIGRATIONS.md for backup procedures.
    """
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()

"""
Startup check: verify the database is at the current Alembic head revision.

Fails fast with a clear RuntimeError if the database is not stamped or is
behind head. Never executes DDL and never calls alembic upgrade automatically.

Usage: call check_migration_head() once during FastAPI startup.
"""

import os

from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory

from .db import engine


def check_migration_head() -> None:
    """Raise RuntimeError if the connected database is not at Alembic head.

    Reads the alembic_version table and compares it to the revision head
    declared in migrations/versions/. Uses Alembic APIs, not the CLI.
    """
    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ini_path = os.path.join(backend_dir, "alembic.ini")
    script_location = os.path.join(backend_dir, "migrations")

    alembic_cfg = Config(ini_path)
    alembic_cfg.set_main_option("script_location", script_location)

    script = ScriptDirectory.from_config(alembic_cfg)
    expected_heads = set(script.get_heads())

    with engine.connect() as conn:
        context = MigrationContext.configure(conn)
        current_heads = set(context.get_current_heads())

    if current_heads == expected_heads:
        return

    if not current_heads:
        raise RuntimeError(
            "Database schema is not stamped with an Alembic revision. "
            "Run from backend/: alembic upgrade head"
        )

    pending = sorted(expected_heads - current_heads)
    raise RuntimeError(
        f"Database schema is behind Alembic head. "
        f"Current: {sorted(current_heads)}, Expected: {sorted(expected_heads)}, "
        f"Pending revisions: {pending}. "
        f"Run from backend/: alembic upgrade head"
    )

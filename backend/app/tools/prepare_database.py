"""Stamp only a fresh init-SQL database, then apply every Alembic migration."""
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import inspect, text

from ..db import engine


def main() -> None:
    config = Config(str(Path(__file__).resolve().parents[2] / "alembic.ini"))
    tables = set(inspect(engine).get_table_names())
    if "alembic_version" not in tables:
        if not {"users", "roles", "user_roles"}.issubset(tables):
            raise RuntimeError("Database init SQL has not completed")
        with engine.connect() as db:
            for table in ("users", "submissions", "incidents", "attachments"):
                if table in tables and db.execute(text(f"SELECT 1 FROM {table} LIMIT 1")).first():
                    raise RuntimeError(f"Unversioned database contains {table}; refusing to stamp")
        command.stamp(config, "0001_baseline")
    command.upgrade(config, "head")


if __name__ == "__main__":
    main()

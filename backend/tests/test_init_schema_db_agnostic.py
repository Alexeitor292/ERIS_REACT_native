"""Regression guard for the CI 'clean base->head migration' failure:

    ERROR 1049 (42000) at line 1: Unknown database 'eris'

`database/init/010_schema.sql` (and 020_seed.sql) are the AUTHORITATIVE
fresh-install schema/seed and must be DATABASE-AGNOSTIC — the caller selects the
target DB (the MariaDB docker-entrypoint via MARIADB_DATABASE=eris, OR a
`mysql <dbname> < file.sql` target such as the CI clean-migration DB
`eris_migtest`). A hardcoded `USE eris;` / `CREATE DATABASE eris;` in these files
rebinds the connection to a specific database and breaks loading into any other
one — exactly the failure above. 001_create_db.sql is the deployment DB bootstrap
and is intentionally excluded (it creates the named database and is not loaded by
the clean-migration test).

Runs in the non-DB suite so it fails fast, before CI ever reaches a live DB.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

INIT_DIR = Path(__file__).resolve().parents[2] / "database" / "init"
# Files that must be loadable into an arbitrary target database.
DB_AGNOSTIC_FILES = ["010_schema.sql", "020_seed.sql"]

_USE = re.compile(r"^\s*USE\s+", re.IGNORECASE)
_CREATE_DB = re.compile(r"\bCREATE\s+DATABASE\b", re.IGNORECASE)


def _strip_sql_comment(line: str) -> str:
    # Remove a trailing `-- ...` line comment (keep code before it).
    idx = line.find("--")
    return line[:idx] if idx >= 0 else line


@pytest.mark.parametrize("fname", DB_AGNOSTIC_FILES)
def test_init_sql_is_database_agnostic(fname):
    path = INIT_DIR / fname
    assert path.exists(), f"authoritative init file missing: {path}"
    offenders = []
    for n, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        code = _strip_sql_comment(raw)
        if _USE.search(code) or _CREATE_DB.search(code):
            offenders.append((n, raw.strip()))
    assert not offenders, (
        f"{fname} must be database-agnostic (no USE/CREATE DATABASE); the caller "
        f"selects the target DB. Offending lines: {offenders}"
    )

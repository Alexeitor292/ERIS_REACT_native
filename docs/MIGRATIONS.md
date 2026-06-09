# ERIS Database Migrations

ERIS uses [Alembic](https://alembic.sqlalchemy.org/) to manage schema changes
after the initial baseline.

## Overview

| Layer | Purpose |
|---|---|
| `database/init/010_schema.sql` | Bootstrap schema for **fresh installs only** — defines the initial 19 tables as of baseline commit `ce447ab`. Do not add new columns here after the baseline. |
| `database/init/020_seed.sql` | Dev/bootstrap seed data (roles + local users). Idempotent; safe to re-run. |
| `backend/migrations/versions/` | Alembic revisions. All schema changes **after** the baseline live here. |
| `backend/app/main.py` `startup()` | Calls `check_migration_head()` — fails fast if DB is not at Alembic head. No DDL is executed. |

The backend uses raw SQLAlchemy `text()` queries, not ORM models. Alembic
autogenerate is disabled. All migrations are written as explicit
`op.execute("ALTER TABLE ...")` or `op.add_column(...)` calls.

## Running commands

All alembic commands must be run from the **`backend/` directory**, where
`alembic.ini` and `backend/.env` are located.

```powershell
cd backend
alembic current           # show revision the connected DB is at
alembic history --verbose # show full migration history
alembic heads             # show head revision(s)
```

Or use the helper scripts from `backend/`:

```powershell
.\migrate.ps1 current          # Windows
./migrate.sh current           # Linux / Proxmox
```

## Installing Alembic

Alembic is included in `backend/requirements.txt`. Install with:

```powershell
pip install -r requirements.txt
```

---

## Fresh install procedure

For a brand-new environment (new Docker volume, new server):

1. Start Docker infra. MariaDB will auto-run `database/init/*.sql`:
   ```powershell
   cd docker
   docker compose --env-file .env.example -f docker-compose.yml up -d
   ```

2. Start the backend at least once so the runtime shims run and confirm no
   errors. Then stop it.

3. Stamp the database to the Alembic baseline (run from `backend/`):
   ```powershell
   alembic stamp 0001_baseline
   alembic current   # should show: 0001_baseline (head)
   ```

4. Apply any pending migrations after the baseline:
   ```powershell
   alembic upgrade head
   ```

5. Start the backend normally.

---

## Existing database procedure (local dev or Proxmox)

For a database that already exists and has been used with the runtime shims:

### Step 1 — Backup first (always)

```powershell
# Local Docker
docker exec eris_mariadb mysqldump -u eris_user -p eris > backup_$(Get-Date -Format yyyyMMdd_HHmm).sql
```

```bash
# Proxmox (from docker/ directory)
docker compose --env-file .env.proxmox -f docker-compose.yml \
  exec mariadb sh -c 'mysqldump -u "$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE"' \
  > backup_$(date +%Y%m%d_%H%M).sql
```

### Step 2 — Verify shims have run

Start the backend once and confirm it starts cleanly. The runtime shims in
`startup()` are idempotent — they apply any missing columns automatically.
After the backend starts successfully, the DB is aligned with `010_schema.sql`.

Optional verification:
```powershell
docker exec eris_mariadb mysql -u eris_user -p eris \
  -e "SHOW COLUMNS FROM submission_gisa LIKE 'pavement_ground_annotation_layout_json';"
docker exec eris_mariadb mysql -u eris_user -p eris \
  -e "SHOW COLUMNS FROM incidents LIKE 'current_stage';"
```

### Step 3 — Stamp the baseline

From `backend/`:
```powershell
alembic stamp 0001_baseline
alembic current   # expected: 0001_baseline (head)
```

This inserts a row into the `alembic_version` table. No DDL is executed.

### Step 4 — Apply pending migrations

```powershell
alembic upgrade head
```

If there are no revisions after `0001_baseline`, this is a no-op.

---

## Proxmox procedure

```bash
cd /opt/ERIS_REACT_native

# 1. Pull latest
git pull

# 2. Rebuild and restart stack
cd docker
docker compose --env-file .env.proxmox -f docker-compose.yml -f docker-compose.proxmox.yml \
  up -d --build

# 3. Backup
docker compose --env-file .env.proxmox -f docker-compose.yml \
  exec mariadb sh -c 'mysqldump -u "$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE"' \
  > /opt/backups/eris_$(date +%Y%m%d_%H%M).sql

# 4. Stamp baseline (one-time, after backend has started at least once)
docker compose --env-file .env.proxmox -f docker-compose.yml -f docker-compose.proxmox.yml \
  exec backend alembic stamp 0001_baseline

# 5. Verify
docker compose --env-file .env.proxmox -f docker-compose.yml -f docker-compose.proxmox.yml \
  exec backend alembic current

# 6. Apply future migrations
docker compose --env-file .env.proxmox -f docker-compose.yml -f docker-compose.proxmox.yml \
  exec backend alembic upgrade head
```

---

## Creating new migrations

After the baseline is stamped, all schema changes go through Alembic:

```powershell
cd backend
alembic revision -m "add_column_foo_to_bar"
# Edit the generated file in migrations/versions/
# Write upgrade() and downgrade() explicitly — no autogenerate
alembic upgrade --sql head   # preview SQL first
alembic upgrade head         # apply after backup
```

Convention for migration files:
- Describe the change in the `-m` message (e.g., `add_notes_field_to_incidents`)
- Write both `upgrade()` and `downgrade()` even if downgrade destroys data — comment it clearly
- Keep each migration focused on one logical change

---

## Backup and restore

### Backup (local Docker)

```powershell
# From repo root, infra running
$ts = Get-Date -Format "yyyyMMdd_HHmm"
docker exec eris_mariadb mysqldump -u eris_user -p eris | Out-File "backup_$ts.sql"
```

### Restore (local Docker)

```powershell
Get-Content "backup_20260608_1430.sql" | docker exec -i eris_mariadb mysql -u eris_user -p eris
# Then re-stamp if alembic_version was in the backup:
alembic current
```

### Backup (Linux / Proxmox)

```bash
docker compose --env-file .env.proxmox -f docker-compose.yml \
  exec mariadb sh -c 'mysqldump -u "$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE"' \
  > backup.sql
```

### Restore (Linux / Proxmox)

```bash
docker compose --env-file .env.proxmox -f docker-compose.yml \
  exec -T mariadb sh -c 'mysql -u "$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE"' \
  < backup.sql
```

---

## MariaDB DDL rollback limitations

**MariaDB does not support transactional DDL.** This means:

- `ALTER TABLE ADD COLUMN` that has already executed cannot be rolled back,
  even if the migration script fails afterward.
- `alembic downgrade` for `ADD COLUMN` must explicitly run `DROP COLUMN`.
  This works but destroys the column's data.
- `alembic downgrade` for `DROP TABLE` or `DROP COLUMN` is destructive and
  effectively irreversible in practice.
- The `alembic_version` table is only updated after the migration Python
  function completes. If DDL succeeded but Python code after it failed, the
  version may not have been recorded — inspect with `alembic current` and
  re-stamp manually if needed.

**Rule: always take a `mysqldump` backup before running `alembic upgrade head`
on any real database.**

Previewing migrations before running them:
```powershell
alembic upgrade --sql head   # prints SQL to stdout, no DB connection needed
```

---

## Runtime shim status

Runtime ALTER TABLE shims have been removed. Both environments (local dev and
Proxmox) were confirmed stamped to `0001_baseline` before removal.

The backend now fails fast on startup if the database is not at Alembic head:

```
RuntimeError: Database schema is not stamped with an Alembic revision.
Run from backend/: alembic stamp 0001_baseline && alembic upgrade head
```

If you see this error on a new environment, follow the Fresh install or
Existing database procedure above before starting the backend.

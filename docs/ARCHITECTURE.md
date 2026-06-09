# ERIS Architecture (Verified)

## Monorepo Structure

- `backend/`: FastAPI + SQLAlchemy + MariaDB + MinIO integration
- `web/`: Vite + React + React Router + ArcGIS JS (`@arcgis/core`)
- `mobile/`: Expo Router + React Native + offline queue/local draft layer + ArcGIS native bridge
- `database/init/`: SQL initialization (`001_create_db.sql`, `010_schema.sql`, `020_seed.sql`)
- `docker/`: compose definitions for local/proxmox

## Runtime Topology

From compose (`docker-compose.yml` + `docker-compose.proxmox.yml`):

- `mariadb` (source of truth DB)
- `minio` (attachment/object storage)
- `backend` (FastAPI on `:8000`)
- `web` (Nginx serving built SPA on `:5173`)
- `adminer` optional profile (`devtools`)

## Backend Composition

- Main app bootstrap: `backend/app/main.py`
- Feature routers:
  - `routes/auth.py`
  - `routes/gisa.py`
  - `routes/arcgis.py`
  - `routes/incidents.py`
  - plus `admin_users.py`, `photos.py`, and `dev_routes.py` (dev env only)

Supporting modules:

- `auth.py`: JWT + Argon2 password verify/hash
- `deps.py`: auth/role dependencies
- `permissions.py`: submission ownership/authorization checks
- `storage.py`: MinIO object put/get/presign
- `services/gisa_validation.py`: lookup/action validation
- `constants/gisa_lookups.py`: lookup catalog source

## Schema Management

Alembic is the sole owner of schema changes after the baseline:

- `database/init/010_schema.sql` — authoritative bootstrap schema for fresh installs,
  representing 19 tables as of commit `ce447ab`. Do not add new columns here after that
  baseline; use Alembic migrations instead.
- `backend/migrations/versions/0001_baseline.py` — empty Alembic checkpoint corresponding
  to the init SQL. All environments are stamped at this revision.
- `backend/app/main.py` `startup()` — calls `check_migration_head()` (via
  `backend/app/migrations_check.py`) which raises `RuntimeError` on startup if the database
  is not at Alembic head. Runtime ALTER TABLE shims have been removed.

See `docs/MIGRATIONS.md` for full procedures, backup commands, and Proxmox instructions.

## Security/Auth

- Password hashing: Argon2 (`argon2-cffi`) via `backend/app/auth.py`
- Token: JWT (`python-jose`) with `sub`, `iat`, `exp`
- Auth APIs:
  - `POST /auth/login`
  - `GET /auth/me`

## Storage Model

- Relational state in MariaDB
- File bytes in MinIO
- DB stores object metadata + keys (`attachments`, link tables)

## Frontend/Client Boundaries

- Web is primarily big-picture and review/admin portal.
- Mobile includes offline-first mechanics:
  - local drafts index/payload
  - offline op queue
  - periodic sync loop

## ArcGIS

- Web map uses ArcGIS JS SDK.
- Mission Center web map currently uses OSM basemap fallback (`web/src/components/MissionCenterMap.tsx`).
- Mobile uses native ArcGIS bridge for sketch map workflows; mission-center native launcher code exists but mobile mission-center tab has been removed in current routing.

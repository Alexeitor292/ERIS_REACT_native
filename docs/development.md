# Development

How to run ERIS on your own machine, test it, and change the database schema.
Commands are shown for PowerShell and bash where they differ. Every setting
mentioned here is described in [configuration.md](configuration.md).

## Prerequisites

- Docker Desktop (MariaDB and MinIO run in containers).
- Python 3.12 for the backend.
- Node.js 20 for the web and mobile apps.
- For the iOS app: macOS with Xcode and CocoaPods.

## 1. Start MariaDB and MinIO

```bash
cd docker
cp .env.example .env    # then replace every CHANGE_ME value
docker compose up -d
```

This starts MariaDB (port 3306), MinIO (API on 9800, console on 9801) and
Adminer (8081). All but the MinIO API listen on localhost only.

On its **first** start MariaDB runs the files in `database/init/`: it creates the
schema, the eight roles and the organization structure. It creates **no
accounts**. Before running the migrations, load the mock accounts, from the repo
root:

```bash
docker exec -i eris_mariadb sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" "$MARIADB_DATABASE"' < database/dev/030_mock_accounts.sql
```

PowerShell has no `<` redirection; pipe the file instead:

```powershell
Get-Content -Raw database\dev\030_mock_accounts.sql | docker exec -i eris_mariadb sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" "$MARIADB_DATABASE"'
```

The order matters: the organization-model migration builds each coordinator's
district coverage from the accounts it finds. After `alembic upgrade head`, put
the mock accounts in their places (roles come only from where people sit):

```bash
docker exec -i eris_mariadb sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" "$MARIADB_DATABASE"' < database/dev/040_mock_placements.sql
```
 The accounts, all with password
`password`, are listed in [roles-and-identity.md](roles-and-identity.md#mock-accounts-development-and-test-only).

A database seeded before the `mock.*` addresses can be renamed in place with
`database/dev/rename_local_accounts.sql`.

## 2. Backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1          # bash: source .venv/bin/activate
pip install -r requirements.txt       # requirements-worker.txt adds the terrain worker's GIS stack
copy .env.example .env                # bash: cp .env.example .env
```

In `backend/.env`, make `DB_PASS`, `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD`
match `docker/.env`, and set `JWT_SECRET` to any long string.

Bring the database to the current schema. This is needed once on a new
database, and again after every pull that adds a migration:

```bash
alembic stamp 0001_baseline   # new database only: marks the init schema as the baseline
alembic upgrade head
```

`migrate.ps1` and `migrate.sh` are thin wrappers that run `alembic` from
`backend/`.

Run the API with auto-reload on port 8000:

```bash
./run.sh        # PowerShell: .\run.ps1   (both run: uvicorn app.asgi:app --reload --host 0.0.0.0 --port 8000)
```

The backend **refuses to start** if the database is not at the latest migration.
Interactive API documentation is at http://127.0.0.1:8000/docs while
`ENV=dev`.

Optional helpers:

- `python -m app.tools.create_admin --email ... --name ...` creates or promotes
  an administrator (see [deployment.md](deployment.md#fresh-installation)).
- `python scripts/seed_demo_org_roster.py --i-understand-this-is-demo-data`
  fills the organization with 27 invented people (`mock.demo.*@dot.ca.gov`), so
  the office, branch and person pickers have something to show. `--remove`
  deletes them. It refuses to run when `ENV` is `production` or `prod`.
- `python -m app.worker.offline_scene_worker` runs the offline 3D terrain worker
  (needs `requirements-worker.txt`). It stops at startup unless the private
  `eris-offline-scenes` bucket exists; locally, set `OFFLINE_SCENE_DEV_MODE=true`
  to continue with a warning instead.

## 3. Web app

```bash
cd web
npm ci
cp .env.example .env      # VITE_API_BASE_URL=http://127.0.0.1:8000 is the default
npm run dev               # http://localhost:5173 (web/run.ps1 and run.sh do the same)
```

Sign in with a mock account. `VITE_*` values are read when Vite starts, so
restart `npm run dev` after changing `web/.env`.

## 4. Mobile app

The app uses the native ArcGIS Runtime SDK for iOS, so it runs as a development
build, not in Expo Go.

```bash
cd mobile
npm ci
cp .env.example .env
npx expo run:ios          # builds the native project and opens the simulator
```

`expo run:ios` generates `mobile/ios` (not committed) and installs the ArcGIS
pod through `plugins/withArcGisIos.js`. On a physical device on the same
network, set `EXPO_PUBLIC_API_URL=http://<your computer's LAN IP>:8000` and
restart Metro with `npx expo start --clear`. Without it, the app tries the Metro
host on port 8000.

The Android project builds (`npx expo run:android`), but the native map and
offline terrain screens are iOS-only.

## Tests

| Suite | Command | Needs |
| --- | --- | --- |
| Backend, no database | `python -m pytest tests -m "not db"` (from `backend/`) | `backend/.env` or the variables below |
| Backend, database | `python -m pytest tests -m db` | A **disposable** MariaDB at the latest migration, with the mock accounts |
| Web | `npm test` (from `web/`) | — |
| Web types and build | `npm run build` | — |
| Mobile | `npm test`, `npx tsc --noEmit`, `npx expo lint` (from `mobile/`) | — |

The database tests create and change records and accounts, so point them at a
throwaway database rather than the one you develop with. CI builds a fresh
MariaDB 11 for each run the same way (bash, from the repo root):

```bash
docker run -d --name eris_test_db -p 3307:3306 \
  -e MARIADB_ROOT_PASSWORD=rootpassword -e MARIADB_DATABASE=eris \
  -e MARIADB_USER=eris_user -e MARIADB_PASSWORD=testpassword mariadb:11
# once it is up:
docker exec -i eris_test_db mariadb -uroot -prootpassword eris < database/init/010_schema.sql
docker exec -i eris_test_db mariadb -uroot -prootpassword eris < database/init/020_seed.sql
docker exec -i eris_test_db mariadb -uroot -prootpassword eris < database/dev/030_mock_accounts.sql
```

Then, from `backend/`, with `DB_HOST=127.0.0.1`, `DB_PORT=3307`,
`DB_PASS=testpassword`, `JWT_SECRET=<anything>` and `ENV=dev` set in the shell:

```bash
alembic stamp 0001_baseline && alembic upgrade head
docker exec -i eris_test_db mariadb -uroot -prootpassword eris < ../database/dev/040_mock_placements.sql
python -m pytest tests -m db
```

Tests that need somebody in a role create and place them with
`tests/org_people.py` (a role can never be granted directly).

The database tests do not need MinIO. A few offline-scene tests import the GIS
packages in `requirements-worker.txt` (such as `rasterio` and `affine`); install
that file to run them.

### Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`:

- **Backend (non-DB):** compiles every module, checks that Alembic has a single
  head, and runs the non-database tests.
- **Backend (DB + offline-scene):** runs the database tests on a fresh MariaDB
  seeded as above.
- **Backend (clean base→head migration):** loads only `010_schema.sql`, stamps
  the baseline, upgrades to head, checks the result, and upgrades again to prove
  it is a no-op.
- **Worker image:** builds `backend/Dockerfile.worker` and imports its modules.
- **Web:** `npm test` and `npm run build`.
- **Mobile:** the source-contract scripts, lint, types, unit tests and an iOS
  prebuild.
- **iOS native compile:** builds the app for the simulator on macOS.
- **Compose:** renders both Compose files and asserts that the backend and worker
  never receive the browser ArcGIS key.

Four smaller workflows run further mobile source-contract checks: the Esri
offline terrain contract, the incident map location, the offline incident
location, and the site photo map.

## Changing the database schema

The schema has two sources that must stay in step:

- `backend/migrations/versions/` — Alembic revisions, one straight line of
  history. **Every schema change is a new revision.**
- `database/init/010_schema.sql` — the schema a brand-new database starts from.
  It is not complete on its own: some columns (for example the road inventory
  and elevation profile fields of `submission_gisa`) exist only through
  revisions.

A fresh install loads `010_schema.sql` and then runs every revision on top of
it, so revisions must be **idempotent** (`CREATE TABLE IF NOT EXISTS`, check
before `ALTER`): they must work whether or not `010_schema.sql` already has the
object. CI's clean base→head job proves the fresh-install path on every pull
request.

```bash
alembic revision -m "short description"   # then edit the new file in migrations/versions/
alembic upgrade head
alembic downgrade -1 && alembic upgrade head   # prove the downgrade works
```

Name new revision files `YYYYMMDD_short_name.py`, as the recent ones are. A
MariaDB DDL statement commits on its own, so a revision that fails halfway
leaves the earlier statements applied; write each step so running the revision
again finishes the job.

`database/init/020_seed.sql` holds the roles and the organization structure,
and must never create accounts (a test enforces this). Development and test
accounts belong in `database/dev/030_mock_accounts.sql`.

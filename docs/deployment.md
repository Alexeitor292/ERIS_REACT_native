# Deployment

How to run ERIS on a server, for staging or production, and keep it running.
Local development is in [development.md](development.md); every setting is
explained in [configuration.md](configuration.md).

## Environments

| Environment | Where | Purpose | Accounts |
| --- | --- | --- | --- |
| Development | A developer's machine | Writing and debugging code | Mock accounts (`database/dev/030_mock_accounts.sql`) |
| Staging | Its own server, built exactly like production | Trying a release, and rehearsing its migrations on a copy of production data, before it goes live | Real test accounts made with `create_admin` and the admin pages. Mock accounts only if the server is unreachable from outside your network. |
| Production | The production server | Live use | Real accounts only. Never load anything from `database/dev/`. |

Staging and production use the **same procedure and the same files**. Each has
its own `docker/.env.proxmox`, with its own passwords, secrets and addresses.
Every container in the stack has a fixed name (`eris_backend`, `eris_mariadb`
and so on), so staging and production cannot share one Docker host: give each
its own VM or container.

## The server stack

The production stack is `docker/docker-compose.yml` plus
`docker/docker-compose.proxmox.yml`, configured by `docker/.env.proxmox`:

| Service | Published port | What it is |
| --- | --- | --- |
| `mariadb` | 3306, localhost only | MariaDB 11. Data in the `eris_mariadb_data` volume. On its first start it loads `database/init/`: schema, roles, organization structure, and no accounts. |
| `minio` | 9800 (API, all interfaces), 9801 (console, localhost only) | File storage. Data in the `eris_minio_data` volume. |
| `minio-init` | — | One-shot job. Creates the private, versioned `eris-offline-scenes` bucket with object lock, and fails (blocking the backend and worker) if it cannot. |
| `backend` | 8000 | FastAPI (`uvicorn app.asgi:app`). Health: `GET /health`. |
| `offline-scene-worker` | — | Builds offline 3D terrain packages from the job queue. |
| `web` | 5173 | The built web app, served by nginx. Health: `GET /healthz`. |
| `adminer` | 8081, localhost only | Database browser. Only started with `--profile devtools`. |

The backend and worker receive every variable in `docker/.env.proxmox` (Compose
`env_file`). The web app's `VITE_*` values are **build arguments**: they are
baked into the image, so changing one means rebuilding `web`.

All commands below run from the repository's `docker/` directory. To keep them
short, define:

```bash
alias dc='docker compose --env-file .env.proxmox -f docker-compose.yml -f docker-compose.proxmox.yml'
```

## Server requirements

- Linux with Docker Engine and the Compose v2 plugin, plus `git`.
- At least 8 GB of RAM: the web image build gives Node a 4 GB heap.
- Disk for the two volumes (photos and offline terrain packages grow over time)
  and for backups.
- Outbound HTTPS from the worker to the USGS, Census and Caltrans GIS services
  it builds terrain packages from (see [offline-terrain.md](offline-terrain.md)).

## Fresh installation

1. **Get the code** (any path; `/opt/eris` is used here):

   ```bash
   git clone <repository-url> /opt/eris
   cd /opt/eris/docker
   cp .env.proxmox.example .env.proxmox
   ```

2. **Fill in `.env.proxmox`.** At minimum: every `CHANGE_ME` value, a long random
   `JWT_SECRET` (for example `openssl rand -hex 32`), `CORS_ORIGINS`,
   `VITE_API_BASE_URL` and `VITE_API_BASE`, `MINIO_PUBLIC_ENDPOINT` and
   `WEB_BASE_URL`. Keep `ENV=prod` and `STORAGE_URL_MODE=presigned`. See the
   [production checklist](#production-checklist).

3. **Build the images and start the database.** The first start loads
   `database/init/`, which takes a minute:

   ```bash
   dc build
   dc up -d --wait mariadb
   ```

4. **Bring the schema to the current version.** The backend refuses to start
   until this is done:

   ```bash
   dc run --rm --no-deps backend alembic stamp 0001_baseline
   dc run --rm --no-deps backend alembic upgrade head
   ```

5. **Create the first administrator.** It prompts twice for a password of at
   least 12 characters:

   ```bash
   dc run --rm --no-deps backend python -m app.tools.create_admin --email jane.doe@dot.ca.gov --name "Jane Doe"
   ```

   `--sso-only` creates an account without a password, for Entra ID sign-in once
   it is enabled. Everyone else is added from **Administration › Users** and
   then placed on the **Organization** page, which gives them their role.

6. **Start everything:**

   ```bash
   export VITE_ARCGIS_API_KEY='<browser key>'   # optional; see configuration.md
   dc up -d --build
   unset VITE_ARCGIS_API_KEY
   ```

7. **Check it:**

   ```bash
   dc ps                                  # every service Up (healthy); minio-init Exited (0)
   curl http://127.0.0.1:8000/health      # {"ok": true}
   curl http://127.0.0.1:5173/healthz
   ```

   Then sign in on the web as the administrator.

## Updating

```bash
cd /opt/eris && git pull
cd docker

# 1. Back up the database (see Backups).
dc exec -T mariadb sh -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --single-transaction --routines "$MARIADB_DATABASE"' \
  > /opt/backups/eris_$(date +%Y%m%d_%H%M).sql

# 2. Build the new images. The running services keep serving.
dc build

# 3. Apply new migrations.
dc run --rm --no-deps backend alembic upgrade head

# 4. Replace the running services and check them.
dc up -d
dc ps
curl http://127.0.0.1:8000/health
```

`alembic upgrade head` is safe to run when there is nothing new. Include the
`VITE_ARCGIS_API_KEY` shell variable in step 2 whenever the web image should
keep its ArcGIS key.

Release notes that need action:

- **Organization model (`20260911_org_model`), for servers older than it.** This
  revision gives every active user an organization profile from the office code
  stored on their account, and **refuses to run** (a `RuntimeError` naming the
  accounts) if an active user's office code matches no office. Run this pre-flight
  query first:

  ```sql
  SELECT u.id, u.email,
         UPPER(TRIM(JSON_VALUE(u.metadata_json,'$.office_code'))) AS office_code
  FROM users u
  WHERE u.is_active = 1
    AND COALESCE(TRIM(JSON_VALUE(u.metadata_json,'$.office_code')),'') <> ''
    AND UPPER(TRIM(JSON_VALUE(u.metadata_json,'$.office_code')))
        NOT IN ('WEST','NORTH','SOUTH','POLICY','SUPPORT')
  ORDER BY office_code, u.id;
  ```

  An empty result means the upgrade will pass. Otherwise correct those accounts'
  office, then upgrade. To run it, save it as `preflight.sql` next to the Compose files and:

  ```bash
  dc exec -T mariadb sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" "$MARIADB_DATABASE"' < preflight.sql
  ```

  Its `downgrade()` un-grants every viewer: it deletes the `CALTRANS_VIEWER` role
  row, and `user_roles` follows it through `ON DELETE CASCADE`. A later upgrade
  does not restore those grants.

- **Role consolidation (`20260923_roles_consolidated`).** Moves every account onto
  the seven roles and the Administrator in one step. Nobody has to sign in again,
  and every old grant is kept in `role_consolidation_audit`. Ship the matching
  mobile build at the same time: older builds hide their tabs from every account.
- **Private file storage.** A server running with `STORAGE_URL_MODE=public` should
  switch to `presigned`, then close the uploads bucket to anonymous reads:

  ```bash
  dc run --rm --entrypoint sh minio-init -c \
    'mc alias set eris http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" && mc anonymous set none eris/eris-uploads'
  ```

- **Saved layouts and formatted memos** (`20260924_user_saved_layouts`,
  `20260925_gisa_rich_memos`). Additive only; `alembic upgrade head` applies
  them. The backend image gains the `nh3` HTML sanitizer, which `dc build`
  installs.
- **Roles from the organization tree** (`20260926_org_tree`). Adds
  `org_user_profiles.tree_position` and `org_district_crew`, and places everyone
  who already holds a role (GeoTech roles into their office's tree, coordinators
  and crew at their home district). Nobody's roles change on deploy. After it,
  open **Organization**: anybody it could not place (no office or district
  known) is listed at the top of each tab; place them there. The Offices,
  Branches and Coverage pages redirect to it, and Users keeps only accounts and
  the Administrator switch.
- **Incident names** (`20260927_incident_names`). Reporters no longer type a
  title: every incident is named District-County-Route-PostMile - MM/DD/YY (the
  day it was first observed), e.g. `04-MRN-001-12.300 - 09/22/26`. The
  migration renames existing incidents the same way, replacing typed titles.
- **Incident Groups** (`20260928_incident_groups`). Event Groups are now called
  Incident Groups everywhere people read them; the page moved to
  `/incident-groups` and old `/event-groups` links redirect. Group titles saved
  with "Event Group" in them are renamed. API paths and tables are unchanged.
- **Published ports.** MariaDB (3306), Adminer (8081) and the MinIO console (9801)
  now listen on localhost only. Set `MARIADB_BIND`, `ADMINER_BIND` or
  `MINIO_CONSOLE_BIND` in `.env.proxmox` only if another machine really needs
  them.

## Rolling back

The backend only starts against the schema version its code expects, so rolling
back code means rolling back the schema too. Two ways, in order of preference:

1. **Restore the backup** taken before the update (see [Restoring](#restoring)),
   then check out the previous release and `dc up -d --build`. This is exact, and
   loses anything written since the backup.
2. **Downgrade the schema with the new code still checked out**, then check out
   the old release and rebuild:

   ```bash
   dc run --rm --no-deps backend alembic downgrade <previous revision>
   git checkout <previous release>
   dc up -d --build
   ```

   Read the revision's `downgrade()` first: some downgrades drop data that the
   next upgrade cannot recreate.

## Backups

**Database.** The MariaDB 11 image ships `mariadb-dump`, not `mysqldump`:

```bash
dc exec -T mariadb sh -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --single-transaction --routines "$MARIADB_DATABASE"' \
  > /opt/backups/eris_$(date +%Y%m%d_%H%M).sql
```

Run it from cron at least daily, and before every update. Copy the files off the
server.

**Files.** Photos, attachments, PDFs and terrain packages live in the MinIO
volume. Back it up with the stack's writers stopped:

```bash
dc stop backend offline-scene-worker
docker run --rm -v "$(docker volume ls -q | grep eris_minio_data)":/data:ro -v /opt/backups:/backup alpine \
  tar czf /backup/eris_minio_$(date +%Y%m%d_%H%M).tgz -C /data .
dc start backend offline-scene-worker
```

### Restoring

```bash
dc stop backend offline-scene-worker web
dc exec -T mariadb sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" -e "DROP DATABASE eris; CREATE DATABASE eris;"'
dc exec -T mariadb sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" eris' < /opt/backups/<file>.sql
dc up -d
```

To rehearse an update on staging, restore a production backup there first.

## HTTPS and a reverse proxy

Browsers and phones must reach three things: the web app (5173), the API (8000)
and MinIO's API (9800), because file links point straight at MinIO. Put a TLS
reverse proxy in front with one hostname for each. With Caddy:

```caddyfile
eris.example.gov {
  reverse_proxy <eris-server>:5173
}
api.eris.example.gov {
  reverse_proxy <eris-server>:8000
}
files.eris.example.gov {
  reverse_proxy <eris-server>:9800
}
```

Caddy obtains certificates automatically. Behind Cloudflare or an internal
certificate authority, give each site a `tls <cert> <key>` line instead. Then
set, in `.env.proxmox`:

```env
VITE_API_BASE_URL=https://api.eris.example.gov
VITE_API_BASE=https://api.eris.example.gov
CORS_ORIGINS=https://eris.example.gov
MINIO_PUBLIC_ENDPOINT=https://files.eris.example.gov
WEB_BASE_URL=https://eris.example.gov
```

and rebuild: `dc up -d --build`. Expose only the proxy's ports 80 and 443 to
users; do not forward 8000, 5173 or 9800 from outside. Set `API_BIND` and
`WEB_BIND` to the address the proxy connects to if the ERIS server has other
networks.

## Email

Set the `SMTP_*` variables in `.env.proxmox` and `dc up -d backend`. The approval
notice is sent right after each approval and retried at every backend start. To
also retry on a schedule, add a cron entry on the host:

```bash
*/15 * * * * cd /opt/eris/docker && docker compose --env-file .env.proxmox -f docker-compose.yml -f docker-compose.proxmox.yml exec -T backend python -m app.tools.flush_email_outbox
```

## Monitoring

- `dc ps`: every long-running service should be `Up (healthy)`.
- `dc logs -f backend` (or `web`, `offline-scene-worker`).
- `GET /health` (API) and `GET /healthz` (web).
- `GET /ops/offline-scene/health` (administrators): the worker's heartbeat and
  the job queue.

## Mobile app releases

The mobile app is built with EAS (`mobile/eas.json`):

| Profile | Use | EAS environment |
| --- | --- | --- |
| `development` | Development client for engineers | — |
| `preview` | Internal testers, pointed at staging | `preview` |
| `production` | App Store builds | `production` |

Set the API address for each environment before building, because it is baked
into the app:

```bash
cd mobile
eas env:create --environment production --name EXPO_PUBLIC_API_URL --value https://api.eris.example.gov
eas env:create --environment production --name EXPO_PUBLIC_WEB_URL --value https://eris.example.gov
eas build --profile production --platform ios
eas submit --profile production --platform ios
```

Use the `preview` environment and profile the same way for staging builds. A
build without `EXPO_PUBLIC_API_URL` cannot reach any server.

## Production checklist

- [ ] `ENV=prod` (API docs and `/dev/*` routes off).
- [ ] Unique, strong `MARIADB_ROOT_PASSWORD`, `MARIADB_PASSWORD`,
      `MINIO_ROOT_PASSWORD` and `JWT_SECRET`; none copied from an example.
- [ ] `STORAGE_URL_MODE=presigned`, `MINIO_PUBLIC_ENDPOINT` set, and the uploads
      bucket not anonymously readable.
- [ ] `CORS_ORIGINS`, `VITE_API_BASE_URL`, `VITE_API_BASE` and `WEB_BASE_URL`
      match the real addresses.
- [ ] HTTPS in front; only ports 80 and 443 reachable from users' networks.
- [ ] No file from `database/dev/` loaded; the first administrator made with
      `create_admin`.
- [ ] `VITE_ARCGIS_API_KEY` restricted to the web app's origin, if used.
- [ ] `SMTP_*` configured, if coordinators should get approval emails.
- [ ] Daily database and MinIO backups, copied off the server, and a restore
      tried once.
- [ ] Mobile builds made with `EXPO_PUBLIC_API_URL` pointing at this server.

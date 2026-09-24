# Configuration

Every setting ERIS reads, by component. All of it comes from environment
variables; nothing is configured in the database except the organization model
and accounts, which administrators edit in the app.

| Component | Where its settings come from |
| --- | --- |
| Backend API and offline-scene worker | `backend/.env` when run directly (see `backend/.env.example`), or `docker/.env.proxmox` in the server stack. Read by `backend/app/config.py`. |
| MariaDB and MinIO containers | `docker/.env` (dev, from `docker/.env.example`) or `docker/.env.proxmox` (server, from `docker/.env.proxmox.example`). |
| Web app | `VITE_*` variables at **build** time: `web/.env` for `npm run dev` and `npm run build`, or Docker build args in the server stack. |
| Mobile app | `EXPO_PUBLIC_*` variables at **build** time: `mobile/.env` locally, EAS environment variables for EAS builds. |

`VITE_*` and `EXPO_PUBLIC_*` values are compiled into the app and readable by
anyone who has it. Never put a server secret in them.

## Backend

The backend and the worker share one settings class. `DB_PASS` and `JWT_SECRET`
have no default; the process refuses to start without them.

### Core

| Variable | Default | Purpose |
| --- | --- | --- |
| `ENV` | `dev` | `dev` mounts the `/dev/*` helper routes, tolerates MinIO being down at startup, and lets `create_admin` accept `mock.*` addresses. Any other value (use `prod`) disables all three. `dev`, `development`, `local`, `test` and `testing` turn API docs on by default. |
| `LOG_LEVEL` | `INFO` | Python log level. |
| `API_DOCS_ENABLED` | unset | Forces `/docs`, `/redoc` and `/openapi.json` on (`true`) or off (`false`). Unset: on only for the development `ENV` values above. |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated web origins allowed to call the API. Set to the web app's exact origin in every deployment. |
| `WEB_BASE_URL` | `http://localhost:5173` | The web app's address, used to build links in notification emails. |
| `PUBLIC_INCLUDES_CLOSED_WITHOUT_ASSESSMENT` | `false` | When `true`, Guests can also read incidents closed at triage without an assessment. |
| `API_HOST`, `API_PORT` | `0.0.0.0`, `8000` | Read into settings but not used: `run.sh`, `run.ps1` and the Docker image all start uvicorn on port 8000 themselves. |

### Database

| Variable | Default | Purpose |
| --- | --- | --- |
| `DB_HOST` | `127.0.0.1` | MariaDB host (`mariadb` inside the server stack). |
| `DB_PORT` | `3306` | MariaDB port. |
| `DB_NAME` | `eris` | Database name. Keep `eris`: `database/init/001_create_db.sql` creates that name. |
| `DB_USER` | `eris_user` | Application user. |
| `DB_PASS` | **required** | Application user's password. |

Alembic reads the same variables (`backend/migrations/env.py`).

### Authentication

| Variable | Default | Purpose |
| --- | --- | --- |
| `JWT_SECRET` | **required** | Signing key for session tokens. Use a long random value; changing it signs everyone out. |
| `JWT_ALG` | `HS256` | Signing algorithm. |
| `JWT_EXPIRES_MINUTES` | `120` | Session length. |

Sign-in is email and password today. The database is ready for Microsoft Entra
ID, but no single sign-on setting exists yet; see
[roles-and-identity.md](roles-and-identity.md).

### File storage (MinIO)

| Variable | Default | Purpose |
| --- | --- | --- |
| `MINIO_ENDPOINT` | `http://localhost:9000` | How the backend reaches MinIO: `http://minio:9000` in the server stack, `127.0.0.1:9800` for local dev. A value without a scheme is treated as plain HTTP. |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | `minioadmin` / `minio_root_password` | MinIO credentials; the same values the MinIO container is started with. |
| `MINIO_BUCKET` | `eris-uploads` | Photos, attachments and generated PDFs. The API creates it at startup. |
| `MINIO_PUBLIC_ENDPOINT` | unset | The MinIO address browsers and phones use, e.g. `https://files.example.gov` or `http://<server>:9800`. File URLs are signed against it, so set it in every deployment where clients are not on the backend's host. |
| `STORAGE_URL_MODE` | `presigned` | `presigned`: file URLs are signed and expire after 15 minutes. `public`: permanent URLs that work only if the bucket is made anonymously readable. **Use `presigned` in production.** |
| `MINIO_REGION` | `us-east-1` | Region used to sign URLs. Change it only if MinIO runs with another region. |
| `MINIO_OFFLINE_SCENES_BUCKET` | `eris-offline-scenes` | Private, versioned bucket for offline 3D terrain packages. In the server stack, `minio-init` creates it with object lock and refuses to continue if it is not private. |

Road-inventory packages are stored in a bucket named `road-inventory`. The name
is fixed in code, and the API creates the bucket on first use.

### Email notifications

ERIS emails one notice today: the district coordinator hears when an assessment
is approved. Email is **off while `SMTP_HOST` is unset**; the notice is still
recorded and shown in the app. When a relay is configured, delivery is attempted
right after the approval, and anything left over is retried at every API start. Addresses that
start with `mock.` are never handed to a real relay.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SMTP_HOST` | unset | Relay host. The master switch. |
| `SMTP_PORT` | `587` | Relay port. |
| `SMTP_USER` / `SMTP_PASSWORD` | unset | Relay login, if required. |
| `SMTP_FROM` / `SMTP_FROM_NAME` | `eris-no-reply@dot.ca.gov` / `ERIS` | Sender. |
| `SMTP_STARTTLS` | `true` | Upgrade to TLS after connecting. |
| `SMTP_SSL` | `false` | Implicit TLS (usually port 465). Mutually exclusive with `SMTP_STARTTLS`. |
| `SMTP_TIMEOUT_S` | `10` | Connection timeout. |
| `SMTP_MAX_RECIPIENTS_PER_FLUSH` / `SMTP_FLUSH_BUDGET_S` | `25` / `30` | Caps on one delivery run. |
| `SMTP_MAX_ATTEMPTS` | `5` | Attempts per message before giving up. |
| `SMTP_BACKLOG_MAX_AGE_HOURS` | `24` | Messages older than this are never sent, so turning email on late does not flood inboxes with history. |
| `MAIL_DEV_DUMP_DIR` | unset | With `SMTP_HOST` unset, write each message as an `.eml` file here instead (development and CI). |

To retry undelivered messages on a schedule, run
`python -m app.tools.flush_email_outbox` from cron (see
[deployment.md](deployment.md#email)).

### Push notifications (mobile app)

The notification feed (the web portal's bell and the mobile app's
Notifications screen) works without any setting. Push only adds the phone's
lock-screen alert, sent through Expo's push service to the phones people signed
in on. It is **off unless `EXPO_PUSH_ENABLED=true`**.

| Variable | Default | Meaning |
| --- | --- | --- |
| `EXPO_PUSH_ENABLED` | `false` | Start the push sender with the API. |
| `EXPO_ACCESS_TOKEN` | unset | Only if the Expo project requires an access token for push. |
| `EXPO_PUSH_URL` | Expo's endpoint | Override for testing. |

Phones register through the mobile app, which needs the `expo-notifications`
module and push credentials in EAS (Apple push key; Firebase for Android).

### ArcGIS (mobile runtime)

Served to signed-in mobile clients by `GET /arcgis/runtime-config`. These are
server-side values; never reuse them as the web's `VITE_ARCGIS_API_KEY`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARCGIS_RUNTIME_ENABLED` | `false` | Turns the runtime configuration on. The Esri offline-scene builder also requires it. |
| `ARCGIS_API_KEY` | unset | ArcGIS API key for the native runtime. |
| `ARCGIS_LICENSE_KEY` / `ARCGIS_LICENSE_EXPIRES_AT` | unset | Runtime license string and its expiry. |
| `ARCGIS_MMPK_URL` | unset | URL of an offline mobile map package, if one is published. |
| `ARCGIS_CONFIG_OFFLINE_TTL_HOURS` | `168` | How long the phone may use a cached configuration while offline. |

### Postmile lookup (server side)

`POSTMILE_FEATURE_LAYER_URL` (unset) and `POSTMILE_ROUTE_FIELD`,
`POSTMILE_PM_FIELD`, `POSTMILE_COUNTY_FIELD`, `POSTMILE_DISTRICT_FIELD`,
`POSTMILE_WHERE` and `POSTMILE_SEARCH_DISTANCE_METERS` (120) configure the
server's own route/postmile lookup: `GET /geo/enrich-point` (a point to district,
county, route and postmile) and the road bearing for a technical form. Unset,
those return no postmile data. The web and mobile apps' own location forms query
the public Caltrans postmile layer directly and do not depend on these.

### Roadway encroachment (technical form)

The technical form's **Roadway encroachment** measurement (Lr and Wr) rebuilds the
road from a centerline and the road inventory. The server fetches the centerline;
nothing needs credentials.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ROADWAY_CENTERLINE_SOURCE` | `caltrans_shn` | `caltrans_shn` (Caltrans SHN Lines, keyed by county, route and postmile like the inventory), `census_tigerweb` or `caltrans_crs`. |
| `ROADWAY_SHN_LINES_URL` | public Caltrans SHN Lines layer | Change only to use a mirror. |
| `ROADWAY_FETCH_TIMEOUT_S` | `20` | Per-request timeout for the centerline source. |

`census_tigerweb` uses `OFFLINE_SCENE_TIGERWEB_BASE_URL` and `caltrans_crs` uses
`OFFLINE_SCENE_CALTRANS_ROADS_URL`.

### Offline 3D terrain packages

These govern the offline-scene worker (see [offline-terrain.md](offline-terrain.md)).
The ones an operator is likely to change:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OFFLINE_SCENE_DEV_MODE` | `false` | `true` downgrades bucket-posture failures to warnings. Development only. |
| `OFFLINE_SCENE_MAX_RADIUS_M` | `3000` | Largest area radius a package may cover (hard ceiling 8000 m). |
| `OFFLINE_SCENE_MAX_PACKAGE_MB` | `512` | Largest package the API registers or serves. |
| `OFFLINE_SCENE_WORKER_POLL_SECONDS` | `5` | How often an idle worker looks for jobs. |
| `OFFLINE_SCENE_JOB_STALE_SECONDS` | `900` | A running job silent this long is put back in the queue. |
| `OFFLINE_SCENE_DOWNLOAD_TTL_SECONDS` | `900` | Lifetime of a package download link. |
| `OFFLINE_SCENE_ROADS_ENABLED` | `true` | Package road context. |
| `OFFLINE_SCENE_ROAD_SOURCE` | `eris_internal` | Where road lines come from: `none`, `eris_internal`, `census_tigerweb`, `arcgis_feature_service` (needs `OFFLINE_SCENE_ROAD_SOURCE_URL`) or `caltrans_crs`. |
| `OFFLINE_SCENE_ROADS_REQUIRED` | `false` | `true` fails a job whose road data cannot be fetched instead of shipping without roads. |
| `OFFLINE_SCENE_ROAD_FALLBACK_SOURCE` | empty | Optional second road source. |
| `OFFLINE_SCENE_IMAGERY_ENABLED` | `false` | Package aerial imagery (USGS NAIP by default). |

The remaining `OFFLINE_SCENE_*` variables tune the terrain grid, road sources
(TIGERweb, Caltrans CRS paging), divided-highway pairing (`OFFLINE_SCENE_PAIR_*`),
route chaining (`OFFLINE_SCENE_ROUTE_CHAIN_*`) and tiled imagery
(`OFFLINE_SCENE_IMAGERY_*`). Their defaults and meaning are commented in
`backend/app/config.py`; the defaults are the tested values, so change them only
with a reason. The design behind the road settings is in
[decisions/adr-offline-road-context-source.md](decisions/adr-offline-road-context-source.md)
and [decisions/adr-divided-highway-corridor-pairing.md](decisions/adr-divided-highway-corridor-pairing.md).

## Server stack (`docker/.env.proxmox`)

Besides every backend variable above, the Compose files read:

| Variable | Used by | Purpose |
| --- | --- | --- |
| `TZ` | all containers | Time zone (default `America/Los_Angeles`). |
| `MARIADB_ROOT_PASSWORD`, `MARIADB_DATABASE`, `MARIADB_USER`, `MARIADB_PASSWORD` | MariaDB | Created on the database's first start only. The stack passes `MARIADB_*` to the backend as `DB_*`, so do not set `DB_*` separately. |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | MinIO, backend, worker | Must match; set once, before the first start. |
| `VITE_API_BASE_URL` | web build | The API address browsers use (e.g. `https://api.example.gov`). Required. |
| `VITE_API_BASE` | web build | Older alias of `VITE_API_BASE_URL`; set it to the same value. |
| `VITE_CALTRANS_HIGHWAYS_URL`, `VITE_CALTRANS_POSTMILE_LAYER_URL`, `VITE_GOOGLE_MAPS_EMBED_KEY` | web build | Optional web settings (see [Web app](#web-app)). |
| `VITE_ARCGIS_API_KEY` | web build | Browser ArcGIS key. Pass it as a **shell variable** at build time rather than in this file, because the backend loads the whole file. |
| `API_BIND`, `WEB_BIND` | backend, web | Interface the API (8000) and web (5173) ports are published on. Default `0.0.0.0`. |
| `MARIADB_BIND`, `ADMINER_BIND`, `MINIO_CONSOLE_BIND` | MariaDB, Adminer, MinIO console | Default `127.0.0.1`: not reachable from other machines. |

MinIO's API port (9800) is always published on every interface, because file URLs
point at it.

## Web app

Read at build time (`npm run dev`, `npm run build`, or the web Docker image).

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `http://127.0.0.1:8000` | Backend address. |
| `VITE_API_BASE` | — | Older alias, used only if `VITE_API_BASE_URL` is unset. |
| `VITE_ARCGIS_API_KEY` | empty | Browser-safe ArcGIS key for the 3D terrain view. Optional in development; set it in production and restrict it to the site's origin in the ArcGIS dashboard. |
| `VITE_CALTRANS_POSTMILE_LAYER_URL` | public Caltrans SHN Postmiles Tenth layer | Layer the "Report an incident" form uses to convert between coordinates and route/postmile. Change only to use a mirror. |
| `VITE_CALTRANS_HIGHWAYS_URL` | empty | Optional Caltrans freeways and expressways map overlay. Empty: no overlay, and no request to that service. |
| `VITE_GOOGLE_MAPS_EMBED_KEY` | empty | Optional. Shows Street View inside the report form; without it Street View opens in a new tab. Restrict the key to the site's domain. |

## Mobile app

Read at build time from `mobile/.env`, or from EAS environment variables for EAS
builds (`eas.json` loads the `preview` and `production` environments for those
profiles).

| Variable | Default | Purpose |
| --- | --- | --- |
| `EXPO_PUBLIC_API_URL` | derived | Backend address. **Required for every build that runs away from your desk.** Unset, the app tries the Metro bundler's host on port 8000, then `10.0.2.2:8000` on Android, then `127.0.0.1:8000`, which only works in local development. |
| `EXPO_PUBLIC_WEB_URL` | unset | Web app address, for "Open full 3D map". Unset disables that action. |
| `EXPO_PUBLIC_CALTRANS_POSTMILE_LAYER_URL` | public Caltrans SHN Postmiles Tenth layer | Postmile layer for online location lookups. |
| `EXPO_PUBLIC_ARCGIS_MMPK_URL` / `EXPO_PUBLIC_ARCGIS_MMPK_PATH` | unset | An offline mobile map package to preload, if you publish one. |

Session tokens are kept in the device's secure storage (`expo-secure-store`).

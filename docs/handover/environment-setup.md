# Environment setup and configuration worksheet

Reviewed against the repository on **2026-11-13**. ERIS owner: **Deh Jeng Jang**.
Caltrans staging and production infrastructure has not yet been assigned. The
Campos Labs service is personal rehearsal infrastructure, not Caltrans staging.
Record assigned values and evidence in the [acceptance record](acceptance.md).
Store passwords and private keys in the approved secret store; record references
to them here, never their values.

## Choose the environment

| Item | Local development | Caltrans staging | Caltrans production |
| --- | --- | --- | --- |
| Purpose | Develop with invented data | Validate releases, identity, recovery and devices | Operate the accepted service |
| Procedure | [Getting started](../development/getting-started.md) | [Podman first installation](../operations/caltrans-podman.md#first-installation) | Same Podman installation, after staging acceptance |
| Runtime | Compose DB/storage; Python API; Vite web | Dedicated Linux host/service account, rootless Podman | Separate host/service account and volumes |
| `ENV` | `dev` | `prod` | `prod` |
| Browser/API | `http://localhost:5173` and same-origin `/api` | `https://<staging-web>/api` | `https://<production-web>/api` |
| Signed file endpoint | `http://127.0.0.1:9800` | `https://<staging-files>` | `https://<production-files>` |
| Authentication | `LOCAL_LOGIN_ENABLED=true`, `ENTRA_ENABLED=false` | Entra staging registration; local login off | Entra production registration; local login off |
| Data | `database/dev` mock accounts only here/test DBs | Synthetic test records, or an explicitly authorized data copy | Real accounts; never seed `database/dev` |
| Releases | Working source | Five signed image digests | The digests proven on staging |

Use separate environment files, keys, DBs, object volumes and backup destinations
for staging and production. With the default pod name and ports, use separate
hosts; do not launch both default deployments under one service account.

## Local development: exact values that must agree

Create `deploy/compose/.env`, `backend/.env`, and `web/.env` from their adjacent
examples. Run all commands from the directories named in the getting-started
guide; each new terminal starts from the repository root.

| Setting | Infrastructure file | Application file |
| --- | --- | --- |
| Database name | `MARIADB_DATABASE=eris` | `DB_NAME=eris` |
| Database user | `MARIADB_USER=eris_user` | `DB_USER=eris_user` |
| Database password | `MARIADB_PASSWORD=<generated local value>` | `DB_PASS=<same value>` |
| Database host/port | Compose publishes localhost 3306 | `DB_HOST=127.0.0.1`, `DB_PORT=3306` |
| S3 credentials | `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Same two values |
| S3 endpoints | Compose publishes 9800 | `S3_ENDPOINT=http://127.0.0.1:9800`, `S3_PUBLIC_ENDPOINT=http://127.0.0.1:9800` |
| Upload bucket | Default `eris-uploads` | `S3_BUCKET=eris-uploads` |
| Private terrain bucket | Provisioned with `app.storage_bootstrap` | `S3_OFFLINE_SCENES_BUCKET=eris-offline-scenes` |
| Authentication | No infrastructure setting | `JWT_SECRET=<random local value>`, `LOCAL_LOGIN_ENABLED=true`, `ENTRA_ENABLED=false` |
| Browser origin | Vite on 5173 | `CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173` |
| Browser routing | `web/.env` | `VITE_API_BASE_URL=/api`, `VITE_DEV_API_TARGET=http://127.0.0.1:8000` |

Generate secrets with `python -c "import secrets; print(secrets.token_hex(32))"`.
The DB root password is separate from the application password. Changing
MariaDB bootstrap env values after a volume exists does not change DB users;
change the DB credentials explicitly or recreate only disposable local volumes.

Follow this order: infrastructure healthy → mock accounts → baseline stamp on
a fresh database only → migrations → mock placements → storage bootstrap → API
and web. Install `backend/requirements-worker.txt` and run the terrain worker
when testing terrain generation. Normal API startup alone does not process jobs.
Check `/api/health` through Vite, sign in, create a report, upload/download a
photo, and restart without losing the record.

## Hosted setup: required files and values

Files live in `deploy/podman/`. Copy examples separately on each host. All
runtime secret files require mode 600; `secrets/` requires mode 700.

| File | Values to assign | Supplier / validation |
| --- | --- | --- |
| `db.env` | `MARIADB_ROOT_PASSWORD`, `MARIADB_DATABASE`, `MARIADB_USER`, `MARIADB_PASSWORD` | IT; DB password must equal `app.env` `DB_PASS` |
| `storage.env` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET` | IT; equal `app.env` `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` |
| `app.env` DB | `DB_HOST=127.0.0.1`, `DB_PORT=3306`, matching DB name/user/password | Pod containers share the loopback network |
| `app.env` files | `S3_ENDPOINT=http://127.0.0.1:8333`, `S3_PUBLIC_ENDPOINT=https://<files>`, private bucket names, `STORAGE_URL_MODE=presigned` | IT; public signed GET must work without an ERIS bearer header |
| `app.env` security | `ENV=prod`, `API_DOCS_ENABLED=false`, random `JWT_SECRET` (at least 32 characters), `OFFLINE_SCENE_DEV_MODE=false` | API production checks; never reuse personal/local secrets |
| `app.env` sessions | `SESSION_IDLE_MINUTES=30`, `SESSION_ABSOLUTE_MINUTES=720` initially | IT/security to confirm policy; absolute maximum 720 |
| `app.env` URLs | `WEB_BASE_URL=https://<web>`, `CORS_ORIGINS=https://<web>` | Same browser origin; do not configure a separate browser API origin |
| `app.env` identity | `LOCAL_LOGIN_ENABLED=false`, `ENTRA_ENABLED=true`, tenant/client UUIDs, authority host, `ENTRA_REDIRECT_URI=https://<web>/api/auth/entra/callback` | Identity team registers this exact HTTPS redirect |
| `secrets/` and `app.env` certificate | `entra-client.crt`, `entra-client.key`; container paths `/run/secrets/eris/entra-client.crt` and `/run/secrets/eris/entra-client.key` | Certificate uploaded to Entra; private key stays on host/secret store; `cert-check` |
| `app.env` proxy policy | `AUTH_RATE_LIMIT_PER_MINUTE`, `TRUSTED_PROXY_HOPS` | IT verifies actual forwarded-for chain; example assumes gateway plus pod nginx |
| `bootstrap.env` | First admin email/name and `ERIS_BOOTSTRAP_ADMIN_ENTRA_OBJECT_ID` | Identity team supplies user object ID, not app ID; delete after first successful start |
| `images.env` | Five `ERIS_*_IMAGE` references from Jenkins `release-images.env`; `ERIS_REQUIRE_DIGESTS=true` | Approved Harbor digests and cosign signature policy; do not use example tags |
| `release.env` | `ERIS_BACKUP_ROOT`, `ERIS_PUBLIC_URL=https://<web>`, `ERIS_FILES_URL=https://<files>`, `ERIS_VERIFY_PROFILE=production` | IT; backup path is private with enough space; both public URLs must be set |

Production-required examples are templates, not ready-to-use credentials. Some
settings are optional and intentionally absent from `app.env.example`; add the
needed values using the [complete configuration reference](../operations/configuration.md).

## Feature-specific decisions

| Feature | What to set | Acceptance |
| --- | --- | --- |
| Web maps | Public, origin-restricted `VITE_ARCGIS_API_KEY` supplied at web build time | [Map licensing](../operations/map-licensing.md); test each environment's origin |
| Native maps | `ARCGIS_RUNTIME_ENABLED`, separate `ARCGIS_API_KEY`, valid Swift SDK 200.x `ARCGIS_LICENSE_KEY` | Test maps and offline use on a Caltrans device; 100.x licenses do not cover 200.x |
| iOS Entra | `ENTRA_MOBILE_CLIENT_ID`, `ENTRA_API_SCOPE` matching exposed `access_as_user` scope; MSAL redirect/bundle registration | [iOS specification](../development/ios.md); actual device and Conditional Access test |
| Push | `APNS_ENABLED=true`, `.p8` key file, key/team IDs, `APNS_TOPIC` matching bundle ID | Xcode debug uses sandbox tokens; enterprise uses production tokens |
| Email | SMTP relay/port/from/TLS and credentials if required | Approval email delivered; scheduled outbox retry configured |
| Terrain | Worker running; private bucket verified; approved road/elevation/imagery sources and egress | Generate, download, verify and open a package offline |
| Guided demo | Build and host `deploy/demo` separately, then `VITE_GUIDED_DEMO_ENABLED=true` | [Guided demo guide](../user-guides/guided-demo.md); production API/data never used |

`VITE_*` values are public build inputs. Rebuild the web image to change them;
changing runtime env alone cannot change an existing browser bundle. Promote
the same digests only when the built browser key is valid for both staging and
production origins. Assign per-environment server settings at runtime.

## Network and startup acceptance

IT must provide DNS and trusted TLS for both hostnames. The gateway forwards the
web host to pod port 8080 with `/api/` intact; pod nginx strips that prefix once.
The file host forwards to 9800 preserving signed Host, path, query and encoding.
Publish neither DB nor API/admin internals. Provide HSTS, request size limits
above `MAX_UPLOAD_MB`, and timeouts for uploads and terrain downloads.

Allow egress for the selected Entra authority, Harbor, approved GIS sources,
backup target, and optional SMTP/APNs. The Podman runbook lists the network
boundaries. Do not copy old Campos Labs proxy rules without adjusting hosts.

After installation: remove `bootstrap.env`, establish two Entra-linked admins
who have each signed in, then run `cert-check`, `handover-check`, and
`ERIS_VERIFY_PROFILE=production bash deploy/podman/verify-rehearsal.sh <web-https-url> <files-https-url>`.
Run a restore drill and complete [acceptance](acceptance.md) before go-live.

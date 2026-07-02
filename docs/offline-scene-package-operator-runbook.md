# Operator runbook: offline 3D scene packages (automatic `eristerrain` + optional `.mspk`)

> **PRIMARY PATH IS NOW AUTOMATIC.** ERIS generates a bounded offline 3D package
> on demand (USGS 3DEP terrain → `eristerrain` bundle) via the `offline-scene-worker`
> service — a user just taps **Prepare offline 3D area**. No desktop GIS, no manual
> clipping/hashing/upload. See the "automatic package generation pipeline" addendum
> in `docs/adr-native-offline-3d-terrain-mobile.md`.
>
> This runbook now covers **(a) one-time private bucket provisioning** (still
> required) and **(b) the optional ADMIN manual-override path** for registering an
> externally-authored enterprise **`.mspk`**. The automatic path needs only step 0.

Audience: ERIS GIS operators / admins. The **manual `.mspk`** workflow below is an
optional override; ERIS provides storage, catalog, verification, secure delivery,
automatic generation, and mobile handling.

Lifecycle: **author (ArcGIS Pro) → upload (private MinIO) → register (ERIS ADMIN) →
field download + airplane-mode test → retire/replace**.

---

## 0. Deployment (ZERO manual steps) + private bucket bootstrap

The full stack comes up with one command; the private offline-scenes bucket is
provisioned automatically — **no host-side script to remember**.

```sh
cd docker
# One-time: copy the env template and fill in secrets (see "Required env" below).
cp .env.proxmox.example .env.proxmox && $EDITOR .env.proxmox
docker compose --env-file .env.proxmox -f docker-compose.yml -f docker-compose.proxmox.yml up -d --build
```

**Bucket bootstrap (`minio-init`):** a one-shot init service (`minio/mc`) runs the
fail-closed `docker/scripts/bootstrap-offline-scenes-bucket.sh` **before** backend
and `offline-scene-worker` start (they `depends_on: minio-init:
service_completed_successfully`). It creates `eris-offline-scenes` **`mc mb
--with-lock`** (object lock + versioning) only if absent, verifies anonymous access
is `none` and versioning is `Enabled`, and **exits nonzero** (blocking the whole
stack) if the bucket cannot be made private + immutable. It never touches the
uploads bucket and never recreates an existing one.

**Immutability — accurate wording:** ERIS relies on **application-level
immutability**: canonical, versioned, never-overwritten object keys
(`submissions/{id}/{version}/scene.{ext}`) plus a strictly private bucket policy.
The bucket is created with **object lock enabled (capability) + versioning**; a
governed **WORM retention period** (e.g. `mc retention set`) is a separate operator
decision and is **not** implied by versioning alone. Do not describe versioning by
itself as WORM.

**Standalone MinIO (non-compose):** if MinIO is managed outside this compose stack,
run the equivalent one-time script yourself:

```sh
MINIO_ENDPOINT=http://<minio-host>:9800 MINIO_ROOT_USER=<u> MINIO_ROOT_PASSWORD=<p> \
  sh docker/scripts/create-offline-scenes-bucket.sh
```

### Required env (docker/.env.proxmox)

| Var | Purpose |
|---|---|
| `MARIADB_*` | DB name/user/password (backend + worker share). |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | MinIO credentials (backend/worker/init only; **never** sent to mobile). |
| `MINIO_OFFLINE_SCENES_BUCKET` | Private bucket name (default `eris-offline-scenes`). |
| `OFFLINE_SCENE_DEV_MODE` | `false` in prod → MinIO posture problems fail closed. |
| `OFFLINE_SCENE_MAX_RADIUS_M` | Single authoritative AOI ceiling (default `3000`). |
| `OFFLINE_SCENE_MAX_PACKAGE_MB` | Max registered/downloadable package size (default `512`). |
| `VITE_ARCGIS_API_KEY` | Browser-only web build arg — **must NOT** be in this env file (supply as a shell var at web build). |

### Worker health checks (operations)

- `GET /ops/offline-scene/health` (**ADMIN**) → `{healthy, bucket:{name,status},
  queue:{queued,running,failed}, workers:[{worker_id, age_seconds, alive, ...}],
  orphaned_objects_unresolved, dev_mode}`. Sanitized — no MinIO creds/endpoints.
  `healthy` is true when the bucket is present AND at least one worker heartbeat is
  fresh.
- Workers write a durable heartbeat every poll (even when idle) to
  `offline_scene_worker_heartbeats`; structured logs carry `worker_id / job_id /
  submission_id / stage / package_version`.
- Concurrency = **worker replicas** (scale the `offline-scene-worker` service); jobs
  are claimed with `FOR UPDATE SKIP LOCKED`, so replicas never double-process.

### Rollback / retry

- **Failed job:** `POST /submissions/{id}/gisa/offline-scene-package/job/retry`
  (edit permission) re-queues a `FAILED` job. Stale running jobs (dead worker) are
  auto-requeued after `OFFLINE_SCENE_JOB_STALE_SECONDS`.
- **Cancel:** `.../job/cancel` is authoritative at every stage — a cancelled job is
  never marked READY and never creates a READY catalog row.
- **Bad package already READY:** it is immutable; publish a **new** `package_version`
  (auto path: re-run Prepare; manual path: register a new version). ERIS retires the
  prior READY row (kept for audit) and serves the newest READY.
- **Bucket/stack rollback:** `docker compose ... down` then re-`up` re-runs
  `minio-init` idempotently; an existing correctly-postured bucket is accepted as-is.

### Package lifecycle & cleanup

- **Orphaned objects:** if a job is cancelled after the object upload but before
  registration, the object is recorded in `offline_scene_orphaned_objects`
  (unresolved) and is **never** referenced by a READY row (not downloadable). An
  operator reconciles/removes these out-of-band, honoring the bucket's
  retention/versioning controls, and marks the row `resolved`. The unresolved count
  surfaces in the ops health endpoint.
- **Retire/replace:** see §10.
- **Device cleanup:** users delete local packages from **Settings → Offline 3D
  terrain areas**; the app also clears packages older than its stale threshold.

---

## 1. Create a bounded incident-area scene in ArcGIS Pro

1. New **Local Scene** (not Global) for a small, bounded area around the incident
   (e.g. the incident ± ~1.5 km, or a short route segment). **Do not** package the
   whole district/state.
2. Set the scene's **clipping extent** to the incident bounds you intend (record
   `min/max lat/lon`, `center lat/lon`, and `radius_m` — you will register these).

## 2. Add USGS 3DEP as the elevation source

1. Obtain the **USGS 3DEP raster DEM** for the area (e.g. 1 m / 10 m DEM from The
   National Map / 3DEP). Note the **dataset, version/published date, resolution**
   (you will register these as `elevation_dataset` / `elevation_version` /
   `elevation_resolution`).
2. In **Scene Properties → Elevation Surface → Ground**, add the 3DEP raster as the
   **elevation source** (replace the default world elevation so it is **local**).

## 3. Use an approved offline basemap / imagery

1. Use a **licensed** local basemap/imagery you are permitted to redistribute
   offline — Caltrans/enterprise imagery, an Esri offline-enabled subscription
   basemap, or another approved local tile package (TPK/VTPK). **Do not** package
   public streamed Esri/Google imagery you cannot license for offline storage.
2. Record the source (you will register it as `basemap_or_imagery_source`).

## 4. Match coordinate systems

Ensure the **scene, elevation surface, and basemap/imagery share a consistent
coordinate system** (typically WGS84 / Web Mercator for mobile). Mismatched CS is
the most common cause of misaligned terrain/imagery in the field.

## 5. Create a mobile-optimized, fully-offline .mspk

1. **Map/Scene → Package → Create Mobile Scene Package**.
2. Choose **mobile-optimized** output.
3. **Exclude online/referenced layers** — every layer must be local so the package
   works with **no network**. Remove or localize any web/elevation/imagery service
   references.
4. Output a single `scene.mspk`.

## 6. Calculate SHA-256

ERIS verifies the hash before marking the package READY.

```sh
# macOS
shasum -a 256 scene.mspk
# Linux
sha256sum scene.mspk
# Windows PowerShell
Get-FileHash scene.mspk -Algorithm SHA256
```
Record the 64-hex digest and the exact byte size (`stat`/`Get-Item .Length`).

## 7. Upload to private MinIO (immutable key)

Objects are **immutable** — never overwrite. Use a **versioned** key:

```sh
# key: submissions/{submission_id}/{package_version}/scene.mspk
mc cp scene.mspk erisminio/eris-offline-scenes/submissions/123/v2026-06-27a/scene.mspk
```
Pick a unique `package_version` per build (e.g. a date + letter). A replacement is
a **new** version with a **new** key.

## 8. Register the package in ERIS (ADMIN)

`POST /admin/offline-scene-packages` (ADMIN token). ERIS HEADs the object, checks
size, verifies SHA-256, then marks it READY and **retires** any prior READY
version for the submission.

```sh
curl -sS -X POST "$ERIS_API/admin/offline-scene-packages" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "submission_id": 123,
    "package_version": "v2026-06-27a",
    "size_bytes": 41943040,
    "sha256": "<64-hex>",
    "min_lat": 38.4865, "min_lon": -121.5172,
    "max_lat": 38.5135, "max_lon": -121.4828,
    "center_lat": 38.5, "center_lon": -121.5, "radius_m": 1500,
    "elevation_source": "USGS_3DEP",
    "elevation_dataset": "USGS 3DEP 1m DEM",
    "elevation_version": "2024",
    "elevation_resolution": "1m",
    "basemap_or_imagery_source": "Caltrans enterprise imagery (licensed offline)",
    "content_signature": "<from descriptor>",
    "notes": "Initial package for SR-XX PM 5.0 slipout"
  }'
```
`object_key` is optional — when omitted ERIS derives
`submissions/{submission_id}/{package_version}/scene.mspk`. The endpoint rejects:
missing object, size mismatch, SHA-256 mismatch, duplicate version, invalid bounds,
and non-ADMIN callers.

## 9. Test download + Airplane Mode (field device)

1. On an **EAS development build** (the native viewer + integrity bridge require it),
   open the submission → Measurements → **3D Terrain**.
2. **Download offline 3D area** (watch progress; try **Pause/Resume**). ERIS mints a
   short-lived presigned URL; the file downloads to a temporary `.part`, is verified
   (size + SHA-256 + real `.mspk` load) and atomically promoted to **Downloaded**.
3. **Enable Airplane Mode.** Tap **Open native 3D terrain** → confirm, with **no
   network**: terrain, imagery, incident marker, overlays, zoom/orbit/tilt, compass
   (North), and Reset.

## 10. Retire / replace a package

To replace: author a new `.mspk`, upload under a **new** `package_version` key, and
register it. ERIS automatically sets the prior READY row to **RETIRED**
(`retired_at` recorded) — retired rows remain for audit; the descriptor always
serves the **newest READY** package. The mobile app detects the changed content
signature and offers **Update**. Delete the device copy from **Settings → Offline
3D terrain areas** or the per-incident **Delete**.

## 11. Source attribution requirements

Always register accurate attribution: `elevation_source` (USGS_3DEP),
`elevation_dataset`/`version`/`resolution`, and `basemap_or_imagery_source`. The
mobile UI surfaces these so the field user can see **exactly** which elevation and
imagery they are viewing. Honor the imagery provider's attribution/licensing terms
for offline redistribution.

## Secure-download model (reference)

- Mobile never receives MinIO credentials and the bucket is never anonymous.
- The descriptor returns a **protected ERIS path** (`download_path`), not a raw URL.
- `GET /submissions/{id}/gisa/offline-scene-package/download` mints a **short-lived
  presigned URL** (default **900 s / 15 min**, `OFFLINE_SCENE_DOWNLOAD_TTL_SECONDS`)
  only after the role/access check.
- **Expiry/retry:** if a signed URL expires mid-download, the app re-requests the
  descriptor/grant to get a fresh URL and resumes/restarts. Pause/resume state
  (including resumable data) is persisted across app restarts.

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

**Road-source attribution.** Each packaged `roads.geojson` records truthful provenance
in `context_layers.roads.source` (`provider`, `dataset`, `attribution`, `service`,
`retrieved_at`). Honor the source's terms:
- `census_tigerweb` → "U.S. Census Bureau" (development context; never labelled Caltrans
  or engineering/survey-grade).
- `caltrans_crs` → **"California Department of Transportation (Caltrans), CRS Functional
  Classification / Linear Reference System-derived data."** This is Caltrans
  functional-classification linework used as road *context* — do not imply ERIS owns or
  authored it, do not present it as an ownership record, and do not present it as
  survey/engineering-grade centerline. The same credit is shown on the optional online
  "Caltrans Freeways & Expressways" web map layer.
  **Attribution is trusted and built in:** ERIS always emits its own expected Caltrans
  credit and never copies upstream service text into the manifest or UI. So the credit
  survives a missing/changed/malformed upstream copyright field, and upstream text can
  never inject arbitrary content into a package manifest or the map UI.

## Secure-download model (reference)

- Mobile never receives MinIO credentials and the bucket is never anonymous.
- The descriptor returns a **protected ERIS path** (`download_path`), not a raw URL.
- `GET /submissions/{id}/gisa/offline-scene-package/download` mints a **short-lived
  presigned URL** (default **900 s / 15 min**, `OFFLINE_SCENE_DOWNLOAD_TTL_SECONDS`)
  only after the role/access check.
- **Expiry/retry:** if a signed URL expires mid-download, the app re-requests the
  descriptor/grant to get a fresh URL and resumes/restarts. Pause/resume state
  (including resumable data) is persisted across app restarts.
- **Presigning host:** grants are signed **directly against `MINIO_PUBLIC_ENDPOINT`**
  (the externally reachable host, e.g. `https://files.camposlabs.org`) using
  `MINIO_REGION` (default `us-east-1`), so the SigV4 `Host` matches the host the
  device connects to. There is **no** post-sign host rewrite (which would produce
  `SignatureDoesNotMatch`/403 and a tiny error body the client mis-reads as a size
  mismatch). Internal storage ops still use the in-cluster `MINIO_ENDPOINT`.

## Verify the protected download end-to-end (post-deploy)

Run on the ERIS server after deploy. `C` is the compose invocation:

```sh
C="docker compose --env-file docker/.env.proxmox -f docker/docker-compose.yml -f docker/docker-compose.proxmox.yml"
set -a; . docker/.env.proxmox; set +a   # load MARIADB_ROOT_PASSWORD etc.

# 1) Newest READY package: object key + authoritative catalog size.
read OBJECT_KEY SIZE_BYTES <<EOF
$($C exec -T mariadb mariadb -u root -p"$MARIADB_ROOT_PASSWORD" "$MARIADB_DATABASE" -N -B -e \
  "SELECT object_key, size_bytes FROM offline_scene_packages WHERE status='READY' ORDER BY id DESC LIMIT 1;")
EOF
echo "object_key=$OBJECT_KEY size_bytes=$SIZE_BYTES"

# 2) Generate a FRESH grant (signed against the public host; no credentials exposed).
URL="$($C exec -T backend python -c "
from app.storage import presign_get
from app.config import settings
print(presign_get('$OBJECT_KEY', bucket=settings.MINIO_OFFLINE_SCENES_BUCKET, expires_seconds=300))
")"
case "$URL" in https://files.camposlabs.org/*) : ;; *) echo "UNEXPECTED grant host: $URL"; exit 1;; esac

# 3) Fetch the grant through files.camposlabs.org: assert HTTP 200 + EXACT size.
HTTP_SIZE="$(curl -sS -o /tmp/scene.eristerrain -w '%{http_code} %{size_download}' "$URL")"
echo "grant fetch: $HTTP_SIZE"
[ "$HTTP_SIZE" = "200 $SIZE_BYTES" ] || { echo "FAIL: expected '200 $SIZE_BYTES'"; exit 1; }

# 4) The object must NOT be anonymously readable (no signature -> denied).
ANON_CODE="$(curl -s -o /dev/null -w '%{http_code}' "https://files.camposlabs.org/eris-offline-scenes/$OBJECT_KEY")"
echo "anonymous (unsigned) access code: $ANON_CODE"
case "$ANON_CODE" in 401|403) echo "OK: anonymous access denied";; *) echo "FAIL: bucket is not private ($ANON_CODE)"; exit 1;; esac

echo "OK: protected offline-scene download verified (200 + exact size; private)."
```

This confirms the presigned grant works through the public proxy at the exact
catalog size, and that the package/bucket is not anonymously exposed. It never
prints MinIO credentials.

## Context layers (roads / imagery / overview)

Offline terrain packages combine elevation, terrain relief, road context, and an
optional aerial-imagery drape into a portable field map. Once downloaded, the
package works with **no cellular service** — the iOS viewer reads only local files.

**What each layer is + where it comes from**
- **Elevation + hillshade** — USGS 3DEP (public domain). Always packaged.
- **Roads** (`roads.geojson`) — ERIS-authoritative by default (resolved
  road-bearing segment + road-inventory line geometry), clipped to the package
  bounds + `OFFLINE_SCENE_ROAD_BUFFER_M`. No third-party provider unless an
  operator opts into `OFFLINE_SCENE_ROAD_SOURCE=arcgis_feature_service` with a
  license-reviewed `OFFLINE_SCENE_ROAD_SOURCE_URL`, or
  `OFFLINE_SCENE_ROAD_SOURCE=census_tigerweb` (public, credential-free).
  **Road class:** TIGERweb features carry an ERIS-trusted class derived from the
  layer queried — layer `2` → `road_class: "primary"` ("Primary road / highway"),
  `6` → `"secondary"`, `8` → `"local"` — alongside `source_layer_id` and
  `road_class_label`. These are written *after* the provider attributes, so a
  provider attribute can never spoof them. When the same geometry appears in two
  layers, the **highest** class wins (`primary > secondary > local`), independent of
  request order. The manifest advertises only the classes actually packaged, via
  `road_classes` + `road_class_counts` (both omitted when no classified roads are
  present, e.g. `eris_internal`).
- **Caltrans freeway/expressway road context** (`OFFLINE_SCENE_ROAD_SOURCE=caltrans_crs`)
  — an **optional** California source: the PUBLIC, credential-free Caltrans
  **CRS Functional Classification** ArcGIS FeatureServer
  (`OFFLINE_SCENE_CALTRANS_ROADS_URL`).

  **What it is — and is not.** This layer publishes **functional classification** (how a
  road *functions* in the network), **not ownership or jurisdiction**. `F_System` therefore
  does **not** prove a feature belongs to the California State Highway System, is
  Caltrans-owned, or is a State Route — and a filtered subset of it must never be described
  as "the state highway system". `RouteID` (e.g. `SHS_050._P`) is a provider LRS identifier
  and is treated as a display hint only. For an actual SHS/ownership dataset see
  "Future state-highway (SHS) provider boundary" below.

  **Inclusion policy.** Driven by `F_System` via
  `OFFLINE_SCENE_CALTRANS_FUNCTIONAL_CLASSES`. **Default `1,2`** = `1` Interstate + `2`
  Other Freeways and Expressways — the conservative freeway/expressway scope matching the
  product requirement. Class `3` ("Principal Arterial - Other") is a **surface arterial,
  not a freeway**; operators may opt in with `1,2,3` for broader principal-arterial
  context. Classes 4-7 (minor arterial / collectors / local) are outside ERIS's scope.
  The ERIS-trusted `road_class` mapping is truthful: `1,2` → `primary`, `3,4` → `secondary`,
  `5,6,7` → `local`.

  **Packaged per feature:** `provider_object_id` (the provider's OBJECTID — provenance and
  pagination only, **not** a durable identity: a republication may reassign it),
  `provider_event_id` (the provider's persistent `EventID`, when published — this is what
  correlates the same provider event across releases), `source_feature_id` (the durable ERIS
  identity of ONE exact original road feature — with divided-corridor pairing enabled, the
  default, the packaged value is the pairing pass's `r…` id, itself derived from the durable
  id ERIS supplies as `provider_feature_id`; either way it is independent of OBJECTID),
  `route_id`, `functional_class` + `functional_class_label`, `county`/`district` when
  present, `provider:"caltrans_crs"`, the ERIS-trusted `road_class`, and a `NAME` route
  label (e.g. `Route 50`) for the native identification callout.

  **Identity formula.** `source_feature_id` = hash(identity version, canonical layer
  identity, validated `EventID` when available, normalized `RouteID`, functional class,
  **canonical geometry**). Geometry is always included because `EventID` is validated for
  shape only — the provider does not guarantee it is unique — so an event-only identity
  would merge distinct roads. It is coordinate-order, multipart-order and response-order
  invariant, and unchanged when only OBJECTID changes.

  **Untrusted geometry is rejected, never repaired.** If any vertex of any declared part is
  malformed, non-finite, or outside WGS84 bounds, the WHOLE feature is dropped. ERIS never
  skips a bad vertex and joins its neighbours, because that would invent a straight chord
  across the corrupt point that does not exist in the source, and one malformed member of a
  multipart geometry must not be able to create a false connection in the road network.

  **Bounded + fail-closed.** The query is paginated and clipped to the package AOI (never
  the statewide dataset) with
  `OFFLINE_SCENE_CALTRANS_PAGE_SIZE`/`_MAX_FEATURES`/`_MAX_PAGES`/`_MAX_RESPONSE_MB`. If a
  cap is reached **while the service reports more matching features remain**, the result is
  known-truncated and is **never packaged**: the layer degrades with reason
  `incomplete_source` (or fails the job when roads are required, or uses an explicitly
  configured audited fallback). The manifest records `filter_version` + `functional_classes`
  so a package is reproducible and auditable.

  **Known limitations.** `F_System` is the only classification lever this layer exposes, so
  the packaged set is a *functional* selection: some roads carried by other agencies appear,
  and highways functionally classed below the configured set do not. This is Caltrans
  functional-classification linework used as road **context** — **not** an ownership record
  and **not** survey/engineering-grade centerline; ERIS does not own or author it.
- **Overview** (`overview.png`) — ERIS server-rendered north-up inset.
- **Aerial imagery** (`imagery.png`) — **opt-in**, USGS/USDA NAIP (public domain).
  `OFFLINE_SCENE_IMAGERY_ENABLED=false` by default; enable + validate on a worker
  with network before relying on it. When off/unavailable, Satellite/Hybrid show
  as unavailable in the app and hillshade + roads keep working.

**Config knobs:** see `backend/app/config.py` `OFFLINE_SCENE_ROADS_*`,
`OFFLINE_SCENE_CALTRANS_*`, `OFFLINE_SCENE_IMAGERY_*`, `OFFLINE_SCENE_OVERVIEW_*`. All
context assets count toward `OFFLINE_SCENE_MAX_PACKAGE_MB`; imagery is skipped (not
fatal) if it would exceed the cap. A road/imagery source failure marks that layer
unavailable and never corrupts the terrain package (`OFFLINE_SCENE_IMAGERY_MANDATORY=true`
opts into hard-failing the job if imagery cannot be retrieved).

**Roads required vs optional (failure policy):**
- An EXTERNAL provider (`census_tigerweb`, `arcgis_feature_service`, `caltrans_crs`) whose
  required endpoint is missing/blank reports reason **`provider_not_configured`**. ERIS does
  **not** quietly package internal bearing/Road-Inventory/submitted geometry and label it as
  that provider — only `OFFLINE_SCENE_ROAD_SOURCE=eris_internal` may package internal
  context. The same check applies to a configured fallback, so a fallback missing its URL is
  never reported as a successful fallback.
- **Cancellation is not a road failure.** If a job is cancelled during a long paginated road
  fetch, generation aborts immediately: no fallback provider is contacted, the outcome is
  never recorded as `source_error` or `incomplete_source`, `OFFLINE_SCENE_ROADS_REQUIRED`
  cannot turn it into an availability failure, nothing is uploaded or registered, and the
  job stays **CANCELLED** (not FAILED).
- `OFFLINE_SCENE_ROADS_REQUIRED=false` (default) — a road-source failure/absence marks
  the roads layer unavailable (with a truthful `reason`) and the terrain package still
  builds.
- `OFFLINE_SCENE_ROADS_REQUIRED=true` — a road retrieval/validation/filter/packaging
  failure **fails the job**; no READY package is published without verified road data.
  Applies to the selected provider, never to `OFFLINE_SCENE_ROAD_SOURCE=none`.
- ERIS **never silently** falls back from one provider to another. Set
  `OFFLINE_SCENE_ROAD_FALLBACK_SOURCE` to another real source (e.g. `census_tigerweb`) to
  enable an **explicit** fallback; when it is used, the manifest `roads.fallback`
  (`{from, to, reason}`) and the worker logs record it.
- Package validation additionally re-parses `roads.geojson` and rejects a package whose
  road layer is not valid line GeoJSON or whose actual feature count does not match the
  declared `feature_count` — so no READY package can carry missing, partial, or
  count-mismatched road data. The check is strict: the container `type` must be exactly
  `FeatureCollection`, every item's `type` exactly `Feature`, `properties` an object when
  present, geometry exactly `LineString`/`MultiLineString` with every part holding >= 2
  valid vertices (an empty or holey multipart geometry is rejected), all coordinates finite
  non-boolean numbers inside WGS84 bounds, and `feature_count` a non-negative integer.
  A legacy package with no roads layer remains valid.

**Content signature reflects the ACTUAL road result.** `content_signature` is finalized
*after* road collection from the finished roads layer — availability, unavailable reason,
the actual `source.provider`, `filter_version`, `functional_classes`, the audited
`fallback`, and the packaged `roads.geojson` SHA-256 — and the same finalized value is
written to both the manifest and the catalog row. So a Caltrans success, a TIGERweb
fallback, an unavailable layer, and a later recovery of the primary provider each produce a
different signature and therefore a correct mobile re-download decision. Timestamps
(`retrieved_at`), transient log text and the package version are deliberately excluded, so
regenerating identical roads does not force a pointless re-download.

**Verify a generated package includes roads/overview/imagery metadata + checksums.**
Download the object with the presigned grant (see the verification block above),
then inspect the manifest without a full client:

```sh
python - "$OBJECT_KEY" <<'PY'
import sys, zipfile, json, hashlib
z = zipfile.ZipFile("/tmp/scene.eristerrain")
m = json.loads(z.read("manifest.json"))
cl = m.get("context_layers", {})
print("format_version:", m.get("format_version"))
for name in ("roads", "imagery", "overview"):
    layer = cl.get(name) or {}
    if layer.get("available"):
        data = z.read(layer["file"])
        ok = hashlib.sha256(data).hexdigest() == layer.get("sha256") and len(data) == layer.get("bytes")
        print(f"{name}: available file={layer['file']} bytes={len(data)} sha_ok={ok} source={layer.get('source')}")
    else:
        print(f"{name}: unavailable reason={layer.get('reason')}")
PY
```
Every `available` layer must be present with a matching SHA-256 + byte count, and
its `source` must carry provenance only (no credentials/tokens).

**Airplane-Mode iPhone test:** see ADR "Addendum 3" — verify roads draped on the
surface, the north-up overview inset, Layers toggles, Terrain/Satellite/Hybrid
switching (only when imagery packaged), and the Package Details sheet, all with the
device in Airplane Mode.

### Caltrans CRS Functional Classification source — select, verify, revert

Select the optional Caltrans source (worker env / `docker/.env.proxmox`), then redeploy
the `offline-scene-worker`:

```sh
OFFLINE_SCENE_ROAD_SOURCE=caltrans_crs
OFFLINE_SCENE_CALTRANS_ROADS_URL=https://caltrans-gis.dot.ca.gov/arcgis/rest/services/CHhighway/CRS_Functional_Classification/FeatureServer/0
OFFLINE_SCENE_CALTRANS_FUNCTIONAL_CLASSES=1,2   # default freeway/expressway scope; 1,2,3 adds surface principal arterials
OFFLINE_SCENE_ROADS_REQUIRED=true               # optional: fail generation if no road data is packaged
```

**Confirm a generated package bundles Caltrans roads.** Use the manifest verification
block above; for `caltrans_crs` the `roads` layer additionally carries
`source.provider = "caltrans_crs"`, `source.dataset = "Caltrans CRS Functional
Classification"`, `filter_version` (e.g. `caltrans_crs.v2:F_System[1,2]`), and
`functional_classes`. Confirm `roads.geojson` is in the archive (`z.namelist()`), that
`feature_count` matches `len(json.loads(z.read("roads.geojson"))["features"])`, and that
`source.attribution` credits Caltrans and contains no token/URL query string.

### Future state-highway (SHS) provider boundary

`caltrans_crs` is a **functional-classification** source and must not be used to answer
"is this road on the California State Highway System?" A real SHS provider must come from
a dataset that **explicitly represents the SHS** — e.g. the Caltrans **Postmile / LRS
network** — rather than inferring ownership from `F_System`.

A Postmile/LRS-based provider is also likely to be a better *geometric* fit for ERIS:
it supports independent route alignments, so geographically separated directional
roadways (divided highways) can be preserved as distinct alignments with authoritative
route/postmile references, instead of relying on ERIS's derived divided-corridor pairing.
That work is **not** implemented here; it belongs in a separate, independently testable
provider (tracked in `docs/adr-offline-road-context-source.md`).

**Opt-in connectivity smoke test** (NOT part of CI). The automated suite is fully
offline (mocked HTTP). To sanity-check live reachability of the Caltrans service against
a tiny California AOI without generating a package:

```sh
cd backend && ./.venv/Scripts/python -c "
from app.services.offline_scene_caltrans import fetch_caltrans_road_features as f
b={'min_lat':38.55,'min_lon':-121.52,'max_lat':38.60,'max_lon':-121.46}  # ~5 km, Sacramento
url='https://caltrans-gis.dot.ca.gov/arcgis/rest/services/CHhighway/CRS_Functional_Classification/FeatureServer/0'
out=f(b, layer_url=url, functional_classes=(1,2), timeout_s=30, page_size=500, max_features=2000)
print('features:', len(out)); print('sample:', out[0]['properties'] if out else None)"
```

Keep the AOI small and the limits strict; this is a manual reachability check only.

**Revert** to the previous provider (or none): set `OFFLINE_SCENE_ROAD_SOURCE` back to
`census_tigerweb` / `eris_internal` / `none`, clear `OFFLINE_SCENE_ROADS_REQUIRED` if you
set it, and redeploy the worker. Already-registered packages are immutable and unaffected;
only newly generated packages use the changed provider (their `content_signature` changes,
so the mobile app re-downloads once).

## 12. Road-versus-imagery alignment diagnostic

When a field tester reports that roads look **displaced from the aerial imagery**, do not
guess and do not patch the renderer yet. Run this diagnostic against the **exact package
the tester downloaded**. It reads only the files inside the `.eristerrain` bundle and
makes **no network requests**, so it answers one question deterministically: *is the
package itself self-consistent?*

**Retrieve the latest package from MinIO and run the diagnostic** (on the ERIS server;
same `C` compose invocation as the verification block above):

```sh
C="docker compose --env-file docker/.env.proxmox -f docker/docker-compose.yml -f docker/docker-compose.proxmox.yml"
set -a; . docker/.env.proxmox; set +a

# 1) Newest READY package (the catalog is the source of truth).
OBJECT_KEY="$($C exec -T mariadb mariadb -u root -p"$MARIADB_ROOT_PASSWORD" "$MARIADB_DATABASE" -N -B -e \
  "SELECT object_key FROM offline_scene_packages WHERE status='READY' ORDER BY id DESC LIMIT 1;")"
echo "object_key=$OBJECT_KEY"

# 2) Fetch it with a FRESH presigned grant (no credentials are exposed or printed).
URL="$($C exec -T backend python -c "
from app.storage import presign_get
from app.config import settings
print(presign_get('$OBJECT_KEY', bucket=settings.MINIO_OFFLINE_SCENES_BUCKET, expires_seconds=300))
")"
curl -sS -o /tmp/package.eristerrain "$URL"

# 3) Run the diagnostic inside the packaging worker. The Compose service is
#    `offline-scene-worker` (there is NO service named `worker`).
#    Its image ships Pillow + app.tools.
$C cp /tmp/package.eristerrain offline-scene-worker:/tmp/package.eristerrain
$C exec -T offline-scene-worker python -m app.tools.offline_scene_alignment \
  --package /tmp/package.eristerrain --output-dir /tmp/eris-alignment
$C exec -T offline-scene-worker cat /tmp/eris-alignment/road-imagery-alignment.json

# 4) Pull the image back to the host to look at it.
$C cp offline-scene-worker:/tmp/eris-alignment/road-imagery-alignment.png ./road-imagery-alignment.png
```

**Outputs** (in `--output-dir`):

- `road-imagery-alignment.png` — north-up, east-right. Packaged imagery as the background
  (a single `imagery.png`, or a mosaic rebuilt from **each tile's own declared bounds** —
  never filename order). Roads drawn on top, styled by class so a highway is unmistakable:
  **primary = thick magenta**, **secondary = medium orange**, **local = thin cyan**.
  Plus the incident marker and the package-boundary outline.
- `road-imagery-alignment.json` — package version, terrain bounds, imagery format +
  bounds, road feature count and counts by `road_class`, road geometry bbox, malformed
  features dropped, the road clipping contract, the two out-of-bounds counters (below),
  source provider/dataset, output image dimensions, and the exact lon/lat→pixel transform.
  It contains **no** credentials, query strings, tokens, local source paths, or MinIO
  secrets.

**Roads are buffered — read the two counters correctly.** Road context is deliberately
clipped to *terrain bounds + `OFFLINE_SCENE_ROAD_BUFFER_M`*, so roads legitimately extend
past the terrain/imagery footprint. The package records the exact contract it applied
(`context_layers.roads.clip_bounds` + `buffer_m`) and the diagnostic judges against
**that**, never against live config:

| Field | Meaning |
| --- | --- |
| `coordinates_outside_terrain_bounds` | Outside the terrain/imagery frame. **Expected to be non-zero** — that is the road buffer doing its job. Not an error. Such geometry is still drawn; Pillow clips it at the canvas edge. |
| `coordinates_outside_road_clip_bounds` | Outside the package's **own declared** `clip_bounds`. This is a **packaging contract violation** and should normally be `0`. |
| `road_clip_bounds_status` | `declared`, or `not_declared_legacy` for a package built before this field existed — then `road_clip_bounds` and `coordinates_outside_road_clip_bounds` are `null` (**unknown**, not zero). Terrain bounds are *not* a substitute. |

**How to read it — this is the decision:**

| What you see | What it means | What to do |
| --- | --- | --- |
| **A.** Roads sit on the pavement in the PNG, but are displaced on the iPhone | The package is self-consistent. The bug is in the **native coordinate/texture transform**. | Fix the renderer. Do not touch the road source. |
| **B.** Roads are displaced in the PNG too | The package itself disagrees: **TIGERweb geometry vs. the packaged imagery**. | Treat as source accuracy/generalization (TIGERweb is context, not survey-grade). Do not "fix" the renderer. |

Also check the JSON before drawing conclusions: a non-zero
`coordinates_outside_road_clip_bounds` (a clipping/packaging contract violation), a
non-zero `malformed_features_dropped`, or an `imagery_bounds` that differs from
`terrain_bounds`, each explain apparent displacement on their own.

**`coordinates_outside_terrain_bounds` does not.** It is expected to be non-zero because
of the configured road buffer, and buffered geometry is *not* an explanation for roads
sitting off the pavement. Do not cite it as one.

> **Warning — never apply a global lon/lat offset based on one screenshot.** TIGERweb error
> is not a constant translation; it varies by area, road class, and vintage. A blanket nudge
> would corrupt correctly-placed roads and dress up an unverified alignment as a corrected
> one. The diagnostic proves **package-coordinate consistency only** — it cannot declare the
> imagery's visible pavement centerlines authoritative, and it is not a survey or an
> engineering-grade check.

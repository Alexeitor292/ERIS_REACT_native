# ADR: Native, offline, immersive 3D terrain viewer (mobile)

Status: Accepted — 2026-06-27 (Current Architecture updated 2026-06-28)
Branch: `feature/native-offline-3d-terrain-mobile`

---

## Current Architecture (AUTHORITATIVE)

This section is the single source of truth. Where the historical **Decision** and
**Discovery** sections below differ (they describe an earlier `.mspk`-primary,
manual-authoring design), **this section wins**. They are retained only as history.

- **Automatic package format: `eristerrain`** — a bounded, per-incident, STORED
  (uncompressed) ZIP: `manifest.json` + `elevation-grid.bin` (raw little-endian
  float32 height grid, row 0 = north) + optional `hillshade.png` + `overlays.json`.
  Generated automatically by ERIS; **no manual ArcGIS Pro authoring**. Exact schema
  in "Addendum — native eristerrain format".
- **Terrain source: USGS 3DEP.** The worker fetches the 3DEP DEM, decodes it with
  **rasterio** (geospatial worker image), downsamples to a mobile-sane grid, and
  writes the canonical height grid. Not a TIFF magic-byte check — a real decode.
- **Offline texture: USGS-derived hillshade relief** — NOT offline satellite/aerial
  imagery. Licensed offline imagery is a future provider behind
  `OFFLINE_SCENE_IMAGERY_PROVIDER`.
- **Web SceneView** (streamed Esri imagery + elevation) remains the **connected
  desktop** analysis experience, unchanged.
- **Native iOS viewer is primary** for downloaded offline areas: SceneKit mesh from
  the local grid + hillshade texture + truthful overlays (incident, uploaded
  geometry, sample extent, real road bearing only), fully offline. An `eristerrain`
  bundle is **never** opened as an `AGSMobileScenePackage`.
- **`.mspk`** remains an **optional future enterprise/ArcGIS** path, handled by the
  same catalog/download/registry layer (format routing via `usesMspkRuntime`); it is
  not the automatic path.
- **Android: explicitly UNSUPPORTED** (no reproducible native renderer). The UI says
  iOS-only when the native bridge is absent. See
  `docs/android-native-terrain-parity-plan.md`.
- **Pipeline / deployment**: async job model (`offline_scene_jobs`), a **separate**
  worker service (safe to restart; `FOR UPDATE SKIP LOCKED`; conditional status so a
  CANCELLED job is authoritative and never yields a READY catalog row; orphaned
  objects audited), a one-shot **`minio-init`** bootstrap that provisions the private,
  versioned offline-scenes bucket (fail-closed) before backend/worker start, a single
  authoritative AOI ceiling + max package-size enforced at API + worker, and an admin
  ops health endpoint. Full runbook: `docs/offline-scene-package-operator-runbook.md`.
- **Validation gate**: the physical **iPhone Airplane-Mode acceptance test**
  (`docs/offline-3d-terrain-device-acceptance.md`) is **still required** and must not
  be claimed passed without on-device evidence.

---

## Context

The WebUI ArcGIS **SceneView** (streamed Esri World Imagery + World Elevation) is the
approved **connected desktop** 3D experience and is unchanged. On mobile the previous
"Open full 3D map" browser redirect is **not** an acceptable primary field experience —
field crews work in low/no connectivity. Mobile needs a **real, native, immersive 3D
terrain viewer that works fully offline** after the user downloads a bounded area. The
browser handoff is demoted to an optional fallback (kept until the native viewer is
device-tested).

## Discovery (what already exists)

| Area | Finding |
|---|---|
| **iOS native ArcGIS** | Reproducible via an Expo **config plugin** `mobile/plugins/withArcGisIos.js` that pins `pod 'ArcGIS-Runtime-SDK-iOS', '100.15.6'` and injects Objective-C sources (`ArcGisModule`, sketch + mission-center controllers) into the Xcode project at prebuild. RN bridge module name: **`ArcGis`** (`NativeModules.ArcGis`, wrapped by `src/arcgis/ArcGISNative.ts`). State is passed JS→native via a static `ArcGisSketchStore`; controllers are presented modally full-screen. |
| **Android native ArcGIS** | Kotlin sources exist under `mobile/android/.../arcgis/*.kt` pinning `com.esri.arcgisruntime:arcgis-android:100.15.6`, **but `mobile/android/` is NOT git-tracked** (prebuild output, package `com.anonymous.mobile` ≠ configured `com.juancampos.eris.mobile`). There is **no Android config plugin** — Android ArcGIS is currently ad-hoc, local-only, and not reproducible from the repo. |
| **Runtime version** | **100.15.6** on both platforms. It supports native **`AGSSceneView`/`AGSScene`** (3D) and offline **`AGSMobileScenePackage` (.mspk)**, local elevation (`AGSArcGISTiledElevationSource`), and local basemap tiles (TPK/VTPK). |
| **Offline storage / MMPK flow** | `ArcGisModule.downloadMmpk` saves to `Documents/arcgis-offline/`; `mapPreload.ts` tracks an MMPK registry. `secureStoreLarge` chunks small JSON; `expo-file-system` is available (and `expo-file-system/legacy` is already used in `uploadFile.ts`). |
| **Backend ArcGIS** | `/arcgis/runtime-config` issues `api_key`/`license_key`/`mmpk_url` from `settings.ARCGIS_*`. There is **no server-side scene-package generation** — packages are externally hosted via a URL. |
| **Incident data** | `submission_gisa.latitude/longitude`, `geometry_json` (uploaded), `elevation_terrain` (USGS grid: `road_bearing_deg_used`, point lat/lons), `updated_at`. Road bearing is derived from real postmile geometry; no stored road centerline. |

## Decision

> **HISTORICAL / SUPERSEDED (kept for context).** This section described the initial
> `.mspk`-primary, externally/manually authored design. The **Current Architecture**
> section above supersedes it: the automatic format is `eristerrain` from USGS 3DEP,
> generated by the ERIS worker, with `.mspk` as an optional future path. Read the top
> section for what ERIS does today.

### Offline package: bounded **Mobile Scene Package (`.mspk`)**
The authoritative offline-3D format for ArcGIS Runtime. One **bounded, per-incident** `.mspk`
(incident radius, **never statewide**) containing **locally stored elevation + imagery/basemap**
for that area. Opened natively with `AGSMobileScenePackage` → `AGSScene` → `AGSSceneView`. The
**11×11 USGS EPQS grid is NOT used as the terrain surface** — it remains the diagnostic
"USGS sampled relief" card/overlay. **No streamed Esri World Imagery/Elevation is cached** (not
licensed for redistribution; not available offline).

### Operational overlays drawn at open time (truthful, not baked in)
Incident marker (real lat/lon), uploaded `geometry_json`, road-bearing line (**only when a real
bearing exists** — no fake road), and terrain sample-extent ring (from the real USGS grid bounds).
Passed to the native viewer as params so they stay current with ERIS data.

### Download + file management in **JS** (`expo-file-system/legacy`)
`createDownloadResumable` gives **progress + pause/resume**; `getInfoAsync` gives size; metadata
lives in a JSON registry in the document directory. Only the final 3D render is native — this
minimizes native surface (one method) and risk.

### Native surface (one new method)
`ArcGis.openOfflineTerrainScene(paramsJson)` presents `ArcGisTerrainSceneViewController` (new):
loads the local `.mspk` into `AGSSceneView`, draws overlays, and provides **full screen** (modal),
**pan/zoom/orbit/tilt** (native gestures), **reset-to-incident** (oblique 65° camera), **north
reset**, and an **offline status** pill (version, size, downloaded date).

### Server contract (descriptor only)
New `GET /submissions/{id}/gisa/offline-scene-package` returns the **bounded area** (incident
radius → bounds), an **estimated size**, a **content signature** (for refresh), and a **download
URL** when `settings.ARCGIS_SCENE_PACKAGE_BASE_URL` is configured. With no host configured it
returns `available:false` with a clear reason (honest offline-unavailable). It **describes** the
package; it does **not generate** the `.mspk`.

## Offline package format & contents

```
<area>.mspk  (Esri Mobile Scene Package)
├── a 3D Scene with:
│   ├── elevation surface  ← local tiled elevation (LERC/TPK) for the area
│   └── basemap            ← local imagery (TPK) or vector tiles (VTPK) for the area
└── (operational overlays are NOT inside the package — drawn live from ERIS data)
```
Bounds = incident center ± radius (default 1500 m, clamped 250–8000 m). Local metadata per area:
`submissionId, center, radiusM, bounds, contentSignature, packageVersion, status, sizeBytes,
estimatedSizeMb, localPath, downloadedAt, error`.

## How packages are generated / hosted

ERIS does **not** generate `.mspk` today (documented gap). Production options, in order of
preference:
1. **Caltrans/enterprise ArcGIS** publishes/serves pre-authored offline scene packages per
   district/route with **licensed** local imagery + elevation; ERIS sets
   `ARCGIS_SCENE_PACKAGE_BASE_URL` to that host.
2. **ArcGIS Enterprise offline packaging** (a `createOfflineMapAreas`/Pro-built MSPK pipeline)
   generates bounded packages on demand; a small ERIS service would proxy/sign the URLs.
3. Interim: pre-built `.mspk` files for known incident corridors hosted on MinIO/static and
   referenced by URL.

The backend descriptor endpoint already produces the per-submission download URL + size + signature
to drive any of these.

## Lifecycle / refresh model

- **Download**: bounded, explicit scope shown with a size estimate; resumable (pause/retry);
  metadata persisted PENDING→DOWNLOADING→READY/FAILED.
- **Refresh**: each package stores the server **content signature** at download; when the server
  signature changes (incident geometry/bearing/area moved) the app flags "update available" and
  re-downloads on demand (`needsRefresh`). Offline, the existing copy is kept.
- **Storage management** (Settings → "Offline 3D terrain areas"): list areas, per-area delete,
  **clear stale** (> 60 days).
- **Incident edits/photos/forms** are untouched — they keep using the existing offline queue
  (`src/offline/queue.ts`) and sync on reconnect.

## Data / licensing

- Offline **imagery + elevation must be explicitly licensed** for local storage — Caltrans
  enterprise basemaps/elevation or an Esri offline-enabled subscription. Public streamed Esri
  basemaps are **not** assumed redistributable/cacheable.
- Roads/incident overlays come from **ERIS's own data** (incident geometry, postmile-derived
  bearing, USGS sample extent) — authoritative and not invented.
- Production should prefer **Caltrans/enterprise-hosted** packages.

## iOS status
**Implemented (code-complete, needs an EAS dev build + device test):** new
`ArcGisTerrainSceneViewController` (`AGSSceneView`), `ArcGis.openOfflineTerrainScene`, store field,
and registration in `withArcGisIos.js`. iOS is the required platform.

## Android status
**Not at parity — intentionally not faked.** Android ArcGIS today is non-reproducible local
prebuild output with no config plugin. Parity requires: (1) author `mobile/plugins/withArcGisAndroid.js`
to inject the Esri maven repo + `arcgis-android:100.15.6` Gradle dependency and a committed Kotlin
`ArcGisTerrainSceneActivity` (`SceneView`/`ArcGISScene`/`MobileScenePackage`) + `ReactPackage`
wiring with the correct `com.juancampos.eris.mobile` package; (2) verify the same JS bridge method
name (`openOfflineTerrainScene`). The JS layer (download/manage/open) is already cross-platform.

## EAS rebuild requirement
This adds native code, so a **new EAS development build is required** before the native viewer
appears (it no-ops gracefully on builds without it — `supportsOfflineTerrainScene()` is false and
the panel shows a "rebuild required" note + keeps the browser fallback). Exact commands:

```sh
cd mobile
npx expo install --check
# iOS (required):
eas build --platform ios --profile development
# Android (only after the Android config plugin above exists):
eas build --platform android --profile development
```
(`eas.json` already defines the `development` profile with `developmentClient: true`.)

## Airplane-mode manual test path
1. EAS dev build installed on a physical iOS device; log in; open a submission **with coordinates**.
2. Measurements → **3D Terrain** → **Download offline 3D area**; confirm the bounded scope + size
   estimate; watch progress (test **Pause/Resume**); wait for **Downloaded**.
3. **Enable Airplane Mode** (no Wi-Fi/cellular).
4. Tap **Open native 3D terrain** → verify with **no network**: terrain relief, imagery/basemap,
   incident marker, overlays (geometry/bearing/sample extent when present), **zoom/orbit/tilt**,
   **North** reset, **Reset** to incident, and the offline status pill.
5. Open a **different** submission with **no downloaded package** → clear "offline-unavailable"
   state (download disabled with reason).
6. **Settings → Offline 3D terrain areas** → **Delete** the area; reopen the submission → it now
   shows offline-unavailable. **Re-download** to confirm replacement; change incident geometry
   server-side, reconnect → verify the "update available" refresh prompt.

## Addendum — real catalog + private MinIO + integrity (2026-06-27)

The placeholder "base URL means available" approach is replaced by a real, MinIO-backed
catalog. See also `docs/offline-scene-package-operator-runbook.md`.

**Authoritative data model.** USGS **3DEP** raster DEM is the offline elevation source;
operators author bounded `.mspk` in **ArcGIS Pro / Enterprise**; binaries live in a **private**
MinIO bucket **`eris-offline-scenes`** (never anonymous, not the uploads bucket); **ERIS owns
authorization, catalog, lifecycle, and signed download**.

**Catalog table `offline_scene_packages`** (init schema + Alembic `0011`, idempotent CREATE TABLE
IF NOT EXISTS): `id, submission_id, status(READY|RETIRED|FAILED), package_version, minio_bucket,
object_key, sha256, size_bytes, min/max/center lat-lon, radius_m, elevation_source(USGS_3DEP),
elevation_dataset/version/resolution, basemap_or_imagery_source, content_signature, created_at,
uploaded_at, uploaded_by, retired_at, notes`. Unique `(submission_id, package_version)` and unique
`object_key`. **Objects are immutable**; a replacement is a new version and the prior READY row is
**RETIRED** (audited). The descriptor serves the **newest READY** row.

**Availability is verified, never inferred.** `GET …/offline-scene-package` returns `available:true`
**only** when a READY catalog row exists **and** a live MinIO **HEAD** confirms the object exists
with the catalog's size. Otherwise `available:false` with a precise reason ("none prepared" /
"missing from storage"). Values come from the catalog row, never a base-URL string.

**Secure download.** `GET …/offline-scene-package/download` mints a **short-lived presigned URL**
(default 900 s, `OFFLINE_SCENE_DOWNLOAD_TTL_SECONDS`) only after the role/access check. Mobile
never receives MinIO credentials; the bucket stays private. On expiry the app re-requests the grant
and resumes/restarts.

**ADMIN registration.** `POST /admin/offline-scene-packages` (ADMIN only) HEADs the object, verifies
**exact size** and **SHA-256** (stream-hashed server-side) before marking READY, retires prior READY
versions, and rejects missing object / size or hash mismatch / duplicate version / invalid bounds /
non-ADMIN. It never infers readiness from a URL.

**Mobile integrity + lifecycle.** Downloads go to a temporary **`.part`** file; before READY the app
verifies **(1) byte size, (2) SHA-256 (native `sha256OfFile`, CommonCrypto — no JS crypto dep),
(3) the `.mspk` actually loads as an `AGSMobileScenePackage` (native `validateScenePackage`)**, then
**atomically** renames `.part` → final. A package is **never** READY just because a file exists; on
failure it stays **FAILED** with cleanup. Pause/resume persists the resumable snapshot **across app
restarts**; a visible **Resume** button drives PAUSED. The UI shows real **version, exact size,
USGS 3DEP attribution, age, offline-ready**, a clear **"No offline package prepared"** state, and
correct **Download/Pause/Resume/Retry/Delete/Update** — no size *estimate* shown as if a package
exists.

**Config.** New `MINIO_OFFLINE_SCENES_BUCKET` (default `eris-offline-scenes`) and
`OFFLINE_SCENE_DOWNLOAD_TTL_SECONDS` (default 900). `ARCGIS_SCENE_PACKAGE_BASE_URL` is removed.

**Still requires ArcGIS Pro:** package *authoring* (bounded local scene + 3DEP elevation + approved
offline basemap + mobile-optimized `.mspk` with online layers excluded) remains a manual operator
step — ERIS does not generate packages from USGS yet. **Android** remains unsupported for the native
renderer (no reproducible plugin) and the two native methods added here (`sha256OfFile`,
`validateScenePackage`) are iOS-only. **EAS rebuild is still required** for the native viewer +
integrity bridge.

## Addendum — durability, immutability, provenance (2026-06-27)

**Durable mobile download state machine.** A persisted record is now reconciled against on-disk
reality on app startup (`reconcileAllPackages`) and on panel load (`reconcilePackage`):
READY without its final file → FAILED (re-download); DOWNLOADING with no live task → PAUSED if a
`.part` + persisted resume snapshot exist, else FAILED ("Download interrupted; retry required.");
PAUSED that cannot resume → FAILED. A **per-submission generation counter** guarantees a **single
authoritative completion path**: Pause/Delete/new-start bump the generation, and a worker only
promotes READY / marks FAILED / deletes the `.part` if its generation is still current — so a paused
or superseded `downloadAsync` can never later clobber state (`shouldApplyWorkerResult`). Pause flips
the UI to PAUSED immediately and persists the resumable snapshot; resume reconstructs the Expo
`DownloadResumable` from that snapshot (works after a restart). An expired presigned URL surfaces as
a failed/needs-restart resume → the UI fetches a fresh ERIS grant and restarts. Delete bumps the
generation, removes **both** final `.mspk` and `.part`, clears resumable state, and removes the
registry entry. Pure-tested: restart-during-DOWNLOADING, explicit Pause, resume-after-restart,
expired-grant retry, delete-while-PAUSED, and no-duplicate-completion.

**Fail-closed MinIO + real immutability.** `docker/scripts/create-offline-scenes-bucket.sh` removes
`|| true`: it creates the bucket **`mc mb --with-lock`** (object lock ⇒ versioning), **fails nonzero**
unless anonymous access is verified `none` AND versioning is verified `Enabled`, and prints no success
otherwise (object lock can only be set at creation, so a non-locked existing bucket is rejected). The
backend **no longer silently creates** the bucket — registration `bucket_exists()`-checks and returns
409 if it is missing/unprovisioned. Registration enforces the **canonical immutable key**
`submissions/{submission_id}/{package_version}/scene.mspk` (a differing supplied `object_key` → 422)
and captures the object's **immutable version id + etag**; the descriptor requires catalog row +
object present + **matching size + matching version id/etag**, so a same-size replacement is detected
and reported unavailable. New catalog columns `object_version_id`, `object_etag`.

**USGS provenance enforced.** `elevation_source` is a server-enforced `Literal["USGS_3DEP"]` (any other
value → 422), and a READY registration **requires** non-empty `elevation_dataset`,
`elevation_version`, `elevation_resolution`, and `basemap_or_imagery_source`.

**Not done yet.** The feature is **not** validated until a real ArcGIS Pro-authored `.mspk` (USGS 3DEP)
is hosted in private MinIO, downloaded by an **iOS EAS development build**, and opened in **Airplane
Mode**. No EAS build has been made on this branch.

## Addendum — automatic package generation pipeline (2026-06-27)

Manual ArcGIS Pro authoring is **no longer the ERIS workflow**. An authorized user taps **Prepare
offline 3D area**; ERIS generates the bounded package automatically.

**Package-format decision (item 7) — Option B, an ERIS terrain bundle (`eristerrain`).** Discovery:
the Linux worker has `requests`/`numpy`/`Pillow` but **no `rasterio` and no `arcpy`/ArcGIS Pro**.
Automated true-`.mspk` authoring requires ArcGIS Pro (Windows + per-seat license) — not reproducible
on a server worker. So the auto-generated package is a **zip bundle** (`scene.eristerrain`) containing a
**clipped USGS 3DEP DEM** (`dem.tif`), a **server-rendered hillshade** (`hillshade.png`), ERIS overlays,
and a `manifest.json` (provenance). It is rendered natively at runtime by building an `AGSScene` from the
local DEM + hillshade (no `.mspk` needed). The format is validated structurally (real TIFF DEM, recognized
manifest) — a file is never "valid" just because it ends in `.mspk`. The `.mspk` path remains supported
(catalog `package_format`), registerable via the ADMIN override endpoint, for an enterprise ArcGIS pipeline
later.

**Pipeline.** `offline_scene_jobs` table (Alembic 0012) + a separate **worker Docker service**
(`offline-scene-worker`, reuses the backend image, `python -m app.worker.offline_scene_worker`). Endpoints:
`POST …/offline-scene-package/generate` (edit-perm, coordinates required, bounded AOI, duplicate-job
prevention, returns a QUEUED job), `GET …/job` (mobile polling), `…/job/cancel`, `…/job/retry`. Job states:
QUEUED → FETCHING_USGS_3DEP → BUILDING_TERRAIN → BUILDING_BASEMAP → PACKAGING → VERIFYING → UPLOADING →
REGISTERING → READY / FAILED / CANCELLED. The worker safely claims jobs (`FOR UPDATE SKIP LOCKED`),
recovers stale running jobs on startup, writes progress to the DB, and **only registers a READY catalog
package after the bundle validates AND the verified MinIO upload + catalog SHA/size/identity checks pass**
(a failed build never creates a READY catalog row). Builder provider interface
(`OfflineScenePackageBuilder`: prepare_source_data / build_package / validate_package / upload_and_register)
with `HillshadeReliefBuilder` today; an approved licensed offline-imagery provider can be added behind the
same interface via `OFFLINE_SCENE_IMAGERY_PROVIDER`.

**Basemap strategy.** MVP default is **USGS-3DEP hillshade (terrain relief)** — licence-clean, no streamed
Esri/Google/online tiles cached for offline. When no offline imagery provider is configured the package is
clearly labelled "USGS 3DEP terrain relief". Imagery is a provider setting for future licensed sources.

**Mobile UX.** The "No offline package prepared" dead-end is replaced by **Prepare offline 3D area →
Preparing terrain: NN% — downloading USGS 3DEP → Building offline terrain package → Ready to download →
Download → Downloaded / ready offline**, with **Cancel** while active and **Retry** on failure (polled from
`…/job`). The native viewer stays primary; WebUI scene stays the connected desktop analysis; browser handoff
stays a temporary fallback.

**Worker deployment.** Long terrain jobs run in the separate `offline-scene-worker` service, never the API
request process. Bounded concurrency (1 by default), dev mode with small AOIs (`OFFLINE_SCENE_MAX_RADIUS_M`),
and the bundle is assembled **in memory** (no temp DEM/package files written to disk or Git).

**Licensing / what's automatic today vs. blocked.** Fully automatic now: USGS 3DEP elevation + hillshade
acquisition, bounded clipping, package build/validate/upload/register, mobile prepare→download. **No
dedicated ArcGIS/Windows worker license is required** for the `eristerrain` path. Still requires
licensing/sourcing work: **offline draped satellite/aerial imagery** (the hillshade is relief, not imagery) —
add a licensed offline imagery provider behind `OFFLINE_SCENE_IMAGERY_PROVIDER`; and the **native runtime
renderer for the `eristerrain` bundle** (AGSScene from local DEM + hillshade) plus the integrity bridge still
require an **EAS dev build + device airplane-mode validation** (not done on this branch).

## Addendum — native eristerrain format + renderer (2026-06-27)

Closes the format gap: the worker emits `eristerrain` but the phone previously validated/opened
everything as `.mspk`. Now the format is explicit **end to end** (backend descriptor + download grant →
mobile `SceneAreaDescriptor`/`SceneDownloadGrant`/registry meta/`OpenOfflineSceneParams` → native bridge →
view controller) and **an `eristerrain` bundle is never loaded through `AGSMobileScenePackage`**.

**Exact eristerrain manifest schema (`format_version: 2`):**
```json
{
  "format": "eristerrain", "format_version": 2,
  "submission_id": 7, "package_version": "g20260627...-<jobId>",
  "generated_at": "<iso>",
  "area": {"center": {"lat","lon"}, "radius_m", "bounds": {"min_lat","min_lon","max_lat","max_lon"}},
  "elevation": {"source": "USGS_3DEP", "dataset", "version", "resolution", "service"},
  "terrain": {
    "file": "elevation-grid.bin", "rows", "columns",
    "encoding": "float32", "byte_order": "little",
    "no_data_value": -9999.0, "min_elevation_m", "max_elevation_m", "vertical_units": "meters",
    "bounds": {"min_lat","min_lon","max_lat","max_lon"},
    "local_transform": {"origin_lon","origin_lat","lon_per_col","lat_per_row"},
    "sha256": "<sha256 of elevation-grid.bin>"
  },
  "basemap": {"provider","source_label","has_imagery","has_hillshade"},
  "overlays": {"incident":{...},"geometry":...,"roadBearingDeg":...,"sampleExtent":...},
  "content_signature": "...",
  "files": {"manifest","terrain","hillshade?","overlays"}
}
```
Bundle = a **STORED (uncompressed) ZIP**: `manifest.json`, `elevation-grid.bin` (raw little-endian float32,
row-major, row 0 = north edge; no-data cells store `no_data_value`), optional `hillshade.png`, `overlays.json`.
STORED so the mobile client reads entries with no decompressor.

**Worker DEM decoding dependency choice:** **rasterio** (bundled GDAL via manylinux wheels) in a dedicated
worker image (`backend/Dockerfile.worker` + `requirements-worker.txt`; compose `offline-scene-worker` builds
it). `offline_scene_terrain.decode_dem_tiff` decodes the real 3DEP GeoTIFF, downsamples to a mobile-sane grid
(`OFFLINE_SCENE_GRID_PX`, default 256), converts the source no-data to NaN, and `encode_height_grid` emits the
canonical float32 grid (no-data → `-9999.0`, min/max over valid cells). A TIFF magic-byte test is **not** used
as validation; the bundle is validated by decoding to a real grid whose byte length + SHA-256 match the manifest.

**Native renderer (`ErisTerrainSceneViewController`, SceneKit):** reads the extracted dir (manifest + grid +
hillshade), builds a height-field `SCNGeometry` mesh from the float32 grid (no-data flattened), drapes
`hillshade.png` as the diffuse texture, places the incident marker + road-bearing (only when real) via the
manifest's `local_transform`, and provides orbit/pan/zoom/tilt (SCNView camera control) + North + reset-to-incident
+ a version/source status pill. The ArcGIS-Runtime `ArcGisTerrainSceneViewController` remains for `mspk`. The
native bridge `openOfflineTerrainScene` routes by `packageFormat`.

**Mobile validation/extraction (`eristerrainBundle.ts`, pure + unit-tested):** parses the STORED zip, rejects
path-traversal entries, verifies per-entry **CRC-32**, validates the manifest + terrain metadata + grid
dimensions, and decodes the height grid + coordinate transform. The manager downloads to `.part`, verifies
byte size + package SHA-256 (native), then — for `eristerrain` — **validates + extracts** the bundle to a
per-package dir and verifies the grid's manifest SHA-256 natively **before** marking READY; for `mspk` it keeps
the `AGSMobileScenePackage` load check. A package is never READY until its declared-format validation passes.

**Manual acceptance test (must pass before EAS sign-off):**
1. Tap **Prepare offline 3D area** on a submission with coordinates; wait for the worker to produce a
   USGS-3DEP `eristerrain` package and the job to reach READY → **Download** → **Downloaded**.
2. Install an **iOS EAS development build** and download the package on the device.
3. Enable **Airplane Mode**.
4. **Open native 3D terrain** → verify (no network): an actual terrain **mesh** from the height grid, the
   **hillshade texture**, the incident marker + overlays, and **orbit / pan / zoom / tilt / North / Reset**.

**What remains unsupported:** licensed **offline draped imagery** (only USGS hillshade relief today); the
native renderer + integrity bridge are **code-complete but unvalidated on device** (need the EAS dev build);
**Android** native rendering (no reproducible plugin). No EAS build was made on this branch.

## Addendum 2 — code-review hardening (2026-06-28)

Fixes five code-review blockers on top of the eristerrain renderer above.

**1. Worker image dependency.** `HillshadeReliefBuilder` imports `requests`, which the slim API stack
(httpx) does not pull in transitively. `requirements-worker.txt` now pins `requests>=2.31,<3` explicitly.
`Dockerfile.worker` also installs `libexpat1` — the rasterio manylinux wheel bundles GDAL but still
dynamically links `libexpat.so.1`, which `python:3.12-slim` strips. Regression guard:
`backend/tests/test_worker_requirements.py` asserts every worker import (`requests`/`numpy`/`rasterio`/
`Pillow`) is declared in the worker reqs and that the file extends `requirements.txt`. Build + in-image
import smoke check: `docker build -f backend/Dockerfile.worker -t eris-offline-scene-worker backend` then
`docker run --rm eris-offline-scene-worker python -c "import requests,rasterio,numpy,PIL; from app.services.offline_scene_builder import HillshadeReliefBuilder; print('worker imports OK')"`.

**2. Full native overlays.** `ErisTerrainSceneViewController` now renders, draped on the mesh surface and
clipped to the packaged bounds: the **uploaded incident geometry** (GeoJSON geometry/Feature/
FeatureCollection/GeometryCollection and Esri `x-y`/`points`/`paths`/`rings`; Point, MultiPoint, LineString,
Polygon and multi-equivalents), the **sample-extent rectangle** (only when provided), the incident marker,
and the road-bearing line (only when a real bearing exists). Out-of-bounds vertices are **skipped, never
invented**; Web Mercator coordinates are coerced to lon/lat. The coordinate math (lon/lat → grid col/row →
mesh XZ, Web Mercator coercion, bounds clipping, sample-extent ring) lives in the unit-tested
`src/arcgis/terrainOverlays.ts`, which the Objective-C mirrors.

**3. Reset-to-incident.** Reset maps the incident through the manifest `local_transform`, frames the camera
around the **incident** (falling back to the terrain centre only when the incident is unavailable or outside
the packaged bounds), and pins the built-in `defaultCameraController.target` to the incident so orbit/pan/
zoom revolve around it (a stable SceneKit look-at target, not only Euler angles). **North** restores north-up
yaw while preserving the incident framing (same target, elevation, and zoom radius).

**4. Stricter manifest validation (`eristerrainBundle.ts`).** In addition to format/version/source, terrain
validation now requires: `sha256` present + 64 hex chars; `byte_order == little`; `vertical_units == meters`;
finite rows/columns/bounds/no-data/min-max/transform values; `lon_per_col > 0`; `lat_per_row < 0`; and the
`local_transform` consistent with the declared bounds + grid dimensions within a small tolerance. Every
required entry must pass CRC-32, and a **corrupt optional `hillshade.png`/`overlays.json` now rejects the
bundle** instead of being silently ignored. Package-level SHA-256 is still verified before extraction and the
grid SHA-256 after extraction.

**5. Tests.** Pure suites cover the new rejection cases (byte_order/vertical_units/sha256/finite/transform-
consistency/corrupt-optional-entry) and coordinate-to-mesh mapping of a point, line, polygon, and sample
extent, plus geometry normalization (GeoJSON + Esri) and bounds clipping.

**iPhone Airplane-Mode acceptance test (still the one remaining gate — needs an iOS EAS dev build, not run
here):** generate an `eristerrain` package for a submission **with uploaded geometry and a real road bearing**;
download it on the device; enable Airplane Mode; open native 3D and verify, with **no network**, the terrain
**mesh** + **hillshade texture**, the **incident marker**, the **uploaded geometry** (correct type/placement),
the **sample-extent rectangle**, the **road-bearing line**, geometry outside the AOI clipped, and **orbit /
pan / zoom / tilt**, **North** (north-up, framing preserved), and **Reset** (re-frames the incident).

## Addendum 3 — offline geographic context layers (2026-07-02)

Adds packaged, fully-offline geographic context to the native iOS terrain viewer:
road/route context, an optional aerial-imagery drape, a north-up 2D overview
inset, and per-layer provenance — a Google-Maps-style *layered* field map that
still works with **zero connectivity after download**. Design note:
`docs/design/offline-terrain-context-layers.md`.

**What is packaged (inside the `.eristerrain` bundle, build-time only):**

| Layer | Asset | Source | Default | Fully offline after download |
|---|---|---|---|---|
| Elevation mesh | `elevation-grid.bin` | USGS 3DEP (public domain) | on | yes |
| Hillshade relief | `hillshade.png` | USGS 3DEP rendered relief (public domain) | on when available | yes |
| Roads / routes | `roads.geojson` | **ERIS-authoritative** (resolved road-bearing segment + road-inventory line geometry), clipped to bounds+buffer; opt-in ArcGIS FeatureServer adapter | on | yes |
| Overview inset | `overview.png` | **server-rendered** (Pillow) from bounds+roads+incident+geometry | on | yes |
| Aerial imagery | `imagery.png` | **USGS/USDA NAIP** (public domain) via config adapter | **off (opt-in)** | yes |

**Data-source / licensing decisions.** Roads use ERIS-authoritative data only (no
third-party provider added by default); a documented, license-reviewed opt-in
ArcGIS FeatureServer adapter can broaden coverage. Imagery uses NAIP (USGS/USDA,
public domain) but ships **disabled** until validated on a live worker — until
then the manifest records `imagery.available=false, reason="not_configured"` and
the iOS Layers sheet shows Satellite/Hybrid as **Not packaged**. No Google / Apple
/ Bing / Mapbox imagery. Layer `source` blocks carry provider/dataset/attribution/
retrieved_at only — sanitized (URL query stripped; **never** credentials).

**Manifest (backward compatible).** New `context_layers` block; legacy packages
without it open exactly as before (all optional layers "unavailable", never
corrupt). Every declared-`available` asset is verified (presence + SHA-256 + byte
count + per-entry CRC-32) on the backend and again on the device before extraction;
a declared-available-but-missing/corrupt asset fails the bundle closed, while
absent layers just don't render. Context assets count toward
`OFFLINE_SCENE_MAX_PACKAGE_MB`; optional imagery is the last, skippable asset
(dropped `too_large` before exceeding the cap).

**Fetched only during package generation (worker):** roads (only for the opt-in
external adapter — the default `eris_internal` source needs no network) and NAIP
imagery (when enabled). **Nothing** is fetched during the mobile download or while
viewing offline; the terrain view controller makes no network request.

**Config knobs:** `OFFLINE_SCENE_ROADS_ENABLED` / `_ROAD_SOURCE` (`eris_internal` |
`arcgis_feature_service`) / `_ROAD_SOURCE_URL` / `_ROAD_BUFFER_M` /
`_ROAD_FETCH_TIMEOUT_S`; `OFFLINE_SCENE_IMAGERY_ENABLED` (default false) /
`_IMAGERY_MANDATORY` / `_IMAGERY_EXPORT_URL` / `_IMAGERY_MAX_PX` /
`_IMAGERY_FETCH_TIMEOUT_S`; `OFFLINE_SCENE_OVERVIEW_ENABLED` / `_OVERVIEW_PX`.

**Size / resolution tradeoffs.** roads.geojson is tiny (a few features). overview
is a small PNG (`OFFLINE_SCENE_OVERVIEW_PX`, default 512). Imagery dominates size
(`OFFLINE_SCENE_IMAGERY_MAX_PX`, default 1024) and is skipped rather than blowing
the package budget.

**Platform statement.** iOS is the supported native offline-terrain target.
**Android is NOT** a native offline-terrain target (unchanged); no browser/WebView
substitution is used for "native offline".

**What is NOT proven yet (honest):** live NAIP imagery is adapter-complete but
default-off + unvalidated against the live service; the native iOS build is
compiled by CI (macOS), not on the Windows dev box; the real-device Airplane-Mode
acceptance below is a manual gate, not claimed as passed.

**Airplane-Mode manual acceptance (extends the base test):** on a submission with
coordinates + a real road bearing, prepare + download the package on an iOS dev
build; enable Airplane Mode; open native 3D and verify with **no network**: terrain
mesh + hillshade, incident marker, roads draped on the surface, the north-up
overview inset (lower-right), and — via **Layers** — toggling Roads / Overlays /
Boundary / Overview, and (only if imagery was packaged) switching Terrain /
Satellite / Hybrid; tap the status pill for Package Details; confirm the pill never
claims "aerial imagery" when only hillshade is packaged, and that a package without
imagery shows Satellite/Hybrid as unavailable.

## Addendum 4 — display vertical exaggeration (2026-07-XX)

Adds a user-controlled **vertical exaggeration** to the native iOS Layers sheet
with a physically-derived **true-scale (1.0×) baseline**, while the packaged
elevation grid stays immutable source-derived data.

**Data vs display (non-negotiable).** `elevation-grid.bin` is the validated
**source-derived** USGS 3DEP elevation dataset (float32 metres). It is read-only
after extraction; `self.gridData` is never mutated, and no packaged file
(`manifest.json` / `elevation-grid.bin` / `imagery.png` / `hillshade.png` /
`roads.geojson`) is written. Vertical exaggeration is a pure **SceneKit
geometry/transform** change in memory. (We do NOT claim the package stores the
original USGS source TIFF — it stores the validated source-derived grid the
renderer uses.)

**True-scale calculation (1.0×).** Derived from the package footprint, not a magic
visual constant (the old `worldSize * 0.35 / relief` normalization is removed):
- Physical footprint in metres from `terrain.local_transform` (preferred) or
  `bounds`: `heightM = Δlat·111320`; `widthM = Δlon·111320·cos(midLat)`.
- `sceneUnitsPerMeter = (2·worldSize) / max(widthM, heightM)` — the larger
  horizontal dimension fills the scene; the smaller keeps the **true aspect ratio**
  (packages are never forced square).
- Mesh X/Z use the aspect-correct half-extents; at 1.0× the vertical uses the SAME
  factor: `sceneY = (elevationM − minElevationM) · sceneUnitsPerMeter`, so a metre
  up looks like a metre across (approximately true scale).
- At N×: `sceneY × N`. Reference math + tests: `mobile/src/arcgis/terrainScale.ts`.

**Renderer design.** Terrain + all draped layers (roads, boundary, geometry,
bearing, sample-extent) are built once at true scale under an `exagNode` container;
the 0.5×–3.0× control just sets `exagNode.scale = (1, N, 1)`. Marker spheres are
counter-scaled `(1, 1/N, 1)` so they track the scaled surface but stay round.
The camera/orbit pivot follows the scaled focus height **without** resetting
orientation/zoom. Imagery/Hybrid alignment and the packed-float2 texcoord fix are
untouched (no UV regression); the overview inset is 2D and unaffected. No network
request originates from the view controller.

**Layers UI.** Appearance now has **Vertical exaggeration** (slider 0.5×–3.0×,
snap 0.1×, default 1.0×, live value + accessibility value: e.g. "1.0× True scale",
"2.0× Enhanced relief") described as a display setting, and the previous "Terrain
relief intensity" slider is renamed **Hillshade intensity** (unchanged
Terrain/Satellite/Hybrid blending). Package Details states: "Elevation data: USGS
3DEP source-derived elevation grid, stored in metres / Display vertical
exaggeration: 1.0× True scale / Display settings do not modify the packaged
elevation data".

**No regeneration / no deploy.** This is renderer-only Objective-C. Existing valid
`.eristerrain` packages (incl. `vg20260707185444-7` and legacy packages without
`context_layers`) work after installing the updated iOS **development build** — no
backend deploy, worker change, manifest/format change, or package regeneration is
required. A new native build IS required (Objective-C SceneKit changes).

## Addendum 5 — tiled HD imagery + durable async packaging (2026-07-08)

Replaces the single `imagery.png` drape with a **high-definition tiled imagery**
package, and hardens the async package-creation contract so the frontend never waits
for worker packaging.

**Why tiled.** A single whole-AOI export has hard limits: quality drops as the area
grows, a large export can exceed the ImageServer max size or time out, and it cannot
provide ArcGIS-style local detail. Tiling splits the AOI into a grid of JPEG tiles so
each upstream export stays well below the service maximum and total packaged detail
can far exceed a single 4000px export — without over-requesting beyond source-native
resolution.

**Source / licensing (unchanged posture).** Default imagery source stays **USGS/USDA
NAIP (public domain)**; imagery is **OFF by default**. We do NOT claim visual
equivalence with an ArcGIS map unless the operator configures the exact licensed
service (with export/offline-cache rights + separate credentials). Package Details and
the manifest report the ACTUAL source + effective packaged resolution. Browser-only
ArcGIS API keys are never used in the backend/worker (CI asserts key isolation).

**Tile-planning policy (`offline_scene_imagery.py`, pure + tested).** Footprint in
metres (cos-lat) → planned m/px = `max(target, source_native)` (never finer than
source) → `columns = ceil(widthPx/tile_px)`, `rows = ceil(heightPx/tile_px)`. Tiles
are equal cells with **float-exact shared edges** (no gaps/overlaps), each exported
square at `tile_px` (1024/2048, ≤ a conservative max-export ceiling). A tile-count
budget (`OFFLINE_SCENE_IMAGERY_MAX_TILES`) fails with a precise operator reason before
uncontrolled growth; a runtime MB budget bounds imagery bytes.

**Worker download behavior.** Each tile is fetched independently, validated as a real
image (JPEG/PNG magic — not a JSON/HTML service error), with **bounded retries +
exponential backoff + jitter** and an overall deadline; a single timeout never fails
the job. Per-tile progress is persisted to the job (`"Packaging aerial imagery: 7 of
16 tiles"`, surfaced verbatim in the app). Packaging is **all-or-nothing**: a partial/
holey imagery layer is never declared available (successful tiles are rolled back);
with mandatory imagery, an exhausted tile fails the job with **exact coordinates + a
sanitized upstream reason**.

**Manifest + integrity (backward compatible).** `context_layers.imagery` gains
`format:"tiled"` with `columns/rows/tile_size_px/target_meters_per_pixel/
effective_meters_per_pixel/bounds/source` and a `tiles[]` array of
`{row,column,file,bounds,sha256,bytes}`. Every tile gets entry-level validation
(presence, SHA-256, byte count, ZIP CRC) on both the worker and the device; a
declared-available tile that is missing/corrupt fails the bundle **closed**. Legacy
single `imagery.png` packages remain fully supported (`format:"single"`/absent).

**Native rendering (`ErisTerrainSceneViewController.m`).** Tiled imagery renders as
**per-tile terrain patches** (`imageryTilesNode`): each patch is a height-field mesh
covering one tile's geographic bounds, sampled from the SAME grid mapping as the base
mesh + overlays (so edges coincide → seamless, no bleed), with local UV 0..1 mapping
the tile image (clamp) and the **packed float2 texcoord retained** (no diagonal-stripe
regression). Satellite shows the patches; Hybrid multiplies the whole-AOI hillshade
**sliced per tile** (`multiply.contentsTransform`) at the Hillshade-intensity value.
Patches live under `exagNode`, so true-scale terrain + vertical exaggeration + all
draped content stay aligned. Legacy single-image rendering is the fallback. No network
originates from the view controller (static guard + CI).

**Async packaging contract (Part B).** The start endpoint is **enqueue-only**: it
validates, creates/reuses an idempotent durable job, and returns **HTTP 202** with the
job id, current status, and a `status_url` — it never fetches USGS 3DEP / NAIP / MinIO
inline (unit-tested). The offline-scene worker (separate container) owns all fetch /
tiling / assembly / verify / upload / catalog registration, with the existing lease /
heartbeat / orphan-recovery / duplicate-prevention. The app polls with short
independent requests; a failed poll never fails the job; there is no frontend
wall-clock timeout; the active job is restored from server state on reopen. Download
resume/retry stays separate from generation, behind private MinIO + presigned URLs +
full integrity verification.

**No regeneration required for existing packages.** Renderer + worker changes are
additive and backward compatible. Existing valid `.eristerrain` packages (single-image
or none) work after the new iOS **development build**; enabling tiled imagery is an
operator config change that applies to newly generated packages. A new native build IS
required (Objective-C SceneKit changes). Config: `OFFLINE_SCENE_IMAGERY_MODE`,
`_TARGET_MPP`, `_SOURCE_NATIVE_MPP`, `_TILE_PX`, `_TILE_TIMEOUT_S`, `_TILE_RETRIES`,
`_OVERALL_DEADLINE_S`, `_MAX_TILES`, `_MAX_MB`, `_JPEG_QUALITY`.

## Addendum 6 — map-driven 3D road cross-section slice (2026-07-08)

Adds a **"Cross Section" tool** to the native offline 3D terrain viewer: the user taps
a road, ERIS snaps to the packaged road context, samples the offline USGS 3DEP grid
along a perpendicular slice, and opens a **realistic SceneKit roadway/terrain cutaway**
looking UPSTATION — deliberately NOT the flat schematic SVG Measurements diagram
(`RoadCrossSectionRenderer`, retained for legacy Measurements use).

**Canonical orientation (unchanged).** Always looking UPSTATION (toward increasing
postmile); LT always left, RT always right; no mirrored/downstation mode. Offsets are
feet from the roadway centerline (median center): LT negative, RT positive; the
cross-section axis = upstation bearing + 90°.

**Data contract — `RoadCrossSectionSlice`** (`mobile/src/measurements/roadCrossSectionSlice.ts`,
the tested source of truth mirrored by native Obj-C + consumed by the RN renderer):
selected/snapped lat-lon, upstation + cross-section bearings, the `RoadCrossSection`
layout, `elevationSource: "USGS_3DEP_OFFLINE_GRID"`, an ordered `samples[]`
(`{side, offsetFt, lat, lon, elevationM|null, elevationFt|null, status: OK|NO_DATA|
OUT_OF_BOUNDS, label}`), `keyMarkers` (LT/RT outside-shoulder edges + 10/20/50 ft), and
`provenance` (roadLayoutSource ROAD_INVENTORY|FORM_FIELDS|DEFAULT, elevation source,
packageVersion, snappedToRoadContext, roadContextSource).

**Tap → slice (native, offline).** `ErisTerrainSceneViewController.m`: a "Cross Section"
nav button enters selection mode with the banner "Tap a road to create a cross section."
An `SCNHitTest` on the terrain → world XZ → grid col/row (inverse of the true-scale mesh
mapping, exaggeration-independent) → lat/lon via `local_transform`. No network.

**Road snapping.** The tapped point is projected onto the nearest packaged `roads.geojson`
LineString (richest-first: road_inventory / road_centerline before the derived
road_bearing line) within a max snap distance (60 m). Upstation is resolved by orienting
the segment tangent to the packaged/incident road-bearing hint. Too far / no feature →
"No road context near tap. Try closer to the roadway." (never a misleading far slice).
If no road geometry is packaged but a bearing exists, a clearly-labelled fallback
orientation is used.

**Elevation sampling.** Each offset lat/lon → grid col/row → **bilinear** sample of the
read-only `elevation-grid.bin` (metres). No-data cells → `NO_DATA`; outside the grid →
`OUT_OF_BOUNDS`; nothing is invented beyond coverage. `self.gridData` is never mutated
and no packaged file is written (static guard + CI).

**Realistic SceneKit cutaway** (`ErisRoadSliceSceneViewController`). Procedural, local-only
materials: an asphalt roadway deck (lanes / shoulders / median by category NONE/PAINTED/
RAISED/BARRIER/DEPRESSED with lane markings + edge lines), an **elevation-driven terrain
surface** beyond each shoulder extruded from the sampled profile (SCNShape), 10/20/50 ft
stakes coloured by sample status, an **orthographic camera looking upstation** (LT left,
RT right), lighting, LT/RT + "Looking upstation" + route/postmile labels, an always-on
honest stake legend, and a **Technical overlay** toggle (exact element widths, all
breakpoints, stake elevations + deltas, provenance). Reset restores the upstation framing.

**Packaged road context (offline).** The worker derives the `RoadCrossSection` layout
server-side (`road_cross_section_build.py`, a faithful parity port of the mobile
`buildRoadSectionFromInventory` — locked by the shared fixture
`roadCrossSectionParity.json` asserted by both a Python and a TS test) and packages
`road_cross_section.json` (attributes + route/county/postmile + upstation direction +
provenance) as a `context_layers.road_cross_section` asset (per-entry SHA-256/CRC/byte
validated on worker + device). Legacy packages without it still open; the tool then uses
a clearly-labelled default 2-lane layout. Config: `OFFLINE_SCENE_ROAD_CROSS_SECTION_ENABLED`
(default true).

**What is measured vs schematic.** Ground elevation beyond the shoulder is **measured**
from the USGS 3DEP offline grid. The roadway deck is a **schematic** Road Inventory-derived
surface (lane/shoulder/median widths) — no crown, cross-slope, curb shape, superelevation,
or lane-level engineering precision is claimed unless that data exists. Labels state
"Roadway layout: Road Inventory / default assumptions", "Ground elevation: USGS 3DEP
offline grid", and "Roadway surface is schematic unless pavement crown/superelevation data
is available."

**Offline guarantees.** After download the feature works in Airplane Mode: no server call,
no online basemap/imagery, no live USGS/ArcGIS elevation call, no AI imagery — all geometry
+ materials are package-derived/procedural. **No backend deploy or package regeneration is
required** (the packaged block is additive/backward compatible); a new native iOS
development build IS required (SceneKit + config-plugin source additions).

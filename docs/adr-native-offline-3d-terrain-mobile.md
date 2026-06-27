# ADR: Native, offline, immersive 3D terrain viewer (mobile)

Status: Accepted — 2026-06-27
Branch: `feature/native-offline-3d-terrain-mobile`

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

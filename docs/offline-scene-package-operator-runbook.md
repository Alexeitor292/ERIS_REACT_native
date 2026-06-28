# Operator runbook: offline 3D scene packages (.mspk)

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

## 0. One-time: create the private MinIO bucket

The packages live in a **private, versioned, object-locked** bucket
`eris-offline-scenes` (never anonymous, never the uploads bucket). Run once per
environment:

```sh
MINIO_ENDPOINT=http://<minio-host>:9800 \
MINIO_ROOT_USER=<root-user> MINIO_ROOT_PASSWORD=<root-pass> \
sh docker/scripts/create-offline-scenes-bucket.sh
```

The script is **fail-closed**: it creates the bucket **`mc mb --with-lock`** (object
lock ⇒ versioning ⇒ append-only immutability) and exits **nonzero** unless it can
confirm anonymous access is `none` **and** versioning is `Enabled`. **Object lock
can only be enabled at creation** — if a non-locked `eris-offline-scenes` already
exists, the script rejects it and you must recreate it. The ERIS backend reads the
bucket with the existing MinIO credentials (mobile never gets them) and will
**refuse** to register a package if the bucket is missing (it never auto-creates an
unprovisioned bucket).

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

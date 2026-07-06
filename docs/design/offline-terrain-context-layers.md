# Design note — Offline terrain context layers (iOS)

Status: implementation in progress on `feature/offline-terrain-context-layers`.

## Goal

Make the native iOS offline 3D terrain viewer geographically legible — a
Google-Maps-style *layered* field map — **without any network after download**.
Add, packaged inside the existing `.eristerrain` bundle: road/route context, an
optional aerial-imagery drape, a north-up 2D overview inset, and clear
per-layer provenance. Reuse the existing SceneKit height-field renderer and the
existing package/download/integrity machinery. No Google/Apple/Bing/Mapbox tiles.

## Smallest safe implementation path

Evolve the **manifest**, not the DB schema. `.eristerrain` is already a STORED
zip of `manifest.json` + `elevation-grid.bin` + optional `hillshade.png` +
`overlays.json`, validated by per-entry CRC-32 + declared SHA-256. We add optional
sibling assets and a backward-compatible `context_layers` manifest block. Legacy
(no `context_layers`) packages are interpreted as "all optional layers
unavailable", never as corrupt.

### Manifest addition (backward compatible)

```jsonc
"context_layers": {
  "roads":   { "available": true,  "file": "roads.geojson",  "sha256": "...", "bytes": 1234,
               "source": { "provider": "eris_internal", "dataset": "...", "retrieved_at": "...", "attribution": "..." } },
  "imagery": { "available": false, "reason": "not_configured" },
  "overview":{ "available": true,  "file": "overview.png",   "sha256": "...", "bytes": 5678,
               "width": 512, "height": 512,
               "source": { "provider": "eris_render", "attribution": "..." } }
}
```
- Any asset declared `available:true` MUST exist in the zip and match its `sha256`
  and CRC, else the bundle is rejected (fail-closed) — same rule as `hillshade`.
- A declared-`available:false` (or absent) layer is simply not shown; the base
  terrain + hillshade + incident + geometry keep working.

## Assets & data sources (this iteration)

| Layer | Asset | Source | Default | Offline after download? | Notes |
|---|---|---|---|---|---|
| Terrain relief | `elevation-grid.bin` | USGS 3DEP (public domain) | on | yes | unchanged |
| Hillshade | `hillshade.png` | USGS 3DEP rendered relief (public domain) | on when available | yes | unchanged |
| Roads/routes | `roads.geojson` | **ERIS-authoritative** data already in the build context (submitted incident geometry + resolved road-bearing segment + any line geometry in the road-inventory snapshot), clipped to bounds + buffer | **on** | yes | no third-party provider; opt-in external ArcGIS FeatureServer adapter is documented + config-gated |
| Overview inset | `overview.png` | **server-rendered** (Pillow) from package bounds + roads + incident + geometry on a dark background | **on** | yes | licence-clean; no external data |
| Aerial imagery | `imagery.png` | **USGS/USDA NAIP** ImageServer `exportImage` (public domain) via a config-driven adapter | **off (opt-in)** | yes | adapter implemented; disabled by default until validated on a live worker |

Roads/imagery are fetched **only during package build** on the worker — never
during the mobile download or while viewing offline.

### Why imagery defaults OFF
NAIP (USGS/USDA National Agriculture Imagery Program) is public-domain federal
imagery and is the intended licence-clean provider. But the live service behavior
must be confirmed on a worker with network before we claim "satellite imagery";
until then `OFFLINE_SCENE_IMAGERY_ENABLED=false` and the manifest records
`imagery.available=false, reason="not_configured"`, so the iOS Layers sheet shows
Satellite/Hybrid as **Unavailable**. Hillshade + roads + overview still work.

## Config knobs (safe defaults, fail-graceful)

```
OFFLINE_SCENE_ROADS_ENABLED=true
OFFLINE_SCENE_ROAD_SOURCE=eris_internal          # eris_internal | arcgis_feature_service
OFFLINE_SCENE_ROAD_SOURCE_URL=                   # required only for arcgis_feature_service
OFFLINE_SCENE_ROAD_BUFFER_M=250
OFFLINE_SCENE_ROAD_FETCH_TIMEOUT_S=30

OFFLINE_SCENE_IMAGERY_ENABLED=false              # opt-in; NAIP adapter below
OFFLINE_SCENE_IMAGERY_MANDATORY=false            # if true, imagery failure fails the job
OFFLINE_SCENE_IMAGERY_EXPORT_URL=https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer
OFFLINE_SCENE_IMAGERY_MAX_PX=1024
OFFLINE_SCENE_IMAGERY_FETCH_TIMEOUT_S=45

OFFLINE_SCENE_OVERVIEW_ENABLED=true
OFFLINE_SCENE_OVERVIEW_PX=512
```

- A **road-source failure never corrupts/deletes** a valid terrain package: roads
  are marked `available:false, reason:"source_error"` and the package still builds.
- **Optional imagery** that is disabled/uncovered/too-large/failed is **skipped**
  with a manifest reason; the job only fails if `OFFLINE_SCENE_IMAGERY_MANDATORY`.
- All packaged assets count toward `OFFLINE_SCENE_MAX_PACKAGE_MB` (enforced on the
  total bundle bytes before registration + before the download grant). Imagery is
  the last, skippable asset, so it is dropped (reason `too_large`) before it could
  push the package over the limit.

## Native iOS (reuse SceneKit renderer)

- **Layers** bar button → native `UITableView`/sheet: Base surface (Terrain
  Relief / Satellite / Hybrid — last two disabled when imagery absent), Overlays
  (Roads, Incident/Geometry, Package Boundary, Overview), Appearance (relief +
  imagery opacity). Default: Terrain Relief + Roads + Overview. Accessible labels.
- Material switching: terrain node material `diffuse.contents` swaps between
  hillshade image, imagery image, or a blended layer; no network.
- Roads drape on the mesh surface (reuse the existing surface-sampling + polyline
  helpers). Labels deferred to the overview inset to avoid 3D clutter.
- **Overview inset** (lower-right `UIImageView` of `overview.png`) with a center
  indicator; "Overview" accessibility label; toggleable.
- **Package Details** sheet from the status pill: elevation/imagery/road sources,
  created-at, area/radius, version, offline-ready, attribution, unavailable layers
  + reasons.
- All new controllers read only the extracted local files; **no `URLSession`/
  network** is introduced. Corrupt GeoJSON/image/metadata degrade that one layer.

## Security / integrity (unchanged, extended)
Private bucket, signed-against-public-host grants, anonymous-denied, SHA-256 +
size + CRC integrity all preserved. Context-layer sources carry provider/dataset/
attribution/retrieved_at only — **never** credentials or internal URLs. No provider
keys in the mobile app or committed `.env`.

## What is NOT in this iteration (honest)
- Live NAIP imagery is adapter-complete but **default-off** and unverified against
  the live service from this environment.
- iOS is compiled by CI (macOS runner); not compiled on the Windows dev box.
- Real-device Airplane-Mode acceptance is a documented manual gate, not claimed.
- Android is unchanged and remains **not** a native offline-terrain target.

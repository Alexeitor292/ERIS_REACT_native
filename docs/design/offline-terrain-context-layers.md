# Design note — Offline terrain context layers (iOS)

Status: baseline implemented; road-source strategy updated 2026-07-14.

## Goal

Make the native iOS offline 3D terrain viewer geographically legible — a
Google-Maps-style *layered* field map — **without any network after download**.
Add, packaged inside the existing `.eristerrain` bundle: road/route context, an
optional aerial-imagery drape, a north-up 2D overview inset, and clear
per-layer provenance. Reuse the existing SceneKit height-field renderer and the
existing package/download/integrity machinery. No Google/Apple/Bing/Mapbox tiles.

## Current road-source decision (2026-07-14)

The source decision is recorded in
`docs/adr-offline-road-context-source.md` and should be reviewed before changing
road-provider configuration or implementing a new adapter.

- **Selected development source:** public U.S. Census Bureau TIGERweb
  Transportation road geometry, queried by the worker during package generation.
- **Implementation status:** **implemented (backend-only, 2026-07-14).** The code now
  supports `eris_internal`, `census_tigerweb`, and `arcgis_feature_service`. No mobile /
  Objective-C / Expo change and **no new EAS build** were required.
- **Why:** this allows independent development without connecting the current ERIS
  environment to Caltrans ArcGIS Enterprise yet.
- **Production posture:** Caltrans ArcGIS Enterprise remains a future authoritative
  option when its environment, credentials, data contract, licensing, and security
  review are ready.
- **Other retained options:** a personal Esri-hosted development layer, ArcGIS
  Online, self-hosted PostGIS/versioned road extracts, and deterministic static test
  fixtures.

TIGERweb geometry is road **snap context**, not Caltrans engineering truth. It does
not establish postmile direction, authoritative upstation, lane/shoulder dimensions,
crown, superelevation, or survey accuracy. USGS 3DEP remains the ground-elevation
source, and the roadway layout remains independently identified as Road Inventory,
form fields, or default assumptions.

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

## Assets & data sources

| Layer | Asset | Source | Default / status | Offline after download? | Notes |
|---|---|---|---|---|---|
| Terrain relief | `elevation-grid.bin` | USGS 3DEP | on | yes | unchanged |
| Hillshade | `hillshade.png` | USGS 3DEP rendered relief | on when available | yes | unchanged |
| Roads/routes | `roads.geojson` | Current: ERIS build context; selected development target: U.S. Census TIGERweb; future production option: approved Caltrans/enterprise centerlines | `eris_internal` today; `census_tigerweb` planned | yes | provider must be truthful in the manifest; TIGERweb is context, not engineering-grade data |
| Overview inset | `overview.png` | server-rendered (Pillow) from package bounds + roads + incident + geometry | on | yes | no external data |
| Aerial imagery | single/tiled imagery assets | USGS/USDA NAIP ImageServer via config-driven adapter | opt-in by code default | yes | source and effective resolution recorded |

Roads/imagery are fetched **only during package build** on the worker — never
during the mobile download or while viewing offline.

### Why imagery defaults OFF in code

NAIP (USGS/USDA National Agriculture Imagery Program) is the intended
licence-clean provider. Live behavior must be validated on the deployed worker;
when `OFFLINE_SCENE_IMAGERY_ENABLED=false`, the manifest records imagery as
unavailable and the iOS Layers sheet disables Satellite/Hybrid. Hillshade + roads +
overview still work.

## Config knobs (safe defaults, fail-graceful)

Implemented road sources:

```env
OFFLINE_SCENE_ROADS_ENABLED=true
# eris_internal | census_tigerweb | arcgis_feature_service
OFFLINE_SCENE_ROAD_SOURCE=eris_internal
OFFLINE_SCENE_ROAD_SOURCE_URL=                   # required only for arcgis_feature_service
OFFLINE_SCENE_ROAD_BUFFER_M=250
OFFLINE_SCENE_ROAD_FETCH_TIMEOUT_S=30
```

TIGERweb development source (implemented; credential-free, worker-only):

```env
OFFLINE_SCENE_ROAD_SOURCE=census_tigerweb
OFFLINE_SCENE_TIGERWEB_BASE_URL=https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer
OFFLINE_SCENE_TIGERWEB_LAYERS=2,6,8   # 2 Primary, 6 Secondary, 8 Local
```

TIGERweb behavior: layers are queried against bounds + buffer in WGS84 (GeoJSON preferred,
Esri `paths` accepted defensively); successful layers are combined even if one fails; all
layers failing degrades roads to `source_error`; geometry is de-duplicated; only `NAME`,
`BASENAME`, `MTFCC`, `RTTYP` are packaged; features are tagged `kind: "road_centerline"`;
provenance is `us_census_tigerweb` / U.S. Census Bureau.

### Road geometry clipping (all sources)

Every packaged road line — TIGERweb/external centerlines, road-inventory geometry,
submitted line geometry, and the synthetic road-bearing line — is **truly clipped** to the
buffered bounds with per-segment Liang-Barsky (`clip_line_to_bounds`), not merely filtered:

- a segment that **crosses** the AOI with both endpoints outside is **retained**, cut to the
  boundary intersections;
- **no out-of-bounds coordinate is ever packaged**;
- a line that leaves and re-enters the AOI becomes **separate `LineString` features** (the
  mobile snap parser already handles multiple line features);
- duplicate vertices at segment joins are collapsed, and parts with fewer than two distinct
  points are rejected.

Other context settings:

```env
OFFLINE_SCENE_IMAGERY_ENABLED=false
OFFLINE_SCENE_IMAGERY_MANDATORY=false
OFFLINE_SCENE_IMAGERY_EXPORT_URL=https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer
OFFLINE_SCENE_IMAGERY_MAX_PX=1024
OFFLINE_SCENE_IMAGERY_FETCH_TIMEOUT_S=45

OFFLINE_SCENE_OVERVIEW_ENABLED=true
OFFLINE_SCENE_OVERVIEW_PX=512
```

- A **road-source failure never corrupts/deletes** a valid terrain package: roads
  are marked unavailable with a precise reason and the package still builds.
- **Optional imagery** that is disabled/uncovered/too-large/failed is **skipped**
  with a manifest reason; the job only fails if `OFFLINE_SCENE_IMAGERY_MANDATORY`.
- All packaged assets count toward `OFFLINE_SCENE_MAX_PACKAGE_MB`. Imagery is the
  last skippable asset and is dropped before it can push the package over the cap.

## Native iOS (reuse SceneKit renderer)

- **Layers** bar button → native `UITableView`/sheet: Base surface (Terrain
  Relief / Satellite / Hybrid — last two disabled when imagery absent), Overlays
  (Roads, Incident/Geometry, Package Boundary, Overview), Appearance (relief +
  imagery opacity). Default: Terrain Relief + Roads + Overview. Accessible labels.
- Material switching: terrain node material swaps between hillshade, imagery, or a
  blended layer; no network.
- Roads drape on the mesh surface. Labels are kept out of the 3D scene where they
  would create clutter.
- **Overview inset** is north-up and toggleable.
- **Package Details** reports elevation/imagery/road sources, version, area,
  attribution, unavailable reasons, road snap availability, orientation
  availability, and Cross Section usability.
- All controllers read only extracted local files; **no network** is introduced by
  the native viewer. Corrupt GeoJSON/image/metadata degrades or rejects according to
  the package integrity contract.

## Security / integrity

Private bucket, signed-against-public-host grants, anonymous-denied, SHA-256 + size
+ CRC integrity are preserved. Context-layer source blocks contain sanitized
provider/dataset/attribution/retrieved-at/service provenance only — **never**
credentials, token query strings, internal endpoints, or browser API keys. No
provider key belongs in the mobile app or committed `.env` files.

## Open work and review points

- ~~Implement `census_tigerweb` as a backend-only provider~~ — **done (2026-07-14)**:
  supports the public `MapServer/<layer>/query` contract (and `FeatureServer/<layer>`)
  with truthful Census provenance.
- Revalidate TIGERweb layer IDs `2`, `6`, and `8`, schemas, access behavior, and
  service limits periodically (public service schemas can change).
- Ensure a TIGER-only tangent is not presented as authoritative increasing-postmile
  upstation when no resolved road bearing exists.
- Perform physical iPhone Airplane-Mode acceptance with a newly generated package
  containing TIGERweb road centerlines.
- Revisit the provider decision when Caltrans offers an approved dev/production
  service or when a self-hosted road snapshot becomes operationally preferable.
- Android remains **not** a native offline-terrain target.

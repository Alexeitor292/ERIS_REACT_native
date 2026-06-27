# ADR: Interactive 3D Terrain Viewer ("Google-Earth-like" GIS scene)

Status: Accepted — 2026-06-26
Branch: `feature/interactive-3d-terrain-viewer`

## Context

The original "3D Terrain / Terrain Relief" feature is an oblique **SVG** surface built
from a small **11×11 USGS 3DEP/EPQS** elevation grid (~200×200 m, 121 points). It is a
static picture, not a navigable scene: no smooth zoom, no orbit, no tilt, no satellite
imagery draped on real terrain. Product direction is a real, interactive,
Google-Earth-like scene — **without** Google Earth, Google Maps tiles, or any
scraped/uncertain-licence imagery.

## Discovery (what already exists)

| Area | Finding |
|---|---|
| **WebUI GIS stack** | `@arcgis/core` **4.33** (ArcGIS Maps SDK for JavaScript) is already a dependency. `MapView` (2D) is used in `SubmissionArcGisMap.tsx` and `MissionCenterMap.tsx`. Assets are copied locally by `vite-plugin-static-copy` (`node_modules/@arcgis/core/assets` → `/assets`), and `esriConfig.assetsPath="/assets"` is set. |
| **WebUI credentials** | No mandatory API key. `basemap:"hybrid"` (Esri World Imagery + labels) is already used **without** a key. `MissionCenterMap` optionally reads `VITE_ARCGIS_API_KEY` and sets `esriConfig.apiKey` when present. |
| **Mobile GIS stack** | **No** JS ArcGIS dependency. A **custom native Objective-C plugin** (`mobile/plugins/withArcGisIos.js` + `plugins/arcgis-ios/*.m`) links **ArcGIS Runtime SDK for iOS 100.15.6** (iOS only) and exposes **sketch / mission-center / MMPK** view controllers — **not** a generic 3D `AGSSceneView` to JS. Requires a custom dev-client / EAS build (not Expo Go). |
| **Mobile config** | Backend `/arcgis/runtime-config` issues `api_key` / `license_key` / `mmpk_url` (`backend/app/routes/arcgis.py`, `settings.ARCGIS_*`). Mobile caches it (`arcgisRuntimeConfig.ts`). |
| **Incident / terrain data** | `gisa.latitude`/`gisa.longitude` (incident point), `gisa.geometry_json` (uploaded GeoJSON, optional), `gisa.elevation_terrain` (the USGS grid: `road_bearing_deg_used`, `grid.points[].lat/lon`, extents), `gisa.elevation_profile` (cross-section + `classification_reason`). Road **bearing** is derived from real ArcGIS postmile geometry; ERIS does **not** store an actual road centerline polyline. |
| **Web test runner** | None configured. Node 24 runs `.ts` tests natively (`node --test`, type-stripping) — used here with zero new dependency. |

## Decision

### Selected renderer — **ArcGIS Maps SDK for JavaScript `SceneView` (3D)**
Already a dependency, already configured (local assets, optional API key, hybrid imagery).
It is the ArcGIS-native solution the brief prefers, needs **no new package**, and gives
smooth zoom / pan / orbit / tilt, a real streaming globe, and built-in widgets
(Home, Compass, attribution).

Rejected alternatives: **Cesium / Resium** (new heavy dependency, separate Ion token /
licensing); **MapLibre GL + terrain** (new dependency, raster-DEM terrain plumbing, no
existing ArcGIS reuse); **Google Earth / Maps tiles** (explicitly disallowed).

### Terrain source — **Esri World Elevation 3D** (`ground: "world-elevation"`)
The default Esri Terrain3D streaming elevation service — purpose-built for interactive 3D,
global, continuous. Real elevation, streamed by LOD. No fabrication.

### Satellite / hybrid imagery — **Esri World Imagery** (`basemap: "hybrid"`)
Draped over the elevation surface by SceneView. Same default service already used by
`SubmissionArcGisMap`. Topographic fallback uses `basemap: "topo-vector"`.

### Credentials / licensing assumptions
- Works in development with Esri **default services** (no key), matching the existing
  `basemap:"hybrid"` usage already shipping in this repo.
- For production, set **`VITE_ARCGIS_API_KEY`** (same pattern as `MissionCenterMap`); the
  scene calls `esriConfig.apiKey` when present. Attribution for Esri/Maxar/USGS terrain &
  imagery is rendered by SceneView's attribution widget and reinforced in the panel.
- **No** Google Earth, Google Maps tiles, or scraped imagery. Nothing with uncertain
  licensing is introduced.

### WebUI implementation approach
New `web/src/components/InteractiveTerrainScene.tsx` (SceneView) + a pure, ArcGIS-free
`web/src/components/terrainScene.ts` (framing / basemap / overlay / error logic, unit
tested). It becomes the **primary** terrain visualization in `SubmissionDetailPage`; the
old SVG `TerrainRelief` is demoted to a compact, collapsible **"USGS sampled relief
(diagnostic)"** card. Controls: full-screen, zoom/pan/rotate/tilt (native), reset-to-incident
(Home), compass/north reset, satellite/topographic toggle, incident marker + summary panel,
loading state, terrain/imagery failure state, attribution, responsive full-screen layout.
Initial camera is an **oblique** (~65° tilt, not overhead) view framed on the incident.

### Mobile implementation approach — **clean fallback, no native add**
A real mobile 3D scene would require a **new native AGSSceneView** view controller (iOS) and
an Android equivalent — i.e. new native code and an **EAS rebuild**. Per the brief we do
**not** silently add that. Instead the mobile "3D Terrain" tab keeps the existing compact
`TerrainReliefView` analysis card and adds an **"Open full 3D map"** action that opens the
WebUI scene in the device browser via `expo-web-browser` (already a dependency). A new
optional `EXPO_PUBLIC_WEB_URL` config powers the link; when it is unset (or the submission
is an unsynced local draft) the action is disabled with an explanatory note rather than
opening a broken URL.

### Does mobile need a native dependency / new EAS build?
**No — not for this change.** The mobile fallback uses only `expo-web-browser` (already
present). **No new native module, config plugin, or EAS rebuild is required.** A *native*
in-app 3D scene later **would** require new Objective-C/Android code and an EAS rebuild;
that is intentionally deferred.

### Why the USGS EPQS 11×11 grid stays analysis data, not the scene renderer
It is a **bounded, road-aligned analytical sample** (~200×200 m, 121 points) feeding
cross-section **classification** (LEFT_HIGH / RIGHT_HIGH / BOWL / CROWN / FLAT),
`classification_reason`, partial-coverage diagnostics, and an offline-capable cached
artifact. It is precise where it samples but far too coarse and small-extent to be a
navigable surface. SceneView's world-elevation provides the continuous streaming terrain for
navigation; the EPQS grid remains the **diagnostic** "what did we actually sample / classify"
layer and fallback. They are complementary, not interchangeable.

## Preserved capabilities
Below Road terminology, `classification_reason`, terrain caching, partial-coverage messaging,
EPQS concurrency protection, no fabricated elevation cells, and backend migration
compatibility are all untouched — this change is additive (a new viewer + a demoted card).

## Truthful overlays (each individually toggleable)
- **Incident marker** — from `gisa.latitude/longitude` (only when valid).
- **Road bearing direction** — short line through the incident along `road_bearing_deg_used`
  (only when a bearing was resolved from real postmile geometry); labelled as a bearing
  indicator, **not** a road ribbon.
- **Terrain sample extent** — bounding ring of the real sampled USGS grid points (only when
  the grid exists).
- **Uploaded incident geometry** — `gisa.geometry_json` (only when present).

No road centerline polyline is drawn, because ERIS does not store one — only the derived
bearing. No left/right labels are drawn unless a bearing is known. No geometry is invented.

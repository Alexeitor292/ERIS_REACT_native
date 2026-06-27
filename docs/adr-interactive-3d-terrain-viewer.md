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

## Addendum — review-fix decisions (2026-06-26)

1. **Real full screen.** The "Full screen" button uses the browser **Fullscreen API**
   (`element.requestFullscreen()`) on the viewer container when available, falling back to
   the fixed-inset CSS layout otherwise. A `fullscreenchange` listener keeps the button,
   **Esc**, and native browser controls in sync; exiting restores body scrolling and resizes
   the SceneView. Logic (`supportsFullscreenApi`, `isElementFullscreen`, `sceneContainerClass`)
   is unit-tested.

2. **Reliable failure handling.** Terrain failure is **no longer inferred from
   `ground.layers.length`**. After the view loads we `loadAll()` the basemap and ground and
   evaluate each layer's real `loadStatus`/`loadError` (`evaluateLayerHealth`). `deriveSceneHealth`
   maps that to: both-failed → blocking error; one-failed → non-blocking amber banner (imagery
   ⇒ "switch to topographic"; elevation ⇒ "terrain flat"); access/auth (`isArcgisAccessError`:
   401/403/498/499 or token/api-key/forbidden text) → a specific "service rejected access /
   set VITE_ARCGIS_API_KEY" message. **Retry fully recreates** the SceneView/map/layers via a
   `reloadKey` that re-runs the creation effect (it never just re-calls `when()` on an errored
   view). The USGS sampled-relief card stays available as the fallback.

3. **Complete GeoJSON.** `extractRenderableGeometries` flattens raw Geometry, **Feature**,
   **FeatureCollection**, **GeometryCollection**, and all six primitive types, validating
   coordinate arrays before any ArcGIS geometry is built. `overlayAvailability.uploadedGeometry`
   is driven by `geoJsonRenderable`, so a present-but-unrenderable object leaves the overlay
   **disabled**. FeatureCollection and GeometryCollection are covered by tests.

4. **Production ArcGIS config.** `web/.env.example` documents **`VITE_ARCGIS_API_KEY`** — a
   **browser-safe** key that must be **referrer-restricted to `https://eris.camposlabs.org`**.
   It is read only via `import.meta.env`; the backend `ARCGIS_API_KEY` (from
   `/arcgis/runtime-config`, for the mobile native runtime) is **never** exposed to the
   frontend. Because Vite inlines `VITE_*` at **build time**, the `.env.example` documents the
   exact **Docker build-arg** wiring (`ARG`/`ENV` before `RUN npm run build`, compose
   `build.args`). A visible scene error appears when ArcGIS rejects access.

5. **Performance.** `InteractiveTerrainScene` is **`React.lazy` + `Suspense`** in
   `SubmissionDetailPage`; SceneView's 3D modules download only when the user opens the 3D
   Terrain tab. The Suspense fallback reuses the loading panel. The main submission bundle no
   longer eagerly includes the 3D renderer (separate chunk).

6. **Mobile handoff.** "Open full 3D map" opens the exact synced submission route
   `/(submissions)/{id}?section=terrain`; the WebUI reads `section=terrain`, switches to the
   3D Terrain view, and scrolls it into view. **No access token is ever placed in the URL** —
   the browser uses its own ERIS WebUI session and **may require a separate login** unless a
   secure SSO/session handoff exists (documented in-app and here).

## Addendum — deployment wiring & camera stability (2026-06-26)

**ArcGIS key Docker wiring (actual, not just documented).**
- `web/Dockerfile`: `ARG VITE_ARCGIS_API_KEY=""` + `ENV VITE_ARCGIS_API_KEY=$VITE_ARCGIS_API_KEY`
  before `RUN ... npm run build` (also raised the build heap with
  `NODE_OPTIONS=--max-old-space-size=4096`, since the SceneView bundle OOM'd the container's
  default Node heap).
- `docker/docker-compose.proxmox.yml`: `services.web.build.args` now includes
  `VITE_ARCGIS_API_KEY: ${VITE_ARCGIS_API_KEY:-}`.
- `docker/.env.proxmox.example` documents that the ERIS server's `docker/.env.proxmox` must set
  `VITE_ARCGIS_API_KEY=<restricted browser key>`.
- It is **not** added to the backend service's `environment:` block and the component reads it
  only via `import.meta.env.VITE_ARCGIS_API_KEY`. (Because the backend service shares
  `env_file: .env.proxmox`, the browser key is visible in the backend's runtime env the same
  way `VITE_API_BASE_URL` already is — inert and not a secret; the backend reads `ARCGIS_API_KEY`,
  a different, untouched variable.)
- Verified end-to-end: with a harmless probe value, `docker compose build web` embeds the value
  into the served SceneView chunk (no real key printed or committed). `import.meta.env.VITE_*`
  is accessed directly so Vite statically inlines it at build time.

**SceneView no longer recreated on every parent render.** `SubmissionDetailPage` passes a new
inline `location` object each render; the component now derives stable `lat`/`lon` primitives and
a `sceneAnchorKey`, and the view-creation effect depends on `[anchorKey, reloadKey]` — so the
SceneView (and the user's camera) is recreated **only** when the incident latitude/longitude
changes or Retry is pressed. Terrain/geometry/toggle overlays still update live (separate effect
keyed on the stable primitives). `sceneAnchorKey` has a unit test proving equal coordinates in
separate object instances yield the same anchor.

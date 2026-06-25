# Elevation Profile Enrichment

ERIS can fetch a cross-section elevation profile for any GISA submission that has latitude/longitude
coordinates. The profile comes from the USGS 3DEP Elevation Point Query Service (EPQS) — no API key
required.

## Data source

**USGS 3DEP / EPQS**

Endpoint pattern:
```
https://epqs.nationalmap.gov/v1/json?x={lon}&y={lat}&wkid=4326&units=Feet&includeDate=False
```

Returns `{"value": <float_feet>}`. Values below −9000 ft are treated as "no data".

The service identifier stored in the database is `USGS_EPQS_3DEP`.

## Cross-section sampling

A perpendicular transect is sampled across the roadway to capture the terrain profile on both sides.

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `half_width_m` | 60 m | Distance sampled on each side of the center point |
| `spacing_m` | 10 m | Distance between successive sample points |

This produces approximately 13 elevation points (−60 m … 0 … +60 m in 10 m steps) plus the center.

### Sampling sufficiency for the live slope render

The mobile **roadside slope profile** (see *Mobile slope profile render* below) draws the real
sampled cross-section and marks each sample with a dot. The default `half_width_m = 60`,
`spacing_m = 10` (≈13 points) is intentionally retained for the visual render:

- 60 m of half-width covers typical roadside cut/fill on both sides of a two-lane to multi-lane
  cross-section.
- 10 m spacing captures the cut/fill break and slope on each side with ~5 points per side, which
  reads cleanly once plotted with sample dots and a smoothed crest.
- Each EPQS point is a **separate sequential HTTPS request**. Halving the spacing (≈25 points)
  would roughly double fetch latency for only a marginal gain in fidelity, so it is not the
  default. Callers that want a denser transect can still pass a smaller `spacing_m` (≥1 m) or larger
  `half_width_m` (≤500 m) in the request body.

The crest is drawn with a **centripetal Catmull-Rom** spline that passes through **every** measured
sample (it does not overshoot or invent peaks between points), and each sample is still marked with a
dot. This gives a believable, art-directed silhouette while keeping the engineering data honest —
fidelity comes from the renderer, not from more network calls.

### Bearing and offsets

`road_bearing_deg` is the compass bearing (0–360°, clockwise from North) that the road runs in the
direction of increasing stationing (up-station direction). This value is read from
`road_inventory_context.snapshot.road_bearing_deg` when available; otherwise the caller must supply
it explicitly.

- Left-side points are offset at bearing `(road_bearing_deg + 270) % 360`
- Right-side points are offset at bearing `(road_bearing_deg + 90) % 360`

Offsets are computed using a spherical-Earth approximation (radius 6 371 008 m):

```
Δlat = distance_m / R × cos(bearing_rad)
Δlon = distance_m / R × sin(bearing_rad) / cos(lat_rad)
```

## Classification

After sampling, the profile is classified into one of five `TerrainSideShape` values:

| Class | Meaning |
|-------|---------|
| `LEFT_HIGH` | Left side is ≥ 5 ft above center; right side is flat or lower (cut slope on left) |
| `RIGHT_HIGH` | Right side is ≥ 5 ft above center; left side is flat or lower (cut slope on right) |
| `CROWN` | Both sides ≥ 5 ft above center (road in cut section) |
| `BOWL` | Both sides ≥ 5 ft below center (road on embankment / fill) |
| `FLAT` | Neither side differs from center by ≥ 5 ft |
| `UNKNOWN` | Insufficient data (no `road_bearing_deg`, or fewer than 2 off-center points resolved) |

Threshold: **5 ft elevation difference** vs. the center point, averaged over the outer 30 m on each side.

Confidence is set to `0.80` when a full cross-section is available and `0.0` otherwise.

### UNKNOWN limitation

When `road_bearing_deg` is not supplied, the service fetches only the center point and always returns
`UNKNOWN`. This covers the case where no road inventory context exists for the submission. Until a
bearing source is available, the mobile diagram AUTO terrain will fall back to FLAT.

## Road bearing

`road_bearing_deg` is the compass bearing (0–359°, clockwise from North) of the road in the
**upstation** (increasing postmile) direction.

### Bearing source order

The endpoint resolves bearing using the following priority:

| Priority | Source | `road_bearing_source` value |
|----------|--------|-----------------------------|
| 1 | Explicit in request payload | `"request"` |
| 2 | `road_inventory_context.snapshot.road_bearing_deg` | `"road_inventory_snapshot"` |
| 3 | Auto-derived from ArcGIS postmile geometry | `"arcgis_postmile_geometry"` |
| 4 | None (no bearing available) | `null` → classification `UNKNOWN` |

The resolved bearing and its source are stored in `elevation_profile.profile.metadata`:

**Request-supplied bearing:**
```json
{
  "road_bearing_deg_used": 90.0,
  "road_bearing_source": "request",
  "half_width_m": 60.0,
  "spacing_m": 10.0,
  "classification_requires_bearing": true
}
```

**Auto-derived bearing:**
```json
{
  "road_bearing_deg_used": 87.0,
  "road_bearing_source": "arcgis_postmile_geometry",
  "half_width_m": 60.0,
  "spacing_m": 10.0,
  "classification_requires_bearing": true,
  "road_bearing_derivation": {
    "method": "postmile_points_lower_to_higher",
    "source": "https://arcgis.example.com/.../FeatureServer/0"
  }
}
```

**Bearing absent:**
```json
{
  "road_bearing_deg_used": null,
  "road_bearing_source": null,
  "classification_requires_bearing": true,
  "classification_note": "No road bearing was provided; only center elevation was sampled."
}
```

### Automatic bearing derivation from postmile geometry

When neither the request payload nor the road inventory snapshot supply a bearing, the endpoint
attempts to derive one from the ArcGIS postmile feature layer (configured via
`POSTMILE_FEATURE_LAYER_URL`).

**Algorithm:**

1. Query the postmile layer with `returnGeometry=true`, `outSR=4326`, search distance
   `max(POSTMILE_SEARCH_DISTANCE_METERS, 3200)` metres (wider than the point-in-polygon query to
   capture marker points ~1 mile apart).
2. Filter returned features to those matching the submission's route, county, and district.
3. Identify the **nearest lower-PM point** (highest PM ≤ current PM) and the **nearest higher-PM
   point** (lowest PM > current PM).
4. Compute the geodesic initial bearing from the lower-PM point to the higher-PM point.  This
   defines the upstation / increasing-postmile road direction.
5. Round to 2 decimal places and return.

**Bearing formula** (geodesic initial bearing):
```
x = sin(Δlon) × cos(lat₂)
y = cos(lat₁) × sin(lat₂) − sin(lat₁) × cos(lat₂) × cos(Δlon)
bearing = atan2(x, y) normalized to [0, 360)
```

**Safety rules:**
- If `POSTMILE_FEATURE_LAYER_URL` is not configured, derivation is skipped and bearing stays `null`.
- If route, county, or post_mile are missing from the GISA record, derivation is skipped.
- If fewer than two valid geometry points pass filtering, derivation returns `null`.
- Any network or ArcGIS error is caught silently; the elevation profile request continues with
  bearing `null` and classification `UNKNOWN`.
- This function never infers bearing from `THY_TERRAIN_CODE` or any terrain classification field.

### CA Highways tabular extract limitation

The CA Highways tabular data (HICOMP) is postmile-based and contains no segment geometry or
bearing column. Automatic bearing derivation therefore relies on the ArcGIS postmile feature
layer supplying point geometries for the route. When the layer is not configured or returns
insufficient geometry points, bearing remains `null`.

## API endpoint

```
POST /submissions/{submission_id}/gisa/elevation-profile
```

**Request body** (all fields optional):

```json
{
  "road_bearing_deg": 90.0,
  "half_width_m": 60,
  "spacing_m": 10,
  "force": false
}
```

- `force: true` — re-fetch from USGS even if a profile already exists in the database.
- `force: false` (default) — return the cached profile if one is already stored.

**Response body**:

```json
{
  "elevation_profile": {
    "source": "USGS_EPQS_3DEP",
    "checked_at": "2026-06-10T12:34:56",
    "classification": "LEFT_HIGH",
    "confidence": 0.80,
    "profile": {
      "points": [
        { "offset_m": -60.0, "lat": 37.701, "lon": -122.401, "elevation_ft": 120.5, "source": "USGS_EPQS_3DEP" },
        ...
      ],
      "metadata": {
        "road_bearing_deg_used": 90.0,
        "road_bearing_source": "request",
        "half_width_m": 60.0,
        "spacing_m": 10.0,
        "classification_requires_bearing": true
      }
    },
    "error": null
  }
}
```

## Database columns (migration 0007)

Added to `submission_gisa`:

| Column | Type | Description |
|--------|------|-------------|
| `elevation_profile_json` | JSON | Full profile object with `points` array |
| `elevation_profile_source` | VARCHAR(64) | e.g. `USGS_EPQS_3DEP` |
| `elevation_profile_checked_at` | DATETIME | When the fetch was performed |
| `elevation_profile_classification` | VARCHAR(32) | One of the TerrainSideShape values |
| `elevation_profile_confidence` | FLOAT | 0.0–1.0 |
| `elevation_profile_error` | TEXT | Error message if fetch failed, else NULL |

All columns are nullable. Existing GISA rows are unaffected. GISA PATCH does not touch these columns.

## Web UI bearing display

The web elevation panel shows the resolved bearing and its source:

| `road_bearing_source` | Display text |
|-----------------------|-------------|
| `"request"` | `87° (request)` |
| `"road_inventory_snapshot"` | `87° (road inventory snapshot)` |
| `"arcgis_postmile_geometry"` | `87° (auto from postmile geometry)` |
| `null` | `not set — classification may be UNKNOWN` |

The bearing input field is pre-filled from `road_inventory_context.snapshot.road_bearing_deg` when
available. Leaving the field blank allows auto-derivation from postmile geometry on each Fetch/Refresh.

## Mobile refresh

Field users can fetch or refresh the elevation profile directly from the Measurements section
of the mobile submission detail screen.

### Controls

| Control | Behavior |
|---------|----------|
| **Fetch / Refresh button** | Calls `POST /submissions/{id}/gisa/elevation-profile` with `force: true` |
| Plain-language explainer | A one-line note states elevations come from USGS 3DEP and the road orientation is auto-detected. No GIS knowledge required. |
| **Advanced ▸ set road orientation manually** | A collapsed-by-default disclosure. Most users never open it. Inside is the optional bearing (deg) input, placeholder `Auto`. |
| Manual bearing validation | Input must be `0–359°`. Inline error shown if out of range; request is not sent. |
| Loading state | Button text changes to `Refreshing…` while the request is in flight. |
| Error display | On network or server failure, a red inline error appears below the panel. |

### Bearing input behavior

The manual bearing field is **demoted** behind the *Advanced* disclosure because auto-detection is
the intended path for normal users. Behaviour when opened:

- The field defaults to **blank** on every screen visit, regardless of previously stored metadata.
- If blank, the backend resolves bearing via: request payload → road_inventory_snapshot → ArcGIS
  postmile geometry → `null` (UNKNOWN). This is the default, no-input path.
- If filled, the value overrides all automatic sources and is sent as `road_bearing_deg` in the
  POST body (source: `"request"`).
- Advanced users testing specific bearing angles can type a value here; it is not persisted
  beyond the request.

### Local state update

On successful refresh the response `elevation_profile` object is:
1. Written into `localElevProfile` state (screen-scoped).
2. Merged into the `data.gisa.elevation_profile` state immediately.
3. Passed as the `elevationProfile` prop to both `RoadElevationProfileChart` (the live slope render)
   and `MeasurementDiagramRenderer` (the schematic measurement diagram).

This means the live slope profile **and** the diagram Terrain AUTO both update **without requiring a
screen reload or full data refresh**.

### Elevation profile summary display

| Field | Display |
|-------|---------|
| Source | `USGS_EPQS_3DEP` |
| Terrain summary | `LEFT_HIGH` / `RIGHT_HIGH` / `BOWL` / `CROWN` / `FLAT` / `UNKNOWN` (summary only — the live chart is the source of truth for shape) |
| Confidence | `54%` |
| Checked | `YYYY-MM-DD` |
| Road orientation | plain-language, see table below |

Road-orientation display (replaces the old raw "Bearing" row):

| `road_bearing_source` | Label |
|-----------------------|-------|
| `"request"` | `90° · manual override` |
| `"road_inventory_snapshot"` | `90° · from road inventory` |
| `"arcgis_postmile_geometry"` | `87° · auto-detected from map` |
| `null` / absent | `not detected yet — tap Refresh to auto-detect` |

## Mobile slope profile render

The headline of the Measurements section is a **live 2D roadside slope profile**
(`RoadElevationProfileChart`) that plots the *actual sampled cross-section* — `offset_m` vs.
`elevation_ft` from `elevation_profile.profile.points` — as an honest ground line. This is the real
terrain shape, not the coarse classification.

| Aspect | Behaviour |
|--------|-----------|
| Source of truth | `profile.points` (raw samples). `classification` is shown only as a one-word summary chip. |
| Normalization | Pure helper `buildElevationProfileGeometry()` maps offsets/elevations to plot fractions. Tested-by-construction, no rendering dependency. |
| Horizontal scale | Symmetric about the road center (offset 0) so the roadway sits dead center; extent labelled `±N m (N ft)`. |
| Vertical scale | Auto-fit to fill the plot, then **capped at 8× exaggeration** so small relief is not blown into dramatic terrain. Reported in-chart (`"3.0× vertical exaggeration"`, `"≈ true scale (1:1)"`, or `"…compressed to fit"`). |
| Crest curve | **Centripetal Catmull-Rom** through every measured sample (no overshoot, no invented peaks). A dot is drawn at each real sample so the data stays auditable. |
| Material render | The ground body is layered: base gradient (lit crest → shaded toe) → ambient-occlusion shadow → material texture pattern → moisture overlay, plus surface decorations. All colours/patterns come from `buildTerrainPalette()` (see *Form-driven terrain appearance*). An atmospheric sky gradient sits behind the cut. |
| Left/right | Canonical **UPSTATION** orientation only — LT is always on the left, RT on the right. There is no mirror/DOWNSTATION toggle. LT/RT chips, an `UPSTATION →` indicator, and a road-grade reference line are drawn. |
| Road band | If a roadway width (ft) is available it is drawn to scale at the center (tinted by pavement type); otherwise a center marker line is shown. |
| Legibility | Axis labels sit in the dark gutter; the `Road` label has a backing pill; decorations never cover the dimension text. |

### Slope-profile fallbacks

| Condition | Behaviour |
|-----------|-----------|
| `< 3` resolved samples (e.g. no bearing → center-only) | Empty state: *“Only the center point was sampled — a road orientation is needed to sample both sides.”* plus the center elevation if known. Never crashes. |
| Points present but no horizontal spread | Empty state with an explanation. |
| No profile fetched | Chart is not shown; the panel reads *“No elevation profile fetched.”* |
| No appearance/form context | Both renderers fall back to a neutral MIXED-material palette so the render never breaks. |

## Form-driven terrain appearance

The terrain *shape* comes from USGS elevation; the terrain *material/condition styling* is derived
from the GISA "Materials / Composition / Water / Vegetation" form fields by
`buildTerrainAppearance(form)` → `buildTerrainPalette(appearance)`
(`mobile/src/measurements/buildTerrainAppearance.ts`). Both the slope profile and the schematic
cross-section consume the same palette so they stay visually consistent.

| Visual cue | Driven by form field(s) | Effect |
|-----------|--------------------------|--------|
| Dominant material (SOIL / ROCK / MIXED) | `material_rock`, `material_soil`, `est_rock_pct`, `est_gravel_pct`, `est_boulder_pct`, `material_bedding`/`material_joints`/`material_fractures` | Soil-heavy → warm earthy fill + fine speckle texture; rock-heavy → cooler stony fill + angular fracture hatch + rock/boulder accents. |
| Soil composition tint | `est_clay_pct`, `est_sand_pct` | Sand warms/lightens the soil tone; clay shifts it redder. |
| Moisture | `water_moist` / `water_wet` / `water_flowing` (mutually exclusive base), `water_seep`, `water_spring` | Wetter → darker, damper body + a moisture sheen toward the toe; seep/spring/flowing add downslope water streaks. |
| Vegetation | `vegetation_trees`, `vegetation_bushes_shrubs`, `vegetation_groundcover` (% coverage) | Higher coverage → green-tinted crest line + vegetation clumps; trees weight clump size. |
| Pavement context | `material_pavement_type` (`ASPHALT` / `CONCRETE`) | Tints the roadway/shoulder fill (dark asphalt vs. pale concrete). |

Boolean fields are `"YES"/"NO"` strings in the mobile form; percentage fields are numeric strings.
Missing/blank fields fall back to sensible neutral defaults, so the render is always populated.

## Mobile diagram integration

The measurement diagram (`MeasurementDiagramRenderer` → `RoadCrossSectionRenderer`) now renders in
the **same world-space coordinate model** as the slope profile (see
*Coordinate model — world-space cross-section* in `docs/measurement-diagram-templates.md`). It builds
a `CrossSectionScene` via `buildCrossSectionSceneGeometry`:

- **Usable profile** → the terrain silhouette is the **real sampled transect** (flattened across the
  road deck), the road is sized by its physical width (≈17% of a ±60 m transect for a typical road),
  and failure overlays/dimensions anchor to the real road edges.
- **Unusable/missing profile** → it falls back to a `classification`-derived **schematic** silhouette
  in the same world model (road still subordinate), using:

| classification | Schematic fallback shape |
|----------------|----------------------|
| `LEFT_HIGH` | LT cut (higher) / RT fill (lower) |
| `RIGHT_HIGH` | RT cut / LT fill |
| `BOWL` | both sides lower (road on embankment) |
| `CROWN` | both sides higher (road in cut) |
| `FLAT` / `UNKNOWN` / `null` | level both sides (safe neutral) |

So `classification` is now strictly a **fallback**, not the primary driver — the real geometry is
used whenever the sampled points are usable. The source note row in the diagram still shows:
- `"Terrain: auto · USGS (LEFT_HIGH)"` when a valid non-UNKNOWN classification exists
- `"Terrain: auto · elevation unknown"` when classification is UNKNOWN
- `"Terrain: auto · no elevation profile"` when no profile has been fetched

The source note row in the diagram shows:
- `"Terrain: auto · USGS (LEFT_HIGH)"` when a valid non-UNKNOWN classification exists
- `"Terrain: auto · elevation unknown"` when classification is UNKNOWN
- `"Terrain: auto · no elevation profile"` when no profile has been fetched

Manual terrain buttons (L-High / R-High / Bowl / Crown / Flat) override AUTO regardless of the persisted classification.

## Error handling

- USGS EPQS is retried twice on network failure before returning `null` for that point.
- If the center point itself cannot be resolved, the full profile is marked with `classification: "UNKNOWN"` and a non-null `error` field.
- GISA `elevation_profile` will be `null` in the submission detail response if no fetch has been performed.

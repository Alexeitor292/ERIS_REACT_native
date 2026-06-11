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
| 3 | None (no bearing available) | `null` → classification `UNKNOWN` |

The resolved bearing and its source are stored in `elevation_profile.profile.metadata`:

```json
{
  "road_bearing_deg_used": 90.0,
  "road_bearing_source": "request",
  "half_width_m": 60.0,
  "spacing_m": 10.0,
  "classification_requires_bearing": true
}
```

When bearing is absent:
```json
{
  "road_bearing_deg_used": null,
  "road_bearing_source": null,
  "classification_requires_bearing": true,
  "classification_note": "No road bearing was provided; only center elevation was sampled."
}
```

### Why bearing is not automatic from CA Highways

The current CA Highways tabular extract (HICOMP) is postmile-based and contains no segment
geometry or heading column. Automatic bearing would require a Caltrans SHN shapefile or ArcGIS
route geometry layer. Until that is integrated, bearing must be supplied manually via the web
elevation panel or left absent.

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

## Future: bearing derivation

When `road_inventory_context.snapshot` contains a `road_bearing_deg` field, the endpoint will use it
automatically without requiring the caller to supply it. Until road inventory segment bearings are
added to the snapshot, pass `road_bearing_deg` manually or accept `UNKNOWN` classification.

## Mobile diagram integration

The mobile measurement diagram reads `elevation_profile.classification` to drive Terrain AUTO mode:

| classification | Rendered terrain shape |
|----------------|----------------------|
| `LEFT_HIGH` | LEFT_HIGH (cut slope on left) |
| `RIGHT_HIGH` | RIGHT_HIGH (cut slope on right) |
| `BOWL` | BOWL (road on embankment) |
| `CROWN` | CROWN (road in cut section) |
| `FLAT` | FLAT |
| `UNKNOWN` | FLAT (safe schematic fallback) |
| `null` / no profile | FLAT (safe schematic fallback) |

The source note row in the diagram shows:
- `"Terrain: auto · USGS (LEFT_HIGH)"` when a valid non-UNKNOWN classification exists
- `"Terrain: auto · elevation unknown"` when classification is UNKNOWN
- `"Terrain: auto · no elevation profile"` when no profile has been fetched

Manual terrain buttons (L-High / R-High / Bowl / Crown / Flat) override AUTO regardless of the persisted classification.

## Error handling

- USGS EPQS is retried twice on network failure before returning `null` for that point.
- If the center point itself cannot be resolved, the full profile is marked with `classification: "UNKNOWN"` and a non-null `error` field.
- GISA `elevation_profile` will be `null` in the submission detail response if no fetch has been performed.

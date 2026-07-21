# ADR: Offline road-context source for development and future production

Status: **Accepted for development; backend adapters IMPLEMENTED — `census_tigerweb` (2026-07-14), `caltrans_crs` (2026-07-21)**

Date: **2026-07-14** (addendum **2026-07-21**)

Scope: automatic `.eristerrain` package generation and the native offline Cross Section tool

> **Implementation note (2026-07-14).** `census_tigerweb` is implemented as a
> backend-only worker adapter (`OFFLINE_SCENE_ROAD_SOURCE=census_tigerweb`). The ArcGIS
> REST query path is generalized to both `MapServer/<id>` and `FeatureServer/<id>`, so
> `arcgis_feature_service` is preserved unchanged for a future authorized Caltrans
> Enterprise layer. No mobile, Objective-C, or Expo change was required, and **no new EAS
> build is needed** — the shipped app already consumes `roads.geojson` with
> `kind: "road_centerline"`.

> **Addendum (2026-07-21) — `caltrans_crs` California highway/freeway source.** An
> OPTIONAL, operator-selected provider (`OFFLINE_SCENE_ROAD_SOURCE=caltrans_crs`) packages
> California **highways and freeways** (not local streets) from the PUBLIC, credential-free
> Caltrans **CRS Functional Classification** ArcGIS FeatureServer
> (`.../CHhighway/CRS_Functional_Classification/FeatureServer/0`). It lives in a dedicated
> pure/worker module (`backend/app/services/offline_scene_caltrans.py`) so filter +
> normalization stay separate from networking. Highlights:
> - **Filter:** inclusion is driven by the layer's `F_System` functional-classification
>   field (the only classification lever it exposes). Default include = `1,2,3` (Interstate
>   + Other Freeways/Expressways + Other Principal Arterials = the state highway system,
>   excluding minor arterials/collectors/local), tunable via
>   `OFFLINE_SCENE_CALTRANS_FUNCTIONAL_CLASSES`. The `where` clause is built by a pure,
>   unit-tested function from validated integer codes only — never string-concatenated
>   input. `RouteID` values (e.g. `SHS_050._P`) confirm the included set is the State
>   Highway System.
> - **Pagination + safety:** bounded `resultOffset`/`resultRecordCount` pagination with
>   `exceededTransferLimit` detection, hard-capped by `_MAX_PAGES`/`_MAX_FEATURES`; https-only
>   endpoint, connect/read timeouts, bounded retry with jitter, max response size, JSON +
>   geometry + coordinate validation, dedupe by `OBJECTID`, and cancellation re-checked
>   between pages. It queries only the package AOI — never the statewide dataset.
> - **Schema:** minimal per-feature allowlist (`source_feature_id`, `route_id`, `NAME`,
>   `functional_class` + `functional_class_label`, `county`, `district`, `provider`), with
>   the ERIS-trusted `road_class` (`1,2,3` → `primary`) written last (unspoofable). The
>   existing divided-highway pairing merges `_P`/`_S` carriageways into a corridor.
> - **Failure policy:** `OFFLINE_SCENE_ROADS_REQUIRED` makes roads mandatory (job fails
>   rather than publishing a package without verified road data); `OFFLINE_SCENE_ROAD_SOURCE`
>   now also accepts `none`; there is **no silent fallback** — an explicit, audited
>   `OFFLINE_SCENE_ROAD_FALLBACK_SOURCE` records `roads.fallback` in the manifest+logs.
> - **Provenance/attribution:** "California Department of Transportation (Caltrans), CRS
>   Functional Classification / Linear Reference System-derived data" — road **context**,
>   not survey/engineering-grade. No mobile/Objective-C change was required (the shipped app
>   already renders `road_centerline` + `road_class`). The same public layer is also offered
>   as an OPTIONAL online web map toggle ("Caltrans Highways & Freeways"), independent of
>   whether a downloaded package contains packaged roads.

## Context

The native Cross Section tool requires two separate inputs:

1. a roadway-layout description (`road_cross_section.json`) for lanes, shoulders, median, and related schematic dimensions; and
2. road snap/orientation context (`roads.geojson` and/or a resolved road bearing) so a tap can be associated with a roadway line.

A package may legitimately contain a default roadway layout while having no road geometry or upstation bearing. In that state the mobile application correctly reports:

> Roadway layout is packaged, but no road snap geometry or upstation bearing is available for this area.

The current `eris_internal` source can package road context only when the submission/build context already contains usable line geometry or a resolved `roadBearingDeg`. It does not provide a general road network.

ERIS already supports an opt-in ArcGIS REST centerline adapter through the historical configuration name `arcgis_feature_service`. Connecting development directly to the Caltrans ArcGIS Enterprise ecosystem is intentionally deferred because it would couple current development to a separate managed environment, credentials, governance, and workstation constraints before that integration is ready.

## Decision

For the current independent development environment, ERIS will use the public **U.S. Census Bureau TIGERweb Transportation** service as the planned default external road-snap source.

This source is for development and functional field testing of:

- packaging `roads.geojson`;
- drawing offline road context;
- snapping a terrain tap to a nearby line;
- deriving a local road tangent for a cross-section; and
- proving the complete worker → package → iPhone Airplane-Mode workflow.

It is **not** authoritative Caltrans engineering data and must never be represented as such.

As of the decision the code supported `eris_internal` and `arcgis_feature_service`. `census_tigerweb` has since been implemented as the backend-only adapter described under "Required implementation behavior"; the code now supports all three sources.

## Selected public service

Base service:

```text
https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer
```

Planned layers:

| Layer ID | Service name | Intended use |
|---:|---|---|
| `2` | Primary Roads | Major-road centerlines |
| `6` | Secondary Roads 72_1k scale | Secondary-road coverage |
| `8` | Local Roads | Local-street coverage |

At the time of this decision, the service directory identifies these as feature layers with `esriGeometryPolyline`, supports query output including GeoJSON, and attributes the source to the U.S. Census Bureau. The service and layer metadata must be rechecked during implementation and periodically afterward because public service schemas, layer IDs, dates, availability, and operational limits can change.

## Target configuration

The planned operator contract is:

```env
OFFLINE_SCENE_ROADS_ENABLED=true
OFFLINE_SCENE_ROAD_SOURCE=census_tigerweb
OFFLINE_SCENE_TIGERWEB_BASE_URL=https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer
OFFLINE_SCENE_TIGERWEB_LAYERS=2,6,8
OFFLINE_SCENE_ROAD_BUFFER_M=250
OFFLINE_SCENE_ROAD_FETCH_TIMEOUT_S=30
OFFLINE_SCENE_ROAD_CROSS_SECTION_ENABLED=true
```

These `census_tigerweb` variables are **recognized by the backend** as of the 2026-07-14 adapter implementation. A running deployment still only uses them once the worker is redeployed with the new image and the variables are set.

## Required implementation behavior

The backend implementation should generalize the existing ArcGIS REST query path so that both `MapServer/<layer>` and `FeatureServer/<layer>` line layers can be queried by the worker.

For `census_tigerweb`, the worker must:

- query configured layer IDs against package bounds plus the configured buffer;
- request WGS84 output and line geometry;
- accept GeoJSON `LineString`/`MultiLineString` and Esri `paths` defensively;
- combine successful layers while allowing one layer to fail without discarding the others;
- clip and validate geometry before packaging;
- deduplicate identical or effectively identical lines;
- preserve only an allowlist of useful non-sensitive attributes, such as `NAME`, `BASENAME`, `MTFCC`, and `RTTYP`;
- package the result as `roads.geojson` with `kind: "road_centerline"`;
- fetch only during worker package generation;
- make no road-source request from the mobile application; and
- degrade honestly to an unavailable roads layer if no usable feature is returned.

The manifest provenance must be truthful, for example:

```json
{
  "provider": "us_census_tigerweb",
  "dataset": "U.S. Census Bureau TIGERweb Transportation Roads",
  "attribution": "U.S. Census Bureau",
  "service": "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer"
}
```

It must never label TIGERweb geometry as Caltrans, ERIS Road Inventory, ArcGIS Enterprise, survey-grade, or engineering-grade.

## Accuracy and product boundaries

TIGERweb provides road geometry suitable for development snap context. It does not, by itself, provide authoritative values for:

- Caltrans route/postmile direction;
- increasing-postmile upstation orientation;
- lane and shoulder widths;
- median design;
- crown, cross-slope, superelevation, curb, or pavement structure;
- current construction alignment; or
- survey-grade horizontal or vertical control.

The roadway-layout source remains independently identified as `ROAD_INVENTORY`, `FORM_FIELDS`, or `DEFAULT`. USGS 3DEP remains the ground-elevation source.

When TIGERweb geometry is available but no authoritative `roadBearingDeg` is available, ERIS may use the centerline tangent to construct a development cross-section, but it must preserve `orientation_available=false` and must not imply that the chosen line direction is verified increasing postmile. A future UX review should ensure that “Looking upstation” is not presented as authoritative in that degraded state.

## Road classification (added after the first field test)

Field testing of package `vg20260714175006-18` showed local streets were visible and
selectable while the actual freeway was hard or impossible to select, because
`roads.geojson` carried no way to tell a highway from a driveway. The class is therefore
made **explicit and trusted** at package-build time.

The class is derived from **which TIGERweb layer the worker queried**, never from a
provider attribute:

| Layer | `source_layer_id` | `road_class` | `road_class_label`        |
| ----- | ----------------- | ------------ | ------------------------- |
| 2     | `2`               | `primary`    | `Primary road / highway`  |
| 6     | `6`               | `secondary`  | `Secondary road`          |
| 8     | `8`               | `local`      | `Local road`              |
| other | as configured     | `unclassified` | `Unclassified road`     |

Every TIGERweb feature in `roads.geojson` therefore carries:

```json
{
  "NAME": "US-50", "BASENAME": "US-50", "MTFCC": "S1100", "RTTYP": "U",
  "source_layer_id": 2,
  "road_class": "primary",
  "road_class_label": "Primary road / highway",
  "kind": "road_centerline"
}
```

Rules that must hold:

- `kind`, `source_layer_id`, `road_class`, and `road_class_label` are **ERIS-trusted**.
  They are written **after** the provider attribute allowlist, so a TIGERweb attribute
  named `road_class` (or `kind`) can never spoof them. A misconfigured layer ID degrades
  to `unclassified` — it must never silently become a highway.
- Deduplication of the same geometry across layers retains the **highest** class:
  `primary > secondary > local > unclassified`. The priority is explicit, not an accident
  of request order. The winning feature keeps **its own** safe metadata; loser attributes
  are never merged in.
- Only `NAME`, `BASENAME`, `MTFCC`, `RTTYP` are preserved from the provider.

The manifest advertises only the classes **actually packaged**:

```json
"roads": {
  "available": true, "file": "context_layers/roads.geojson",
  "feature_count": 128, "road_kinds": ["road_centerline"],
  "road_classes": ["local", "primary", "secondary"],
  "road_class_counts": { "primary": 4, "secondary": 11, "local": 113 },
  "source": { "provider": "us_census_tigerweb", "dataset": "U.S. Census Bureau TIGERweb Transportation Roads", "attribution": "U.S. Census Bureau", "service": "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer" }
}
```

`road_classes`/`road_class_counts` are **omitted** when no classified roads were packaged
(e.g. `eris_internal` road-bearing geometry). Provider/dataset/attribution are unchanged.

This ADR does **not** decide the native renderer behavior. A later mobile milestone will
use `road_class` for highway-first selection and the immersive cross-section transition.

## Road-versus-imagery alignment diagnostic

The same field test showed some TIGERweb lines appearing displaced from the packaged
aerial imagery. Before changing the native renderer, we must know **where** the
displacement comes from. A deterministic, server-side diagnostic renders the roads and
the imagery of a **specific `.eristerrain` package** into one image, using only packaged
files and no network:

```sh
python -m app.tools.offline_scene_alignment \
  --package /tmp/package.eristerrain \
  --output-dir /tmp/eris-alignment
```

It writes `road-imagery-alignment.png` (imagery/tile mosaic + roads styled by class:
primary = thick magenta, secondary = medium orange, local = thin cyan, incident marker,
package boundary outline) and `road-imagery-alignment.json` (package version, terrain and
imagery bounds, imagery format, feature counts by class, road bbox, malformed features
dropped, the road clipping contract, both out-of-bounds counters, provider/dataset, and
the exact lon/lat→pixel transform). Tiles are placed by **each tile's own declared
bounds**, never by filename order. In Docker the Compose service to exec into is
`offline-scene-worker`.

### The road clipping contract must be packaged, not inferred

Road context is clipped to *terrain bounds + `OFFLINE_SCENE_ROAD_BUFFER_M`*, so roads
**legitimately** extend beyond the terrain/imagery footprint. A diagnostic that checked
road coordinates against terrain bounds alone would condemn perfectly valid buffered
geometry. Therefore the roads manifest layer persists the exact bounds that were applied:

```json
"roads": {
  "clip_bounds": { "min_lat": 38.3978, "min_lon": -121.6029, "max_lat": 38.5022, "max_lon": -121.3971 },
  "buffer_m": 250
}
```

`clip_bounds` is exactly what `roads_geojson_from_context` clipped to (both go through
`road_clip_bounds()`, so they cannot drift). A reader must **never** recompute it from
live configuration — the package stays self-describing and reproducible even after the
config changes. The diagnostic then reports two distinct things:

- `coordinates_outside_terrain_bounds` — outside the terrain/imagery frame. **Expected**
  to be non-zero; that is the buffer. Such geometry is still drawn (Pillow clips it at the
  canvas edge) and is never called malformed or invalid.
- `coordinates_outside_road_clip_bounds` — outside the package's own declared
  `clip_bounds`. A **packaging contract violation**; normally `0`.

For a legacy package with no `clip_bounds`, `road_clip_bounds` is `null`,
`road_clip_bounds_status` is `not_declared_legacy`, and
`coordinates_outside_road_clip_bounds` is `null` — **unknown, not zero**. Terrain bounds
are not a stand-in for the clipping contract.

### Interpreting the result — the next decision

- **A. Roads line up with the imagery in the diagnostic, but not on the iPhone.** The
  package is self-consistent; the fault is in the **native coordinate/texture transform**.
  Fix the renderer. Do not change the road source.
- **B. Roads are displaced in the diagnostic too.** The package itself disagrees. The
  displacement is **TIGERweb geometry versus the packaged imagery** — i.e. source accuracy
  and generalization, which this ADR already accepts as *context, not survey-grade*. Treat
  it as a source-accuracy question (or revisit the provider), not a renderer bug.

**Warning — do not apply a global lon/lat offset.** It is tempting to eyeball one
screenshot and shift every road by a fixed delta. Do not. TIGERweb error is *not* a
constant translation: it varies by area, road class, and vintage, and a global nudge would
fabricate precision, corrupt correctly-placed roads, and silently misrepresent an
unverified alignment as a corrected one. The diagnostic measures **package-coordinate
consistency only** — it cannot declare the imagery's visible pavement centerlines
authoritative, and it is not a survey or an engineering-grade check.

## Alternatives retained for future review

### 1. ERIS internal context

`OFFLINE_SCENE_ROAD_SOURCE=eris_internal` remains the preferred zero-network path when the build context already contains real submitted line geometry, Road Inventory geometry, or a resolved road bearing.

Advantages: no external runtime dependency, strongest ERIS provenance, simple offline packaging.  
Limitation: many submissions currently have layout data but no usable centerline or bearing.

### 2. Personal Esri developer / ArcGIS Location Platform or hosted test layer

A personal Esri developer account may be used later to host a small, isolated development centerline layer without touching Caltrans Enterprise.

Advantages: controlled test dataset, familiar ArcGIS REST contract, useful for authentication and private-layer testing.  
Limitations: account entitlement, pricing, storage, authentication, and service terms must be reverified at the time of use; it should not become a hidden requirement for local ERIS development.

### 3. ArcGIS Online trial or subscription

ArcGIS Online can host feature layers and may be useful for a temporary proof of concept. The standard public trial is time-limited, so it is not selected as the durable development dependency.

Advantages: managed hosting and ArcGIS tooling.  
Limitations: trial/subscription lifecycle, credits, account governance, and avoidable vendor coupling.

### 4. Caltrans ArcGIS Enterprise

> **Update (2026-07-21).** The PUBLIC Caltrans **CRS Functional Classification**
> FeatureServer is now implemented as `caltrans_crs` (see the addendum above) — a
> credential-free California highway/freeway **context** source. That is distinct from
> the authenticated Caltrans **Enterprise** integration described here, which remains the
> future path for authoritative route/postmile alignment and Road Inventory coupling.

This remains the likely production or authoritative integration when the organizational environment, service owner, credentials, licensing, network path, data contract, and security review are ready.

Advantages: authoritative organizational data, route/postmile alignment, potential Road Inventory integration, governed access.  
Limitations: premature coupling would slow independent development and require managed environment access now.

No Caltrans Enterprise URL, token, account, or internal endpoint belongs in source control, a mobile bundle, package provenance, or logs.

### 5. Self-hosted road data

ERIS may later ingest a versioned TIGER/Line or OpenStreetMap-derived extract into PostGIS, object storage, or prebuilt bounded GeoJSON.

Advantages: no live third-party dependency during package generation, deterministic snapshots, full control over refresh and availability.  
Limitations: ingestion, updates, deduplication, spatial indexing, attribution/licensing review, and operational ownership become ERIS responsibilities.

### 6. Static fixtures

Small committed or test-generated GeoJSON fixtures remain appropriate for deterministic automated tests and demos. They are not a substitute for field-area road coverage and must never be silently used as production geometry.

## Why TIGERweb is selected now

- It avoids connection to the Caltrans Enterprise environment during independent development.
- It does not require an additional mobile build or on-device network path.
- It matches the existing worker-side ArcGIS REST query model closely.
- It provides broad road-line coverage sufficient to exercise snapping and offline packaging.
- It keeps the production provider replaceable through configuration and provenance instead of coupling the package format to one GIS ecosystem.

## Consequences

Positive:

- Cross Section development can continue on the current laptop and Proxmox environment.
- No Caltrans credentials or internal endpoints are introduced.
- The existing iOS build can consume newly generated packages after a backend-only provider implementation and deployment.
- The package remains fully offline after download.

Tradeoffs:

- TIGERweb availability and schema are external dependencies at package-build time.
- Geometry is suitable for context, not engineering claims.
- Upstation remains unverified without a separate authoritative bearing.
- Production migration to Caltrans or another provider will still require integration and acceptance work.

## Review triggers

Revisit this ADR when any of the following occurs:

- Caltrans provides an approved development and production road-centerline service;
- authoritative route/postmile and upstation behavior becomes required;
- TIGERweb layer IDs, schema, availability, performance, or access policy changes;
- public-service reliability is inadequate for package generation;
- ERIS needs private/offline generation with no external network dependency;
- a self-hosted PostGIS or versioned road snapshot pipeline becomes operationally justified;
- field testing reveals unacceptable snap accuracy; or
- security, licensing, privacy, or data-governance review changes the allowed provider set.

## External references to revalidate

- U.S. Census TIGERweb Transportation service directory: `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer`
- Primary Roads layer 2: `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer/2`
- Secondary Roads layer 6: `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer/6`
- Local Roads layer 8: `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer/8`
- Esri developer platform and pricing: `https://developers.arcgis.com/`
- ArcGIS Online trial information: `https://www.esri.com/en-us/arcgis/products/arcgis-online/trial`

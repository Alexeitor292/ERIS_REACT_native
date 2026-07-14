# ADR: Offline road-context source for development and future production

Status: **Accepted for development; backend adapter IMPLEMENTED (2026-07-14)**

Date: **2026-07-14**  
Scope: automatic `.eristerrain` package generation and the native offline Cross Section tool

> **Implementation note (2026-07-14).** `census_tigerweb` is implemented as a
> backend-only worker adapter (`OFFLINE_SCENE_ROAD_SOURCE=census_tigerweb`). The ArcGIS
> REST query path is generalized to both `MapServer/<id>` and `FeatureServer/<id>`, so
> `arcgis_feature_service` is preserved unchanged for a future authorized Caltrans
> Enterprise layer. No mobile, Objective-C, or Expo change was required, and **no new EAS
> build is needed** — the shipped app already consumes `roads.geojson` with
> `kind: "road_centerline"`.

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

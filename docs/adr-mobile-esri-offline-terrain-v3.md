# ADR — ERIS mobile offline terrain v3: Esri tiled scene visualization

Status: proposed/implemented on `feature/mobile-esri-offline-terrain`.

## Decision

New automatically generated mobile terrain packages use catalog format
`eristerrain_esri` and ERIS bundle format version 3. The package remains an ERIS-
managed immutable bundle stored in the private MinIO offline-scenes bucket, but it
adds two authenticated CompactV2 exports for the package AOI:

- `esri-terrain.tpkx` — Esri Terrain 3D (for Export), LERC elevation tiles.
- `esri-imagery.tpkx` — Esri World Imagery from its export-enabled tile service.

The native iOS viewer opens both local caches in `AGSSceneView`:
`AGSArcGISTiledElevationSource` supplies the base surface and `AGSArcGISTiledLayer`
supplies the satellite imagery drape. Neither layer contacts an Esri service while
viewing a downloaded package. Surface exaggeration defaults to 1.0x.

## Why

The former whole-AOI 256x256 USGS height field is deterministic and useful for
analysis/provenance, but its fixed posting loses terrain detail on steep remote road
corridors. A narrow road bench can disappear between samples and appear swallowed
by the surrounding slope. The Web UI already demonstrates the desired behavior by
using ArcGIS World Elevation and imagery in a high-quality SceneView.

Esri's offline tile-cache path preserves tiled levels of detail and is consumed by
ArcGIS Runtime as native tiled elevation/imagery instead of collapsing the whole AOI
into one ERIS mesh and one fixed texture.

## What does NOT change

USGS 3DEP remains the authoritative analytical/provenance surface in ERIS. The
existing USGS height grid, hillshade, road context, Road Inventory cross-section
context, overlays, content checksums, MinIO object immutability, signed download,
and package catalog remain in place.

This is an explicit separation of responsibilities:

- Esri Terrain 3D TPKX: visual 3D ground surface and navigation fidelity.
- Esri World Imagery TPKX: offline satellite visual context.
- USGS 3DEP / future S1M: engineering analysis, reported elevation provenance, and
  cross-section calculations.

Neither elevation source is described as surveyed pavement or bridge-deck elevation.

## Compatibility

Legacy catalog format `eristerrain` continues to open in the existing ERIS native
terrain renderer. Real `.mspk` packages continue to open in the existing mobile
scene-package controller. Only `eristerrain_esri` is routed to the new local tiled
SceneView.

Both Esri export contracts are included in the worker content signature. Existing
devices therefore see an update available for a previously downloaded legacy
package covering the same incident/AOI.

## Authentication and offline boundary

Terrain 3D and World Imagery export are performed by the ERIS worker using backend-
managed ArcGIS credentials. The credential is never written to the package,
manifest, MinIO object metadata, or mobile registry. The phone downloads only the
finished ERIS package. After download, the native viewer reads both embedded TPKX
files locally.

Package generation fails closed if either authenticated Esri export cannot be
completed; it does not silently publish a legacy/coarse surface under the new format.

## Size policy

The existing `OFFLINE_SCENE_MAX_PACKAGE_MB` policy remains authoritative (512 MB by
default). The v3 builder evaluates the final ERIS bundle after both Esri caches are
embedded. If every advertised LOD cannot fit under the configured package limit,
generation fails with a smaller-AOI instruction. ERIS does not silently remove the
highest-detail LODs and then claim Web-equivalent fidelity.

## Fidelity boundary

The intent is to match the Web SceneView experience as closely as Esri's supported
offline exports permit, using every LOD advertised by the export-enabled Terrain3D
and World Imagery services for the bounded AOI. Esri documents the export elevation
service as equivalent to Terrain 3D except for source datasets that are not included
in the export product. Accordingly, ERIS must not claim byte-for-byte identity with
the online surface in those exceptional coverage areas.

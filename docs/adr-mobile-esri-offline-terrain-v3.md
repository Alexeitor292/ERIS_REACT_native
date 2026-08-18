# ADR — ERIS mobile offline terrain v3: Esri tiled elevation for visualization

Status: proposed/implemented on `feature/mobile-esri-offline-terrain`.

## Decision

New automatically generated mobile terrain packages use catalog format
`eristerrain_esri` and ERIS bundle format version 3. The package remains an ERIS-
managed immutable bundle stored in the private MinIO offline-scenes bucket, but it
adds `esri-terrain.tpkx`: an authenticated CompactV2/LERC export of Esri Terrain 3D
(for Export) for the package AOI.

The native iOS viewer opens that local tile cache with `AGSTileCache` and
`AGSArcGISTiledElevationSource` in `AGSSceneView`. It performs no elevation-service
request while viewing the downloaded package. Surface exaggeration defaults to
1.0x.

## Why

The former whole-AOI 256x256 USGS height field is deterministic and useful for
analysis/provenance, but its fixed posting loses terrain detail on steep remote road
corridors. A narrow road bench can disappear between samples and appear swallowed
by the surrounding slope. The Web UI already demonstrates the desired behavior by
using ArcGIS World Elevation in a high-quality SceneView.

Esri Terrain 3D's offline export path preserves the service's tiled LOD model and is
consumed by ArcGIS Runtime as an actual tiled elevation source instead of being
collapsed into one ERIS mesh.

## What does NOT change

USGS 3DEP remains the authoritative analytical/provenance surface in ERIS. The
existing USGS height grid, hillshade, road context, Road Inventory cross-section
context, overlays, content checksums, MinIO object immutability, signed download,
and package catalog remain in place.

This is an explicit separation of responsibilities:

- Esri Terrain 3D TPKX: visual 3D ground surface and navigation fidelity.
- USGS 3DEP / future S1M: engineering analysis, reported elevation provenance, and
  cross-section calculations.

Neither source is described as surveyed pavement or bridge-deck elevation.

## Compatibility

Legacy catalog format `eristerrain` continues to open in the existing ERIS native
terrain renderer. Real `.mspk` packages continue to open in the existing mobile
scene-package controller. Only `eristerrain_esri` is routed to the new local tiled-
elevation SceneView.

The Esri export contract is included in the worker content signature. Existing
devices therefore see an update available for a previously downloaded legacy
package covering the same incident/AOI.

## Authentication and offline boundary

Terrain 3D export is performed by the ERIS worker using backend-managed ArcGIS
credentials. The credential is never written to the package, manifest, MinIO object
metadata, or mobile registry. The phone downloads only the finished ERIS package.
After download, the native Terrain3D renderer reads the embedded TPKX locally.

Package generation fails closed if authenticated Terrain3D export cannot be
completed; it does not silently publish a legacy coarse surface under the new
format.

## Fidelity boundary

The intent is to match the Web SceneView terrain behavior as closely as Esri's
supported offline export permits, using every LOD advertised by the export-enabled
Terrain3D service for the bounded AOI. Esri documents the export layer as equivalent
to Terrain 3D except for source datasets that are not included in the export product.
Accordingly, ERIS must not claim byte-for-byte identity with the online surface in
those exceptional coverage areas.

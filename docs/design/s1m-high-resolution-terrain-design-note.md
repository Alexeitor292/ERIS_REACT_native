# Design note — truthful high-resolution (S1M) offline terrain

Status: **design only.** Nothing in this note is implemented in
`fix/offline-terrain-field-correctness`. It records the intended next architecture so a
later PR can be scoped honestly. This branch deliberately does **not** add an S1M switch,
does **not** relabel the current output as S1M, and changes no imagery/elevation contract.

## 1. What ships today (the truthful baseline)

The offline package's elevation comes from the USGS **3DEPElevation** ImageServer, sampled
into a single packaged height grid (e.g. 256×256 over a ~1,500 m-radius AOI ≈ **11.72 m/px**
for the field package under review). Provenance is recorded as `USGS_3DEP_OFFLINE_GRID`. This
is a **bare-earth DEM**: it models the ground surface, not the road deck, and at ~12 m
posting it cannot resolve a cross-section's true roadway grade. The cross-section tools now
state this explicitly (see DEFECT D — "bare-earth terrain under the centerline, not pavement
grade") and default to **1.0× true scale**.

"S1M" here refers to a **1-metre (or finer)** seamless bare-earth product (e.g. USGS 3DEP 1 m
DEM, distributed as Cloud-Optimized GeoTIFF / COG tiles). It is still **bare earth** — a finer
S1M grid improves terrain fidelity but **does not** supply bridge-deck or pavement-surface
elevations. Any future note or UI must keep that distinction.

## 2. Why a naive "switch to S1M" is wrong

- **Coverage is not universal.** 1 m 3DEP coverage is a patchwork; an AOI may be fully,
  partially, or not covered. Silently upgrading the source label without verifying coverage
  would produce packages whose stated resolution is a lie for uncovered areas.
- **Lineage matters.** A 1 m tile has its own acquisition date, method (lidar QL1/QL2), and
  project boundary. Packaging it as "3DEP" without lineage repeats the exact class of defect
  PR #55 fixed for imagery (recording a claim the bytes do not support).
- **Size.** A 1 m grid over a 3 km-diameter AOI is ~3000×3000 samples — ~100× the current
  grid. It cannot be a single packaged grid at the current budget.

## 3. Proposed architecture (future PR)

1. **Truthful S1M coverage detection + COG lineage.**
   - Query the S1M source's coverage/footprint for the AOI *before* packaging. Record, per
     package, the fraction of the AOI actually covered at 1 m, the source dataset id, the
     acquisition/vintage, and the COG tile lineage (tile ids + checksums). Fail closed —
     never relabel — when coverage is absent or the lineage cannot be verified, mirroring the
     imagery exact-extent contract (`exact_extent_arcgis_export_v2`).
   - Introduce a versioned elevation export contract string (analogous to
     `IMAGERY_EXPORT_CONTRACT`) folded into `content_signature`, so upgrading the elevation
     source deterministically invalidates stale packages and a device re-downloads.

2. **Tiered terrain: overview mesh + high-resolution corridor sampling.**
   - Keep a **low-resolution overview mesh** (today's ~256-grid) for the whole AOI — fast to
     render, small, and sufficient for context.
   - Add **high-resolution corridor sampling**: sample S1M elevations only along/near the
     selected road corridor (a narrow buffer), where the cross-section tools actually need
     fidelity. This bounds package size while giving the inspection views real 1 m ground.
   - Alternative for full-AOI HD: a **tiled terrain LOD** (height tiles + a manifest, like the
     imagery tile grid) so the renderer streams only the tiles in view. Heavier; defer unless
     needed.

3. **Storage.** A high-resolution stored elevation grid or tiled terrain LOD as a new packaged
   asset with its own manifest block, sha256, and per-tile verification — never overwriting or
   silently redefining the existing `terrain` grid contract.

4. **Honesty in the UI.** Even with S1M, the cross-section provenance must continue to say the
   surface is **bare-earth terrain under the centerline, not the pavement grade**. A separately
   named, versioned, visibly-labelled *inferred road-grade* capability (if ever built) is the
   only place a pavement/deck model may appear, and it must never be presented as measured DEM
   truth.

## 4. Explicitly out of scope for this branch

- No S1M fetch, no coverage query, no COG handling.
- No new elevation asset, no tiled terrain LOD.
- No change to the packaged `terrain` grid, the imagery export contract, or `content_signature`
  beyond the road-provenance change already required by DEFECT A.
- No relabeling of 3DEPElevation output as S1M anywhere (backend, manifest, or native UI).

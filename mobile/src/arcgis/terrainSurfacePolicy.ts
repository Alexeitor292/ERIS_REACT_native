// ONE authoritative visible terrain surface per base mode. This is the TESTED mirror of
// -applyBaseSurface in ErisTerrainSceneViewController.m — keep the two in lockstep.
//
// THE DEFECT this fixes: the native renderer used to keep the base triangular terrain mesh
// ALWAYS visible AND drape independent bilinear imagery patch meshes ~0.05 m above it. A
// bilinear patch is not identical to the two triangles of each grid cell (and the patches
// were under-tessellated), so the base mesh poked THROUGH the aerial imagery as white/grey
// facets — worsened by a default lit material adding specular highlights.
//
// THE CONTRACT: exactly one terrain surface is visible per base mode. The base mesh and the
// tiled imagery surface are NEVER simultaneously visible; satellite imagery is drawn with a
// constant (unlit) material so no scene light or specular can whiten it.
//
// No react-native/expo imports (unit-tested under node --experimental-strip-types --test).

export type BaseMode = "relief" | "satellite" | "hybrid";

export type TerrainSurfaceInputs = {
  /** Every declared tile loaded, validated and built into a patch (25/25 fail-closed). */
  tiledImageryReady: boolean;
  /** A legacy single-image aerial texture is available (older packages). */
  singleImageAvailable: boolean;
};

export type TerrainSurfacePolicy = {
  /** The base triangular terrain mesh is the visible surface. */
  baseTerrainVisible: boolean;
  /** The tiled imagery patch surface is the visible surface. */
  tiledImageryVisible: boolean;
  /** Imagery is drawn with a constant/unlit material (no specular/scene-light whitening). */
  imageryUnlit: boolean;
  /** Hybrid: hillshade is multiplied onto the SAME imagery surface (never a 2nd mesh). */
  hillshadeOnImagery: boolean;
  /** Legacy single-image path: the base mesh's own diffuse is repainted (one surface). */
  legacySingleImageOnBase: boolean;
  /** Why this policy resulted (for diagnostics / package-details copy). */
  reason: "relief" | "tiled_satellite" | "tiled_hybrid" | "legacy_single" | "relief_fallback";
};

/**
 * Resolve the ONE visible terrain surface + its material for a base mode.
 *
 * Invariants (asserted in tests):
 *   * baseTerrainVisible and tiledImageryVisible are NEVER both true.
 *   * satellite/hybrid with ready tiles: base hidden, tiled visible, imagery unlit.
 *   * hybrid uses the SAME imagery surface with hillshade multiply — no second mesh.
 *   * relief always uses the base mesh.
 *   * missing/incomplete tiled imagery falls back to relief (base mesh), never a partial
 *     tiled surface.
 */
export function terrainSurfacePolicy(
  mode: BaseMode,
  { tiledImageryReady, singleImageAvailable }: TerrainSurfaceInputs,
): TerrainSurfacePolicy {
  const RELIEF: TerrainSurfacePolicy = {
    baseTerrainVisible: true,
    tiledImageryVisible: false,
    imageryUnlit: false,
    hillshadeOnImagery: false,
    legacySingleImageOnBase: false,
    reason: "relief",
  };

  if (mode === "relief") return RELIEF;

  // Satellite / Hybrid want imagery.
  if (tiledImageryReady) {
    return {
      baseTerrainVisible: false, // authoritative base mesh HIDDEN under the imagery surface
      tiledImageryVisible: true,
      imageryUnlit: true, // constant material: no specular / scene-light whitening
      hillshadeOnImagery: mode === "hybrid",
      legacySingleImageOnBase: false,
      reason: mode === "hybrid" ? "tiled_hybrid" : "tiled_satellite",
    };
  }
  if (singleImageAvailable) {
    // Legacy single-image path repaints the base mesh's own diffuse — still ONE surface.
    // Aerial imagery is drawn UNLIT here too (the native branch sets
    // SCNLightingModelConstant), so this mirror must report imageryUnlit: true.
    return {
      baseTerrainVisible: true,
      tiledImageryVisible: false,
      imageryUnlit: true,
      hillshadeOnImagery: mode === "hybrid",
      legacySingleImageOnBase: true,
      reason: "legacy_single",
    };
  }
  // No usable imagery: fall back to relief rather than showing a broken/partial surface.
  return { ...RELIEF, reason: "relief_fallback" };
}

/** Guard used by tests + callers: the two terrain surfaces are never both visible. */
export function surfacesAreMutuallyExclusive(p: TerrainSurfacePolicy): boolean {
  return !(p.baseTerrainVisible && p.tiledImageryVisible);
}

// Pure reference logic for LOCAL, TILE-NATIVE immersive corridor imagery.
//
// The old immersive compositor flattened ALL AOI imagery into a fixed CGSizeMake(512, 512)
// square: it discarded most packaged detail, ignored geographic aspect, and pretended the
// result carried more information than the source. This module decides, deterministically:
//
//   * which packaged tiles actually intersect the corridor (never the whole AOI);
//   * the USEFUL output size = corridor ground metres / effective_meters_per_pixel;
//   * aspect preservation, a source-density ceiling, a 3072 safety cap, and a decoded/GPU
//     memory budget;
//   * truthful provenance flags (source-resolution limited / memory capped).
//
// GROUND SAMPLE DISTANCE controls genuine detail. Tile pixel dimensions only control
// request partitioning and texture management — a bigger tile_px never creates real detail.
// A 260 m corridor at 0.6 m/px holds ~433 genuine source pixels across; a 3072 texture
// would be ~7x upscale and must never be presented as additional detail.
//
// This is the TESTED mirror of the Objective-C corridor compositor — keep in lockstep.
// No react-native/expo imports (unit-tested under node --test).

export type LonLatBounds = { min_lon: number; min_lat: number; max_lon: number; max_lat: number };

export type ImageryTileMeta = {
  file: string;
  bounds: LonLatBounds;
  row?: number;
  column?: number;
  /** decoded pixel dims when the worker measured them */
  width_px?: number;
  height_px?: number;
};

const M_PER_DEG_LAT = 111_320.0;

/** Safety ceiling for the longest texture side. A CEILING, never a target. */
export const MAX_CORRIDOR_TEXTURE_PX = 3072;
/** Decoded RGBA budget for one local corridor texture (bytes). */
export const CORRIDOR_TEXTURE_MEMORY_BUDGET_BYTES = 64 * 1024 * 1024;
/** Minimum useful side so a degenerate corridor still yields a sane texture. */
export const MIN_CORRIDOR_TEXTURE_PX = 64;

const cosLat = (lat: number) => Math.cos((lat * Math.PI) / 180) || 1e-9;

/** Ground size (metres) of geographic bounds, cos-lat corrected. */
export function groundSizeMeters(b: LonLatBounds): { widthM: number; heightM: number } {
  const midLat = (b.min_lat + b.max_lat) / 2;
  return {
    widthM: (b.max_lon - b.min_lon) * M_PER_DEG_LAT * Math.abs(cosLat(midLat)),
    heightM: (b.max_lat - b.min_lat) * M_PER_DEG_LAT,
  };
}

/** True when two bounds share any interior area (touching edges do NOT intersect). */
export function boundsIntersect(a: LonLatBounds, b: LonLatBounds, eps = 1e-12): boolean {
  const ox = Math.min(a.max_lon, b.max_lon) - Math.max(a.min_lon, b.min_lon);
  const oy = Math.min(a.max_lat, b.max_lat) - Math.max(a.min_lat, b.min_lat);
  return ox > eps && oy > eps;
}

/**
 * ONLY the packaged tiles overlapping the corridor. This is what stops the immersive view
 * from decoding and compositing the complete AOI.
 */
export function tilesIntersectingCorridor(tiles: ImageryTileMeta[] | null | undefined, corridor: LonLatBounds): ImageryTileMeta[] {
  return (tiles ?? []).filter((t) => t && t.bounds && boundsIntersect(t.bounds, corridor));
}

export type CorridorTextureSizing = {
  /** useful pixels implied by ground size / effective GSD (pre-cap) */
  requestedWidthPx: number;
  requestedHeightPx: number;
  /** the size actually used after the source/3072/memory caps */
  widthPx: number;
  heightPx: number;
  effectiveMetersPerPixel: number;
  /** m/px the OUTPUT actually achieves (>= effectiveMetersPerPixel when capped) */
  outputMetersPerPixel: number;
  sourceResolutionLimited: boolean;
  memoryCapped: boolean;
  estimatedRgbaBytes: number;
  estimatedMipmappedBytes: number;
  tileCount: number;
};

const clampSide = (v: number) => Math.max(MIN_CORRIDOR_TEXTURE_PX, Math.min(MAX_CORRIDOR_TEXTURE_PX, Math.round(v)));

/**
 * Decide the corridor texture size from GROUND SIZE and the manifest's
 * `effective_meters_per_pixel`. Never upscales beyond source density (beyond integer
 * rounding); preserves geographic aspect; applies the 3072 ceiling and a memory budget.
 */
export function corridorTextureSizing(
  corridor: LonLatBounds,
  effectiveMetersPerPixel: number,
  tileCount = 0,
  opts?: { maxSidePx?: number; memoryBudgetBytes?: number },
): CorridorTextureSizing {
  const maxSide = opts?.maxSidePx ?? MAX_CORRIDOR_TEXTURE_PX;
  const budget = opts?.memoryBudgetBytes ?? CORRIDOR_TEXTURE_MEMORY_BUDGET_BYTES;
  const { widthM, heightM } = groundSizeMeters(corridor);
  const gsd = Number.isFinite(effectiveMetersPerPixel) && effectiveMetersPerPixel > 0 ? effectiveMetersPerPixel : 1;

  // The genuinely available source pixels across the corridor.
  const reqW = Math.max(1, Math.round(widthM / gsd));
  const reqH = Math.max(1, Math.round(heightM / gsd));

  // Aspect-preserving fit under the 3072 ceiling. We never scale UP past the source count.
  let scale = 1;
  const longest = Math.max(reqW, reqH);
  if (longest > maxSide) scale = maxSide / longest;
  let w = clampSide(reqW * scale);
  let h = clampSide(reqH * scale);

  // Memory budget (decoded RGBA). Shrink, aspect-preserving, until it fits.
  let memoryCapped = false;
  const rgba = (a: number, b: number) => a * b * 4;
  if (rgba(w, h) > budget) {
    memoryCapped = true;
    const k = Math.sqrt(budget / rgba(w, h));
    w = clampSide(w * k);
    h = clampSide(h * k);
  }

  // The m/px the OUTPUT actually resolves. Larger than gsd only when we capped.
  const outputMpp = Math.max(widthM / Math.max(w, 1), heightM / Math.max(h, 1));
  const bytes = rgba(w, h);
  return {
    requestedWidthPx: reqW,
    requestedHeightPx: reqH,
    widthPx: w,
    heightPx: h,
    effectiveMetersPerPixel: gsd,
    outputMetersPerPixel: outputMpp,
    // TRUTHFUL: the texture holds no more real detail than the source provided. True
    // whenever we are NOT capped — i.e. the source density itself is the limit.
    sourceResolutionLimited: !memoryCapped && Math.max(reqW, reqH) <= maxSide,
    memoryCapped,
    estimatedRgbaBytes: bytes,
    // Full mip chain adds ~1/3.
    estimatedMipmappedBytes: Math.round(bytes * (4 / 3)),
    tileCount,
  };
}

/** Human provenance line for the inspection panel. Never overstates detail. */
export function imageryProvenanceSummary(s: CorridorTextureSizing, provider?: string | null): string {
  const bits = [
    provider ? `Imagery: ${provider}` : null,
    `${s.effectiveMetersPerPixel.toFixed(2)} m/px effective`,
    `${s.tileCount} tile${s.tileCount === 1 ? "" : "s"} used`,
    `${s.widthPx}x${s.heightPx} local texture`,
    s.sourceResolutionLimited ? "Source-resolution limited" : null,
    s.memoryCapped ? "Device-memory capped" : null,
  ].filter(Boolean);
  return bits.join(" · ");
}

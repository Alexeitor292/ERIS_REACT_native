/**
 * Normalizes a USGS 3DEP / EPQS cross-section elevation profile into clean
 * geometry for the live 2D slope-profile chart.
 *
 * This is the source of truth for the rendered slope: it works from the actual
 * sampled `profile.points` (offset_m, elevation_ft), NOT from the coarse
 * classification. `classification` is carried through only as summary metadata.
 *
 * Offset convention (from the backend service):
 *   offset_m < 0  → LEFT of the upstation (increasing postmile) direction = LT side
 *   offset_m > 0  → RIGHT of the upstation direction = RT side
 *
 * Orientation is CANONICAL UPSTATION — always. LT is always on the left of the
 * plot (negative offset → small x), RT on the right. There is no mirrored /
 * DOWNSTATION mode.
 *
 * The function returns x/y fractions in [0, 1] within the plot area so the
 * renderer only has to multiply by its pixel dimensions. Vertical exaggeration
 * is auto-chosen to fill the plot without clipping and reported so the UI can
 * label it honestly.
 */

import type { GisaElevationProfile } from "../api/submissions";

const M_PER_FT = 0.3048;

export type ElevationGeometryPoint = {
  offset_m: number;
  elevation_ft: number;
  /** Horizontal position within the plot, 0 = left edge, 1 = right edge. */
  xFrac: number;
  /** Vertical position within the plot, 0 = top (high), 1 = bottom (low). */
  yFrac: number;
};

export type ElevationProfileGeometry =
  | {
      usable: true;
      points: ElevationGeometryPoint[];
      minElev_ft: number;
      maxElev_ft: number;
      /** Elevation at (or nearest to) the road center, offset 0. */
      centerElev_ft: number;
      /** Vertical position of the road-center elevation, 0..1. */
      centerYFrac: number;
      /** Horizontal position of the road center (offset 0), 0..1. */
      roadCenterXFrac: number;
      relief_ft: number;
      /** Half-width actually used for horizontal scaling, in metres. */
      halfSpan_m: number;
      /** ~1 = true scale; >1 = vertical exaggerated; <1 = vertical compressed. */
      verticalExaggeration: number;
      classification: string | null;
    }
  | {
      usable: false;
      reason: string;
      /** Center elevation if at least the center point resolved. */
      centerElev_ft: number | null;
      classification: string | null;
    };

export type BuildGeometryOptions = {
  plotWidthPx: number;
  plotHeightPx: number;
  /** Cap on auto vertical exaggeration to avoid turning noise into mountains. */
  maxVerticalExaggeration?: number;
  /** Vertical breathing room (px) kept above/below the profile band. */
  verticalPaddingPx?: number;
};

type RawPoint = { offset_m: number; elevation_ft: number };

function usablePoints(profile?: GisaElevationProfile | null): RawPoint[] {
  const raw = profile?.profile?.points ?? [];
  const out: RawPoint[] = [];
  for (const p of raw) {
    const o = typeof p?.offset_m === "number" ? p.offset_m : Number(p?.offset_m);
    const e = p?.elevation_ft;
    if (Number.isFinite(o) && typeof e === "number" && Number.isFinite(e)) {
      out.push({ offset_m: o, elevation_ft: e });
    }
  }
  out.sort((a, b) => a.offset_m - b.offset_m);
  return out;
}

function nearestCenterElevation(points: RawPoint[]): number {
  let best = points[0];
  for (const p of points) {
    if (Math.abs(p.offset_m) < Math.abs(best.offset_m)) best = p;
  }
  return best.elevation_ft;
}

export function buildElevationProfileGeometry(
  profile: GisaElevationProfile | null | undefined,
  opts: BuildGeometryOptions,
): ElevationProfileGeometry {
  const {
    plotWidthPx,
    plotHeightPx,
    maxVerticalExaggeration = 8,
    verticalPaddingPx = 14,
  } = opts;

  const classification = profile?.classification ?? null;
  const points = usablePoints(profile);

  // Need at least 3 resolved samples with real horizontal spread to draw a
  // meaningful cross-section. (No bearing → only the center point is sampled.)
  if (points.length < 3) {
    return {
      usable: false,
      reason:
        points.length <= 1
          ? "Only the center point was sampled — a road orientation is needed to sample both sides."
          : "Not enough resolved elevation samples to draw a slope profile.",
      centerElev_ft: points.length >= 1 ? nearestCenterElevation(points) : null,
      classification,
    };
  }

  const offsets = points.map((p) => p.offset_m);
  const minOffset = Math.min(...offsets);
  const maxOffset = Math.max(...offsets);
  if (maxOffset - minOffset <= 0) {
    return {
      usable: false,
      reason: "Samples have no horizontal spread.",
      centerElev_ft: nearestCenterElevation(points),
      classification,
    };
  }

  // Symmetric horizontal scaling so the road center (offset 0) sits dead center.
  const halfSpan_m = Math.max(Math.abs(minOffset), Math.abs(maxOffset));

  const elevs = points.map((p) => p.elevation_ft);
  const minElev = Math.min(...elevs);
  const maxElev = Math.max(...elevs);
  const relief = maxElev - minElev;
  const midElev = (minElev + maxElev) / 2;
  const centerElev = nearestCenterElevation(points);

  // Vertical placement: band centered in the plot, anchored on the elevation
  // midpoint so the available height is used symmetrically.
  const innerH = Math.max(1, plotHeightPx - 2 * verticalPaddingPx);
  const centerY = verticalPaddingPx + innerH / 2;
  const availHalf = innerH / 2;

  // True (1:1) scale: px per metre horizontally → px per foot vertically.
  const pxPerMeterH = plotWidthPx / (2 * halfSpan_m);
  const truePxPerFt = pxPerMeterH * M_PER_FT;

  // Auto exaggeration: fill the available half-height, then cap so tiny relief
  // is not blown up into dramatic (misleading) terrain.
  const maxDevFt = relief / 2;
  let exag = 1;
  if (maxDevFt > 0 && truePxPerFt > 0) {
    const fitExag = availHalf / (maxDevFt * truePxPerFt);
    // Below 1 we *compress* to fit very large relief; above we exaggerate up to cap.
    exag = Math.min(fitExag, maxVerticalExaggeration);
  }
  const effPxPerFt = truePxPerFt * exag;

  const toYFrac = (elev: number): number => {
    const yPx = centerY - (elev - midElev) * effPxPerFt;
    return Math.min(1, Math.max(0, yPx / plotHeightPx));
  };

  // Canonical UPSTATION: LT (negative offset) on the left, RT on the right.
  const toXFrac = (offset: number): number => {
    return 0.5 + offset / (2 * halfSpan_m); // -half→0, 0→0.5, +half→1
  };

  const geoPoints: ElevationGeometryPoint[] = points.map((p) => ({
    offset_m: p.offset_m,
    elevation_ft: p.elevation_ft,
    xFrac: toXFrac(p.offset_m),
    yFrac: toYFrac(p.elevation_ft),
  }));

  return {
    usable: true,
    points: geoPoints,
    minElev_ft: minElev,
    maxElev_ft: maxElev,
    centerElev_ft: centerElev,
    centerYFrac: toYFrac(centerElev),
    roadCenterXFrac: toXFrac(0),
    relief_ft: relief,
    halfSpan_m,
    verticalExaggeration: exag,
    classification,
  };
}

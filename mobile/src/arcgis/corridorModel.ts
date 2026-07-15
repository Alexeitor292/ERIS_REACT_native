// Pure corridor geometry for the immersive road inspection (Part 8 / PR #51 review).
// The TESTED mirror of buildCorridorModelAtLat: in ErisTerrainSceneViewController.m and
// the part rendering in ErisImmersiveCorridorViewController.m — keep in lockstep.
//
// Two correctness rules the review pinned:
//  (1) The SELECTED STATION is fixed: the cross-section plane + camera target follow the
//      snapped station, NOT the (edge-clipped) patch midpoint.
//  (2) The selected road is CLIPPED per segment (Liang–Barsky), so a segment crossing the
//      corridor is retained even when both endpoints are outside, leave/re-enter yields
//      SEPARATE parts, and disconnected parts are never joined by a false chord.
//
// No react-native/expo imports (unit-tested under node --test).

export type LonLat = [number, number];
export type Rect = { minLon: number; minLat: number; maxLon: number; maxLat: number };

const M_PER_DEG_LAT = 111_320.0;

/** Patch-local metres (east, south) of a lon/lat relative to the patch centre. */
export function toLocalMeters(lon: number, lat: number, centerLon: number, centerLat: number): LonLat {
  const cosLat = Math.cos((centerLat * Math.PI) / 180) || 1e-9;
  return [(lon - centerLon) * M_PER_DEG_LAT * cosLat, (centerLat - lat) * M_PER_DEG_LAT];
}

/** Equirectangular metres between two lon/lat points. */
export function metersBetween(aLon: number, aLat: number, bLon: number, bLat: number): number {
  const mLat = (aLat + bLat) / 2;
  const dN = (bLat - aLat) * M_PER_DEG_LAT;
  const dE = (bLon - aLon) * M_PER_DEG_LAT * Math.cos((mLat * Math.PI) / 180);
  return Math.hypot(dN, dE);
}

/**
 * Liang–Barsky clip of ONE segment [a,b] to the rect. Returns the retained parameter
 * range [t0,t1] (0 ≤ t0 ≤ t1 ≤ 1) or null when the segment misses the rect entirely.
 */
export function clipSegmentParam(a: LonLat, b: LonLat, r: Rect): [number, number] | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - r.minLon, r.maxLon - a[0], a[1] - r.minLat, r.maxLat - a[1]];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null; // parallel and outside this edge
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }
  return t0 <= t1 ? [t0, t1] : null;
}

const lerp = (a: LonLat, b: LonLat, t: number): LonLat => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const nearLonLat = (p: LonLat, q: LonLat, eps = 1e-12) => Math.abs(p[0] - q[0]) < eps && Math.abs(p[1] - q[1]) < eps;

/**
 * Clip a polyline to the rect, producing zero or more SEPARATE connected parts. A
 * segment that only crosses the rect (both endpoints outside) is retained as its own
 * part; leaving and re-entering produces distinct parts; disconnected parts are never
 * joined. Every emitted coordinate lies inside (or on) the rect.
 */
export function clipPolylineToRect(coords: LonLat[], r: Rect): LonLat[][] {
  const parts: LonLat[][] = [];
  let cur: LonLat[] = [];
  const eps = 1e-12;
  for (let i = 0; i + 1 < coords.length; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const res = clipSegmentParam(a, b, r);
    if (!res) {
      if (cur.length) {
        parts.push(cur);
        cur = [];
      }
      continue;
    }
    const [t0, t1] = res;
    const p0 = lerp(a, b, t0);
    const p1 = lerp(a, b, t1);
    const entering = t0 > eps; // came from outside -> starts a fresh part
    const exiting = t1 < 1 - eps; // leaves to outside -> ends this part
    if (cur.length === 0 || entering) {
      if (cur.length) parts.push(cur);
      cur = [p0];
    }
    if (!nearLonLat(cur[cur.length - 1], p1)) cur.push(p1);
    if (exiting) {
      parts.push(cur);
      cur = [];
    }
  }
  if (cur.length) parts.push(cur);
  return parts.filter((pt) => pt.length >= 2);
}

export type Projection = { snapLon: number; snapLat: number; distM: number; tangentDeg: number };

// Project point p onto segment [a,b] in metres; return the snap point + tangent bearing.
function projectPointSeg(p: LonLat, a: LonLat, b: LonLat): Projection {
  const cosLat = Math.cos((p[1] * Math.PI) / 180) || 1e-9;
  const mx = (lon: number) => lon * M_PER_DEG_LAT * cosLat;
  const my = (lat: number) => lat * M_PER_DEG_LAT;
  const ax = mx(a[0]);
  const ay = my(a[1]);
  const bx = mx(b[0]);
  const by = my(b[1]);
  const px = mx(p[0]);
  const py = my(p[1]);
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const sx = ax + t * dx;
  const sy = ay + t * dy;
  const mLat = (a[1] + b[1]) / 2;
  const dN = (b[1] - a[1]) * M_PER_DEG_LAT;
  const dE = (b[0] - a[0]) * M_PER_DEG_LAT * Math.cos((mLat * Math.PI) / 180);
  return {
    snapLon: sx / (M_PER_DEG_LAT * cosLat),
    snapLat: sy / M_PER_DEG_LAT,
    distM: Math.hypot(px - sx, py - sy),
    tangentDeg: ((Math.atan2(dE, dN) * 180) / Math.PI + 360) % 360,
  };
}

/**
 * Project a tap onto a road AFTER clipping it to the grid `rect`. The snap point is
 * therefore inherently inside the grid: a road that is entirely outside the grid yields
 * null (not selectable, even within tolerance); a road crossing the grid snaps to its
 * in-bounds portion. Mirrors gatherCandidatesAtLat's project-onto-clipped-parts.
 */
export function projectTapOntoClippedRoad(coords: LonLat[], rect: Rect, tapLon: number, tapLat: number): Projection | null {
  let best: Projection | null = null;
  for (const part of clipPolylineToRect(coords, rect)) {
    for (let i = 0; i + 1 < part.length; i++) {
      const r = projectPointSeg([tapLon, tapLat], part[i], part[i + 1]);
      if (!best || r.distM < best.distM) best = r;
    }
  }
  return best;
}

/**
 * Clip a straight cross-section slice segment [a,b] to the corridor rect. Returns the
 * in-rect endpoints and whether it was truncated by the boundary (so the immersive view
 * renders only the available portion and can state the truncation). Empty when the slice
 * misses the rect entirely.
 */
export function clipSliceToRect(a: LonLat, b: LonLat, rect: Rect): { points: LonLat[]; truncated: boolean } {
  const res = clipSegmentParam(a, b, rect);
  if (!res) return { points: [], truncated: true };
  const [t0, t1] = res;
  return { points: [lerp(a, b, t0), lerp(a, b, t1)], truncated: t0 > 1e-9 || t1 < 1 - 1e-9 };
}

// Project station onto segment [a,b]; return {distM, t}.
function projectStation(station: LonLat, a: LonLat, b: LonLat): { distM: number; t: number } {
  const cosLat = Math.cos((station[1] * Math.PI) / 180) || 1e-9;
  const mx = (lon: number) => lon * M_PER_DEG_LAT * cosLat;
  const my = (lat: number) => lat * M_PER_DEG_LAT;
  const ax = mx(a[0]);
  const ay = my(a[1]);
  const bx = mx(b[0]);
  const by = my(b[1]);
  const px = mx(station[0]);
  const py = my(station[1]);
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { distM: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t };
}

/**
 * Ensure the projected snap point (the station) is an explicit vertex of the appropriate
 * retained part. The station lies on the selected road, so it belongs to whichever part's
 * segment is nearest (within tolM). Never creates a new part or a false chord.
 */
export function insertStationIntoParts(parts: LonLat[][], station: LonLat, tolM = 2): LonLat[][] {
  let best = { d: Infinity, pi: -1, si: -1 };
  for (let pi = 0; pi < parts.length; pi++) {
    for (let si = 0; si + 1 < parts[pi].length; si++) {
      const { distM } = projectStation(station, parts[pi][si], parts[pi][si + 1]);
      if (distM < best.d) best = { d: distM, pi, si };
    }
  }
  if (best.pi < 0 || best.d > tolM) return parts;
  const part = parts[best.pi];
  if (!nearLonLat(part[best.si], station) && !nearLonLat(part[best.si + 1], station)) {
    part.splice(best.si + 1, 0, station);
  }
  return parts;
}

export type CorridorParts = {
  /** Station in patch-local metres (east, south) from the patch centre — the FIXED inspection origin. */
  stationLocal: LonLat;
  /** Selected road as separate clipped parts, each in patch-local metres. */
  roadPartsXsZs: LonLat[][];
};

/**
 * Full corridor road geometry in patch-local metres, station-fixed. `rect` is the
 * (AOI-clipped) corridor bounds; `center` is the patch centre (mesh origin). The station
 * and every road part are expressed relative to `center`, but the station is preserved
 * exactly (never replaced by the patch midpoint).
 */
export function buildCorridorParts(
  roadCoords: LonLat[],
  rect: Rect,
  centerLon: number,
  centerLat: number,
  stationLon: number,
  stationLat: number,
): CorridorParts {
  const clipped = insertStationIntoParts(clipPolylineToRect(roadCoords, rect), [stationLon, stationLat]);
  return {
    stationLocal: toLocalMeters(stationLon, stationLat, centerLon, centerLat),
    roadPartsXsZs: clipped.map((part) => part.map((c) => toLocalMeters(c[0], c[1], centerLon, centerLat))),
  };
}

// Dependency-free (runs under `node --test`): how far a slide reaches onto the roadway.
//
// The roadway is rebuilt from the highway centerline and the road inventory's
// cross-section (traveled way, shoulders and median, in feet, left and right as the
// inventory records them: relative to the direction of increasing postmile). Every
// point of a fine grid inside the slide outline gets a station (distance along the
// centerline) and an offset (distance across it, + to the right). Points whose offset
// falls on the roadway are encroached, and:
// - Lr is the length of centerline they cover (1 m stations, so curves are measured
//   along the road, not as a straight line);
// - Wr is the widest stretch of roadway they cover at any one station.

export type LonLat = [number, number];
type XY = [number, number];

export type SideSection = {
  lanes: number | null;
  traveled_way_ft: number | null;
  outside_shoulder_ft: number | null;
  inside_shoulder_ft: number | null;
};
export type CrossSection = {
  left: SideSection;
  right: SideSection;
  median_width_ft: number | null;
  highway_group?: string | null;
  begin_pm?: number;
  end_pm?: number;
};
export type CenterLine = { coordinates: LonLat[]; align?: string | null; direction?: string | null };

const M_PER_FT = 0.3048;
export const FT_PER_M = 1 / M_PER_FT;
const DEFAULT_LANE_FT = 12;

/** A band across the road: from/to are offsets in metres, + to the right of the line. */
export type Band = { kind: "lane" | "shoulder"; from: number; to: number; label: string };
export type Carriageway = { line: CenterLine; bands: Band[]; label: string };
export type RoadModel = { carriageways: Carriageway[]; notes: string[]; assumed: boolean };

function frameAt(lon0: number, lat0: number) {
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110_540;
  return {
    toXY: ([lon, lat]: LonLat): XY => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLonLat: ([x, y]: XY): LonLat => [lon0 + x / kx, lat0 + y / ky],
  };
}

const ft = (value: number | null | undefined) => (value != null && Number.isFinite(value) && value > 0 ? value : 0);

/** Lane bands from the line outwards: `sign` -1 builds to the left, +1 to the right. */
function sideBands(start: number, sign: 1 | -1, lanes: number, traveledFt: number, outsideFt: number, sideLabel: string): Band[] {
  const bands: Band[] = [];
  const lane = (traveledFt / Math.max(1, lanes)) * M_PER_FT;
  let at = start;
  for (let i = 0; i < Math.max(1, lanes); i += 1) {
    const next = at + sign * lane;
    bands.push({ kind: "lane", from: Math.min(at, next), to: Math.max(at, next), label: `${sideLabel} lane ${i + 1}` });
    at = next;
  }
  if (outsideFt > 0) {
    const next = at + sign * outsideFt * M_PER_FT;
    bands.push({ kind: "shoulder", from: Math.min(at, next), to: Math.max(at, next), label: `${sideLabel} shoulder` });
  }
  return bands;
}

function sideName(direction: string | null | undefined, right: boolean): string {
  const opposite: Record<string, string> = { NB: "SB", SB: "NB", EB: "WB", WB: "EB" };
  const dir = (direction ?? "").toUpperCase();
  if (opposite[dir]) return right ? dir : opposite[dir];
  return right ? "Right" : "Left";
}

/** Distance between two lines where they are closest to each other's middle. */
function separation(a: CenterLine, b: CenterLine, toXY: (p: LonLat) => XY): number {
  const bxy = b.coordinates.map(toXY);
  const mid = toXY(a.coordinates[Math.floor(a.coordinates.length / 2)]);
  return project(bxy, mid)?.distance ?? Infinity;
}

/**
 * The roadway as bands along each carriageway's line. A single line (or two that
 * coincide) is the centre of the whole road; two lines apart are the two carriageways
 * of a divided highway, each carrying its own side of the cross-section.
 */
export function buildRoadModel(section: CrossSection | null, lines: CenterLine[]): RoadModel {
  const notes: string[] = [];
  let assumed = false;
  if (!lines.length) return { carriageways: [], notes: ["No centerline near the site."], assumed };
  const origin = lines[0].coordinates[0];
  const { toXY } = frameAt(origin[0], origin[1]);

  const left = section?.left ?? { lanes: null, traveled_way_ft: null, outside_shoulder_ft: null, inside_shoulder_ft: null };
  const right = section?.right ?? { lanes: null, traveled_way_ft: null, outside_shoulder_ft: null, inside_shoulder_ft: null };
  let lanesL = left.lanes ?? 0;
  let lanesR = right.lanes ?? 0;
  let twL = ft(left.traveled_way_ft);
  let twR = ft(right.traveled_way_ft);
  const osL = ft(left.outside_shoulder_ft);
  const osR = ft(right.outside_shoulder_ft);
  if (!section) {
    notes.push("No road inventory for this route and postmile: assumed two 12 ft lanes and no shoulders.");
    assumed = true;
    lanesL = lanesR = 1;
    twL = twR = DEFAULT_LANE_FT;
  } else {
    // An undivided road may be recorded entirely on one side: split it about the line.
    if (twL === 0 && twR > 0 && !lanesL) {
      notes.push("The inventory records the whole traveled way on the right side; it is split evenly about the centerline.");
      lanesL = Math.floor((lanesR || 2) / 2);
      lanesR = Math.max(1, (lanesR || 2) - lanesL);
      twL = twR * (lanesL / (lanesL + lanesR));
      twR -= twL;
    } else if (twR === 0 && twL > 0 && !lanesR) {
      notes.push("The inventory records the whole traveled way on the left side; it is split evenly about the centerline.");
      lanesR = Math.floor((lanesL || 2) / 2);
      lanesL = Math.max(1, (lanesL || 2) - lanesR);
      twR = twL * (lanesR / (lanesL + lanesR));
      twL -= twR;
    }
    if (twL === 0 && lanesL) {
      twL = lanesL * DEFAULT_LANE_FT;
      assumed = true;
      notes.push(`No left traveled-way width in the inventory: assumed ${DEFAULT_LANE_FT} ft lanes.`);
    }
    if (twR === 0 && lanesR) {
      twR = lanesR * DEFAULT_LANE_FT;
      assumed = true;
      notes.push(`No right traveled-way width in the inventory: assumed ${DEFAULT_LANE_FT} ft lanes.`);
    }
  }
  const median = ft(section?.median_width_ft);

  // Two lines more than 3 m apart are separate carriageways.
  const rightLine = lines.find((l) => (l.align ?? "").toLowerCase() === "right") ?? lines[0];
  const leftLine = lines.find((l) => l !== rightLine && (l.align ?? "").toLowerCase() === "left");
  const divided = !!leftLine && separation(leftLine, rightLine, toXY) > 3;
  const dir = rightLine.direction;
  const nameR = sideName(dir, true);
  const nameL = sideName(dir, false);

  if (!divided) {
    const half = (median * M_PER_FT) / 2;
    const bands = [
      ...sideBands(-half, -1, lanesL || 1, twL, osL, nameL),
      ...sideBands(half, 1, lanesR || 1, twR, osR, nameR),
    ];
    if (median > 0) notes.push(`Divided by a ${Math.round(median)} ft median around one centerline.`);
    return { carriageways: [{ line: rightLine, bands, label: "Roadway" }], notes, assumed };
  }

  // Divided: each line carries its side's traveled way centred on it, the inside
  // shoulder toward the other line and the outside shoulder away from it.
  notes.push("Divided highway: each carriageway is centred on its own line.");
  const carriageways: Carriageway[] = [];
  for (const [line, other, lanes, tw, os, is, name] of [
    [rightLine, leftLine!, lanesR, twR, osR, ft(right.inside_shoulder_ft), nameR],
    [leftLine!, rightLine, lanesL, twL, osL, ft(left.inside_shoulder_ft), nameL],
  ] as const) {
    const xy = line.coordinates.map(toXY);
    const probe = project(xy, toXY(other.coordinates[Math.floor(other.coordinates.length / 2)]));
    const medianSign: 1 | -1 = probe && probe.offset > 0 ? 1 : -1;
    const halfTw = (tw * M_PER_FT) / 2;
    // Lanes run from the traveled way's median edge outwards, then the outside shoulder.
    const lanesOut = sideBands(medianSign * halfTw, (-medianSign) as 1 | -1, lanes || 1, tw, os, name);
    const inside: Band[] = is > 0
      ? [{ kind: "shoulder", from: Math.min(medianSign * halfTw, medianSign * (halfTw + is * M_PER_FT)), to: Math.max(medianSign * halfTw, medianSign * (halfTw + is * M_PER_FT)), label: `${name} inside shoulder` }]
      : [];
    carriageways.push({ line, bands: [...lanesOut, ...inside], label: `${name} carriageway` });
  }
  return { carriageways, notes, assumed };
}

type Projection = { distance: number; offset: number; station: number; atEnd: boolean };

/** Station and signed offset (+ right of the line's direction) of a point. */
function project(xy: XY[], [px, py]: XY): Projection | null {
  let best: Projection | null = null;
  let station = 0;
  for (let i = 1; i < xy.length; i += 1) {
    const [ax, ay] = xy[i - 1];
    const [bx, by] = xy[i];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const raw = ((px - ax) * dx + (py - ay) * dy) / (len * len);
    const t = Math.max(0, Math.min(1, raw));
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    const distance = Math.hypot(px - qx, py - qy);
    if (!best || distance < best.distance) {
      const cross = dx * (py - ay) - dy * (px - ax); // > 0: left of the direction of travel
      best = {
        distance,
        offset: cross > 0 ? -distance : distance,
        station: station + t * len,
        atEnd: (i === 1 && raw < 0) || (i === xy.length - 1 && raw > 1),
      };
    }
    station += len;
  }
  return best;
}

function pointInRings([x, y]: XY, rings: XY[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

export type Encroachment = {
  /** Lr: centerline length the slide covers, metres (to the station bin, 1 m or the grid spacing). */
  lengthM: number;
  /** Wr: widest roadway it covers at one station, metres. */
  widthM: number;
  /** Full roadway width (lanes and shoulders) where Wr was taken, metres. */
  roadwayWidthM: number;
  bandsHit: string[];
  lanesHit: number;
  lanesTotal: number;
  shoulderOnly: boolean;
  /** Encroached cells, thinned, for drawing. */
  cells: LonLat[];
  spacingM: number;
};

/** Measure a slide outline (rings of [lon, lat]) against the road model. Null when it misses the road. */
export function measureEncroachment(rings: LonLat[][], road: RoadModel, targetCells = 60_000): Encroachment | null {
  if (!rings.length || !road.carriageways.length) return null;
  const [lon0, lat0] = rings[0][0];
  const frame = frameAt(lon0, lat0);
  const xyRings = rings.map((ring) => ring.map(frame.toXY));
  const xs = xyRings[0].map((p) => p[0]);
  const ys = xyRings[0].map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const spacing = Math.max(0.25, Math.sqrt(((maxX - minX) * (maxY - minY)) / targetCells));
  // Station bins no finer than the grid, so every bin the slide crosses gets a cell.
  const binM = Math.max(1, Math.ceil(spacing));

  const lanesTotal = road.carriageways.reduce((n, c) => n + c.bands.filter((b) => b.kind === "lane").length, 0);
  const lines = road.carriageways.map((c) => ({ c, xy: c.line.coordinates.map(frame.toXY) }));
  // Per carriageway: 1 m station bins -> [min offset, max offset] of encroached cells.
  const bins = lines.map(() => new Map<number, [number, number]>());
  const hit = new Set<string>();
  const cells: LonLat[] = [];
  for (let y = minY + spacing / 2; y <= maxY; y += spacing) {
    for (let x = minX + spacing / 2; x <= maxX; x += spacing) {
      if (!pointInRings([x, y], xyRings)) continue;
      for (let k = 0; k < lines.length; k += 1) {
        const p = project(lines[k].xy, [x, y]);
        if (!p || p.atEnd) continue;
        const band = lines[k].c.bands.find((b) => p.offset >= b.from && p.offset <= b.to);
        if (!band) continue;
        hit.add(band.label);
        const key = Math.floor(p.station / binM);
        const range = bins[k].get(key);
        bins[k].set(key, range ? [Math.min(range[0], p.offset), Math.max(range[1], p.offset)] : [p.offset, p.offset]);
        cells.push(frame.toLonLat([x, y]));
        break;
      }
    }
  }
  if (!cells.length) return null;

  let lengthM = 0;
  let widthM = 0;
  let roadwayWidthM = 0;
  bins.forEach((binMap, k) => {
    lengthM = Math.max(lengthM, binMap.size * binM);
    const bands = lines[k].c.bands;
    const edgeLo = Math.min(...bands.map((b) => b.from));
    const edgeHi = Math.max(...bands.map((b) => b.to));
    const full = edgeHi - edgeLo;
    for (const [lo, hi] of binMap.values()) {
      // Each cell stands for half a spacing either side, but never past the pavement edge.
      const w = Math.min(hi + spacing / 2, edgeHi) - Math.max(lo - spacing / 2, edgeLo);
      if (w > widthM) {
        widthM = w;
        roadwayWidthM = full;
      }
    }
  });
  const stride = Math.max(1, Math.floor(cells.length / 4000));
  const lanesHit = [...hit].filter((label) => / lane \d+$/.test(label)).length;
  return {
    lengthM,
    widthM,
    roadwayWidthM,
    bandsHit: [...hit].sort(),
    lanesHit,
    lanesTotal,
    shoulderOnly: lanesHit === 0,
    cells: cells.filter((_, i) => i % stride === 0),
    spacingM: spacing,
  };
}

/** A line shifted sideways by `offsetM` metres (+ to the right of its direction). */
export function offsetLine(coords: LonLat[], offsetM: number): LonLat[] {
  if (coords.length < 2) return coords;
  const frame = frameAt(coords[0][0], coords[0][1]);
  const xy = coords.map(frame.toXY);
  return xy.map((p, i) => {
    const a = xy[Math.max(0, i - 1)];
    const b = xy[Math.min(xy.length - 1, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    // Right-hand normal of the local direction.
    return frame.toLonLat([p[0] + ((b[1] - a[1]) / len) * offsetM, p[1] - ((b[0] - a[0]) / len) * offsetM]);
  });
}

/** Lines along each band edge, for drawing the rebuilt roadway ([lon, lat] paths). */
export function roadEdges(road: RoadModel): Array<{ kind: "edge" | "lane" | "centre"; path: LonLat[] }> {
  const out: Array<{ kind: "edge" | "lane" | "centre"; path: LonLat[] }> = [];
  for (const c of road.carriageways) {
    if (c.line.coordinates.length < 2 || !c.bands.length) continue;
    const lo = Math.min(...c.bands.map((b) => b.from));
    const hi = Math.max(...c.bands.map((b) => b.to));
    const offsets = new Set<number>();
    for (const b of c.bands) {
      offsets.add(Math.round(b.from * 100) / 100);
      offsets.add(Math.round(b.to * 100) / 100);
    }
    for (const o of offsets) {
      const kind = Math.abs(o) < 0.01 ? "centre" : o === Math.round(lo * 100) / 100 || o === Math.round(hi * 100) / 100 ? "edge" : "lane";
      out.push({ kind, path: offsetLine(c.line.coordinates, o) });
    }
  }
  return out;
}

/** The roadway's outline per carriageway (outer edge to outer edge), for filling. */
export function roadOutlines(road: RoadModel): LonLat[][] {
  return road.carriageways
    .filter((c) => c.line.coordinates.length >= 2 && c.bands.length)
    .map((c) => {
      const lo = Math.min(...c.bands.map((b) => b.from));
      const hi = Math.max(...c.bands.map((b) => b.to));
      return [...offsetLine(c.line.coordinates, lo), ...offsetLine(c.line.coordinates, hi).reverse()];
    });
}

/** Lr in whole feet and Wr to a tenth of a foot, as the form takes them. */
export function roadwayFieldValues(e: Encroachment): { measure_roadway_length_ft: string; measure_roadway_width_ft: string } {
  return {
    measure_roadway_length_ft: (e.lengthM * FT_PER_M).toFixed(0),
    measure_roadway_width_ft: (e.widthM * FT_PER_M).toFixed(1),
  };
}

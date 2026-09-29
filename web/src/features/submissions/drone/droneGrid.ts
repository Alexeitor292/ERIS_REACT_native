// Dependency-free (runs under `node --test`): a drone survey's elevation patch.
//
// A drone flight (DroneDeploy, Pix4D, Metashape, Site Scan...) exports an
// elevation model as a GeoTIFF in its own coordinate system, often far finer
// and far larger than a site needs. The browser reads it into a regular
// longitude/latitude grid over the captured area (the "patch"): cell centres at
// west + (c + ½)·dx and north − (r + ½)·dy, row 0 along the north edge, heights
// in metres, NaN where the drone saw nothing. The patch replaces the terrain
// model only inside its footprint; everywhere else the terrain model stays.

export type LonLat = [number, number];
export type Bounds = { west: number; south: number; east: number; north: number };
export type DroneGrid = Bounds & { cols: number; rows: number; values: Float32Array };

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON_AT_EQUATOR = 111_320;
const MAGIC = "ERISDSM1";

/** Metres per degree of longitude and latitude at a latitude. */
export function metresPerDegree(lat: number): { lon: number; lat: number } {
  return { lon: M_PER_DEG_LON_AT_EQUATOR * Math.cos((lat * Math.PI) / 180), lat: M_PER_DEG_LAT };
}

/** The size of one grid cell on the ground, in metres. */
export function cellSizeM(grid: DroneGrid): { dx: number; dy: number } {
  const m = metresPerDegree((grid.north + grid.south) / 2);
  return { dx: ((grid.east - grid.west) / grid.cols) * m.lon, dy: ((grid.north - grid.south) / grid.rows) * m.lat };
}

// --- The stored patch (routes/drone_surveys.py reads the same layout) ---------

/** "ERISDSM1", the header length (uint32 LE), a JSON header, then float32 LE heights. */
export function encodeGrid(grid: DroneGrid): Uint8Array {
  const json = new TextEncoder().encode(
    JSON.stringify({ west: grid.west, south: grid.south, east: grid.east, north: grid.north, cols: grid.cols, rows: grid.rows }),
  );
  const pad = (4 - ((12 + json.length) % 4)) % 4;
  const headerLength = json.length + pad;
  const out = new Uint8Array(12 + headerLength + grid.values.length * 4);
  for (let i = 0; i < 8; i += 1) out[i] = MAGIC.charCodeAt(i);
  const view = new DataView(out.buffer);
  view.setUint32(8, headerLength, true);
  out.set(json, 12);
  out.fill(0x20, 12 + json.length, 12 + headerLength); // spaces: still valid JSON
  const base = 12 + headerLength;
  for (let i = 0; i < grid.values.length; i += 1) view.setFloat32(base + i * 4, grid.values[i], true);
  return out;
}

export function decodeGrid(input: ArrayBuffer | Uint8Array): DroneGrid {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  if (bytes.length < 12 || magic !== MAGIC) throw new Error("Not an ERIS elevation patch.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + headerLength)));
  const cols = Number(header.cols);
  const rows = Number(header.rows);
  const base = 12 + headerLength;
  if (bytes.length !== base + cols * rows * 4) throw new Error("The elevation patch is damaged.");
  const values = new Float32Array(cols * rows);
  for (let i = 0; i < values.length; i += 1) values[i] = view.getFloat32(base + i * 4, true);
  return { west: Number(header.west), south: Number(header.south), east: Number(header.east), north: Number(header.north), cols, rows, values };
}

// --- Reading heights -----------------------------------------------------------

export function covers(grid: Bounds, lon: number, lat: number): boolean {
  return lon >= grid.west && lon <= grid.east && lat >= grid.south && lat <= grid.north;
}

/**
 * The height at a point: bilinear between the four nearest cell centres, using
 * those that hold data when they carry at least half the weight (a patch's
 * ragged edge still answers), or null outside the patch or over a hole.
 */
export function sampleGrid(grid: DroneGrid, lon: number, lat: number): number | null {
  if (!covers(grid, lon, lat)) return null;
  const fx = ((lon - grid.west) / (grid.east - grid.west)) * grid.cols - 0.5;
  const fy = ((grid.north - lat) / (grid.north - grid.south)) * grid.rows - 0.5;
  const x0 = Math.max(0, Math.min(grid.cols - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(grid.rows - 1, Math.floor(fy)));
  const x1 = Math.min(grid.cols - 1, x0 + 1);
  const y1 = Math.min(grid.rows - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));
  const corners: Array<[number, number]> = [
    [grid.values[y0 * grid.cols + x0], (1 - tx) * (1 - ty)],
    [grid.values[y0 * grid.cols + x1], tx * (1 - ty)],
    [grid.values[y1 * grid.cols + x0], (1 - tx) * ty],
    [grid.values[y1 * grid.cols + x1], tx * ty],
  ];
  let sum = 0;
  let weight = 0;
  for (const [value, w] of corners) {
    if (Number.isFinite(value) && w > 0) {
      sum += value * w;
      weight += w;
    }
  }
  // At least half the weight must come from data: a ragged edge still answers,
  // a hole the drone did not see stays a hole.
  if (weight >= 0.5) return sum / weight;
  return null;
}

export function gridStats(grid: DroneGrid): { min: number | null; max: number | null; validCells: number } {
  let min = Infinity;
  let max = -Infinity;
  let validCells = 0;
  for (const value of grid.values) {
    if (!Number.isFinite(value)) continue;
    validCells += 1;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min: validCells ? min : null, max: validCells ? max : null, validCells };
}

/** The patch's outline, as a closed [lon, lat] ring. */
export function boundsRing(b: Bounds): LonLat[] {
  return [[b.west, b.north], [b.east, b.north], [b.east, b.south], [b.west, b.south], [b.west, b.north]];
}

// --- Lining the drone heights up with the terrain model ------------------------

export function median(values: number[]): number | null {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return null;
  const mid = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[mid] : (finite[mid - 1] + finite[mid]) / 2;
}

/**
 * Drone heights are often on another vertical datum (ellipsoid rather than
 * NAVD88), or floating without ground control. Compared on ground that did not
 * move, the terrain model minus the drone surface is a constant: its median is
 * the offset to add to every drone height. The spread (median absolute
 * deviation) says how well the two agree once lined up.
 */
export function verticalOffset(pairs: Array<{ terrain: number | null; drone: number | null }>): { offsetM: number; spreadM: number; count: number } | null {
  const diffs = pairs.flatMap((p) => (p.terrain != null && p.drone != null && Number.isFinite(p.terrain) && Number.isFinite(p.drone) ? [p.terrain - p.drone] : []));
  if (diffs.length < 8) return null;
  const offsetM = median(diffs)!;
  return { offsetM, spreadM: median(diffs.map((d) => Math.abs(d - offsetM)))!, count: diffs.length };
}

function inRing([lon, lat]: LonLat, ring: LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Where to compare the two surfaces for the offset: a lattice over the patch,
 * on cells with data, away from the affected areas (which did move).
 */
export function alignmentPoints(grid: DroneGrid, avoid: LonLat[][] = [], target = 400): LonLat[] {
  const side = Math.max(4, Math.round(Math.sqrt(target)));
  const points: LonLat[] = [];
  for (let r = 0; r < side; r += 1) {
    for (let c = 0; c < side; c += 1) {
      const lon = grid.west + ((c + 0.5) / side) * (grid.east - grid.west);
      const lat = grid.north - ((r + 0.5) / side) * (grid.north - grid.south);
      if (sampleGrid(grid, lon, lat) == null) continue;
      if (avoid.some((ring) => inRing([lon, lat], ring))) continue;
      points.push([lon, lat]);
    }
  }
  return points;
}

// --- Building the patch from a drone raster ------------------------------------

/**
 * How fine to make the patch: the drone's own resolution, but never finer than
 * `minCellM` (detail a site does not need) and never more than `maxCells` a side.
 */
export function chooseGridSize(b: Bounds, nativeResM: number, maxCells = 1024, minCellM = 0.2): { cols: number; rows: number; cellM: number } {
  const m = metresPerDegree((b.north + b.south) / 2);
  const widthM = (b.east - b.west) * m.lon;
  const heightM = (b.north - b.south) * m.lat;
  const cellM = Math.max(minCellM, nativeResM, widthM / maxCells, heightM / maxCells);
  return { cols: Math.max(2, Math.ceil(widthM / cellM)), rows: Math.max(2, Math.ceil(heightM / cellM)), cellM };
}

/**
 * Accumulates a raster read in horizontal bands into one `factor` times
 * smaller, averaging the valid values of each block: a 20 000-pixel-wide
 * drone DSM never has to sit in memory whole.
 */
export class BlockAverager {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly factor: number;
  readonly width: number;
  readonly height: number;
  private readonly isValid: (v: number) => boolean;
  private readonly sums: Float64Array;
  private readonly counts: Uint32Array;

  constructor(sourceWidth: number, sourceHeight: number, factor: number, isValid: (v: number) => boolean) {
    this.sourceWidth = sourceWidth;
    this.sourceHeight = sourceHeight;
    this.factor = factor;
    this.isValid = isValid;
    this.width = Math.ceil(sourceWidth / factor);
    this.height = Math.ceil(sourceHeight / factor);
    this.sums = new Float64Array(this.width * this.height);
    this.counts = new Uint32Array(this.width * this.height);
  }

  /** Add source rows y0 … y0 + band.length/sourceWidth − 1. */
  add(band: ArrayLike<number>, y0: number): void {
    const rows = band.length / this.sourceWidth;
    for (let r = 0; r < rows; r += 1) {
      const target = Math.floor((y0 + r) / this.factor) * this.width;
      const offset = r * this.sourceWidth;
      for (let x = 0; x < this.sourceWidth; x += 1) {
        const v = band[offset + x];
        if (!this.isValid(v)) continue;
        const i = target + Math.floor(x / this.factor);
        this.sums[i] += v;
        this.counts[i] += 1;
      }
    }
  }

  finish(): Float32Array {
    const out = new Float32Array(this.width * this.height);
    for (let i = 0; i < out.length; i += 1) out[i] = this.counts[i] ? this.sums[i] / this.counts[i] : NaN;
    return out;
  }
}

/** Bilinear read of a reduced raster at continuous pixel coordinates (cell centres at integers). */
export function sampleRaster(values: Float32Array, width: number, height: number, px: number, py: number): number {
  if (px < -0.5 || py < -0.5 || px > width - 0.5 || py > height - 0.5) return NaN;
  const grid: DroneGrid = { west: 0, east: width, north: height, south: 0, cols: width, rows: height, values };
  // Reuse the grid sampler: x → longitude-like, y → from the north edge.
  const v = sampleGrid(grid, px + 0.5, height - (py + 0.5));
  return v == null ? NaN : v;
}

/**
 * Where a longitude/latitude falls in the drone file's own coordinates, from a
 * lattice of points projected once (projection is exact at the lattice and
 * bilinear between — sub-millimetre over a site).
 */
export function latticeInterpolator(b: Bounds, n: number, projected: Array<[number, number]>): (lon: number, lat: number) => [number, number] {
  if (projected.length !== n * n) throw new Error("The projected lattice has the wrong size.");
  return (lon, lat) => {
    const fx = Math.max(0, Math.min(n - 1, ((lon - b.west) / (b.east - b.west)) * (n - 1)));
    const fy = Math.max(0, Math.min(n - 1, ((b.north - lat) / (b.north - b.south)) * (n - 1)));
    const x0 = Math.min(n - 2, Math.floor(fx));
    const y0 = Math.min(n - 2, Math.floor(fy));
    const tx = fx - x0;
    const ty = fy - y0;
    const at = (x: number, y: number) => projected[y * n + x];
    const [a, bb, c, d] = [at(x0, y0), at(x0 + 1, y0), at(x0, y0 + 1), at(x0 + 1, y0 + 1)];
    return [
      a[0] * (1 - tx) * (1 - ty) + bb[0] * tx * (1 - ty) + c[0] * (1 - tx) * ty + d[0] * tx * ty,
      a[1] * (1 - tx) * (1 - ty) + bb[1] * tx * (1 - ty) + c[1] * (1 - tx) * ty + d[1] * tx * ty,
    ];
  };
}

/** The lattice points to project: n × n over the bounds, row by row from the north. */
export function latticePoints(b: Bounds, n: number): LonLat[] {
  const points: LonLat[] = [];
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) points.push([b.west + (c / (n - 1)) * (b.east - b.west), b.north - (r / (n - 1)) * (b.north - b.south)]);
  }
  return points;
}

/**
 * The patch: each cell centre mapped into the reduced raster and read bilinearly.
 * `toPixel` gives continuous full-resolution pixel coordinates (cell centres at
 * integers); the reduced raster is `factor` times smaller.
 */
export function resampleToGrid(args: {
  bounds: Bounds;
  cols: number;
  rows: number;
  reduced: Float32Array;
  reducedWidth: number;
  reducedHeight: number;
  factor: number;
  toPixel: (lon: number, lat: number) => [number, number];
  scale?: number;
}): DroneGrid {
  const { bounds: b, cols, rows, reduced, reducedWidth, reducedHeight, factor, toPixel } = args;
  const scale = args.scale ?? 1;
  const values = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r += 1) {
    const lat = b.north - ((r + 0.5) / rows) * (b.north - b.south);
    for (let c = 0; c < cols; c += 1) {
      const lon = b.west + ((c + 0.5) / cols) * (b.east - b.west);
      const [px, py] = toPixel(lon, lat);
      // Full-resolution pixel p lies in block floor(p / factor), whose centre is (k + ½)·factor − ½.
      const v = sampleRaster(reduced, reducedWidth, reducedHeight, (px + 0.5) / factor - 0.5, (py + 0.5) / factor - 0.5);
      values[r * cols + c] = Number.isFinite(v) ? v * scale : NaN;
    }
  }
  return { ...b, cols, rows, values };
}

// --- Blending a survey into the terrain model at its edges -----------------------

/** The cell holding a point, or -1 outside the grid. */
export function cellIndex(grid: DroneGrid, lon: number, lat: number): number {
  if (!covers(grid, lon, lat)) return -1;
  const c = Math.min(grid.cols - 1, Math.max(0, Math.floor(((lon - grid.west) / (grid.east - grid.west)) * grid.cols)));
  const r = Math.min(grid.rows - 1, Math.max(0, Math.floor(((grid.north - lat) / (grid.north - grid.south)) * grid.rows)));
  return r * grid.cols + c;
}

/**
 * For each cell, how many cells away the nearest cell without data is (outside
 * the grid counts as without data), capped at `cap`; 0 for cells without data.
 * Two passes of an 8-neighbour chamfer: exact along rows and columns, close
 * enough on diagonals for blending an edge.
 */
export function edgeDistance(grid: DroneGrid, cap: number): Uint8Array {
  const { cols, rows, values } = grid;
  const limit = Math.max(1, Math.min(255, Math.floor(cap)));
  const d = new Uint8Array(cols * rows);
  for (let i = 0; i < d.length; i += 1) d[i] = Number.isFinite(values[i]) ? limit : 0;
  const at = (r: number, c: number) => (r < 0 || c < 0 || r >= rows || c >= cols ? 0 : d[r * cols + c]);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const k = r * cols + c;
      if (!d[k]) continue;
      d[k] = Math.min(d[k], at(r - 1, c - 1) + 1, at(r - 1, c) + 1, at(r - 1, c + 1) + 1, at(r, c - 1) + 1);
    }
  }
  for (let r = rows - 1; r >= 0; r -= 1) {
    for (let c = cols - 1; c >= 0; c -= 1) {
      const k = r * cols + c;
      if (!d[k]) continue;
      d[k] = Math.min(d[k], at(r + 1, c + 1) + 1, at(r + 1, c) + 1, at(r + 1, c - 1) + 1, at(r, c + 1) + 1);
    }
  }
  return d;
}

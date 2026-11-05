// Dependency-free (runs under `node --test`): USGS 3DEP elevation read tile by tile, exactly as
// the iPhone reads it (ios/ERISKit/.../UsgsElevation.swift), so the two get the same heights.
// elevationTile.test.ts and UsgsElevationTests.swift hold the same tile to the same height.

export type LonLat = [number, number];
export type ElevationTile = { width: number; height: number; values: Float32Array };
export type TilePlace = { row: number; col: number; x: number; y: number };

// USGS's finest DEM is 1 m, and this reads 0.9 to 1 m apart everywhere in California.
const LEVEL = 17;
const ORIGIN_X = -20037508.342787;
const ORIGIN_Y = 20037508.342787;
const RESOLUTION_AT_LEVEL_ZERO = 156543.03392800014;
const EARTH_RADIUS = 6378137.0;
const CELLS_PER_TILE = 256;
const RESOLUTION_M = RESOLUTION_AT_LEVEL_ZERO / 2 ** LEVEL;
const AT_ONCE = 6;

class Reader {
  at = 0;
  bytes: Uint8Array;
  view: DataView;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private claim(count: number): number {
    if (count < 0 || this.at + count > this.bytes.length) throw new Error("Damaged elevation tile");
    const at = this.at;
    this.at += count;
    return at;
  }
  raw(count: number): Uint8Array {
    const at = this.claim(count);
    return this.bytes.subarray(at, at + count);
  }
  u8() { return this.view.getUint8(this.claim(1)); }
  i8() { return this.view.getInt8(this.claim(1)); }
  u16() { return this.view.getUint16(this.claim(2), true); }
  i16() { return this.view.getInt16(this.claim(2), true); }
  u32() { return this.view.getUint32(this.claim(4), true); }
  i32() { return this.view.getInt32(this.claim(4), true); }
  f32() { return this.view.getFloat32(this.claim(4), true); }
  f64() { return this.view.getFloat64(this.claim(8), true); }
}

/** Heights as small whole numbers packed into 32-bit words, top bits first. */
function unstuff(r: Reader, values: Float32Array, cells: number[], offset: number, scale: number, maxZ: number) {
  const header = r.u8();
  const bits = header & 63;
  const size = header >> 6;
  const stored = size === 0 ? r.u32() : size === 1 ? r.u16() : r.u8();
  const byteCount = Math.floor((stored * bits + 7) / 8);
  const raw = r.raw(byteCount);
  const wordCount = Math.floor((byteCount + 3) / 4);
  const words = new Uint32Array(wordCount);
  raw.forEach((byte, i) => { words[i >> 2] = (words[i >> 2] | (byte << (8 * (i % 4)))) >>> 0; });
  const tail = wordCount * 4 - byteCount;
  if (tail > 0 && wordCount > 0) words[wordCount - 1] = (words[wordCount - 1] << (8 * tail)) >>> 0;
  if (stored < cells.length) throw new Error("Damaged elevation tile");

  const mask = bits >= 32 ? 0xffffffff : 2 ** bits - 1;
  let word = 0;
  let left = 0;
  let buffer = 0;
  for (const i of cells) {
    let n = 0;
    if (bits > 0) {
      if (left === 0) {
        if (word >= wordCount) throw new Error("Damaged elevation tile");
        buffer = words[word++];
        left = 32;
      }
      if (left >= bits) {
        n = ((buffer >>> (left - bits)) & mask) >>> 0;
        left -= bits;
      } else {
        const missing = bits - left;
        n = (((buffer & mask) << missing) & mask) >>> 0;
        if (word >= wordCount) throw new Error("Damaged elevation tile");
        buffer = words[word++];
        left = 32 - missing;
        n += buffer >>> left;
      }
    }
    values[i] = Math.min(Math.fround(offset + n * scale), maxZ);
  }
}

/** One tile as ERIS sends it (LERC 1, "CntZImage"): heights running corner to corner, NaN where there are none. */
export function readElevationTile(buffer: ArrayBuffer | Uint8Array): ElevationTile {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const r = new Reader(bytes);
  const magic = String.fromCharCode(...r.raw(10));
  if (magic !== "CntZImage ") throw new Error("Not an elevation tile");
  r.i32(); // version
  r.i32(); // type
  const height = r.i32();
  const width = r.i32();
  const maxError = r.f64();
  if (width <= 0 || height <= 0 || width * height > 4_194_304) throw new Error("Damaged elevation tile");
  const count = width * height;

  // Which cells hold data: all, none, or a run-length coded bitmask.
  r.i32();
  r.i32();
  const maskBytes = r.i32();
  const maskMax = r.f32();
  const valid = new Uint8Array(count);
  if (maskBytes === 0) {
    valid.fill(maskMax > 0 ? 1 : 0);
  } else {
    const end = r.at + maskBytes;
    const bits: number[] = [];
    while (r.at < end) {
      const run = r.i16();
      if (run === -32768) break;
      if (run > 0) bits.push(...r.raw(run));
      else {
        const byte = r.u8();
        for (let i = 0; i < -run; i += 1) bits.push(byte);
      }
    }
    if (bits.length < Math.floor((count + 7) / 8)) throw new Error("Damaged elevation tile");
    for (let i = 0; i < count; i += 1) valid[i] = bits[i >> 3] & (128 >> (i & 7)) ? 1 : 0;
    r.at = end;
  }
  const values = new Float32Array(count).fill(NaN);
  if (!valid.includes(1)) return { width, height, values };

  // The heights, in blocks.
  const blocksY = Math.max(1, r.i32());
  const blocksX = Math.max(1, r.i32());
  const heightBytes = r.i32();
  const maxZ = r.f32();
  if (heightBytes === 0) {
    for (let i = 0; i < count; i += 1) if (valid[i]) values[i] = maxZ;
    return { width, height, values };
  }
  const blockH = Math.floor(height / blocksY);
  const blockW = Math.floor(width / blocksX);
  const rows = blocksY + (height % blocksY > 0 ? 1 : 0);
  const cols = blocksX + (width % blocksX > 0 ? 1 : 0);
  for (let by = 0; by < rows; by += 1) {
    const thisH = by < blocksY ? blockH : height % blocksY;
    for (let bx = 0; bx < cols; bx += 1) {
      const thisW = bx < blocksX ? blockW : width % blocksX;
      const cells: number[] = [];
      for (let y = 0; y < thisH; y += 1) {
        for (let x = 0; x < thisW; x += 1) {
          const i = (by * blockH + y) * width + bx * blockW + x;
          if (valid[i]) cells.push(i);
        }
      }
      const header = r.u8();
      const encoding = header & 63;
      if (encoding === 0) {
        for (const i of cells) values[i] = r.f32();
      } else if (encoding === 2) {
        for (const i of cells) values[i] = 0;
      } else if (encoding === 1 || encoding === 3) {
        const size = header >> 6;
        const offset = size === 0 ? r.f32() : size === 1 ? r.i16() : r.i8();
        if (encoding === 3) for (const i of cells) values[i] = offset;
        else unstuff(r, values, cells, offset, 2 * maxError, maxZ);
      } else {
        throw new Error("Damaged elevation tile");
      }
    }
  }
  return { width, height, values };
}

/** Bilinear between the four posts around a spot given as fractions across the tile; null over no data. */
export function heightInTile(tile: ElevationTile, x: number, y: number): number | null {
  const { width, height, values } = tile;
  const fx = x * (width - 1);
  const fy = y * (height - 1);
  const x0 = Math.max(0, Math.min(width - 2, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(height - 2, Math.floor(fy)));
  const tx = fx - x0;
  const ty = fy - y0;
  const a = values[y0 * width + x0];
  const b = values[y0 * width + x0 + 1];
  const c = values[(y0 + 1) * width + x0];
  const d = values[(y0 + 1) * width + x0 + 1];
  if (![a, b, c, d].every(Number.isFinite)) return null;
  return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
}

/** Which tile a point falls in, and how far across it. */
export function tileOf([lon, lat]: LonLat): TilePlace {
  const mx = (lon * Math.PI / 180) * EARTH_RADIUS;
  const my = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const size = RESOLUTION_M * CELLS_PER_TILE;
  const col = Math.floor((mx - ORIGIN_X) / size);
  const row = Math.floor((ORIGIN_Y - my) / size);
  return { row, col, x: (mx - ORIGIN_X) / size - col, y: (ORIGIN_Y - my) / size - row };
}

/** The spacing of the heights on the ground at a latitude, in metres. */
export const groundSpacingM = (lat: number) => RESOLUTION_M * Math.cos((lat * Math.PI) / 180);

/** Heights at points, in order, null where there is no data. A tile that fails fails the whole answer. */
export async function heightsAt(
  points: LonLat[],
  fetchTile: (row: number, col: number) => Promise<ElevationTile | null>,
): Promise<Array<number | null>> {
  const places = points.map(tileOf);
  const wanted = new Map<string, { row: number; col: number }>();
  for (const { row, col } of places) wanted.set(`${row}/${col}`, { row, col });
  const queue = [...wanted.entries()];
  const tiles = new Map<string, ElevationTile | null>();
  // A few at a time: a form can touch dozens of tiles, and each may have to come from USGS.
  await Promise.all(
    Array.from({ length: Math.min(AT_ONCE, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        tiles.set(next[0], await fetchTile(next[1].row, next[1].col));
      }
    }),
  );
  return places.map((place) => {
    const tile = tiles.get(`${place.row}/${place.col}`);
    return tile ? heightInTile(tile, place.x, place.y) : null;
  });
}

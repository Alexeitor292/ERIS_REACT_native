// Dependency-free (runs under `node --test`): site areas drawn on the technical
// form's location map. An area is a GeoJSON polygon (rings of [lon, lat] in
// WGS84); a form's areas are stored as one Polygon or a MultiPolygon, which is
// what the mobile app's sketch reads and writes.

export type Ring = Array<[number, number]>;
export type AreaRings = Ring[];
export type AreasGeometry = { type: "Polygon"; coordinates: AreaRings } | { type: "MultiPolygon"; coordinates: AreaRings[] };

const EARTH_RADIUS_M = 6_378_137;
const SQ_M_PER_ACRE = 4_046.8564224;
const SQ_FT_PER_SQ_M = 10.763910417;

const rad = (degrees: number) => (degrees * Math.PI) / 180;

/** Area enclosed by one ring on the sphere, in square metres (always positive). */
export function ringAreaSqM(ring: Ring): number {
  const n = ring.length;
  if (n < 3) return 0;
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[(i + 1) % n];
    total += rad(lon2 - lon1) * (2 + Math.sin(rad(lat1)) + Math.sin(rad(lat2)));
  }
  return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

/** A polygon's area: its outer ring less its holes. */
export function polygonAreaSqM(rings: AreaRings): number {
  if (!rings.length) return 0;
  const [outer, ...holes] = rings;
  return Math.max(0, ringAreaSqM(outer) - holes.reduce((sum, hole) => sum + ringAreaSqM(hole), 0));
}

/** The polygons in any stored geometry; lines and points are not areas. */
export function areasFromGeoJson(geometry: unknown): AreaRings[] {
  if (!geometry || typeof geometry !== "object") return [];
  const g = geometry as { type?: string; coordinates?: unknown; geometries?: unknown[] };
  const type = String(g.type ?? "").toLowerCase();
  if (type === "polygon" && Array.isArray(g.coordinates) && g.coordinates.length) return [g.coordinates as AreaRings];
  if (type === "multipolygon" && Array.isArray(g.coordinates)) return (g.coordinates as AreaRings[]).filter((p) => Array.isArray(p) && p.length);
  if (type === "geometrycollection" && Array.isArray(g.geometries)) return g.geometries.flatMap((item) => areasFromGeoJson(item));
  return [];
}

/** How a set of areas is stored: nothing, one Polygon, or a MultiPolygon. */
export function geoJsonFromAreas(areas: AreaRings[]): AreasGeometry | null {
  const kept = areas.filter((rings) => rings.length && rings[0].length >= 4);
  if (kept.length === 0) return null;
  if (kept.length === 1) return { type: "Polygon", coordinates: kept[0] };
  return { type: "MultiPolygon", coordinates: kept };
}

/** "5,020 m² · 1.24 ac" for large areas, "650 m² · 7,000 ft²" for small ones. */
export function formatArea(sqm: number): string {
  const metric = `${Math.round(sqm).toLocaleString("en-US")} m²`;
  if (sqm >= SQ_M_PER_ACRE / 4) return `${metric} · ${(sqm / SQ_M_PER_ACRE).toLocaleString("en-US", { maximumFractionDigits: 2 })} ac`;
  return `${metric} · ${Math.round(sqm * SQ_FT_PER_SQ_M).toLocaleString("en-US")} ft²`;
}

/** Summary line for the toolbar: "2 areas · 5,020 m² · 1.24 ac". */
export function areasSummary(areas: AreaRings[]): string {
  if (!areas.length) return "No areas drawn";
  const total = areas.reduce((sum, rings) => sum + polygonAreaSqM(rings), 0);
  return `${areas.length} ${areas.length === 1 ? "area" : "areas"} · ${formatArea(total)}`;
}

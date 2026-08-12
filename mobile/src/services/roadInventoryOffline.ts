/**
 * Road inventory + Caltrans postmile offline sync service.
 *
 * Package schema v2 contains both the existing HICOMP-derived road segments and
 * a server-side snapshot of Caltrans SHN Postmiles Tenth point geometry. The
 * mobile app verifies the package SHA-256 before persisting either dataset.
 *
 * Schema v1 remains readable for backwards compatibility, but it cannot satisfy
 * offline coordinate <-> postmile conversion because it contains no geometry.
 */

import { File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { inflate } from "pako";
import { sha256 } from "js-sha256";

import {
  downloadRoadInventoryPackage,
  getRoadInventoryManifest,
} from "../api/roadInventory";

const META_KEY = "road_inventory_offline_meta_v1";
const SEGMENTS_FILENAME = "road_inventory_segments_v1.json";
const POSTMILE_POINTS_FILENAME = "road_inventory_postmile_points_v2.json";
const GRID_DEGREES = 0.05;

function segmentsFile(): File {
  return new File(Paths.document, SEGMENTS_FILENAME);
}

function postmilePointsFile(): File {
  return new File(Paths.document, POSTMILE_POINTS_FILENAME);
}

export type RoadSegment = {
  id: number;
  district_code: string | null;
  county_code: string;
  route_name: string;
  route_suffix_code: string | null;
  pm_prefix_code: string | null;
  begin_pm: number;
  end_pm: number;
  length_miles: number | null;
  left_lanes: number | null;
  right_lanes: number | null;
  left_surface_type: string | null;
  right_surface_type: string | null;
  median_type: string | null;
  median_width: number | null;
  terrain_code: string | null;
  design_speed: number | null;
  adt: number | null;
  landmark_short_desc: string | null;
};

export type PostmileReferencePoint = {
  object_id: number | null;
  district_code: string | null;
  county_code: string;
  route_name: string;
  route_suffix_code: string | null;
  pm_route_id: string | null;
  pm_prefix_code: string | null;
  postmile: number;
  pm_suffix_code: string | null;
  postmile_compound: string | null;
  odometer: number | null;
  pm_interval: number | null;
  highway_segment: string | null;
  align_code: string | null;
  direction: string | null;
  latitude: number;
  longitude: number;
};

export type LocalPackageMeta = {
  dataset_version_id: number;
  version_tag: string;
  extract_date: string | null;
  generated_at: string;
  row_count: number;
  sha256: string;
  synced_at: string;
  schema_version?: number;
  location_reference_source?: string | null;
  location_point_count?: number;
};

export type RoadInventoryLocalStatus =
  | { available: false; location_reference_available: false }
  | {
      available: true;
      meta: LocalPackageMeta;
      location_reference_available: boolean;
    };

export type LocalLocationResolution = {
  district: string | null;
  county: string;
  route: string;
  post_mile: string;
  latitude: number;
  longitude: number;
  align_code: string | null;
  method: "NEAREST_REFERENCE" | "PROJECTED_REFERENCE" | "EXACT_POSTMILE" | "INTERPOLATED_POSTMILE";
  distance_meters?: number;
  source: "CALTRANS_SHN_POSTMILES_TENTH_OFFLINE";
};

let segmentsCache: RoadSegment[] | null = null;
let postmilePointsCache: PostmileReferencePoint[] | null = null;
let spatialGridCache: Map<string, PostmileReferencePoint[]> | null = null;
let routeIndexCache: Map<string, PostmileReferencePoint[]> | null = null;

function clearReferenceCaches() {
  postmilePointsCache = null;
  spatialGridCache = null;
  routeIndexCache = null;
}

export async function getLocalRoadInventoryStatus(): Promise<RoadInventoryLocalStatus> {
  try {
    const raw = await SecureStore.getItemAsync(META_KEY);
    if (!raw) return { available: false, location_reference_available: false };
    const meta = JSON.parse(raw) as LocalPackageMeta;
    if (!segmentsFile().exists) return { available: false, location_reference_available: false };
    const locationReferenceAvailable =
      Number(meta.location_point_count ?? 0) > 0 && postmilePointsFile().exists;
    return {
      available: true,
      meta,
      location_reference_available: locationReferenceAvailable,
    };
  } catch {
    return { available: false, location_reference_available: false };
  }
}

export async function syncRoadInventoryPackage(
  token: string,
): Promise<LocalPackageMeta> {
  const manifest = await getRoadInventoryManifest(token);

  if (!manifest.package.available) {
    throw new Error(
      "No mobile package has been generated yet. Ask an administrator to generate one from the web admin panel.",
    );
  }

  const pkg = manifest.package;
  if (!pkg.download_url) {
    throw new Error("Package download URL is unavailable. Check MinIO configuration.");
  }

  const compressed = await downloadRoadInventoryPackage(pkg.download_url);
  const computedHash = sha256(compressed);
  if (computedHash !== pkg.sha256) {
    throw new Error(
      `Package integrity check failed: expected ${pkg.sha256.slice(0, 12)}… got ${computedHash.slice(0, 12)}…`,
    );
  }

  let inflated: Uint8Array;
  try {
    inflated = inflate(compressed);
  } catch (e: any) {
    throw new Error(`Failed to decompress package: ${e?.message ?? e}`);
  }

  const decoder = new TextDecoder("utf-8");
  let parsed: any;
  try {
    parsed = JSON.parse(decoder.decode(inflated));
  } catch (e: any) {
    throw new Error(`Failed to parse package JSON: ${e?.message ?? e}`);
  }

  if (parsed?.schema_version !== 1 && parsed?.schema_version !== 2) {
    throw new Error(
      `Unsupported package schema_version: ${parsed?.schema_version}. Update the app.`,
    );
  }
  if (!Array.isArray(parsed?.segments)) {
    throw new Error("Package JSON is missing the segments array.");
  }
  if (parsed.schema_version === 2 && !Array.isArray(parsed?.postmile_points)) {
    throw new Error("Schema v2 package is missing the postmile_points array.");
  }

  const segments: RoadSegment[] = parsed.segments;
  const points: PostmileReferencePoint[] =
    parsed.schema_version === 2 ? parsed.postmile_points : [];

  segmentsFile().write(JSON.stringify(segments));
  if (points.length > 0) {
    postmilePointsFile().write(JSON.stringify(points));
  } else {
    try {
      const f = postmilePointsFile();
      if (f.exists) f.delete();
    } catch {
      // best effort cleanup of stale v2 geometry when a v1 package is installed
    }
  }

  const meta: LocalPackageMeta = {
    dataset_version_id: manifest.version_id,
    version_tag: manifest.version_tag,
    extract_date: manifest.extract_date,
    generated_at: pkg.generated_at,
    row_count: segments.length,
    sha256: pkg.sha256,
    synced_at: new Date().toISOString(),
    schema_version: Number(parsed.schema_version),
    location_reference_source:
      typeof parsed?.location_reference?.source === "string"
        ? parsed.location_reference.source
        : null,
    location_point_count: points.length,
  };
  await SecureStore.setItemAsync(META_KEY, JSON.stringify(meta));

  segmentsCache = segments;
  clearReferenceCaches();
  postmilePointsCache = points;

  return meta;
}

export async function clearLocalRoadInventoryPackage(): Promise<void> {
  segmentsCache = null;
  clearReferenceCaches();
  for (const file of [segmentsFile(), postmilePointsFile()]) {
    try {
      if (file.exists) file.delete();
    } catch {
      // ignore
    }
  }
  try {
    await SecureStore.deleteItemAsync(META_KEY);
  } catch {
    // ignore
  }
}

export async function lookupLocalRoadSegments(params: {
  countyCode: string;
  routeName: string;
  postmile: number;
  districtCode?: string;
}): Promise<RoadSegment[]> {
  const segments = await loadSegments();
  if (!segments || segments.length === 0) return [];

  const county = params.countyCode.trim().toUpperCase();
  const route = normalizeRoute(params.routeName);
  const pm = params.postmile;

  const matches = segments.filter(
    (s) =>
      s.county_code.toUpperCase() === county &&
      normalizeRoute(s.route_name) === route &&
      s.begin_pm <= pm &&
      s.end_pm >= pm,
  );

  matches.sort((a, b) => {
    const dist = normalizeDistrict(params.districtCode);
    const aMatch = dist && normalizeDistrict(a.district_code) === dist ? 0 : 1;
    const bMatch = dist && normalizeDistrict(b.district_code) === dist ? 0 : 1;
    if (aMatch !== bMatch) return aMatch - bMatch;
    return a.end_pm - a.begin_pm - (b.end_pm - b.begin_pm);
  });

  return matches;
}

export async function lookupLocalLocationByCoordinates(params: {
  latitude: number;
  longitude: number;
  maxDistanceMeters?: number;
}): Promise<LocalLocationResolution | null> {
  const lat = Number(params.latitude);
  const lon = Number(params.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const points = await loadPostmilePoints();
  if (!points || points.length === 0) return null;
  const grid = buildSpatialGrid(points);
  const candidates = nearbyGridPoints(grid, lat, lon);
  const pool = candidates.length > 0 ? candidates : points;

  let nearest: PostmileReferencePoint | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const point of pool) {
    const distance = distanceMeters(lat, lon, point.latitude, point.longitude);
    if (distance < nearestDistance) {
      nearest = point;
      nearestDistance = distance;
    }
  }

  const maxDistance = params.maxDistanceMeters ?? 3000;
  if (!nearest || nearestDistance > maxDistance) return null;

  const projected = projectCoordinateToAdjacentPostmile(
    lat,
    lon,
    nearest,
    pointsForRoute(await buildRouteIndex(points), nearest.county_code, nearest.route_name),
  );

  if (projected) {
    return {
      district: projected.anchor.district_code,
      county: projected.anchor.county_code,
      route: normalizeRoute(projected.anchor.route_name).padStart(3, "0"),
      post_mile: formatPostmile(
        projected.postmile,
        projected.anchor.pm_prefix_code,
        projected.anchor.pm_suffix_code,
      ),
      latitude: lat,
      longitude: lon,
      align_code: projected.anchor.align_code,
      method: "PROJECTED_REFERENCE",
      distance_meters: projected.distanceMeters,
      source: "CALTRANS_SHN_POSTMILES_TENTH_OFFLINE",
    };
  }

  return {
    district: nearest.district_code,
    county: nearest.county_code,
    route: normalizeRoute(nearest.route_name).padStart(3, "0"),
    post_mile: formatPostmile(nearest.postmile, nearest.pm_prefix_code, nearest.pm_suffix_code),
    latitude: lat,
    longitude: lon,
    align_code: nearest.align_code,
    method: "NEAREST_REFERENCE",
    distance_meters: nearestDistance,
    source: "CALTRANS_SHN_POSTMILES_TENTH_OFFLINE",
  };
}

export async function lookupLocalCoordinatesByRoad(params: {
  districtCode?: string;
  countyCode: string;
  routeName: string;
  postmile: string | number;
}): Promise<LocalLocationResolution | null> {
  const points = await loadPostmilePoints();
  if (!points || points.length === 0) return null;

  const county = String(params.countyCode || "").trim().toUpperCase();
  const route = normalizeRoute(params.routeName);
  const parsedPm = parsePostmile(params.postmile);
  if (!county || !route || !parsedPm) return null;

  const routeIndex = await buildRouteIndex(points);
  let candidates = pointsForRoute(routeIndex, county, route);
  if (candidates.length === 0) return null;

  const district = normalizeDistrict(params.districtCode);
  if (district) {
    const districtMatches = candidates.filter(
      (p) => normalizeDistrict(p.district_code) === district,
    );
    if (districtMatches.length > 0) candidates = districtMatches;
  }

  if (parsedPm.prefix) {
    candidates = candidates.filter(
      (p) => normalizePmCode(p.pm_prefix_code) === parsedPm.prefix,
    );
  } else {
    const noPrefix = candidates.filter((p) => !normalizePmCode(p.pm_prefix_code));
    if (noPrefix.length > 0) candidates = noPrefix;
  }

  if (parsedPm.suffix) {
    candidates = candidates.filter(
      (p) => normalizePmCode(p.pm_suffix_code) === parsedPm.suffix,
    );
  }
  if (candidates.length === 0) return null;

  const exact = candidates.filter((p) => Math.abs(p.postmile - parsedPm.value) <= 0.0005);
  if (exact.length > 0) {
    const point = midpointReferencePoints(exact);
    return {
      district: point.district_code,
      county: point.county_code,
      route: normalizeRoute(point.route_name).padStart(3, "0"),
      post_mile: formatPostmile(parsedPm.value, point.pm_prefix_code, point.pm_suffix_code),
      latitude: point.latitude,
      longitude: point.longitude,
      align_code: point.align_code,
      method: "EXACT_POSTMILE",
      source: "CALTRANS_SHN_POSTMILES_TENTH_OFFLINE",
    };
  }

  const interpolated = interpolatePostmile(candidates, parsedPm.value);
  if (interpolated) {
    return {
      district: interpolated.anchor.district_code,
      county: interpolated.anchor.county_code,
      route: normalizeRoute(interpolated.anchor.route_name).padStart(3, "0"),
      post_mile: formatPostmile(
        parsedPm.value,
        interpolated.anchor.pm_prefix_code,
        interpolated.anchor.pm_suffix_code,
      ),
      latitude: interpolated.latitude,
      longitude: interpolated.longitude,
      align_code: interpolated.anchor.align_code,
      method: "INTERPOLATED_POSTMILE",
      source: "CALTRANS_SHN_POSTMILES_TENTH_OFFLINE",
    };
  }

  const nearest = [...candidates].sort(
    (a, b) => Math.abs(a.postmile - parsedPm.value) - Math.abs(b.postmile - parsedPm.value),
  )[0];
  if (!nearest || Math.abs(nearest.postmile - parsedPm.value) > 0.12) return null;

  return {
    district: nearest.district_code,
    county: nearest.county_code,
    route: normalizeRoute(nearest.route_name).padStart(3, "0"),
    post_mile: formatPostmile(parsedPm.value, nearest.pm_prefix_code, nearest.pm_suffix_code),
    latitude: nearest.latitude,
    longitude: nearest.longitude,
    align_code: nearest.align_code,
    method: "NEAREST_REFERENCE",
    source: "CALTRANS_SHN_POSTMILES_TENTH_OFFLINE",
  };
}

async function loadSegments(): Promise<RoadSegment[] | null> {
  if (segmentsCache !== null) return segmentsCache;
  try {
    const f = segmentsFile();
    if (!f.exists) return null;
    segmentsCache = JSON.parse(await f.text()) as RoadSegment[];
    return segmentsCache;
  } catch {
    return null;
  }
}

async function loadPostmilePoints(): Promise<PostmileReferencePoint[] | null> {
  if (postmilePointsCache !== null) return postmilePointsCache;
  try {
    const f = postmilePointsFile();
    if (!f.exists) return null;
    postmilePointsCache = JSON.parse(await f.text()) as PostmileReferencePoint[];
    return postmilePointsCache;
  } catch {
    return null;
  }
}

function normalizeRoute(route: string): string {
  if (!route) return route;
  let r = String(route).trim();
  r = r.replace(/^(US|SR|CA|HWY|HIGHWAY)\s*/i, "");
  r = r.replace(/^0+(\d+)$/, "$1");
  return r;
}

function normalizeDistrict(value?: string | null): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits ? digits.slice(-2).padStart(2, "0") : "";
}

function normalizePmCode(value?: string | null): string {
  return String(value ?? "").trim().toUpperCase();
}

function parsePostmile(value: string | number): { prefix: string; value: number; suffix: string } | null {
  const raw = String(value ?? "").trim().replace(/\s+/g, "").toUpperCase();
  const match = raw.match(/^([A-Z]?)(-?\d+(?:\.\d+)?)([A-Z]?)$/);
  if (!match) return null;
  const number = Number(match[2]);
  if (!Number.isFinite(number)) return null;
  return { prefix: match[1] || "", value: number, suffix: match[3] || "" };
}

function formatPostmile(value: number, prefix?: string | null, suffix?: string | null): string {
  const rounded = Math.round(value * 100) / 100;
  return `${normalizePmCode(prefix)}${rounded.toFixed(2)}${normalizePmCode(suffix)}`;
}

function gridKey(lat: number, lon: number): string {
  return `${Math.floor(lat / GRID_DEGREES)}:${Math.floor(lon / GRID_DEGREES)}`;
}

function buildSpatialGrid(points: PostmileReferencePoint[]): Map<string, PostmileReferencePoint[]> {
  if (spatialGridCache) return spatialGridCache;
  const grid = new Map<string, PostmileReferencePoint[]>();
  for (const point of points) {
    const key = gridKey(point.latitude, point.longitude);
    const bucket = grid.get(key);
    if (bucket) bucket.push(point);
    else grid.set(key, [point]);
  }
  spatialGridCache = grid;
  return grid;
}

function nearbyGridPoints(
  grid: Map<string, PostmileReferencePoint[]>,
  lat: number,
  lon: number,
): PostmileReferencePoint[] {
  const latCell = Math.floor(lat / GRID_DEGREES);
  const lonCell = Math.floor(lon / GRID_DEGREES);
  const result: PostmileReferencePoint[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const bucket = grid.get(`${latCell + dy}:${lonCell + dx}`);
      if (bucket) result.push(...bucket);
    }
  }
  return result;
}

async function buildRouteIndex(
  points: PostmileReferencePoint[],
): Promise<Map<string, PostmileReferencePoint[]>> {
  if (routeIndexCache) return routeIndexCache;
  const index = new Map<string, PostmileReferencePoint[]>();
  for (const point of points) {
    const key = `${point.county_code.toUpperCase()}|${normalizeRoute(point.route_name)}`;
    const bucket = index.get(key);
    if (bucket) bucket.push(point);
    else index.set(key, [point]);
  }
  for (const bucket of index.values()) {
    bucket.sort((a, b) => a.postmile - b.postmile);
  }
  routeIndexCache = index;
  return index;
}

function pointsForRoute(
  index: Map<string, PostmileReferencePoint[]>,
  county: string,
  route: string,
): PostmileReferencePoint[] {
  return index.get(`${county.trim().toUpperCase()}|${normalizeRoute(route)}`) ?? [];
}

function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 6_371_000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dp / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function compatibleReferenceGroup(a: PostmileReferencePoint, b: PostmileReferencePoint): boolean {
  return (
    a.county_code === b.county_code &&
    normalizeRoute(a.route_name) === normalizeRoute(b.route_name) &&
    normalizeDistrict(a.district_code) === normalizeDistrict(b.district_code) &&
    normalizePmCode(a.pm_prefix_code) === normalizePmCode(b.pm_prefix_code) &&
    normalizePmCode(a.pm_suffix_code) === normalizePmCode(b.pm_suffix_code) &&
    String(a.pm_route_id ?? "") === String(b.pm_route_id ?? "") &&
    String(a.align_code ?? "") === String(b.align_code ?? "")
  );
}

function interpolatePostmile(
  points: PostmileReferencePoint[],
  targetPm: number,
): { latitude: number; longitude: number; anchor: PostmileReferencePoint } | null {
  let best: {
    latitude: number;
    longitude: number;
    anchor: PostmileReferencePoint;
    gap: number;
  } | null = null;

  const sorted = [...points].sort((a, b) => a.postmile - b.postmile);
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (!compatibleReferenceGroup(a, b)) continue;
    if (targetPm < a.postmile || targetPm > b.postmile) continue;
    const gap = b.postmile - a.postmile;
    if (gap <= 0 || gap > 0.25) continue;
    const t = (targetPm - a.postmile) / gap;
    const candidate = {
      latitude: a.latitude + (b.latitude - a.latitude) * t,
      longitude: a.longitude + (b.longitude - a.longitude) * t,
      anchor: a,
      gap,
    };
    if (!best || candidate.gap < best.gap) best = candidate;
  }

  return best
    ? { latitude: best.latitude, longitude: best.longitude, anchor: best.anchor }
    : null;
}

function midpointReferencePoints(points: PostmileReferencePoint[]): PostmileReferencePoint {
  if (points.length === 1) return points[0];
  const preferred = [...points].sort((a, b) => alignRank(a.align_code) - alignRank(b.align_code))[0];
  const lat = points.reduce((sum, p) => sum + p.latitude, 0) / points.length;
  const lon = points.reduce((sum, p) => sum + p.longitude, 0) / points.length;
  return { ...preferred, latitude: lat, longitude: lon };
}

function alignRank(value?: string | null): number {
  const code = String(value ?? "").trim().toUpperCase();
  if (!code || code === "C" || code === "CL") return 0;
  if (code.startsWith("R")) return 1;
  if (code.startsWith("L")) return 2;
  return 3;
}

function projectCoordinateToAdjacentPostmile(
  lat: number,
  lon: number,
  nearest: PostmileReferencePoint,
  routePoints: PostmileReferencePoint[],
): { postmile: number; distanceMeters: number; anchor: PostmileReferencePoint } | null {
  const compatible = routePoints.filter(
    (p) =>
      compatibleReferenceGroup(nearest, p) &&
      Math.abs(p.postmile - nearest.postmile) <= 0.25,
  );
  if (compatible.length < 2) return null;

  let best: { postmile: number; distanceMeters: number; anchor: PostmileReferencePoint } | null = null;
  const sorted = [...compatible].sort((a, b) => a.postmile - b.postmile);
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const pmGap = b.postmile - a.postmile;
    if (pmGap <= 0 || pmGap > 0.25) continue;
    const projection = projectPointToSegment(lat, lon, a, b);
    if (!best || projection.distanceMeters < best.distanceMeters) {
      best = {
        postmile: a.postmile + pmGap * projection.t,
        distanceMeters: projection.distanceMeters,
        anchor: a,
      };
    }
  }
  return best;
}

function projectPointToSegment(
  lat: number,
  lon: number,
  a: PostmileReferencePoint,
  b: PostmileReferencePoint,
): { t: number; distanceMeters: number } {
  const latRef = (lat + a.latitude + b.latitude) / 3;
  const metersPerLat = 111_320;
  const metersPerLon = 111_320 * Math.cos((latRef * Math.PI) / 180);
  const px = lon * metersPerLon;
  const py = lat * metersPerLat;
  const ax = a.longitude * metersPerLon;
  const ay = a.latitude * metersPerLat;
  const bx = b.longitude * metersPerLon;
  const by = b.latitude * metersPerLat;
  const abx = bx - ax;
  const aby = by - ay;
  const denom = abx * abx + aby * aby;
  if (denom <= 0.0001) {
    return { t: 0, distanceMeters: Math.hypot(px - ax, py - ay) };
  }
  const rawT = ((px - ax) * abx + (py - ay) * aby) / denom;
  const t = Math.max(0, Math.min(1, rawT));
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  return { t, distanceMeters: Math.hypot(px - cx, py - cy) };
}

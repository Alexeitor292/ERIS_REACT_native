/**
 * Where a new report is, resolved exactly as the mobile app resolves it ONLINE.
 *
 * Ported rule for rule from
 *   mobile/src/utils/arcgisEnrichment.ts   — coordinates → District / County / Route / Post mile
 *   mobile/src/utils/arcgisRoadLocation.ts — District / County / Route / Post mile → coordinates
 * against the same public Caltrans SHN Postmiles Tenth layer, so a location
 * entered on the web and one captured on a phone come out the same. The web
 * queries Caltrans directly and does not use the offline road-inventory package
 * (owner decision, 2026-09-22): a desktop is online.
 *
 * One deliberate omission: the phone also asks the ArcGIS World geocoder for a
 * county and route, but only as a fallback for a postmile feature that lacks
 * them, and a location only counts as resolved when the postmile layer supplied
 * the district and post mile too — so that call never changes a result.
 *
 * Only the selection rules live here; caltransPostmileClient.ts does the
 * fetching. Dependency-free: `node --test` runs this file directly, which is why
 * the normalizers of utils/precision (identical on web and mobile) are repeated.
 */

export const DEFAULT_POSTMILE_LAYER_URL =
  "https://caltrans-gis.dot.ca.gov/arcgis/rest/services/CHhighway/SHN_Postmiles_Tenth/FeatureServer/0";

export type PostmileFeature = {
  attributes?: Record<string, unknown>;
  geometry?: {
    paths?: number[][][];
    rings?: number[][][];
    x?: number;
    y?: number;
  };
};

export type LocationMethod =
  | "ONLINE_COORDINATE_LOOKUP"
  | "ONLINE_EXACT_POSTMILE"
  | "ONLINE_INTERPOLATED_POSTMILE"
  | "ONLINE_NEAREST_POSTMILE";

/** A location every part of which is known: the only kind a report can be filed with. */
export type ResolvedIncidentLocation = {
  latitude: number;
  longitude: number;
  district: string;
  county: string;
  route: string;
  post_mile: string;
  method: LocationMethod;
  align_code?: string | null;
};

// ---------------------------------------------------------------------------
// utils/precision, repeated (see the header)
// ---------------------------------------------------------------------------

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function normalizeCoordinate(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const num = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(num) ? roundTo(num, 6) : null;
}

function normalizeRouteValue(value?: string | number | null): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return raw;
  return digits.slice(0, 3).padStart(3, "0");
}

function normalizePostMileValue(value?: string | number | null): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const num = Number(raw);
  if (!Number.isFinite(num)) return raw;
  return roundTo(num, 2).toFixed(2);
}

/** The number inside a post mile such as "R12.3" or "12.30L" (mobile CreateIncidentScreen). */
export function numericPostmile(value: string): number | null {
  const match = String(value || "").trim().toUpperCase().match(/^[A-Z]?(-?\d+(?:\.\d+)?)[A-Z]?$/);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) ? number : null;
}

// ---------------------------------------------------------------------------
// Coordinates → road (mobile arcgisEnrichment.ts: queryPostmileLayer)
// ---------------------------------------------------------------------------

export function coordinateQueryParams(lat: number, lon: number): Record<string, string> {
  return {
    f: "pjson",
    where: "1=1",
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    distance: "3000",
    units: "esriSRUnit_Meter",
    outFields: "*",
    returnGeometry: "true",
    outSR: "4326",
    resultRecordCount: "60",
  };
}

function toTwoDigitDistrict(value: unknown): string | null {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  return digits.padStart(2, "0");
}

function normalizeCounty(raw?: string | null): string | null {
  if (!raw) return null;
  return raw.replace(/\s+County$/i, "").trim() || null;
}

function pointToSegmentDistanceMeters(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const latRef = (py + ay + by) / 3;
  const mx = 111_320 * Math.cos((latRef * Math.PI) / 180);
  const my = 111_320;
  const pX = px * mx;
  const pY = py * my;
  const aX = ax * mx;
  const aY = ay * my;
  const bX = bx * mx;
  const bY = by * my;
  const abX = bX - aX;
  const abY = bY - aY;
  const apX = pX - aX;
  const apY = pY - aY;
  const abLenSq = abX * abX + abY * abY;
  if (abLenSq <= 0.0001) return Math.hypot(apX, apY);
  let t = (apX * abX + apY * abY) / abLenSq;
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  return Math.hypot(pX - (aX + t * abX), pY - (aY + t * abY));
}

function geometryDistanceMeters(feature: PostmileFeature, lon: number, lat: number): number {
  const g = feature.geometry;
  if (!g) return Number.POSITIVE_INFINITY;
  if (typeof g.x === "number" && typeof g.y === "number") {
    return pointToSegmentDistanceMeters(lon, lat, g.x, g.y, g.x, g.y);
  }
  let best = Number.POSITIVE_INFINITY;
  for (const line of g.paths ?? g.rings ?? []) {
    for (let i = 0; i + 1 < line.length; i += 1) {
      const [ax, ay] = line[i];
      const [bx, by] = line[i + 1];
      if (![ax, ay, bx, by].every((v) => Number.isFinite(v))) continue;
      best = Math.min(best, pointToSegmentDistanceMeters(lon, lat, ax, ay, bx, by));
    }
  }
  return best;
}

function getAttr(attrs: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (name in attrs) return attrs[name];
  }
  return undefined;
}

/**
 * The road location of a point: the nearest postmile feature's district,
 * county, route and post mile, at the point itself — or null unless all four
 * are known (the phone refuses a partial location the same way).
 */
export function roadFromCoordinateFeatures(features: PostmileFeature[], lat: number, lon: number): ResolvedIncidentLocation | null {
  if (features.length === 0) return null;
  const best = [...features].sort((a, b) => geometryDistanceMeters(a, lon, lat) - geometryDistanceMeters(b, lon, lat))[0];
  const attrs = best?.attributes;
  if (!attrs || typeof attrs !== "object") return null;
  const countyAttr = getAttr(attrs, "County", "COUNTY", "county");
  const district = toTwoDigitDistrict(getAttr(attrs, "District", "DISTRICT", "district"));
  const county = normalizeCounty(countyAttr != null ? String(countyAttr) : null);
  const route = normalizeRouteValue(getAttr(attrs, "Route", "ROUTE", "route") as string | number | null | undefined);
  const postMile = normalizePostMileValue(getAttr(attrs, "PM", "POSTMILE", "postmile", "ODOMETER") as string | number | null | undefined);
  const latitude = normalizeCoordinate(lat);
  const longitude = normalizeCoordinate(lon);
  if (!district || !county || !route || !postMile || latitude == null || longitude == null) return null;
  return { latitude, longitude, district, county: county.toUpperCase(), route, post_mile: postMile, method: "ONLINE_COORDINATE_LOOKUP" };
}

// ---------------------------------------------------------------------------
// Road → coordinates (mobile arcgisRoadLocation.ts)
// ---------------------------------------------------------------------------

export type RoadQuery = { district: string; county: string; route: string; postmile: number };

function escSql(value: string): string {
  return value.replace(/'/g, "''");
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

/** The query for postmile features within a quarter mile of the target, or null for an incomplete road location. */
export function roadQueryParams(params: RoadQuery): Record<string, string> | null {
  const routeNumber = Number(String(params.route).replace(/\D/g, ""));
  const districtNumber = Number(String(params.district).replace(/\D/g, ""));
  const county = params.county.trim().toUpperCase();
  if (!String(params.route).replace(/\D/g, "") || !String(params.district).replace(/\D/g, "")) return null;
  if (!Number.isFinite(routeNumber) || !Number.isFinite(districtNumber) || !county || !Number.isFinite(params.postmile)) return null;
  const where = [
    `County='${escSql(county)}'`,
    `Route=${Math.trunc(routeNumber)}`,
    `District=${Math.trunc(districtNumber)}`,
    `PM>=${params.postmile - 0.25}`,
    `PM<=${params.postmile + 0.25}`,
  ].join(" AND ");
  return {
    f: "json",
    where,
    outFields: "District,County,Route,PMPrefix,PM,PMSuffix,PMRouteID,AlignCode",
    returnGeometry: "true",
    outSR: "4326",
    orderByFields: "PM ASC",
    resultRecordCount: "50",
  };
}

function sameGroup(a: PostmileFeature, b: PostmileFeature): boolean {
  const aa = a.attributes ?? {};
  const ba = b.attributes ?? {};
  return (
    text(aa.PMRouteID) === text(ba.PMRouteID)
    && text(aa.PMPrefix) === text(ba.PMPrefix)
    && text(aa.PMSuffix) === text(ba.PMSuffix)
    && text(aa.AlignCode) === text(ba.AlignCode)
  );
}

function asResolution(feature: PostmileFeature, latitude: number, longitude: number, postmile: number, method: LocationMethod): ResolvedIncidentLocation | null {
  const attrs = feature.attributes ?? {};
  const districtNumber = finiteNumber(attrs.District);
  const county = text(attrs.County).toUpperCase();
  const route = normalizeRouteValue(attrs.Route as string | number | null | undefined);
  const lat = normalizeCoordinate(latitude);
  const lon = normalizeCoordinate(longitude);
  if (districtNumber == null || !county || !route || lat == null || lon == null) return null;
  return {
    latitude: lat,
    longitude: lon,
    district: String(Math.trunc(districtNumber)).padStart(2, "0"),
    county,
    route,
    post_mile: `${text(attrs.PMPrefix).toUpperCase()}${postmile.toFixed(2)}${text(attrs.PMSuffix).toUpperCase()}`,
    align_code: text(attrs.AlignCode) || null,
    method,
  };
}

/**
 * The point for a post mile: the exact reference point (both alignments
 * averaged), else a straight-line interpolation between the two reference
 * points around it on one alignment, else the nearest within 0.12 mi — or null.
 */
export function coordinatesFromRoadFeatures(features: PostmileFeature[], postmile: number): ResolvedIncidentLocation | null {
  const usable = features.filter(
    (feature) => finiteNumber(feature.attributes?.PM) != null && finiteNumber(feature.geometry?.x) != null && finiteNumber(feature.geometry?.y) != null,
  );
  if (usable.length === 0) return null;
  const pmOf = (feature: PostmileFeature) => finiteNumber(feature.attributes?.PM) as number;
  const xOf = (feature: PostmileFeature) => finiteNumber(feature.geometry?.x) as number;
  const yOf = (feature: PostmileFeature) => finiteNumber(feature.geometry?.y) as number;

  const exact = usable.filter((feature) => Math.abs(pmOf(feature) - postmile) <= 0.0005);
  if (exact.length > 0) {
    const lat = exact.reduce((sum, feature) => sum + yOf(feature), 0) / exact.length;
    const lon = exact.reduce((sum, feature) => sum + xOf(feature), 0) / exact.length;
    return asResolution(exact[0], lat, lon, postmile, "ONLINE_EXACT_POSTMILE");
  }

  let best: { a: PostmileFeature; b: PostmileFeature; gap: number } | null = null;
  for (let i = 0; i + 1 < usable.length; i += 1) {
    const a = usable[i];
    const b = usable[i + 1];
    if (!sameGroup(a, b)) continue;
    if (postmile < pmOf(a) || postmile > pmOf(b)) continue;
    const gap = pmOf(b) - pmOf(a);
    if (gap <= 0 || gap > 0.25) continue;
    if (!best || gap < best.gap) best = { a, b, gap };
  }
  if (best) {
    const t = (postmile - pmOf(best.a)) / best.gap;
    return asResolution(
      best.a,
      yOf(best.a) + (yOf(best.b) - yOf(best.a)) * t,
      xOf(best.a) + (xOf(best.b) - xOf(best.a)) * t,
      postmile,
      "ONLINE_INTERPOLATED_POSTMILE",
    );
  }

  const nearest = [...usable].sort((a, b) => Math.abs(pmOf(a) - postmile) - Math.abs(pmOf(b) - postmile))[0];
  if (Math.abs(pmOf(nearest) - postmile) > 0.12) return null;
  return asResolution(nearest, yOf(nearest), xOf(nearest), postmile, "ONLINE_NEAREST_POSTMILE");
}

// ---------------------------------------------------------------------------
// Words and links
// ---------------------------------------------------------------------------

export function locationMethodLabel(method: LocationMethod): string {
  switch (method) {
    case "ONLINE_COORDINATE_LOOKUP": return "Nearest Caltrans post mile to the point";
    case "ONLINE_EXACT_POSTMILE": return "Caltrans post mile marker";
    case "ONLINE_INTERPOLATED_POSTMILE": return "Between two Caltrans post mile markers";
    case "ONLINE_NEAREST_POSTMILE": return "Nearest Caltrans post mile marker";
  }
}

/** "D01 · HUM · 101 · PM 84.20" */
export function roadLocationLabel(location: Pick<ResolvedIncidentLocation, "district" | "county" | "route" | "post_mile">): string {
  return `D${location.district} · ${location.county} · ${location.route} · PM ${location.post_mile}`;
}

/**
 * The name the server gives a report: District-County-Route-PostMile and the
 * day it was first seen, "04-MRN-001-12.300 - 09/22/26". Reporters no longer
 * type a title. Null until the report is placed.
 */
export function incidentName(location: Pick<ResolvedIncidentLocation, "district" | "county" | "route" | "post_mile"> | null, firstObservedAt: string): string | null {
  if (!location) return null;
  const districtDigits = location.district.replace(/\D/g, "");
  const district = districtDigits ? districtDigits.padStart(2, "0") : location.district.trim() || "?";
  const county = location.county.trim().replace(/\s+County$/i, "").toUpperCase() || "?";
  const routeDigits = location.route.replace(/\D/g, "");
  const route = routeDigits ? routeDigits.slice(0, 3).padStart(3, "0") : location.route.trim() || "?";
  const postMileNumber = Number(location.post_mile);
  const postMile = location.post_mile.trim() && Number.isFinite(postMileNumber) ? postMileNumber.toFixed(3) : location.post_mile.trim() || "?";
  const base = `${district}-${county}-${route}-${postMile}`;
  const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(firstObservedAt.trim());
  return day ? `${base} - ${day[2]}/${day[3]}/${day[1].slice(2)}` : base;
}

/** Google Street View at a point, in a new tab — needs no key. */
export function streetViewUrl(latitude: number, longitude: number): string {
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${latitude},${longitude}`;
}

/** Google Street View embedded in the page — needs a Maps Embed API key. */
export function streetViewEmbedUrl(key: string, latitude: number, longitude: number): string {
  return `https://www.google.com/maps/embed/v1/streetview?key=${encodeURIComponent(key)}&location=${latitude},${longitude}&fov=90`;
}

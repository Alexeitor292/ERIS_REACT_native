const DEFAULT_POSTMILE_LAYER_URL =
  "https://caltrans-gis.dot.ca.gov/arcgis/rest/services/CHhighway/SHN_Postmiles_Tenth/FeatureServer/0";

const POSTMILE_LAYER_URL =
  process.env.EXPO_PUBLIC_CALTRANS_POSTMILE_LAYER_URL?.trim() || DEFAULT_POSTMILE_LAYER_URL;

type ArcgisEnrichment = {
  district?: string | null;
  county?: string | null;
  route?: string | null;
  post_mile?: string | null;
  source: {
    reverse_geocode?: string | null;
    postmile_layer?: string | null;
  };
};

type ArcgisFeature = {
  attributes?: Record<string, unknown>;
  geometry?: {
    paths?: number[][][];
    rings?: number[][][];
    x?: number;
    y?: number;
  };
};

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

function extractRoute(text?: string | null): string | null {
  if (!text) return null;
  const m =
    text.match(/\b(?:I|US|CA|SR)[-\s]?(\d{1,3})\b/i) || text.match(/\b(\d{1,3})\b/);
  return m?.[1] ?? null;
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function formatPostmile(value: unknown): string | null {
  return normalizePostMileValue(value as string | number | null | undefined);
}

function metersPerDegreeLat(): number {
  return 111_320;
}

function metersPerDegreeLon(latDeg: number): number {
  return 111_320 * Math.cos((latDeg * Math.PI) / 180);
}

function pointToSegmentDistanceMeters(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const latRef = (py + ay + by) / 3;
  const mx = metersPerDegreeLon(latRef);
  const my = metersPerDegreeLat();
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
  const cX = aX + t * abX;
  const cY = aY + t * abY;
  return Math.hypot(pX - cX, pY - cY);
}

function geometryDistanceMeters(feature: ArcgisFeature, lon: number, lat: number): number {
  const g = feature.geometry;
  if (!g) return Number.POSITIVE_INFINITY;
  if (typeof g.x === "number" && typeof g.y === "number") {
    return pointToSegmentDistanceMeters(lon, lat, g.x, g.y, g.x, g.y);
  }
  let best = Number.POSITIVE_INFINITY;
  const lines = g.paths ?? g.rings ?? [];
  for (const line of lines) {
    for (let i = 0; i + 1 < line.length; i += 1) {
      const [ax, ay] = line[i];
      const [bx, by] = line[i + 1];
      if (![ax, ay, bx, by].every((v) => Number.isFinite(v))) continue;
      const d = pointToSegmentDistanceMeters(lon, lat, ax, ay, bx, by);
      if (d < best) best = d;
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

async function fetchJsonWithTimeout(url: string, timeoutMs = 6500): Promise<any | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function reverseGeocodeArcgis(lat: number, lon: number) {
  const params = new URLSearchParams({
    f: "pjson",
    location: `${lon},${lat}`,
  });
  const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?${params.toString()}`;
  const data = await fetchJsonWithTimeout(url);
  const address = data?.address || {};
  return {
    county: normalizeCounty(address?.Subregion || address?.District),
    route: extractRoute(address?.ShortLabel || address?.LongLabel || address?.Match_addr),
    source_reverse: data?.address ? "arcgis_world_geocoder" : null,
  };
}

async function queryPostmileLayer(lat: number, lon: number) {
  const params = new URLSearchParams({
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
  });
  const url = `${POSTMILE_LAYER_URL.replace(/\/$/, "")}/query?${params.toString()}`;
  const data = await fetchJsonWithTimeout(url);
  const features: ArcgisFeature[] = Array.isArray(data?.features) ? data.features : [];
  if (features.length === 0) return {};
  const best = [...features].sort(
    (a, b) => geometryDistanceMeters(a, lon, lat) - geometryDistanceMeters(b, lon, lat)
  )[0];
  const attrs = best?.attributes;
  if (!attrs || typeof attrs !== "object") return {};
  return {
    district: toTwoDigitDistrict(getAttr(attrs, "District", "DISTRICT", "district")),
    county: normalizeCounty(
      getAttr(attrs, "County", "COUNTY", "county") != null
        ? String(getAttr(attrs, "County", "COUNTY", "county"))
        : null
    ),
    route:
      getAttr(attrs, "Route", "ROUTE", "route") != null
        ? String(getAttr(attrs, "Route", "ROUTE", "route")).trim() || null
        : null,
    post_mile: formatPostmile(getAttr(attrs, "PM", "POSTMILE", "postmile", "ODOMETER")),
    source_postmile: "caltrans_public_postmile_layer",
  };
}

export async function enrichPointFromArcgisClient(
  lat: number,
  lon: number
): Promise<ArcgisEnrichment> {
  const [reverse, postmile] = await Promise.all([
    reverseGeocodeArcgis(lat, lon),
    queryPostmileLayer(lat, lon),
  ]);

  return {
    district: postmile.district ?? null,
    county: postmile.county ?? reverse.county ?? null,
    route: postmile.route ?? reverse.route ?? null,
    post_mile: postmile.post_mile ?? null,
    source: {
      reverse_geocode: reverse.source_reverse ?? null,
      postmile_layer: postmile.source_postmile ?? null,
    },
  };
}
import { normalizePostMileValue } from "./precision";

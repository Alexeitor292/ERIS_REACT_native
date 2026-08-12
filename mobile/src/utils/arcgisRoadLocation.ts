import { normalizeRouteValue } from "./precision";

const DEFAULT_POSTMILE_LAYER_URL =
  "https://caltrans-gis.dot.ca.gov/arcgis/rest/services/CHhighway/SHN_Postmiles_Tenth/FeatureServer/0";

const POSTMILE_LAYER_URL =
  process.env.EXPO_PUBLIC_CALTRANS_POSTMILE_LAYER_URL?.trim() || DEFAULT_POSTMILE_LAYER_URL;

type Feature = {
  attributes?: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
};

export type OnlineRoadCoordinateResolution = {
  latitude: number;
  longitude: number;
  district: string;
  county: string;
  route: string;
  post_mile: string;
  align_code: string | null;
  method: "ONLINE_EXACT_POSTMILE" | "ONLINE_INTERPOLATED_POSTMILE" | "ONLINE_NEAREST_POSTMILE";
  source: "CALTRANS_SHN_POSTMILES_TENTH_ONLINE";
};

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

function sameGroup(a: Feature, b: Feature): boolean {
  const aa = a.attributes ?? {};
  const ba = b.attributes ?? {};
  return (
    text(aa.PMRouteID) === text(ba.PMRouteID) &&
    text(aa.PMPrefix) === text(ba.PMPrefix) &&
    text(aa.PMSuffix) === text(ba.PMSuffix) &&
    text(aa.AlignCode) === text(ba.AlignCode)
  );
}

function asResolution(
  feature: Feature,
  latitude: number,
  longitude: number,
  postmile: number,
  method: OnlineRoadCoordinateResolution["method"],
): OnlineRoadCoordinateResolution | null {
  const attrs = feature.attributes ?? {};
  const districtNumber = finiteNumber(attrs.District);
  const county = text(attrs.County).toUpperCase();
  const routeValue = normalizeRouteValue(attrs.Route as any);
  if (districtNumber == null || !county || !routeValue) return null;
  const prefix = text(attrs.PMPrefix).toUpperCase();
  const suffix = text(attrs.PMSuffix).toUpperCase();
  return {
    latitude,
    longitude,
    district: String(Math.trunc(districtNumber)).padStart(2, "0"),
    county,
    route: routeValue,
    post_mile: `${prefix}${postmile.toFixed(2)}${suffix}`,
    align_code: text(attrs.AlignCode) || null,
    method,
    source: "CALTRANS_SHN_POSTMILES_TENTH_ONLINE",
  };
}

export async function resolveRoadLocationFromArcgisClient(params: {
  district: string;
  county: string;
  route: string;
  postmile: number;
}): Promise<OnlineRoadCoordinateResolution | null> {
  const routeNumber = Number(String(params.route).replace(/\D/g, ""));
  const districtNumber = Number(String(params.district).replace(/\D/g, ""));
  const county = params.county.trim().toUpperCase();
  if (!Number.isFinite(routeNumber) || !Number.isFinite(districtNumber) || !county) return null;

  const minPm = params.postmile - 0.25;
  const maxPm = params.postmile + 0.25;
  const where = [
    `County='${escSql(county)}'`,
    `Route=${Math.trunc(routeNumber)}`,
    `District=${Math.trunc(districtNumber)}`,
    `PM>=${minPm}`,
    `PM<=${maxPm}`,
  ].join(" AND ");

  const query = new URLSearchParams({
    f: "json",
    where,
    outFields: "District,County,Route,PMPrefix,PM,PMSuffix,PMRouteID,AlignCode",
    returnGeometry: "true",
    outSR: "4326",
    orderByFields: "PM ASC",
    resultRecordCount: "50",
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6500);
  try {
    const response = await fetch(
      `${POSTMILE_LAYER_URL.replace(/\/$/, "")}/query?${query.toString()}`,
      { signal: controller.signal },
    );
    if (!response.ok) return null;
    const payload = await response.json();
    const features: Feature[] = Array.isArray(payload?.features) ? payload.features : [];
    const usable = features.filter(
      (feature) =>
        finiteNumber(feature.attributes?.PM) != null &&
        finiteNumber(feature.geometry?.x) != null &&
        finiteNumber(feature.geometry?.y) != null,
    );
    if (usable.length === 0) return null;

    const exact = usable.filter(
      (feature) => Math.abs((finiteNumber(feature.attributes?.PM) as number) - params.postmile) <= 0.0005,
    );
    if (exact.length > 0) {
      const lat = exact.reduce((sum, feature) => sum + (finiteNumber(feature.geometry?.y) as number), 0) / exact.length;
      const lon = exact.reduce((sum, feature) => sum + (finiteNumber(feature.geometry?.x) as number), 0) / exact.length;
      return asResolution(exact[0], lat, lon, params.postmile, "ONLINE_EXACT_POSTMILE");
    }

    let best: { a: Feature; b: Feature; gap: number } | null = null;
    for (let i = 0; i + 1 < usable.length; i += 1) {
      const a = usable[i];
      const b = usable[i + 1];
      if (!sameGroup(a, b)) continue;
      const aPm = finiteNumber(a.attributes?.PM) as number;
      const bPm = finiteNumber(b.attributes?.PM) as number;
      if (params.postmile < aPm || params.postmile > bPm) continue;
      const gap = bPm - aPm;
      if (gap <= 0 || gap > 0.25) continue;
      if (!best || gap < best.gap) best = { a, b, gap };
    }
    if (best) {
      const aPm = finiteNumber(best.a.attributes?.PM) as number;
      const t = (params.postmile - aPm) / best.gap;
      const aLat = finiteNumber(best.a.geometry?.y) as number;
      const aLon = finiteNumber(best.a.geometry?.x) as number;
      const bLat = finiteNumber(best.b.geometry?.y) as number;
      const bLon = finiteNumber(best.b.geometry?.x) as number;
      return asResolution(
        best.a,
        aLat + (bLat - aLat) * t,
        aLon + (bLon - aLon) * t,
        params.postmile,
        "ONLINE_INTERPOLATED_POSTMILE",
      );
    }

    const nearest = [...usable].sort(
      (a, b) =>
        Math.abs((finiteNumber(a.attributes?.PM) as number) - params.postmile) -
        Math.abs((finiteNumber(b.attributes?.PM) as number) - params.postmile),
    )[0];
    const nearestPm = finiteNumber(nearest.attributes?.PM) as number;
    if (Math.abs(nearestPm - params.postmile) > 0.12) return null;
    return asResolution(
      nearest,
      finiteNumber(nearest.geometry?.y) as number,
      finiteNumber(nearest.geometry?.x) as number,
      params.postmile,
      "ONLINE_NEAREST_POSTMILE",
    );
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

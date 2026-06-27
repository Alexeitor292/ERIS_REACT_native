// Pure, ArcGIS-free logic for the interactive 3D terrain scene.
//
// Kept deliberately free of any `@arcgis/core` import so it can be unit-tested
// without a WebGL/ArcGIS runtime (the SceneView itself cannot render in a test
// environment). InteractiveTerrainScene.tsx consumes these helpers and feeds the
// results to the live SceneView.

export type IncidentLocation = {
  latitude: number | null | undefined;
  longitude: number | null | undefined;
};

export type SceneBasemapMode = "satellite" | "topographic";

// Esri default services (no API key required for development, same as the
// existing 2D maps in this app). "hybrid" = World Imagery + reference labels.
export const SCENE_BASEMAP_ID: Record<SceneBasemapMode, string> = {
  satellite: "hybrid",
  topographic: "topo-vector",
};

export function basemapIdFor(mode: SceneBasemapMode): string {
  return SCENE_BASEMAP_ID[mode];
}

// Oblique framing constants: a slightly tilted view (NOT directly overhead, NOT
// flat to the horizon) so terrain relief reads clearly, framed close enough to
// see the incident and nearby slope/road context.
export const DEFAULT_SCENE_TILT = 65; // degrees from nadir-up; 0 = straight down
export const DEFAULT_SCENE_HEADING = 0; // looking toward true north
export const DEFAULT_SCENE_ZOOM = 16; // close, terrain-readable

/**
 * A coordinate is a usable incident location only when both lat/lon are finite,
 * within valid ranges, and not the null-island (0,0) placeholder.
 */
export function isValidIncidentLocation(
  loc: IncidentLocation | null | undefined,
): loc is { latitude: number; longitude: number } {
  if (!loc) return false;
  const { latitude, longitude } = loc;
  return (
    typeof latitude === "number" &&
    typeof longitude === "number" &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180 &&
    !(latitude === 0 && longitude === 0)
  );
}

/**
 * Stable string key for the scene's camera anchor, derived purely from the
 * incident coordinates. Two DISTINCT location objects with equal lat/lon yield
 * the SAME key — so the SceneView is recreated only when the coordinates
 * actually change, never on a parent re-render that merely passes a new object
 * instance. Returns null for invalid coordinates.
 */
export function sceneAnchorKey(loc: IncidentLocation | null | undefined): string | null {
  if (!isValidIncidentLocation(loc)) return null;
  return `${loc.latitude},${loc.longitude}`;
}

export type InitialViewpoint = {
  target: [number, number]; // [lon, lat]
  tilt: number;
  heading: number;
  zoom: number;
};

/**
 * Initial camera framing centered on the incident. Returns null when the
 * incident has no usable coordinates, so the caller renders a safe empty state
 * instead of flying the camera to a bogus place.
 */
export function initialViewpointFor(
  loc: IncidentLocation | null | undefined,
): InitialViewpoint | null {
  if (!isValidIncidentLocation(loc)) return null;
  return {
    target: [loc.longitude, loc.latitude],
    tilt: DEFAULT_SCENE_TILT,
    heading: DEFAULT_SCENE_HEADING,
    zoom: DEFAULT_SCENE_ZOOM,
  };
}

export type TerrainGridLike =
  | {
      road_bearing_deg_used?: number | null;
      grid?: { points?: Array<{ lat: number; lon: number }> } | null;
    }
  | null
  | undefined;

export type OverlayAvailability = {
  incidentMarker: boolean;
  roadBearing: boolean;
  terrainExtent: boolean;
  uploadedGeometry: boolean;
};

/**
 * Decide which overlays we are ALLOWED to draw from real ERIS data. Anything not
 * backed by real data stays false so the scene never invents geometry:
 *  - roadBearing only when a bearing was actually resolved (postmile geometry),
 *  - terrainExtent only when the USGS grid has sampled points,
 *  - uploadedGeometry only when geometry_json is present.
 */
export function overlayAvailability(args: {
  location: IncidentLocation | null | undefined;
  terrain: TerrainGridLike;
  geometryJson: unknown;
}): OverlayAvailability {
  const incidentMarker = isValidIncidentLocation(args.location);
  const bearing = args.terrain?.road_bearing_deg_used;
  const roadBearing =
    incidentMarker && typeof bearing === "number" && Number.isFinite(bearing);
  const pts = args.terrain?.grid?.points;
  const terrainExtent = Array.isArray(pts) && pts.length > 0;
  // Only "available" when the supplied object actually yields a renderable
  // geometry — a non-empty / malformed object must not enable the overlay.
  const uploadedGeometry = geoJsonRenderable(args.geometryJson);
  return { incidentMarker, roadBearing, terrainExtent, uploadedGeometry };
}

// ---- GeoJSON --------------------------------------------------------------

export type GeoJsonGeometry = { type: string; coordinates: unknown };

const PRIMITIVE_GEOMETRY_TYPES = new Set([
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
]);

function isValidPosition(p: unknown): p is number[] {
  return (
    Array.isArray(p) &&
    p.length >= 2 &&
    typeof p[0] === "number" &&
    typeof p[1] === "number" &&
    Number.isFinite(p[0]) &&
    Number.isFinite(p[1])
  );
}

function validPositions(arr: unknown, min: number): number[][] | null {
  if (!Array.isArray(arr)) return null;
  const out = arr.filter(isValidPosition) as number[][];
  return out.length >= min ? out : null;
}

/**
 * Validate a single GeoJSON geometry primitive, returning a normalized
 * geometry (with only valid coordinates) or null when nothing is renderable.
 */
export function validatePrimitiveGeometry(
  type: string,
  coordinates: unknown,
): GeoJsonGeometry | null {
  switch (type) {
    case "Point":
      return isValidPosition(coordinates) ? { type, coordinates } : null;
    case "MultiPoint": {
      const pts = validPositions(coordinates, 1);
      return pts ? { type, coordinates: pts } : null;
    }
    case "LineString": {
      const line = validPositions(coordinates, 2);
      return line ? { type, coordinates: line } : null;
    }
    case "MultiLineString": {
      if (!Array.isArray(coordinates)) return null;
      const lines = coordinates
        .map((l) => validPositions(l, 2))
        .filter((l): l is number[][] => l !== null);
      return lines.length ? { type, coordinates: lines } : null;
    }
    case "Polygon": {
      if (!Array.isArray(coordinates)) return null;
      const rings = coordinates
        .map((r) => validPositions(r, 3))
        .filter((r): r is number[][] => r !== null);
      return rings.length ? { type, coordinates: rings } : null;
    }
    case "MultiPolygon": {
      if (!Array.isArray(coordinates)) return null;
      const polys = coordinates
        .map((poly) =>
          Array.isArray(poly)
            ? poly.map((r) => validPositions(r, 3)).filter((r): r is number[][] => r !== null)
            : [],
        )
        .filter((rings) => rings.length > 0);
      return polys.length ? { type, coordinates: polys } : null;
    }
    default:
      return null;
  }
}

/**
 * Flatten any GeoJSON object (raw Geometry, Feature, FeatureCollection,
 * GeometryCollection, and all primitive geometry types) into a list of
 * validated, renderable primitive geometries. Returns [] when nothing can be
 * rendered, so callers never enable an overlay they cannot actually draw.
 */
export function extractRenderableGeometries(obj: unknown): GeoJsonGeometry[] {
  const out: GeoJsonGeometry[] = [];
  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 8) return;
    const t = String((node as { type?: unknown }).type ?? "");
    if (t === "FeatureCollection") {
      const features = (node as { features?: unknown }).features;
      if (Array.isArray(features)) features.forEach((f) => visit(f, depth + 1));
      return;
    }
    if (t === "Feature") {
      visit((node as { geometry?: unknown }).geometry, depth + 1);
      return;
    }
    if (t === "GeometryCollection") {
      const geoms = (node as { geometries?: unknown }).geometries;
      if (Array.isArray(geoms)) geoms.forEach((g) => visit(g, depth + 1));
      return;
    }
    if (PRIMITIVE_GEOMETRY_TYPES.has(t)) {
      const v = validatePrimitiveGeometry(t, (node as { coordinates?: unknown }).coordinates);
      if (v) out.push(v);
    }
  };
  visit(obj, 0);
  return out;
}

/** True when the object contains at least one renderable GeoJSON geometry. */
export function geoJsonRenderable(obj: unknown): boolean {
  return extractRenderableGeometries(obj).length > 0;
}

const M_PER_DEG_LAT = 111_320;

/**
 * Two endpoints of a short line through (lat,lon) along `bearingDeg` (degrees
 * clockwise from north). This is a *bearing-direction indicator* derived from the
 * real postmile bearing — not an invented road centerline ribbon. Local
 * equirectangular approximation is fine for a few-hundred-metre segment.
 */
export function bearingLineEndpoints(
  lat: number,
  lon: number,
  bearingDeg: number,
  halfLenM = 120,
): [[number, number], [number, number]] {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (Math.cos(rad) * halfLenM) / M_PER_DEG_LAT;
  const cosLat = Math.cos((lat * Math.PI) / 180) || 1e-6;
  const dLon = (Math.sin(rad) * halfLenM) / (M_PER_DEG_LAT * cosLat);
  return [
    [lon - dLon, lat - dLat],
    [lon + dLon, lat + dLat],
  ];
}

/**
 * Bounding ring (closed) of the real sampled USGS grid points, for the
 * "terrain sample extent" overlay. Returns null when there are no points.
 */
export function gridBoundingRing(
  points: Array<{ lat: number; lon: number }> | null | undefined,
): number[][] | null {
  if (!Array.isArray(points) || points.length === 0) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
  }
  if (!Number.isFinite(minLat) || !Number.isFinite(minLon)) return null;
  return [
    [minLon, minLat],
    [maxLon, minLat],
    [maxLon, maxLat],
    [minLon, maxLat],
    [minLon, minLat],
  ];
}

export type SceneLoadFailure = "elevation" | "imagery" | "both" | "access" | "unknown";

/**
 * Useful, human-readable failure text when the streaming terrain/imagery cannot
 * initialize. Never blames the user; points at the upstream service and offers
 * the diagnostic fallback.
 */
export function terrainSceneErrorMessage(kind: SceneLoadFailure): string {
  switch (kind) {
    case "elevation":
      return "The 3D elevation service could not be reached, so terrain relief is unavailable. Imagery may still load flat. Check your connection or try again; the USGS sampled-relief card below remains available.";
    case "imagery":
      return "Satellite imagery could not be loaded. Switch to the topographic basemap, or try again shortly.";
    case "both":
      return "The 3D map could not load terrain or imagery (the mapping service may be unreachable). Try again, or use the USGS sampled-relief diagnostic card below.";
    case "access":
      return "The mapping service rejected access. The ArcGIS API key is missing, invalid, or not authorized for this domain. An administrator must set a browser-safe VITE_ARCGIS_API_KEY restricted to this site. The USGS sampled-relief diagnostic card below remains available.";
    default:
      return "The interactive 3D map failed to initialize. Try again, or use the USGS sampled-relief diagnostic card below.";
  }
}

/**
 * Heuristic: does an ArcGIS layer/service load error indicate an access/auth
 * problem (missing/invalid/unauthorized API key) rather than a transient
 * network failure? Pure so it can be unit-tested with plain error-like objects.
 */
export function isArcgisAccessError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; message?: unknown; details?: unknown };
  const code = (e.details as { httpStatus?: unknown } | undefined)?.httpStatus;
  if (code === 401 || code === 403 || code === 498 || code === 499) return true;
  const text = `${String(e.name ?? "")} ${String(e.message ?? "")}`.toLowerCase();
  return (
    text.includes("token") ||
    text.includes("api key") ||
    text.includes("apikey") ||
    text.includes("not authorized") ||
    text.includes("unauthorized") ||
    text.includes("forbidden") ||
    text.includes("license")
  );
}

export type LayerLike = { loadStatus?: string | null; loadError?: unknown };
export type ServiceHealth = { failed: boolean; access: boolean };

/**
 * Evaluate a set of ArcGIS layers (basemap imagery OR ground/elevation) for REAL
 * load failures via each layer's loadStatus/loadError — never by counting how
 * many layers exist. An empty set is treated as "not failed".
 */
export function evaluateLayerHealth(layers: LayerLike[] | null | undefined): ServiceHealth {
  if (!Array.isArray(layers) || layers.length === 0) return { failed: false, access: false };
  let failed = false;
  let access = false;
  for (const l of layers) {
    if (l && l.loadStatus === "failed") {
      failed = true;
      if (isArcgisAccessError(l.loadError)) access = true;
    }
  }
  return { failed, access };
}

export type SceneHealth = {
  blocking: SceneLoadFailure | null;
  warning: { kind: "imagery" | "elevation" | "access" } | null;
};

/**
 * Combine imagery + elevation health into a blocking error (both failed) or a
 * non-blocking warning (only one failed) so the mesh stays visible when it can.
 */
export function deriveSceneHealth(imagery: ServiceHealth, elevation: ServiceHealth): SceneHealth {
  const anyAccess = imagery.access || elevation.access;
  if (imagery.failed && elevation.failed) {
    return { blocking: anyAccess ? "access" : "both", warning: null };
  }
  if (imagery.failed) {
    return { blocking: null, warning: { kind: imagery.access ? "access" : "imagery" } };
  }
  if (elevation.failed) {
    return { blocking: null, warning: { kind: elevation.access ? "access" : "elevation" } };
  }
  return { blocking: null, warning: null };
}

/**
 * Layout class for the scene container.
 *  - not fullscreen: inline card.
 *  - native fullscreen (Fullscreen API): the browser already sizes the element
 *    to the screen, so we only darken it.
 *  - CSS fallback (no Fullscreen API): pin to the viewport ourselves.
 * (Pure helper so the full-screen control is testable without a DOM.)
 */
export function sceneContainerClass(fullscreen: boolean, nativeFullscreen = false): string {
  if (!fullscreen) return "relative w-full overflow-hidden rounded-lg border border-[var(--line)]";
  if (nativeFullscreen) return "relative w-full bg-black";
  return "fixed inset-0 z-50 bg-black";
}

export function nextFullscreen(prev: boolean): boolean {
  return !prev;
}

type FullscreenDocLike = {
  fullscreenEnabled?: boolean;
  fullscreenElement?: Element | null;
};

/** True when the browser exposes a usable Fullscreen API (optionally for `el`). */
export function supportsFullscreenApi(
  doc: FullscreenDocLike | null | undefined,
  el?: { requestFullscreen?: unknown } | null,
): boolean {
  if (!doc || !doc.fullscreenEnabled) return false;
  if (el && typeof el.requestFullscreen !== "function") return false;
  return true;
}

/** True when `el` is the document's current fullscreen element. */
export function isElementFullscreen(
  doc: FullscreenDocLike | null | undefined,
  el: Element | null | undefined,
): boolean {
  return !!doc && !!el && doc.fullscreenElement === el;
}

/**
 * Short incident summary line for the overlay panel; safe with partial data.
 */
export function incidentSummaryLine(args: {
  route?: string | null;
  postMile?: string | null;
  county?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}): string {
  const parts: string[] = [];
  if (args.route) parts.push(`Rte ${args.route}`);
  if (args.postMile) parts.push(`PM ${args.postMile}`);
  if (args.county) parts.push(args.county);
  if (
    typeof args.latitude === "number" &&
    typeof args.longitude === "number" &&
    Number.isFinite(args.latitude) &&
    Number.isFinite(args.longitude)
  ) {
    parts.push(`${args.latitude.toFixed(5)}, ${args.longitude.toFixed(5)}`);
  }
  return parts.length ? parts.join("  ·  ") : "Location unavailable";
}

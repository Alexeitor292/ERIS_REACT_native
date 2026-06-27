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
  const uploadedGeometry =
    !!args.geometryJson &&
    typeof args.geometryJson === "object" &&
    Object.keys(args.geometryJson as Record<string, unknown>).length > 0;
  return { incidentMarker, roadBearing, terrainExtent, uploadedGeometry };
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

export type SceneLoadFailure = "elevation" | "imagery" | "both" | "unknown";

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
    default:
      return "The interactive 3D map failed to initialize. Try again, or use the USGS sampled-relief diagnostic card below.";
  }
}

/**
 * Layout class for the scene container; full-screen pins to the viewport.
 * (Pure helper so the full-screen control is testable without a DOM.)
 */
export function sceneContainerClass(fullscreen: boolean): string {
  return fullscreen
    ? "fixed inset-0 z-50 bg-black"
    : "relative w-full overflow-hidden rounded-lg border border-[var(--line)]";
}

export function nextFullscreen(prev: boolean): boolean {
  return !prev;
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

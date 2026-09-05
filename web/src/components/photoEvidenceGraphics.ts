/**
 * Pure geometry/color helpers for drawing field-photo evidence on the submission map.
 * Kept free of ArcGIS imports so they can be unit tested with node --test.
 */

export const PHOTO_HEADING_WEDGE_RADIUS_M = 45;
export const PHOTO_HEADING_WEDGE_HALF_ANGLE_DEG = 16;
export const PHOTO_HEADING_WEDGE_FILL_ALPHA = 0.28;

const METERS_PER_DEGREE_LAT = 111_320;

export type RgbColor = [number, number, number];

/**
 * Sector ring (WGS84 lon/lat pairs) opening from the photo location toward the camera
 * heading. Small distances, so an equirectangular offset is accurate enough.
 */
export function headingWedgeRing(
  latitude: number,
  longitude: number,
  headingDeg: number,
  radiusM = PHOTO_HEADING_WEDGE_RADIUS_M,
  halfAngleDeg = PHOTO_HEADING_WEDGE_HALF_ANGLE_DEG,
  steps = 12,
): number[][] {
  const metersPerDegreeLon = METERS_PER_DEGREE_LAT * Math.max(0.05, Math.cos((latitude * Math.PI) / 180));
  const ring: number[][] = [[longitude, latitude]];
  for (let index = 0; index <= steps; index += 1) {
    const bearing = headingDeg - halfAngleDeg + (2 * halfAngleDeg * index) / steps;
    const radians = (bearing * Math.PI) / 180;
    const east = radiusM * Math.sin(radians);
    const north = radiusM * Math.cos(radians);
    ring.push([longitude + east / metersPerDegreeLon, latitude + north / METERS_PER_DEGREE_LAT]);
  }
  ring.push([longitude, latitude]);
  return ring;
}

/** Parse `#rgb`, `#rrggbb`, `rgb(r, g, b)` or `rgba(...)`; returns null when unrecognized. */
export function parseCssColor(value: string | null | undefined): RgbColor | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const expanded = hex.length === 3 ? hex.split("").map((char) => char + char).join("") : hex;
    return [parseInt(expanded.slice(0, 2), 16), parseInt(expanded.slice(2, 4), 16), parseInt(expanded.slice(4, 6), 16)];
  }
  const rgb = raw.match(/^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/i);
  if (rgb) {
    const channels = [rgb[1], rgb[2], rgb[3]].map((channel) => Math.round(Number(channel)));
    if (channels.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 255)) return channels as RgbColor;
  }
  return null;
}

export function themeColor(variable: string, fallback: RgbColor): RgbColor {
  if (typeof window === "undefined" || typeof document === "undefined") return fallback;
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(variable);
    return parseCssColor(value) ?? fallback;
  } catch {
    return fallback;
  }
}

export function withAlpha(color: RgbColor, alpha: number): [number, number, number, number] {
  return [color[0], color[1], color[2], alpha];
}

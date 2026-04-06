export const POST_MILE_DECIMALS = 2;
export const COORDINATE_DECIMALS = 6;

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function normalizePostMileValue(value?: string | number | null): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const num = Number(raw);
  if (!Number.isFinite(num)) return raw;
  return roundTo(num, POST_MILE_DECIMALS).toFixed(POST_MILE_DECIMALS);
}

export function normalizePostMileInput(value?: string | number | null): string {
  return normalizePostMileValue(value) ?? "";
}

export function normalizeRouteValue(value?: string | number | null): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return raw;
  return digits.slice(0, 3).padStart(3, "0");
}

export function normalizeRouteInput(value?: string | number | null): string {
  return normalizeRouteValue(value) ?? "";
}

export function normalizeCoordinateValue(value?: string | number | null): number | null {
  if (value == null || value === "") return null;
  const num = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(num)) return null;
  return roundTo(num, COORDINATE_DECIMALS);
}

export function formatCoordinate(value?: string | number | null): string {
  const normalized = normalizeCoordinateValue(value);
  return normalized == null ? "" : normalized.toFixed(COORDINATE_DECIMALS);
}

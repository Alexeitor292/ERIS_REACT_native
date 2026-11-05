/**
 * Pavement/ground cracks as their own records (backend routes/cracks.py).
 *
 * GISA-001 asks to "map cracks": each crack's location, length, width,
 * horizontal and vertical displacement, depth and direction. Every crack is a
 * separate record with these same fields, its own photo and the labels drawn
 * on that photo. This model is pure: no React, no network.
 */

export type CrackMeasure = "length_ft" | "width_in" | "horizontal_disp_in" | "vertical_disp_in" | "depth_in";
export type CrackOrientation = "LONGITUDINAL" | "TRANSVERSE" | "DIAGONAL" | "ARCUATE" | "OTHER";
export type CrackLocationSource = "PHOTO" | "MAP" | "MANUAL";

/** A shape drawn over the crack's photo; points are fractions (0..1) of the photo, origin top left. */
export type CrackShape =
  | { type: "path" | "arrow"; points: [number, number][]; measure?: CrackMeasure; color?: string }
  | { type: "label"; at: [number, number]; text?: string | null; measure?: CrackMeasure; color?: string };

export type Crack = {
  id: number;
  submission_id: number;
  client_uuid: string;
  sort_order: number;
  label: string | null;
  latitude: number | null;
  longitude: number | null;
  location_source: CrackLocationSource | null;
  geometry_json: unknown;
  trend_deg: number | null;
  orientation: CrackOrientation | null;
  length_ft: number | null;
  width_in: number | null;
  horizontal_disp_in: number | null;
  vertical_disp_in: number | null;
  depth_in: number | null;
  notes: string | null;
  photo_attachment_id: number | null;
  annotations_json: { version: number; shapes: CrackShape[] } | null;
  revision: number;
  created_by_name?: string | null;
};

export const CRACK_MEASURES: ReadonlyArray<{ key: CrackMeasure; label: string; unit: "ft" | "in"; max: number; step: number }> = [
  { key: "length_ft", label: "Length", unit: "ft", max: 500, step: 0.5 },
  { key: "width_in", label: "Width", unit: "in", max: 24, step: 0.25 },
  { key: "horizontal_disp_in", label: "Horizontal displacement", unit: "in", max: 24, step: 0.25 },
  { key: "vertical_disp_in", label: "Vertical displacement", unit: "in", max: 24, step: 0.25 },
  { key: "depth_in", label: "Depth", unit: "in", max: 48, step: 0.5 },
];

export const CRACK_ORIENTATIONS: ReadonlyArray<{ value: CrackOrientation; label: string }> = [
  { value: "LONGITUDINAL", label: "Longitudinal" },
  { value: "TRANSVERSE", label: "Transverse" },
  { value: "DIAGONAL", label: "Diagonal" },
  { value: "ARCUATE", label: "Arcuate" },
  { value: "OTHER", label: "Other" },
];

/** What the editor holds for one crack: every value as typed. */
export type CrackDraft = {
  label: string;
  latitude: string;
  longitude: string;
  trend_deg: string;
  orientation: CrackOrientation | "";
  notes: string;
  photo_attachment_id: number | null;
} & Record<CrackMeasure, string>;

const text = (value: number | null | undefined) => (value == null ? "" : String(value));

export function draftOf(crack: Crack): CrackDraft {
  return {
    label: crack.label ?? "",
    latitude: text(crack.latitude),
    longitude: text(crack.longitude),
    trend_deg: text(crack.trend_deg),
    orientation: crack.orientation ?? "",
    notes: crack.notes ?? "",
    photo_attachment_id: crack.photo_attachment_id,
    length_ft: text(crack.length_ft),
    width_in: text(crack.width_in),
    horizontal_disp_in: text(crack.horizontal_disp_in),
    vertical_disp_in: text(crack.vertical_disp_in),
    depth_in: text(crack.depth_in),
  };
}

function numberOrNull(value: string, name: string, min: number, max: number, below = false): number | null {
  const raw = value.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || (below ? parsed >= max : parsed > max)) {
    throw new Error(`${name} must be a number from ${min} to ${below ? `less than ${max}` : max}.`);
  }
  return parsed;
}

/**
 * The PATCH body for what changed between the saved crack and the draft, or
 * an error naming the first value that cannot be sent. Empty when nothing changed.
 */
export function changesOf(crack: Crack, draft: CrackDraft): { changes: Record<string, unknown> } | { error: string } {
  const changes: Record<string, unknown> = {};
  try {
    const label = draft.label.trim() || null;
    if (label !== (crack.label ?? null)) changes.label = label;
    const notes = draft.notes.trim() || null;
    if (notes !== (crack.notes ?? null)) changes.notes = notes;
    for (const measure of CRACK_MEASURES) {
      const value = numberOrNull(draft[measure.key], measure.label, 0, 100_000);
      if (value !== crack[measure.key]) changes[measure.key] = value;
    }
    const trend = numberOrNull(draft.trend_deg, "Direction", 0, 360, true);
    if (trend !== crack.trend_deg) changes.trend_deg = trend;
    const orientation = draft.orientation || null;
    if (orientation !== crack.orientation) changes.orientation = orientation;
    const latitude = numberOrNull(draft.latitude, "Latitude", -90, 90);
    const longitude = numberOrNull(draft.longitude, "Longitude", -180, 180);
    if ((latitude == null) !== (longitude == null)) throw new Error("Enter both latitude and longitude, or neither.");
    if (latitude !== crack.latitude || longitude !== crack.longitude) {
      changes.latitude = latitude;
      changes.longitude = longitude;
      changes.location_source = latitude == null ? null : "MANUAL";
    }
    if (draft.photo_attachment_id !== crack.photo_attachment_id) changes.photo_attachment_id = draft.photo_attachment_id;
  } catch (error) {
    return { error: (error as Error).message };
  }
  return { changes };
}

/** "Crack 2", or its label. */
export function crackTitle(crack: Pick<Crack, "label">, index: number): string {
  return crack.label?.trim() || `Crack ${index + 1}`;
}

const trim = (value: number) => (Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2))));

/** "12.5 ft" or "0.75 in" for one measure, or null when it is not set. */
export function measureText(crack: Pick<Crack, CrackMeasure>, key: CrackMeasure): string | null {
  const value = crack[key];
  const measure = CRACK_MEASURES.find((m) => m.key === key)!;
  return value == null ? null : `${trim(value)} ${measure.unit}`;
}

const POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE"];

/** "035° (NE–SW)": a crack line's direction, which runs both ways. */
export function trendText(degrees: number | null): string | null {
  if (degrees == null || !Number.isFinite(degrees)) return null;
  const normalized = ((degrees % 180) + 180) % 180;
  const index = Math.round(normalized / 22.5) % 8;
  const opposite = ["S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][index];
  return `${String(Math.round(normalized) % 180).padStart(3, "0")}° (${POINTS[index]}–${opposite})`;
}

/** One line under a crack's title: what is known about it. */
export function crackSummary(crack: Crack): string {
  const parts = [
    measureText(crack, "length_ft") && `${measureText(crack, "length_ft")} long`,
    measureText(crack, "width_in") && `${measureText(crack, "width_in")} wide`,
    measureText(crack, "horizontal_disp_in") && `${measureText(crack, "horizontal_disp_in")} horizontal`,
    measureText(crack, "vertical_disp_in") && `${measureText(crack, "vertical_disp_in")} vertical`,
    measureText(crack, "depth_in") && `${measureText(crack, "depth_in")} deep`,
    trendText(crack.trend_deg) && `trends ${trendText(crack.trend_deg)}`,
    crack.orientation && CRACK_ORIENTATIONS.find((o) => o.value === crack.orientation)?.label.toLowerCase(),
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No measurements yet";
}

/** The words a label shape shows: its own text, else the measure it names with today's value. */
export function shapeText(shape: CrackShape, crack: Pick<Crack, CrackMeasure>): string | null {
  if (shape.type !== "label" && !shape.measure) return null;
  const own = shape.type === "label" ? shape.text?.trim() : "";
  if (own) return own;
  if (!shape.measure) return null;
  const measure = CRACK_MEASURES.find((m) => m.key === shape.measure)!;
  return `${measure.label} ${measureText(crack, shape.measure) ?? "—"}`;
}

/** Where a crack's location came from, in words. */
export function locationText(crack: Pick<Crack, "latitude" | "longitude" | "location_source">): string | null {
  if (crack.latitude == null || crack.longitude == null) return null;
  const where = `${crack.latitude.toFixed(6)}, ${crack.longitude.toFixed(6)}`;
  const source = { PHOTO: "approximate, from its photo", MAP: "mapped", MANUAL: "entered" }[crack.location_source ?? "MANUAL"];
  return `${where} (${source})`;
}

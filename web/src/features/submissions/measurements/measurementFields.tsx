import { Check, Mountain, Plane, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { terrainWhen, type TerrainSource } from "../../../components/terrainSourceModel";
import type { MeasurementField } from "../siteTerrainModel";
import type { GuideKey } from "./measurementGuides";
import type { MeasureResult } from "./useSiteMeasurement";

export const MEASURE_KEYS = [
  "measure_slope_height_ft",
  "measure_original_slope_deg",
  "measure_landslide_width_ft",
  "measure_landslide_length_ft",
  "measure_main_scarp_height_ft",
  "measure_landslide_slope_deg",
  "measure_roadway_length_ft",
  "measure_roadway_width_ft",
] as const;
export type MeasureKey = (typeof MEASURE_KEYS)[number];
export type MeasureValues = Record<MeasureKey, string>;

/**
 * Where a suggestion can come from: the ground (terrain model or drone survey), a
 * drone survey only, for someone to review, or nowhere: it is measured on site.
 */
export type FieldSpec = {
  key: MeasureKey;
  symbol: ReactNode;
  name: string;
  unit: "ft" | "°";
  source: "ground" | "scarp" | "site";
  guide?: GuideKey;
};

// Grouped as the reference sketch groups them: the slope, the slide, the road.
export const FIELD_GROUPS: Array<{ title: string; fields: FieldSpec[] }> = [
  {
    title: "Slope",
    fields: [
      { key: "measure_slope_height_ft", symbol: "H", name: "Slope height", unit: "ft", source: "ground", guide: "H" },
      { key: "measure_original_slope_deg", symbol: "α", name: "Original slope", unit: "°", source: "ground", guide: "A" },
    ],
  },
  {
    title: "Landslide",
    fields: [
      { key: "measure_landslide_width_ft", symbol: <>W<sub>d</sub></>, name: "Width", unit: "ft", source: "ground", guide: "W" },
      { key: "measure_landslide_length_ft", symbol: <>L<sub>d</sub></>, name: "Length", unit: "ft", source: "ground", guide: "L" },
      { key: "measure_landslide_slope_deg", symbol: "β", name: "Slope", unit: "°", source: "ground", guide: "B" },
      { key: "measure_main_scarp_height_ft", symbol: <>H<sub>s</sub></>, name: "Main scarp height", unit: "ft", source: "scarp", guide: "S" },
    ],
  },
  {
    title: "Roadway encroached",
    fields: [
      { key: "measure_roadway_length_ft", symbol: <>L<sub>r</sub></>, name: "Length", unit: "ft", source: "site" },
      { key: "measure_roadway_width_ft", symbol: <>W<sub>r</sub></>, name: "Width", unit: "ft", source: "site" },
    ],
  },
];

export const sameNumber = (a: string, b: string | undefined) => b != null && a.trim() !== "" && Number(a) === Number(b);

/** What a field could be filled with now, and where that came from. */
export function fieldSuggestion(field: FieldSpec, current: MeasureResult | null, scarpFt: string | null, terrain: TerrainSource | null): { value: string; from: string } | null {
  if (!current) return null;
  if (field.source === "scarp") return scarpFt ? { value: scarpFt, from: "Drone survey" } : null;
  if (field.source !== "ground") return null;
  const value = current.proposed[field.key as MeasurementField];
  if (value == null) return null;
  const { drone } = current;
  if (!drone) return { value, from: terrain && terrainWhen(terrain) ? `Terrain model, ${terrainWhen(terrain)}` : "Terrain model" };
  const before = field.key === "measure_slope_height_ft" || field.key === "measure_original_slope_deg";
  return { value, from: before ? `Before: ${drone.beforeTitle}` : `Now: ${drone.nowTitle}` };
}

/** The agreed words, wherever measurements are shown. */
export function ReviewNotice({ className = "" }: { className?: string }) {
  return (
    <p role="note" className={`flex items-start gap-2 rounded-md border border-[color:color-mix(in_oklab,var(--warn-text)_40%,var(--line))] bg-[color:color-mix(in_oklab,var(--warn-text)_8%,var(--panel))] px-3 py-2 text-xs font-medium ${className}`}>
      <TriangleAlert size={14} className="mt-px shrink-0 text-[var(--warn-text)]" aria-hidden />
      <span>This data has not been reviewed by land surveyors. Take it as a suggestion, not as fact.</span>
    </p>
  );
}

/** Under a field: where its suggestion came from, how to use it, or that it is measured on site. */
export function FieldNote({
  field,
  value,
  suggestion,
  canEdit,
  hasSurvey,
  onUse,
}: {
  field: FieldSpec;
  value: string;
  suggestion: { value: string; from: string } | null;
  canEdit: boolean;
  /** A drone survey is on the form, so Hs can be suggested once it is measured. */
  hasSurvey: boolean;
  onUse: (value: string) => void;
}) {
  const units = field.unit === "°" ? "°" : " ft";
  if (!suggestion) {
    if (field.source === "ground") return null;
    return (
      <div className="mt-1 text-[11px] font-medium text-muted">
        {field.source === "scarp" && hasSurvey ? "Measure on site, or measure the drone survey for a suggestion" : "Measure on site"}
      </div>
    );
  }
  const review = field.source === "scarp";
  const Icon = review ? Plane : Mountain;
  const matches = sameNumber(value, suggestion.value);
  return (
    <div className="mt-1 grid gap-1 justify-items-start text-[11px]">
      {matches ? (
        <span className="inline-flex items-center gap-1 font-medium text-[var(--good)]"><Check size={12} aria-hidden /> Suggested value in use</span>
      ) : canEdit ? (
        <button
          type="button"
          onClick={() => onUse(suggestion.value)}
          title={review ? "Use the suggestion from the drone survey, then check it on site" : "Use this suggested value"}
          className="inline-flex min-h-7 items-center gap-1 rounded-full border border-dashed border-[var(--accent)] px-2 py-0.5 font-medium text-[var(--accent)] hover:bg-[color:color-mix(in_oklab,var(--accent)_10%,var(--panel))]"
        >
          <Icon size={11} aria-hidden /> {suggestion.value}{units} · Use
        </button>
      ) : (
        <span className="text-muted">Suggested: {suggestion.value}{units}</span>
      )}
      {review ? (
        <span className="font-semibold text-[var(--warn-text)]">Drone survey suggestion. Please review it on site.</span>
      ) : (
        <span className="text-muted">{suggestion.from}</span>
      )}
    </div>
  );
}

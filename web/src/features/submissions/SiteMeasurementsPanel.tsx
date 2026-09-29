import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, Info, Loader2, MapPinned, Mountain, PenLine, Route as RouteIcon, Undo2 } from "lucide-react";

import { SliderField } from "./gisaFields";
import RoadwayEncroachment, { type RoadIdentity } from "./RoadwayEncroachment";

import { areasFromGeoJson, formatArea, polygonAreaSqM } from "../../components/siteAreasModel";
import { sampleElevations } from "./terrainElevation";
import {
  bearingLabel,
  buildSamplePlan,
  compareSurfaces,
  comparisonFieldValues,
  FT_PER_M,
  measureSiteArea,
  measurementFieldValues,
  pointsAlong,
  pointsAlongPath,
  profileLine,
  type LonLat,
  type MeasurementField,
  type Sample,
  type SiteMeasurement,
  type SurfaceComparison,
} from "./siteTerrainModel";
import type { SavedComparison } from "../../api/droneSurveys";
import { useDroneSurveys } from "./drone/DroneSurveyContext";
import SlopeProfileDiagram, { type ProfilePoint } from "./drone/SlopeProfileDiagram";
import { surveyTitle } from "./drone/surveyLabels";

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

/** Where a proposed value can come from: the terrain model, the rebuilt roadway, or only the field. */
type FieldSpec = { key: MeasureKey; symbol: ReactNode; name: string; unit: "ft" | "°"; source: "terrain" | "road" | "field" };

// Grouped as the reference sketch groups them: the slope, the slide, the road.
const GROUPS: Array<{ title: string; fields: FieldSpec[] }> = [
  {
    title: "Slope",
    fields: [
      { key: "measure_slope_height_ft", symbol: "H", name: "Slope height", unit: "ft", source: "terrain" },
      { key: "measure_original_slope_deg", symbol: "α", name: "Original slope", unit: "°", source: "terrain" },
    ],
  },
  {
    title: "Landslide",
    fields: [
      { key: "measure_landslide_width_ft", symbol: <>W<sub>d</sub></>, name: "Width", unit: "ft", source: "terrain" },
      { key: "measure_landslide_length_ft", symbol: <>L<sub>d</sub></>, name: "Length", unit: "ft", source: "terrain" },
      { key: "measure_landslide_slope_deg", symbol: "β", name: "Slope", unit: "°", source: "terrain" },
      { key: "measure_main_scarp_height_ft", symbol: <>H<sub>s</sub></>, name: "Main scarp height", unit: "ft", source: "field" },
    ],
  },
  {
    title: "Roadway encroached",
    fields: [
      { key: "measure_roadway_length_ft", symbol: <>L<sub>r</sub></>, name: "Length", unit: "ft", source: "road" },
      { key: "measure_roadway_width_ft", symbol: <>W<sub>r</sub></>, name: "Width", unit: "ft", source: "road" },
    ],
  },
];

type TerrainResult = {
  /** The area, the drone survey and what it is compared with (each with its offset). */
  key: string;
  measurement: SiteMeasurement;
  proposed: Partial<Record<MeasurementField, string>>;
  resolution: { min: number; max: number } | null;
  missing: number;
  bufferM: number;
  /** Before and after, when a drone survey covers the area. */
  drone: {
    comparison: SurfaceComparison;
    profile: ProfilePoint[];
    /** The survey that is the ground now, and what the ground before is: "terrain model" or an earlier survey. */
    nowTitle: string;
    beforeTitle: string;
    beforeIsSurvey: boolean;
    offsetM: number;
    /** The drawn line the section follows (null: down the fall line), as a key to notice when it changes. */
    sectionLine: LonLat[] | null;
    sectionKey: string;
    /** What was saved with the survey, to save again when only the section line changes. */
    saved: SavedComparison | null;
  } | null;
  /** A drone survey is loaded but covers too little of the area (with what it is compared with) to measure it. */
  droneCoverage: number | null;
};

/** The drone survey must cover at least this share of the area to measure the ground now. */
const MIN_DRONE_COVERAGE = 0.5;
const YD3_PER_M3 = 1.307950619;

const fmtFt = (m: number) => `${Math.round(m * FT_PER_M).toLocaleString("en-US")} ft`;
const fmtRes = (r: { min: number; max: number } | null) =>
  !r ? "resolution not reported" : Math.abs(r.max - r.min) < 0.01 ? `${+r.min.toFixed(1)} m DEM` : `${+r.min.toFixed(1)}–${+r.max.toFixed(1)} m DEM`;
const sameNumber = (a: string, b: string | undefined) => b != null && a.trim() !== "" && Number(a) === Number(b);
const fmtYd3 = (m3: number) => `${Math.round(m3 * YD3_PER_M3).toLocaleString("en-US")} yd³`;
const fmtChangeFt = (m: number) => `${(m * FT_PER_M).toFixed(1)} ft`;

/**
 * The measurement fields beside their reference sketch, and the tool that
 * measures the slide from the terrain under the area drawn on the location map.
 */
export default function SiteMeasurementsPanel({
  values,
  onChange,
  geojson,
  canEdit,
  road,
}: {
  values: MeasureValues;
  onChange: (patch: Partial<MeasureValues>) => void;
  geojson: unknown;
  canEdit: boolean;
  road: RoadIdentity;
}) {
  const areas = useMemo(() => areasFromGeoJson(geojson), [geojson]);
  const [areaIndex, setAreaIndex] = useState(0);
  const index = Math.min(areaIndex, Math.max(0, areas.length - 1));
  const area = areas[index] ?? null;
  const areaKey = area ? JSON.stringify(area) : "";
  const drone = useDroneSurveys();
  const survey = drone?.active ?? null;
  const baseline = drone?.baseline ?? null;
  const measureKey = [
    areaKey,
    survey ? `${survey.survey.id}:${survey.survey.vertical_offset_m}` : "",
    baseline ? `${baseline.survey.id}:${baseline.survey.vertical_offset_m}` : "terrain",
  ].join("|");

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TerrainResult | null>(null);
  const [applied, setApplied] = useState<number | null>(null);
  const [roadProposal, setRoadProposal] = useState<{ areaKey: string; values: Partial<Record<MeasureKey, string>> } | null>(null);
  const stale = result != null && result.key !== measureKey;
  const proposed = result && !stale ? result.proposed : {};

  // The section follows a line someone drew in the 3D view, else the fall line.
  const drawnLine = drone && !drone.section.drawing && drone.section.points.length >= 2 ? drone.section.points : null;
  const drawnKey = drawnLine ? JSON.stringify(drawnLine) : "";

  async function sectionProfile(rings: LonLat[][], bearingDeg: number, bufferM: number, line: LonLat[] | null): Promise<ProfilePoint[]> {
    if (!drone) return [];
    const along = line
      ? pointsAlongPath(line, 160)
      : (() => {
          const [top, bottom] = profileLine(rings, bearingDeg, Math.max(10, bufferM));
          return pointsAlong(top, bottom, 90);
        })();
    const beforeLine = await drone.beforeHeights(along.map((a) => a.point));
    return along.map((a, i) => ({ distanceM: a.distanceM, point: a.point, historical: beforeLine[i] ?? null, actual: drone.actualAt(a.point[0], a.point[1]) }));
  }

  // A new section line redraws the section (and is kept with the comparison) without measuring again.
  useEffect(() => {
    const current = result?.drone;
    if (!current || stale || !area || current.sectionKey === drawnKey) return;
    let cancelled = false;
    sectionProfile(area, current.comparison.original.downslopeBearingDeg, result.bufferM, drawnLine).then((profile) => {
      if (cancelled) return;
      setResult((prev) => (prev?.drone ? { ...prev, drone: { ...prev.drone, profile, sectionLine: drawnLine, sectionKey: drawnKey } } : prev));
      if (canEdit && current.saved) {
        drone?.saveComparison({ ...current.saved, measured_at: new Date().toISOString(), section_line: drawnLine }).catch(() => undefined);
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawnKey, result?.drone?.sectionKey, stale]);

  async function measure() {
    if (!area) return;
    setError(null);
    setApplied(null);
    const plan = buildSamplePlan(area);
    setBusy(`Sampling the terrain at ${(plan.inside.length + plan.around.length).toLocaleString("en-US")} points…`);
    try {
      const { z, resolution } = await sampleElevations([...plan.inside, ...plan.around]);
      const toSamples = (points: LonLat[], offset: number) =>
        points.flatMap(([lon, lat], i): Sample[] => (z[offset + i] == null ? [] : [{ lon, lat, z: z[offset + i]! }]));
      const inside = toSamples(plan.inside, 0);
      const around = toSamples(plan.around, plan.inside.length);
      const measurement = measureSiteArea(area, inside, around);
      if (!measurement) throw new Error("The terrain model has no usable data under this area.");

      // A drone survey over the area: the same points on the ground now, compared with the
      // ground before (the terrain model, or an earlier survey), and a section down the slope.
      let before: TerrainResult["drone"] = null;
      let droneCoverage: number | null = null;
      if (drone && survey) {
        const all = [...plan.inside, ...plan.around];
        const actual = all.map(([lon, lat]) => drone.actualAt(lon, lat));
        const historical = baseline ? all.map(([lon, lat]) => drone.baselineAt(lon, lat)) : z;
        const comparison = compareSurfaces(area, plan, historical, actual);
        droneCoverage = comparison?.coverage ?? plan.inside.filter((_, i) => actual[i] != null && historical[i] != null).length / Math.max(1, plan.inside.length);
        if (comparison && comparison.coverage >= MIN_DRONE_COVERAGE) {
          setBusy(drawnLine ? "Drawing the section along your line…" : "Drawing the section down the slope…");
          const profile = await sectionProfile(area, comparison.original.downslopeBearingDeg, plan.bufferM, drawnLine);
          const heights = (m: SiteMeasurement) => ({ slope_deg: m.landslideSlopeDeg, height_m: m.slopeHeightM, low_m: m.lowElevationM, high_m: m.highElevationM });
          const saved: SavedComparison = {
              area_key: areaKey,
              measured_at: new Date().toISOString(),
              offset_m: survey.survey.vertical_offset_m,
              baseline: baseline
                ? { kind: "survey", survey_id: baseline.survey.id, title: surveyTitle(baseline.survey), offset_m: baseline.survey.vertical_offset_m }
                : { kind: "terrain" },
              original: heights(comparison.original),
              updated: heights(comparison.updated),
              coverage: comparison.coverage,
              max_loss_m: comparison.maxLossM,
              max_gain_m: comparison.maxGainM,
              mean_change_m: comparison.meanChangeM,
              loss_m3: comparison.lossVolumeM3,
              gain_m3: comparison.gainVolumeM3,
              net_m3: comparison.netVolumeM3,
              section_line: drawnLine,
          };
          before = {
            comparison,
            profile,
            nowTitle: surveyTitle(survey.survey),
            beforeTitle: baseline ? surveyTitle(baseline.survey) : "terrain model",
            beforeIsSurvey: !!baseline,
            offsetM: survey.survey.vertical_offset_m,
            sectionLine: drawnLine,
            sectionKey: drawnKey,
            saved,
          };
          if (canEdit) {
            drone.saveComparison(saved).catch(() => {
              // The comparison shows either way; keeping it with the survey is a convenience.
            });
          }
        }
      }
      setResult({
        key: measureKey,
        measurement,
        proposed: before ? comparisonFieldValues(before.comparison) : measurementFieldValues(measurement),
        resolution,
        missing: plan.inside.length + plan.around.length - inside.length - around.length,
        bufferM: plan.bufferM,
        drone: before,
        droneCoverage,
      });
    } catch (e: any) {
      setError(e?.message ? `Could not measure the terrain: ${e.message}` : "Could not measure the terrain.");
    } finally {
      setBusy(null);
    }
  }

  const proposedKeys = Object.keys(proposed) as MeasurementField[];
  const emptyKeys = proposedKeys.filter((key) => !values[key]?.trim());
  const differentKeys = proposedKeys.filter((key) => !sameNumber(values[key], proposed[key]));
  const fill = (keys: MeasurementField[]) => {
    if (!keys.length) return;
    onChange(Object.fromEntries(keys.map((key) => [key, proposed[key]!])));
    setApplied(keys.length);
  };

  const m = result && !stale ? result.measurement : null;

  return (
    <div className="min-w-0 space-y-4">
      <figure className="rounded-xl border border-[var(--line)] bg-white p-2">
        <img src="/measurement/landslide.png" alt="Landslide measurement reference with symbols H, alpha, Wd, Ld, Hs, beta, Lr, Wr" className="mx-auto max-h-72 w-full object-contain" />
      </figure>

      <div className="rounded-xl border border-[color:color-mix(in_oklab,var(--accent)_45%,var(--line))] bg-[color:color-mix(in_oklab,var(--accent)_6%,var(--panel))] p-3">
        <div className="flex flex-wrap items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent)] text-white" aria-hidden>
            <Mountain size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">Measure from the terrain</div>
            <p className="text-xs text-muted">
              {area
                ? "Samples the elevation model inside the area drawn on the location map and around it, and works out the slope, the slide's size and the slope height."
                : "Draw the slide's outline on the location map (Site areas, then Draw area) to measure it from the elevation model."}
              {area && survey
                ? baseline
                  ? ` The drone survey "${surveyTitle(survey.survey)}" gives the ground now and "${surveyTitle(baseline.survey)}" the ground before.`
                  : ` The drone survey "${surveyTitle(survey.survey)}" gives the ground now: the terrain model stays the ground before.`
                : ""}
            </p>
          </div>
          {area ? (
            <div className="flex flex-wrap items-center gap-2">
              {areas.length > 1 ? (
                <select
                  aria-label="Area to measure"
                  className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2 py-1.5 text-xs"
                  value={index}
                  onChange={(e) => setAreaIndex(Number(e.target.value))}
                >
                  {areas.map((rings, i) => (
                    <option key={i} value={i}>
                      Area {i + 1} · {formatArea(polygonAreaSqM(rings))}
                    </option>
                  ))}
                </select>
              ) : null}
              <button
                type="button"
                onClick={measure}
                disabled={busy != null}
                className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-60"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Mountain size={14} />}
                {result ? "Measure again" : "Measure"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => document.getElementById("submission-location-title")?.scrollIntoView({ behavior: "smooth", block: "start" })}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-1.5 text-xs font-medium hover:border-[var(--accent)]"
            >
              <MapPinned size={14} /> Go to the map
            </button>
          )}
        </div>

        {busy ? <p className="mt-2 text-xs text-muted" aria-live="polite">{busy}</p> : null}
        {error ? <p className="mt-2 text-xs text-[var(--bad)]">{error}</p> : null}
        {stale ? <p className="mt-2 text-xs text-[var(--warn-text)]">The area or the drone survey changed since it was measured. Measure it again.</p> : null}
        {result && !stale && !result.drone && result.droneCoverage != null ? (
          <p className="mt-2 text-xs text-[var(--warn-text)]">
            {baseline
              ? `The two drone surveys overlap on ${Math.round(result.droneCoverage * 100)}% of this area, too little to compare them.`
              : `The drone survey covers ${Math.round(result.droneCoverage * 100)}% of this area, too little to measure the ground now.`}{" "}
            These values come from the terrain model only.
          </p>
        ) : null}

        {m && result ? (
          <>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-[var(--line)] pt-3 text-xs sm:grid-cols-4">
              <Metric label="Faces" value={bearingLabel(m.downslopeBearingDeg)} note={m.directionFromOutline ? "Nearly flat: length follows the outline" : "Down the fall line"} />
              <Metric label="Elevation" value={`${fmtFt(m.lowElevationM)} – ${fmtFt(m.highElevationM)}`} note="Low and high points, with the ground around" />
              <Metric label="Plan length" value={fmtFt(m.horizontalLengthM)} note={`${fmtFt(m.slopeLengthM)} along the slope`} />
              <Metric label="Source" value="Esri World Elevation" note={`${fmtRes(result.resolution)} · ${(m.insideSamples + m.aroundSamples).toLocaleString("en-US")} samples`} />
            </dl>
            {result.drone ? <BeforeAndAfter drone={result.drone} /> : null}
            {canEdit && !differentKeys.length ? (
              <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-[var(--good)]" aria-live="polite">
                <Check size={14} />
                {applied ? `Filled ${applied} ${applied === 1 ? "field" : "fields"}. Save the draft to keep ${applied === 1 ? "it" : "them"}.` : "The fields match the terrain."}
              </p>
            ) : canEdit ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => fill(emptyKeys.length ? emptyKeys : differentKeys)}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110"
                >
                  <Check size={14} />
                  {emptyKeys.length
                    ? `Fill ${emptyKeys.length} empty ${emptyKeys.length === 1 ? "field" : "fields"}`
                    : `Replace ${differentKeys.length} ${differentKeys.length === 1 ? "field" : "fields"}`}
                </button>
                <span className="text-xs text-muted" aria-live="polite">
                  {applied
                    ? `Filled ${applied} ${applied === 1 ? "field" : "fields"}. Save the draft to keep ${applied === 1 ? "it" : "them"}.`
                    : emptyKeys.length && emptyKeys.length < differentKeys.length
                      ? "Fields you already filled keep their values; use a field's suggestion to replace it."
                      : "Suggestions also appear under each field."}
                </span>
              </div>
            ) : null}
            <details className="mt-3 text-xs text-muted">
              <summary className="cursor-pointer select-none font-medium text-[var(--ink)]">How these are measured</summary>
              <ul className="mt-1.5 list-disc space-y-1 pl-4">
                <li>β: a plane fitted to the elevations inside the area. α: a plane fitted to a band {Math.round(result.bufferM)} m wide around it.</li>
                <li>Ld runs down the fall line, measured along the slope; Wd is the area's extent across it.</li>
                {result.drone ? (
                  <li>
                    With a drone survey, α and H describe the ground before ({result.drone.beforeIsSurvey ? "the earlier survey" : "the terrain model"}) and β, Ld and Wd the ground now (the drone), measured the same way.
                    {result.drone.beforeIsSurvey
                      ? " Both surveys' heights are lined up with the terrain model on the ground around the slide, so they compare on the same footing."
                      : ` The drone heights are shifted ${result.drone.offsetM >= 0 ? "up" : "down"} ${Math.abs(result.drone.offsetM * FT_PER_M).toFixed(1)} ft to line up with the terrain model on the ground around the slide.`}
                    Volumes add up the change at each sample inside the area.
                  </li>
                ) : null}
                <li>H is the rise from the low point to the high point of the area and the band around it (2nd to 98th percentile, so single spikes don't count).</li>
                <li>
                  {result.drone
                    ? result.drone.beforeIsSurvey
                      ? "Each drone survey is only as good as its flight and processing. Check both in the field."
                      : "The terrain model predates the slide and the drone survey is only as good as its flight and processing. Check both in the field."
                    : "The elevation model usually predates the slide, so these describe the slope as it was mapped. Check them in the field."}
                </li>
                <li>Hs is too small to read from the model: measure it in the field. Lr and Wr come from the roadway panel below.</li>
                {result.missing ? <li>{result.missing} points had no elevation data and were left out.</li> : null}
              </ul>
            </details>
          </>
        ) : null}
      </div>

      {area ? (
        <RoadwayEncroachment
          area={area}
          areaKey={areaKey}
          road={road}
          values={{ measure_roadway_length_ft: values.measure_roadway_length_ft, measure_roadway_width_ft: values.measure_roadway_width_ft }}
          canEdit={canEdit}
          onProposal={(proposal) => setRoadProposal({ areaKey, values: proposal })}
          onFill={(patch) => onChange(patch)}
        />
      ) : null}

      <div className="space-y-4">
        {GROUPS.map((group) => (
          <fieldset key={group.title} disabled={!canEdit} className="min-w-0">
            <legend className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{group.title}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {group.fields.map((field) => {
                const suggestion =
                  field.source === "terrain"
                    ? proposed[field.key as MeasurementField]
                    : field.source === "road" && roadProposal?.areaKey === areaKey
                      ? roadProposal.values[field.key]
                      : undefined;
                const SourceIcon = field.source === "road" ? RouteIcon : Mountain;
                const sourceName = field.source === "road" ? "roadway" : "terrain";
                const matches = suggestion != null && sameNumber(values[field.key], suggestion);
                return (
                  <div key={field.key} className="min-w-0">
                    {field.unit === "°" ? (
                      // Angles: a 0-90° slider, the box beside it for exact values.
                      <SliderField
                        label={<><SymbolBadge>{field.symbol}</SymbolBadge>{field.name}</>}
                        name={field.name}
                        unit="°"
                        max={90}
                        step={0.5}
                        value={values[field.key]}
                        onChange={(value) => onChange({ [field.key]: value })}
                      />
                    ) : (
                    <>
                    <label htmlFor={`measure-${field.key}`} className="mb-1 flex items-baseline gap-2 text-xs font-medium">
                      <SymbolBadge>{field.symbol}</SymbolBadge>
                      {field.name}
                    </label>
                    <div className="relative">
                      <input
                        id={`measure-${field.key}`}
                        type="number"
                        step="any"
                        inputMode="decimal"
                        className="w-full rounded-md border border-[var(--line)] bg-[var(--panel-soft)] py-2 pl-2.5 pr-9 text-sm tabular-nums"
                        value={values[field.key]}
                        onChange={(e) => onChange({ [field.key]: e.target.value })}
                      />
                      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted">{field.unit}</span>
                    </div>
                    </>
                    )}
                    {suggestion != null ? (
                      matches ? (
                        <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-[var(--good)]">
                          <Check size={12} /> Matches the {sourceName}
                        </div>
                      ) : canEdit ? (
                        <button
                          type="button"
                          onClick={() => (field.source === "road" ? onChange({ [field.key]: suggestion }) : fill([field.key as MeasurementField]))}
                          className="mt-1 inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--accent)] px-2 py-0.5 text-[11px] font-medium text-[var(--accent)] hover:bg-[color:color-mix(in_oklab,var(--accent)_10%,var(--panel))]"
                          title={`Use the value measured from the ${sourceName}`}
                        >
                          <SourceIcon size={11} /> {suggestion}
                          {field.unit === "°" ? "°" : " ft"} · Use
                        </button>
                      ) : (
                        <div className="mt-1 text-[11px] text-muted">
                          {field.source === "road" ? "Roadway" : "Terrain"}: {suggestion}
                          {field.unit === "°" ? "°" : " ft"}
                        </div>
                      )
                    ) : m && field.source === "field" ? (
                      <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted">
                        <Info size={11} /> Measure in the field
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
    </div>
  );
}

function SymbolBadge({ children }: { children: ReactNode }) {
  return (
    <span className="mr-0.5 inline-block min-w-8 text-center rounded-md bg-[color:color-mix(in_oklab,var(--accent)_14%,var(--panel))] px-1.5 py-0.5 font-serif text-sm italic leading-none text-[var(--accent)]">
      {children}
    </span>
  );
}

/** The slope before (terrain model or an earlier survey) and now (drone survey), the change between them, and the section down the slope. */
function BeforeAndAfter({ drone }: { drone: NonNullable<TerrainResult["drone"]> }) {
  const { comparison: c } = drone;
  const surveys = useDroneSurveys();
  const angle = (d: number) => `${d.toFixed(1)}°`;
  const rows: Array<{ label: ReactNode; before: string; now: string }> = [
    { label: "Slope", before: angle(c.original.landslideSlopeDeg), now: angle(c.updated.landslideSlopeDeg) },
    { label: "Height", before: fmtFt(c.original.slopeHeightM), now: fmtFt(c.updated.slopeHeightM) },
    { label: "Low point", before: fmtFt(c.original.lowElevationM), now: fmtFt(c.updated.lowElevationM) },
    { label: "High point", before: fmtFt(c.original.highElevationM), now: fmtFt(c.updated.highElevationM) },
    { label: "Length along the slope", before: fmtFt(c.original.slopeLengthM), now: fmtFt(c.updated.slopeLengthM) },
  ];
  return (
    <div className="mt-3 border-t border-[var(--line)] pt-3">
      <div className="text-xs font-semibold">Before and now</div>
      <div className="mt-1.5 overflow-x-auto">
        <table className="w-full min-w-[22rem] text-xs tabular-nums">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-muted">
              <th className="py-1 pr-3 font-semibold" scope="col"><span className="sr-only">Measure</span></th>
              <th className="py-1 pr-3 font-semibold" scope="col">Before<span className="block font-normal normal-case tracking-normal">{drone.beforeTitle}</span></th>
              <th className="py-1 pr-3 font-semibold" scope="col">Now<span className="block font-normal normal-case tracking-normal">{drone.nowTitle}</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t border-[var(--line)]">
                <th scope="row" className="py-1 pr-3 text-left font-medium">{row.label}</th>
                <td className="py-1 pr-3">{row.before}</td>
                <td className="py-1 pr-3 font-semibold">{row.now}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
        <Metric label="Deepest drop" value={fmtChangeFt(c.maxLossM)} note={`Mean change ${c.meanChangeM >= 0 ? "+" : "−"}${fmtChangeFt(Math.abs(c.meanChangeM))}`} />
        <Metric label="Highest rise" value={fmtChangeFt(c.maxGainM)} note="Debris or bulging ground" />
        <Metric label="Ground lost" value={fmtYd3(c.lossVolumeM3)} note={`Gained ${fmtYd3(c.gainVolumeM3)}`} />
        <Metric label="Net change" value={`${c.netVolumeM3 >= 0 ? "+" : "−"}${fmtYd3(Math.abs(c.netVolumeM3))}`} note={`${drone.beforeIsSurvey ? "The surveys overlap on" : "Drone covers"} ${Math.round(c.coverage * 100)}% of the area`} />
      </dl>
      <SlopeProfileDiagram
        profile={drone.profile}
        originalSlopeDeg={c.original.landslideSlopeDeg}
        newSlopeDeg={c.updated.landslideSlopeDeg}
        originalHeightM={c.original.slopeHeightM}
        newHeightM={c.updated.slopeHeightM}
        beforeTitle={drone.beforeTitle}
        nowTitle={drone.nowTitle}
        axisLabel={drone.sectionLine ? "Distance along your section line (ft)" : "Distance down the slope (ft)"}
        onHover={(index) => surveys?.setSectionHover(index == null ? null : drone.profile[index]?.point ?? null)}
      />
      {surveys ? <SectionControls line={drone.sectionLine} lengthM={drone.profile[drone.profile.length - 1]?.distanceM ?? 0} /> : null}
    </div>
  );
}

/** Where the section runs: down the fall line, or along a line drawn in the 3D view (as in the cross-section tool). */
function SectionControls({ line, lengthM }: { line: LonLat[] | null; lengthM: number }) {
  const drone = useDroneSurveys()!;
  const { section } = drone;
  const link = "inline-flex items-center gap-1 rounded-md border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50";
  if (section.drawing) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-dashed border-[#2563eb] bg-[color:color-mix(in_oklab,#2563eb_6%,var(--panel))] px-2.5 py-2 text-xs">
        <span className="basis-full sm:basis-auto sm:flex-1">
          <b>Click the 3D view</b> to place the section's points in order (S1, S2, …).{" "}
          {section.points.length ? `${section.points.length} placed.` : "None placed yet."}
        </span>
        <button type="button" className={link} disabled={!section.points.length} onClick={drone.undoSectionPoint}><Undo2 size={12} aria-hidden /> Undo point</button>
        <button type="button" className={link} onClick={drone.clearSection}>Cancel</button>
        <button
          type="button"
          disabled={section.points.length < 2}
          onClick={drone.finishSection}
          className="inline-flex items-center gap-1 rounded-md bg-[#2563eb] px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50"
        >
          <Check size={12} aria-hidden /> Finish &amp; draw section
        </button>
      </div>
    );
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted">
        Section: {line ? <>your line S1–S{line.length}, {Math.round(lengthM * FT_PER_M).toLocaleString("en-US")} ft</> : "down the fall line, through the middle of the area"}.
      </span>
      <button type="button" className={link} onClick={drone.startSection}>
        <PenLine size={12} aria-hidden /> {line ? "Redraw section line" : "Draw section line"}
      </button>
      {line ? <button type="button" className={link} onClick={drone.clearSection}>Use fall line</button> : null}
    </div>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
      <dd className="text-[11px] text-muted">{note}</dd>
    </div>
  );
}

import { useMemo, useState, type ReactNode } from "react";
import { Check, Info, Loader2, MapPinned, Mountain } from "lucide-react";

import { areasFromGeoJson, formatArea, polygonAreaSqM } from "../../components/siteAreasModel";
import {
  bearingLabel,
  buildSamplePlan,
  FT_PER_M,
  measureSiteArea,
  measurementFieldValues,
  type LonLat,
  type MeasurementField,
  type Sample,
  type SiteMeasurement,
} from "./siteTerrainModel";

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

type FieldSpec = { key: MeasureKey; symbol: ReactNode; name: string; unit: "ft" | "°"; fromTerrain: boolean };

// Grouped as the reference sketch groups them: the slope, the slide, the road.
const GROUPS: Array<{ title: string; fields: FieldSpec[] }> = [
  {
    title: "Slope",
    fields: [
      { key: "measure_slope_height_ft", symbol: "H", name: "Slope height", unit: "ft", fromTerrain: true },
      { key: "measure_original_slope_deg", symbol: "α", name: "Original slope", unit: "°", fromTerrain: true },
    ],
  },
  {
    title: "Landslide",
    fields: [
      { key: "measure_landslide_width_ft", symbol: <>W<sub>d</sub></>, name: "Width", unit: "ft", fromTerrain: true },
      { key: "measure_landslide_length_ft", symbol: <>L<sub>d</sub></>, name: "Length", unit: "ft", fromTerrain: true },
      { key: "measure_landslide_slope_deg", symbol: "β", name: "Slope", unit: "°", fromTerrain: true },
      { key: "measure_main_scarp_height_ft", symbol: <>H<sub>s</sub></>, name: "Main scarp height", unit: "ft", fromTerrain: false },
    ],
  },
  {
    title: "Roadway encroached",
    fields: [
      { key: "measure_roadway_length_ft", symbol: <>L<sub>r</sub></>, name: "Length", unit: "ft", fromTerrain: false },
      { key: "measure_roadway_width_ft", symbol: <>W<sub>r</sub></>, name: "Width", unit: "ft", fromTerrain: false },
    ],
  },
];

type TerrainResult = {
  areaKey: string;
  measurement: SiteMeasurement;
  proposed: Partial<Record<MeasurementField, string>>;
  resolution: { min: number; max: number } | null;
  missing: number;
  bufferM: number;
};

// One elevation source for the page, loaded the first time someone measures.
let groundPromise: Promise<any> | null = null;
function worldElevationGround(): Promise<any> {
  if (!groundPromise) {
    groundPromise = (async () => {
      const [{ default: esriConfig }, { default: ArcGisMap }] = await Promise.all([import("@arcgis/core/config"), import("@arcgis/core/Map")]);
      const apiKey = import.meta.env.VITE_ARCGIS_API_KEY;
      if (apiKey) esriConfig.apiKey = String(apiKey);
      const map = new ArcGisMap({ ground: "world-elevation" });
      await map.ground.loadAll();
      return map.ground;
    })().catch((error) => {
      groundPromise = null;
      throw error;
    });
  }
  return groundPromise;
}

/** Elevations (metres) at [lon, lat] points from Esri World Elevation, finest resolution that covers them all. */
async function sampleElevations(points: LonLat[]) {
  const [ground, { default: Multipoint }] = await Promise.all([worldElevationGround(), import("@arcgis/core/geometry/Multipoint")]);
  const geometry = new Multipoint({ points: points.map(([lon, lat]) => [lon, lat]), spatialReference: { wkid: 4326 } });
  const result = await ground.queryElevation(geometry, { demResolution: "finest-contiguous", returnSampleInfo: true });
  const noData = result.noDataValue;
  const z: Array<number | null> = (result.geometry.points as number[][]).map((p) => (Number.isFinite(p[2]) && p[2] !== noData ? p[2] : null));
  const resolutions = ((result.sampleInfo ?? []) as Array<{ demResolution?: number }>)
    .map((info) => Number(info.demResolution))
    .filter((value) => Number.isFinite(value) && value > 0);
  return { z, resolution: resolutions.length ? { min: Math.min(...resolutions), max: Math.max(...resolutions) } : null };
}

const fmtFt = (m: number) => `${Math.round(m * FT_PER_M).toLocaleString("en-US")} ft`;
const fmtRes = (r: { min: number; max: number } | null) =>
  !r ? "resolution not reported" : Math.abs(r.max - r.min) < 0.01 ? `${+r.min.toFixed(1)} m DEM` : `${+r.min.toFixed(1)}–${+r.max.toFixed(1)} m DEM`;
const sameNumber = (a: string, b: string | undefined) => b != null && a.trim() !== "" && Number(a) === Number(b);

/**
 * The measurement fields beside their reference sketch, and the tool that
 * measures the slide from the terrain under the area drawn on the location map.
 */
export default function SiteMeasurementsPanel({
  values,
  onChange,
  geojson,
  canEdit,
}: {
  values: MeasureValues;
  onChange: (patch: Partial<MeasureValues>) => void;
  geojson: unknown;
  canEdit: boolean;
}) {
  const areas = useMemo(() => areasFromGeoJson(geojson), [geojson]);
  const [areaIndex, setAreaIndex] = useState(0);
  const index = Math.min(areaIndex, Math.max(0, areas.length - 1));
  const area = areas[index] ?? null;
  const areaKey = area ? JSON.stringify(area) : "";

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TerrainResult | null>(null);
  const [applied, setApplied] = useState<number | null>(null);
  const stale = result != null && result.areaKey !== areaKey;
  const proposed = result && !stale ? result.proposed : {};

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
      setResult({
        areaKey,
        measurement,
        proposed: measurementFieldValues(measurement),
        resolution,
        missing: plan.inside.length + plan.around.length - inside.length - around.length,
        bufferM: plan.bufferM,
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
        {stale ? <p className="mt-2 text-xs text-[var(--warn-text)]">The area changed since it was measured. Measure it again.</p> : null}

        {m && result ? (
          <>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-[var(--line)] pt-3 text-xs sm:grid-cols-4">
              <Metric label="Faces" value={bearingLabel(m.downslopeBearingDeg)} note={m.directionFromOutline ? "Nearly flat: length follows the outline" : "Down the fall line"} />
              <Metric label="Elevation" value={`${fmtFt(m.lowElevationM)} – ${fmtFt(m.highElevationM)}`} note="Low and high points, with the ground around" />
              <Metric label="Plan length" value={fmtFt(m.horizontalLengthM)} note={`${fmtFt(m.slopeLengthM)} along the slope`} />
              <Metric label="Source" value="Esri World Elevation" note={`${fmtRes(result.resolution)} · ${(m.insideSamples + m.aroundSamples).toLocaleString("en-US")} samples`} />
            </dl>
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
                <li>H is the rise from the low point to the high point of the area and the band around it (2nd to 98th percentile, so single spikes don't count).</li>
                <li>The elevation model usually predates the slide, so these describe the slope as it was mapped. Check them in the field.</li>
                <li>Hs, Lr and Wr are too small, or depend on the road edge, to read from the model: measure them in the field.</li>
                {result.missing ? <li>{result.missing} points had no elevation data and were left out.</li> : null}
              </ul>
            </details>
          </>
        ) : null}
      </div>

      <div className="space-y-4">
        {GROUPS.map((group) => (
          <fieldset key={group.title} disabled={!canEdit} className="min-w-0">
            <legend className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{group.title}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {group.fields.map((field) => {
                const suggestion = field.fromTerrain ? proposed[field.key as MeasurementField] : undefined;
                const matches = suggestion != null && sameNumber(values[field.key], suggestion);
                return (
                  <div key={field.key} className="min-w-0">
                    <label htmlFor={`measure-${field.key}`} className="mb-1 flex items-baseline gap-2 text-xs font-medium">
                      <span className="inline-flex min-w-8 justify-center rounded-md bg-[color:color-mix(in_oklab,var(--accent)_14%,var(--panel))] px-1.5 py-0.5 font-serif text-sm italic leading-none text-[var(--accent)]">
                        {field.symbol}
                      </span>
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
                    {suggestion != null ? (
                      matches ? (
                        <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-[var(--good)]">
                          <Check size={12} /> Matches the terrain
                        </div>
                      ) : canEdit ? (
                        <button
                          type="button"
                          onClick={() => fill([field.key as MeasurementField])}
                          className="mt-1 inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--accent)] px-2 py-0.5 text-[11px] font-medium text-[var(--accent)] hover:bg-[color:color-mix(in_oklab,var(--accent)_10%,var(--panel))]"
                          title="Use the value measured from the terrain"
                        >
                          <Mountain size={11} /> {suggestion}
                          {field.unit === "°" ? "°" : " ft"} · Use
                        </button>
                      ) : (
                        <div className="mt-1 text-[11px] text-muted">
                          Terrain: {suggestion}
                          {field.unit === "°" ? "°" : " ft"}
                        </div>
                      )
                    ) : m && !field.fromTerrain ? (
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

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
      <dd className="text-[11px] text-muted">{note}</dd>
    </div>
  );
}

import { ArrowLeft, Check, Eye, EyeOff, Loader2, MapPinned, Mountain, PenLine, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { Gisa } from "../../../api/types";
import { formatArea, polygonAreaSqM } from "../../../components/siteAreasModel";
import { flownAfter, terrainSourceText, terrainWhen, type TerrainSource } from "../../../components/terrainSourceModel";
import SurveysPanel, { PointsPanel, SurveyPickers } from "../drone/DroneSurveyCard";
import { useDroneSurveys } from "../drone/DroneSurveyContext";
import SlopeProfileDiagram from "../drone/SlopeProfileDiagram";
import { surveyTitle } from "../drone/surveyLabels";
import { bearingLabel, FT_PER_M, type LonLat, type MeasurementField, type SurfaceComparison } from "../siteTerrainModel";
import SubmissionMeasurementContext, { TerrainSamplesControl } from "../SubmissionMeasurementContext";
import {
  FIELD_GROUPS,
  FieldNote,
  fieldSuggestion,
  ReviewNotice,
  sameNumber,
  type MeasureValues,
} from "./measurementFields";
import { GUIDE_KEYS, viewAfterToggle, visibleGuides, type GroundView, type GuideKey } from "./measurementGuides";
import type { DroneMeasure, SiteMeasurementState } from "./useSiteMeasurement";

const YD3_PER_M3 = 1.307950619;
const fmtFt = (m: number) => `${Math.round(m * FT_PER_M).toLocaleString("en-US")} ft`;
const fmtYd3 = (m3: number) => `${Math.round(m3 * YD3_PER_M3).toLocaleString("en-US")} yd³`;
const fmtChangeFt = (m: number) => `${(m * FT_PER_M).toFixed(1)} ft`;
const fmtRes = (r: { min: number; max: number } | null) =>
  !r ? "resolution not reported" : Math.abs(r.max - r.min) < 0.01 ? `${+r.min.toFixed(1)} m DEM` : `${+r.min.toFixed(1)}–${+r.max.toFixed(1)} m DEM`;

const button = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50";
const primary = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md bg-[var(--brand)] px-4 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50";
type Tab = "values" | "points" | "surveys";

/**
 * The measurements' own screen: the 3D map with each value drawn on it, the
 * ground before or now, one at a time, the profile with the displacement along
 * it, and the values with where each came from.
 */
export default function MeasurementsWorkspace({
  submissionId,
  gisa,
  onReload,
  geometryJson,
  values,
  onChange,
  canEdit,
  measuring,
  onClose,
}: {
  submissionId: number;
  gisa: Gisa | null;
  onReload: () => Promise<void>;
  geometryJson: unknown;
  values: MeasureValues;
  onChange: (patch: Partial<MeasureValues>) => void;
  canEdit: boolean;
  measuring: SiteMeasurementState;
  onClose: () => void;
}) {
  const { areas, index, setAreaIndex, area, areaKey, terrain, drone, busy, error, result, stale, current, measure, scarpFt, guides } = measuring;
  const hasDrone = !!current?.drone;
  const [tab, setTab] = useState<Tab>("values");
  const [shown, setShown] = useState<ReadonlySet<GuideKey>>(() => new Set(GUIDE_KEYS));
  const [focus, setFocus] = useState<GuideKey | null>(null);
  const [applied, setApplied] = useState<number | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // A window's worth of map; the profile sits under it.
  const [mapHeight, setMapHeight] = useState(() => Math.max(360, Math.round(window.innerHeight * 0.52)));
  useEffect(() => {
    const onResize = () => setMapHeight(Math.max(360, Math.round(window.innerHeight * 0.52)));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // A screen of its own: the page behind stays put, Esc goes back unless the map is taking clicks.
  const taking = !!drone?.section.drawing || !!drone?.capturing;
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => { document.body.style.overflow = previous; };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !taking) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [taking, onClose]);
  // Leaving ends whatever was taking clicks on a map that is no longer there.
  useEffect(() => () => {
    drone?.setCapturing(false);
    if (drone?.section.drawing) drone.clearSection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const view: GroundView = drone?.showSurface === false ? "before" : "now";
  const setView = (next: GroundView) => drone?.setShowSurface(next === "now");
  const sceneGuides = useMemo(
    () => visibleGuides(guides, shown, view, hasDrone).map((guide) => ({ ...guide, hot: guide.key === focus })),
    [guides, shown, view, hasDrone, focus],
  );
  const drawable = useMemo(() => new Set(guides.map((g) => g.key)), [guides]);

  const toggle = (key: GuideKey) => {
    const turningOn = !shown.has(key);
    const next = new Set(shown);
    if (turningOn) next.add(key);
    else next.delete(key);
    setShown(next);
    setFocus(turningOn ? key : focus === key ? null : focus);
    if (hasDrone) setView(viewAfterToggle(key, turningOn, view, hasDrone));
  };
  const anyShown = GUIDE_KEYS.some((key) => shown.has(key));

  // Bulk fill never takes the scarp: that one is reviewed and used on purpose.
  const proposed = current?.proposed ?? {};
  const proposedKeys = Object.keys(proposed) as MeasurementField[];
  const emptyKeys = proposedKeys.filter((key) => !values[key]?.trim());
  const differentKeys = proposedKeys.filter((key) => !sameNumber(values[key], proposed[key]));
  const fill = (keys: MeasurementField[]) => {
    if (!keys.length) return;
    onChange(Object.fromEntries(keys.map((key) => [key, proposed[key]!])));
    setApplied(keys.length);
  };

  const beforeLabel = current?.drone ? current.drone.beforeTitle : drone?.baseline ? surveyTitle(drone.baseline.survey) : "terrain model";
  const nowLabel = current?.drone?.nowTitle ?? (drone?.active ? surveyTitle(drone.active.survey) : "");
  const onHere = (GUIDE_KEYS.filter((key) => drawable.has(key)) as GuideKey[])
    .filter((key) => !hasDrone || visibleGuides(guides, new Set([key]), view, true).length > 0)
    .map((key) => ({ H: "H", A: "α", W: "Wd", L: "Ld", B: "β", S: "Hs" })[key])
    .join(", ");

  const content = (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Measurements workspace"
      className="fixed inset-0 z-50 flex flex-col bg-[var(--bg)] text-[var(--ink)] outline-none"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--line)] bg-[var(--panel)] px-3 py-2">
        <button type="button" className={button} onClick={onClose}>
          <ArrowLeft size={15} aria-hidden /> Back to the form
        </button>
        <h2 className="mr-auto text-base font-semibold">Measurements</h2>
        {areas.length > 1 ? (
          <label className="inline-flex items-center gap-1.5 text-sm text-muted">
            Area
            <select className="h-11 rounded-md border border-[var(--line)] bg-[var(--panel)] px-2 text-sm" value={index} onChange={(e) => setAreaIndex(Number(e.target.value))}>
              {areas.map((rings, i) => <option key={i} value={i}>Area {i + 1} · {formatArea(polygonAreaSqM(rings))}</option>)}
            </select>
          </label>
        ) : null}
        <SurveyPickers />
        {drone && !drone.surveys.length ? (
          <span className="text-sm text-muted">Ground: <b className="font-semibold text-[var(--ink)]">terrain model{terrain && terrainWhen(terrain) ? `, ${terrainWhen(terrain)}` : ""}</b></span>
        ) : null}
        {area ? (
          <button type="button" className={primary} onClick={() => void measure()} disabled={busy != null}>
            {busy ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Mountain size={15} aria-hidden />}
            {result ? "Measure again" : "Measure"}
          </button>
        ) : null}
      </header>
      <ReviewNotice className="rounded-none border-x-0 border-t-0" />

      <div className="min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[minmax(0,1fr)_25rem] lg:overflow-hidden">
        <main className="min-w-0 lg:overflow-y-auto">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--line)] bg-[var(--panel)] px-3 py-2">
            {drone?.active ? (
              <div role="radiogroup" aria-label="Ground shown on the map" className="inline-flex overflow-hidden rounded-md border border-[var(--line)] text-sm font-medium">
                {(["before", "now"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={view === option}
                    onClick={() => setView(option)}
                    className={`min-h-11 px-5 ${view === option ? "bg-[var(--brand)] font-semibold text-white" : "bg-[var(--panel)] hover:bg-[var(--panel-soft)]"}`}
                  >
                    {option === "before" ? "Before" : "Now"}
                  </button>
                ))}
              </div>
            ) : null}
            <span className="min-w-0 text-sm text-muted">
              {drone?.active
                ? `${view === "before" ? beforeLabel : nowLabel}${hasDrone && onHere ? `. Showing ${onHere}, measured on this ground.` : ""}`
                : `The ground as mapped${terrain && terrainWhen(terrain) ? `, ${terrainWhen(terrain)}` : ""}, usually before the slide. Add a drone survey to see what changed.`}
            </span>
          </div>

          {drone?.section.drawing ? <SectionDrawing /> : null}
          {drone?.capturing ? (
            <p className="border-b border-[var(--line)] bg-[color:color-mix(in_oklab,var(--accent)_10%,var(--panel))] px-3 py-2 text-sm font-medium">Click the map to capture a point on both grounds.</p>
          ) : null}

          <SubmissionMeasurementContext
            submissionId={submissionId}
            gisa={gisa}
            geometryJson={geometryJson}
            height={mapHeight}
            guides={sceneGuides}
            guideFitKey={areaKey}
          />

          <section aria-labelledby="profile-title" className="grid gap-3 border-t border-[var(--line)] bg-[var(--panel)] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="profile-title" className="text-sm font-semibold">{hasDrone ? "Profile and displacement" : "Profile"}</h3>
              {current ? <SectionControls line={current.sectionLine} lengthM={current.profile[current.profile.length - 1]?.distanceM ?? 0} /> : null}
            </div>

            {!area ? (
              <div className="grid justify-items-start gap-2 text-sm">
                <p>Draw the slide's outline on the location map (Site areas, then Draw area) to measure it.</p>
                <button
                  type="button"
                  className={button}
                  onClick={() => {
                    onClose();
                    window.setTimeout(() => document.getElementById("submission-location-title")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
                  }}
                >
                  <MapPinned size={14} aria-hidden /> Go to the map
                </button>
              </div>
            ) : null}
            {busy ? <p className="text-sm text-muted" aria-live="polite"><Loader2 size={14} className="mr-1.5 inline animate-spin" aria-hidden />{busy}</p> : null}
            {error ? <p className="text-sm text-[var(--bad)]">{error}</p> : null}
            {stale && !busy ? <p className="text-sm text-[var(--warn-text)]">The area or the drone survey changed since it was measured. Measure it again.</p> : null}
            {current && !current.drone && current.droneCoverage != null ? (
              <p className="text-sm text-[var(--warn-text)]">
                {drone?.baseline
                  ? `The two drone surveys overlap on ${Math.round(current.droneCoverage * 100)}% of this area, too little to compare them.`
                  : `The drone survey covers ${Math.round(current.droneCoverage * 100)}% of this area, too little to measure the ground now.`}{" "}
                These values come from the terrain model only.
              </p>
            ) : null}

            {current ? (
              <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
                <div className="min-w-0">
                  <SlopeProfileDiagram
                    profile={current.profile}
                    originalSlopeDeg={current.drone?.comparison.original.landslideSlopeDeg}
                    newSlopeDeg={current.drone?.comparison.updated.landslideSlopeDeg}
                    originalHeightM={current.drone?.comparison.original.slopeHeightM}
                    newHeightM={current.drone?.comparison.updated.slopeHeightM}
                    beforeTitle={current.drone?.beforeTitle ?? `Ground as mapped${terrain && terrainWhen(terrain) ? `, ${terrainWhen(terrain)}` : ""}`}
                    nowTitle={current.drone?.nowTitle ?? ""}
                    axisLabel={current.sectionLine ? "Distance along your section line (ft)" : "Distance down the slope (ft)"}
                    onHover={(i) => drone?.setSectionHover(i == null ? null : current.profile[i]?.point ?? null)}
                  />
                </div>
                <div className="grid min-w-0 gap-3">
                  {current.drone ? (
                    <ChangeFacts drone={current.drone} terrain={terrain} />
                  ) : (
                    <TerrainFacts measuring={measuring} />
                  )}
                </div>
              </div>
            ) : null}

            {current ? <HowMeasured measuring={measuring} /> : null}
          </section>
        </main>

        <aside aria-label="Measurements panel" className="min-w-0 border-t border-[var(--line)] bg-[var(--panel)] lg:overflow-y-auto lg:border-l lg:border-t-0">
          <div role="tablist" aria-label="Panel" className="sticky top-0 z-10 flex gap-1 border-b border-[var(--line)] bg-[var(--panel)] px-2 pt-1">
            {([["values", "Values"], ["points", "Points"], ["surveys", "Surveys"]] as Array<[Tab, string]>).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`min-h-11 border-b-[3px] px-3 text-sm ${tab === id ? "border-[var(--brand)] font-semibold" : "border-transparent font-medium text-muted"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="grid gap-3 p-3">
            {tab === "values" ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold">Show on the map</span>
                  <button type="button" className={button} onClick={() => setShown(new Set(anyShown ? [] : GUIDE_KEYS))}>
                    {anyShown ? "Hide all" : "Show all"}
                  </button>
                </div>
                <div>
                  {FIELD_GROUPS.flatMap((group) => group.fields).map((field) => {
                    const canShow = !!field.guide && drawable.has(field.guide);
                    const on = !!field.guide && shown.has(field.guide);
                    return (
                      <div
                        key={field.key}
                        className={`flex items-start gap-2 border-t border-[var(--line)] px-1 py-2 ${field.guide && focus === field.guide ? "bg-[color:color-mix(in_oklab,var(--warn-text)_10%,var(--panel))]" : ""}`}
                      >
                        {canShow ? (
                          <button
                            type="button"
                            onClick={() => toggle(field.guide!)}
                            aria-pressed={on}
                            aria-label={`Show ${field.name} on the map`}
                            title={on ? "Shown on the map" : "Hidden from the map"}
                            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-md border ${on ? "border-[var(--brand)] text-[var(--brand)]" : "border-[var(--line)] text-muted"}`}
                          >
                            {on ? <Eye size={18} aria-hidden /> : <EyeOff size={18} aria-hidden />}
                          </button>
                        ) : (
                          <span className="w-11 shrink-0" aria-hidden />
                        )}
                        <div className="min-w-0 flex-1">
                          <label htmlFor={`workspace-${field.key}`} className="text-sm">
                            <i className="font-serif font-bold text-[var(--accent)]">{field.symbol}</i>&nbsp; {field.name}
                          </label>
                          <FieldNote
                            field={field}
                            value={values[field.key]}
                            suggestion={fieldSuggestion(field, current, scarpFt, terrain)}
                            canEdit={canEdit}
                            hasSurvey={!!drone?.surveys.length}
                            onUse={(value) => onChange({ [field.key]: value })}
                          />
                        </div>
                        <div className="relative w-28 shrink-0">
                          <input
                            id={`workspace-${field.key}`}
                            type="number"
                            step="any"
                            inputMode="decimal"
                            disabled={!canEdit}
                            className="h-11 w-full rounded-md border border-[var(--line)] bg-[var(--panel-soft)] pl-2 pr-7 text-sm tabular-nums"
                            value={values[field.key]}
                            onChange={(e) => onChange({ [field.key]: e.target.value })}
                          />
                          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted">{field.unit}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {canEdit && current ? (
                  differentKeys.length ? (
                    <button
                      type="button"
                      className={`${button} border-[var(--brand)] font-semibold`}
                      onClick={() => fill(emptyKeys.length ? emptyKeys : differentKeys)}
                    >
                      <Check size={15} aria-hidden />
                      {emptyKeys.length
                        ? `Use the ${emptyKeys.length} suggested ${emptyKeys.length === 1 ? "value" : "values"}`
                        : `Replace ${differentKeys.length} with the suggested ${differentKeys.length === 1 ? "value" : "values"}`}
                    </button>
                  ) : null
                ) : null}
                {applied ? (
                  <p className="text-xs text-muted" aria-live="polite">
                    Filled {applied} {applied === 1 ? "field" : "fields"}. Save the draft to keep {applied === 1 ? "it" : "them"}.
                  </p>
                ) : null}
              </>
            ) : null}
            {tab === "points" ? <PointsPanel /> : null}
            {tab === "surveys" ? (
              <>
                <SurveysPanel />
                <div className="border-t border-[var(--line)] pt-3">
                  <h4 className="mb-1.5 text-sm font-semibold">Terrain samples</h4>
                  <TerrainSamplesControl submissionId={submissionId} gisa={gisa} onReload={onReload} />
                </div>
              </>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );
  return createPortal(content, document.body);
}

function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="min-w-0 rounded-md bg-[var(--panel-soft)] px-2.5 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm font-semibold tabular-nums">{value}</dd>
      {note ? <dd className="text-[11px] text-muted">{note}</dd> : null}
    </div>
  );
}

/** With a drone survey: what changed inside the area, and each ground's figures. */
function ChangeFacts({ drone, terrain }: { drone: DroneMeasure; terrain: TerrainSource | null }) {
  const c: SurfaceComparison = drone.comparison;
  // The terrain model as "before" is only before if it was flown before the survey.
  const terrainAfter = !drone.beforeIsSurvey && flownAfter(terrain, drone.nowDate);
  const beforeTitle = !drone.beforeIsSurvey && terrain && terrainWhen(terrain) ? `${drone.beforeTitle}, ${terrainWhen(terrain)}` : drone.beforeTitle;
  const angle = (d: number) => `${d.toFixed(1)}°`;
  const rows: Array<{ label: ReactNode; before: string; now: string }> = [
    { label: "Slope", before: angle(c.original.landslideSlopeDeg), now: angle(c.updated.landslideSlopeDeg) },
    { label: "Height", before: fmtFt(c.original.slopeHeightM), now: fmtFt(c.updated.slopeHeightM) },
    { label: "Low point", before: fmtFt(c.original.lowElevationM), now: fmtFt(c.updated.lowElevationM) },
    { label: "High point", before: fmtFt(c.original.highElevationM), now: fmtFt(c.updated.highElevationM) },
    { label: "Length along the slope", before: fmtFt(c.original.slopeLengthM), now: fmtFt(c.updated.slopeLengthM) },
  ];
  return (
    <>
      {terrainAfter && terrain ? (
        <p className="rounded-md border border-[color:color-mix(in_oklab,var(--warn-text)_40%,var(--line))] px-2.5 py-1.5 text-xs text-[var(--warn-text)]">
          The terrain model here ({terrainSourceText(terrain)}) was flown after this survey ({drone.nowDate}), so as "before" it may already show the event. Compare with an earlier survey if there is one.
        </p>
      ) : null}
      <dl className="grid grid-cols-2 gap-2">
        <Fact label="Deepest drop" value={fmtChangeFt(c.maxLossM)} note={`Mean change ${c.meanChangeM >= 0 ? "+" : "−"}${fmtChangeFt(Math.abs(c.meanChangeM))}`} />
        <Fact label="Highest rise" value={fmtChangeFt(c.maxGainM)} note="Debris or bulging ground" />
        <Fact label="Ground lost" value={fmtYd3(c.lossVolumeM3)} note={`Gained ${fmtYd3(c.gainVolumeM3)}`} />
        <Fact label="Net change" value={`${c.netVolumeM3 >= 0 ? "+" : "−"}${fmtYd3(Math.abs(c.netVolumeM3))}`} note={`Compared on ${Math.round(c.coverage * 100)}% of the area`} />
      </dl>
      {drone.seaShare > 0 ? (
        <p className="text-xs text-muted">
          {Math.round(drone.seaShare * 100)}% of the compared area was sea before. It is compared from sea level, so the ground gained there counts only what stands above the water: the true volume is larger.
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="text-left text-muted">
              <th scope="col" className="py-1 pr-2 font-semibold"><span className="sr-only">Measure</span></th>
              <th scope="col" className="py-1 pr-2 font-semibold">Before<span className="block font-normal">{beforeTitle}</span></th>
              <th scope="col" className="py-1 font-semibold">Now<span className="block font-normal">{drone.nowTitle}</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t border-[var(--line)]">
                <th scope="row" className="py-1 pr-2 text-left font-medium">{row.label}</th>
                <td className="py-1 pr-2">{row.before}</td>
                <td className="py-1 font-semibold">{row.now}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Without a survey: what the terrain model says about the area, and that displacement needs a survey. */
function TerrainFacts({ measuring }: { measuring: SiteMeasurementState }) {
  const { current, terrain } = measuring;
  if (!current) return null;
  const m = current.measurement;
  return (
    <>
      <p className="rounded-md border border-[color:color-mix(in_oklab,var(--warn-text)_40%,var(--line))] px-2.5 py-2 text-xs font-medium">
        Displacement and volumes need a drone survey to compare with this ground.
      </p>
      <dl className="grid grid-cols-2 gap-2">
        <Fact label="Faces" value={bearingLabel(m.downslopeBearingDeg)} note={m.directionFromOutline ? "Nearly flat: length follows the outline" : "Down the fall line"} />
        <Fact label="Elevation" value={`${fmtFt(m.lowElevationM)} – ${fmtFt(m.highElevationM)}`} note="Low and high points" />
        <Fact label="Plan length" value={fmtFt(m.horizontalLengthM)} note={`${fmtFt(m.slopeLengthM)} along the slope`} />
        <Fact
          label="Source"
          value="Esri World Elevation"
          note={[terrain ? terrainSourceText(terrain).replace(/^Esri World Elevation /, "") : null, fmtRes(current.resolution)].filter(Boolean).join(" · ")}
        />
      </dl>
    </>
  );
}

function HowMeasured({ measuring }: { measuring: SiteMeasurementState }) {
  const { current } = measuring;
  if (!current) return null;
  const { drone, bufferM, missing } = current;
  return (
    <details className="text-xs text-muted">
      <summary className="cursor-pointer select-none py-2 font-medium text-[var(--ink)]">How these are worked out</summary>
      <ul className="mt-1 list-disc space-y-1 pl-4">
        <li>β: a plane fitted to the elevations inside the area. α: a plane fitted to a band {Math.round(bufferM)} m wide around it.</li>
        <li>Ld runs down the fall line, measured along the slope; Wd is the area's extent across it.</li>
        <li>H is the rise from the low point to the high point of the area and the band around it (2nd to 98th percentile, so single spikes don't count).</li>
        {drone ? (
          <li>
            With a drone survey, α and H describe the ground before ({drone.beforeIsSurvey ? "the earlier survey" : "the terrain model"}) and β, Ld and Wd the ground now.
            {drone.beforeIsSurvey
              ? " Both surveys' heights are lined up with the terrain model on the ground around the slide."
              : ` The drone heights are shifted ${drone.offsetM >= 0 ? "up" : "down"} ${Math.abs(drone.offsetM * FT_PER_M).toFixed(1)} ft to line up with the terrain model.`}{" "}
            Volumes add up the change at each sample inside the area.
          </li>
        ) : null}
        {current.scarp ? (
          <li>Hs is suggested from the largest drop between the two grounds in the upper third of the area, down the fall line. The real scarp runs from its crown to the top of the moved ground, so check it on site.</li>
        ) : null}
        <li>On the map, α and β are drawn as triangles raised just clear of the ground they were fitted to, so the angle can be read against it.</li>
        <li>Hs needs a drone survey to suggest, and Lr and Wr need the road: measure them on site.</li>
        {missing ? <li>{missing} points had no elevation data and were left out.</li> : null}
      </ul>
    </details>
  );
}

function SectionDrawing() {
  const drone = useDroneSurveys()!;
  const { section } = drone;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] bg-[color:color-mix(in_oklab,var(--accent)_10%,var(--panel))] px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 basis-60">
        <b>Click the map</b> to place the section's points in order. {section.points.length ? `${section.points.length} placed.` : "None placed yet."}
      </span>
      <button type="button" className={button} disabled={!section.points.length} onClick={drone.undoSectionPoint}><Undo2 size={13} aria-hidden /> Undo point</button>
      <button type="button" className={button} onClick={drone.clearSection}>Cancel</button>
      <button type="button" className={primary} disabled={section.points.length < 2} onClick={drone.finishSection}><Check size={13} aria-hidden /> Finish</button>
    </div>
  );
}

/** Where the section runs: down the fall line, or along a line drawn on the map. */
function SectionControls({ line, lengthM }: { line: LonLat[] | null; lengthM: number }) {
  const drone = useDroneSurveys();
  if (!drone || drone.section.drawing) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted">
        {line ? `Your line, ${Math.round(lengthM * FT_PER_M).toLocaleString("en-US")} ft` : "Down the fall line"}
      </span>
      <button type="button" className={button} onClick={drone.startSection}>
        <PenLine size={13} aria-hidden /> {line ? "Redraw section line" : "Draw a section line"}
      </button>
      {line ? <button type="button" className={button} onClick={drone.clearSection}>Use the fall line</button> : null}
    </div>
  );
}

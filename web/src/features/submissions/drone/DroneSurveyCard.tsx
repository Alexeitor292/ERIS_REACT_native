import { useState, type ReactNode } from "react";
import { ArrowLeftRight, Crosshair, Layers, Loader2, Plane, Trash2, Upload, X } from "lucide-react";

import { FT_PER_M } from "../siteTerrainModel";
import { MAX_ARCHIVED_BYTES, useDroneSurveys, type NewSurvey } from "./DroneSurveyContext";
import { dateFromFileName, VERTICAL_UNIT_LABEL, type VerticalUnit } from "./readDroneFiles";
import { flownOutOfOrder, surveyTitle } from "./surveyLabels";

const button = "inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 text-xs font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50";
const input = "w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-2 py-1.5 text-xs";
const ft = (m: number | null | undefined) => (m == null ? "—" : `${(m * FT_PER_M).toFixed(1)} ft`);
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes > 10 * 1024 * 1024 ? 0 : 1)} MB`;

/**
 * Drone surveys under the 3D view: add one (its elevation file and
 * orthomosaic), compare it with the terrain model or an earlier survey, show
 * either in 3D, line its heights up with the terrain model, and capture points
 * on both surfaces.
 */
export default function DroneSurveyCard() {
  const drone = useDroneSurveys();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!drone) return null;
  const { active, baseline, surveys, canEdit } = drone;
  const survey = active?.survey ?? null;
  const beforeTitle = baseline ? surveyTitle(baseline.survey) : "terrain model";

  if (!surveys.length && !canEdit) return null;

  return (
    <section aria-labelledby="drone-survey-title" className="mt-3 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Plane size={15} className="text-[var(--accent)]" aria-hidden />
        <h3 id="drone-survey-title" className="text-sm font-semibold">Drone survey</h3>
        {surveys.length > 1 ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <label className="inline-flex items-center gap-1.5">
              <span className="font-semibold text-muted">Now</span>
              <select className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-xs" value={drone.activeId ?? ""} onChange={(e) => {
                const id = Number(e.target.value);
                if (id === drone.baselineId) drone.setBaselineId(null);
                drone.setActiveId(id);
              }}>
                {surveys.map((s) => <option key={s.id} value={s.id}>{surveyTitle(s)}</option>)}
              </select>
            </label>
            <label className="inline-flex items-center gap-1.5">
              <span className="font-semibold text-muted">compared with</span>
              <select className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-xs" value={drone.baselineId ?? ""} onChange={(e) => drone.setBaselineId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">Terrain model</option>
                {surveys.filter((s) => s.id !== drone.activeId).map((s) => <option key={s.id} value={s.id}>{surveyTitle(s)}</option>)}
              </select>
            </label>
          </div>
        ) : null}
        {canEdit && !adding ? (
          <button type="button" onClick={() => setAdding(true)} className={`${button} ml-auto`}>
            <Upload size={13} aria-hidden /> {surveys.length ? "Add another survey" : "Add a drone survey"}
          </button>
        ) : null}
      </div>
      {!surveys.length && !adding ? (
        <p className="mt-1 text-xs text-muted">
          Upload the elevation model (DSM or DEM GeoTIFF) and orthomosaic exported from DroneDeploy, Pix4D, Metashape or Site Scan. They are laid over the terrain model only where the drone flew, so you can compare the original ground with the ground now.
        </p>
      ) : null}
      {drone.error ? <p className="mt-2 text-xs text-[var(--bad)]">{drone.error}</p> : null}
      {error ? <p className="mt-2 text-xs text-[var(--bad)]">{error}</p> : null}

      {adding ? <AddSurvey onClose={() => setAdding(false)} onError={setError} /> : null}

      {survey && baseline && flownOutOfOrder(baseline.survey, survey) ? (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--warn-text)]">
          The survey compared with was flown after the one shown as now, so ground lost and gained read reversed.
          <button type="button" className={button} onClick={drone.swapBaseline}><ArrowLeftRight size={13} aria-hidden /> Swap them</button>
        </p>
      ) : null}

      {survey && active ? (
        <div className="mt-3 grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div role="radiogroup" aria-label="Ground shown in 3D" className="inline-flex overflow-hidden rounded-md border border-[var(--line)] text-xs font-medium">
              {[[false, `Before (${baseline ? baseline.survey.captured_on ?? "earlier survey" : "terrain model"})`], [true, `Now (drone${survey.captured_on ? `, ${survey.captured_on}` : ""})`]].map(([value, label]) => (
                <button key={String(value)} type="button" role="radio" aria-checked={drone.showSurface === value} onClick={() => drone.setShowSurface(value as boolean)}
                  className={`px-2.5 py-1.5 ${drone.showSurface === value ? "bg-[var(--accent)] text-white" : "bg-[var(--panel)] hover:bg-[var(--panel-soft)]"}`}>
                  {label as string}
                </button>
              ))}
            </div>
            {canEdit ? (
              <button type="button" onClick={() => drone.setCapturing(!drone.capturing)} className={`${button} ${drone.capturing ? "border-[var(--accent)] text-[var(--accent)]" : ""}`} aria-pressed={drone.capturing}>
                <Crosshair size={13} aria-hidden /> {drone.capturing ? "Click the 3D view to capture · stop" : "Capture points"}
              </button>
            ) : null}
          </div>

          <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
            <Fact label="Flown">{survey.captured_on ?? "date not given"}{survey.source ? ` · ${survey.source}` : ""}</Fact>
            <Fact label="Files">{[survey.dsm_filename, survey.ortho_filename].filter(Boolean).join(" · ") || "—"}</Fact>
            <Fact label="Patch">{survey.cols} × {survey.rows} cells{survey.resolution_m ? ` · ${(survey.resolution_m * FT_PER_M).toFixed(2)} ft (${survey.resolution_m.toFixed(2)} m) each` : ""}{survey.source_crs ? ` · from ${survey.source_crs}` : ""}</Fact>
            <Fact label="Lined up">
              <OffsetEditor key={survey.id} />
            </Fact>
          </dl>

          <Points />

          {canEdit ? (
            <div className="flex justify-end">
              <button
                type="button"
                className={`${button} text-[var(--bad)]`}
                onClick={async () => {
                  if (!window.confirm("Remove this drone survey from the form? Its original files stay in the Measurements attachments.")) return;
                  try { await drone.remove(survey.id); } catch (e) { setError(e instanceof Error ? e.message : "Could not remove the survey."); }
                }}
              >
                <Trash2 size={13} aria-hidden /> Remove survey
              </button>
            </div>
          ) : null}
        </div>
      ) : surveys.length ? <p className="mt-2 text-xs text-muted"><Loader2 size={12} className="mr-1 inline animate-spin" aria-hidden />Loading the survey…</p> : null}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="shrink-0 font-semibold text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function OffsetEditor() {
  const drone = useDroneSurveys()!;
  const survey = drone.active!.survey;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(survey.vertical_offset_m));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const spread = survey.stats?.alignment_spread_m as number | null | undefined;
  const description =
    survey.offset_mode === "NONE"
      ? "drone heights used as they are"
      : `${survey.vertical_offset_m >= 0 ? "+" : ""}${survey.vertical_offset_m.toFixed(2)} m added to the drone heights${survey.offset_mode === "AUTO" ? " (from stable ground)" : " (set by hand)"}`;
  if (!editing) {
    return (
      <span>
        {description}
        {survey.offset_mode === "AUTO" && spread != null ? <span className="text-muted"> · agree within ±{(spread * FT_PER_M).toFixed(1)} ft</span> : null}
        {note ? <span className="text-muted"> · {note}</span> : null}
        {drone.canEdit ? (
          <>
            {" "}
            <button type="button" className="text-[var(--brand)] hover:underline" onClick={() => setEditing(true)}>Change</button>
          </>
        ) : null}
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <input className="w-20 rounded border border-[var(--line)] bg-[var(--panel)] px-1.5 py-0.5 text-xs" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Offset added to the drone heights, metres" /> m
      <button type="button" className={button} disabled={busy || !Number.isFinite(Number(value))} onClick={async () => {
        setBusy(true);
        try { await drone.update(survey.id, { vertical_offset_m: Number(value), offset_mode: "MANUAL" }); setEditing(false); } finally { setBusy(false); }
      }}>Save</button>
      <button type="button" className={button} disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          const result = await drone.realign();
          setNote(result ? "lined up again on stable ground" : "not enough stable ground to line up");
          setEditing(false);
        } finally { setBusy(false); }
      }}>Line up again</button>
      <button type="button" className={button} disabled={busy} onClick={async () => {
        setBusy(true);
        try { await drone.update(survey.id, { vertical_offset_m: 0, offset_mode: "NONE" }); setEditing(false); } finally { setBusy(false); }
      }}>Use drone heights as they are</button>
      <button type="button" aria-label="Cancel" className="p-1" onClick={() => setEditing(false)}><X size={13} /></button>
    </span>
  );
}

function Points() {
  const drone = useDroneSurveys()!;
  const points = drone.active!.survey.points;
  // Each point keeps the terrain model's height; compared with an earlier survey, "before" is that survey's.
  const beforeAt = (p: { lon: number; lat: number; historical_m: number | null }) => (drone.baseline ? drone.baselineAt(p.lon, p.lat) : p.historical_m);
  if (!points.length) {
    return drone.canEdit ? <p className="text-xs text-muted">No points yet. <b>Capture points</b>, then click the 3D view: each point records the ground before and the ground now (the drone).</p> : null;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[28rem] text-xs tabular-nums">
        <thead className="text-left text-muted">
          <tr><th className="py-1 pr-2 font-semibold">Point</th><th className="pr-2 font-semibold">Before</th><th className="pr-2 font-semibold">Now</th><th className="pr-2 font-semibold">Change</th><th className="pr-2 font-semibold">Where</th><th /></tr>
        </thead>
        <tbody>
          {points.map((p) => {
            const before = beforeAt(p);
            const change = before != null && p.actual_m != null ? p.actual_m - before : null;
            return (
              <tr key={p.id} className="border-t border-[var(--line)]">
                <td className="py-1 pr-2 font-semibold">{p.label ?? "—"}</td>
                <td className="pr-2">{drone.baseline && before == null ? <span className="text-muted">outside the earlier survey</span> : ft(before)}</td>
                <td className="pr-2">{p.actual_m == null ? <span className="text-muted">outside the survey</span> : ft(p.actual_m)}</td>
                <td className={`pr-2 font-semibold ${change == null ? "" : change < 0 ? "text-[var(--bad)]" : "text-[var(--good)]"}`}>{change == null ? "—" : `${change > 0 ? "+" : ""}${(change * FT_PER_M).toFixed(1)} ft`}</td>
                <td className="pr-2 text-muted">{p.lat.toFixed(6)}, {p.lon.toFixed(6)}</td>
                <td className="text-right">
                  {drone.canEdit ? <button type="button" aria-label={`Remove ${p.label ?? "point"}`} className="p-1 text-muted hover:text-[var(--bad)]" onClick={() => drone.removePoint(p.id)}><X size={12} /></button> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AddSurvey({ onClose, onError }: { onClose: () => void; onError: (message: string | null) => void }) {
  const drone = useDroneSurveys()!;
  const [dsm, setDsm] = useState<File | null>(null);
  const [ortho, setOrtho] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const [capturedOn, setCapturedOn] = useState("");
  const [source, setSource] = useState("DroneDeploy");
  const [unit, setUnit] = useState<VerticalUnit | "">("");
  const [alignment, setAlignment] = useState<NewSurvey["alignment"]>("AUTO");
  const [progress, setProgress] = useState<{ fraction: number; message: string } | null>(null);

  async function start() {
    if (!dsm) return;
    onError(null);
    setProgress({ fraction: 0, message: "Starting…" });
    try {
      await drone.upload(
        { dsm, ortho, label, capturedOn: capturedOn || null, source, verticalUnit: unit || undefined, alignment },
        (fraction, message) => setProgress({ fraction, message }),
      );
      onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not read the drone survey.");
    } finally {
      setProgress(null);
    }
  }

  const tooBig = [dsm, ortho].filter((f): f is File => !!f && f.size > MAX_ARCHIVED_BYTES);
  return (
    <div className="mt-3 grid gap-2.5 rounded-lg border border-dashed border-[var(--line)] bg-[var(--panel-soft)] p-3">
      <div className="grid gap-2.5 sm:grid-cols-2">
        <label className="grid gap-1 text-xs">
          <span className="font-semibold">Elevation model (DSM or DEM GeoTIFF) *</span>
          <input type="file" accept=".tif,.tiff,image/tiff" onChange={(e) => {
            const file = e.target.files?.[0] ?? null;
            setDsm(file);
            if (file && !capturedOn) setCapturedOn(dateFromFileName(file.name) ?? "");
          }} />
          {dsm ? <span className="text-muted">{dsm.name} · {mb(dsm.size)}</span> : null}
        </label>
        <label className="grid gap-1 text-xs">
          <span className="font-semibold">Orthomosaic (GeoTIFF, optional)</span>
          <input type="file" accept=".tif,.tiff,image/tiff" onChange={(e) => setOrtho(e.target.files?.[0] ?? null)} />
          {ortho ? <span className="text-muted">{ortho.name} · {mb(ortho.size)}</span> : null}
        </label>
        <label className="grid gap-1 text-xs"><span className="font-semibold">Name</span><input className={input} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="After the storm" /></label>
        <label className="grid gap-1 text-xs"><span className="font-semibold">Flight date</span><input type="date" className={input} value={capturedOn} onChange={(e) => setCapturedOn(e.target.value)} /></label>
        <label className="grid gap-1 text-xs"><span className="font-semibold">Made with</span><input className={input} value={source} onChange={(e) => setSource(e.target.value)} placeholder="DroneDeploy" /></label>
        <label className="grid gap-1 text-xs">
          <span className="font-semibold">Heights in the file</span>
          <select className={input} value={unit} onChange={(e) => setUnit(e.target.value as VerticalUnit | "")}>
            <option value="">As the file says (metres if it says nothing)</option>
            {(Object.keys(VERTICAL_UNIT_LABEL) as VerticalUnit[]).map((u) => <option key={u} value={u}>{VERTICAL_UNIT_LABEL[u]}</option>)}
          </select>
        </label>
      </div>
      <fieldset className="grid gap-1 text-xs">
        <legend className="font-semibold">Line the heights up with the terrain model</legend>
        <label className="flex items-start gap-1.5"><input type="radio" checked={alignment === "AUTO"} onChange={() => setAlignment("AUTO")} /> <span>Yes, on the ground that did not move (recommended: drone heights are often on another datum or have no ground control)</span></label>
        <label className="flex items-start gap-1.5"><input type="radio" checked={alignment === "NONE"} onChange={() => setAlignment("NONE")} /> <span>No, the survey is tied to NAVD88 with ground control points</span></label>
      </fieldset>
      {tooBig.length ? (
        <p className="text-xs text-[var(--warn-text)]">
          {tooBig.map((f) => f.name).join(" and ")} {tooBig.length > 1 ? "are" : "is"} over {mb(MAX_ARCHIVED_BYTES)}: ERIS keeps the survey it reads from {tooBig.length > 1 ? "them" : "it"}, but not the original file. Keep it in your drone software.
        </p>
      ) : null}
      {progress ? (
        <div aria-live="polite" className="grid gap-1 text-xs">
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--line)]"><div className="h-full bg-[var(--accent)] transition-[width]" style={{ width: `${Math.round(progress.fraction * 100)}%` }} /></div>
          <span className="text-muted">{progress.message}</span>
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <button type="button" className={button} onClick={onClose} disabled={!!progress}>Cancel</button>
        <button type="button" onClick={start} disabled={!dsm || !!progress} className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
          {progress ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Layers size={13} aria-hidden />} Read and add the survey
        </button>
      </div>
    </div>
  );
}

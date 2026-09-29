import { useState, type PointerEvent } from "react";

import { FT_PER_M, type LonLat } from "../siteTerrainModel";

/** A spot on the section: how far along, where, and the ground before and now there (metres). */
export type ProfilePoint = { distanceM: number; point?: LonLat; historical: number | null; actual: number | null };

const W = 640;
const PAD = { left: 52, right: 14, top: 16, bottom: 34 };
const PLOT_W = W - PAD.left - PAD.right;
// The section is drawn to scale (a foot up as long as a foot across) when that
// fits between these heights; otherwise heights are stretched or squeezed, and
// the caption says by how much.
const MIN_PLOT_H = 150;
const MAX_PLOT_H = 380;

function niceStep(span: number, target: number): number {
  const raw = span / target;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit < 1.5 ? 1 : unit < 3 ? 2 : unit < 7 ? 5 : 10) * power;
}

function path(points: Array<[number, number] | null>): string {
  let d = "";
  let pen = false;
  for (const p of points) {
    if (!p) { pen = false; continue; }
    d += `${pen ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
    pen = true;
  }
  return d;
}

/**
 * The slope in section, down the fall line: the ground before (terrain model
 * or an earlier survey) dashed, the ground now (drone survey) solid, and the
 * ground lost or gained between them shaded. Heights and distances in feet,
 * at true scale whenever it fits, so the slope looks as steep as its angle says.
 */
export default function SlopeProfileDiagram({
  profile,
  originalSlopeDeg,
  newSlopeDeg,
  originalHeightM,
  newHeightM,
  beforeTitle,
  nowTitle,
  axisLabel = "Distance down the slope (ft)",
  onHover,
}: {
  profile: ProfilePoint[];
  originalSlopeDeg: number;
  newSlopeDeg: number;
  originalHeightM: number;
  newHeightM: number;
  /** What each line is: "terrain model", or a survey's name and date. */
  beforeTitle: string;
  nowTitle: string;
  axisLabel?: string;
  /** The spot the pointer is over (an index into `profile`), or null when it leaves. */
  onHover?: (index: number | null) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const heights = profile.flatMap((p) => [p.historical, p.actual]).filter((v): v is number => v != null).map((m) => m * FT_PER_M);
  if (heights.length < 4) return null;
  const maxDist = (profile[profile.length - 1]?.distanceM ?? 1) * FT_PER_M;
  const [zLo, zHi] = [Math.min(...heights), Math.max(...heights)];
  const zPad = Math.max(2, (zHi - zLo) * 0.08);
  const [z0, z1] = [zLo - zPad, zHi + zPad];
  const naturalH = (PLOT_W * (z1 - z0)) / maxDist;
  const plotH = Math.min(MAX_PLOT_H, Math.max(MIN_PLOT_H, naturalH));
  const exaggeration = plotH / naturalH;
  const H = PAD.top + plotH + PAD.bottom;
  const x = (dFt: number) => PAD.left + (dFt / maxDist) * PLOT_W;
  const y = (zFt: number) => PAD.top + (1 - (zFt - z0) / (z1 - z0)) * plotH;
  const at = (p: ProfilePoint, key: "historical" | "actual"): [number, number] | null => (p[key] == null ? null : [x(p.distanceM * FT_PER_M), y(p[key]! * FT_PER_M)]);
  const before = profile.map((p) => at(p, "historical"));
  const after = profile.map((p) => at(p, "actual"));
  const zStep = niceStep(z1 - z0, Math.max(3, Math.round(plotH / 50)));
  const dStep = niceStep(maxDist, 6);
  const zTicks: number[] = [];
  for (let v = Math.ceil(z0 / zStep) * zStep; v <= z1; v += zStep) zTicks.push(v);
  const dTicks: number[] = [];
  for (let v = 0; v <= maxDist + 1e-6; v += dStep) dTicks.push(v);

  // Shade between the two lines wherever both exist, red where ground was lost, green where gained.
  // The pointer's spot: the sample nearest its distance along the section.
  const pick = (event: PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const dFt = ((event.clientX - box.left) / box.width) * maxDist;
    let best = 0;
    for (let i = 1; i < profile.length; i += 1) {
      if (Math.abs(profile[i].distanceM * FT_PER_M - dFt) < Math.abs(profile[best].distanceM * FT_PER_M - dFt)) best = i;
    }
    if (best !== hover) {
      setHover(best);
      onHover?.(best);
    }
  };
  const leave = () => {
    setHover(null);
    onHover?.(null);
  };
  const spot = hover != null ? profile[hover] : null;
  const feet = (m: number | null) => (m == null ? "—" : `${Math.round(m * FT_PER_M).toLocaleString("en-US")} ft`);
  const readout = spot
    ? [
        `${Math.round(spot.distanceM * FT_PER_M).toLocaleString("en-US")} ft along`,
        `before ${feet(spot.historical)}`,
        `now ${feet(spot.actual)}`,
        spot.historical != null && spot.actual != null
          ? `${spot.actual >= spot.historical ? "+" : "−"}${Math.abs((spot.actual - spot.historical) * FT_PER_M).toFixed(1)} ft`
          : "",
      ].filter(Boolean).join(" · ")
    : null;

  const bands = profile.slice(1).flatMap((p, i) => {
    const q = profile[i];
    if (p.historical == null || p.actual == null || q.historical == null || q.actual == null) return [];
    const lost = (p.actual + q.actual) / 2 < (p.historical + q.historical) / 2;
    const pts = [at(q, "historical")!, at(p, "historical")!, at(p, "actual")!, at(q, "actual")!];
    return [{ d: `M${pts.map((pt) => pt.join(",")).join("L")}Z`, lost }];
  });

  return (
    <figure className="mt-3">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Section down the slope: before ${originalSlopeDeg.toFixed(1)} degrees, now ${newSlopeDeg.toFixed(1)} degrees`} className="h-auto w-full">
        <rect x={PAD.left} y={PAD.top} width={W - PAD.left - PAD.right} height={H - PAD.top - PAD.bottom} fill="var(--panel-soft)" />
        {zTicks.map((v) => (
          <g key={`z${v}`}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth={1} />
            <text x={PAD.left - 6} y={y(v) + 3.5} textAnchor="end" fontSize={10} fill="var(--muted)">{Math.round(v)}</text>
          </g>
        ))}
        {dTicks.map((v) => (
          <text key={`d${v}`} x={x(v)} y={H - PAD.bottom + 14} textAnchor="middle" fontSize={10} fill="var(--muted)">{Math.round(v)}</text>
        ))}
        <text x={PAD.left + (W - PAD.left - PAD.right) / 2} y={H - 4} textAnchor="middle" fontSize={10} fill="var(--muted)">{axisLabel}</text>
        <text x={12} y={PAD.top + (H - PAD.top - PAD.bottom) / 2} textAnchor="middle" fontSize={10} fill="var(--muted)" transform={`rotate(-90 12 ${PAD.top + (H - PAD.top - PAD.bottom) / 2})`}>Elevation (ft)</text>
        {bands.map((band, i) => <path key={i} d={band.d} fill={band.lost ? "#dc2626" : "#16a34a"} fillOpacity={0.22} stroke="none" />)}
        <path d={path(before)} fill="none" stroke="var(--muted)" strokeWidth={2} strokeDasharray="6 4" />
        <path d={path(after)} fill="none" stroke="var(--accent)" strokeWidth={2.5} />
        {spot ? (
          <g pointerEvents="none">
            <line x1={x(spot.distanceM * FT_PER_M)} x2={x(spot.distanceM * FT_PER_M)} y1={PAD.top} y2={PAD.top + plotH} stroke="#ca8a04" strokeWidth={1.5} />
            {spot.historical != null ? <circle cx={x(spot.distanceM * FT_PER_M)} cy={y(spot.historical * FT_PER_M)} r={3.5} fill="var(--muted)" /> : null}
            {spot.actual != null ? <circle cx={x(spot.distanceM * FT_PER_M)} cy={y(spot.actual * FT_PER_M)} r={4} fill="var(--accent)" stroke="white" strokeWidth={1} /> : null}
          </g>
        ) : null}
        <rect x={PAD.left} y={PAD.top} width={PLOT_W} height={plotH} fill="transparent" onPointerMove={pick} onPointerLeave={leave} style={{ cursor: "crosshair" }} />
      </svg>
      <p className="mt-1 min-h-4 text-xs tabular-nums text-muted" aria-live="polite">{readout ?? "Point at the section to read the ground there; the spot shows in the 3D view."}</p>
      <figcaption className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-5 border-t-2 border-dashed border-[var(--muted)]" aria-hidden />Before ({beforeTitle}): {originalSlopeDeg.toFixed(1)}°, {Math.round(originalHeightM * FT_PER_M)} ft high</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-5 border-t-2 border-[var(--accent)]" aria-hidden />Now ({nowTitle}): {newSlopeDeg.toFixed(1)}°, {Math.round(newHeightM * FT_PER_M)} ft high</span>
        <span className="text-muted">Shaded: ground lost (red) and gained (green)</span>
        <span className="text-muted">{scaleNote(exaggeration)}</span>
      </figcaption>
    </figure>
  );
}

/** How the section's heights relate to its distances. */
export function scaleNote(exaggeration: number): string {
  if (!Number.isFinite(exaggeration) || exaggeration <= 0) return "";
  if (Math.abs(exaggeration - 1) < 0.03) return "True scale: heights and distances drawn alike";
  return exaggeration > 1
    ? `Heights stretched ×${exaggeration.toFixed(1)} so a gentle slope reads`
    : `Heights squeezed ×${exaggeration.toFixed(2)} to fit a steep, short slope`;
}

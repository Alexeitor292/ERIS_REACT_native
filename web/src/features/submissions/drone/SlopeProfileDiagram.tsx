import { useState, type PointerEvent } from "react";

import { FT_PER_M, type LonLat } from "../siteTerrainModel";

/** A spot on the section: how far along, where, and the ground before and now there (metres). */
export type ProfilePoint = {
  distanceM: number;
  point?: LonLat;
  historical: number | null;
  /** The ground before here was the sea surface (the earlier survey saw water), not a surveyed height. */
  historicalSea?: boolean;
  actual: number | null;
};

const W = 640;
const PAD = { left: 52, right: 14, top: 16, bottom: 34 };
const PLOT_W = W - PAD.left - PAD.right;
// The section is drawn to scale (a foot up as long as a foot across) when that
// fits between these heights; otherwise heights are stretched or squeezed, and
// the caption says by how much.
const MIN_PLOT_H = 150;
const MAX_PLOT_H = 380;
/** The displacement chart under the section, on the same distances. */
const DISPLACEMENT_H = 96;
const DISPLACEMENT_GAP = 22;
const LOST = "#c2570c";
const GAINED = "#1478a6";

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
 * Under it, the displacement along the same line. Without a survey there is
 * only the one ground, drawn solid.
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
  /** With a drone survey: what each ground measured, for the legend. */
  originalSlopeDeg?: number;
  newSlopeDeg?: number;
  originalHeightM?: number;
  newHeightM?: number;
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
  // Displacement: where both grounds have a height, how far the ground moved.
  const hasNow = profile.some((p) => p.actual != null);
  const changes = profile.map((p) => (p.historical != null && p.actual != null ? (p.actual - p.historical) * FT_PER_M : null));
  const known = changes.filter((c): c is number => c != null);
  const showDisplacement = hasNow && known.length >= 2;
  const biggest = Math.max(1, ...known.map(Math.abs));
  const deepest = known.length ? Math.min(...known) : 0;
  const highest = known.length ? Math.max(...known) : 0;
  const zeroY = PAD.top + plotH + DISPLACEMENT_GAP + DISPLACEMENT_H / 2;
  const changeY = (c: number) => zeroY - (c / biggest) * (DISPLACEMENT_H / 2 - 4);
  const chartBottom = showDisplacement ? PAD.top + plotH + DISPLACEMENT_GAP + DISPLACEMENT_H : PAD.top + plotH;
  const H = chartBottom + PAD.bottom;
  const x = (dFt: number) => PAD.left + (dFt / maxDist) * PLOT_W;
  const y = (zFt: number) => PAD.top + (1 - (zFt - z0) / (z1 - z0)) * plotH;
  const at = (p: ProfilePoint, key: "historical" | "actual"): [number, number] | null => (p[key] == null ? null : [x(p.distanceM * FT_PER_M), y(p[key]! * FT_PER_M)]);
  // The before line: surveyed ground grey, the sea surface blue (each joined to where the other ends).
  const seaAt = (i: number) => !!profile[i]?.historicalSea;
  const before = profile.map((p, i) => (seaAt(i) && seaAt(i - 1) ? null : at(p, "historical")));
  const beforeSea = profile.map((p, i) => (seaAt(i) || seaAt(i - 1) ? at(p, "historical") : null));
  const hasSea = profile.some((p) => p.historicalSea);
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
        hasNow ? `before ${feet(spot.historical)}` : feet(spot.historical),
        hasNow ? `now ${feet(spot.actual)}` : "",
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
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={hasNow && originalSlopeDeg != null && newSlopeDeg != null ? `Section down the slope: before ${originalSlopeDeg.toFixed(1)} degrees, now ${newSlopeDeg.toFixed(1)} degrees` : "Section down the slope"} className="h-auto w-full">
        <rect x={PAD.left} y={PAD.top} width={PLOT_W} height={plotH} fill="var(--panel-soft)" />
        {zTicks.map((v) => (
          <g key={`z${v}`}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth={1} />
            <text x={PAD.left - 6} y={y(v) + 3.5} textAnchor="end" fontSize={10} fill="var(--muted)">{Math.round(v)}</text>
          </g>
        ))}
        {dTicks.map((v) => (
          <text key={`d${v}`} x={x(v)} y={chartBottom + 14} textAnchor="middle" fontSize={10} fill="var(--muted)">{Math.round(v)}</text>
        ))}
        <text x={PAD.left + (W - PAD.left - PAD.right) / 2} y={H - 4} textAnchor="middle" fontSize={10} fill="var(--muted)">{axisLabel}</text>
        <text x={12} y={PAD.top + plotH / 2} textAnchor="middle" fontSize={10} fill="var(--muted)" transform={`rotate(-90 12 ${PAD.top + plotH / 2})`}>Elevation (ft)</text>
        {bands.map((band, i) => <path key={i} d={band.d} fill={band.lost ? LOST : GAINED} fillOpacity={0.28} stroke="none" />)}
        <path d={path(before)} fill="none" stroke={hasNow ? "var(--muted)" : "var(--accent)"} strokeWidth={hasNow ? 2 : 2.5} strokeDasharray={hasNow ? "6 4" : undefined} />
        {hasSea ? <path d={path(beforeSea)} fill="none" stroke="#0284c7" strokeWidth={2} strokeDasharray="6 4" /> : null}
        <path d={path(after)} fill="none" stroke="var(--accent)" strokeWidth={2.5} />
        {showDisplacement ? (
          <g>
            <rect x={PAD.left} y={PAD.top + plotH + DISPLACEMENT_GAP} width={PLOT_W} height={DISPLACEMENT_H} fill="var(--panel-soft)" />
            <text x={PAD.left} y={PAD.top + plotH + DISPLACEMENT_GAP - 5} fontSize={10} fontWeight={600} fill="var(--ink)">Displacement along this line (ft)</text>
            {changes.slice(1).map((c, i) => {
              const previous = changes[i];
              if (c == null || previous == null) return null;
              const [x0, x1] = [x(profile[i].distanceM * FT_PER_M), x(profile[i + 1].distanceM * FT_PER_M)];
              return (
                <path
                  key={`c${i}`}
                  d={`M${x0.toFixed(1)},${zeroY}L${x0.toFixed(1)},${changeY(previous).toFixed(1)}L${x1.toFixed(1)},${changeY(c).toFixed(1)}L${x1.toFixed(1)},${zeroY}Z`}
                  fill={c + previous < 0 ? LOST : GAINED}
                  fillOpacity={0.75}
                />
              );
            })}
            <line x1={PAD.left} x2={W - PAD.right} y1={zeroY} y2={zeroY} stroke="var(--muted)" strokeWidth={1} />
            <text x={PAD.left - 6} y={zeroY + 3.5} textAnchor="end" fontSize={10} fill="var(--muted)">0</text>
            {highest > 0 ? <text x={PAD.left - 6} y={changeY(highest) + 3.5} textAnchor="end" fontSize={10} fill={GAINED}>+{highest.toFixed(1)}</text> : null}
            {deepest < 0 ? <text x={PAD.left - 6} y={changeY(deepest) + 3.5} textAnchor="end" fontSize={10} fill={LOST}>−{Math.abs(deepest).toFixed(1)}</text> : null}
          </g>
        ) : null}
        {spot ? (
          <g pointerEvents="none">
            <line x1={x(spot.distanceM * FT_PER_M)} x2={x(spot.distanceM * FT_PER_M)} y1={PAD.top} y2={chartBottom} stroke="#ca8a04" strokeWidth={1.5} />
            {spot.historical != null ? <circle cx={x(spot.distanceM * FT_PER_M)} cy={y(spot.historical * FT_PER_M)} r={3.5} fill="var(--muted)" /> : null}
            {spot.actual != null ? <circle cx={x(spot.distanceM * FT_PER_M)} cy={y(spot.actual * FT_PER_M)} r={4} fill="var(--accent)" stroke="white" strokeWidth={1} /> : null}
          </g>
        ) : null}
        <rect x={PAD.left} y={PAD.top} width={PLOT_W} height={chartBottom - PAD.top} fill="transparent" onPointerMove={pick} onPointerLeave={leave} style={{ cursor: "crosshair" }} />
      </svg>
      <p className="mt-1 min-h-4 text-xs tabular-nums text-muted" aria-live="polite">{readout ?? "Point at the graph to read the ground there; the spot shows on the map."}</p>
      <figcaption className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {hasNow ? (
          <>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-5 border-t-2 border-dashed border-[var(--muted)]" aria-hidden />
              Before ({beforeTitle}){originalSlopeDeg != null && originalHeightM != null ? `: ${originalSlopeDeg.toFixed(1)}°, ${Math.round(originalHeightM * FT_PER_M)} ft high` : ""}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-5 border-t-2 border-[var(--accent)]" aria-hidden />
              Now ({nowTitle}){newSlopeDeg != null && newHeightM != null ? `: ${newSlopeDeg.toFixed(1)}°, ${Math.round(newHeightM * FT_PER_M)} ft high` : ""}
            </span>
          </>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-5 border-t-2 border-[var(--accent)]" aria-hidden />
            {beforeTitle}
          </span>
        )}
        {hasSea ? (
          <span className="inline-flex items-center gap-1.5"><span className="inline-block w-5 border-t-2 border-dashed border-[#0284c7]" aria-hidden />Before: sea level where the earlier survey saw sea</span>
        ) : null}
        {hasNow ? <span className="text-muted">Orange: ground lost. Blue: ground gained.</span> : null}
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

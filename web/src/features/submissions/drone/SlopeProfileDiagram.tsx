import { FT_PER_M } from "../siteTerrainModel";

export type ProfilePoint = { distanceM: number; historical: number | null; actual: number | null };

const W = 640;
const H = 250;
const PAD = { left: 52, right: 14, top: 16, bottom: 34 };

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
 * The slope in section, down the fall line: the original ground (terrain
 * model) dashed, the ground now (drone survey) solid, and the ground lost or
 * gained between them shaded. Heights and distances in feet, not exaggerated
 * more than the chart's proportions require.
 */
export default function SlopeProfileDiagram({
  profile,
  originalSlopeDeg,
  newSlopeDeg,
  originalHeightM,
  newHeightM,
  capturedOn,
}: {
  profile: ProfilePoint[];
  originalSlopeDeg: number;
  newSlopeDeg: number;
  originalHeightM: number;
  newHeightM: number;
  capturedOn: string | null;
}) {
  const heights = profile.flatMap((p) => [p.historical, p.actual]).filter((v): v is number => v != null).map((m) => m * FT_PER_M);
  if (heights.length < 4) return null;
  const maxDist = (profile[profile.length - 1]?.distanceM ?? 1) * FT_PER_M;
  const [zLo, zHi] = [Math.min(...heights), Math.max(...heights)];
  const zPad = Math.max(2, (zHi - zLo) * 0.08);
  const [z0, z1] = [zLo - zPad, zHi + zPad];
  const x = (dFt: number) => PAD.left + (dFt / maxDist) * (W - PAD.left - PAD.right);
  const y = (zFt: number) => PAD.top + (1 - (zFt - z0) / (z1 - z0)) * (H - PAD.top - PAD.bottom);
  const at = (p: ProfilePoint, key: "historical" | "actual"): [number, number] | null => (p[key] == null ? null : [x(p.distanceM * FT_PER_M), y(p[key]! * FT_PER_M)]);
  const before = profile.map((p) => at(p, "historical"));
  const after = profile.map((p) => at(p, "actual"));
  const zStep = niceStep(z1 - z0, 5);
  const dStep = niceStep(maxDist, 6);
  const zTicks: number[] = [];
  for (let v = Math.ceil(z0 / zStep) * zStep; v <= z1; v += zStep) zTicks.push(v);
  const dTicks: number[] = [];
  for (let v = 0; v <= maxDist + 1e-6; v += dStep) dTicks.push(v);

  // Shade between the two lines wherever both exist, red where ground was lost, green where gained.
  const bands = profile.slice(1).flatMap((p, i) => {
    const q = profile[i];
    if (p.historical == null || p.actual == null || q.historical == null || q.actual == null) return [];
    const lost = (p.actual + q.actual) / 2 < (p.historical + q.historical) / 2;
    const pts = [at(q, "historical")!, at(p, "historical")!, at(p, "actual")!, at(q, "actual")!];
    return [{ d: `M${pts.map((pt) => pt.join(",")).join("L")}Z`, lost }];
  });

  return (
    <figure className="mt-3">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Section down the slope: original ground ${originalSlopeDeg.toFixed(1)} degrees, ground now ${newSlopeDeg.toFixed(1)} degrees`} className="h-auto w-full">
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
        <text x={PAD.left + (W - PAD.left - PAD.right) / 2} y={H - 4} textAnchor="middle" fontSize={10} fill="var(--muted)">Distance down the slope (ft)</text>
        <text x={12} y={PAD.top + (H - PAD.top - PAD.bottom) / 2} textAnchor="middle" fontSize={10} fill="var(--muted)" transform={`rotate(-90 12 ${PAD.top + (H - PAD.top - PAD.bottom) / 2})`}>Elevation (ft)</text>
        {bands.map((band, i) => <path key={i} d={band.d} fill={band.lost ? "#dc2626" : "#16a34a"} fillOpacity={0.22} stroke="none" />)}
        <path d={path(before)} fill="none" stroke="var(--muted)" strokeWidth={2} strokeDasharray="6 4" />
        <path d={path(after)} fill="none" stroke="var(--accent)" strokeWidth={2.5} />
      </svg>
      <figcaption className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-5 border-t-2 border-dashed border-[var(--muted)]" aria-hidden />Original ground (terrain model): {originalSlopeDeg.toFixed(1)}°, {Math.round(originalHeightM * FT_PER_M)} ft high</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-5 border-t-2 border-[var(--accent)]" aria-hidden />Ground now (drone{capturedOn ? `, ${capturedOn}` : ""}): {newSlopeDeg.toFixed(1)}°, {Math.round(newHeightM * FT_PER_M)} ft high</span>
        <span className="text-muted">Shaded: ground lost (red) and gained (green)</span>
      </figcaption>
    </figure>
  );
}

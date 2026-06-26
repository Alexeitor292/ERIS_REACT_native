import { useMemo, type ReactElement } from "react";
import type { GisaTerrainGrid } from "../api/types";

// Lightweight 3D Terrain / Terrain Relief view.
//
// Renders the ACTUAL road-aligned USGS 3DEP / EPQS elevation grid as an oblique
// (axonometric) surface mesh in plain SVG — no 3D engine. The relief is built
// only from sampled points; cells with a missing USGS sample are left as gaps
// (no synthetic elevations).

const C = {
  road: "#f8fafc",
  marker: "#ef4444",
  edge: "#0b1220",
  text: "#94a3b8",
  ink: "#e2e8f0",
};

// Hypsometric ramp (low -> high). Interpolated for fill color.
const RAMP: Array<[number, [number, number, number]]> = [
  [0.0, [42, 78, 110]], // deep blue-green
  [0.25, [63, 125, 79]], // green
  [0.5, [150, 150, 96]], // tan
  [0.75, [150, 110, 78]], // brown
  [1.0, [236, 236, 236]], // light (high)
];

function rampColor(t: number): string {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 0; i < RAMP.length - 1; i++) {
    const [a, ca] = RAMP[i];
    const [b, cb] = RAMP[i + 1];
    if (x >= a && x <= b) {
      const f = b === a ? 0 : (x - a) / (b - a);
      const r = Math.round(ca[0] + (cb[0] - ca[0]) * f);
      const g = Math.round(ca[1] + (cb[1] - ca[1]) * f);
      const bl = Math.round(ca[2] + (cb[2] - ca[2]) * f);
      return `rgb(${r},${g},${bl})`;
    }
  }
  return "rgb(236,236,236)";
}

const M_TO_FT = 3.280839895;

export function TerrainRelief({ terrain }: { terrain: GisaTerrainGrid | null | undefined }) {
  const grid = terrain?.grid ?? null;
  const valid = grid?.valid_sample_count ?? 0;

  const view = useMemo(() => {
    if (!grid || !grid.points?.length) return null;
    const rows = grid.rows;
    const cols = grid.columns;
    // index lookup
    const elev: (number | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null));
    let lat: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));
    let lon: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));
    let min = Infinity;
    let max = -Infinity;
    for (const p of grid.points) {
      if (p.row < 0 || p.row >= rows || p.column < 0 || p.column >= cols) continue;
      elev[p.row][p.column] = p.elevation_ft;
      lat[p.row][p.column] = p.lat;
      lon[p.row][p.column] = p.lon;
      if (p.elevation_ft != null) {
        min = Math.min(min, p.elevation_ft);
        max = Math.max(max, p.elevation_ft);
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    return { rows, cols, elev, lat, lon, min, max, relief: Math.max(1, max - min) };
  }, [grid]);

  if (!terrain || !grid || valid === 0 || !view) {
    return (
      <div className="rounded border border-[var(--line)] bg-[var(--panel-soft)] p-4 text-center text-xs text-muted">
        <div className="mb-1 font-semibold text-[var(--ink)]">3D Terrain</div>
        {terrain?.error ? <div className="text-[var(--error)]">{terrain.error}</div> : <div>No terrain elevation data yet. Build the grid to sample USGS 3DEP around this location.</div>}
      </div>
    );
  }

  const { rows, cols, elev, min, max, relief } = view;

  // Oblique projection layout.
  const W = 560;
  const H = 360;
  const padX = 40;
  const padTop = 28;
  const dx = (W - 2 * padX) / (cols - 1 + (rows - 1) * 0.45); // cross spacing, leaving room for shear
  const shearX = dx * 0.45; // per-row horizontal shear (depth)
  const dy = Math.max(8, ((H - padTop - 70) - 90) / Math.max(1, rows - 1)); // row depth down-screen
  const zHeight = 90; // vertical elevation displacement (px)

  const px = (r: number, c: number) => padX + c * dx + r * shearX;
  const py = (r: number, c: number, e: number) => padTop + 70 + r * dy - ((e - min) / relief) * zHeight;

  const centerRow = (rows - 1) / 2;
  const centerCol = (cols - 1) / 2;

  // Build cell quads back-to-front (painter's algorithm: small r = back).
  const quads: ReactElement[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const e00 = elev[r][c];
      const e01 = elev[r][c + 1];
      const e10 = elev[r + 1][c];
      const e11 = elev[r + 1][c + 1];
      if (e00 == null || e01 == null || e10 == null || e11 == null) continue; // gap — no synthetic fill
      const avg = (e00 + e01 + e10 + e11) / 4;
      const t = (avg - min) / relief;
      const pts = [
        [px(r, c), py(r, c, e00)],
        [px(r, c + 1), py(r, c + 1, e01)],
        [px(r + 1, c + 1), py(r + 1, c + 1, e11)],
        [px(r + 1, c), py(r + 1, c, e10)],
      ];
      quads.push(
        <polygon
          key={`q-${r}-${c}`}
          points={pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")}
          fill={rampColor(t)}
          stroke={C.edge}
          strokeWidth={0.3}
          strokeOpacity={0.5}
        />,
      );
    }
  }

  // Roadway ribbon along the center column (road bearing axis).
  const ribbon: ReactElement[] = [];
  const cc = Math.round(centerCol);
  for (let r = 0; r < rows - 1; r++) {
    const eA = elev[r][cc];
    const eB = elev[r + 1][cc];
    if (eA == null || eB == null) continue;
    const halfW = dx * 0.18;
    const pts = [
      [px(r, cc) - halfW, py(r, cc, eA) - 1],
      [px(r, cc) + halfW, py(r, cc, eA) - 1],
      [px(r + 1, cc) + halfW, py(r + 1, cc, eB) - 1],
      [px(r + 1, cc) - halfW, py(r + 1, cc, eB) - 1],
    ];
    ribbon.push(
      <polygon key={`road-${r}`} points={pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")} fill={C.road} opacity={0.85} />,
    );
  }

  // Incident marker at grid center.
  const mr = Math.round(centerRow);
  const mc = Math.round(centerCol);
  const markerElev = elev[mr][mc] ?? max;
  const mx = px(mr, mc);
  const my = py(mr, mc, markerElev);

  const bearing = terrain.road_bearing_deg_used;
  const hasBearing = bearing != null;
  const checked = terrain.checked_at ? terrain.checked_at.slice(0, 16).replace("T", " ") : "—";
  const extentAlong = grid.extent_along_m ?? grid.along_road_spacing_m * (rows - 1);
  const extentCross = grid.extent_cross_m ?? grid.cross_road_spacing_m * (cols - 1);
  // Partial coverage: the mesh is real but some USGS samples were unavailable or
  // exceeded the build time budget. Keep the mesh visible and say so plainly.
  const sampleCount = grid.sample_count ?? grid.rows * grid.columns;
  const isPartial = valid > 0 && !!terrain.error;

  return (
    <div className="rounded border border-[var(--line)] bg-[#0f172a] p-2">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2 px-1">
        <span className="text-xs font-semibold text-emerald-400">3D Terrain (Terrain Relief)</span>
        <span className={`text-[10px] ${hasBearing ? "text-[color:#94a3b8]" : "text-amber-300"}`}>
          {hasBearing ? `Road bearing ${Math.round(bearing!)}°` : "North-aligned terrain relief — road orientation unavailable"}
        </span>
      </div>
      {isPartial ? (
        <div className="mx-1 mb-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-200">
          <span className="font-semibold">Partial terrain coverage.</span> Some USGS
          samples were unavailable or exceeded the time budget — {valid} of {sampleCount} grid
          points returned elevation. The mesh below shows only real samples; missing cells are
          intentionally left blank (not interpolated or invented).
        </div>
      ) : null}
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Terrain relief surface from sampled USGS elevation grid">
        {quads}
        {/* Roadway ribbon + LT/RT only when a road bearing was resolved; otherwise
            the grid is merely north-aligned and left/right of the road is unknown. */}
        {hasBearing ? ribbon : null}
        {/* incident marker */}
        <circle cx={mx} cy={my} r={4.5} fill={C.marker} stroke="#fff" strokeWidth={1} />
        <text x={mx + 7} y={my - 6} fontSize={9} fill={C.ink}>Incident</text>
        {hasBearing ? (
          <>
            <text x={px(rows - 1, 0)} y={py(rows - 1, 0, elev[rows - 1][0] ?? min) + 16} fontSize={9} fill="#60a5fa" textAnchor="middle">LT (left)</text>
            <text x={px(rows - 1, cols - 1)} y={py(rows - 1, cols - 1, elev[rows - 1][cols - 1] ?? min) + 16} fontSize={9} fill="#34d399" textAnchor="middle">RT (right)</text>
          </>
        ) : null}
        {/* legend */}
        <g transform={`translate(${W - 150}, 12)`}>
          <text x={0} y={8} fontSize={8.5} fill={C.text}>Elevation (ft)</text>
          {[0, 0.25, 0.5, 0.75, 1].map((t, i) => (
            <rect key={i} x={i * 24} y={12} width={24} height={7} fill={rampColor(t)} />
          ))}
          <text x={0} y={30} fontSize={8} fill={C.text}>{Math.round(min)}</text>
          <text x={120} y={30} fontSize={8} fill={C.text} textAnchor="end">{Math.round(max)}</text>
        </g>
      </svg>
      <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 px-1 text-[10px] text-[color:#94a3b8]">
        <span>Source: <span className="text-[color:#e2e8f0]">{terrain.source ?? "—"}</span></span>
        <span>Sampled: <span className="text-[color:#e2e8f0]">{checked}</span></span>
        <span>Grid: <span className="text-[color:#e2e8f0]">{grid.rows}×{grid.columns}</span> ({valid}/{grid.sample_count ?? grid.rows * grid.columns} valid)</span>
        <span>Coverage: <span className="text-[color:#e2e8f0]">{Math.round(extentAlong)}×{Math.round(extentCross)} m</span> ({Math.round(extentAlong * M_TO_FT)} ft along)</span>
      </div>
      <div className="mt-1 px-1 text-[9px] italic text-[color:#64748b]">
        Operational visualization derived from sampled USGS 3DEP / EPQS elevation points — not a surveyed design surface.
      </div>
    </div>
  );
}

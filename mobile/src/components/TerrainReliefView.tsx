/**
 * Compact 3D Terrain / Terrain Relief view for mobile.
 *
 * Renders the ACTUAL road-aligned USGS 3DEP / EPQS elevation grid as an oblique
 * (axonometric) surface mesh in react-native-svg — no browser-only / WebGL
 * dependency. Built only from sampled points; cells with a missing USGS sample
 * are left as gaps (no synthetic elevations). Calculated from the real grid.
 */

import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, type LayoutChangeEvent } from "react-native";
import Svg, { Polygon, Circle, Rect, Text as SvgText, G } from "react-native-svg";
import type { GisaTerrainGrid } from "../api/submissions";

const M_TO_FT = 3.280839895;

const C = {
  bg: "#0f172a",
  road: "#f8fafc",
  marker: "#ef4444",
  edge: "#0b1220",
  text: "#94a3b8",
  ink: "#e2e8f0",
  title: "#34d399",
};

const RAMP: [number, [number, number, number]][] = [
  [0.0, [42, 78, 110]],
  [0.25, [63, 125, 79]],
  [0.5, [150, 150, 96]],
  [0.75, [150, 110, 78]],
  [1.0, [236, 236, 236]],
];

function rampColor(t: number): string {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 0; i < RAMP.length - 1; i++) {
    const [a, ca] = RAMP[i];
    const [b, cb] = RAMP[i + 1];
    if (x >= a && x <= b) {
      const f = b === a ? 0 : (x - a) / (b - a);
      return `rgb(${Math.round(ca[0] + (cb[0] - ca[0]) * f)},${Math.round(ca[1] + (cb[1] - ca[1]) * f)},${Math.round(ca[2] + (cb[2] - ca[2]) * f)})`;
    }
  }
  return "rgb(236,236,236)";
}

export function TerrainReliefView({ terrain }: { terrain?: GisaTerrainGrid | null }) {
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), []);

  const grid = terrain?.grid ?? null;
  const valid = grid?.valid_sample_count ?? 0;

  const view = useMemo(() => {
    if (!grid || !grid.points?.length) return null;
    const rows = grid.rows;
    const cols = grid.columns;
    const elev: (number | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null));
    let min = Infinity;
    let max = -Infinity;
    for (const p of grid.points) {
      if (p.row < 0 || p.row >= rows || p.column < 0 || p.column >= cols) continue;
      elev[p.row][p.column] = p.elevation_ft;
      if (p.elevation_ft != null) {
        min = Math.min(min, p.elevation_ft);
        max = Math.max(max, p.elevation_ft);
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    return { rows, cols, elev, min, max, relief: Math.max(1, max - min) };
  }, [grid]);

  const header = (
    <View style={styles.headerRow}>
      <Text style={styles.title}>3D Terrain (Terrain Relief)</Text>
      {terrain?.road_bearing_deg_used != null ? (
        <Text style={styles.sub}>Road bearing {Math.round(terrain.road_bearing_deg_used)}°</Text>
      ) : (
        <Text style={[styles.sub, { color: "#fbbf24", maxWidth: "62%", textAlign: "right" }]}>
          North-aligned terrain relief — road orientation unavailable
        </Text>
      )}
    </View>
  );

  if (!terrain || !grid || valid === 0 || !view) {
    return (
      <View style={styles.wrapper} onLayout={onLayout}>
        {header}
        <View style={styles.emptyBox}>
          <Text style={styles.emptyText}>
            {terrain?.error
              ? terrain.error
              : "No terrain elevation data yet. Build the grid to sample USGS 3DEP around this location."}
          </Text>
        </View>
      </View>
    );
  }

  const W = Math.max(1, width);
  const H = Math.round(W * 0.62);
  const { rows, cols, elev, min, max, relief } = view;
  const hasBearing = terrain.road_bearing_deg_used != null;
  // Partial coverage: the mesh is real but some USGS samples were unavailable or
  // exceeded the build time budget. Keep the mesh visible and say so plainly.
  const sampleCount = grid.sample_count ?? grid.rows * grid.columns;
  const isPartial = valid > 0 && !!terrain.error;

  const padX = 26;
  const padTop = 18;
  const dx = (W - 2 * padX) / (cols - 1 + (rows - 1) * 0.4);
  const shearX = dx * 0.4;
  const zHeight = Math.min(70, H * 0.28);
  const dy = Math.max(5, (H - padTop - 48 - zHeight) / Math.max(1, rows - 1));

  const px = (r: number, c: number) => padX + c * dx + r * shearX;
  const py = (r: number, c: number, e: number) => padTop + 40 + r * dy - ((e - min) / relief) * zHeight;

  const cc = Math.round((cols - 1) / 2);
  const cr = Math.round((rows - 1) / 2);

  const quads: React.ReactNode[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const e00 = elev[r][c], e01 = elev[r][c + 1], e10 = elev[r + 1][c], e11 = elev[r + 1][c + 1];
      if (e00 == null || e01 == null || e10 == null || e11 == null) continue;
      const t = ((e00 + e01 + e10 + e11) / 4 - min) / relief;
      const pts =
        `${px(r, c).toFixed(1)},${py(r, c, e00).toFixed(1)} ` +
        `${px(r, c + 1).toFixed(1)},${py(r, c + 1, e01).toFixed(1)} ` +
        `${px(r + 1, c + 1).toFixed(1)},${py(r + 1, c + 1, e11).toFixed(1)} ` +
        `${px(r + 1, c).toFixed(1)},${py(r + 1, c, e10).toFixed(1)}`;
      quads.push(<Polygon key={`q-${r}-${c}`} points={pts} fill={rampColor(t)} stroke={C.edge} strokeWidth={0.3} strokeOpacity={0.5} />);
    }
  }

  const ribbon: React.ReactNode[] = [];
  for (let r = 0; r < rows - 1; r++) {
    const eA = elev[r][cc], eB = elev[r + 1][cc];
    if (eA == null || eB == null) continue;
    const hw = dx * 0.18;
    const pts =
      `${(px(r, cc) - hw).toFixed(1)},${(py(r, cc, eA) - 1).toFixed(1)} ` +
      `${(px(r, cc) + hw).toFixed(1)},${(py(r, cc, eA) - 1).toFixed(1)} ` +
      `${(px(r + 1, cc) + hw).toFixed(1)},${(py(r + 1, cc, eB) - 1).toFixed(1)} ` +
      `${(px(r + 1, cc) - hw).toFixed(1)},${(py(r + 1, cc, eB) - 1).toFixed(1)}`;
    ribbon.push(<Polygon key={`road-${r}`} points={pts} fill={C.road} opacity={0.85} />);
  }

  const markerElev = elev[cr][cc] ?? max;
  const mx = px(cr, cc);
  const my = py(cr, cc, markerElev);

  const checked = terrain.checked_at ? terrain.checked_at.slice(0, 16).replace("T", " ") : "—";
  const extentAlong = grid.extent_along_m ?? grid.along_road_spacing_m * (rows - 1);
  const extentCross = grid.extent_cross_m ?? grid.cross_road_spacing_m * (cols - 1);

  return (
    <View style={styles.wrapper} onLayout={onLayout}>
      {header}
      {isPartial ? (
        <View style={styles.partialBox}>
          <Text style={styles.partialText}>
            <Text style={styles.partialBold}>Partial terrain coverage. </Text>
            Some USGS samples were unavailable or exceeded the time budget — {valid} of{" "}
            {sampleCount} grid points returned elevation. The mesh shows only real samples;
            missing cells are intentionally left blank (not interpolated or invented).
          </Text>
        </View>
      ) : null}
      {W > 1 ? (
        <Svg width={W} height={H}>
          <G>{quads}</G>
          {/* Roadway ribbon + LT/RT only when a road bearing was resolved. */}
          {hasBearing ? <G>{ribbon}</G> : null}
          <Circle cx={mx} cy={my} r={4} fill={C.marker} stroke="#fff" strokeWidth={1} />
          <SvgText x={mx + 6} y={my - 5} fontSize={8} fill={C.ink}>Incident</SvgText>
          {hasBearing ? (
            <>
              <SvgText x={px(rows - 1, 0)} y={py(rows - 1, 0, elev[rows - 1][0] ?? min) + 13} fontSize={8} fill="#60a5fa" textAnchor="middle">LT</SvgText>
              <SvgText x={px(rows - 1, cols - 1)} y={py(rows - 1, cols - 1, elev[rows - 1][cols - 1] ?? min) + 13} fontSize={8} fill="#34d399" textAnchor="middle">RT</SvgText>
            </>
          ) : null}
          <G x={W - 118} y={8}>
            <SvgText x={0} y={7} fontSize={7.5} fill={C.text}>Elev (ft)</SvgText>
            {[0, 0.25, 0.5, 0.75, 1].map((t, i) => (
              <Rect key={i} x={i * 20} y={10} width={20} height={6} fill={rampColor(t)} />
            ))}
            <SvgText x={0} y={26} fontSize={7} fill={C.text}>{Math.round(min)}</SvgText>
            <SvgText x={100} y={26} fontSize={7} fill={C.text} textAnchor="end">{Math.round(max)}</SvgText>
          </G>
        </Svg>
      ) : null}
      <View style={styles.metaGrid}>
        <Text style={styles.meta}>Source: <Text style={styles.metaVal}>{terrain.source ?? "—"}</Text></Text>
        <Text style={styles.meta}>Sampled: <Text style={styles.metaVal}>{checked}</Text></Text>
        <Text style={styles.meta}>Grid: <Text style={styles.metaVal}>{grid.rows}×{grid.columns}</Text> ({valid}/{grid.sample_count ?? grid.rows * grid.columns})</Text>
        <Text style={styles.meta}>Coverage: <Text style={styles.metaVal}>{Math.round(extentAlong)}×{Math.round(extentCross)} m</Text> ({Math.round(extentAlong * M_TO_FT)} ft)</Text>
      </View>
      <Text style={styles.disclaimer}>
        Operational visualization from sampled USGS 3DEP / EPQS points — not a surveyed design surface.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { backgroundColor: C.bg, borderRadius: 8, overflow: "hidden", marginTop: 8, paddingBottom: 6 },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8, paddingVertical: 6 },
  title: { fontSize: 11, fontWeight: "700", color: C.title },
  sub: { fontSize: 8.5, color: C.text },
  emptyBox: { paddingHorizontal: 12, paddingVertical: 18, alignItems: "center" },
  emptyText: { fontSize: 10, color: C.text, textAlign: "center" },
  partialBox: {
    marginHorizontal: 8,
    marginBottom: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "rgba(245,158,11,0.4)",
    backgroundColor: "rgba(245,158,11,0.12)",
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  partialText: { fontSize: 9, color: "#fcd34d", lineHeight: 13 },
  partialBold: { fontWeight: "700", color: "#fde68a" },
  metaGrid: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 8, paddingTop: 4, gap: 2 },
  meta: { fontSize: 9, color: C.text, width: "50%" },
  metaVal: { color: C.ink },
  disclaimer: { fontSize: 8, color: "#64748b", fontStyle: "italic", paddingHorizontal: 8, paddingTop: 3 },
});

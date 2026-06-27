/**
 * SVG cross-section diagram for a Caltrans road section with landslide overlay.
 *
 * LT = Caltrans left side relative to increasing postmile (UPSTATION direction).
 * RT = Caltrans right side relative to increasing postmile (UPSTATION direction).
 *
 * Orientation is CANONICAL UPSTATION — always. The diagram always looks toward
 * increasing postmile, so LT elements are always on the left and RT on the right.
 * There is no mirrored / DOWNSTATION perspective and no user-facing view toggle.
 *
 * The failure side (LT, RT, or both) is an explicit field on MeasurementDiagramData.
 * It carries no implied compass direction, elevation, or cut/fill relationship.
 */

import React, { useMemo } from "react";
import Svg, {
  Rect,
  Line,
  Text as SvgText,
  Path,
  G,
  Defs,
  Pattern,
  LinearGradient,
  Stop,
  Circle,
} from "react-native-svg";
import type { MeasurementDiagramData, TerrainAppearance, TerrainSideShape } from "../measurements/measurementDiagramModel";
import type { RoadCrossSection } from "../measurements/roadCrossSectionModel";
import { buildTerrainPalette, type TerrainPalette } from "../measurements/buildTerrainAppearance";

// ── SVG constants ─────────────────────────────────────────────────────────────
const SVG_H = 270;
const ROAD_TOP = 88;
const ROAD_BOT = 148;
const ROAD_H = ROAD_BOT - ROAD_TOP; // 60
const H_MARGIN = 32;
const ABOVE_H = ROAD_TOP - 8;       // vertical space above road for overlays
const BELOW_H = SVG_H - ROAD_BOT - 20; // vertical space below road for overlays
const DIM_Y = ROAD_BOT + 14;
const FOOTER_Y = SVG_H - 8;

// ── Colour palette ────────────────────────────────────────────────────────────
const C = {
  bg: "#0f172a",
  road: "#374151",
  shoulder: "#4b5563",
  lane_div: "#9ca3af",
  edge_line: "#f3f4f6",
  cl_yellow: "#fbbf24",
  median_raised: "#1f2937",
  median_barrier: "#78716c",
  terrain_neutral: "#1a2635", // both terrain sides — no directional implication
  slope_line: "#34d399",
  ls_hatch: "#c2410c",
  scarp: "#ef4444",
  dim: "#f59e0b",
  dim_text: "#fef3c7",
  label: "#e2e8f0",
  muted: "#64748b",
  lt_chip: "#1d4ed8",
  rt_chip: "#15803d",
  header: "#94a3b8",
};

type TerrainSurfaceSegment = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

type TerrainRenderSide = {
  kind: SideTerrain;
  path: string;
  surface: TerrainSurfaceSegment;
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

// ── Layout computation ────────────────────────────────────────────────────────

type ElementKind =
  | "lt_shoulder_outer"
  | "lt_shoulder_inner"
  | "lt_lane"
  | "median"
  | "rt_lane"
  | "rt_shoulder_inner"
  | "rt_shoulder_outer";

type LayoutEl = {
  kind: ElementKind;
  x: number;
  w: number;
  ft: number;
  laneIdx?: number;
};

function computeLayout(
  cs: RoadCrossSection,
  svgW: number,
): { els: LayoutEl[]; scale: number; ltEdge: number; rtEdge: number; cx: number } {
  const roadAvail = svgW - 2 * H_MARGIN;
  const scale = roadAvail / Math.max(cs.total_width_ft, 1);

  const els: LayoutEl[] = [];
  let x = H_MARGIN;

  const push = (kind: ElementKind, ft: number, laneIdx?: number) => {
    const w = ft * scale;
    if (w > 0) els.push({ kind, x, w, ft, laneIdx });
    x += w;
  };

  // UPSTATION order: LT-outer-shoulder → LT-lanes (outermost first) → LT-inner-shoulder
  //   → median → RT-inner-shoulder → RT-lanes (innermost first) → RT-outer-shoulder
  push("lt_shoulder_outer", cs.lt_outside_shoulder_ft);
  for (let i = 0; i < cs.lt_lane_count; i++) push("lt_lane", cs.lt_lane_width_ft, i);
  push("lt_shoulder_inner", cs.lt_inside_shoulder_ft);
  push("median", cs.median_width_ft);
  push("rt_shoulder_inner", cs.rt_inside_shoulder_ft);
  for (let i = 0; i < cs.rt_lane_count; i++) push("rt_lane", cs.rt_lane_width_ft, i);
  push("rt_shoulder_outer", cs.rt_outside_shoulder_ft);

  const ltEdge = H_MARGIN;
  const rtEdge = Math.min(x, svgW - H_MARGIN);
  const cx =
    H_MARGIN +
    (cs.lt_outside_shoulder_ft +
      cs.lt_lane_count * cs.lt_lane_width_ft +
      cs.lt_inside_shoulder_ft +
      cs.median_width_ft / 2) *
      scale;

  return { els, scale, ltEdge, rtEdge, cx };
}

// ── Failure-side geometry helper ──────────────────────────────────────────────

/**
 * Returns the x-position of the road edge on the requested Caltrans side and
 * the direction (sign) to extend an overlay away from the road center.
 *
 * Orientation is canonical UPSTATION, so LT is always the left edge and RT the
 * right edge; the dir sign falls out of the edge position.
 */
function getFailureEdgeAndDir(
  side: "LT" | "RT",
  ltEdge: number,
  rtEdge: number,
  svgW: number,
): { edge: number; dir: number } {
  const edge = side === "LT" ? ltEdge : rtEdge;
  // Away from the road center: negative when edge is on the left, positive on the right
  const dir = edge < svgW / 2 ? -1 : 1;
  return { edge, dir };
}

// ── Dimension helpers ─────────────────────────────────────────────────────────

function DimArrow({
  x1, y, x2, label, color = C.dim, textColor = C.dim_text,
}: {
  x1: number; y: number; x2: number; label: string;
  color?: string; textColor?: string;
}) {
  const mid = (x1 + x2) / 2;
  const tickH = 5;
  return (
    <G>
      <Line x1={x1} y1={y} x2={x2} y2={y} stroke={color} strokeWidth={1.5} />
      <Line x1={x1} y1={y - tickH} x2={x1} y2={y + tickH} stroke={color} strokeWidth={1.5} />
      <Line x1={x2} y1={y - tickH} x2={x2} y2={y + tickH} stroke={color} strokeWidth={1.5} />
      <SvgText x={mid} y={y - 3} fontSize={9} fill={textColor} textAnchor="middle" fontWeight="600">
        {label}
      </SvgText>
    </G>
  );
}

function VDimArrow({
  x, y1, y2, label, color = C.dim, textColor = C.dim_text,
}: {
  x: number; y1: number; y2: number; label: string;
  color?: string; textColor?: string;
}) {
  const mid = (y1 + y2) / 2;
  return (
    <G>
      <Line x1={x} y1={y1} x2={x} y2={y2} stroke={color} strokeWidth={1.5} />
      <Line x1={x - 4} y1={y1} x2={x + 4} y2={y1} stroke={color} strokeWidth={1.5} />
      <Line x1={x - 4} y1={y2} x2={x + 4} y2={y2} stroke={color} strokeWidth={1.5} />
      <SvgText x={x + 6} y={mid + 4} fontSize={9} fill={textColor} textAnchor="start" fontWeight="600">
        {label}
      </SvgText>
    </G>
  );
}

// ── Road section ──────────────────────────────────────────────────────────────

function renderRoadSection(
  els: LayoutEl[],
  cs: RoadCrossSection,
  cx: number,
  terrainPalette: TerrainPalette,
) {
  const nodes: React.ReactNode[] = [];

  for (const el of els) {
    let fill = terrainPalette.road;
    if (el.kind.includes("shoulder")) fill = terrainPalette.shoulder;
    if (el.kind === "median") {
      fill =
        cs.median_category === "BARRIER" ? C.median_barrier
        : cs.median_category === "RAISED" ? C.median_raised
        : terrainPalette.road;
    }
    nodes.push(
      <Rect key={`fill-${el.kind}-${el.x}`} x={el.x} y={ROAD_TOP} width={el.w} height={ROAD_H} fill={fill} />,
    );
  }

  // Dashed lane dividers (within each directional group)
  for (const el of els) {
    if (el.kind !== "lt_lane" && el.kind !== "rt_lane") continue;
    if (el.laneIdx === 0) continue;
    nodes.push(
      <Line key={`div-${el.kind}-${el.x}`}
        x1={el.x} y1={ROAD_TOP} x2={el.x} y2={ROAD_BOT}
        stroke={C.lane_div} strokeWidth={1} strokeDasharray="6,4" />,
    );
  }

  // Edge lines at outer travel-way boundaries
  const ltLanes = els.filter((e) => e.kind === "lt_lane");
  const rtLanes = els.filter((e) => e.kind === "rt_lane");
  const ltTravelLeft = ltLanes.length > 0 ? ltLanes[0].x : cx;
  const ltTravelRight = ltLanes.length > 0 ? ltLanes[ltLanes.length - 1].x + ltLanes[ltLanes.length - 1].w : cx;
  const rtTravelLeft = rtLanes.length > 0 ? rtLanes[0].x : cx;
  const rtTravelRight = rtLanes.length > 0 ? rtLanes[rtLanes.length - 1].x + rtLanes[rtLanes.length - 1].w : cx;

  nodes.push(
    <Line key="elt" x1={ltTravelLeft} y1={ROAD_TOP} x2={ltTravelLeft} y2={ROAD_BOT} stroke={C.edge_line} strokeWidth={2} />,
    <Line key="ert" x1={rtTravelRight} y1={ROAD_TOP} x2={rtTravelRight} y2={ROAD_BOT} stroke={C.edge_line} strokeWidth={2} />,
    <Line key="road-top-shadow" x1={ltTravelLeft} y1={ROAD_TOP + 2} x2={rtTravelRight} y2={ROAD_TOP + 2} stroke={terrainPalette.roadEdge} strokeWidth={1.2} opacity={0.55} />,
    <Line key="road-bot-shadow" x1={ltTravelLeft} y1={ROAD_BOT - 2} x2={rtTravelRight} y2={ROAD_BOT - 2} stroke={terrainPalette.roadEdge} strokeWidth={1.1} opacity={0.35} />,
  );

  // Centerline / median treatment
  if (cs.median_category === "NONE" || cs.median_width_ft === 0) {
    nodes.push(
      <Line key="cl1" x1={cx - 2} y1={ROAD_TOP} x2={cx - 2} y2={ROAD_BOT}
        stroke={C.cl_yellow} strokeWidth={1.5} strokeDasharray="8,4" />,
      <Line key="cl2" x1={cx + 2} y1={ROAD_TOP} x2={cx + 2} y2={ROAD_BOT}
        stroke={C.cl_yellow} strokeWidth={1.5} strokeDasharray="8,4" />,
    );
  } else if (cs.median_category === "PAINTED") {
    nodes.push(
      <Line key="mpl" x1={ltTravelRight} y1={ROAD_TOP} x2={ltTravelRight} y2={ROAD_BOT}
        stroke={C.cl_yellow} strokeWidth={2} />,
      <Line key="mpr" x1={rtTravelLeft} y1={ROAD_TOP} x2={rtTravelLeft} y2={ROAD_BOT}
        stroke={C.cl_yellow} strokeWidth={2} />,
    );
  }

  nodes.push(
    <Line key="rtop" x1={ltTravelLeft} y1={ROAD_TOP} x2={rtTravelRight} y2={ROAD_TOP}
      stroke={C.edge_line} strokeWidth={1} />,
    <Line key="rbot" x1={ltTravelLeft} y1={ROAD_BOT} x2={rtTravelRight} y2={ROAD_BOT}
      stroke={C.edge_line} strokeWidth={1} />,
  );

  return nodes;
}

// ── Width labels ──────────────────────────────────────────────────────────────

function renderWidthLabels(els: LayoutEl[]): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const y = DIM_Y + 8;
  const groups: [string, number, number][] = [];

  let i = 0;
  while (i < els.length) {
    const el = els[i];
    if (el.kind === "lt_lane") {
      const x1 = el.x;
      let lastX2 = el.x + el.w;
      let j = i + 1;
      while (j < els.length && els[j].kind === "lt_lane") {
        lastX2 = els[j].x + els[j].w;
        j++;
      }
      const count = j - i;
      groups.push([count > 1 ? `LT ${count}×${Math.round(el.ft)}'` : `LT ${Math.round(el.ft)}'`, x1, lastX2]);
      i = j;
      continue;
    }
    if (el.kind === "rt_lane") {
      const x1 = el.x;
      let lastX2 = el.x + el.w;
      let j = i + 1;
      while (j < els.length && els[j].kind === "rt_lane") {
        lastX2 = els[j].x + els[j].w;
        j++;
      }
      const count = j - i;
      groups.push([count > 1 ? `RT ${count}×${Math.round(el.ft)}'` : `RT ${Math.round(el.ft)}'`, x1, lastX2]);
      i = j;
      continue;
    }
    if (el.kind === "lt_shoulder_outer" || el.kind === "lt_shoulder_inner")
      groups.push([`${Math.round(el.ft)}'`, el.x, el.x + el.w]);
    if (el.kind === "rt_shoulder_outer" || el.kind === "rt_shoulder_inner")
      groups.push([`${Math.round(el.ft)}'`, el.x, el.x + el.w]);
    if (el.kind === "median" && el.ft > 0)
      groups.push([`MDN ${Math.round(el.ft)}'`, el.x, el.x + el.w]);
    i++;
  }

  for (const [label, x1, x2] of groups) {
    const mid = (x1 + x2) / 2;
    const w = x2 - x1;
    if (w < 16) continue;
    nodes.push(
      <Line key={`ll-${x1}`} x1={x1} y1={ROAD_BOT} x2={x1} y2={DIM_Y + 4} stroke={C.muted} strokeWidth={0.8} />,
      <Line key={`lr-${x2}`} x1={x2} y1={ROAD_BOT} x2={x2} y2={DIM_Y + 4} stroke={C.muted} strokeWidth={0.8} />,
      <Line key={`lh-${x1}`} x1={x1} y1={DIM_Y + 4} x2={x2} y2={DIM_Y + 4} stroke={C.muted} strokeWidth={0.8} />,
      <SvgText key={`lt-${x1}`} x={mid} y={y + 2} fontSize={8.5} fill={C.muted} textAnchor="middle">
        {label}
      </SvgText>,
    );
  }

  return nodes;
}

// ── Terrain profile — slope-aware filled polygons ────────────────────────────

const TERRAIN_TOP = 8;
const TERRAIN_BOT = SVG_H - 16;

type SideTerrain = "HIGH" | "LOW" | "FLAT";

function ltTerrainPath(t: SideTerrain, ltEdge: number): string {
  const lowY = ROAD_BOT + (TERRAIN_BOT - ROAD_BOT) * 0.65;
  if (t === "HIGH")
    // cut slope: surface rises from road edge up to top of diagram going left
    return `M 0,${TERRAIN_TOP} L ${ltEdge},${ROAD_TOP} L ${ltEdge},${TERRAIN_BOT} L 0,${TERRAIN_BOT} Z`;
  if (t === "LOW")
    // fill slope: surface drops from road bottom going left
    return `M 0,${lowY} L ${ltEdge},${ROAD_BOT} L ${ltEdge},${TERRAIN_BOT} L 0,${TERRAIN_BOT} Z`;
  // FLAT: level with road top
  return `M 0,${ROAD_TOP} L ${ltEdge},${ROAD_TOP} L ${ltEdge},${TERRAIN_BOT} L 0,${TERRAIN_BOT} Z`;
}

function rtTerrainPath(t: SideTerrain, rtEdge: number, svgW: number): string {
  const lowY = ROAD_BOT + (TERRAIN_BOT - ROAD_BOT) * 0.65;
  if (t === "HIGH")
    return `M ${rtEdge},${ROAD_TOP} L ${svgW},${TERRAIN_TOP} L ${svgW},${TERRAIN_BOT} L ${rtEdge},${TERRAIN_BOT} Z`;
  if (t === "LOW")
    return `M ${rtEdge},${ROAD_BOT} L ${svgW},${lowY} L ${svgW},${TERRAIN_BOT} L ${rtEdge},${TERRAIN_BOT} Z`;
  return `M ${rtEdge},${ROAD_TOP} L ${svgW},${ROAD_TOP} L ${svgW},${TERRAIN_BOT} L ${rtEdge},${TERRAIN_BOT} Z`;
}

function ltSurfaceSegment(t: SideTerrain, ltEdge: number): TerrainSurfaceSegment {
  const lowY = ROAD_BOT + (TERRAIN_BOT - ROAD_BOT) * 0.65;
  if (t === "HIGH") return { x1: 0, y1: TERRAIN_TOP, x2: ltEdge, y2: ROAD_TOP };
  if (t === "LOW") return { x1: 0, y1: lowY, x2: ltEdge, y2: ROAD_BOT };
  return { x1: 0, y1: ROAD_TOP, x2: ltEdge, y2: ROAD_TOP };
}

function rtSurfaceSegment(t: SideTerrain, rtEdge: number, svgW: number): TerrainSurfaceSegment {
  const lowY = ROAD_BOT + (TERRAIN_BOT - ROAD_BOT) * 0.65;
  if (t === "HIGH") return { x1: rtEdge, y1: ROAD_TOP, x2: svgW, y2: TERRAIN_TOP };
  if (t === "LOW") return { x1: rtEdge, y1: ROAD_BOT, x2: svgW, y2: lowY };
  return { x1: rtEdge, y1: ROAD_TOP, x2: svgW, y2: ROAD_TOP };
}

function resolveTerrainSides(
  terrainShape: TerrainSideShape,
  ltEdge: number,
  rtEdge: number,
  svgW: number,
): { lt: TerrainRenderSide; rt: TerrainRenderSide } {
  let ltKind: SideTerrain;
  let rtKind: SideTerrain;

  switch (terrainShape) {
    case "LEFT_HIGH":  ltKind = "HIGH"; rtKind = "LOW"; break;
    case "RIGHT_HIGH": ltKind = "LOW";  rtKind = "HIGH"; break;
    case "BOWL":       ltKind = "LOW";  rtKind = "LOW"; break;
    case "CROWN":      ltKind = "HIGH"; rtKind = "HIGH"; break;
    case "FLAT":
    default:           ltKind = "FLAT"; rtKind = "FLAT"; break;
  }

  return {
    lt: {
      kind: ltKind,
      path: ltTerrainPath(ltKind, ltEdge),
      surface: ltSurfaceSegment(ltKind, ltEdge),
    },
    rt: {
      kind: rtKind,
      path: rtTerrainPath(rtKind, rtEdge, svgW),
      surface: rtSurfaceSegment(rtKind, rtEdge, svgW),
    },
  };
}

function renderVegetationClumps(
  keyPrefix: string,
  surface: TerrainSurfaceSegment,
  appearance: TerrainAppearance,
  terrainPalette: TerrainPalette,
): React.ReactNode[] {
  if (appearance.vegetationDensity < 0.12) return [];
  const count =
    appearance.vegetationDensity > 0.58 ? 4 :
    appearance.vegetationDensity > 0.32 ? 3 :
    2;
  const nodes: React.ReactNode[] = [];
  const span = Array.from({ length: count }, (_, i) => 0.14 + (0.72 * i) / (count - 1));

  span.forEach((t, idx) => {
    const x = lerp(surface.x1, surface.x2, t);
    const y = lerp(surface.y1, surface.y2, t) - 2.6 - (idx % 2) * 1.4;
    const r = 2.5 + appearance.vegetationDensity * 2.2 + (appearance.treesPct / 100) * 1.2;
    nodes.push(
      <Circle key={`${keyPrefix}-veg-shadow-${idx}`} cx={x} cy={y + 1.1} r={r * 0.9} fill={terrainPalette.vegetationDark} opacity={0.5} />,
      <Circle key={`${keyPrefix}-veg-${idx}`} cx={x} cy={y} r={r} fill={terrainPalette.vegetation} />,
    );
  });

  return nodes;
}

function renderRockAccents(
  keyPrefix: string,
  side: TerrainRenderSide,
  appearance: TerrainAppearance,
  terrainPalette: TerrainPalette,
): React.ReactNode[] {
  if (appearance.rockiness < 0.35 && appearance.boulderPct < 8) return [];
  const count =
    appearance.boulderPct > 26 ? 4 :
    appearance.rockiness > 0.66 ? 3 :
    2;
  const nodes: React.ReactNode[] = [];

  for (let i = 0; i < count; i++) {
    const t = 0.2 + i * 0.22;
    const depth = side.kind === "HIGH" ? 0.34 + i * 0.08 : 0.46 + i * 0.08;
    const x = lerp(side.surface.x1, side.surface.x2, t);
    const surfaceY = lerp(side.surface.y1, side.surface.y2, t);
    const y = lerp(surfaceY, TERRAIN_BOT - 14, clamp01(depth));
    const r = 2.6 + appearance.rockiness * 1.9 + (appearance.boulderPct / 100) * 2.6 + (i === count - 1 ? 0.8 : 0);
    nodes.push(
      <Circle key={`${keyPrefix}-rock-${i}`} cx={x} cy={y} r={r} fill={terrainPalette.stone} stroke={terrainPalette.stoneShade} strokeWidth={0.9} />,
      <Line key={`${keyPrefix}-rock-shine-${i}`} x1={x - r * 0.5} y1={y - r * 0.3} x2={x + r * 0.25} y2={y - r * 0.55} stroke="#ffffff" strokeWidth={0.7} opacity={0.18} />,
    );
  }

  return nodes;
}

function renderMoistureStreaks(
  keyPrefix: string,
  side: TerrainRenderSide,
  appearance: TerrainAppearance,
  terrainPalette: TerrainPalette,
): React.ReactNode[] {
  if (appearance.moistureLevel < 0.52 && !appearance.seep && !appearance.spring) return [];
  const streakCount = appearance.moisture === "FLOWING" ? 2 : 1;
  const nodes: React.ReactNode[] = [];
  const dir = side.surface.x2 >= side.surface.x1 ? 1 : -1;

  for (let i = 0; i < streakCount; i++) {
    const t = 0.32 + i * 0.26;
    const startX = lerp(side.surface.x1, side.surface.x2, t);
    const startY = lerp(side.surface.y1, side.surface.y2, t);
    const endX = startX + dir * (8 + i * 4);
    const endY = Math.min(TERRAIN_BOT - 12, startY + 24 + i * 10);
    nodes.push(
      <Line key={`${keyPrefix}-wet-${i}`} x1={startX} y1={startY + 1} x2={endX} y2={endY} stroke={terrainPalette.moisture} strokeWidth={1.6} opacity={0.7} />,
      <Line key={`${keyPrefix}-wet-shine-${i}`} x1={startX + dir * 1.2} y1={startY + 2.2} x2={endX + dir * 1.2} y2={endY} stroke="#dbeafe" strokeWidth={0.65} opacity={0.4} />,
    );
  }

  return nodes;
}

function renderTerrainProfile(
  terrainShape: TerrainSideShape,
  appearance: TerrainAppearance,
  terrainPalette: TerrainPalette,
  ltEdge: number,
  rtEdge: number,
  svgW: number,
): React.ReactNode[] {
  const sides = resolveTerrainSides(terrainShape, ltEdge, rtEdge, svgW);
  const textureFill =
    appearance.dominantMaterial === "ROCK"
      ? "url(#terrain_tex_rock)"
      : appearance.dominantMaterial === "SOIL"
        ? "url(#terrain_tex_soil)"
        : "url(#terrain_tex_mixed)";
  const nodes: React.ReactNode[] = [];

  ([
    ["lt", sides.lt],
    ["rt", sides.rt],
  ] as const).forEach(([prefix, side]) => {
    nodes.push(
      <Path key={`${prefix}-terrain-base`} d={side.path} fill="url(#terrain_fill)" />,
      <Path key={`${prefix}-terrain-shadow`} d={side.path} fill="url(#terrain_shadow)" opacity={0.72} />,
      <Path key={`${prefix}-terrain-texture`} d={side.path} fill={textureFill} opacity={0.42 + appearance.rockiness * 0.1} />,
    );
    if (appearance.moistureLevel > 0.18) {
      nodes.push(
        <Path key={`${prefix}-terrain-moisture`} d={side.path} fill="url(#terrain_moisture)" opacity={0.28 + appearance.moistureLevel * 0.24} />,
      );
    }
    nodes.push(
      <Line
        key={`${prefix}-surface`}
        x1={side.surface.x1}
        y1={side.surface.y1}
        x2={side.surface.x2}
        y2={side.surface.y2}
        stroke={appearance.vegetationDensity > 0.12 ? terrainPalette.vegetation : terrainPalette.texture}
        strokeWidth={2.2}
        opacity={0.95}
      />,
      <Line
        key={`${prefix}-surface-shadow`}
        x1={side.surface.x1}
        y1={side.surface.y1 + 1.1}
        x2={side.surface.x2}
        y2={side.surface.y2 + 1.1}
        stroke={terrainPalette.crack}
        strokeWidth={1.2}
        opacity={0.35}
      />,
    );
    nodes.push(...renderVegetationClumps(prefix, side.surface, appearance, terrainPalette));
    nodes.push(...renderRockAccents(prefix, side, appearance, terrainPalette));
    nodes.push(...renderMoistureStreaks(prefix, side, appearance, terrainPalette));
  });

  return nodes;
}

// ── Template overlays ─────────────────────────────────────────────────────────

/**
 * Draws an above-road (high-side failure) overlay on one Caltrans side.
 *
 * The side is resolved to a diagram x-position via getFailureEdgeAndDir. With
 * canonical UPSTATION orientation, LT is always the left edge and RT the right.
 */
function renderAboveRoadOneSide(
  data: MeasurementDiagramData,
  side: "LT" | "RT",
  ltEdge: number,
  rtEdge: number,
  svgW: number,
): React.ReactNode[] {
  const { measurements: m } = data;
  const { edge, dir } = getFailureEdgeAndDir(side, ltEdge, rtEdge, svgW);
  const k = side;

  const hsPx = m.slopeHeight_ft
    ? Math.min(ABOVE_H - 8, m.slopeHeight_ft * 1.2)
    : ABOVE_H * 0.65;
  const phiRad = m.originalSlopeDeg ? (m.originalSlopeDeg * Math.PI) / 180 : Math.atan(0.6);
  const runPx = hsPx / Math.tan(Math.max(0.15, phiRad));

  const slopeTipX = edge + dir * runPx;
  const tipY = ROAD_TOP - hsPx;
  const mainScarpH = m.mainScarpHeight_ft
    ? Math.min(hsPx * 0.7, m.mainScarpHeight_ft * 1.0)
    : hsPx * 0.5;
  const scarpX = edge + dir * runPx * 0.4;

  const nodes: React.ReactNode[] = [
    <Path key={`ls-above-${k}`}
      d={`M ${edge},${ROAD_TOP} L ${slopeTipX},${tipY} L ${scarpX + dir * runPx * 0.15},${ROAD_TOP - mainScarpH} L ${scarpX},${ROAD_TOP} Z`}
      fill="url(#hatch_ls)"
      opacity={0.85}
    />,
    <Line key={`slope-nat-${k}`}
      x1={edge} y1={ROAD_TOP} x2={slopeTipX} y2={tipY}
      stroke={C.slope_line} strokeWidth={2} />,
    <Line key={`scarp-${k}`}
      x1={scarpX} y1={ROAD_TOP} x2={scarpX} y2={ROAD_TOP - mainScarpH}
      stroke={C.scarp} strokeWidth={2} strokeDasharray="4,3" />,
  ];

  const dimX = edge + dir * (runPx + 14);
  nodes.push(
    <VDimArrow key={`dim-hs-${k}`}
      x={dimX} y1={ROAD_TOP - hsPx} y2={ROAD_TOP}
      label={m.slopeHeight_ft ? `H-S ${m.slopeHeight_ft}'` : "H-S"} />,
    <SvgText key={`phi-os-${k}`}
      x={edge + dir * 12} y={ROAD_TOP - 10}
      fontSize={9} fill={C.dim_text} textAnchor="middle">
      {m.originalSlopeDeg ? `Φ-OS ${m.originalSlopeDeg}°` : "Φ-OS"}
    </SvgText>,
  );

  if (m.mainScarpHeight_ft) {
    nodes.push(
      <SvgText key={`hhs-${k}`}
        x={scarpX + dir * 12} y={ROAD_TOP - mainScarpH / 2}
        fontSize={9} fill={C.scarp} textAnchor="start">
        {`H-HS ${m.mainScarpHeight_ft}'`}
      </SvgText>,
    );
  }

  return nodes;
}

function renderAboveRoadOverlay(
  data: MeasurementDiagramData,
  ltEdge: number,
  rtEdge: number,
  svgW: number,
): React.ReactNode[] {
  const sides: ("LT" | "RT")[] =
    data.failureSide === "BOTH" ? ["LT", "RT"] : [data.failureSide];
  return sides.flatMap((s) => renderAboveRoadOneSide(data, s, ltEdge, rtEdge, svgW));
}

/**
 * Draws a Landslide Below Road (low-side failure) overlay on one Caltrans side.
 */
function renderBelowRoadOneSide(
  data: MeasurementDiagramData,
  side: "LT" | "RT",
  ltEdge: number,
  rtEdge: number,
  svgW: number,
): React.ReactNode[] {
  const { measurements: m } = data;
  const { edge, dir } = getFailureEdgeAndDir(side, ltEdge, rtEdge, svgW);
  const k = side;

  const hsPx = m.slopeHeight_ft
    ? Math.min(BELOW_H - 8, m.slopeHeight_ft * 1.0)
    : BELOW_H * 0.65;
  const phiRad = m.landslideSlopeDeg ? (m.landslideSlopeDeg * Math.PI) / 180 : Math.atan(0.5);
  const runPx = hsPx / Math.tan(Math.max(0.1, phiRad));

  const slipTipX = edge + dir * runPx;
  const slipTipY = ROAD_BOT + hsPx;

  const nodes: React.ReactNode[] = [
    <Path key={`ls-below-${k}`}
      d={`M ${edge},${ROAD_BOT} L ${slipTipX},${slipTipY} L ${edge + dir * runPx * 0.6},${slipTipY} Z`}
      fill="url(#hatch_ls)"
      opacity={0.85}
    />,
    <Line key={`fill-slope-${k}`}
      x1={edge} y1={ROAD_BOT} x2={slipTipX} y2={slipTipY}
      stroke={C.slope_line} strokeWidth={2} />,
  ];

  const dimX = edge + dir * (runPx + 14);
  nodes.push(
    <VDimArrow key={`dim-hs-below-${k}`}
      x={dimX} y1={ROAD_BOT} y2={ROAD_BOT + hsPx}
      label={m.slopeHeight_ft ? `H-S ${m.slopeHeight_ft}'` : "H-S"} />,
    <SvgText key={`phi-ss-${k}`}
      x={edge + dir * 14} y={ROAD_BOT + 18}
      fontSize={9} fill={C.dim_text} textAnchor="middle">
      {m.landslideSlopeDeg ? `Φ-SS ${m.landslideSlopeDeg}°` : "Φ-SS"}
    </SvgText>,
  );

  return nodes;
}

function renderBelowRoadOverlay(
  data: MeasurementDiagramData,
  ltEdge: number,
  rtEdge: number,
  svgW: number,
): React.ReactNode[] {
  const sides: ("LT" | "RT")[] =
    data.failureSide === "BOTH" ? ["LT", "RT"] : [data.failureSide];
  return sides.flatMap((s) => renderBelowRoadOneSide(data, s, ltEdge, rtEdge, svgW));
}

function renderThroughRoadOverlay(
  data: MeasurementDiagramData,
  ltEdge: number,
  rtEdge: number,
  cx: number,
): React.ReactNode[] {
  const { measurements: m } = data;
  const nodes: React.ReactNode[] = [
    <Rect key="ls-through"
      x={ltEdge} y={ROAD_TOP} width={rtEdge - ltEdge} height={ROAD_H}
      fill="url(#hatch_ls)" opacity={0.55} />,
  ];

  const crackOffset = (rtEdge - ltEdge) * 0.22;
  nodes.push(
    <Line key="crack1"
      x1={cx - crackOffset} y1={ROAD_TOP} x2={cx} y2={ROAD_BOT}
      stroke={C.scarp} strokeWidth={2} strokeDasharray="5,3" />,
    <Line key="crack2"
      x1={cx} y1={ROAD_TOP} x2={cx + crackOffset} y2={ROAD_BOT}
      stroke={C.scarp} strokeWidth={2} strokeDasharray="5,3" />,
  );

  const dimY = DIM_Y - 6;
  nodes.push(
    <DimArrow key="dim-wm" x1={ltEdge} y={dimY} x2={rtEdge}
      label={m.landslideWidth_ft ? `W-M ${m.landslideWidth_ft}'` : "W-M"} />,
  );

  if (m.roadwayWidth_ft) {
    nodes.push(
      <SvgText key="rs-label" x={cx} y={dimY - 14}
        fontSize={9} fill={C.dim_text} textAnchor="middle">
        {`R&S ${m.roadwayWidth_ft}'`}
      </SvgText>,
    );
  }

  if (m.landslideLength_ft) {
    nodes.push(
      <SvgText key="tls" x={cx} y={ROAD_BOT + 32}
        fontSize={9} fill={C.dim_text} textAnchor="middle">
        {`TLS: ${m.landslideLength_ft}' (along slope)`}
      </SvgText>,
    );
  }

  return nodes;
}

// ── Station direction labels ──────────────────────────────────────────────────

// Canonical UPSTATION: the diagram always looks toward increasing postmile.
// These are static directional annotations (which way is up-/down-station), NOT
// a view toggle — there is no mirrored perspective.
function renderStationLabels(svgW: number): React.ReactNode[] {
  return [
    <SvgText key="st-up" x={svgW - 4} y={FOOTER_Y - 1}
      fontSize={9} fill="#60a5fa" textAnchor="end" fontWeight="700">
      UPSTATION →
    </SvgText>,
    <SvgText key="st-dn" x={4} y={FOOTER_Y - 1}
      fontSize={9} fill="#94a3b8" textAnchor="start">
      ← DOWNSTATION
    </SvgText>,
  ];
}

// Canonical UPSTATION: LT (Caltrans left) is always on the left of the diagram,
// RT always on the right.
function renderLtRtLabels(svgW: number): React.ReactNode[] {
  const ltX = 2;
  const rtX = svgW - 28;
  const labelY = ROAD_TOP + ROAD_H / 2 + 4;

  return [
    <Rect key="lt-bg" x={ltX} y={labelY - 11} width={26} height={13} fill={C.lt_chip} rx={3} />,
    <SvgText key="lt-lbl" x={ltX + 13} y={labelY}
      fontSize={10} fill="#fff" textAnchor="middle" fontWeight="700">LT</SvgText>,
    <Rect key="rt-bg" x={rtX} y={labelY - 11} width={26} height={13} fill={C.rt_chip} rx={3} />,
    <SvgText key="rt-lbl" x={rtX + 13} y={labelY}
      fontSize={10} fill="#fff" textAnchor="middle" fontWeight="700">RT</SvgText>,
  ];
}

// ── Header ────────────────────────────────────────────────────────────────────

function renderHeader(cs: RoadCrossSection, svgW: number): React.ReactNode[] {
  const parts: string[] = [];
  if (cs.route_name) parts.push(`SR ${cs.route_name}`);
  if (cs.county_code) parts.push(cs.county_code);
  if (cs.begin_pm != null && cs.end_pm != null) parts.push(`PM ${cs.begin_pm}–${cs.end_pm}`);
  if (cs.design_speed) parts.push(`${cs.design_speed} mph`);
  if (cs.terrain_code) parts.push(`Terrain: ${cs.terrain_code}`);
  const headerText = parts.length > 0 ? parts.join("  |  ") : "Road Cross-Section";

  const badgeText =
    cs.source === "ROAD_INVENTORY" ? "ROAD INVENTORY" :
    cs.source === "FORM_FIELDS" ? "FROM FORM" : "DEFAULT";
  const badgeColor = cs.source === "ROAD_INVENTORY" ? "#065f46" : "#78350f";

  return [
    <Rect key="hdr-bg" x={0} y={0} width={svgW} height={18} fill="#1e293b" />,
    <SvgText key="hdr-text" x={svgW / 2} y={12}
      fontSize={9} fill={C.header} textAnchor="middle">
      {headerText}
    </SvgText>,
    <Rect key="src-bg" x={svgW - 72} y={1} width={70} height={14} fill={badgeColor} rx={3} />,
    <SvgText key="src-txt" x={svgW - 37} y={11}
      fontSize={7.5} fill="#d1fae5" textAnchor="middle" fontWeight="700">
      {badgeText}
    </SvgText>,
  ];
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  data: MeasurementDiagramData;
  width: number;
}

export function RoadCrossSectionRenderer({ data, width }: Props) {
  const svgW = Math.max(200, width);

  // Canonical UPSTATION layout — never mirrored.
  const layout = useMemo(
    () => computeLayout(data.crossSection, svgW),
    [data.crossSection, svgW],
  );

  // Material-aware palette derived from the GISA form inputs.
  const pal = useMemo(
    () => buildTerrainPalette(data.terrainAppearance),
    [data.terrainAppearance],
  );

  const { els, ltEdge, rtEdge, cx } = layout;

  return (
    <Svg width={svgW} height={SVG_H} viewBox={`0 0 ${svgW} ${SVG_H}`}>
      <Defs>
        <Pattern
          id="hatch_ls"
          patternUnits="userSpaceOnUse"
          width="8" height="8"
          patternTransform="rotate(45 0 0)"
        >
          <Line x1="0" y1="0" x2="0" y2="8" stroke={C.ls_hatch} strokeWidth="2.5" />
        </Pattern>

        {/* Atmospheric backdrop */}
        <LinearGradient id="sky_grad" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={pal.skyTop} />
          <Stop offset="1" stopColor={pal.skyBottom} />
        </LinearGradient>

        {/* Ground body: lit crest → mid → shaded toe */}
        <LinearGradient id="terrain_fill" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={pal.top} />
          <Stop offset="0.5" stopColor={pal.mid} />
          <Stop offset="1" stopColor={pal.deep} />
        </LinearGradient>

        {/* Ambient occlusion toward the toe of the slope for depth */}
        <LinearGradient id="terrain_shadow" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#000000" stopOpacity="0" />
          <Stop offset="0.62" stopColor="#000000" stopOpacity="0" />
          <Stop offset="1" stopColor="#000000" stopOpacity="0.5" />
        </LinearGradient>

        {/* Damp darkening + sheen toward the toe when wet */}
        <LinearGradient id="terrain_moisture" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={pal.moisture} stopOpacity="0" />
          <Stop offset="0.55" stopColor={pal.moisture} stopOpacity="0.25" />
          <Stop offset="1" stopColor={pal.moisture} stopOpacity="0.82" />
        </LinearGradient>

        {/* Soil: fine granular speckle */}
        <Pattern id="terrain_tex_soil" patternUnits="userSpaceOnUse" width="9" height="9">
          <Circle cx="1.6" cy="2.2" r="0.8" fill={pal.texture} opacity="0.5" />
          <Circle cx="6.2" cy="5.4" r="0.6" fill={pal.texture} opacity="0.4" />
          <Circle cx="3.6" cy="7.6" r="0.5" fill={pal.texture} opacity="0.35" />
        </Pattern>

        {/* Rock: angular fracture hatch */}
        <Pattern id="terrain_tex_rock" patternUnits="userSpaceOnUse" width="11" height="11" patternTransform="rotate(20)">
          <Line x1="0" y1="0" x2="0" y2="11" stroke={pal.crack} strokeWidth="0.9" opacity="0.55" />
          <Line x1="5.5" y1="0" x2="5.5" y2="11" stroke={pal.texture} strokeWidth="0.6" opacity="0.4" />
        </Pattern>

        {/* Mixed: sparse grit + occasional seam */}
        <Pattern id="terrain_tex_mixed" patternUnits="userSpaceOnUse" width="12" height="12">
          <Circle cx="3" cy="3.4" r="0.7" fill={pal.texture} opacity="0.45" />
          <Line x1="7" y1="2" x2="10.5" y2="9.5" stroke={pal.crack} strokeWidth="0.7" opacity="0.4" />
        </Pattern>
      </Defs>

      {/* Atmospheric background */}
      <Rect x={0} y={0} width={svgW} height={SVG_H} fill="url(#sky_grad)" />

      {/* Terrain profile — material-aware ground render */}
      {renderTerrainProfile(data.terrainShape, data.terrainAppearance, pal, ltEdge, rtEdge, svgW)}

      {/* Road cross-section */}
      {renderRoadSection(els, data.crossSection, cx, pal)}

      {/* Template overlay — failure side from data.failureSide, not view */}
      {data.template === "LANDSLIDE_ABOVE_ROAD" &&
        renderAboveRoadOverlay(data, ltEdge, rtEdge, svgW)}
      {data.template === "LANDSLIDE_BELOW_ROAD_SLIPOUT" &&
        renderBelowRoadOverlay(data, ltEdge, rtEdge, svgW)}
      {data.template === "LANDSLIDE_THROUGH_ROAD" &&
        renderThroughRoadOverlay(data, ltEdge, rtEdge, cx)}

      {/* Width dimension labels */}
      {renderWidthLabels(els)}

      {/* LT / RT chips — always indicate Caltrans stationing sides */}
      {renderLtRtLabels(svgW)}

      {/* Station direction arrows (canonical UPSTATION) */}
      {renderStationLabels(svgW)}

      {/* Header */}
      {renderHeader(data.crossSection, svgW)}
    </Svg>
  );
}

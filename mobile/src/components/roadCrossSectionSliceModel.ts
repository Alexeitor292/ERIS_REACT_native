// Pure render-model for the realistic road cross-section slice view. Consumes a
// RoadCrossSectionSlice and produces screen-space geometry (deck spans, elevation-
// driven ground profiles, 10/20/50 ft stakes, labels, technical dimensions). The
// RoadCrossSectionSceneView React component is a thin SVG renderer over this model,
// and the native ErisRoadSliceSceneViewController builds the equivalent scene — this
// module is the TESTED source of truth for the layout + honest missing-sample handling.
//
// Deliberately NOT the flat schematic SVG: the ground is a real elevation profile from
// the USGS 3DEP samples (not fixed y-bands), the deck sits at its sampled elevation,
// and unavailable samples are shown honestly (never interpolated beyond coverage).
//
// No react-native/expo imports (unit-tested under node --test).

import type { RoadCrossSection } from "./../measurements/roadCrossSectionModel";
import type { CrossSectionSample, RoadCrossSectionSlice } from "./../measurements/roadCrossSectionSlice";

// Inlined from roadCrossSectionSlice (kept type-only cross-module so this stays
// node --test resolvable, matching the codebase's pure-module convention). Both are
// pinned by tests on each side.
function outsideShoulderEdgesFt(road: RoadCrossSection): { ltFt: number; rtFt: number } {
  const mh = Math.max(0, road.median_width_ft) / 2;
  return {
    ltFt: -(mh + road.lt_inside_shoulder_ft + road.lt_lane_count * road.lt_lane_width_ft + road.lt_outside_shoulder_ft),
    rtFt: mh + road.rt_inside_shoulder_ft + road.rt_lane_count * road.rt_lane_width_ft + road.rt_outside_shoulder_ft,
  };
}
function elevationDeltaFt(sample: CrossSectionSample | null, reference: CrossSectionSample | null): number | null {
  if (!sample || !reference || sample.elevationFt == null || reference.elevationFt == null) return null;
  return sample.elevationFt - reference.elevationFt;
}

export type SpanKind =
  | "lt_shoulder"
  | "rt_shoulder"
  | "lt_lanes"
  | "rt_lanes"
  | "lt_inside_shoulder"
  | "rt_inside_shoulder"
  | "median";

export type DeckSpan = { kind: SpanKind; x0: number; x1: number; ft: number; label: string };
export type Pt = { x: number; y: number };
export type StakeStatus = "OK" | "NO_DATA" | "OUT_OF_BOUNDS";

export type Stake = {
  side: "LT" | "RT";
  offsetFt: number;
  distanceFt: number; // 10 / 20 / 50 beyond the shoulder edge
  x: number;
  yGround: number;
  yTop: number;
  elevationText: string; // "412.3 ft" | "No data" | "Outside package"
  deltaText: string; // "+2.1 ft" relative to shoulder edge, or "—"
  status: StakeStatus;
};

export type DimLabel = { x: number; y: number; text: string };

export type SliceRenderModel = {
  width: number;
  height: number;
  technical: boolean;
  hasElevation: boolean;

  deckY: number;
  deckThickness: number;
  deckSpans: DeckSpan[];
  laneDividers: number[]; // x positions of interior lane dividers
  edgeLines: number[]; // x positions of the outer pavement (travel-way) edge lines
  centerlineX: number; // x of the roadway centerline (median center)

  ltGround: Pt[]; // elevation-driven ground profile (LT, outward from the shoulder)
  rtGround: Pt[];
  ltGroundMissing: boolean; // any LT ground sample unavailable
  rtGroundMissing: boolean;

  stakes: Stake[]; // 10/20/50 ft beyond both shoulders

  labels: {
    lt: string;
    rt: string;
    lookingUpstation: string;
    route: string | null;
    postmile: string | null;
    roadLayoutLabel: string; // "Roadway layout: Road Inventory"
    elevationLabel: string; // "Ground elevation: USGS 3DEP offline grid"
    schematicNote: string;
    snapNote: string;
  };

  dims: DimLabel[]; // technical overlay only: exact element widths + stake elevations
};

const PAD_X = 28;
const PAD_TOP = 56;
const PAD_BOT = 64;
const DECK_THICKNESS = 10;
// Vertical exaggeration for the ground profile so slope reads without dominating.
const V_EXAG = 2.5;

function fmtFt(n: number, digits = 1): string {
  return `${n.toFixed(digits)} ft`;
}

/** Deck spans (LT outer shoulder → RT outer shoulder) as signed offsets, classified. */
export function deckSpansFt(road: RoadCrossSection): DeckSpan[] {
  const mh = Math.max(0, road.median_width_ft) / 2;
  const ltInsideEdge = -(mh + road.lt_inside_shoulder_ft);
  const ltTravelEdge = -(mh + road.lt_inside_shoulder_ft + road.lt_lane_count * road.lt_lane_width_ft);
  const ltShoulderEdge = outsideShoulderEdgesFt(road).ltFt;
  const rtInsideEdge = mh + road.rt_inside_shoulder_ft;
  const rtTravelEdge = mh + road.rt_inside_shoulder_ft + road.rt_lane_count * road.rt_lane_width_ft;
  const rtShoulderEdge = outsideShoulderEdgesFt(road).rtFt;

  const spans: DeckSpan[] = [];
  const push = (kind: SpanKind, a: number, b: number, label: string) => {
    if (b - a > 1e-9) spans.push({ kind, x0: a, x1: b, ft: b - a, label });
  };
  push("lt_shoulder", ltShoulderEdge, ltTravelEdge, `LT shoulder ${fmtFt(road.lt_outside_shoulder_ft, 0)}`);
  push("lt_lanes", ltTravelEdge, ltInsideEdge, `${road.lt_lane_count}×${fmtFt(road.lt_lane_width_ft, 0)} LT`);
  push("lt_inside_shoulder", ltInsideEdge, -mh, `LT inside ${fmtFt(road.lt_inside_shoulder_ft, 0)}`);
  push("median", -mh, mh, `Median ${fmtFt(road.median_width_ft, 0)} (${road.median_category})`);
  push("rt_inside_shoulder", mh, rtInsideEdge, `RT inside ${fmtFt(road.rt_inside_shoulder_ft, 0)}`);
  push("rt_lanes", rtInsideEdge, rtTravelEdge, `${road.rt_lane_count}×${fmtFt(road.rt_lane_width_ft, 0)} RT`);
  push("rt_shoulder", rtTravelEdge, rtShoulderEdge, `RT shoulder ${fmtFt(road.rt_outside_shoulder_ft, 0)}`);
  return spans;
}

function okElevs(slice: RoadCrossSectionSlice): number[] {
  return slice.samples.filter((s) => s.status === "OK" && s.elevationFt != null).map((s) => s.elevationFt as number);
}

/** Reference elevation for the roadway deck: the sampled center/median elevation when
 *  available, else the mean of available road samples, else null (flat schematic). */
function deckElevationFt(slice: RoadCrossSectionSlice): number | null {
  const center = slice.samples.find((s) => s.offsetFt === 0 && s.status === "OK");
  if (center && center.elevationFt != null) return center.elevationFt;
  const roadOk = slice.samples.filter((s) => Math.abs(s.offsetFt) <= Math.abs(outsideShoulderEdgesFt(slice.road).rtFt) && s.status === "OK" && s.elevationFt != null);
  if (roadOk.length) return roadOk.reduce((a, s) => a + (s.elevationFt as number), 0) / roadOk.length;
  return null;
}

export function buildSliceRenderModel(
  slice: RoadCrossSectionSlice,
  opts?: { technical?: boolean; width?: number; height?: number },
): SliceRenderModel {
  const width = Math.max(280, opts?.width ?? 360);
  const height = Math.max(220, opts?.height ?? 300);
  const technical = !!opts?.technical;
  const road = slice.road;

  const { ltFt, rtFt } = outsideShoulderEdgesFt(road);
  const minOffset = ltFt - 50;
  const maxOffset = rtFt + 50;
  const spanOffset = Math.max(1, maxOffset - minOffset);
  const xForOffset = (ft: number) => PAD_X + ((ft - minOffset) / spanOffset) * (width - 2 * PAD_X);

  const elevs = okElevs(slice);
  const hasElevation = elevs.length > 0;
  const deckE = deckElevationFt(slice);
  let minE = hasElevation ? Math.min(...elevs) : 0;
  let maxE = hasElevation ? Math.max(...elevs) : 0;
  if (deckE != null) {
    minE = Math.min(minE, deckE);
    maxE = Math.max(maxE, deckE);
  }
  const rangeE = Math.max(1, (maxE - minE) * V_EXAG);
  const plotTop = PAD_TOP;
  const plotBot = height - PAD_BOT;
  // Higher elevation → smaller y. When there is no elevation, place the deck mid-plot.
  const yForElev = (ft: number) => {
    if (!hasElevation && deckE == null) return plotTop + (plotBot - plotTop) * 0.45;
    return plotBot - ((ft - minE) * V_EXAG) / rangeE * (plotBot - plotTop);
  };

  const deckRefE = deckE != null ? deckE : hasElevation ? (minE + maxE) / 2 : 0;
  const deckY = yForElev(deckRefE);

  // Deck spans + lane dividers + pavement edge lines.
  const deckSpans = deckSpansFt(road).map((s) => ({ ...s, x0: xForOffset(s.x0), x1: xForOffset(s.x1) }));
  const laneDividers: number[] = [];
  const mh = Math.max(0, road.median_width_ft) / 2;
  const ltTravelEdge = -(mh + road.lt_inside_shoulder_ft + road.lt_lane_count * road.lt_lane_width_ft);
  for (let k = 1; k < road.lt_lane_count; k++) laneDividers.push(xForOffset(ltTravelEdge + k * road.lt_lane_width_ft));
  const rtInsideEdge = mh + road.rt_inside_shoulder_ft;
  for (let k = 1; k < road.rt_lane_count; k++) laneDividers.push(xForOffset(rtInsideEdge + k * road.rt_lane_width_ft));
  const edgeLines = [xForOffset(ltTravelEdge), xForOffset(mh + road.rt_inside_shoulder_ft + road.rt_lane_count * road.rt_lane_width_ft)];

  // Elevation-driven ground profiles (beyond the shoulder), ordered outward.
  const groundSide = (side: "LT" | "RT"): { pts: Pt[]; missing: boolean } => {
    const edge = side === "LT" ? ltFt : rtFt;
    const rows = slice.samples
      .filter((s) => s.side === side && (side === "LT" ? s.offsetFt <= edge + 1e-9 : s.offsetFt >= edge - 1e-9))
      .sort((a, b) => Math.abs(b.offsetFt) - Math.abs(a.offsetFt)); // outward = larger |offset| first (far → near)
    const pts: Pt[] = [];
    let missing = false;
    for (const s of rows) {
      if (s.status === "OK" && s.elevationFt != null) pts.push({ x: xForOffset(s.offsetFt), y: yForElev(s.elevationFt) });
      else missing = true;
    }
    // Anchor the near end at the shoulder edge on the deck so the ground meets the road.
    pts.push({ x: xForOffset(edge), y: deckY });
    return { pts, missing };
  };
  const lt = groundSide("LT");
  const rt = groundSide("RT");

  // 10/20/50 ft stakes on both sides.
  const km = slice.keyMarkers;
  const stake = (side: "LT" | "RT", d: number, sample: CrossSectionSample | null, ref: CrossSectionSample | null): Stake => {
    const edge = side === "LT" ? ltFt : rtFt;
    const offsetFt = side === "LT" ? edge - d : edge + d;
    const x = xForOffset(offsetFt);
    let status: StakeStatus = "OUT_OF_BOUNDS";
    let elevationText = "Outside package";
    let yGround = deckY;
    if (sample) {
      status = sample.status;
      if (sample.status === "OK" && sample.elevationFt != null) {
        elevationText = fmtFt(sample.elevationFt);
        yGround = yForElev(sample.elevationFt);
      } else if (sample.status === "NO_DATA") {
        elevationText = "No data";
      } else {
        elevationText = "Outside package";
      }
    }
    const delta = elevationDeltaFt(sample, ref);
    const deltaText = delta == null ? "—" : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} ft`;
    return { side, offsetFt, distanceFt: d, x, yGround, yTop: yGround - 26, elevationText, deltaText, status };
  };
  const stakes: Stake[] = [
    stake("LT", 10, km.lt10ft, km.ltOutsideShoulderEdge),
    stake("LT", 20, km.lt20ft, km.ltOutsideShoulderEdge),
    stake("LT", 50, km.lt50ft, km.ltOutsideShoulderEdge),
    stake("RT", 10, km.rt10ft, km.rtOutsideShoulderEdge),
    stake("RT", 20, km.rt20ft, km.rtOutsideShoulderEdge),
    stake("RT", 50, km.rt50ft, km.rtOutsideShoulderEdge),
  ];

  const layoutSrc =
    road.source === "ROAD_INVENTORY" ? "Road Inventory" : road.source === "FORM_FIELDS" ? "form/default assumptions" : "default assumptions";
  const route = road.route_name ? `Route ${road.route_name}` : null;
  const postmile =
    road.begin_pm != null && road.end_pm != null ? `PM ${road.begin_pm}–${road.end_pm}` : road.begin_pm != null ? `PM ${road.begin_pm}` : null;

  const dims: DimLabel[] = [];
  if (technical) {
    for (const s of deckSpans) {
      dims.push({ x: (s.x0 + s.x1) / 2, y: deckY + DECK_THICKNESS + 14, text: s.label });
    }
    for (const st of stakes) {
      dims.push({ x: st.x, y: st.yTop - 12, text: `${st.side}+${st.distanceFt}ft ${st.elevationText} (${st.deltaText})` });
    }
  }

  return {
    width,
    height,
    technical,
    hasElevation,
    deckY,
    deckThickness: DECK_THICKNESS,
    deckSpans,
    laneDividers,
    edgeLines,
    centerlineX: xForOffset(0),
    ltGround: lt.pts,
    rtGround: rt.pts,
    ltGroundMissing: lt.missing,
    rtGroundMissing: rt.missing,
    stakes,
    labels: {
      lt: "LT",
      rt: "RT",
      lookingUpstation: "Looking upstation",
      route,
      postmile,
      roadLayoutLabel: `Roadway layout: ${layoutSrc}`,
      elevationLabel: "Ground elevation: USGS 3DEP offline grid",
      schematicNote: "Roadway surface is schematic unless pavement crown/superelevation data is available.",
      snapNote: slice.provenance.snappedToRoadContext
        ? `Snapped to ${slice.provenance.roadContextSource ?? "road context"}`
        : "Not snapped to a road feature (fallback orientation)",
    },
    dims,
  };
}

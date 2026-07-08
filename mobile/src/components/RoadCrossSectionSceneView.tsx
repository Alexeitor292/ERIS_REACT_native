/**
 * Realistic, map-driven road cross-section slice view (React Native / SVG).
 *
 * This is the cross-platform + FALLBACK renderer for the map-driven Cross Section
 * feature (the primary field view is the native SceneKit ErisRoadSliceSceneViewController).
 * It is deliberately NOT the flat schematic Measurements diagram (RoadCrossSectionRenderer):
 * the ground is a real USGS 3DEP elevation profile (not fixed y-bands), the roadway deck
 * sits at its sampled elevation with realistic asphalt/median materials, and unavailable
 * elevation samples are shown honestly (No data / Outside package), never invented.
 *
 * Canonical orientation: looking UPSTATION — LT always left, RT always right.
 * Layout comes from ERIS Road Inventory (schematic surface — no crown/superelevation
 * unless that data exists); ground elevation comes only from the packaged offline grid.
 *
 * All geometry comes from the tested render-model (roadCrossSectionSliceModel); this
 * component only paints it. No network, no external textures — procedural fills only.
 */

import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Defs, G, Line, LinearGradient, Path, Polyline, Rect, Stop, Text as SvgText } from "react-native-svg";

import type { RoadCrossSectionSlice } from "../measurements/roadCrossSectionSlice";
import { buildSliceRenderModel, type DeckSpan, type SliceRenderModel } from "./roadCrossSectionSliceModel";

export type RoadCrossSectionSceneViewProps = {
  slice: RoadCrossSectionSlice;
  width?: number;
  height?: number;
  technical?: boolean; // controlled technical-overlay state
  defaultTechnical?: boolean; // uncontrolled initial value
  onToggleTechnical?: (next: boolean) => void;
};

// Procedural, local material palette (no textures / no network).
const MAT = {
  skyTop: "#1b2735",
  skyBot: "#33465c",
  lane: "#33383f",
  shoulder: "#4b545f",
  insideShoulder: "#565f6a",
  medianRaised: "#6b7280",
  medianBarrier: "#9aa0a6",
  medianDepressed: "#3f6b3a",
  medianPaint: "#0f1216",
  deckFront: "#22262b",
  laneDivider: "#cbd2da",
  edgeLine: "#f4f6f8",
  yellowLine: "#f6c445",
  groundTop: "#6c7a4a",
  groundBot: "#3f3327",
  stake: "#e5533c",
  stakeHead: "#ffd0c6",
  text: "#e8edf2",
  textDim: "#9fb0c0",
  missing: "#c05a4a",
  panel: "rgba(10,14,20,0.72)",
};

function spanFill(kind: DeckSpan["kind"], medianCategory: string): string {
  switch (kind) {
    case "lt_lanes":
    case "rt_lanes":
      return MAT.lane;
    case "lt_shoulder":
    case "rt_shoulder":
      return MAT.shoulder;
    case "lt_inside_shoulder":
    case "rt_inside_shoulder":
      return MAT.insideShoulder;
    case "median":
      if (medianCategory === "BARRIER") return MAT.medianBarrier;
      if (medianCategory === "RAISED") return MAT.medianRaised;
      if (medianCategory === "DEPRESSED") return MAT.medianDepressed;
      return MAT.lane; // NONE / PAINTED — painted lines drawn separately
    default:
      return MAT.lane;
  }
}

function groundPolygon(pts: { x: number; y: number }[], height: number): string {
  if (pts.length < 2) return "";
  const top = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  const first = pts[0];
  return `${top} L${last.x.toFixed(1)},${height} L${first.x.toFixed(1)},${height} Z`;
}

export function RoadCrossSectionSceneView(props: RoadCrossSectionSceneViewProps): React.JSX.Element {
  const width = props.width ?? 360;
  const height = props.height ?? 300;
  const [uncontrolled, setUncontrolled] = useState(props.defaultTechnical ?? false);
  const technical = props.technical ?? uncontrolled;
  const toggle = () => {
    const next = !technical;
    if (props.onToggleTechnical) props.onToggleTechnical(next);
    else setUncontrolled(next);
  };

  const m: SliceRenderModel = useMemo(
    () => buildSliceRenderModel(props.slice, { technical, width, height }),
    [props.slice, technical, width, height],
  );
  const medianCat = props.slice.road.median_category;

  return (
    <View style={[styles.wrap, { width }]}>
      <Svg width={width} height={height} accessibilityLabel="Road cross-section looking upstation">
        <Defs>
          <LinearGradient id="rxsSky" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={MAT.skyTop} />
            <Stop offset="1" stopColor={MAT.skyBot} />
          </LinearGradient>
          <LinearGradient id="rxsGround" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={MAT.groundTop} />
            <Stop offset="1" stopColor={MAT.groundBot} />
          </LinearGradient>
        </Defs>

        {/* Sky */}
        <Rect x={0} y={0} width={width} height={height} fill="url(#rxsSky)" />

        {/* Elevation-driven ground fills (LT + RT) — the terrain cutaway, not a flat chart */}
        {m.ltGround.length >= 2 ? <Path d={groundPolygon(m.ltGround, height)} fill="url(#rxsGround)" /> : null}
        {m.rtGround.length >= 2 ? <Path d={groundPolygon(m.rtGround, height)} fill="url(#rxsGround)" /> : null}
        {m.ltGround.length >= 2 ? (
          <Polyline points={m.ltGround.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="#8b9a63" strokeWidth={2} />
        ) : null}
        {m.rtGround.length >= 2 ? (
          <Polyline points={m.rtGround.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="#8b9a63" strokeWidth={2} />
        ) : null}

        {/* Roadway deck: front face (cutaway) + top surface spans */}
        <G>
          {m.deckSpans.map((s, i) => (
            <Rect key={`f${i}`} x={s.x0} y={m.deckY} width={Math.max(0, s.x1 - s.x0)} height={m.deckThickness + 3} fill={MAT.deckFront} />
          ))}
          {m.deckSpans.map((s, i) => (
            <Rect key={`t${i}`} x={s.x0} y={m.deckY - 3} width={Math.max(0, s.x1 - s.x0)} height={5} fill={spanFill(s.kind, medianCat)} />
          ))}
          {/* Barrier / raised median get a raised block above the deck */}
          {m.deckSpans
            .filter((s) => s.kind === "median" && (medianCat === "BARRIER" || medianCat === "RAISED"))
            .map((s, i) => (
              <Rect
                key={`mb${i}`}
                x={s.x0}
                y={m.deckY - (medianCat === "BARRIER" ? 16 : 7)}
                width={Math.max(0, s.x1 - s.x0)}
                height={medianCat === "BARRIER" ? 16 : 7}
                fill={spanFill(s.kind, medianCat)}
                rx={2}
              />
            ))}
          {/* Lane dividers (dashed) + outer pavement edge lines (solid white) */}
          {m.laneDividers.map((x, i) => (
            <Line key={`d${i}`} x1={x} y1={m.deckY - 3} x2={x} y2={m.deckY + 2} stroke={MAT.laneDivider} strokeWidth={1.5} strokeDasharray="4,3" />
          ))}
          {m.edgeLines.map((x, i) => (
            <Line key={`e${i}`} x1={x} y1={m.deckY - 3} x2={x} y2={m.deckY + 2} stroke={MAT.edgeLine} strokeWidth={1.5} />
          ))}
          {/* Painted centerline for NONE / PAINTED medians */}
          {medianCat === "NONE" || medianCat === "PAINTED" ? (
            <Line x1={m.centerlineX} y1={m.deckY - 3} x2={m.centerlineX} y2={m.deckY + 2} stroke={MAT.yellowLine} strokeWidth={2} />
          ) : null}
        </G>

        {/* 10/20/50 ft stakes (both sides) with elevation + delta or honest status */}
        <G>
          {m.stakes.map((st, i) => (
            <G key={`s${i}`}>
              <Line
                x1={st.x}
                y1={st.yGround}
                x2={st.x}
                y2={st.yTop}
                stroke={st.status === "OK" ? MAT.stake : MAT.missing}
                strokeWidth={2}
                strokeDasharray={st.status === "OK" ? undefined : "3,3"}
              />
              <Rect x={st.x - 3} y={st.yTop - 3} width={6} height={6} fill={st.status === "OK" ? MAT.stakeHead : MAT.missing} />
              <SvgText x={st.x} y={st.yTop - 8} fill={MAT.text} fontSize={9} textAnchor="middle">
                {`${st.distanceFt}ft`}
              </SvgText>
              <SvgText x={st.x} y={st.yGround + 12} fill={st.status === "OK" ? MAT.textDim : MAT.missing} fontSize={8} textAnchor="middle">
                {st.status === "OK" ? `${st.elevationText}` : st.elevationText}
              </SvgText>
            </G>
          ))}
        </G>

        {/* Orientation labels */}
        <SvgText x={PADX} y={26} fill={MAT.text} fontSize={13} fontWeight="bold">{m.labels.lt}</SvgText>
        <SvgText x={width - PADX} y={26} fill={MAT.text} fontSize={13} fontWeight="bold" textAnchor="end">{m.labels.rt}</SvgText>
        <SvgText x={width / 2} y={16} fill={MAT.text} fontSize={11} textAnchor="middle">{m.labels.lookingUpstation}</SvgText>
        {m.labels.route ? (
          <SvgText x={width / 2} y={30} fill={MAT.textDim} fontSize={9} textAnchor="middle">
            {[m.labels.route, m.labels.postmile].filter(Boolean).join("  ·  ")}
          </SvgText>
        ) : null}

        {/* Technical overlay: exact widths + stake values */}
        {technical
          ? m.dims.map((d, i) => (
              <SvgText key={`dim${i}`} x={d.x} y={d.y} fill={MAT.yellowLine} fontSize={8} textAnchor="middle">
                {d.text}
              </SvgText>
            ))
          : null}
      </Svg>

      {/* Provenance footer (honest labelling) */}
      <View style={styles.footer}>
        <Text style={styles.footerText}>{m.labels.roadLayoutLabel}</Text>
        <Text style={styles.footerText}>{m.labels.elevationLabel}</Text>
        <Text style={styles.footerDim}>{m.labels.snapNote}</Text>
        {!m.hasElevation ? <Text style={styles.footerWarn}>Ground elevation unavailable for this slice (outside package / no data).</Text> : null}
        <Text style={styles.footerDim}>{m.labels.schematicNote}</Text>
      </View>

      <Pressable onPress={toggle} style={[styles.toggle, technical && styles.toggleOn]} accessibilityRole="switch" accessibilityState={{ checked: technical }}>
        <Text style={styles.toggleText}>{technical ? "Technical overlay: ON" : "Technical overlay: OFF"}</Text>
      </Pressable>
    </View>
  );
}

const PADX = 28;

const styles = StyleSheet.create({
  wrap: { alignSelf: "center", backgroundColor: "#0b0f16", borderRadius: 10, overflow: "hidden" },
  footer: { paddingHorizontal: 12, paddingVertical: 8, gap: 2, backgroundColor: MAT.panel },
  footerText: { color: MAT.text, fontSize: 11 },
  footerDim: { color: MAT.textDim, fontSize: 10 },
  footerWarn: { color: MAT.missing, fontSize: 10 },
  toggle: { margin: 10, paddingVertical: 8, borderRadius: 8, alignItems: "center", backgroundColor: "#1f2937" },
  toggleOn: { backgroundColor: "#2b4a63" },
  toggleText: { color: MAT.text, fontSize: 12, fontWeight: "600" },
});

export default RoadCrossSectionSceneView;

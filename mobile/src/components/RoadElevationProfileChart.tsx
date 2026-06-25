/**
 * Live 2D roadside slope profile.
 *
 * Renders the ACTUAL sampled USGS 3DEP / EPQS cross-section (offset vs.
 * elevation) as an art-directed terrain cut — the real ground shape, not the
 * coarse LEFT_HIGH / BOWL / CROWN classification (shown only as a summary chip).
 *
 * The terrain surface is the real sampled polyline. Between measured points it
 * is gently curved (centripetal Catmull-Rom, which passes through every sample
 * and does not invent peaks); each measured sample is still marked with a dot so
 * the engineering data stays trustworthy.
 *
 * The body is shaded and textured from the GISA form inputs via
 * buildTerrainPalette(): soil vs. rock material, moisture/seep, vegetation, and
 * pavement context. See buildTerrainAppearance.ts for the field mapping.
 *
 * Orientation is canonical UPSTATION (always): LT on the left, RT on the right.
 * There is no mirror/DOWNSTATION toggle.
 *
 * Fallbacks:
 *   - No profile / no usable points (e.g. no road bearing, so only the center
 *     point was sampled) → a clear explanatory empty state, never a crash.
 */

import React, { useCallback, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  type LayoutChangeEvent,
} from "react-native";
import Svg, {
  Rect,
  Line,
  Path,
  Circle,
  Text as SvgText,
  G,
  Defs,
  LinearGradient,
  Stop,
  Pattern,
} from "react-native-svg";
import type { GisaElevationProfile } from "../api/submissions";
import type { TerrainAppearance } from "../measurements/measurementDiagramModel";
import { buildElevationProfileGeometry } from "../measurements/buildElevationProfileGeometry";
import { buildTerrainPalette } from "../measurements/buildTerrainAppearance";

const M_TO_FT = 3.280839895;

const CHART_H = 200;
const PLOT_LEFT = 38; // room for elevation axis labels
const PLOT_TOP = 12;
const PLOT_BOTTOM = CHART_H - 24; // room for LT/RT + distance labels
const PLOT_RIGHT_PAD = 12;

const C = {
  bg: "#0f172a",
  sample: "#fde68a",
  roadMark: "#f8fafc",
  ref: "#64748b",
  label: "#94a3b8",
  muted: "#64748b",
  ltChip: "#1d4ed8",
  rtChip: "#15803d",
};

// Neutral appearance so the chart still renders richly when the caller has no
// form context (used as a defensive default only).
const NEUTRAL_APPEARANCE: TerrainAppearance = {
  dominantMaterial: "MIXED",
  moisture: "DRY",
  moistureLevel: 0.1,
  vegetationDensity: 0.2,
  rockiness: 0.45,
  soilPct: 50,
  rockPct: 40,
  clayPct: 0,
  siltPct: 0,
  sandPct: 0,
  gravelPct: 0,
  boulderPct: 0,
  treesPct: 0,
  shrubsPct: 0,
  groundcoverPct: 0,
  seep: false,
  spring: false,
  bedding: false,
  joints: false,
  fractures: false,
  pavementType: null,
};

interface Props {
  elevationProfile?: GisaElevationProfile | null;
  /** Optional roadway width (ft) to draw a to-scale road band at the center. */
  roadwayWidthFt?: number | null;
  /** Material/moisture/vegetation context derived from the GISA form. */
  appearance?: TerrainAppearance | null;
}

type Pt = { x: number; y: number };

function formatExag(exag: number): string {
  if (exag >= 0.9 && exag <= 1.1) return "≈ true scale (1:1)";
  if (exag < 1) return `${exag.toFixed(2)}× vertical (compressed to fit)`;
  return `${exag.toFixed(1)}× vertical exaggeration`;
}

/**
 * Centripetal Catmull-Rom spline through ALL points → cubic-bezier path string.
 * Passes through every sample (honest) and avoids the overshoot/cusps of the
 * uniform variant, so it never invents terrain between measured points.
 */
function smoothPath(pts: Pt[]): string {
  if (pts.length === 0) return "";
  if (pts.length < 3) {
    return `M ${pts.map((p) => `${p.x},${p.y}`).join(" L ")}`;
  }
  const alpha = 0.5; // centripetal
  let d = `M ${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;

    const d1 = Math.max(1e-4, Math.hypot(p1.x - p0.x, p1.y - p0.y) ** alpha);
    const d2 = Math.max(1e-4, Math.hypot(p2.x - p1.x, p2.y - p1.y) ** alpha);
    const d3 = Math.max(1e-4, Math.hypot(p3.x - p2.x, p3.y - p2.y) ** alpha);

    // Tangents (Barry-Goldman / centripetal Catmull-Rom).
    const b1x = (p2.x - p1.x + d2 * ((p1.x - p0.x) / d1 - (p2.x - p0.x) / (d1 + d2))) ;
    const b1y = (p2.y - p1.y + d2 * ((p1.y - p0.y) / d1 - (p2.y - p0.y) / (d1 + d2))) ;
    const b2x = (p2.x - p1.x + d2 * ((p3.x - p2.x) / d3 - (p3.x - p1.x) / (d2 + d3))) ;
    const b2y = (p2.y - p1.y + d2 * ((p3.y - p2.y) / d3 - (p3.y - p1.y) / (d2 + d3))) ;

    const c1x = p1.x + b1x / 3;
    const c1y = p1.y + b1y / 3;
    const c2x = p2.x - b2x / 3;
    const c2y = p2.y - b2y / 3;
    d += ` C ${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
  }
  return d;
}

/** Surface y at a given x by linear interpolation across the real polyline. */
function surfaceYAtX(pts: Pt[], x: number): number {
  if (pts.length === 0) return 0;
  if (x <= pts[0].x) return pts[0].y;
  const last = pts[pts.length - 1];
  if (x >= last.x) return last.y;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (x >= a.x && x <= b.x) {
      const t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
      return a.y + (b.y - a.y) * t;
    }
  }
  return last.y;
}

export function RoadElevationProfileChart({ elevationProfile, roadwayWidthFt, appearance }: Props) {
  const [width, setWidth] = useState(0);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    setWidth(e.nativeEvent.layout.width);
  }, []);

  const plotW = Math.max(1, width - PLOT_LEFT - PLOT_RIGHT_PAD);
  const plotH = PLOT_BOTTOM - PLOT_TOP;

  const geometry = useMemo(
    () =>
      width > 0
        ? buildElevationProfileGeometry(elevationProfile, {
            plotWidthPx: plotW,
            plotHeightPx: plotH,
          })
        : null,
    [elevationProfile, plotW, plotH, width],
  );

  const app = appearance ?? NEUTRAL_APPEARANCE;
  const pal = useMemo(() => buildTerrainPalette(app), [app]);

  // Canonical UPSTATION orientation: LT is always on the left, RT on the right.
  const leftLabel = "LT";
  const rightLabel = "RT";

  const header = (
    <View style={styles.headerRow}>
      <Text style={styles.title}>Roadside slope profile</Text>
      <View style={styles.orientChip}>
        <Text style={styles.orientChipText}>UPSTATION →</Text>
      </View>
    </View>
  );

  // Empty / fallback state
  if (geometry && !geometry.usable) {
    const cls = geometry.classification;
    return (
      <View style={styles.wrapper} onLayout={onLayout}>
        {header}
        <View style={styles.emptyBox}>
          <Text style={styles.emptyText}>{geometry.reason}</Text>
          {geometry.centerElev_ft != null && (
            <Text style={styles.emptySub}>
              Center elevation: {geometry.centerElev_ft.toFixed(1)} ft (USGS 3DEP)
            </Text>
          )}
          {cls && cls !== "UNKNOWN" && (
            <Text style={styles.emptySub}>Terrain summary: {cls}</Text>
          )}
        </View>
      </View>
    );
  }

  const textureFill =
    app.dominantMaterial === "ROCK" ? "url(#slope_tex_rock)" :
    app.dominantMaterial === "SOIL" ? "url(#slope_tex_soil)" :
    "url(#slope_tex_mixed)";

  return (
    <View style={styles.wrapper} onLayout={onLayout}>
      {header}

      {geometry && geometry.usable && width > 0 ? (
        <>
          <View style={styles.noteRow}>
            <Text style={styles.note}>
              {formatExag(geometry.verticalExaggeration)} · relief {geometry.relief_ft.toFixed(0)} ft
              {` · ${app.dominantMaterial.toLowerCase()}`}
              {app.moisture !== "DRY" ? ` · ${app.moisture.toLowerCase()}` : ""}
              {geometry.classification && geometry.classification !== "UNKNOWN"
                ? ` · ${geometry.classification}`
                : ""}
            </Text>
          </View>
          <Svg width={width} height={CHART_H}>
            <Defs>
              <LinearGradient id="slope_sky" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={pal.skyTop} />
                <Stop offset="1" stopColor={pal.skyBottom} />
              </LinearGradient>
              <LinearGradient id="slope_fill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={pal.top} />
                <Stop offset="0.5" stopColor={pal.mid} />
                <Stop offset="1" stopColor={pal.deep} />
              </LinearGradient>
              <LinearGradient id="slope_shadow" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor="#000000" stopOpacity="0" />
                <Stop offset="0.62" stopColor="#000000" stopOpacity="0" />
                <Stop offset="1" stopColor="#000000" stopOpacity="0.5" />
              </LinearGradient>
              <LinearGradient id="slope_moisture" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={pal.moisture} stopOpacity="0" />
                <Stop offset="0.5" stopColor={pal.moisture} stopOpacity="0.25" />
                <Stop offset="1" stopColor={pal.moisture} stopOpacity="0.82" />
              </LinearGradient>
              <Pattern id="slope_tex_soil" patternUnits="userSpaceOnUse" width="9" height="9">
                <Circle cx="1.6" cy="2.2" r="0.8" fill={pal.texture} opacity="0.5" />
                <Circle cx="6.2" cy="5.4" r="0.6" fill={pal.texture} opacity="0.4" />
                <Circle cx="3.6" cy="7.6" r="0.5" fill={pal.texture} opacity="0.35" />
              </Pattern>
              <Pattern id="slope_tex_rock" patternUnits="userSpaceOnUse" width="11" height="11" patternTransform="rotate(20)">
                <Line x1="0" y1="0" x2="0" y2="11" stroke={pal.crack} strokeWidth="0.9" opacity="0.55" />
                <Line x1="5.5" y1="0" x2="5.5" y2="11" stroke={pal.texture} strokeWidth="0.6" opacity="0.4" />
              </Pattern>
              <Pattern id="slope_tex_mixed" patternUnits="userSpaceOnUse" width="12" height="12">
                <Circle cx="3" cy="3.4" r="0.7" fill={pal.texture} opacity="0.45" />
                <Line x1="7" y1="2" x2="10.5" y2="9.5" stroke={pal.crack} strokeWidth="0.7" opacity="0.4" />
              </Pattern>
            </Defs>

            {/* Atmospheric sky backdrop */}
            <Rect x={PLOT_LEFT} y={PLOT_TOP} width={plotW} height={plotH} fill="url(#slope_sky)" />

            {(() => {
              const px = (xFrac: number) => PLOT_LEFT + xFrac * plotW;
              const py = (yFrac: number) => PLOT_TOP + yFrac * plotH;
              const pxPts: Pt[] = geometry.points.map((p) => ({ x: px(p.xFrac), y: py(p.yFrac) }));
              const top = smoothPath(pxPts);
              const firstX = pxPts[0].x;
              const lastX = pxPts[pxPts.length - 1].x;
              // Filled body: smoothed crest, then close down the sides to the toe.
              const body = `${top} L ${lastX.toFixed(2)},${PLOT_BOTTOM} L ${firstX.toFixed(2)},${PLOT_BOTTOM} Z`;

              const roadX = px(geometry.roadCenterXFrac);
              const roadRefY = py(geometry.centerYFrac);

              // Optional to-scale road band centered at offset 0.
              let roadBand: React.ReactNode = null;
              if (roadwayWidthFt && roadwayWidthFt > 0) {
                const halfBandM = roadwayWidthFt / M_TO_FT / 2;
                const halfBandFrac = halfBandM / (2 * geometry.halfSpan_m);
                const bandLeftFrac = Math.max(0, geometry.roadCenterXFrac - halfBandFrac);
                const bandRightFrac = Math.min(1, geometry.roadCenterXFrac + halfBandFrac);
                roadBand = (
                  <Rect
                    x={px(bandLeftFrac)}
                    y={PLOT_TOP}
                    width={Math.max(2, px(bandRightFrac) - px(bandLeftFrac))}
                    height={plotH}
                    fill={pal.road}
                    opacity={0.5}
                  />
                );
              }

              // ── Material decorations along the real surface ──────────────
              const decorations: React.ReactNode[] = [];
              const leftBound = firstX + 3;
              const rightBound = lastX - 3;
              const spanX = Math.max(1, rightBound - leftBound);

              // Vegetation clumps
              if (app.vegetationDensity >= 0.12) {
                const vegCount = app.vegetationDensity > 0.58 ? 6 : app.vegetationDensity > 0.32 ? 4 : 3;
                for (let i = 0; i < vegCount; i++) {
                  const x = leftBound + spanX * ((i + 0.5) / vegCount);
                  const y = surfaceYAtX(pxPts, x) - 2.4 - (i % 2) * 1.4;
                  const r = 2.4 + app.vegetationDensity * 2.4 + (app.treesPct / 100) * 1.4;
                  decorations.push(
                    <Circle key={`veg-sh-${i}`} cx={x} cy={y + 1.1} r={r * 0.92} fill={pal.vegetationDark} opacity={0.55} />,
                    <Circle key={`veg-${i}`} cx={x} cy={y} r={r} fill={pal.vegetation} />,
                  );
                }
              }

              // Rock / boulder accents
              if (app.rockiness >= 0.35 || app.boulderPct >= 8) {
                const rockCount = app.boulderPct > 26 ? 5 : app.rockiness > 0.66 ? 4 : 2;
                for (let i = 0; i < rockCount; i++) {
                  const x = leftBound + spanX * ((i + 0.35) / rockCount);
                  const surfaceY = surfaceYAtX(pxPts, x);
                  const y = surfaceY + 3 + (i % 3) * 4;
                  if (y > PLOT_BOTTOM - 3) continue;
                  const r = 2.4 + app.rockiness * 2.0 + (app.boulderPct / 100) * 2.8;
                  decorations.push(
                    <Circle key={`rock-${i}`} cx={x} cy={y} r={r} fill={pal.stone} stroke={pal.stoneShade} strokeWidth={0.9} />,
                    <Line key={`rock-shine-${i}`} x1={x - r * 0.5} y1={y - r * 0.3} x2={x + r * 0.25} y2={y - r * 0.55} stroke="#ffffff" strokeWidth={0.7} opacity={0.2} />,
                  );
                }
              }

              // Moisture / seep streaks running downslope
              if (app.moistureLevel >= 0.52 || app.seep || app.spring) {
                const streaks = app.moisture === "FLOWING" ? 3 : 2;
                for (let i = 0; i < streaks; i++) {
                  const x = leftBound + spanX * (0.28 + 0.4 * (i / Math.max(1, streaks - 1)));
                  const startY = surfaceYAtX(pxPts, x);
                  const endY = Math.min(PLOT_BOTTOM - 2, startY + 22 + i * 8);
                  decorations.push(
                    <Line key={`wet-${i}`} x1={x} y1={startY + 1} x2={x + 2} y2={endY} stroke={pal.moisture} strokeWidth={1.6} opacity={0.7} />,
                    <Line key={`wet-shine-${i}`} x1={x + 1} y1={startY + 2} x2={x + 3} y2={endY} stroke="#dbeafe" strokeWidth={0.6} opacity={0.4} />,
                  );
                }
              }

              const surfaceStroke = app.vegetationDensity > 0.18 ? pal.vegetation : pal.top;

              return (
                <G>
                  {roadBand}

                  {/* Layered ground body: base → depth shadow → material texture → moisture */}
                  <Path d={body} fill="url(#slope_fill)" />
                  <Path d={body} fill="url(#slope_shadow)" opacity={0.72} />
                  <Path d={body} fill={textureFill} opacity={0.42 + app.rockiness * 0.12} />
                  {app.moistureLevel > 0.18 && (
                    <Path d={body} fill="url(#slope_moisture)" opacity={0.26 + app.moistureLevel * 0.24} />
                  )}

                  {/* Material decorations sit on/under the surface */}
                  {decorations}

                  {/* Surface crest: shadow under-stroke, material stroke, rim light */}
                  <Path d={top} fill="none" stroke={pal.crack} strokeWidth={2.6} opacity={0.4} transform="translate(0,1.2)" />
                  <Path d={top} fill="none" stroke={surfaceStroke} strokeWidth={2.2} />
                  <Path d={top} fill="none" stroke="#ffffff" strokeWidth={0.7} opacity={0.22} transform="translate(0,-1)" />

                  {/* Road-grade reference line (elevation at road center) */}
                  <Line
                    x1={PLOT_LEFT} y1={roadRefY} x2={PLOT_LEFT + plotW} y2={roadRefY}
                    stroke={C.ref} strokeWidth={1} strokeDasharray="3,4" opacity={0.7}
                  />

                  {/* Sample points — the real measured data */}
                  {pxPts.map((p, i) => (
                    <Circle key={`s-${i}`} cx={p.x} cy={p.y} r={1.6} fill={C.sample} stroke="#1f2937" strokeWidth={0.5} />
                  ))}

                  {/* Road center marker */}
                  <Line x1={roadX} y1={PLOT_TOP} x2={roadX} y2={PLOT_BOTTOM} stroke={C.roadMark} strokeWidth={1} opacity={0.55} />
                  <Rect x={roadX - 13} y={PLOT_TOP + 1} width={26} height={11} rx={2} fill="#0f172a" opacity={0.55} />
                  <SvgText x={roadX} y={PLOT_TOP + 9} fontSize={8} fill={C.roadMark} textAnchor="middle">
                    Road
                  </SvgText>

                  {/* Elevation axis labels (over the dark gutter — always legible) */}
                  <SvgText x={PLOT_LEFT - 4} y={PLOT_TOP + 8} fontSize={8} fill={C.label} textAnchor="end">
                    {geometry.maxElev_ft.toFixed(0)}
                  </SvgText>
                  <SvgText x={PLOT_LEFT - 4} y={PLOT_BOTTOM} fontSize={8} fill={C.label} textAnchor="end">
                    {geometry.minElev_ft.toFixed(0)}
                  </SvgText>
                  <SvgText x={PLOT_LEFT - 4} y={roadRefY + 3} fontSize={7.5} fill={C.muted} textAnchor="end">
                    {geometry.centerElev_ft.toFixed(0)}
                  </SvgText>
                  <SvgText
                    x={10} y={PLOT_TOP + plotH / 2}
                    fontSize={7.5} fill={C.muted} textAnchor="middle"
                    transform={`rotate(-90 10 ${PLOT_TOP + plotH / 2})`}
                  >
                    Elev (ft)
                  </SvgText>
                </G>
              );
            })()}

            {/* LT / RT side chips — canonical UPSTATION: LT left, RT right */}
            <Rect x={PLOT_LEFT} y={PLOT_BOTTOM + 4} width={20} height={12} rx={2} fill={C.ltChip} />
            <SvgText x={PLOT_LEFT + 10} y={PLOT_BOTTOM + 13} fontSize={8} fill="#fff" textAnchor="middle" fontWeight="700">
              {leftLabel}
            </SvgText>
            <Rect x={PLOT_LEFT + plotW - 20} y={PLOT_BOTTOM + 4} width={20} height={12} rx={2} fill={C.rtChip} />
            <SvgText x={PLOT_LEFT + plotW - 10} y={PLOT_BOTTOM + 13} fontSize={8} fill="#fff" textAnchor="middle" fontWeight="700">
              {rightLabel}
            </SvgText>

            {/* Distance extent label */}
            <SvgText x={PLOT_LEFT + plotW / 2} y={PLOT_BOTTOM + 13} fontSize={8} fill={C.muted} textAnchor="middle">
              {`±${geometry.halfSpan_m.toFixed(0)} m (${(geometry.halfSpan_m * M_TO_FT).toFixed(0)} ft) each side`}
            </SvgText>
          </Svg>
        </>
      ) : (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyText}>Loading slope profile…</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    backgroundColor: C.bg,
    borderRadius: 8,
    overflow: "hidden",
    marginTop: 8,
    paddingBottom: 4,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  title: {
    fontSize: 11,
    fontWeight: "700",
    color: "#34d399",
  },
  orientChip: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: "#1e3a5f",
  },
  orientChipText: {
    fontSize: 8.5,
    fontWeight: "700",
    color: "#93c5fd",
  },
  noteRow: {
    paddingHorizontal: 8,
    paddingBottom: 2,
  },
  note: {
    fontSize: 8.5,
    color: C.muted,
    fontStyle: "italic",
  },
  emptyBox: {
    paddingHorizontal: 12,
    paddingVertical: 16,
    alignItems: "center",
    gap: 4,
  },
  emptyText: {
    fontSize: 10,
    color: C.label,
    textAlign: "center",
  },
  emptySub: {
    fontSize: 9,
    color: C.muted,
    textAlign: "center",
  },
});

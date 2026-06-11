import React, { useState, useCallback, useEffect } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet, LayoutChangeEvent,
  Modal, SafeAreaView, StatusBar,
} from "react-native";
// Rotation is best-effort. Some Expo Go / dev-client binaries may not include
// ExpoScreenOrientation until the native client is rebuilt with the module.
// We lazy-require to avoid a crash at module load time when it is missing.
import type * as ScreenOrientationTypes from "expo-screen-orientation";

let _screenOrientationModule: typeof ScreenOrientationTypes | null | undefined;

function getScreenOrientationModule(): typeof ScreenOrientationTypes | null {
  if (_screenOrientationModule !== undefined) return _screenOrientationModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _screenOrientationModule = require("expo-screen-orientation");
  } catch {
    _screenOrientationModule = null;
  }
  return _screenOrientationModule ?? null;
}

async function unlockOrientationIfAvailable(): Promise<void> {
  const mod = getScreenOrientationModule();
  if (!mod) return;
  try {
    await mod.unlockAsync();
  } catch {
    // Native module unavailable in this client; fullscreen still works.
  }
}

async function lockPortraitIfAvailable(): Promise<void> {
  const mod = getScreenOrientationModule();
  if (!mod) return;
  try {
    await mod.lockAsync(mod.OrientationLock.PORTRAIT_UP);
  } catch {
    // Native module unavailable in this client; ignore.
  }
}
import { RoadCrossSectionRenderer } from "./RoadCrossSectionRenderer";
import { buildMeasurementDiagramData } from "../measurements/buildMeasurementDiagramData";
import type { DiagramTemplate, FailureSide, StationingView, TerrainSideShape } from "../measurements/measurementDiagramModel";
import type { GisaElevationProfile } from "../api/submissions";

interface Props {
  formValues: Record<string, string | undefined | null>;
  roadInventorySnapshot?: Record<string, unknown> | null;
  elevationProfile?: GisaElevationProfile | null;
}

const TEMPLATES: { key: DiagramTemplate | "AUTO"; label: string }[] = [
  { key: "AUTO", label: "AUTO" },
  { key: "LANDSLIDE_THROUGH_ROAD", label: "THROUGH" },
  { key: "LANDSLIDE_ABOVE_ROAD", label: "ABOVE" },
  { key: "LANDSLIDE_BELOW_ROAD_SLIPOUT", label: "SLIPOUT" },
];

const FAILURE_SIDES: { key: FailureSide; label: string }[] = [
  { key: "LT", label: "LT SIDE" },
  { key: "RT", label: "RT SIDE" },
  { key: "BOTH", label: "BOTH" },
];

const TERRAIN_SHAPES: { key: TerrainSideShape | "AUTO"; label: string }[] = [
  { key: "AUTO", label: "Auto" },
  { key: "LEFT_HIGH", label: "L-High" },
  { key: "RIGHT_HIGH", label: "R-High" },
  { key: "BOWL", label: "Bowl" },
  { key: "CROWN", label: "Crown" },
  { key: "FLAT", label: "Flat" },
];

const TEMPLATE_SHORT: Record<DiagramTemplate, string> = {
  LANDSLIDE_THROUGH_ROAD: "through road",
  LANDSLIDE_ABOVE_ROAD: "above road",
  LANDSLIDE_BELOW_ROAD_SLIPOUT: "slipout",
};

const TERRAIN_SHORT: Record<TerrainSideShape, string> = {
  LEFT_HIGH: "left-high",
  RIGHT_HIGH: "right-high",
  BOWL: "bowl",
  CROWN: "crown",
  FLAT: "flat",
};

export function MeasurementDiagramRenderer({ formValues, roadInventorySnapshot, elevationProfile }: Props) {
  const [template, setTemplate] = useState<DiagramTemplate | "AUTO">("AUTO");
  const [view, setView] = useState<StationingView>("UPSTATION");
  const [failureSide, setFailureSide] = useState<FailureSide>("LT");
  const [terrainShape, setTerrainShape] = useState<TerrainSideShape | "AUTO">("AUTO");
  const [containerWidth, setContainerWidth] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [fsWidth, setFsWidth] = useState(0);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    setContainerWidth(e.nativeEvent.layout.width);
  }, []);

  const onFsLayout = useCallback((e: LayoutChangeEvent) => {
    setFsWidth(e.nativeEvent.layout.width);
  }, []);

  const openFullscreen = useCallback(async () => {
    setFullscreen(true);
    await unlockOrientationIfAvailable();
  }, []);

  const closeFullscreen = useCallback(async () => {
    await lockPortraitIfAvailable();
    setFullscreen(false);
  }, []);

  // Safety: re-lock if component unmounts while fullscreen is open
  useEffect(() => {
    return () => {
      if (fullscreen) {
        lockPortraitIfAvailable().catch(() => {});
      }
    };
  }, [fullscreen]);

  const data =
    containerWidth > 0
      ? buildMeasurementDiagramData(
          formValues,
          roadInventorySnapshot,
          template,
          view,
          failureSide,
          terrainShape,
          elevationProfile,
        )
      : null;

  const fsData =
    fsWidth > 0
      ? buildMeasurementDiagramData(
          formValues,
          roadInventorySnapshot,
          template,
          view,
          failureSide,
          terrainShape,
          elevationProfile,
        )
      : null;

  const source = data?.crossSection.source ?? "DEFAULT";
  const sourceLabel =
    source === "ROAD_INVENTORY" ? "Road inventory" :
    source === "FORM_FIELDS" ? "Form fields" :
    "Default";
  const sourceBadgeColor =
    source === "ROAD_INVENTORY" ? "#065f46" :
    source === "FORM_FIELDS" ? "#78350f" :
    "#1e3a5f";

  // Template note
  const templateNoteLabel =
    template === "AUTO"
      ? "auto · pending GEO"
      : TEMPLATE_SHORT[template as DiagramTemplate] ?? template;

  // Terrain note
  let terrainNoteLabel: string;
  if (terrainShape !== "AUTO") {
    terrainNoteLabel = `manual · ${TERRAIN_SHORT[terrainShape as TerrainSideShape] ?? terrainShape}`;
  } else if (!elevationProfile) {
    terrainNoteLabel = "auto · no elevation profile";
  } else if (elevationProfile.classification === "UNKNOWN" || !elevationProfile.classification) {
    terrainNoteLabel = "auto · elevation unknown";
  } else {
    terrainNoteLabel = `auto · USGS (${elevationProfile.classification})`;
  }

  // Elevation source note
  let elevNoteLabel: string;
  if (!elevationProfile) {
    elevNoteLabel = "not fetched";
  } else if (elevationProfile.error) {
    elevNoteLabel = `error · ${elevationProfile.source ?? "USGS"}`;
  } else {
    elevNoteLabel = elevationProfile.source ?? "USGS";
  }

  const compactNote = `Road: ${sourceLabel}  ·  Terrain: ${terrainNoteLabel}  ·  Elev: ${elevNoteLabel}`;
  const fullNote = `Road: ${sourceLabel}  ·  Template: ${templateNoteLabel}  ·  Terrain: ${terrainNoteLabel}  ·  Elevation: ${elevNoteLabel}`;

  // Failure side selector is only meaningful for ABOVE and BELOW templates
  const resolvedTemplate: DiagramTemplate =
    template === "AUTO" ? "LANDSLIDE_THROUGH_ROAD" : template;
  const showFailureSide = resolvedTemplate !== "LANDSLIDE_THROUGH_ROAD";

  const controls = (
    <>
      {/* Template selector */}
      <View style={styles.segRow}>
        {TEMPLATES.map((t) => (
          <TouchableOpacity
            key={t.key}
            style={[styles.seg, template === t.key && styles.segActive]}
            onPress={() => setTemplate(t.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: template === t.key }}
          >
            <Text style={[styles.segText, template === t.key && styles.segTextActive]}>
              {t.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {showFailureSide && (
        <View style={styles.controlRow}>
          <Text style={styles.controlLabel}>Failure side:</Text>
          {FAILURE_SIDES.map((fs) => (
            <TouchableOpacity
              key={fs.key}
              style={[styles.controlBtn, failureSide === fs.key && styles.controlBtnActive]}
              onPress={() => setFailureSide(fs.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: failureSide === fs.key }}
            >
              <Text style={[styles.controlBtnText, failureSide === fs.key && styles.controlBtnTextActive]}>
                {fs.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <View style={styles.controlRow}>
        <Text style={styles.controlLabel}>Terrain:</Text>
        {TERRAIN_SHAPES.map((ts) => (
          <TouchableOpacity
            key={ts.key}
            style={[styles.controlBtn, terrainShape === ts.key && styles.terrainBtnActive]}
            onPress={() => setTerrainShape(ts.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: terrainShape === ts.key }}
          >
            <Text style={[styles.controlBtnText, terrainShape === ts.key && styles.controlBtnTextActive]}>
              {ts.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </>
  );

  return (
    <View style={styles.wrapper}>
      {controls}

      {/* Stationing view + source badge + fullscreen button */}
      <View style={styles.viewRow}>
        <Text style={styles.viewLabel}>View:</Text>
        <TouchableOpacity
          style={[styles.viewBtn, view === "UPSTATION" && styles.viewBtnActive]}
          onPress={() => setView("UPSTATION")}
        >
          <Text style={[styles.viewBtnText, view === "UPSTATION" && styles.viewBtnTextActive]}>
            UPSTATION
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.viewBtn, view === "DOWNSTATION" && styles.viewBtnActive]}
          onPress={() => setView("DOWNSTATION")}
        >
          <Text style={[styles.viewBtnText, view === "DOWNSTATION" && styles.viewBtnTextActive]}>
            DOWNSTATION
          </Text>
        </TouchableOpacity>

        <View style={[styles.badge, { backgroundColor: sourceBadgeColor }]}>
          <Text style={styles.badgeText}>{sourceLabel}</Text>
        </View>

        <TouchableOpacity
          style={styles.fsBtn}
          onPress={openFullscreen}
          accessibilityLabel="Open fullscreen diagram"
          accessibilityRole="button"
        >
          <Text style={styles.fsBtnText}>⤢</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.noteRow}>
        <Text style={styles.noteText}>{fullNote}</Text>
      </View>

      <View style={styles.svgContainer} onLayout={onLayout}>
        {data && containerWidth > 0 ? (
          <RoadCrossSectionRenderer data={data} width={containerWidth} />
        ) : (
          <View style={styles.placeholder}>
            <Text style={styles.placeholderText}>Loading diagram…</Text>
          </View>
        )}
      </View>

      {/* Fullscreen modal */}
      <Modal
        visible={fullscreen}
        animationType="slide"
        statusBarTranslucent
        onRequestClose={closeFullscreen}
      >
        <StatusBar hidden />
        <SafeAreaView style={styles.fsModal}>
          {/* Fullscreen header */}
          <View style={styles.fsHeader}>
            <View style={styles.fsHeaderLeft}>
              {TEMPLATES.map((t) => (
                <TouchableOpacity
                  key={t.key}
                  style={[styles.fsSeg, template === t.key && styles.fsSegActive]}
                  onPress={() => setTemplate(t.key)}
                >
                  <Text style={[styles.segText, template === t.key && styles.segTextActive]}>{t.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity style={styles.fsCloseBtn} onPress={closeFullscreen} accessibilityLabel="Close fullscreen">
              <Text style={styles.fsCloseBtnText}>✕</Text>
            </TouchableOpacity>
          </View>

          {/* Fullscreen sub-controls */}
          <View style={styles.fsControls}>
            {showFailureSide && FAILURE_SIDES.map((fs) => (
              <TouchableOpacity
                key={fs.key}
                style={[styles.controlBtn, failureSide === fs.key && styles.controlBtnActive]}
                onPress={() => setFailureSide(fs.key)}
              >
                <Text style={[styles.controlBtnText, failureSide === fs.key && styles.controlBtnTextActive]}>
                  {fs.label}
                </Text>
              </TouchableOpacity>
            ))}
            {TERRAIN_SHAPES.map((ts) => (
              <TouchableOpacity
                key={ts.key}
                style={[styles.controlBtn, terrainShape === ts.key && styles.terrainBtnActive]}
                onPress={() => setTerrainShape(ts.key)}
              >
                <Text style={[styles.controlBtnText, terrainShape === ts.key && styles.controlBtnTextActive]}>
                  {ts.label}
                </Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={[styles.viewBtn, view === "UPSTATION" && styles.viewBtnActive]}
              onPress={() => setView(view === "UPSTATION" ? "DOWNSTATION" : "UPSTATION")}
            >
              <Text style={[styles.viewBtnText, view === "UPSTATION" && styles.viewBtnTextActive]}>
                {view === "UPSTATION" ? "↑ UP" : "↓ DOWN"}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Fullscreen diagram — fills remaining space */}
          <View style={styles.fsBody} onLayout={onFsLayout}>
            {fsData && fsWidth > 0 ? (
              <RoadCrossSectionRenderer data={fsData} width={fsWidth} />
            ) : (
              <View style={styles.placeholder}>
                <Text style={styles.placeholderText}>Loading…</Text>
              </View>
            )}
          </View>

          {/* Compact note */}
          <View style={styles.fsNoteRow}>
            <Text style={styles.noteText}>{compactNote}</Text>
          </View>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    backgroundColor: "#0f172a",
    borderRadius: 8,
    overflow: "hidden",
    marginVertical: 8,
  },
  segRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
  },
  seg: {
    flex: 1,
    paddingVertical: 7,
    alignItems: "center",
    backgroundColor: "#1e293b",
  },
  segActive: {
    backgroundColor: "#1d4ed8",
  },
  segText: {
    fontSize: 10,
    color: "#64748b",
    fontWeight: "600",
  },
  segTextActive: {
    color: "#ffffff",
  },
  controlRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 5,
    gap: 5,
    backgroundColor: "#0f1e30",
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
  },
  controlLabel: {
    fontSize: 10,
    color: "#64748b",
    marginRight: 2,
  },
  controlBtn: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "#334155",
    backgroundColor: "#1e293b",
  },
  controlBtnActive: {
    backgroundColor: "#b45309",
    borderColor: "#b45309",
  },
  terrainBtnActive: {
    backgroundColor: "#0f5132",
    borderColor: "#0f5132",
  },
  controlBtnText: {
    fontSize: 9,
    color: "#94a3b8",
    fontWeight: "600",
  },
  controlBtnTextActive: {
    color: "#ffffff",
  },
  viewRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 5,
    gap: 6,
    backgroundColor: "#111827",
  },
  viewLabel: {
    fontSize: 10,
    color: "#64748b",
    marginRight: 2,
  },
  viewBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "#334155",
    backgroundColor: "#1e293b",
  },
  viewBtnActive: {
    backgroundColor: "#3b82f6",
    borderColor: "#3b82f6",
  },
  viewBtnText: {
    fontSize: 9,
    color: "#94a3b8",
    fontWeight: "600",
  },
  viewBtnTextActive: {
    color: "#ffffff",
  },
  badge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeText: {
    fontSize: 8,
    color: "#d1fae5",
    fontWeight: "700",
  },
  fsBtn: {
    marginLeft: "auto",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "#475569",
    backgroundColor: "#1e293b",
  },
  fsBtnText: {
    fontSize: 13,
    color: "#94a3b8",
  },
  noteRow: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: "#0a1628",
    borderTopWidth: 1,
    borderTopColor: "#1e293b",
  },
  noteText: {
    fontSize: 8,
    color: "#475569",
    fontStyle: "italic",
  },
  svgContainer: {
    width: "100%",
  },
  placeholder: {
    height: 270,
    alignItems: "center",
    justifyContent: "center",
  },
  placeholderText: {
    color: "#475569",
    fontSize: 12,
  },
  // Fullscreen modal styles
  fsModal: {
    flex: 1,
    backgroundColor: "#060d1a",
  },
  fsHeader: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#0f172a",
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 4,
  },
  fsHeaderLeft: {
    flex: 1,
    flexDirection: "row",
    gap: 4,
  },
  fsSeg: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 4,
    backgroundColor: "#1e293b",
  },
  fsSegActive: {
    backgroundColor: "#1d4ed8",
  },
  fsControls: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: 8,
    paddingVertical: 5,
    gap: 5,
    backgroundColor: "#0f1e30",
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
  },
  fsCloseBtn: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 4,
    backgroundColor: "#334155",
  },
  fsCloseBtnText: {
    fontSize: 14,
    color: "#f1f5f9",
    fontWeight: "700",
  },
  fsBody: {
    flex: 1,
    justifyContent: "center",
  },
  fsNoteRow: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: "#0a1628",
    borderTopWidth: 1,
    borderTopColor: "#1e293b",
  },
});

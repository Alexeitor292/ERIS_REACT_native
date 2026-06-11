import React, { useState, useCallback } from "react";
import { View, Text, TouchableOpacity, StyleSheet, LayoutChangeEvent } from "react-native";
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

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    setContainerWidth(e.nativeEvent.layout.width);
  }, []);

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

  // Terrain note — reflects what AUTO actually resolved to
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

  // Failure side selector is only meaningful for ABOVE and BELOW templates
  const resolvedTemplate: DiagramTemplate =
    template === "AUTO" ? "LANDSLIDE_THROUGH_ROAD" : template;
  const showFailureSide = resolvedTemplate !== "LANDSLIDE_THROUGH_ROAD";

  return (
    <View style={styles.wrapper}>
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

      {/* Failure side selector — LT/RT are Caltrans stationing sides, not compass directions */}
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

      {/* Terrain shape selector */}
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

      {/* Stationing view toggle and data source badge */}
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
      </View>

      {/* Source / assumption notes */}
      <View style={styles.noteRow}>
        <Text style={styles.noteText}>
          {`Road: ${sourceLabel}  ·  Template: ${templateNoteLabel}  ·  Terrain: ${terrainNoteLabel}  ·  Elevation: ${elevNoteLabel}`}
        </Text>
      </View>

      {/* SVG diagram */}
      <View style={styles.svgContainer} onLayout={onLayout}>
        {data && containerWidth > 0 ? (
          <RoadCrossSectionRenderer data={data} width={containerWidth} />
        ) : (
          <View style={styles.placeholder}>
            <Text style={styles.placeholderText}>Loading diagram…</Text>
          </View>
        )}
      </View>
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
    marginLeft: "auto",
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeText: {
    fontSize: 8,
    color: "#d1fae5",
    fontWeight: "700",
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
});

import React, { useState, useCallback } from "react";
import { View, Text, TouchableOpacity, StyleSheet, LayoutChangeEvent } from "react-native";
import { RoadCrossSectionRenderer } from "./RoadCrossSectionRenderer";
import { buildMeasurementDiagramData } from "../measurements/buildMeasurementDiagramData";
import type { DiagramTemplate, FailureSide, StationingView } from "../measurements/measurementDiagramModel";

interface Props {
  formValues: Record<string, string | undefined | null>;
  roadInventorySnapshot?: Record<string, unknown> | null;
}

const TEMPLATES: { key: DiagramTemplate; label: string }[] = [
  { key: "LANDSLIDE_THROUGH_ROAD", label: "THROUGH ROAD" },
  { key: "LANDSLIDE_ABOVE_ROAD", label: "ABOVE ROAD" },
  { key: "LANDSLIDE_BELOW_ROAD_SLIPOUT", label: "BELOW / SLIPOUT" },
];

const FAILURE_SIDES: { key: FailureSide; label: string }[] = [
  { key: "LT", label: "LT SIDE" },
  { key: "RT", label: "RT SIDE" },
  { key: "BOTH", label: "BOTH SIDES" },
];

export function MeasurementDiagramRenderer({ formValues, roadInventorySnapshot }: Props) {
  const [template, setTemplate] = useState<DiagramTemplate>("LANDSLIDE_THROUGH_ROAD");
  const [view, setView] = useState<StationingView>("UPSTATION");
  const [failureSide, setFailureSide] = useState<FailureSide>("LT");
  const [containerWidth, setContainerWidth] = useState(0);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    setContainerWidth(e.nativeEvent.layout.width);
  }, []);

  const data =
    containerWidth > 0
      ? buildMeasurementDiagramData(formValues, roadInventorySnapshot, template, view, failureSide)
      : null;

  const source = data?.crossSection.source ?? "DEFAULT";
  const sourceLabel =
    source === "ROAD_INVENTORY" ? "Road Inventory" :
    source === "FORM_FIELDS" ? "From Form Fields" :
    "Default (no data)";
  const sourceBadgeColor =
    source === "ROAD_INVENTORY" ? "#065f46" :
    source === "FORM_FIELDS" ? "#78350f" :
    "#1e3a5f";

  // Failure side selector is only meaningful for ABOVE and BELOW templates.
  // For THROUGH_ROAD the overlay always spans the full road regardless.
  const showFailureSide = template !== "LANDSLIDE_THROUGH_ROAD";

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
    gap: 6,
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
    paddingHorizontal: 8,
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

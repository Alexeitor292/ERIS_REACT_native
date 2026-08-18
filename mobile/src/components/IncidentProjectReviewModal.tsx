import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { getToken } from "../auth/tokenStore";
import {
  associateIncidentWithProject,
  getIncidentProjectContext,
  getNearbyProjects,
  type IncidentProjectContext,
  type NearbyProject,
} from "../api/projects";
import { useUiSettings } from "../ui/UiSettingsContext";

type Props = {
  incidentId: number | null;
  visible: boolean;
  onClose: () => void;
  onAssociated: () => void | Promise<void>;
};

type MapBounds = {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
};

function locationLabel(value: {
  district?: string | null;
  county?: string | null;
  route?: string | null;
  post_mile?: string | null;
}) {
  return [
    value.district ? `D${value.district}` : null,
    value.county || null,
    value.route ? `R${value.route}` : null,
    value.post_mile ? `PM ${value.post_mile}` : null,
  ].filter(Boolean).join(" · ") || "Location not recorded";
}

function milesFromMeters(meters: number) {
  const miles = meters / 1609.344;
  return miles < 0.1 ? `${Math.round(meters * 3.28084)} ft` : `${miles.toFixed(miles < 10 ? 1 : 0)} mi`;
}

function generatedTitle(context: IncidentProjectContext | null) {
  const incident = context?.incident;
  if (!incident) return "";
  const parts = [
    incident.route ? `Route ${incident.route}` : null,
    incident.post_mile ? `PM ${incident.post_mile}` : null,
    incident.county || null,
  ].filter(Boolean);
  return parts.length ? `${parts.join(" · ")} Project` : `Incident #${incident.id} Project`;
}

function computeBounds(context: IncidentProjectContext | null, projects: NearbyProject[]): MapBounds | null {
  if (!context) return null;
  const points: Array<{ lat: number; lon: number }> = [
    { lat: context.incident.latitude, lon: context.incident.longitude },
  ];
  for (const project of projects) {
    points.push({ lat: project.centroid_latitude, lon: project.centroid_longitude });
    for (const incident of project.incidents) {
      points.push({ lat: incident.latitude, lon: incident.longitude });
    }
  }
  const finite = points.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon));
  if (!finite.length) return null;
  const minLatRaw = Math.min(...finite.map((point) => point.lat));
  const maxLatRaw = Math.max(...finite.map((point) => point.lat));
  const minLonRaw = Math.min(...finite.map((point) => point.lon));
  const maxLonRaw = Math.max(...finite.map((point) => point.lon));
  const latPad = Math.max((maxLatRaw - minLatRaw) * 0.18, 0.01);
  const lonPad = Math.max((maxLonRaw - minLonRaw) * 0.18, 0.01);
  return {
    minLat: minLatRaw - latPad,
    maxLat: maxLatRaw + latPad,
    minLon: minLonRaw - lonPad,
    maxLon: maxLonRaw + lonPad,
  };
}

function mapPreviewUrl(bounds: MapBounds | null) {
  if (!bounds) return null;
  const bbox = [bounds.minLon, bounds.minLat, bounds.maxLon, bounds.maxLat].join(",");
  return `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${encodeURIComponent(bbox)}&bboxSR=4326&imageSR=4326&size=1200,700&format=jpg&f=image`;
}

function markerPosition(lat: number, lon: number, bounds: MapBounds | null) {
  if (!bounds || bounds.maxLat <= bounds.minLat || bounds.maxLon <= bounds.minLon) return null;
  const x = ((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * 100;
  const y = ((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * 100;
  return {
    left: `${Math.max(3, Math.min(97, x))}%` as `${number}%`,
    top: `${Math.max(4, Math.min(96, y))}%` as `${number}%`,
  };
}

export default function IncidentProjectReviewModal({
  incidentId,
  visible,
  onClose,
  onAssociated,
}: Props) {
  const { palette } = useUiSettings();
  const [context, setContext] = useState<IncidentProjectContext | null>(null);
  const [projects, setProjects] = useState<NearbyProject[]>([]);
  const [radiusMiles, setRadiusMiles] = useState(5);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [mode, setMode] = useState<"EXISTING" | "CREATE_NEW">("EXISTING");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load(nextRadius = radiusMiles) {
    if (!incidentId) return;
    const token = await getToken();
    if (!token) {
      setError("Your session is no longer available. Sign in again.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const [nextContext, nearby] = await Promise.all([
        getIncidentProjectContext(token, incidentId),
        getNearbyProjects(token, incidentId, nextRadius),
      ]);
      setContext(nextContext);
      setProjects(nearby.items ?? []);
      if (nextContext.project) {
        setMode("EXISTING");
        setSelectedProjectId(nextContext.project.id);
      } else if (nearby.items?.length) {
        setMode("EXISTING");
        setSelectedProjectId((current) => current ?? nearby.items[0].id);
      } else {
        setMode("CREATE_NEW");
        setSelectedProjectId(null);
      }
      setTitle((current) => current || generatedTitle(nextContext));
    } catch (e: any) {
      setError(String(e?.message ?? "Failed to load Project context."));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!visible || !incidentId) return;
    setContext(null);
    setProjects([]);
    setRadiusMiles(5);
    setSelectedProjectId(null);
    setMode("EXISTING");
    setTitle("");
    setDescription("");
    setNotes("");
    setError(null);
    setNotice(null);
    load(5).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, incidentId]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId)
      ?? (context?.project?.id === selectedProjectId ? context.project : null),
    [context?.project, projects, selectedProjectId],
  );
  const bounds = useMemo(() => computeBounds(context, projects), [context, projects]);
  const previewUrl = useMemo(() => mapPreviewUrl(bounds), [bounds]);
  const currentProjectId = context?.project?.id ?? null;
  const associationChanged = mode === "CREATE_NEW"
    || (mode === "EXISTING" && selectedProjectId != null && selectedProjectId !== currentProjectId);

  async function associate() {
    if (!incidentId || !context?.can_change_association) return;
    if (mode === "EXISTING" && !selectedProjectId) {
      setError("Select an existing Project first.");
      return;
    }
    if (mode === "CREATE_NEW" && !title.trim()) {
      setError("Project title is required.");
      return;
    }
    const token = await getToken();
    if (!token) {
      setError("Your session is no longer available. Sign in again.");
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await associateIncidentWithProject(
        token,
        incidentId,
        mode === "EXISTING"
          ? { mode, project_id: selectedProjectId!, notes: notes.trim() || null }
          : {
              mode,
              title: title.trim(),
              description: description.trim() || null,
              notes: notes.trim() || null,
            },
      );
      setNotice(result.created
        ? "Project created and Incident associated."
        : "Incident associated with the selected Project.");
      await load(radiusMiles);
      await onAssociated();
    } catch (e: any) {
      setError(String(e?.message ?? "Failed to associate Project."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { backgroundColor: palette.panel, borderColor: palette.border }]}>
          <View style={[styles.header, { borderColor: palette.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.eyebrow, { color: palette.muted }]}>Coordinator review</Text>
              <Text style={[styles.title, { color: palette.text }]}>Choose Project for Incident #{incidentId ?? ""}</Text>
              <Text style={[styles.subtitle, { color: palette.muted }]}>Compare the reported location with nearby Projects before triage or engineering assignment.</Text>
            </View>
            <Pressable onPress={onClose} style={[styles.smallButton, { borderColor: palette.border }]}>
              <Text style={{ color: palette.text, fontWeight: "700" }}>Close</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.content}>
            {error ? <View style={[styles.message, { borderColor: palette.danger }]}><Text style={{ color: palette.danger }}>{error}</Text></View> : null}
            {notice ? <View style={[styles.message, { borderColor: palette.primary }]}><Text style={{ color: palette.text }}>{notice}</Text></View> : null}

            {!context ? (
              <View style={styles.loading}><ActivityIndicator color={palette.primary} /><Text style={{ color: palette.muted }}>Loading Project context…</Text></View>
            ) : (
              <>
                <View style={[styles.summaryCard, { backgroundColor: palette.panelSoft, borderColor: palette.border }]}>
                  <Text style={[styles.summaryTitle, { color: palette.text }]}>Incident #{context.incident.id}</Text>
                  <Text style={{ color: palette.muted }}>{locationLabel(context.incident)}</Text>
                  <Text style={{ color: palette.muted, marginTop: 4 }}>{context.incident.latitude.toFixed(6)}, {context.incident.longitude.toFixed(6)}</Text>
                  <Text style={{ color: palette.text, marginTop: 8, fontWeight: "700" }}>Current Project: {context.project?.title ?? "Not assigned"}</Text>
                  <Text style={{ color: palette.muted, marginTop: 2 }}>Classification remains unassigned until the on-site assessment.</Text>
                </View>

                {previewUrl ? (
                  <View style={[styles.map, { borderColor: palette.border }]}>
                    <Image source={{ uri: previewUrl }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
                    {(() => {
                      const position = markerPosition(context.incident.latitude, context.incident.longitude, bounds);
                      return position ? <View pointerEvents="none" style={[styles.incidentMarker, position]}><Text style={styles.markerText}>I</Text></View> : null;
                    })()}
                    {projects.map((project) => {
                      const position = markerPosition(project.centroid_latitude, project.centroid_longitude, bounds);
                      if (!position) return null;
                      const selected = mode === "EXISTING" && selectedProjectId === project.id;
                      return (
                        <Pressable
                          key={`project-marker-${project.id}`}
                          onPress={() => { setMode("EXISTING"); setSelectedProjectId(project.id); }}
                          style={[styles.projectMarker, position, { backgroundColor: selected ? palette.primary : "#ffffff", borderColor: selected ? "#ffffff" : palette.primary }]}
                        >
                          <Text style={[styles.markerText, { color: selected ? "#ffffff" : palette.primary }]}>P</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}

                <View style={styles.radiusRow}>
                  {[5, 10, 25, 50].map((radius) => (
                    <Pressable
                      key={radius}
                      disabled={busy}
                      onPress={() => { setRadiusMiles(radius); load(radius).catch(() => {}); }}
                      style={[styles.radiusButton, { borderColor: radiusMiles === radius ? palette.primary : palette.border, backgroundColor: radiusMiles === radius ? palette.panelSoft : palette.panel }]}
                    >
                      <Text style={{ color: radiusMiles === radius ? palette.primary : palette.text, fontWeight: "700" }}>{radius} mi</Text>
                    </Pressable>
                  ))}
                </View>

                <Text style={[styles.sectionTitle, { color: palette.text }]}>Nearby open Projects</Text>
                {projects.length === 0 ? (
                  <View style={[styles.emptyCard, { borderColor: palette.border }]}><Text style={{ color: palette.muted }}>No open Projects were found in this radius.</Text></View>
                ) : projects.map((project) => {
                  const selected = mode === "EXISTING" && selectedProjectId === project.id;
                  return (
                    <Pressable
                      key={project.id}
                      onPress={() => { setMode("EXISTING"); setSelectedProjectId(project.id); }}
                      style={[styles.projectCard, { borderColor: selected ? palette.primary : palette.border, backgroundColor: palette.panelSoft }]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: palette.text, fontWeight: "800" }}>{project.title}</Text>
                        <Text style={{ color: palette.muted, marginTop: 3 }}>{locationLabel(project)}</Text>
                        <Text style={{ color: palette.muted, marginTop: 3 }}>{project.incident_count} incidents · {project.open_incident_count} active</Text>
                      </View>
                      <Text style={{ color: palette.primary, fontWeight: "800" }}>{milesFromMeters(project.nearest_distance_m)}</Text>
                    </Pressable>
                  );
                })}

                <View style={styles.modeRow}>
                  <Pressable onPress={() => setMode("EXISTING")} style={[styles.modeButton, { borderColor: mode === "EXISTING" ? palette.primary : palette.border }]}>
                    <Text style={{ color: mode === "EXISTING" ? palette.primary : palette.text, fontWeight: "800" }}>Existing Project</Text>
                  </Pressable>
                  <Pressable onPress={() => setMode("CREATE_NEW")} style={[styles.modeButton, { borderColor: mode === "CREATE_NEW" ? palette.primary : palette.border }]}>
                    <Text style={{ color: mode === "CREATE_NEW" ? palette.primary : palette.text, fontWeight: "800" }}>Create new</Text>
                  </Pressable>
                </View>

                {mode === "EXISTING" ? (
                  <View style={[styles.summaryCard, { backgroundColor: palette.panelSoft, borderColor: palette.border }]}>
                    <Text style={{ color: palette.muted, fontWeight: "700" }}>Selected Project</Text>
                    <Text style={{ color: palette.text, fontWeight: "800", marginTop: 4 }}>{selectedProject?.title ?? "Select a Project above"}</Text>
                    {selectedProject ? <Text style={{ color: palette.muted, marginTop: 3 }}>{locationLabel(selectedProject)}</Text> : null}
                  </View>
                ) : (
                  <View style={{ gap: 8 }}>
                    <Text style={[styles.fieldLabel, { color: palette.muted }]}>Project title</Text>
                    <TextInput value={title} onChangeText={setTitle} style={[styles.input, { color: palette.text, borderColor: palette.border, backgroundColor: palette.panelSoft }]} />
                    <Text style={[styles.fieldLabel, { color: palette.muted }]}>Description</Text>
                    <TextInput value={description} onChangeText={setDescription} multiline style={[styles.input, styles.multiline, { color: palette.text, borderColor: palette.border, backgroundColor: palette.panelSoft }]} />
                  </View>
                )}

                <Text style={[styles.fieldLabel, { color: palette.muted }]}>Coordinator note</Text>
                <TextInput
                  value={notes}
                  onChangeText={setNotes}
                  multiline
                  placeholder="Why this Project matches the Incident (optional)"
                  placeholderTextColor={palette.muted}
                  style={[styles.input, styles.multiline, { color: palette.text, borderColor: palette.border, backgroundColor: palette.panelSoft }]}
                />

                {context.can_change_association ? (
                  <Pressable
                    disabled={busy || !associationChanged || (mode === "EXISTING" && !selectedProjectId) || (mode === "CREATE_NEW" && !title.trim())}
                    onPress={associate}
                    style={[styles.primaryButton, { backgroundColor: palette.primary }, (busy || !associationChanged) && { opacity: 0.5 }]}
                  >
                    {busy ? <ActivityIndicator color="#ffffff" /> : <Text style={{ color: "#ffffff", fontWeight: "800" }}>{mode === "CREATE_NEW" ? "Create Project and associate" : currentProjectId === selectedProjectId ? "Project already assigned" : "Associate with selected Project"}</Text>}
                  </Pressable>
                ) : null}

                {context.project ? (
                  <View style={[styles.message, { borderColor: palette.primary }]}>
                    <Text style={{ color: palette.text, fontWeight: "700" }}>Project requirement satisfied.</Text>
                    <Text style={{ color: palette.muted, marginTop: 3 }}>You can close this panel and continue coordinator triage.</Text>
                  </View>
                ) : (
                  <View style={[styles.message, { borderColor: palette.danger }]}>
                    <Text style={{ color: palette.text, fontWeight: "700" }}>Project association required.</Text>
                    <Text style={{ color: palette.muted, marginTop: 3 }}>ERIS will not allow triage or engineering assignment to advance until this Incident belongs to a Project.</Text>
                  </View>
                )}
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  sheet: { maxHeight: "94%", borderTopWidth: 1, borderLeftWidth: 1, borderRightWidth: 1, borderTopLeftRadius: 22, borderTopRightRadius: 22, overflow: "hidden" },
  header: { flexDirection: "row", gap: 12, padding: 16, borderBottomWidth: 1 },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  eyebrow: { fontSize: 11, fontWeight: "800", textTransform: "uppercase", letterSpacing: 1 },
  title: { fontSize: 20, fontWeight: "900", marginTop: 3 },
  subtitle: { fontSize: 13, marginTop: 4, lineHeight: 18 },
  smallButton: { borderWidth: 1, borderRadius: 9, paddingHorizontal: 12, paddingVertical: 8, alignSelf: "flex-start" },
  loading: { minHeight: 160, alignItems: "center", justifyContent: "center", gap: 10 },
  message: { borderWidth: 1, borderRadius: 10, padding: 10 },
  summaryCard: { borderWidth: 1, borderRadius: 12, padding: 12 },
  summaryTitle: { fontSize: 15, fontWeight: "900" },
  map: { height: 260, borderWidth: 1, borderRadius: 14, overflow: "hidden", position: "relative" },
  incidentMarker: { position: "absolute", width: 30, height: 30, marginLeft: -15, marginTop: -15, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: "#dc2626", borderWidth: 3, borderColor: "#ffffff" },
  projectMarker: { position: "absolute", width: 30, height: 30, marginLeft: -15, marginTop: -15, borderRadius: 15, alignItems: "center", justifyContent: "center", borderWidth: 3 },
  markerText: { color: "#ffffff", fontWeight: "900", fontSize: 12 },
  radiusRow: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  radiusButton: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  sectionTitle: { fontSize: 15, fontWeight: "900", marginTop: 2 },
  emptyCard: { borderWidth: 1, borderStyle: "dashed", borderRadius: 10, padding: 14 },
  projectCard: { flexDirection: "row", gap: 10, borderWidth: 1, borderRadius: 11, padding: 11 },
  modeRow: { flexDirection: "row", gap: 8, marginTop: 4 },
  modeButton: { flex: 1, borderWidth: 1, borderRadius: 9, alignItems: "center", paddingVertical: 10 },
  fieldLabel: { fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5 },
  input: { borderWidth: 1, borderRadius: 9, paddingHorizontal: 11, paddingVertical: 10, fontSize: 14 },
  multiline: { minHeight: 76, textAlignVertical: "top" },
  primaryButton: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 13, alignItems: "center", justifyContent: "center", minHeight: 48 },
});

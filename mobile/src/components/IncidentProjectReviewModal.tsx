import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
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

function locationLabel(value: { district?: string | null; county?: string | null; route?: string | null; post_mile?: string | null }) {
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
  const parts = [incident.route ? `Route ${incident.route}` : null, incident.post_mile ? `PM ${incident.post_mile}` : null, incident.county || null].filter(Boolean);
  return parts.length ? `${parts.join(" · ")} Event Group` : `Incident #${incident.id} Event Group`;
}

export default function IncidentProjectReviewModal({ incidentId, visible, onClose, onAssociated }: Props) {
  const { palette } = useUiSettings();
  const [context, setContext] = useState<IncidentProjectContext | null>(null);
  const [groups, setGroups] = useState<NearbyProject[]>([]);
  const [radiusMiles, setRadiusMiles] = useState(5);
  const [selectedId, setSelectedId] = useState<number | null>(null);
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
      setGroups(nearby.items ?? []);
      if (nextContext.project) {
        setMode("EXISTING");
        setSelectedId(nextContext.project.id);
      } else if (nearby.items?.length) {
        setMode("EXISTING");
        setSelectedId((current) => current ?? nearby.items[0].id);
      } else {
        setMode("CREATE_NEW");
        setSelectedId(null);
      }
      setTitle((current) => current || generatedTitle(nextContext));
    } catch (e: any) {
      setError(String(e?.message ?? "Failed to load Event Group context."));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!visible || !incidentId) return;
    setContext(null);
    setGroups([]);
    setRadiusMiles(5);
    setSelectedId(null);
    setMode("EXISTING");
    setTitle("");
    setDescription("");
    setNotes("");
    setError(null);
    setNotice(null);
    load(5).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, incidentId]);

  const selected = useMemo(
    () => groups.find((group) => group.id === selectedId) ?? (context?.project?.id === selectedId ? context.project : null),
    [context?.project, groups, selectedId],
  );

  async function associate() {
    if (!incidentId || !context?.can_change_association) return;
    if (mode === "EXISTING" && !selectedId) {
      setError("Select an existing Event Group first.");
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
          ? { mode, project_id: selectedId!, notes: notes.trim() || null }
          : { mode, title: title.trim(), description: description.trim() || null, notes: notes.trim() || null },
      );
      setNotice(result.created ? "Event Group created and Incident associated." : "Incident associated with the selected Event Group.");
      await load(radiusMiles);
      await onAssociated();
    } catch (e: any) {
      setError(String(e?.message ?? "Failed to associate Event Group."));
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
              <Text style={[styles.title, { color: palette.text }]}>Event Group for Incident #{incidentId ?? ""}</Text>
              <Text style={[styles.subtitle, { color: palette.muted }]}>Event Groups provide shared context. The Incident remains its own historical record and receives its permanent key only when coordinator approval advances it.</Text>
            </View>
            <Pressable onPress={onClose} style={[styles.smallButton, { borderColor: palette.border }]}><Text style={{ color: palette.text, fontWeight: "700" }}>Close</Text></Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.content}>
            {error ? <View style={[styles.message, { borderColor: palette.danger }]}><Text style={{ color: palette.danger }}>{error}</Text></View> : null}
            {notice ? <View style={[styles.message, { borderColor: palette.primary }]}><Text style={{ color: palette.text }}>{notice}</Text></View> : null}

            {!context ? <View style={styles.loading}><ActivityIndicator color={palette.primary} /><Text style={{ color: palette.muted }}>Loading Event Group context…</Text></View> : (
              <>
                <View style={[styles.card, { backgroundColor: palette.panelSoft, borderColor: palette.border }]}>
                  <Text style={{ color: palette.text, fontWeight: "800" }}>Incident #{context.incident.id}</Text>
                  <Text style={{ color: palette.muted, marginTop: 4 }}>{locationLabel(context.incident)}</Text>
                  <Text style={{ color: palette.text, marginTop: 8, fontWeight: "700" }}>Current Event Group: {context.project?.title ?? "Not assigned"}</Text>
                </View>

                <View style={styles.radiusRow}>
                  {[5, 10, 25, 50].map((radius) => <Pressable key={radius} disabled={busy} onPress={() => { setRadiusMiles(radius); load(radius).catch(() => {}); }} style={[styles.radiusButton, { borderColor: radiusMiles === radius ? palette.primary : palette.border }]}><Text style={{ color: radiusMiles === radius ? palette.primary : palette.text, fontWeight: "700" }}>{radius} mi</Text></Pressable>)}
                </View>

                <Text style={[styles.sectionTitle, { color: palette.text }]}>Nearby open Event Groups</Text>
                {groups.length === 0 ? <View style={[styles.card, { borderColor: palette.border }]}><Text style={{ color: palette.muted }}>No open Event Groups were found. Create a new one for this Incident.</Text></View> : groups.map((group) => {
                  const isSelected = mode === "EXISTING" && selectedId === group.id;
                  return <Pressable key={group.id} onPress={() => { setMode("EXISTING"); setSelectedId(group.id); }} style={[styles.card, { borderColor: isSelected ? palette.primary : palette.border, backgroundColor: palette.panelSoft }]}><View style={styles.row}><View style={{ flex: 1 }}><Text style={{ color: palette.text, fontWeight: "800" }}>{group.title}</Text><Text style={{ color: palette.muted, marginTop: 3 }}>{locationLabel(group)}</Text><Text style={{ color: palette.muted, marginTop: 3 }}>{group.incident_count} associated Incident{group.incident_count === 1 ? "" : "s"}</Text></View><Text style={{ color: palette.primary, fontWeight: "800" }}>{milesFromMeters(group.nearest_distance_m)}</Text></View></Pressable>;
                })}

                <View style={styles.modeRow}>
                  <Pressable onPress={() => setMode("EXISTING")} style={[styles.modeButton, { borderColor: mode === "EXISTING" ? palette.primary : palette.border }]}><Text style={{ color: mode === "EXISTING" ? palette.primary : palette.text, fontWeight: "800" }}>Existing group</Text></Pressable>
                  <Pressable onPress={() => setMode("CREATE_NEW")} style={[styles.modeButton, { borderColor: mode === "CREATE_NEW" ? palette.primary : palette.border }]}><Text style={{ color: mode === "CREATE_NEW" ? palette.primary : palette.text, fontWeight: "800" }}>New group</Text></Pressable>
                </View>

                {mode === "EXISTING" ? <View style={[styles.card, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}><Text style={{ color: palette.muted, fontWeight: "700" }}>Selected Event Group</Text><Text style={{ color: palette.text, fontWeight: "800", marginTop: 4 }}>{selected?.title ?? "Select a group above"}</Text></View> : <View style={{ gap: 8 }}><Text style={[styles.fieldLabel, { color: palette.muted }]}>EVENT GROUP TITLE</Text><TextInput value={title} onChangeText={setTitle} style={[styles.input, { borderColor: palette.border, color: palette.text, backgroundColor: palette.panelSoft }]} /><Text style={[styles.fieldLabel, { color: palette.muted }]}>DESCRIPTION</Text><TextInput value={description} onChangeText={setDescription} multiline style={[styles.input, styles.multiline, { borderColor: palette.border, color: palette.text, backgroundColor: palette.panelSoft }]} /></View>}

                <Text style={[styles.fieldLabel, { color: palette.muted }]}>COORDINATOR NOTE</Text>
                <TextInput value={notes} onChangeText={setNotes} multiline style={[styles.input, styles.multiline, { borderColor: palette.border, color: palette.text, backgroundColor: palette.panelSoft }]} />

                <Pressable disabled={busy || !context.can_change_association || (mode === "EXISTING" && !selectedId)} onPress={associate} style={[styles.primaryButton, { backgroundColor: palette.primary, opacity: busy ? 0.55 : 1 }]}><Text style={styles.primaryButtonText}>{busy ? "Saving…" : mode === "CREATE_NEW" ? "Create Event Group and associate" : "Use selected Event Group"}</Text></Pressable>
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
  sheet: { maxHeight: "94%", borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1 },
  header: { flexDirection: "row", gap: 12, padding: 16, borderBottomWidth: 1 },
  eyebrow: { fontSize: 11, fontWeight: "800", letterSpacing: 1.1, textTransform: "uppercase" },
  title: { marginTop: 3, fontSize: 20, fontWeight: "800" },
  subtitle: { marginTop: 4, fontSize: 13, lineHeight: 18 },
  smallButton: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, alignSelf: "flex-start" },
  content: { padding: 16, gap: 12, paddingBottom: 32 },
  loading: { paddingVertical: 40, alignItems: "center", gap: 10 },
  message: { borderWidth: 1, borderRadius: 8, padding: 10 },
  card: { borderWidth: 1, borderRadius: 10, padding: 12 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  radiusRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  radiusButton: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  sectionTitle: { marginTop: 4, fontSize: 14, fontWeight: "800" },
  modeRow: { flexDirection: "row", gap: 8 },
  modeButton: { flex: 1, borderWidth: 1, borderRadius: 8, padding: 10, alignItems: "center" },
  fieldLabel: { fontSize: 11, fontWeight: "800", letterSpacing: 0.7, marginTop: 2 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9, fontSize: 14 },
  multiline: { minHeight: 72, textAlignVertical: "top" },
  primaryButton: { borderRadius: 10, paddingVertical: 12, alignItems: "center", marginTop: 4 },
  primaryButtonText: { color: "#fff", fontSize: 14, fontWeight: "800" },
});

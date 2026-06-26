import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useFocusEffect } from "expo-router";

import { getToken } from "@/src/auth/tokenStore";
import { apiFetch, isSessionExpiredError } from "@/src/api/client";
import {
  assignAssessmentEngineer,
  delegateBranch,
  getAssessment,
  getAssessmentBranchOptions,
  listAssessments,
  reviewAssessment,
  submitAssessment,
  type Assessment,
  type AssessmentDetail,
  type AssessmentQueue,
  type RoutingUserOption,
} from "@/src/api/assessments";
import { useUiSettings } from "@/src/ui/UiSettingsContext";
import {
  assessmentStateLabel,
  canAssignEngineer,
  canDelegateBranch,
  isMaintenanceOnly,
} from "@/src/utils/roleModel";

type QueueKey = AssessmentQueue | "all";
const QUEUES: { key: QueueKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "office_chief", label: "Office" },
  { key: "branch_chief", label: "Branch" },
  { key: "engineer", label: "Engineering" },
  { key: "reviewer", label: "Reviews" },
];

export default function AssessmentsScreen() {
  const { palette } = useUiSettings();
  const [roles, setRoles] = useState<string[]>([]);
  const [queue, setQueue] = useState<QueueKey>("all");
  const [items, setItems] = useState<Assessment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<AssessmentDetail | null>(null);
  const [branchOpts, setBranchOpts] = useState<RoutingUserOption[]>([]);
  const [engineerId, setEngineerId] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) return;
      const me = await apiFetch<{ roles: string[] }>("/auth/me", { token });
      setRoles(me.roles ?? []);
      const res = await listAssessments(token, queue === "all" ? {} : { queue });
      setItems(res.items);
    } catch (e) {
      if (!isSessionExpiredError(e)) setError(e instanceof Error ? e.message : "Failed to load assessments");
    } finally {
      setLoading(false);
    }
  }, [queue]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const openDetail = async (id: number) => {
    setError(null);
    setNotes("");
    setEngineerId("");
    setBranchOpts([]);
    try {
      const token = await getToken();
      if (!token) return;
      const d = await getAssessment(token, id);
      setDetail(d);
      if (d.assessment.state === "PENDING_OFFICE_DELEGATION" && canDelegateBranch(roles)) {
        try {
          const opts = await getAssessmentBranchOptions(token, id);
          setBranchOpts(opts.items);
        } catch {
          setBranchOpts([]);
        }
      }
    } catch (e) {
      if (!isSessionExpiredError(e)) setError(e instanceof Error ? e.message : "Failed to load assessment");
    }
  };

  const runAction = async (fn: (token: string) => Promise<unknown>) => {
    setBusy(true);
    try {
      const token = await getToken();
      if (!token) return;
      await fn(token);
      const id = detail?.assessment.id;
      setDetail(null);
      await load();
      if (id) await openDetail(id);
    } catch (e) {
      if (!isSessionExpiredError(e)) Alert.alert("Action failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  };

  if (isMaintenanceOnly(roles) && roles.length > 0) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: palette.bg }]}>
        <View style={styles.center}>
          <Text style={{ color: palette.muted, textAlign: "center", padding: 24 }}>
            Assessments are available to operational roles. As a maintenance field worker, use Track Incidents to
            follow your own reports.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: palette.bg }]} edges={["top"]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: palette.text }]}>Assessments</Text>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabs} contentContainerStyle={{ gap: 8, paddingHorizontal: 12 }}>
        {QUEUES.map((q) => (
          <Pressable
            key={q.key}
            onPress={() => setQueue(q.key)}
            style={[
              styles.tab,
              {
                backgroundColor: queue === q.key ? palette.primary : palette.panelSoft,
                borderColor: palette.border,
              },
            ]}
          >
            <Text style={{ color: queue === q.key ? "#fff" : palette.text, fontWeight: "700", fontSize: 13 }}>{q.label}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {error ? <Text style={{ color: palette.danger, paddingHorizontal: 12 }}>{error}</Text> : null}

      <FlatList
        data={items}
        keyExtractor={(a) => String(a.id)}
        refreshing={loading}
        onRefresh={load}
        contentContainerStyle={{ padding: 12, gap: 8 }}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={palette.primary} style={{ marginTop: 24 }} />
          ) : (
            <Text style={{ color: palette.muted, textAlign: "center", marginTop: 24 }}>No assessments in this queue.</Text>
          )
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => openDetail(item.id)}
            style={[styles.card, { backgroundColor: palette.panel, borderColor: palette.border }]}
          >
            <View style={styles.rowBetween}>
              <Text style={{ color: palette.text, fontWeight: "800" }}>Assessment #{item.id}</Text>
              <StateBadge state={item.state} palette={palette} />
            </View>
            <Text style={{ color: palette.muted, fontSize: 12, marginTop: 4 }}>
              Incident #{item.incident_id} · Office {item.office_code ?? "—"} · District {item.district ?? "—"}
            </Text>
          </Pressable>
        )}
      />

      <Modal visible={!!detail} animationType="slide" transparent onRequestClose={() => setDetail(null)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalSheet, { backgroundColor: palette.bg }]}>
            {detail && (
              <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
                <View style={styles.rowBetween}>
                  <Text style={[styles.title, { color: palette.text }]}>Assessment #{detail.assessment.id}</Text>
                  <Pressable onPress={() => setDetail(null)}>
                    <Text style={{ color: palette.primary, fontWeight: "700" }}>Close</Text>
                  </Pressable>
                </View>
                <StateBadge state={detail.assessment.state} palette={palette} />
                <Text style={{ color: palette.muted }}>
                  Incident #{detail.assessment.incident_id} · Office {detail.assessment.office_code ?? "—"}
                </Text>
                {detail.assessment.submission_id != null && (
                  <Pressable onPress={() => router.push(`/(tabs)/submissions/${detail.assessment.submission_id}` as any)}>
                    <Text style={{ color: palette.primary, fontWeight: "700" }}>Open technical form #{detail.assessment.submission_id}</Text>
                  </Pressable>
                )}

                {/* Notes input shared by actions */}
                <TextInput
                  value={notes}
                  onChangeText={setNotes}
                  placeholder="Notes (optional)"
                  placeholderTextColor={palette.muted}
                  style={[styles.input, { color: palette.text, borderColor: palette.border, backgroundColor: palette.panel }]}
                  multiline
                />

                {/* Contextual actions */}
                {detail.assessment.state === "PENDING_OFFICE_DELEGATION" && canDelegateBranch(roles) && (
                  <View style={{ gap: 6 }}>
                    <Text style={{ color: palette.muted, fontSize: 12 }}>Delegate to branch chief:</Text>
                    {branchOpts.length === 0 ? (
                      <Text style={{ color: palette.muted }}>No branch chiefs configured for this office.</Text>
                    ) : (
                      branchOpts.map((o) => (
                        <Pressable
                          key={o.id}
                          disabled={busy}
                          onPress={() => runAction((t) => delegateBranch(t, detail.assessment.id, o.id, notes))}
                          style={[styles.actionBtn, { backgroundColor: palette.primary }]}
                        >
                          <Text style={styles.actionText}>{o.full_name} ({o.email})</Text>
                        </Pressable>
                      ))
                    )}
                  </View>
                )}

                {detail.assessment.state === "PENDING_ENGINEER_ASSIGNMENT" && canAssignEngineer(roles) && (
                  <View style={{ gap: 6 }}>
                    <TextInput
                      value={engineerId}
                      onChangeText={setEngineerId}
                      keyboardType="number-pad"
                      placeholder="Engineer user id"
                      placeholderTextColor={palette.muted}
                      style={[styles.input, { color: palette.text, borderColor: palette.border, backgroundColor: palette.panel }]}
                    />
                    <Pressable
                      disabled={busy || !engineerId}
                      onPress={() => runAction((t) => assignAssessmentEngineer(t, detail.assessment.id, Number(engineerId), notes))}
                      style={[styles.actionBtn, { backgroundColor: palette.primary, opacity: engineerId ? 1 : 0.5 }]}
                    >
                      <Text style={styles.actionText}>Assign engineer</Text>
                    </Pressable>
                  </View>
                )}

                {(detail.assessment.state === "DRAFT" || detail.assessment.state === "REVISION_REQUESTED") && (
                  <Pressable
                    disabled={busy}
                    onPress={() => runAction((t) => submitAssessment(t, detail.assessment.id, notes))}
                    style={[styles.actionBtn, { backgroundColor: palette.primary }]}
                  >
                    <Text style={styles.actionText}>Submit for review</Text>
                  </Pressable>
                )}

                {detail.assessment.state === "SUBMITTED" && (
                  <View style={{ gap: 6 }}>
                    <Pressable
                      disabled={busy}
                      onPress={() => runAction((t) => reviewAssessment(t, detail.assessment.id, "APPROVE", notes))}
                      style={[styles.actionBtn, { backgroundColor: "#16a34a" }]}
                    >
                      <Text style={styles.actionText}>Approve</Text>
                    </Pressable>
                    <Pressable
                      disabled={busy}
                      onPress={() => runAction((t) => reviewAssessment(t, detail.assessment.id, "REQUEST_REVISION", notes))}
                      style={[styles.actionBtn, { backgroundColor: "#d97706" }]}
                    >
                      <Text style={styles.actionText}>Request revision</Text>
                    </Pressable>
                    <Text style={{ color: palette.muted, fontSize: 11 }}>Assigned reviewers/approvers only (server enforced).</Text>
                  </View>
                )}

                {/* Timeline */}
                <Text style={{ color: palette.muted, fontWeight: "700", marginTop: 8 }}>Timeline</Text>
                {detail.events.map((ev) => (
                  <View key={ev.id} style={[styles.eventRow, { borderColor: palette.border, backgroundColor: palette.panel }]}>
                    <Text style={{ color: palette.text, fontWeight: "700", fontSize: 13 }}>
                      {ev.event_type}
                      {ev.disposition ? ` · ${ev.disposition}` : ""}
                    </Text>
                    {(ev.from_state || ev.to_state) && (
                      <Text style={{ color: palette.muted, fontSize: 12 }}>
                        {ev.from_state ?? "—"} → {ev.to_state ?? "—"}
                      </Text>
                    )}
                    {ev.notes ? <Text style={{ color: palette.text, fontSize: 12 }}>{ev.notes}</Text> : null}
                    <Text style={{ color: palette.muted, fontSize: 11 }}>
                      by {ev.actor_name ?? `user #${ev.actor_user_id}`} · {new Date(ev.created_at).toLocaleString()}
                    </Text>
                  </View>
                ))}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function StateBadge({ state, palette }: { state: string; palette: { text: string } }) {
  const color =
    state === "APPROVED" || state === "FINALIZED"
      ? "#16a34a"
      : state === "REVISION_REQUESTED"
      ? "#dc2626"
      : state === "SUBMITTED"
      ? "#0284c7"
      : state.startsWith("PENDING")
      ? "#d97706"
      : "#64748b";
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={{ color, fontSize: 11, fontWeight: "700" }}>{assessmentStateLabel(state)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 },
  title: { fontSize: 20, fontWeight: "800" },
  tabs: { flexGrow: 0, paddingVertical: 8 },
  tab: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 18, borderWidth: 1 },
  card: { borderRadius: 12, borderWidth: 1, padding: 12 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  badge: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, alignSelf: "flex-start" },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  modalSheet: { maxHeight: "88%", borderTopLeftRadius: 18, borderTopRightRadius: 18 },
  input: { borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 14, minHeight: 44 },
  actionBtn: { borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  actionText: { color: "#fff", fontWeight: "800" },
  eventRow: { borderWidth: 1, borderRadius: 8, padding: 8, gap: 2 },
});

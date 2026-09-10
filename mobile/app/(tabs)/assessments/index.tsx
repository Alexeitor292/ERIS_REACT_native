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
  getAssessmentEngineerOptions,
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
  isAdmin,
  isMaintenanceOnly,
} from "@/src/utils/roleModel";

type QueueKey = AssessmentQueue | "all";
const QUEUES: { key: QueueKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "office_chief", label: "Office" },
  { key: "branch_chief", label: "Branch" },
  { key: "engineer", label: "Staff" },
  { key: "reviewer", label: "Reviews" },
];

export default function AssessmentsScreen() {
  const { palette } = useUiSettings();
  const [roles, setRoles] = useState<string[]>([]);
  const [meId, setMeId] = useState<number | null>(null);
  const [queue, setQueue] = useState<QueueKey>("all");
  const [items, setItems] = useState<Assessment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<AssessmentDetail | null>(null);
  const [branchOpts, setBranchOpts] = useState<RoutingUserOption[]>([]);
  const [engineerOpts, setEngineerOpts] = useState<RoutingUserOption[]>([]);
  // No preselect, under any data shape: the assign button stays disabled until
  // the branch chief picks somebody, even when the office has one candidate
  // (owner decision 7, design §5).
  const [engineerId, setEngineerId] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) return;
      const me = await apiFetch<{ id: number; roles: string[] }>("/auth/me", { token });
      setRoles(me.roles ?? []);
      setMeId(Number.isFinite(me.id) ? Number(me.id) : null);
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
    setEngineerId(null);
    setBranchOpts([]);
    setEngineerOpts([]);
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
      if (
        d.assessment.state === "PENDING_ENGINEER_ASSIGNMENT" &&
        d.assessment.routing_path === "BRANCH" &&
        canAssignEngineer(roles)
      ) {
        try {
          const opts = await getAssessmentEngineerOptions(token, id);
          setEngineerOpts(opts.items);
        } catch {
          setEngineerOpts([]);
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

  // Route- and identity-derived affordances for the open assessment. Review
  // authority comes from the server's can_review; the assignee lives in
  // assigned_engineer_user_id on both routes.
  const openAssessment = detail?.assessment ?? null;
  const isBranchRoute = openAssessment?.routing_path === "BRANCH";
  const canSubmitThis =
    !!openAssessment &&
    (isAdmin(roles) ||
      (meId != null &&
        openAssessment.assigned_engineer_user_id != null &&
        openAssessment.assigned_engineer_user_id === meId));

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
              Incident #{item.incident_id} · {officeLabel(item)} · District {item.district ?? "—"}
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
                {/* Office and branch by NAME, from the routing snapshot: what
                    they read when this assessment was routed, not what they are
                    called today (design §3.5). */}
                <Text style={{ color: palette.muted }}>
                  Incident #{detail.assessment.incident_id} · {officeLabel(detail.assessment)}
                  {branchLabel(detail.assessment) ? ` · ${branchLabel(detail.assessment)}` : ""}
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
                          style={[styles.actionBtn, styles.personBtn, { backgroundColor: palette.primary }]}
                        >
                          <Text style={styles.actionText}>{o.full_name}</Text>
                          <Text style={styles.personBtnSub}>{personPlace(o)}</Text>
                          <Text style={styles.personBtnSub}>{workloadLine(o)}</Text>
                          {availabilityLine(o) ? <Text style={styles.personBtnSub}>{availabilityLine(o)}</Text> : null}
                        </Pressable>
                      ))
                    )}
                  </View>
                )}

                {detail.assessment.state === "PENDING_ENGINEER_ASSIGNMENT" && canAssignEngineer(roles) && (
                  <View style={{ gap: 6 }}>
                    {!isBranchRoute ? (
                      <Text style={{ color: palette.muted, fontSize: 11 }}>
                        Staff are assigned only on the branch route.
                      </Text>
                    ) : (
                      <>
                        <Text style={{ color: palette.muted, fontSize: 12 }}>Assign a Staff member:</Text>
                        {engineerOpts.length === 0 ? (
                          <Text style={{ color: palette.muted }}>No Staff members are recorded for this office.</Text>
                        ) : (
                          engineerOpts.map((o) => (
                            <PersonOption
                              key={o.id}
                              option={o}
                              selected={engineerId === o.id}
                              palette={palette}
                              onPress={() => setEngineerId(o.id)}
                            />
                          ))
                        )}
                        <Pressable
                          disabled={busy || engineerId == null}
                          onPress={() =>
                            engineerId != null &&
                            runAction((t) => assignAssessmentEngineer(t, detail.assessment.id, engineerId, notes))
                          }
                          style={[
                            styles.actionBtn,
                            { backgroundColor: palette.primary, opacity: engineerId == null ? 0.5 : 1 },
                          ]}
                        >
                          <Text style={styles.actionText}>Assign Staff member</Text>
                        </Pressable>
                        <Text style={{ color: palette.muted, fontSize: 11 }}>
                          Assigning outside this branch is allowed — record why in the notes above.
                        </Text>
                      </>
                    )}
                  </View>
                )}

                {(detail.assessment.state === "DRAFT" || detail.assessment.state === "REVISION_REQUESTED") &&
                  canSubmitThis && (
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
                    {detail.assessment.can_review && (
                      <>
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
                      </>
                    )}
                    <Text style={{ color: palette.muted, fontSize: 11 }}>
                      Only the branch chief (or the office chief on the senior engineer route) can decide this.
                    </Text>
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

/** The office as it read when the assessment was routed, not its code. */
function officeLabel(a: Assessment): string {
  return a.routed_office_name?.trim() || a.office_code || "—";
}

/** The branch the work was handed to, by name, or null before the hand-off. */
function branchLabel(a: Assessment): string | null {
  const name = a.routed_branch_name?.trim();
  if (name) return name;
  const letter = a.routed_branch_letter?.trim();
  return letter ? `Branch ${letter}` : null;
}

function districtLabel(district: string | null): string | null {
  const code = district?.trim();
  if (!code) return null;
  return `D${code.replace(/^0+(?=\d)/, "")}`;
}

/** Office · branch · home city — where this person sits, on one line. */
function personPlace(o: RoutingUserOption): string {
  const branch = o.branch_name?.trim() || (o.branch_letter ? `Branch ${o.branch_letter}` : "Branch not recorded");
  const where = [o.home_city?.trim() || null, districtLabel(o.home_district)].filter(Boolean).join(" ");
  return [o.office_name?.trim() || o.office_code || null, branch, where || null].filter(Boolean).join(" · ");
}

/**
 * Their two workload counts, as TEXT. Never a sort key and never a filter: the
 * hand-off is a deliberate human choice, so the picker annotates and the person
 * decides (owner decision 7, design §5).
 */
function workloadLine(o: RoutingUserOption): string {
  return `${o.open_assessment_count} open · ${o.awaiting_action_count} waiting on them`;
}

/** "Rotation out — back 2/5/27". Rendered beside the name, never filtered out. */
function availabilityLine(o: RoutingUserOption): string | null {
  const state = (o.availability || "AVAILABLE").toUpperCase();
  if (state === "AVAILABLE") return null;
  const label =
    state === "ROTATION_OUT"
      ? "Rotation out"
      : state === "ACTING_ELSEWHERE"
        ? "Acting elsewhere"
        : state === "UNAVAILABLE"
          ? "Unavailable"
          : state.replace(/_/g, " ");
  const until = o.available_until ? new Date(o.available_until) : null;
  return until && !Number.isNaN(until.getTime()) ? `${label} — back ${until.toLocaleDateString()}` : label;
}

/**
 * One picker row: the name, where they sit, what they are carrying. Selecting is
 * a separate act from assigning — nothing is preselected, and the primary button
 * stays disabled until the chief chooses somebody.
 */
function PersonOption({
  option,
  selected,
  palette,
  onPress,
}: {
  option: RoutingUserOption;
  selected: boolean;
  palette: { text: string; muted: string; border: string; panel: string; panelSoft: string; primary: string };
  onPress: () => void;
}) {
  const availability = availabilityLine(option);
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.personOption,
        {
          borderColor: selected ? palette.primary : palette.border,
          backgroundColor: selected ? palette.panelSoft : palette.panel,
          borderWidth: selected ? 2 : 1,
        },
      ]}
    >
      <Text style={{ color: palette.text, fontWeight: "800" }}>{option.full_name}</Text>
      <Text style={{ color: palette.muted, fontSize: 12 }}>{personPlace(option)}</Text>
      <Text style={{ color: palette.muted, fontSize: 12 }}>{workloadLine(option)}</Text>
      {availability ? <Text style={{ color: palette.muted, fontSize: 12 }}>{availability}</Text> : null}
      <Text style={{ color: palette.muted, fontSize: 11 }}>{option.email}</Text>
    </Pressable>
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
  personBtn: { paddingHorizontal: 12, gap: 2 },
  personBtnSub: { color: "#eef4ff", fontSize: 12, textAlign: "center" },
  personOption: { borderRadius: 12, padding: 12, gap: 2 },
  eventRow: { borderWidth: 1, borderRadius: 8, padding: 8, gap: 2 },
});

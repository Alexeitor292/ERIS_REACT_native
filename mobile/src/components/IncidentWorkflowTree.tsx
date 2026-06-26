import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { getToken } from "@/src/auth/tokenStore";
import { isSessionExpiredError } from "@/src/api/client";
import { getWorkflowTree, type WorkflowNode, type WorkflowNodeStatus, type WorkflowTree } from "@/src/api/workflowTree";
import { useUiSettings } from "@/src/ui/UiSettingsContext";

const STATUS_META: Record<WorkflowNodeStatus, { label: string; icon: string; color: string }> = {
  COMPLETED: { label: "Completed", icon: "✓", color: "#16a34a" },
  CURRENT: { label: "Current", icon: "►", color: "#0284c7" },
  PENDING: { label: "Pending", icon: "○", color: "#64748b" },
  WAITING_ON_REPORTER: { label: "Waiting on reporter", icon: "⮌", color: "#d97706" },
  REVISION_REQUESTED: { label: "Revision requested", icon: "↺", color: "#dc2626" },
  SKIPPED: { label: "Skipped", icon: "—", color: "#94a3b8" },
  TERMINAL: { label: "Terminal", icon: "■", color: "#16a34a" },
  UNASSIGNED: { label: "Unassigned", icon: "?", color: "#d97706" },
};

const PATH_LABEL: Record<string, string> = {
  PENDING_TRIAGE: "Awaiting triage",
  ASSESSMENT_REQUIRED: "Assessment required",
  NEEDS_REPORTER_INFORMATION: "Needs reporter information",
  NO_ASSESSMENT_REQUIRED: "No assessment required",
  DUPLICATE_OR_LINKED: "Linked / duplicate report",
};

function fmt(ts: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

function personLabel(node: WorkflowNode): string {
  if (node.user?.full_name) return node.user.full_name;
  if (node.user?.email) return node.user.email;
  if (node.status === "UNASSIGNED") return "Unassigned";
  if (node.status === "PENDING" || node.status === "SKIPPED") return "—";
  return node.role_title;
}

export default function IncidentWorkflowTree({ incidentId }: { incidentId: number }) {
  const { palette } = useUiSettings();
  const [tree, setTree] = useState<WorkflowTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const t = await getWorkflowTree(token, incidentId);
        if (alive) setTree(t);
      } catch (e) {
        if (alive && !isSessionExpiredError(e)) setError(e instanceof Error ? e.message : "Failed to load workflow");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [incidentId]);

  if (loading) return <ActivityIndicator color={palette.primary} style={{ marginVertical: 16 }} />;
  if (error || !tree) {
    // Access-denied or fetch error: keep the detail screen usable, just omit the tree.
    return null;
  }

  const owner = tree.current_owner;
  const overall = STATUS_META[tree.overall_status];

  return (
    <View style={[styles.wrap, { borderColor: palette.border, backgroundColor: palette.panel }]}>
      <Text style={[styles.title, { color: palette.text }]}>Workflow</Text>

      {/* Current owner / status banner — readable without expanding nodes */}
      <View style={[styles.banner, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}>
        <View style={styles.row}>
          <View style={[styles.badge, { borderColor: overall.color }]}>
            <Text style={{ color: overall.color, fontSize: 11, fontWeight: "800" }}>
              {overall.icon} {overall.label}
            </Text>
          </View>
          <Text style={{ color: palette.muted, fontSize: 12 }}>{PATH_LABEL[tree.path_type] ?? tree.path_type}</Text>
        </View>
        <Text style={{ color: palette.text, marginTop: 6, fontSize: 13 }}>
          <Text style={{ color: palette.muted }}>Current owner: </Text>
          {owner ? (
            <Text style={{ fontWeight: "800" }}>
              {owner.role_title}
              {owner.full_name ? ` — ${owner.full_name}` : owner.user_id == null ? " — Unassigned" : ""}
            </Text>
          ) : (
            <Text style={{ fontWeight: "800" }}>None (closed)</Text>
          )}
        </Text>
        {tree.assessment ? (
          <Text style={{ color: palette.muted, marginTop: 2, fontSize: 12 }}>
            Assessment: <Text style={{ color: palette.text, fontWeight: "700" }}>{tree.assessment.state}</Text>
            {tree.assessment.office_code ? ` · Office ${tree.assessment.office_code}` : ""}
          </Text>
        ) : null}
        {tree.linked_incident_id || tree.linked_location_id ? (
          <Text style={{ color: "#d97706", marginTop: 2, fontSize: 12 }}>
            Linked / duplicate
            {tree.linked_incident_id ? ` → incident #${tree.linked_incident_id}` : ""}
            {tree.linked_location_id ? ` → location #${tree.linked_location_id}` : ""}
          </Text>
        ) : null}
      </View>

      {/* Vertical node list */}
      <View style={{ marginTop: 8 }}>
        {tree.nodes.map((node, i) => {
          const meta = STATUS_META[node.status];
          const isCurrent = owner?.node_key === node.key;
          const open = expanded === node.key;
          const hasDetail = !!(node.notes || node.completed_at || node.user?.email || node.linked_incident_id);
          const dim = node.status === "SKIPPED" || node.status === "PENDING";
          return (
            <View key={node.key} style={styles.nodeRow}>
              {/* rail */}
              <View style={styles.rail}>
                <View style={[styles.dot, { backgroundColor: meta.color }]}>
                  <Text style={styles.dotIcon}>{meta.icon}</Text>
                </View>
                {i < tree.nodes.length - 1 ? <View style={[styles.line, { backgroundColor: palette.border }]} /> : null}
              </View>
              {/* card */}
              <Pressable
                onPress={() => hasDetail && setExpanded(open ? null : node.key)}
                style={[
                  styles.card,
                  {
                    borderColor: isCurrent ? palette.primary : palette.border,
                    backgroundColor: palette.panelSoft,
                    opacity: dim ? 0.65 : 1,
                    borderWidth: isCurrent ? 2 : 1,
                  },
                ]}
              >
                <Text style={{ color: palette.muted, fontSize: 10, fontWeight: "800", letterSpacing: 0.4 }}>
                  {node.role_title.toUpperCase()}
                </Text>
                <Text style={{ color: palette.text, fontSize: 14, fontWeight: "600", marginTop: 1 }}>{node.label}</Text>
                <Text style={{ fontSize: 12, marginTop: 2 }}>
                  <Text style={{ color: meta.color, fontWeight: "700" }}>{meta.label}</Text>
                  <Text style={{ color: palette.muted }}> · {personLabel(node)}</Text>
                </Text>
                {node.completed_at ? (
                  <Text style={{ color: palette.muted, fontSize: 11, marginTop: 1 }}>{fmt(node.completed_at)}</Text>
                ) : null}
                {open ? (
                  <View style={{ marginTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border, paddingTop: 6 }}>
                    {node.user?.email ? <Text style={{ color: palette.muted, fontSize: 12 }}>{node.user.email}</Text> : null}
                    {node.notes ? <Text style={{ color: palette.text, fontSize: 12, marginTop: 2 }}>{node.notes}</Text> : null}
                    {node.linked_incident_id ? (
                      <Text style={{ color: palette.muted, fontSize: 12, marginTop: 2 }}>Linked incident #{node.linked_incident_id}</Text>
                    ) : null}
                  </View>
                ) : hasDetail ? (
                  <Text style={{ color: palette.muted, fontSize: 11, marginTop: 2 }}>Tap for details</Text>
                ) : null}
              </Pressable>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 12 },
  title: { fontSize: 16, fontWeight: "800", marginBottom: 8 },
  banner: { borderWidth: 1, borderRadius: 10, padding: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  badge: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  nodeRow: { flexDirection: "row", alignItems: "stretch" },
  rail: { width: 26, alignItems: "center" },
  dot: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  dotIcon: { color: "#000", fontSize: 12, fontWeight: "900" },
  line: { width: 2, flex: 1, marginVertical: 2 },
  card: { flex: 1, borderRadius: 10, padding: 10, marginBottom: 8, marginLeft: 6 },
});

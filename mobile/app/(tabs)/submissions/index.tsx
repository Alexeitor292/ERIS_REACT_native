import { useEffect, useState } from "react";
import { View, Text, Pressable, FlatList, StyleSheet, Alert } from "react-native";
import { router } from "expo-router";
import { apiFetch, isSessionExpiredError } from "../../../src/api/client";
import { getToken, clearToken } from "../../../src/auth/tokenStore";
import { useUiSettings } from "../../../src/ui/UiSettingsContext";

type SubmissionItem = {
  id: number;
  title?: string | null;
  status: string;
  created_at: string;
  submitted_at: string | null;
};

type ListResponse = { items: SubmissionItem[] };

export default function SubmissionsList() {
  const { palette, density } = useUiSettings();
  const [items, setItems] = useState<SubmissionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const compact = density === "compact";

  async function load() {
    const token = await getToken();
    if (!token) return router.replace("/(auth)/login");

    setLoading(true);
    try {
      const res = await apiFetch<ListResponse>("/submissions?limit=50", { token });
      setItems(res.items ?? []);
    } catch (e: any) {
      if (isSessionExpiredError(e)) return;
      Alert.alert("Load failed", String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  async function createDraft() {
    const token = await getToken();
    if (!token) return;

    try {
      const res = await apiFetch<{ submission_id: number }>("/submissions", { method: "POST", token });
      Alert.alert("Created", `Draft #${res.submission_id}`);
      await load();
      router.push({
        pathname: "/(tabs)/submissions/[id]",
        params: { id: String(res.submission_id) },
      });
    } catch (e: any) {
      if (isSessionExpiredError(e)) return;
      Alert.alert("Create failed", String(e?.message ?? e));
    }
  }

  async function logout() {
    await clearToken();
    router.replace("/(auth)/login");
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <View style={[styles.container, { backgroundColor: palette.bg, padding: compact ? 10 : 12 }]}>
      <View style={[styles.hero, { backgroundColor: palette.panelSoft, borderColor: palette.border }]}>
        <Text style={[styles.heroTitle, { color: palette.text }]}>Field Submissions</Text>
        <Text style={[styles.heroSub, { color: palette.muted }]}>Capture, review, and track incidents with confidence.</Text>
      </View>

      <View style={styles.topRow}>
        <Pressable style={[styles.primaryBtn, { backgroundColor: palette.primary, paddingVertical: compact ? 8 : 10 }]} onPress={createDraft}>
          <Text style={styles.primaryText}>+ New Draft</Text>
        </Pressable>

        <Pressable style={[styles.secondaryBtn, { borderColor: palette.border, backgroundColor: palette.panelSoft, paddingVertical: compact ? 8 : 10 }]} onPress={load}>
          <Text style={[styles.secondaryText, { color: palette.text }]}>{loading ? "Loading..." : "Refresh"}</Text>
        </Pressable>

        <Pressable style={[styles.secondaryBtn, { borderColor: palette.border, backgroundColor: palette.panelSoft, paddingVertical: compact ? 8 : 10 }]} onPress={logout}>
          <Text style={[styles.secondaryText, { color: palette.text }]}>Logout</Text>
        </Pressable>
      </View>

      <FlatList
        data={items}
        keyExtractor={(it) => String(it.id)}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push({
              pathname: "/(tabs)/submissions/[id]",
              params: { id: String(item.id) },
            })}
            style={[styles.card, { backgroundColor: palette.panel, borderColor: palette.border, padding: compact ? 10 : 12 }]}
          >
            <Text style={[styles.cardTitle, { color: palette.text }]}>{item.title?.trim() || `Submission #${item.id}`}</Text>
            <View style={styles.statusRow}>
              <Text style={[styles.cardMetaLabel, { color: palette.muted }]}>Status</Text>
              <Text style={[styles.statusPill, item.status === "APPROVED" ? styles.statusApproved : item.status === "REJECTED" ? styles.statusRejected : item.status === "SUBMITTED" ? styles.statusSubmitted : styles.statusDraft]}>{item.status}</Text>
            </View>
            <Text style={[styles.cardMeta, { color: palette.muted }]}>Created: {item.created_at}</Text>
            {item.submitted_at ? <Text style={[styles.cardMeta, { color: palette.muted }]}>Submitted: {item.submitted_at}</Text> : null}
          </Pressable>
        )}
        ListEmptyComponent={<Text style={{ padding: 10, color: palette.muted }}>{loading ? "" : "No submissions yet."}</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 12, gap: 10, backgroundColor: "#eef3fb" },
  hero: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#cfe0ff",
    backgroundColor: "#f8fbff",
    padding: 12,
  },
  heroTitle: { fontSize: 20, fontWeight: "800", color: "#0f2f63" },
  heroSub: { marginTop: 2, fontSize: 13, color: "#5c6e8d" },
  topRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  primaryBtn: { backgroundColor: "#1d4ed8", paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10 },
  primaryText: { color: "white", fontWeight: "600" },
  secondaryBtn: { borderWidth: 1, borderColor: "#c8d3e6", backgroundColor: "#f7faff", paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10 },
  secondaryText: { fontWeight: "600", color: "#26364d" },
  card: { borderWidth: 1, borderColor: "#d7e2f1", backgroundColor: "#fff", borderRadius: 12, padding: 12, marginBottom: 10 },
  cardTitle: { fontSize: 16, fontWeight: "700", marginBottom: 8, color: "#1b283b" },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  cardMetaLabel: { color: "#52647f", fontSize: 12, fontWeight: "700", textTransform: "uppercase" },
  statusPill: { fontSize: 11, fontWeight: "800", paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999, overflow: "hidden" },
  statusDraft: { color: "#334155", backgroundColor: "#e2e8f0" },
  statusSubmitted: { color: "#1d4ed8", backgroundColor: "#dbeafe" },
  statusApproved: { color: "#166534", backgroundColor: "#dcfce7" },
  statusRejected: { color: "#991b1b", backgroundColor: "#fee2e2" },
  cardMeta: { color: "#5c6e8d", fontSize: 12 },
});

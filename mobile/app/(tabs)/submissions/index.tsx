import { useEffect, useMemo, useState } from "react";
import { View, Text, Pressable, FlatList, StyleSheet, Alert, TextInput } from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Swipeable } from "react-native-gesture-handler";
import * as Location from "expo-location";
import { apiFetch, isSessionExpiredError } from "../../../src/api/client";
import { getToken, clearToken } from "../../../src/auth/tokenStore";
import { useUiSettings } from "../../../src/ui/UiSettingsContext";
import { buildSubmissionDescriptor } from "../../../src/utils/submissionLabel";
import { countyCodeFromNameOrCode, districtForCounty, routesForCounty } from "../../../src/utils/caltransLookups";
import { deleteSubmission, patchSubmission } from "../../../src/api/submissions";
import { enrichPointFromArcgisClient } from "../../../src/utils/arcgisEnrichment";

type SubmissionItem = {
  id: number;
  created_by_user_id: number;
  status: string;
  district?: string | null;
  county?: string | null;
  route?: string | null;
  post_mile?: string | null;
  created_at: string;
  submitted_at: string | null;
};

type ListResponse = { items: SubmissionItem[] };
type UserInfo = { id: number; roles: string[] };
type ListView = "DRAFTS" | "SUBMITTED";

export default function SubmissionsList() {
  const { palette, density } = useUiSettings();
  const [items, setItems] = useState<SubmissionItem[]>([]);
  const [me, setMe] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyDeleteId, setBusyDeleteId] = useState<number | null>(null);
  const [view, setView] = useState<ListView>("DRAFTS");
  const [search, setSearch] = useState("");
  const compact = density === "compact";

  async function load() {
    const token = await getToken();
    if (!token) return router.replace("/(auth)/login");

    setLoading(true);
    try {
      const [res, user] = await Promise.all([
        apiFetch<ListResponse>("/submissions?limit=100", { token }),
        apiFetch<UserInfo>("/auth/me", { token }),
      ]);
      setItems(res.items ?? []);
      setMe(user);
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
      const newId = String(res.submission_id);

      try {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (permission.status === "granted") {
          const pos = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          const lat = pos.coords.latitude;
          const lon = pos.coords.longitude;

          const geo = await enrichPointFromArcgisClient(lat, lon);
          const countyCode = countyCodeFromNameOrCode(geo.county ?? "");
          const district = geo.district ? String(geo.district).padStart(2, "0") : districtForCounty(countyCode);
          const route = geo.route?.trim() || "";
          const routeAllowed = countyCode ? routesForCounty(countyCode) : [];
          const normalizedRoute = route && (routeAllowed.length === 0 || routeAllowed.includes(route)) ? route : "";

          await patchSubmission(token, newId, {
            latitude: lat,
            longitude: lon,
            county: countyCode ?? null,
            district: district ?? null,
            route: normalizedRoute || null,
            post_mile: (geo.post_mile || "").trim() || null,
          });
        }
      } catch {
        // Non-blocking: draft still gets created even if enrichment fails.
      }

      Alert.alert("Created", `Draft #${res.submission_id}`);
      await load();
      router.push({
        pathname: "/(tabs)/submissions/[id]",
        params: { id: newId },
      });
    } catch (e: any) {
      if (isSessionExpiredError(e)) return;
      Alert.alert("Create failed", String(e?.message ?? e));
    }
  }

  async function onDelete(item: SubmissionItem) {
    const token = await getToken();
    if (!token) return;

    setBusyDeleteId(item.id);
    try {
      await deleteSubmission(token, String(item.id));
      await load();
    } catch (e: any) {
      if (!isSessionExpiredError(e)) {
        Alert.alert("Delete failed", String(e?.message ?? e));
      }
    } finally {
      setBusyDeleteId(null);
    }
  }

  async function logout() {
    await clearToken();
    router.replace("/(auth)/login");
  }

  const roles = new Set(me?.roles ?? []);
  const isPrivilegedViewer = roles.has("ADMIN") || roles.has("REVIEWER");

  function canDelete(item: SubmissionItem): boolean {
    if (!me) return false;
    const isAdmin = roles.has("ADMIN");
    const isOwner = item.created_by_user_id === me.id;
    if (item.status === "DRAFT") return isAdmin || isOwner;
    return isAdmin;
  }

  const visibleItems = useMemo(() => {
    const source =
      view === "DRAFTS"
        ? items.filter((it) => it.status === "DRAFT" || it.status === "REJECTED")
        : items.filter((it) => it.status !== "DRAFT" && it.status !== "REJECTED");
    const q = search.trim().toLowerCase();
    if (!q) return source;
    return source.filter((it) => {
      const descriptor = buildSubmissionDescriptor({
        id: it.id,
        created_at: it.created_at,
        district: it.district,
        county: it.county,
        route: it.route,
        post_mile: it.post_mile,
      }).toLowerCase();
      return (
        descriptor.includes(q) ||
        String(it.id).includes(q) ||
        (it.status ?? "").toLowerCase().includes(q) ||
        (it.route ?? "").toLowerCase().includes(q) ||
        (it.county ?? "").toLowerCase().includes(q)
      );
    });
  }, [items, search, view]);

  const draftCount = useMemo(
    () => items.filter((it) => it.status === "DRAFT" || it.status === "REJECTED").length,
    [items]
  );
  const submittedCount = useMemo(
    () => items.filter((it) => it.status !== "DRAFT" && it.status !== "REJECTED").length,
    [items]
  );

  useEffect(() => {
    load();
  }, []);

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={[styles.container, { backgroundColor: palette.bg }]}>
      <View style={[styles.contentWrap, { padding: compact ? 10 : 12 }]}>
      <Text style={[styles.title, { color: palette.text }]}>Submissions</Text>
      <Text style={[styles.subtitle, { color: palette.muted }]}>Create, review, and track field reports.</Text>

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

      <View style={[styles.segmentRow, { backgroundColor: palette.panelSoft, borderColor: palette.border }]}>
        <Pressable
          onPress={() => setView("DRAFTS")}
          style={[
            styles.segmentBtn,
            { backgroundColor: view === "DRAFTS" ? palette.primary : "transparent" },
          ]}
        >
          <Text style={[styles.segmentText, { color: view === "DRAFTS" ? "#fff" : palette.text }]}>
            Drafts ({draftCount})
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setView("SUBMITTED")}
          style={[
            styles.segmentBtn,
            { backgroundColor: view === "SUBMITTED" ? palette.primary : "transparent" },
          ]}
        >
          <Text style={[styles.segmentText, { color: view === "SUBMITTED" ? "#fff" : palette.text }]}>
            Submitted ({submittedCount})
          </Text>
        </Pressable>
      </View>

      {view === "SUBMITTED" && isPrivilegedViewer ? (
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search records by ID, route, county..."
          placeholderTextColor={palette.muted}
          style={[
            styles.searchInput,
            { backgroundColor: palette.panelSoft, borderColor: palette.border, color: palette.text },
          ]}
        />
      ) : null}

      <FlatList
        data={visibleItems}
        keyExtractor={(it) => String(it.id)}
        renderItem={({ item }) => {
          const canDeleteThis = canDelete(item);
          const card = (
            <Pressable
              onPress={() => router.push({
                pathname: "/(tabs)/submissions/[id]",
                params: { id: String(item.id) },
              })}
              style={[styles.card, { backgroundColor: palette.panel, borderColor: palette.border, padding: compact ? 10 : 12 }]}
            >
              <Text style={[styles.cardTitle, { color: palette.text }]}>
                {buildSubmissionDescriptor({
                  id: item.id,
                  created_at: item.created_at,
                  district: item.district,
                  county: item.county,
                  route: item.route,
                  post_mile: item.post_mile,
                })}
              </Text>
              <View style={styles.statusRow}>
                <Text style={[styles.cardMetaLabel, { color: palette.muted }]}>Status</Text>
                <Text style={[styles.statusPill, item.status === "APPROVED" ? styles.statusApproved : item.status === "REJECTED" ? styles.statusRejected : item.status === "SUBMITTED" ? styles.statusSubmitted : styles.statusDraft]}>{item.status}</Text>
              </View>
              <Text style={[styles.cardMeta, { color: palette.muted }]}>Created: {item.created_at}</Text>
              {item.submitted_at ? <Text style={[styles.cardMeta, { color: palette.muted }]}>Submitted: {item.submitted_at}</Text> : null}
            </Pressable>
          );

          if (!canDeleteThis) return card;

          return (
            <Swipeable
              overshootRight={false}
              renderRightActions={() => (
                <View style={styles.swipeActionWrap}>
                  <Pressable
                    style={[styles.deleteActionBtn, { backgroundColor: "#b91c1c" }]}
                    onPress={() =>
                      Alert.alert(
                        "Delete Submission",
                        item.status === "DRAFT"
                          ? "Delete this draft?"
                          : "Delete this submitted/reviewed record? This cannot be undone.",
                        [
                          { text: "Cancel", style: "cancel" },
                          {
                            text: "Delete",
                            style: "destructive",
                            onPress: () => onDelete(item),
                          },
                        ]
                      )
                    }
                    disabled={busyDeleteId === item.id}
                  >
                    <Text style={styles.deleteActionText}>{busyDeleteId === item.id ? "..." : "Delete"}</Text>
                  </Pressable>
                </View>
              )}
            >
              {card}
            </Swipeable>
          );
        }}
        ListEmptyComponent={
          <Text style={{ padding: 10, color: palette.muted }}>
            {loading ? "" : view === "DRAFTS" ? "No drafts yet." : "No submitted records yet."}
          </Text>
        }
      />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#eef3fb" },
  contentWrap: { flex: 1, padding: 12, gap: 10 },
  title: { fontSize: 24, fontWeight: "800" },
  subtitle: { marginTop: 2, marginBottom: 6, fontSize: 13 },
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
  segmentRow: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 4,
    flexDirection: "row",
    gap: 4,
  },
  segmentBtn: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: "center",
  },
  segmentText: { fontWeight: "700", fontSize: 12 },
  searchInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
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
  swipeActionWrap: {
    justifyContent: "center",
    marginBottom: 10,
  },
  deleteActionBtn: {
    width: 92,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
  },
  deleteActionText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 12,
  },
});

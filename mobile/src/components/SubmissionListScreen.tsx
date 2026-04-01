import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, FlatList, StyleSheet, Alert, TextInput, Modal, ScrollView } from "react-native";
import { Swipeable } from "react-native-gesture-handler";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Location from "expo-location";
import { apiFetch, isSessionExpiredError } from "../api/client";
import { getToken } from "../auth/tokenStore";
import { useUiSettings } from "../ui/UiSettingsContext";
import { buildSubmissionDescriptor } from "../utils/submissionLabel";
import { countyCodeFromNameOrCode, districtForCounty, routesForCounty } from "../utils/caltransLookups";
import { deleteSubmission, getSubmissionPermissions, patchSubmission, replaceSubmissionPermissions, SubmissionPermissions } from "../api/submissions";
import { enrichPointFromArcgisClient } from "../utils/arcgisEnrichment";
import { normalizeCoordinateValue, normalizePostMileValue } from "../utils/precision";
import {
  clearOfflineQueue,
  diagnoseOfflineQueue,
  getOfflineQueueCount,
  getOfflineQueueSummary,
  type OfflineQueueDiagnosis,
  type OfflineQueueSummary,
} from "../offline/queue";
import { triggerOfflineSyncNow } from "../offline/syncLoop";
import { createLocalDraft, deleteLocalDraft, getLocalDraft, isLocalDraftId, listLocalDrafts } from "../offline/localDrafts";

type SubmissionItem = {
  id: number | string;
  created_by_user_id: number;
  status: string;
  district?: string | null;
  county?: string | null;
  route?: string | null;
  post_mile?: string | null;
  created_at: string;
  submitted_at: string | null;
  localOnly?: boolean;
};

type ListResponse = { items: SubmissionItem[] };
type UserInfo = { id: number; roles: string[] };

type Props = {
  mode: "DRAFTS" | "SUBMITTED";
};

export default function SubmissionListScreen({ mode }: Props) {
  const { palette, density } = useUiSettings();
  const [items, setItems] = useState<SubmissionItem[]>([]);
  const [me, setMe] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyDeleteId, setBusyDeleteId] = useState<number | string | null>(null);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [loadWarning, setLoadWarning] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const compact = density === "compact";

  const [permissionsFor, setPermissionsFor] = useState<SubmissionItem | null>(null);
  const [permissionsData, setPermissionsData] = useState<SubmissionPermissions | null>(null);
  const [permissionsLoading, setPermissionsLoading] = useState(false);
  const [permissionsSaving, setPermissionsSaving] = useState(false);
  const [readerIds, setReaderIds] = useState<number[]>([]);
  const [editorIds, setEditorIds] = useState<number[]>([]);
  const swipeableRefs = useRef<Record<string, Swipeable | null>>({});
  const openSwipeableIdRef = useRef<string | null>(null);

  const closeOpenSwipeable = useCallback(() => {
    const openId = openSwipeableIdRef.current;
    if (openId == null) return;
    swipeableRefs.current[openId]?.close();
    openSwipeableIdRef.current = null;
  }, []);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return router.replace("/(auth)/login");

    setLoading(true);
    try {
      const [res, user, localDraftRows] = await Promise.all([
        apiFetch<ListResponse>("/submissions?limit=100", { token }),
        apiFetch<UserInfo>("/auth/me", { token }),
        listLocalDrafts(),
      ]);
      const localItems: SubmissionItem[] = (localDraftRows ?? [])
        .filter((x) => !x.serverId)
        .map((x) => ({
        id: x.localId,
        created_by_user_id: user.id,
        status: "DRAFT",
        district: null,
        county: null,
        route: null,
        post_mile: null,
        created_at: x.createdAt,
        submitted_at: null,
        localOnly: true,
      }));
      setItems([...(res.items ?? []), ...localItems]);
      setMe(user);
      setLoadWarning(null);
    } catch (e: any) {
      if (isSessionExpiredError(e)) return;
      const localDraftRows = await listLocalDrafts().catch(() => []);
      setItems(
        (localDraftRows ?? [])
          .filter((x) => !x.serverId)
          .map((x) => ({
          id: x.localId,
          created_by_user_id: 0,
          status: "DRAFT",
          district: null,
          county: null,
          route: null,
          post_mile: null,
          created_at: x.createdAt,
          submitted_at: null,
          localOnly: true,
        }))
      );
      setMe((prev) => prev ?? { id: 0, roles: [] });
      setLoadWarning(`Server unreachable. Showing local drafts only. ${String(e?.message ?? e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    let mounted = true;
    const refreshPending = async () => {
      const count = await getOfflineQueueCount();
      if (mounted) setPendingSyncCount(count);
    };
    refreshPending().catch(() => {});
    const t = setInterval(() => {
      refreshPending().catch(() => {});
    }, 5000);
    return () => {
      mounted = false;
      clearInterval(t);
    };
  }, []);

  const refreshPendingSyncCount = useCallback(async () => {
    const count = await getOfflineQueueCount();
    setPendingSyncCount(count);
  }, []);

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
          const lat = normalizeCoordinateValue(pos.coords.latitude);
          const lon = normalizeCoordinateValue(pos.coords.longitude);
          if (lat == null || lon == null) throw new Error("Invalid GPS coordinates.");

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
            post_mile: normalizePostMileValue(geo.post_mile),
          });
        }
      } catch {
        // Non-blocking: draft still gets created even if enrichment fails.
      }

      Alert.alert("Created", `Draft #${res.submission_id}`);
      await load();
      router.push({
        pathname: "/(tabs)/drafts/[id]",
        params: { id: newId },
      });
    } catch (e: any) {
      if (isSessionExpiredError(e)) return;
      try {
        const offlineDraft = await createLocalDraft({
          form: {
            report_date: "",
            district: "",
            county: "",
            route: "",
            post_mile: "",
            latitude: "",
            longitude: "",
          },
          incidentTypes: [],
          immediateActions: [],
          followUpActions: [],
          districtContacts: [],
        });
        const persisted = await getLocalDraft(offlineDraft.localId);
        if (!persisted) {
          throw new Error("Local draft could not be persisted on this device.");
        }
        Alert.alert("Created Offline", "Local draft created and will sync automatically when connectivity returns.");
        await load();
        router.push({
          pathname: "/(tabs)/drafts/[id]",
          params: { id: offlineDraft.localId },
        });
      } catch {
        Alert.alert("Create failed", String(e?.message ?? e));
      }
    }
  }

  async function onDelete(item: SubmissionItem) {
    closeOpenSwipeable();
    const token = await getToken();
    if (!token) return;

    if (isLocalDraftId(String(item.id))) {
      await deleteLocalDraft(String(item.id));
      await load();
      return;
    }

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

  async function openPermissions(item: SubmissionItem) {
    closeOpenSwipeable();
    if (isLocalDraftId(String(item.id))) return;
    const token = await getToken();
    if (!token) return;
    setPermissionsFor(item);
    setPermissionsLoading(true);
    setPermissionsData(null);
    setReaderIds([]);
    setEditorIds([]);
    try {
      const data = await getSubmissionPermissions(token, String(item.id));
      setPermissionsData(data);
      setReaderIds((data.readers ?? []).map((x) => x.user_id));
      setEditorIds((data.editors ?? []).map((x) => x.user_id));
    } catch (e: any) {
      if (!isSessionExpiredError(e)) {
        Alert.alert("Permissions", String(e?.message ?? e));
      }
    } finally {
      setPermissionsLoading(false);
    }
  }

  async function savePermissions() {
    if (!permissionsFor) return;
    const token = await getToken();
    if (!token) return;
    setPermissionsSaving(true);
    try {
      await replaceSubmissionPermissions(token, String(permissionsFor.id), {
        reader_user_ids: readerIds,
        editor_user_ids: editorIds,
      });
      const fresh = await getSubmissionPermissions(token, String(permissionsFor.id));
      setPermissionsData(fresh);
      setReaderIds((fresh.readers ?? []).map((x) => x.user_id));
      setEditorIds((fresh.editors ?? []).map((x) => x.user_id));
      Alert.alert("Saved", "Access permissions updated.");
    } catch (e: any) {
      if (!isSessionExpiredError(e)) {
        Alert.alert("Save failed", String(e?.message ?? e));
      }
    } finally {
      setPermissionsSaving(false);
    }
  }

  const roles = new Set(me?.roles ?? []);

  function canDelete(item: SubmissionItem): boolean {
    if (isLocalDraftId(String(item.id))) return true;
    if (!me) return false;
    const isAdmin = roles.has("ADMIN");
    const isOwner = item.created_by_user_id === me.id;
    return item.status === "DRAFT" && (isAdmin || isOwner);
  }

  const draftsItems = useMemo(() => {
    const source = items.filter((it) => it.status === "DRAFT" || it.status === "REJECTED");
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
  }, [items, search]);

  const submittedItems = useMemo(() => {
    const source = items.filter(
      (it) => !isLocalDraftId(String(it.id)) && it.status !== "DRAFT" && it.status !== "REJECTED"
    );
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
  }, [items, search]);

  const isDraftMode = mode === "DRAFTS";
  const panelItems = isDraftMode ? draftsItems : submittedItems;

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={[styles.container, { backgroundColor: palette.bg }]}>
      <View style={[styles.contentWrap, { padding: compact ? 10 : 12 }]}> 
        <Text style={[styles.title, { color: palette.text }]}>{isDraftMode ? "Drafts" : "Submissions"}</Text>
        <Text style={[styles.subtitle, { color: palette.muted }]}> 
          {isDraftMode ? "Create and continue draft reports." : "Track submitted and reviewed reports."}
        </Text>
        {pendingSyncCount > 0 ? (
          <Pressable
            onPress={async () => {
              try {
                const result = await triggerOfflineSyncNow();
                await refreshPendingSyncCount();
                if (result.skipped) {
                  Alert.alert("Sync", "Unable to sync now. Please confirm you are signed in.");
                  return;
                }
                if (result.remaining > 0) {
                  const summary: OfflineQueueSummary = await getOfflineQueueSummary().catch(() => ({ count: result.remaining }));
                  const diagnosis: OfflineQueueDiagnosis = await diagnoseOfflineQueue().catch(() => ({ count: result.remaining }));
                  const head = diagnosis.head;
                  const details = [
                    `${result.remaining} queued change${result.remaining === 1 ? "" : "s"} still pending.`,
                    summary.firstItemType ? `Next: ${summary.firstItemType}` : "",
                    summary.firstItemSubmissionId ? `Submission: ${summary.firstItemSubmissionId}` : "",
                    head ? `Attempts: ${head.attempts}` : "",
                    head?.resolvedSubmissionId ? `Resolved Submission: ${head.resolvedSubmissionId}` : "",
                    head?.localDraftExists === false ? "Local draft record: missing" : "",
                    head?.localDraftExists === true && head.localDraftServerId ? `Local->Server ID: ${head.localDraftServerId}` : "",
                    summary.firstItemLastError ? `Error: ${summary.firstItemLastError}` : "",
                  ]
                    .filter(Boolean)
                    .join("\n");
                  Alert.alert("Sync Incomplete", details, [
                    { text: "Keep Queue", style: "cancel" },
                    {
                      text: "Clear Pending",
                      style: "destructive",
                      onPress: async () => {
                        await clearOfflineQueue().catch(() => {});
                        await refreshPendingSyncCount().catch(() => {});
                        Alert.alert("Sync Queue Cleared", "Pending offline changes were removed.");
                      },
                    },
                  ]);
                  return;
                }
                Alert.alert("Sync Complete", "Offline changes synced successfully.");
              } catch {
                await refreshPendingSyncCount().catch(() => {});
                Alert.alert("Sync", "Retry failed. Please try again.");
              }
            }}
            style={[styles.syncBanner, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}
          >
            <Text style={[styles.syncBannerText, { color: palette.text }]}>
              {pendingSyncCount} queued offline change{pendingSyncCount === 1 ? "" : "s"} waiting to sync. Tap to retry now.
            </Text>
          </Pressable>
        ) : null}
        {loadWarning ? (
          <View style={[styles.warningBanner, { borderColor: "#b45309", backgroundColor: "#fffbeb" }]}>
            <Text style={[styles.warningBannerText, { color: "#92400e" }]}>{loadWarning}</Text>
          </View>
        ) : null}

        <View style={styles.topRow}>
          {isDraftMode ? (
            <Pressable
              style={[styles.primaryBtn, { backgroundColor: palette.primary, paddingVertical: compact ? 8 : 10 }]}
              onPress={createDraft}
            >
              <Text style={styles.primaryText}>+ New Draft</Text>
            </Pressable>
          ) : null}
          <Pressable
            style={[styles.secondaryBtn, { borderColor: palette.border, backgroundColor: palette.panelSoft, paddingVertical: compact ? 8 : 10 }]}
            onPress={load}
          >
            <Text style={[styles.secondaryText, { color: palette.text }]}>{loading ? "Loading..." : "Refresh"}</Text>
          </Pressable>
        </View>

        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search by ID, status, route, county..."
          placeholderTextColor={palette.muted}
          style={[
            styles.searchInput,
            { backgroundColor: palette.panelSoft, borderColor: palette.border, color: palette.text },
          ]}
        />

        <FlatList
          data={panelItems}
          keyExtractor={(it) => String(it.id)}
          renderItem={({ item }) => {
            const canDeleteThis = canDelete(item);
            const card = (
              <Pressable
                onPress={() => {
                  closeOpenSwipeable();
                  router.push({
                    pathname: item.status === "DRAFT" || item.status === "REJECTED" ? "/(tabs)/drafts/[id]" : "/(tabs)/submissions/[id]",
                    params: { id: String(item.id) },
                  });
                }}
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
                  <Text
                    style={[
                      styles.statusPill,
                      item.status === "APPROVED"
                        ? styles.statusApproved
                        : item.status === "REJECTED"
                          ? styles.statusRejected
                          : item.status === "SUBMITTED"
                            ? styles.statusSubmitted
                            : styles.statusDraft,
                    ]}
                  >
                    {item.status}
                  </Text>
                </View>
                <Text style={[styles.cardMeta, { color: palette.muted }]}>Created: {item.created_at}</Text>
                {item.localOnly ? (
                  <Text style={[styles.cardMeta, { color: "#b45309" }]}>Local draft (offline)</Text>
                ) : null}
                {item.submitted_at ? (
                  <Text style={[styles.cardMeta, { color: palette.muted }]}>Submitted: {item.submitted_at}</Text>
                ) : null}
              </Pressable>
            );

            return (
              <Swipeable
                ref={(ref) => {
                  swipeableRefs.current[String(item.id)] = ref;
                }}
                friction={1.8}
                rightThreshold={24}
                overshootRight={false}
                onSwipeableWillOpen={() => {
                  const currentlyOpen = openSwipeableIdRef.current;
                  const itemId = String(item.id);
                  if (currentlyOpen != null && currentlyOpen !== itemId) {
                    swipeableRefs.current[currentlyOpen]?.close();
                  }
                  openSwipeableIdRef.current = itemId;
                }}
                onSwipeableWillClose={() => {
                  if (openSwipeableIdRef.current === String(item.id)) {
                    openSwipeableIdRef.current = null;
                  }
                }}
                renderRightActions={() => (
                  <View style={styles.swipeActionWrap}>
                    <Pressable
                      style={[styles.actionBtn, { backgroundColor: palette.primary }]}
                      onPress={() => {
                        closeOpenSwipeable();
                        openPermissions(item);
                      }}
                      disabled={isLocalDraftId(String(item.id))}
                    >
                      <Text style={styles.actionText}>{isLocalDraftId(String(item.id)) ? "Local" : "Access"}</Text>
                    </Pressable>
                    {canDeleteThis ? (
                      <Pressable
                        style={[styles.actionBtn, { backgroundColor: "#b91c1c" }]}
                        onPress={() => {
                          closeOpenSwipeable();
                          Alert.alert(
                            "Delete Draft",
                            "Delete this draft? This cannot be undone.",
                            [
                              { text: "Cancel", style: "cancel" },
                              {
                                text: "Delete",
                                style: "destructive",
                                onPress: () => onDelete(item),
                              },
                            ]
                          );
                        }}
                        disabled={busyDeleteId === item.id}
                      >
                        <Text style={styles.actionText}>{busyDeleteId === item.id ? "..." : "Delete"}</Text>
                      </Pressable>
                    ) : null}
                  </View>
                )}
              >
                {card}
              </Swipeable>
            );
          }}
          ListEmptyComponent={
            <Text style={{ padding: 10, color: palette.muted }}>
              {loading ? "" : isDraftMode ? "No drafts yet." : "No submitted records yet."}
            </Text>
          }
          onTouchStart={closeOpenSwipeable}
          onScrollBeginDrag={closeOpenSwipeable}
        />
      </View>

      <Modal
        visible={!!permissionsFor}
        transparent
        animationType="fade"
        onRequestClose={() => setPermissionsFor(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setPermissionsFor(null)}>
          <Pressable style={[styles.modalCard, { backgroundColor: palette.panel, borderColor: palette.border }]}>
            <Text style={[styles.modalTitle, { color: palette.text }]}>Access Permissions</Text>
            <Text style={[styles.modalSub, { color: palette.muted }]}>Submission #{permissionsFor?.id}</Text>

            {permissionsLoading || !permissionsData ? (
              <Text style={{ color: palette.muted, marginTop: 8 }}>Loading...</Text>
            ) : (
              <ScrollView style={{ maxHeight: 420 }}>
                <Text style={[styles.modalLabel, { color: palette.text }]}>Owner</Text>
                <Text style={{ color: palette.text, marginBottom: 8 }}>{permissionsData.owner.full_name} ({permissionsData.owner.email})</Text>

                <Text style={[styles.modalLabel, { color: palette.text }]}>Readers</Text>
                {(permissionsData.readers ?? []).length === 0 ? (
                  <Text style={{ color: palette.muted, marginBottom: 8 }}>No explicit readers.</Text>
                ) : (
                  (permissionsData.readers ?? []).map((u) => (
                    <Text key={`r-${u.user_id}`} style={{ color: palette.text }}>{u.full_name} ({u.email})</Text>
                  ))
                )}

                <Text style={[styles.modalLabel, { color: palette.text, marginTop: 10 }]}>Editors</Text>
                {(permissionsData.editors ?? []).length === 0 ? (
                  <Text style={{ color: palette.muted, marginBottom: 8 }}>No explicit editors.</Text>
                ) : (
                  (permissionsData.editors ?? []).map((u) => (
                    <Text key={`e-${u.user_id}`} style={{ color: palette.text }}>{u.full_name} ({u.email})</Text>
                  ))
                )}

                {permissionsData.can_manage ? (
                  <>
                    <Text style={[styles.modalLabel, { color: palette.text, marginTop: 12 }]}>Manage Access</Text>
                    {(permissionsData.available_users ?? []).map((u) => {
                      const readOn = readerIds.includes(u.id);
                      const editOn = editorIds.includes(u.id);
                      return (
                        <View key={`a-${u.id}`} style={[styles.userRow, { borderColor: palette.border }]}> 
                          <View style={{ flex: 1 }}>
                            <Text style={{ color: palette.text, fontWeight: "700" }}>{u.full_name}</Text>
                            <Text style={{ color: palette.muted, fontSize: 12 }}>{u.email}</Text>
                          </View>
                          <Pressable
                            style={[styles.miniBtn, { borderColor: palette.border, backgroundColor: readOn ? palette.primary : palette.panelSoft }]}
                            onPress={() => setReaderIds((prev) => (prev.includes(u.id) ? prev.filter((x) => x !== u.id) : [...prev, u.id]))}
                          >
                            <Text style={[styles.miniBtnText, { color: readOn ? "#fff" : palette.text }]}>Read</Text>
                          </Pressable>
                          <Pressable
                            style={[styles.miniBtn, { borderColor: palette.border, backgroundColor: editOn ? palette.primary : palette.panelSoft }]}
                            onPress={() => setEditorIds((prev) => (prev.includes(u.id) ? prev.filter((x) => x !== u.id) : [...prev, u.id]))}
                          >
                            <Text style={[styles.miniBtnText, { color: editOn ? "#fff" : palette.text }]}>Edit</Text>
                          </Pressable>
                        </View>
                      );
                    })}
                    <Pressable style={[styles.saveBtn, { backgroundColor: palette.primary }]} disabled={permissionsSaving} onPress={savePermissions}>
                      <Text style={styles.saveBtnText}>{permissionsSaving ? "Saving..." : "Save Permissions"}</Text>
                    </Pressable>
                  </>
                ) : (
                  <Text style={{ color: palette.muted, marginTop: 12 }}>
                    Read-only. Only the owner or an admin can change permissions.
                  </Text>
                )}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#eef3fb" },
  contentWrap: { flex: 1, padding: 12, gap: 10 },
  title: { fontSize: 24, fontWeight: "800" },
  subtitle: { marginTop: 2, marginBottom: 6, fontSize: 13 },
  syncBanner: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 8,
  },
  syncBannerText: { fontSize: 12, fontWeight: "600" },
  warningBanner: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 8,
  },
  warningBannerText: { fontSize: 12, fontWeight: "600" },
  topRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  searchInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  primaryBtn: { backgroundColor: "#1d4ed8", paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10 },
  primaryText: { color: "white", fontWeight: "600" },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: "#c8d3e6",
    backgroundColor: "#f7faff",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  secondaryText: { fontWeight: "600", color: "#26364d" },
  card: {
    borderWidth: 1,
    borderColor: "#d7e2f1",
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
  },
  cardTitle: { fontSize: 16, fontWeight: "700", marginBottom: 8, color: "#1b283b" },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  cardMetaLabel: { color: "#52647f", fontSize: 12, fontWeight: "700", textTransform: "uppercase" },
  statusPill: {
    fontSize: 11,
    fontWeight: "800",
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: 999,
    overflow: "hidden",
  },
  statusDraft: { color: "#334155", backgroundColor: "#e2e8f0" },
  statusSubmitted: { color: "#1d4ed8", backgroundColor: "#dbeafe" },
  statusApproved: { color: "#166534", backgroundColor: "#dcfce7" },
  statusRejected: { color: "#991b1b", backgroundColor: "#fee2e2" },
  cardMeta: { color: "#5c6e8d", fontSize: 12 },
  swipeActionWrap: {
    width: 184,
    marginBottom: 10,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    alignItems: "stretch",
  },
  actionBtn: {
    width: 86,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  actionText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 12,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(8,14,24,0.45)",
    justifyContent: "center",
    padding: 16,
  },
  modalCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
  },
  modalTitle: { fontSize: 18, fontWeight: "800" },
  modalSub: { marginTop: 2, marginBottom: 8 },
  modalLabel: { fontSize: 14, fontWeight: "800", marginBottom: 4 },
  userRow: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 8,
    marginBottom: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  miniBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  miniBtnText: { fontWeight: "700", fontSize: 12 },
  saveBtn: {
    marginTop: 10,
    borderRadius: 10,
    alignItems: "center",
    paddingVertical: 10,
  },
  saveBtnText: { color: "#fff", fontWeight: "700" },
});

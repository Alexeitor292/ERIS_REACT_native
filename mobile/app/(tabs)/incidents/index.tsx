import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Location from "expo-location";
import { router, usePathname } from "expo-router";

import { getToken } from "@/src/auth/tokenStore";
import { apiFetch, isSessionExpiredError } from "@/src/api/client";
import {
  createIncident,
  listIncidents,
  resolveIncident,
  assignIncident,
  unassignIncident,
  type Incident,
  type IncidentStatus,
} from "@/src/api/incidents";
import { enrichPoint } from "@/src/api/submissions";
import { useUiSettings } from "@/src/ui/UiSettingsContext";
import { queueIncidentMapPreload } from "@/src/offline/mapPreload";

type AdminUser = {
  id: number;
  email: string;
  full_name: string;
  is_active: boolean;
  roles: string[];
};

function statusBg(status: IncidentStatus) {
  if (status === "NEW") return { bg: "#450a0a", fg: "#fca5a5", bd: "#7f1d1d" };
  if (status === "IN_PROGRESS") return { bg: "#422006", fg: "#fcd34d", bd: "#854d0e" };
  return { bg: "#052e16", fg: "#86efac", bd: "#166534" };
}

export default function IncidentsTabScreen() {
  const { palette } = useUiSettings();
  const pathname = usePathname();
  const [me, setMe] = useState<{ id: number; roles: string[] } | null>(null);
  const [items, setItems] = useState<Incident[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [assignIncidentId, setAssignIncidentId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"ALL" | IncidentStatus>("ALL");

  const [title, setTitle] = useState("");
  const [incidentType, setIncidentType] = useState("");
  const [description, setDescription] = useState("");
  const [firstObservedAt, setFirstObservedAt] = useState("");
  const [firstOccurredAt, setFirstOccurredAt] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [district, setDistrict] = useState("");
  const [county, setCounty] = useState("");
  const [routeValue, setRouteValue] = useState("");
  const [postMile, setPostMile] = useState("");

  const isAdmin = !!me?.roles?.includes("ADMIN");
  const isWorker = !!me?.roles?.some((r) => r === "FIELD_WORKER" || r === "MAINTENANCE" || r === "ADMIN");
  const canResolve = !!me?.roles?.some((r) => r === "FIELD_WORKER" || r === "ADMIN");
  const isCreateRoute = pathname?.startsWith("/incidents/create") || pathname?.startsWith("/(tabs)/incidents/create");

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) {
      router.replace("/(auth)/login");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const [userRes, incidentsRes] = await Promise.all([
        apiFetch<{ id: number; roles: string[] }>("/auth/me", { token }),
        listIncidents(token, {
          status: statusFilter === "ALL" ? undefined : statusFilter,
          limit: 200,
          scope: "mobile",
        }),
      ]);
      setMe(userRes);
      setItems(incidentsRes.items ?? []);

      if (userRes.roles.includes("ADMIN")) {
        const userList = await apiFetch<{ items: AdminUser[] }>("/admin/users", { token });
        const assignables = (userList.items ?? []).filter(
          (u) => u.is_active && (u.roles.includes("FIELD_WORKER") || u.roles.includes("ADMIN"))
        );
        setUsers(assignables);
      } else {
        setUsers([]);
      }
    } catch (e: any) {
      if (isSessionExpiredError(e)) return;
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const openDraft = (linkedSubmissionId: number | null) => {
    if (!linkedSubmissionId) return;
    router.push({
      pathname: "/(tabs)/drafts/[id]",
      params: { id: String(linkedSubmissionId) },
    });
  };

  const onCreate = async () => {
    const token = await getToken();
    if (!token) return;
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!title.trim()) {
      Alert.alert("Missing Title", "Incident title is required.");
      return;
    }
    if (!firstObservedAt.trim()) {
      Alert.alert("Missing Date", "First observed date/time is required.");
      return;
    }
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      Alert.alert("Invalid Coordinates", "Latitude and longitude must be numeric.");
      return;
    }
    if (!district.trim() || !county.trim() || !routeValue.trim() || !postMile.trim()) {
      Alert.alert("Missing Location", "District, County, Route, and Post Mile are required.");
      return;
    }

    setBusy(true);
    setErr(null);
    try {
      await createIncident(token, {
        title: title.trim(),
        incident_type: incidentType.trim() || null,
        description: description.trim() || null,
        first_observed_at: firstObservedAt.trim(),
        first_occurred_at: firstOccurredAt.trim() || null,
        latitude: lat,
        longitude: lon,
        district: district.trim(),
        county: county.trim(),
        route: routeValue.trim(),
        post_mile: postMile.trim(),
      });
      setTitle("");
      setIncidentType("");
      setDescription("");
      setFirstObservedAt("");
      setFirstOccurredAt("");
      setLatitude("");
      setLongitude("");
      setDistrict("");
      setCounty("");
      setRouteValue("");
      setPostMile("");
      await load();
    } catch (e: any) {
      if (!isSessionExpiredError(e)) setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const onGpsAutofill = async () => {
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== "granted") {
        Alert.alert("Permission Needed", "Location permission is required.");
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const lat = Number(pos.coords.latitude);
      const lon = Number(pos.coords.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        Alert.alert("Location Error", "Unable to read a valid coordinate.");
        return;
      }
      setLatitude(String(lat));
      setLongitude(String(lon));

      const token = await getToken();
      if (!token) {
        return;
      }
      const geo = await enrichPoint(token, lat, lon);
      if (geo.district) setDistrict(String(geo.district).trim());
      if (geo.county) setCounty(String(geo.county).trim());
      if (geo.route) setRouteValue(String(geo.route).trim());
      if (geo.post_mile) setPostMile(String(geo.post_mile).trim());
    } catch (e: any) {
      Alert.alert("GPS Error", String(e?.message ?? e));
    }
  };

  const onResolve = async (incidentId: number) => {
    const token = await getToken();
    if (!token) return;
    setBusy(true);
    setErr(null);
    try {
      await resolveIncident(token, incidentId, null);
      await load();
    } catch (e: any) {
      if (!isSessionExpiredError(e)) setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const onAssignTo = async (userId: number) => {
    const token = await getToken();
    if (!token || !assignIncidentId) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await assignIncident(token, assignIncidentId, userId);
      const incident = items.find((x) => x.id === assignIncidentId);
      if (incident && res.linked_submission_id) {
        const preload = await queueIncidentMapPreload({
          incidentId: assignIncidentId,
          submissionId: res.linked_submission_id,
          latitude: incident.latitude,
          longitude: incident.longitude,
        });
        if (preload.status !== "READY") {
          Alert.alert(
            "Map Preload Pending",
            preload.error || "Offline map package is not ready on this device yet."
          );
        }
      }
      setAssignIncidentId(null);
      await load();
      openDraft(res.linked_submission_id ?? null);
    } catch (e: any) {
      if (!isSessionExpiredError(e)) setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const onUnassign = async (incidentId: number) => {
    const token = await getToken();
    if (!token) return;
    setBusy(true);
    setErr(null);
    try {
      await unassignIncident(token, incidentId);
      await load();
    } catch (e: any) {
      if (!isSessionExpiredError(e)) setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const statusCounts = useMemo(() => {
    return {
      NEW: items.filter((x) => x.status === "NEW").length,
      IN_PROGRESS: items.filter((x) => x.status === "IN_PROGRESS").length,
      RESOLVED: items.filter((x) => x.status === "RESOLVED").length,
    };
  }, [items]);

  if (isCreateRoute && isWorker) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: palette.bg }]}>
        <View style={styles.inner}>
          <Text style={[styles.title, { color: palette.text }]}>Create Incident</Text>
          <Text style={[styles.sub, { color: palette.muted }]}>Create an incident report and send it into workflow.</Text>

          <View style={styles.formCard} testID="incident-create-card">
            <TextInput
              style={[styles.input, { borderColor: palette.border, color: palette.text, backgroundColor: palette.panelSoft }]}
              placeholder="Title *"
              placeholderTextColor={palette.muted}
              value={title}
              onChangeText={setTitle}
            />
            <TextInput
              style={[styles.input, { borderColor: palette.border, color: palette.text, backgroundColor: palette.panelSoft }]}
              placeholder="Incident Type"
              placeholderTextColor={palette.muted}
              value={incidentType}
              onChangeText={setIncidentType}
            />
            <TextInput
              style={[styles.input, { borderColor: palette.border, color: palette.text, backgroundColor: palette.panelSoft }]}
              placeholder="Description"
              placeholderTextColor={palette.muted}
              value={description}
              onChangeText={setDescription}
            />
            <TextInput
              style={[styles.input, { borderColor: palette.border, color: palette.text, backgroundColor: palette.panelSoft }]}
              placeholder="First Observed (YYYY-MM-DDTHH:mm:ss) *"
              placeholderTextColor={palette.muted}
              value={firstObservedAt}
              onChangeText={setFirstObservedAt}
              autoCapitalize="none"
            />
            <TextInput
              style={[styles.input, { borderColor: palette.border, color: palette.text, backgroundColor: palette.panelSoft }]}
              placeholder="First Occurred (optional)"
              placeholderTextColor={palette.muted}
              value={firstOccurredAt}
              onChangeText={setFirstOccurredAt}
              autoCapitalize="none"
            />
            <View style={styles.row2}>
              <TextInput
                style={[styles.input, styles.half, { borderColor: palette.border, color: palette.text, backgroundColor: palette.panelSoft }]}
                placeholder="Latitude *"
                placeholderTextColor={palette.muted}
                value={latitude}
                onChangeText={setLatitude}
                keyboardType="numeric"
              />
              <TextInput
                style={[styles.input, styles.half, { borderColor: palette.border, color: palette.text, backgroundColor: palette.panelSoft }]}
                placeholder="Longitude *"
                placeholderTextColor={palette.muted}
                value={longitude}
                onChangeText={setLongitude}
                keyboardType="numeric"
              />
            </View>
            <View style={styles.row2}>
              <TextInput
                style={[styles.input, styles.half, { borderColor: palette.border, color: palette.text, backgroundColor: palette.panelSoft }]}
                placeholder="District *"
                placeholderTextColor={palette.muted}
                value={district}
                onChangeText={setDistrict}
              />
              <TextInput
                style={[styles.input, styles.half, { borderColor: palette.border, color: palette.text, backgroundColor: palette.panelSoft }]}
                placeholder="County *"
                placeholderTextColor={palette.muted}
                value={county}
                onChangeText={setCounty}
              />
            </View>
            <View style={styles.row2}>
              <TextInput
                style={[styles.input, styles.half, { borderColor: palette.border, color: palette.text, backgroundColor: palette.panelSoft }]}
                placeholder="Route *"
                placeholderTextColor={palette.muted}
                value={routeValue}
                onChangeText={setRouteValue}
              />
              <TextInput
                style={[styles.input, styles.half, { borderColor: palette.border, color: palette.text, backgroundColor: palette.panelSoft }]}
                placeholder="Post Mile *"
                placeholderTextColor={palette.muted}
                value={postMile}
                onChangeText={setPostMile}
              />
            </View>
            <View style={styles.row2}>
              <Pressable style={[styles.btn, { borderColor: palette.border }]} onPress={onGpsAutofill}>
                <Text style={{ color: palette.text, fontWeight: "700" }}>GPS Autofill</Text>
              </Pressable>
              <Pressable style={[styles.btn, { backgroundColor: palette.primary }]} onPress={onCreate} disabled={busy}>
                <Text style={{ color: "#fff", fontWeight: "700" }}>{busy ? "Working..." : "Create Incident"}</Text>
              </Pressable>
            </View>
          </View>
          {err ? (
            <View style={[styles.errorBox, { borderColor: "#b91c1c", backgroundColor: "#450a0a" }]}>
              <Text style={{ color: "#fecaca" }}>{err}</Text>
            </View>
          ) : null}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: palette.bg }]}>
      <View style={styles.inner}>
        <Text style={[styles.title, { color: palette.text }]}>Incidents</Text>
        <Text style={[styles.sub, { color: palette.muted }]}>Create incidents and process them through the assigned workflow.</Text>

        <View style={styles.statusRow}>
          <Pressable style={[styles.filterBtn, { borderColor: palette.border }]} onPress={() => setStatusFilter("ALL")}>
            <Text style={{ color: palette.text }}>All ({items.length})</Text>
          </Pressable>
          <Pressable style={[styles.filterBtn, { borderColor: palette.border }]} onPress={() => setStatusFilter("NEW")}>
            <Text style={{ color: palette.text }}>New ({statusCounts.NEW})</Text>
          </Pressable>
          <Pressable style={[styles.filterBtn, { borderColor: palette.border }]} onPress={() => setStatusFilter("IN_PROGRESS")}>
            <Text style={{ color: palette.text }}>In-Progress ({statusCounts.IN_PROGRESS})</Text>
          </Pressable>
          <Pressable style={[styles.filterBtn, { borderColor: palette.border }]} onPress={() => setStatusFilter("RESOLVED")}>
            <Text style={{ color: palette.text }}>Resolved ({statusCounts.RESOLVED})</Text>
          </Pressable>
          <Pressable style={[styles.filterBtn, { borderColor: palette.border }]} onPress={() => load()}>
            <Text style={{ color: palette.text }}>{busy ? "..." : "Refresh"}</Text>
          </Pressable>
        </View>

        {err ? (
          <View style={[styles.errorBox, { borderColor: "#b91c1c", backgroundColor: "#450a0a" }]}>
            <Text style={{ color: "#fecaca" }}>{err}</Text>
          </View>
        ) : null}

        <FlatList
          data={items}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={{ paddingBottom: 30 }}
          renderItem={({ item }) => {
            const status = statusBg(item.status);
            return (
              <View style={[styles.card, { borderColor: palette.border, backgroundColor: palette.panel }]}>
                <View style={styles.cardHead}>
                  <Text style={[styles.cardTitle, { color: palette.text }]}>{item.title}</Text>
                  <Text style={[styles.badge, { backgroundColor: status.bg, color: status.fg, borderColor: status.bd }]}>
                    {item.status}
                  </Text>
                </View>
                <Text style={{ color: palette.muted, fontSize: 12 }}>
                  #{item.id} | {item.latitude.toFixed(5)}, {item.longitude.toFixed(5)}
                </Text>
                <Text style={{ color: palette.muted, fontSize: 12 }}>
                  Assignee: {item.assignment?.assignee_name || item.assignment?.assignee_email || "Unassigned"}
                </Text>
                <Text style={{ color: palette.muted, fontSize: 12 }}>
                  Stage: {item.current_stage}
                </Text>
                {!!item.linked_submission_id ? (
                  <Pressable
                    style={[styles.smallBtn, { borderColor: palette.border, marginTop: 8 }]}
                    onPress={() => openDraft(item.linked_submission_id)}
                  >
                    <Text style={{ color: palette.text, fontWeight: "700" }}>
                      Open Linked Draft #{item.linked_submission_id}
                    </Text>
                  </Pressable>
                ) : null}
                <View style={[styles.actions, { marginTop: 8 }]}>
                  {isAdmin ? (
                    <>
                      <Pressable
                        style={[styles.smallBtn, { borderColor: palette.border }]}
                        onPress={() => setAssignIncidentId(item.id)}
                      >
                        <Text style={{ color: palette.text, fontWeight: "700" }}>Assign</Text>
                      </Pressable>
                      <Pressable style={[styles.smallBtn, { borderColor: palette.border }]} onPress={() => onUnassign(item.id)}>
                        <Text style={{ color: palette.text, fontWeight: "700" }}>Unassign</Text>
                      </Pressable>
                    </>
                  ) : null}
                  {canResolve && item.status !== "RESOLVED" ? (
                    <Pressable style={[styles.smallBtn, { borderColor: palette.border }]} onPress={() => onResolve(item.id)}>
                      <Text style={{ color: palette.text, fontWeight: "700" }}>Resolve</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>
            );
          }}
          ListEmptyComponent={
            <Text style={{ color: palette.muted, paddingVertical: 20 }}>{busy ? "Loading incidents..." : "No incidents yet."}</Text>
          }
        />
      </View>

      <Modal visible={assignIncidentId != null} transparent animationType="fade" onRequestClose={() => setAssignIncidentId(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setAssignIncidentId(null)}>
          <Pressable style={[styles.modalCard, { backgroundColor: palette.panel, borderColor: palette.border }]}>
            <Text style={[styles.modalTitle, { color: palette.text }]}>Assign Incident</Text>
            <Text style={{ color: palette.muted, marginBottom: 10 }}>Select an assignee</Text>
            <FlatList
              data={users}
              keyExtractor={(item) => String(item.id)}
              renderItem={({ item }) => (
                <Pressable
                  style={[styles.userRow, { borderColor: palette.border }]}
                  onPress={() => onAssignTo(item.id)}
                >
                  <Text style={{ color: palette.text, fontWeight: "700" }}>{item.full_name}</Text>
                  <Text style={{ color: palette.muted, fontSize: 12 }}>{item.email}</Text>
                </Pressable>
              )}
              ListEmptyComponent={
                <Text style={{ color: palette.muted, paddingVertical: 14 }}>No assignable users.</Text>
              }
              style={{ maxHeight: 280 }}
            />
            <Pressable style={[styles.btn, { borderColor: palette.border, marginTop: 8 }]} onPress={() => setAssignIncidentId(null)}>
              <Text style={{ color: palette.text, fontWeight: "700" }}>Close</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  inner: { flex: 1, padding: 12 },
  title: { fontSize: 26, fontWeight: "800" },
  sub: { marginTop: 2, marginBottom: 10, fontSize: 13 },
  statusRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 },
  filterBtn: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  formCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    marginBottom: 10,
  },
  formTitle: { fontSize: 14, fontWeight: "800", marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    marginBottom: 8,
  },
  row2: { flexDirection: "row", gap: 8 },
  half: { flex: 1 },
  btn: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
  },
  errorBox: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 10,
  },
  card: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    marginBottom: 8,
  },
  cardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  cardTitle: { fontSize: 16, fontWeight: "700", flexShrink: 1 },
  badge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    fontSize: 11,
    fontWeight: "800",
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  smallBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    padding: 16,
  },
  modalCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
  },
  modalTitle: { fontSize: 18, fontWeight: "800" },
  userRow: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
  },
});

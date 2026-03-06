import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Location from "expo-location";
import { router, useLocalSearchParams, usePathname } from "expo-router";

import { getToken } from "@/src/auth/tokenStore";
import { apiFetch, isSessionExpiredError } from "@/src/api/client";
import {
  createIncident,
  updateIncident,
  listIncidents,
  resolveIncident,
  assignIncident,
  unassignIncident,
  type Incident,
  type IncidentStatus,
} from "@/src/api/incidents";
import { enrichPointFromArcgisClient } from "@/src/utils/arcgisEnrichment";
import { useUiSettings } from "@/src/ui/UiSettingsContext";
import { queueIncidentMapPreload } from "@/src/offline/mapPreload";
import {
  CALTRANS_COUNTIES,
  countyCodeFromNameOrCode,
  districtForCounty,
  routesForCounty,
} from "@/src/utils/caltransLookups";

type AdminUser = {
  id: number;
  email: string;
  full_name: string;
  is_active: boolean;
  roles: string[];
};

function SelectField({
  label,
  value,
  placeholder,
  editable,
  onPress,
  palette,
  error,
}: {
  label: string;
  value: string;
  placeholder: string;
  editable: boolean;
  onPress: () => void;
  palette?: { muted: string; border: string; panelSoft: string; text: string };
  error?: string;
}) {
  const textValue = value.trim() || placeholder;
  return (
    <View style={{ marginTop: 8 }}>
      <Text style={[styles.labelText, { color: error ? "#dc2626" : (palette?.muted ?? "#465978") }]}>{label}</Text>
      <Pressable
        disabled={!editable}
        onPress={onPress}
        style={[
          styles.input,
          {
            borderColor: error ? "#ef4444" : (palette?.border ?? "#ccd8ea"),
            backgroundColor: palette?.panelSoft ?? "#f7f8fc",
            opacity: editable ? 1 : 0.7,
            justifyContent: "center",
          },
        ]}
      >
        <Text style={{ color: value.trim() ? (palette?.text ?? "#1b2a40") : (palette?.muted ?? "#6b7280") }}>
          {textValue}
        </Text>
      </Pressable>
    </View>
  );
}

function FormField({
  label,
  value,
  onChangeText,
  onFocus,
  editable,
  multiline,
  keyboardType,
  placeholder,
  palette,
}: {
  label: string;
  value: string;
  onChangeText?: (v: string) => void;
  onFocus?: () => void;
  editable: boolean;
  multiline?: boolean;
  keyboardType?: "default" | "numeric" | "decimal-pad" | "number-pad";
  placeholder?: string;
  palette?: { text: string; muted: string; border: string; panelSoft: string };
}) {
  return (
    <View style={{ marginTop: 8 }}>
      <Text style={{ color: palette?.muted ?? "#465978", fontSize: 13, fontWeight: "700", marginBottom: 4 }}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onFocus={onFocus}
        editable={editable}
        multiline={multiline}
        keyboardType={keyboardType ?? "default"}
        placeholder={placeholder}
        placeholderTextColor={palette?.muted ?? "#6b7280"}
        style={[
          styles.input,
          { borderColor: palette?.border ?? "#ccd8ea", backgroundColor: palette?.panelSoft ?? "#f7f8fc", color: palette?.text ?? "#1b2a40" },
          multiline ? styles.inputMultiline : null,
        ]}
      />
    </View>
  );
}

const DISTRICT_OPTIONS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));

function normalizeRoute(input: string): string {
  const digits = (input || "").trim().replace(/\D/g, "");
  if (!digits) return "";
  return digits.slice(0, 3).padStart(3, "0");
}

function statusBg(status: IncidentStatus) {
  if (status === "NEW") return { bg: "#450a0a", fg: "#fca5a5", bd: "#7f1d1d" };
  if (status === "IN_PROGRESS") return { bg: "#422006", fg: "#fcd34d", bd: "#854d0e" };
  return { bg: "#052e16", fg: "#86efac", bd: "#166534" };
}

export default function IncidentsTabScreen() {
  const { palette } = useUiSettings();
  const pathname = usePathname();
  const params = useLocalSearchParams<{ incident_id?: string }>();
  const [me, setMe] = useState<{ id: number; roles: string[] } | null>(null);
  const [items, setItems] = useState<Incident[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [assignIncidentId, setAssignIncidentId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"ALL" | IncidentStatus>("ALL");

  const [description, setDescription] = useState("");
  const [firstObservedAt, setFirstObservedAt] = useState("");
  const [firstOccurredAt, setFirstOccurredAt] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [district, setDistrict] = useState("");
  const [county, setCounty] = useState("");
  const [routeValue, setRouteValue] = useState("");
  const [postMile, setPostMile] = useState("");
  const [editingIncidentId, setEditingIncidentId] = useState<number | null>(null);
  const [editingLocked, setEditingLocked] = useState(false);
  const [datePickerKey, setDatePickerKey] = useState<"firstObservedAt" | "firstOccurredAt" | null>(null);
  const [calendarYear, setCalendarYear] = useState(() => new Date().getFullYear());
  const [calendarMonth, setCalendarMonth] = useState(() => new Date().getMonth());
  const [districtPickerOpen, setDistrictPickerOpen] = useState(false);
  const [countyPickerOpen, setCountyPickerOpen] = useState(false);
  const [routePickerOpen, setRoutePickerOpen] = useState(false);
  const createScrollRef = useRef<ScrollView | null>(null);
  const createFieldY = useRef<Record<string, number>>({});

  const countyRouteOptions = useMemo(() => routesForCounty(county), [county]);
  const countyRouteOptionsNormalized = useMemo(() => {
    const normalized = countyRouteOptions.map(normalizeRoute).filter(Boolean);
    return Array.from(new Set(normalized));
  }, [countyRouteOptions]);
  const countiesForDistrict = useMemo(
    () => (district ? CALTRANS_COUNTIES.filter((c) => c.district === district) : CALTRANS_COUNTIES),
    [district]
  );
  const countyLabelValue = useMemo(() => countyCodeFromNameOrCode(county) ?? "", [county]);
  const calendarDays = useMemo(() => {
    const firstDay = new Date(calendarYear, calendarMonth, 1).getDay();
    const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
    const cells: Array<number | null> = Array(firstDay).fill(null);
    for (let day = 1; day <= daysInMonth; day += 1) cells.push(day);
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [calendarMonth, calendarYear]);

  const isAdmin = !!me?.roles?.includes("ADMIN");
  const isWorker = !!me?.roles?.some((r) => r === "FIELD_WORKER" || r === "MAINTENANCE" || r === "ADMIN");
  const canResolve = !!me?.roles?.some((r) => r === "FIELD_WORKER" || r === "ADMIN");
  const isMaintenanceWorkerMobile =
    !!me?.roles?.some((r) => r === "FIELD_WORKER" || r === "MAINTENANCE") &&
    !me?.roles?.some((r) => r === "MAINT_COORDINATOR" || r === "OFFICE_CHIEF" || r === "BRANCH_CHIEF" || r === "ADMIN");
  const canEditIncidentInForm = editingIncidentId == null || !editingLocked;
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

  const openIncidentFromTracking = (incident: Incident) => {
    const incidentId = String(incident.id);
    router.push({ pathname: "/(tabs)/incidents/create", params: { incident_id: incidentId } });
  };

  const hydrateEditingIncident = (incident: Incident) => {
    const needsRevision = String(incident.location_match_status || "").toUpperCase() === "NEEDS_REVISION";
    setEditingIncidentId(incident.id);
    setEditingLocked(!needsRevision);
    setDescription(incident.description || "");
    setFirstObservedAt((incident.first_observed_at || "").slice(0, 10));
    setFirstOccurredAt((incident.first_occurred_at || "").slice(0, 10));
    setLatitude(Number.isFinite(incident.latitude) ? String(incident.latitude) : "");
    setLongitude(Number.isFinite(incident.longitude) ? String(incident.longitude) : "");
    setDistrict((incident.district || "").trim());
    setCounty((incident.county || "").trim());
    setRouteValue(normalizeRoute(incident.route || ""));
    setPostMile((incident.post_mile || "").trim());
  };

  useEffect(() => {
    if (!isCreateRoute) return;
    const incidentIdRaw = typeof params.incident_id === "string" ? params.incident_id : "";
    const incidentId = Number(incidentIdRaw);
    if (!incidentIdRaw || Number.isNaN(incidentId) || incidentId <= 0) return;
    const incident = items.find((x) => x.id === incidentId);
    if (!incident) return;
    if (editingIncidentId === incident.id) return;
    hydrateEditingIncident(incident);
  }, [editingIncidentId, isCreateRoute, items, params.incident_id]);

  const registerCreateField = (key: string, y: number) => {
    createFieldY.current[key] = y;
  };

  const scrollToCreateField = (key: string) => {
    const y = createFieldY.current[key];
    if (typeof y !== "number") return;
    setTimeout(() => {
      createScrollRef.current?.scrollTo({ y: Math.max(0, y - 20), animated: true });
    }, 120);
  };

  const toYmd = (date: Date): string => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  };

  const monthLabel = (year: number, month: number): string =>
    new Date(year, month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const parseYmd = (value: string): Date | null => {
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const y = Number(m[1]);
    const mm = Number(m[2]) - 1;
    const d = Number(m[3]);
    const dt = new Date(y, mm, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mm || dt.getDate() !== d) return null;
    return dt;
  };

  const openIncidentDatePicker = (key: "firstObservedAt" | "firstOccurredAt") => {
    const currentValue = key === "firstObservedAt" ? firstObservedAt : firstOccurredAt;
    const parsed = parseYmd(currentValue);
    const ref = parsed ?? new Date();
    setCalendarYear(ref.getFullYear());
    setCalendarMonth(ref.getMonth());
    setDatePickerKey(key);
  };

  const selectIncidentDate = (day: number) => {
    if (!datePickerKey) return;
    const nextDate = new Date(calendarYear, calendarMonth, day);
    const ymd = toYmd(nextDate);
    if (datePickerKey === "firstObservedAt") {
      setFirstObservedAt(ymd);
    } else {
      setFirstOccurredAt(ymd);
    }
    setDatePickerKey(null);
  };

  const resetCreateForm = () => {
    setDescription("");
    setFirstObservedAt("");
    setFirstOccurredAt("");
    setLatitude("");
    setLongitude("");
    setDistrict("");
    setCounty("");
    setRouteValue("");
    setPostMile("");
    setEditingIncidentId(null);
    setEditingLocked(false);
  };

  const onConfirmClearForm = () => {
    Alert.alert(
      "Clear Incident Form?",
      "This will remove all current form values.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear Incident",
          style: "destructive",
          onPress: resetCreateForm,
        },
      ]
    );
  };

  const onCreate = async () => {
    const token = await getToken();
    if (!token) return;
    if (!canEditIncidentInForm) {
      router.replace("/(tabs)/incidents/track");
      return;
    }
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!firstObservedAt.trim()) {
      Alert.alert("Missing Date", "First observed date is required.");
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
      const payload = {
        description: description.trim() || null,
        first_observed_at: firstObservedAt.trim(),
        first_occurred_at: firstOccurredAt.trim() || null,
        latitude: lat,
        longitude: lon,
        district: district.trim(),
        county: county.trim(),
        route: routeValue.trim(),
        post_mile: postMile.trim(),
      };
      if (editingIncidentId) {
        await updateIncident(token, editingIncidentId, payload);
      } else {
        await createIncident(token, payload);
      }
      resetCreateForm();
      router.replace("/(tabs)/incidents/track");
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

      const geo = await enrichPointFromArcgisClient(lat, lon);
      const districtValue = geo.district ? String(geo.district).trim() : "";
      if (districtValue) {
        setDistrict(districtValue.padStart(2, "0"));
      }

      const countyCode = countyCodeFromNameOrCode(geo.county ?? "");
      if (countyCode) {
        setCounty(countyCode);
      }

      if (!districtValue && countyCode) {
        const districtFallback = districtForCounty(countyCode);
        if (districtFallback) {
          setDistrict(districtFallback);
        }
      }

      const route = geo.route?.trim() || "";
      const routeAllowed = countyCode ? routesForCounty(countyCode) : [];
      const allowedRouteValues = routeAllowed.map(normalizeRoute).filter(Boolean);
      const normalizedRoute = route && (routeAllowed.length === 0 || allowedRouteValues.includes(normalizeRoute(route))) ? normalizeRoute(route) : "";
      if (normalizedRoute) {
        setRouteValue(normalizedRoute);
      }

      if (geo.post_mile?.trim()) {
        setPostMile(String(geo.post_mile).trim());
      }
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

  const workerTrackingItems = useMemo(() => {
    if (!isMaintenanceWorkerMobile) return items;
    return items.filter((x) => String(x.current_stage || "").toUpperCase() === "COORDINATOR_REVIEW");
  }, [isMaintenanceWorkerMobile, items]);

  const workerReviewCounts = useMemo(() => {
    const needsRevision = workerTrackingItems.filter(
      (x) => String(x.location_match_status || "").toUpperCase() === "NEEDS_REVISION"
    ).length;
    const underReview = workerTrackingItems.length - needsRevision;
    return { underReview, needsRevision };
  }, [workerTrackingItems]);

  if (isCreateRoute && isWorker) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: palette.bg }]}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
          <ScrollView
            ref={createScrollRef}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
            contentContainerStyle={styles.createScrollContent}
          >
            <View style={styles.innerCreate}>
              <Text style={[styles.title, { color: palette.text }]}>
                {editingIncidentId ? (canEditIncidentInForm ? "Edit Incident" : "Incident Details") : "Create Incident"}
              </Text>
              <Text style={[styles.sub, { color: palette.muted }]}>
                {editingIncidentId
                  ? (canEditIncidentInForm
                    ? "Requested updates by the maintenance coordinator. Edit and resubmit."
                    : "Under review by the maintenance coordinator.")
                  : "Create an incident report and send it into workflow."}
              </Text>

              <View style={styles.formCard} testID="incident-create-card">
                <View style={styles.row2}>
                  <View style={styles.half}>
                    <SelectField
                      label="District *"
                      value={district}
                      placeholder="Select district"
                      editable={canEditIncidentInForm}
                      onPress={() => setDistrictPickerOpen(true)}
                      palette={palette}
                    />
                  </View>
                  <View style={styles.half}>
                    <SelectField
                      label="County *"
                      value={countyLabelValue}
                      placeholder={district ? "Select county" : "Select district first"}
                      editable={canEditIncidentInForm && !!district}
                      onPress={() => setCountyPickerOpen(true)}
                      palette={palette}
                    />
                  </View>
                </View>
                <View style={styles.row2}>
                  <View style={styles.half}>
                    <SelectField
                      label="Route *"
                      value={routeValue}
                      placeholder={county ? "Select route" : "Select county first"}
                      editable={canEditIncidentInForm && !!county}
                      onPress={() => setRoutePickerOpen(true)}
                      palette={palette}
                    />
                  </View>
                  <View style={styles.half}>
                    <View onLayout={(e) => registerCreateField("postMile", e.nativeEvent.layout.y)}>
                      <FormField
                        label="Post Mile *"
                        value={postMile}
                        onChangeText={setPostMile}
                        onFocus={() => scrollToCreateField("postMile")}
                        editable={canEditIncidentInForm}
                        placeholder="Post Mile *"
                        palette={palette}
                      />
                    </View>
                  </View>
                </View>
                <View style={[styles.row2, styles.coordinatesRow]}>
                  <View style={styles.half}>
                    <View onLayout={(e) => registerCreateField("latitude", e.nativeEvent.layout.y)}>
                      <FormField
                        label="Latitude *"
                        value={latitude}
                        onChangeText={setLatitude}
                        onFocus={() => scrollToCreateField("latitude")}
                        editable={canEditIncidentInForm}
                        keyboardType="numeric"
                        placeholder="Latitude *"
                        palette={palette}
                      />
                    </View>
                  </View>
                  <View style={styles.half}>
                    <View onLayout={(e) => registerCreateField("longitude", e.nativeEvent.layout.y)}>
                      <FormField
                        label="Longitude *"
                        value={longitude}
                        onChangeText={setLongitude}
                        onFocus={() => scrollToCreateField("longitude")}
                        editable={canEditIncidentInForm}
                        keyboardType="numeric"
                        placeholder="Longitude *"
                        palette={palette}
                      />
                    </View>
                  </View>
                </View>
                <SelectField
                  label="First Observed (YYYY-MM-DD) *"
                  value={firstObservedAt}
                  placeholder="Select date"
                  editable={canEditIncidentInForm}
                  onPress={() => openIncidentDatePicker("firstObservedAt")}
                  palette={palette}
                />
                <SelectField
                  label="First Occurred (YYYY-MM-DD, optional)"
                  value={firstOccurredAt}
                  placeholder="Select date"
                  editable={canEditIncidentInForm}
                  onPress={() => openIncidentDatePicker("firstOccurredAt")}
                  palette={palette}
                />
                <View onLayout={(e) => registerCreateField("description", e.nativeEvent.layout.y)}>
                  <FormField
                    label="Description"
                    value={description}
                    onChangeText={setDescription}
                    onFocus={() => scrollToCreateField("description")}
                    editable={canEditIncidentInForm}
                    multiline
                    placeholder="Description"
                    palette={palette}
                  />
                </View>
                <View style={[styles.row2, styles.actionsRow]}>
                  <Pressable style={[styles.btn, { borderColor: palette.border }]} onPress={onGpsAutofill} disabled={!canEditIncidentInForm}>
                    <Text style={{ color: palette.text, fontWeight: "700" }}>GPS Autofill</Text>
                  </Pressable>
                  <Pressable style={[styles.btn, { borderColor: palette.border, backgroundColor: palette.panelSoft }]} onPress={onConfirmClearForm} disabled={busy || !canEditIncidentInForm}>
                    <Text style={{ color: palette.danger, fontWeight: "700" }}>Clear Incident</Text>
                  </Pressable>
                  <Pressable style={[styles.btn, { backgroundColor: palette.primary }]} onPress={onCreate} disabled={busy}>
                    <Text style={{ color: "#fff", fontWeight: "700" }}>
                      {busy ? "Working..." : (editingIncidentId ? (canEditIncidentInForm ? "Resubmit Incident" : "Back to Tracking") : "Create Incident")}
                    </Text>
                  </Pressable>
                </View>
              </View>
              {err ? (
                <View style={[styles.errorBox, { borderColor: "#b91c1c", backgroundColor: "#450a0a" }]}>
                  <Text style={{ color: "#fecaca" }}>{err}</Text>
                </View>
              ) : null}
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
          <Modal visible={districtPickerOpen} transparent animationType="fade" onRequestClose={() => setDistrictPickerOpen(false)}>
            <Pressable style={styles.pickerBackdrop} onPress={() => setDistrictPickerOpen(false)}>
              <Pressable style={[styles.pickerSheet, { backgroundColor: palette.panel, borderColor: palette.border }]}>
                <Text style={[styles.pickerTitle, { color: palette.text }]}>Select District</Text>
                <ScrollView style={{ maxHeight: 340 }}>
                  {DISTRICT_OPTIONS.map((d) => (
                    <Pressable
                      key={d}
                      style={[styles.pickerItem, district === d ? { backgroundColor: palette.panelSoft } : null]}
                      onPress={() => {
                        const countyMatch = county ? CALTRANS_COUNTIES.find((c) => c.code === county) : null;
                        const countyStillValid = !!countyMatch && countyMatch.district === d;
                        const nextCounty = countyStillValid ? county : "";
                        const nextRoute =
                          countyStillValid && routeValue && countyMatch?.routes.some((route) => normalizeRoute(route) === routeValue)
                            ? routeValue
                            : "";
                        setDistrict(d);
                        setCounty(nextCounty);
                        setRouteValue(normalizeRoute(nextRoute));
                        setDistrictPickerOpen(false);
                      }}
                    >
                      <Text style={{ color: palette.text, fontWeight: "600" }}>{d}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </Pressable>
            </Pressable>
          </Modal>
          <Modal visible={countyPickerOpen} transparent animationType="fade" onRequestClose={() => setCountyPickerOpen(false)}>
            <Pressable style={styles.pickerBackdrop} onPress={() => setCountyPickerOpen(false)}>
              <Pressable style={[styles.pickerSheet, { backgroundColor: palette.panel, borderColor: palette.border }]}>
                <Text style={[styles.pickerTitle, { color: palette.text }]}>Select County</Text>
                {district ? (
                  <Text style={{ color: palette.muted, marginBottom: 6 }}>{`Showing counties in District ${district}`}</Text>
                ) : null}
                <ScrollView style={{ maxHeight: 340 }}>
                  {countiesForDistrict.map((c) => (
                    <Pressable
                      key={c.code}
                      style={[styles.pickerItem, county === c.code ? { backgroundColor: palette.panelSoft } : null]}
                      onPress={() => {
                        setCounty(c.code);
                        setDistrict(c.district);
                        if (routeValue && !c.routes.some((route) => normalizeRoute(route) === routeValue)) {
                          setRouteValue("");
                        }
                        setCountyPickerOpen(false);
                      }}
                    >
                      <Text style={{ color: palette.text, fontWeight: "600" }}>{`${c.name} (${c.code})`}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </Pressable>
            </Pressable>
          </Modal>
          <Modal visible={routePickerOpen} transparent animationType="fade" onRequestClose={() => setRoutePickerOpen(false)}>
            <Pressable style={styles.pickerBackdrop} onPress={() => setRoutePickerOpen(false)}>
              <Pressable style={[styles.pickerSheet, { backgroundColor: palette.panel, borderColor: palette.border }]}>
                <Text style={[styles.pickerTitle, { color: palette.text }]}>Select Route</Text>
                {!county ? <Text style={{ color: palette.muted }}>Select county first.</Text> : null}
                <ScrollView style={{ maxHeight: 340 }}>
                  {countyRouteOptionsNormalized.map((r) => (
                    <Pressable
                      key={r}
                      style={[styles.pickerItem, routeValue === r ? { backgroundColor: palette.panelSoft } : null]}
                      onPress={() => {
                        setRouteValue(r);
                        setRoutePickerOpen(false);
                      }}
                    >
                      <Text style={{ color: palette.text, fontWeight: "600" }}>{r}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </Pressable>
            </Pressable>
          </Modal>
          <Modal visible={datePickerKey != null} transparent animationType="fade" onRequestClose={() => setDatePickerKey(null)}>
            <Pressable style={styles.pickerBackdrop} onPress={() => setDatePickerKey(null)}>
              <Pressable style={[styles.pickerSheet, { backgroundColor: palette.panel, borderColor: palette.border }]}>
                <View style={styles.calendarHeaderRow}>
                  <Pressable
                    onPress={() => {
                      if (calendarMonth === 0) {
                        setCalendarMonth(11);
                        setCalendarYear((y) => y - 1);
                      } else {
                        setCalendarMonth((m) => m - 1);
                      }
                    }}
                  >
                    <Text style={[styles.calendarNav, { color: palette.text }]}>{"<"}</Text>
                  </Pressable>
                  <Text style={[styles.pickerTitle, { color: palette.text }]}>{monthLabel(calendarYear, calendarMonth)}</Text>
                  <Pressable
                    onPress={() => {
                      if (calendarMonth === 11) {
                        setCalendarMonth(0);
                        setCalendarYear((y) => y + 1);
                      } else {
                        setCalendarMonth((m) => m + 1);
                      }
                    }}
                  >
                    <Text style={[styles.calendarNav, { color: palette.text }]}>{">"}</Text>
                  </Pressable>
                </View>
                <View style={styles.calendarWeekRow}>
                  {["S", "M", "T", "W", "T", "F", "S"].map((w, idx) => (
                    <Text key={`${w}-${idx}`} style={[styles.calendarWeekLabel, { color: palette.muted }]}>{w}</Text>
                  ))}
                </View>
                <View style={styles.calendarGrid}>
                  {calendarDays.map((day, idx) => (
                    <Pressable
                      key={`${day ?? "x"}-${idx}`}
                      disabled={!day}
                      onPress={() => day && selectIncidentDate(day)}
                      style={[styles.calendarCell, !day ? { opacity: 0 } : null]}
                    >
                      <Text style={{ color: palette.text }}>{day ?? ""}</Text>
                    </Pressable>
                  ))}
                </View>
                <View style={styles.calendarActions}>
                  <Pressable
                    onPress={() => {
                      if (datePickerKey === "firstObservedAt") setFirstObservedAt("");
                      if (datePickerKey === "firstOccurredAt") setFirstOccurredAt("");
                      setDatePickerKey(null);
                    }}
                    style={[styles.calendarActionBtn, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}
                  >
                    <Text style={{ color: palette.text, fontWeight: "700" }}>Clear</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      const next = toYmd(new Date());
                      if (datePickerKey === "firstObservedAt") setFirstObservedAt(next);
                      if (datePickerKey === "firstOccurredAt") setFirstOccurredAt(next);
                      setDatePickerKey(null);
                    }}
                    style={[styles.calendarActionBtn, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}
                  >
                    <Text style={{ color: palette.text, fontWeight: "700" }}>Today</Text>
                  </Pressable>
                </View>
              </Pressable>
            </Pressable>
          </Modal>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: palette.bg }]}>
      <View style={styles.inner}>
        <Text style={[styles.title, { color: palette.text }]}>Incidents</Text>
        <Text style={[styles.sub, { color: palette.muted }]}>Create incidents and process them through the assigned workflow.</Text>

        <View style={styles.statusRow}>
          {isMaintenanceWorkerMobile ? (
            <>
              <View style={[styles.filterBtn, { borderColor: palette.border }]}>
                <Text style={{ color: palette.text }}>Under Review ({workerReviewCounts.underReview})</Text>
              </View>
              <View style={[styles.filterBtn, { borderColor: palette.border }]}>
                <Text style={{ color: palette.text }}>Needs Revision ({workerReviewCounts.needsRevision})</Text>
              </View>
              <Pressable style={[styles.filterBtn, { borderColor: palette.border }]} onPress={() => load()}>
                <Text style={{ color: palette.text }}>{busy ? "..." : "Refresh"}</Text>
              </Pressable>
            </>
          ) : (
            <>
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
            </>
          )}
        </View>

        {err ? (
          <View style={[styles.errorBox, { borderColor: "#b91c1c", backgroundColor: "#450a0a" }]}>
            <Text style={{ color: "#fecaca" }}>{err}</Text>
          </View>
        ) : null}

        <FlatList
          data={workerTrackingItems}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={{ paddingBottom: 30 }}
          renderItem={({ item }) => {
            const needsRevision = String(item.location_match_status || "").toUpperCase() === "NEEDS_REVISION";
            const workerBadge = needsRevision
              ? { bg: "#450a0a", fg: "#fecaca", bd: "#b91c1c", label: "Needs Revision" }
              : { bg: "#422006", fg: "#fde68a", bd: "#a16207", label: "Under Review" };
            const status = statusBg(item.status);
            const incidentTitle =
              item.title?.trim() || `Incident ${item.district ?? "Unknown district"} / ${item.route ?? "Unknown route"} / PM ${item.post_mile ?? "?"}`;
            return (
              <Pressable
                style={[styles.card, { borderColor: palette.border, backgroundColor: palette.panel }]}
                onPress={isMaintenanceWorkerMobile ? () => openIncidentFromTracking(item) : undefined}
                disabled={!isMaintenanceWorkerMobile}
              >
                <View style={styles.cardHead}>
                  <Text style={[styles.cardTitle, { color: palette.text }]}>{incidentTitle}</Text>
                  {isMaintenanceWorkerMobile ? (
                    <Text style={[styles.badge, { backgroundColor: workerBadge.bg, color: workerBadge.fg, borderColor: workerBadge.bd }]}>
                      {workerBadge.label}
                    </Text>
                  ) : (
                    <Text style={[styles.badge, { backgroundColor: status.bg, color: status.fg, borderColor: status.bd }]}>
                      {item.status}
                    </Text>
                  )}
                </View>
                <Text style={{ color: palette.muted, fontSize: 12 }}>
                  #{item.id} | {item.latitude.toFixed(5)}, {item.longitude.toFixed(5)}
                </Text>
                <Text style={{ color: palette.muted, fontSize: 12 }}>
                  Assignee: {item.assignment?.assignee_name || item.assignment?.assignee_email || "Unassigned"}
                </Text>
                <Text style={{ color: palette.muted, fontSize: 12 }}>
                  Stage: {isMaintenanceWorkerMobile ? workerBadge.label : item.current_stage}
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
                  {canResolve && !isMaintenanceWorkerMobile && item.status !== "RESOLVED" ? (
                    <Pressable style={[styles.smallBtn, { borderColor: palette.border }]} onPress={() => onResolve(item.id)}>
                      <Text style={{ color: palette.text, fontWeight: "700" }}>Resolve</Text>
                    </Pressable>
                  ) : null}
                </View>
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <Text style={{ color: palette.muted, paddingVertical: 20 }}>
              {busy ? "Loading incidents..." : (isMaintenanceWorkerMobile ? "No incidents pending coordinator review." : "No incidents yet.")}
            </Text>
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
  innerCreate: { padding: 12 },
  createScrollContent: { paddingBottom: 18 },
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
    height: 44,
    lineHeight: 20,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 0,
    marginBottom: 8,
  },
  inputMultiline: {
    height: 90,
    lineHeight: 20,
    paddingTop: 10,
    paddingBottom: 10,
    textAlignVertical: "top",
  },
  descriptionArea: {
    minHeight: 120,
    paddingTop: 10,
    paddingBottom: 10,
  },
  labelText: { color: "#465978", fontSize: 13, fontWeight: "700", marginBottom: 4 },
  row2: { flexDirection: "row", gap: 8 },
  coordinatesRow: { marginTop: 2 },
  actionsRow: { marginTop: 4 },
  half: { flex: 1 },
  pickerBackdrop: {
    flex: 1,
    backgroundColor: "rgba(8,14,24,0.45)",
    justifyContent: "center",
    padding: 16,
  },
  pickerSheet: {
    width: "100%",
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    maxWidth: 520,
    alignSelf: "center",
  },
  pickerTitle: {
    fontSize: 16,
    fontWeight: "800",
    marginBottom: 8,
  },
  pickerItem: {
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  btn: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
  },
  calendarHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  calendarNav: {
    fontSize: 18,
    fontWeight: "800",
    width: 32,
    textAlign: "center",
  },
  calendarWeekRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    marginBottom: 4,
  },
  calendarWeekLabel: {
    width: "14.28%",
    textAlign: "center",
    fontWeight: "700",
    fontSize: 12,
  },
  calendarGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: 2,
  },
  calendarCell: {
    width: "14.28%",
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  calendarActions: {
    flexDirection: "row",
    gap: 8,
    marginTop: 10,
    justifyContent: "flex-end",
  },
  calendarActionBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignItems: "center",
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

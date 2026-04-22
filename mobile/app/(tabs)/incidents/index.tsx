import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Location from "expo-location";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { router, useLocalSearchParams, usePathname } from "expo-router";

import { getToken } from "@/src/auth/tokenStore";
import { apiFetch, isSessionExpiredError } from "@/src/api/client";
import {
  assignIncidentToBranchChief,
  createIncident,
  getOfficeChiefBranchOptions,
  updateIncident,
  listIncidents,
  resolveIncident,
  assignIncident,
  unassignIncident,
  uploadIncidentAttachment,
  forwardIncidentByCoordinator,
  getIncidentLocationCandidates,
  getIncidentLocationTimeline,
  linkIncidentLocation,
  requestIncidentRevisionByCoordinator,
  type Incident,
  type IncidentAttachmentKind,
  type IncidentLocationCandidate,
  type IncidentLocationTimeline,
  type IncidentStatus,
  type RoutingUserOption,
} from "@/src/api/incidents";
import { enrichPointFromArcgisClient } from "@/src/utils/arcgisEnrichment";
import { useUiSettings } from "@/src/ui/UiSettingsContext";
import { queueIncidentMapPreload } from "@/src/offline/mapPreload";
import { formatCoordinate, normalizeCoordinateValue, normalizePostMileInput, normalizePostMileValue } from "@/src/utils/precision";
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

type PendingIncidentUpload = {
  uri: string;
  name: string;
  type: string;
  kind: IncidentAttachmentKind;
  size?: number | null;
};

const isIosPhotosAccessError = (msg: string) =>
  /PHPhotosErrorDomain|error 3164/i.test(msg);

function inferIncidentAttachmentKind(name: string, mimeType: string): IncidentAttachmentKind {
  const mime = (mimeType || "").toLowerCase();
  if (mime === "image/png" && /sketch/i.test(name)) return "SKETCH";
  if (mime.startsWith("image/")) return "PHOTO";
  if (mime.startsWith("video/")) return "VIDEO";
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "png" && /sketch/i.test(name)) return "SKETCH";
  if (["jpg", "jpeg", "png", "heic", "heif", "gif", "webp"].includes(ext)) return "PHOTO";
  if (["mp4", "mov", "m4v", "avi", "mkv", "webm"].includes(ext)) return "VIDEO";
  return "DOC";
}

function guessMimeType(name: string, fallback?: string | null): string {
  if (fallback) return fallback;
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "heic") return "image/heic";
  if (ext === "heif") return "image/heif";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "mp4") return "video/mp4";
  if (ext === "mov") return "video/quicktime";
  if (ext === "pdf") return "application/pdf";
  return "application/octet-stream";
}

function formatFileSize(bytes?: number | null): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
  onBlur,
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
  onBlur?: () => void;
}) {
  return (
    <View style={{ marginTop: 8 }}>
      <Text style={{ color: palette?.muted ?? "#465978", fontSize: 13, fontWeight: "700", marginBottom: 4 }}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onFocus={onFocus}
        onBlur={onBlur}
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
const REVISION_FIELDS = [
  "district",
  "county",
  "route",
  "post_mile",
  "latitude",
  "longitude",
  "first_observed_at",
  "first_occurred_at",
  "description",
] as const;

function extractRevisionFields(metadata: unknown): string[] | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as { revision_fields?: unknown }).revision_fields;
  if (!Array.isArray(raw)) return null;
  const allowed = new Set<string>(REVISION_FIELDS as unknown as string[]);
  const fields = raw
    .map((x) => String(x || "").trim().toLowerCase())
    .filter((x) => !!x && allowed.has(x));
  return Array.from(new Set(fields));
}

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

function formatTimestamp(value?: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function formatPostMileLabel(value?: string | null, fallback = "-"): string {
  return normalizePostMileInput(value) || fallback;
}

function formatLocationLine(location: {
  district?: string | null;
  county?: string | null;
  route?: string | null;
  post_mile?: string | null;
}): string {
  return `${location.district || "-"} / ${location.county || "-"} / ${location.route || "-"} / PM ${formatPostMileLabel(location.post_mile)}`;
}

function formatLocationDisplayName(
  location: {
    display_name?: string | null;
    district?: string | null;
    county?: string | null;
    route?: string | null;
    post_mile?: string | null;
  },
  fallback: string
): string {
  if (location.district || location.county || location.route || location.post_mile) {
    return formatLocationLine(location);
  }
  const displayName = location.display_name?.trim();
  if (!displayName) return fallback;
  return displayName.replace(/PM\s+(-?\d+(?:\.\d+)?)/i, (_match, pm) => `PM ${formatPostMileLabel(pm, pm)}`);
}

function buildMapPreviewUrl(lat?: number | null, lon?: number | null): string | null {
  if (lat == null || lon == null || Number.isNaN(lat) || Number.isNaN(lon)) return null;
  const pad = 0.01;
  const bbox = [lon - pad, lat - pad, lon + pad, lat + pad].join(",");
  return `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${encodeURIComponent(bbox)}&bboxSR=4326&imageSR=4326&size=1200,600&format=jpg&f=image`;
}

function buildMapPreviewUrlForBounds(bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null): string | null {
  if (!bounds) return null;
  const bbox = [bounds.minLon, bounds.minLat, bounds.maxLon, bounds.maxLat].join(",");
  return `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${encodeURIComponent(bbox)}&bboxSR=4326&imageSR=4326&size=1200,600&format=jpg&f=image`;
}

function computeReviewBounds(
  incident: Incident | null,
  candidates: IncidentLocationCandidate[]
): { minLat: number; maxLat: number; minLon: number; maxLon: number } | null {
  const points = [
    incident && Number.isFinite(incident.latitude) && Number.isFinite(incident.longitude)
      ? { lat: incident.latitude, lon: incident.longitude }
      : null,
    ...candidates
      .filter((c) => Number.isFinite(c.latitude) && Number.isFinite(c.longitude))
      .map((c) => ({ lat: c.latitude as number, lon: c.longitude as number })),
  ].filter(Boolean) as { lat: number; lon: number }[];

  if (points.length === 0) return null;
  const minLatRaw = Math.min(...points.map((p) => p.lat));
  const maxLatRaw = Math.max(...points.map((p) => p.lat));
  const minLonRaw = Math.min(...points.map((p) => p.lon));
  const maxLonRaw = Math.max(...points.map((p) => p.lon));
  const latPad = Math.max((maxLatRaw - minLatRaw) * 0.2, 0.0035);
  const lonPad = Math.max((maxLonRaw - minLonRaw) * 0.2, 0.0035);
  return {
    minLat: minLatRaw - latPad,
    maxLat: maxLatRaw + latPad,
    minLon: minLonRaw - lonPad,
    maxLon: maxLonRaw + lonPad,
  };
}

function markerPosition(
  lat: number | null | undefined,
  lon: number | null | undefined,
  bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null
): { left: any; top: any } | null {
  if (
    lat == null ||
    lon == null ||
    !bounds ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    bounds.maxLat <= bounds.minLat ||
    bounds.maxLon <= bounds.minLon
  ) {
    return null;
  }
  const x = ((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * 100;
  const y = ((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * 100;
  return {
    left: `${Math.min(96, Math.max(4, x))}%` as any,
    top: `${Math.min(94, Math.max(6, y))}%` as any,
  };
}

export default function IncidentsTabScreen() {
  const { palette } = useUiSettings();
  const pathname = usePathname();
  const params = useLocalSearchParams<{ id?: string; incident_id?: string }>();
  const [me, setMe] = useState<{ id: number; roles: string[] } | null>(null);
  const [items, setItems] = useState<Incident[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [assignIncidentId, setAssignIncidentId] = useState<number | null>(null);
  const [branchRouteIncident, setBranchRouteIncident] = useState<Incident | null>(null);
  const [branchChiefOptions, setBranchChiefOptions] = useState<RoutingUserOption[]>([]);
  const [branchChiefOptionsLoading, setBranchChiefOptionsLoading] = useState(false);
  const [reviewIncident, setReviewIncident] = useState<Incident | null>(null);
  const [reviewCandidates, setReviewCandidates] = useState<IncidentLocationCandidate[]>([]);
  const [reviewTimeline, setReviewTimeline] = useState<IncidentLocationTimeline | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [selectedLocationId, setSelectedLocationId] = useState<number | null>(null);
  const [coordinatorComment, setCoordinatorComment] = useState("");
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
  const [pendingIncidentFiles, setPendingIncidentFiles] = useState<PendingIncidentUpload[]>([]);
  const [editingIncidentId, setEditingIncidentId] = useState<number | null>(null);
  const [editingLocked, setEditingLocked] = useState(false);
  const [revisionEditableFields, setRevisionEditableFields] = useState<string[] | null>(null);
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
    const cells: (number | null)[] = Array(firstDay).fill(null);
    for (let day = 1; day <= daysInMonth; day += 1) cells.push(day);
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [calendarMonth, calendarYear]);

  const isAdmin = !!me?.roles?.includes("ADMIN");
  const canCoordinatorReview = !!me?.roles?.some((r) => r === "MAINT_COORDINATOR" || r === "ADMIN");
  const isOfficeChiefMobile = !!me?.roles?.includes("OFFICE_CHIEF") && !me?.roles?.includes("ADMIN");
  const isBranchChiefMobile = !!me?.roles?.includes("BRANCH_CHIEF") && !me?.roles?.includes("ADMIN");
  const isWorker = !!me?.roles?.some((r) => r === "FIELD_WORKER" || r === "MAINTENANCE" || r === "ADMIN");
  const canResolve = !!me?.roles?.some((r) => r === "FIELD_WORKER" || r === "ADMIN");
  const isMaintenanceWorkerMobile =
    !!me?.roles?.some((r) => r === "FIELD_WORKER" || r === "MAINTENANCE") &&
    !me?.roles?.some((r) => r === "MAINT_COORDINATOR" || r === "OFFICE_CHIEF" || r === "BRANCH_CHIEF" || r === "ADMIN");
  const canEditIncidentInForm = editingIncidentId == null || !editingLocked;
  const isCreateRoute = pathname?.startsWith("/incidents/create") || pathname?.startsWith("/(tabs)/incidents/create");
  const isDetailRoute = /\/incidents\/\d+$/.test(pathname || "");
  const isIncidentFormRoute = isCreateRoute || isDetailRoute;

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

  const closeCoordinatorReview = () => {
    setReviewIncident(null);
    setReviewCandidates([]);
    setReviewTimeline(null);
    setSelectedLocationId(null);
    setCoordinatorComment("");
    setReviewLoading(false);
    setReviewBusy(false);
  };

  const loadLocationTimeline = useCallback(async (locationId: number, token: string) => {
    const timeline = await getIncidentLocationTimeline(token, locationId);
    setReviewTimeline(timeline);
  }, []);

  const openCoordinatorReview = useCallback(async (incident: Incident) => {
    const token = await getToken();
    if (!token) return;
    setReviewIncident(incident);
    setReviewCandidates([]);
    setReviewTimeline(null);
    setSelectedLocationId(incident.location_id ?? null);
    setCoordinatorComment("");
    setReviewLoading(true);
    setErr(null);
    try {
      const res = await getIncidentLocationCandidates(token, incident.id);
      setReviewCandidates(res.items ?? []);
      const preferredLocationId = incident.location_id ?? res.location_id ?? res.items?.[0]?.id ?? null;
      setSelectedLocationId(preferredLocationId);
      if (preferredLocationId) {
        await loadLocationTimeline(preferredLocationId, token);
      }
    } catch (e: any) {
      if (!isSessionExpiredError(e)) setErr(String(e?.message ?? e));
    } finally {
      setReviewLoading(false);
    }
  }, [loadLocationTimeline]);

  const openIncidentFromTracking = (incident: Incident) => {
    const incidentId = String(incident.id);
    router.push({ pathname: "/(tabs)/incidents/[id]", params: { id: incidentId } });
  };

  const hydrateEditingIncident = (incident: Incident) => {
    const needsRevision = String(incident.location_match_status || "").toUpperCase() === "NEEDS_REVISION";
    setEditingIncidentId(incident.id);
    setEditingLocked(!needsRevision);
    setRevisionEditableFields(needsRevision ? extractRevisionFields(incident.location_match_metadata) : null);
    setDescription(incident.description || "");
    setFirstObservedAt((incident.first_observed_at || "").slice(0, 10));
    setFirstOccurredAt((incident.first_occurred_at || "").slice(0, 10));
    setLatitude(formatCoordinate(incident.latitude));
    setLongitude(formatCoordinate(incident.longitude));
    setDistrict((incident.district || "").trim());
    setCounty((incident.county || "").trim());
    setRouteValue(normalizeRoute(incident.route || ""));
    setPostMile(normalizePostMileInput(incident.post_mile));
  };

  useEffect(() => {
    if (!isDetailRoute) return;
    const incidentIdRaw = typeof params.id === "string" ? params.id : "";
    const incidentId = Number(incidentIdRaw);
    if (!incidentIdRaw || Number.isNaN(incidentId) || incidentId <= 0) return;
    const incident = items.find((x) => x.id === incidentId);
    if (!incident) return;
    if (editingIncidentId === incident.id) return;
    hydrateEditingIncident(incident);
  }, [editingIncidentId, isDetailRoute, items, params.id]);

  useEffect(() => {
    if (!isCreateRoute) return;
    setEditingIncidentId(null);
    setEditingLocked(false);
    setRevisionEditableFields(null);
  }, [isCreateRoute]);

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
    setPendingIncidentFiles([]);
    setEditingIncidentId(null);
    setEditingLocked(false);
    setRevisionEditableFields(null);
  };

  const canEditField = (field: string) => {
    if (!canEditIncidentInForm) return false;
    if (!isDetailRoute) return true;
    if (!revisionEditableFields || revisionEditableFields.length === 0) return true;
    return revisionEditableFields.includes(field);
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

  const addPendingIncidentFiles = (files: PendingIncidentUpload[]) => {
    if (!files.length) return;
    setPendingIncidentFiles((prev) => [...prev, ...files]);
  };

  const removePendingIncidentFile = (index: number) => {
    setPendingIncidentFiles((prev) => prev.filter((_, i) => i !== index));
  };

  async function pickIncidentMedia() {
    let result: ImagePicker.ImagePickerResult;
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          "Permission required",
          "Photo library access is required to add photos or videos. Please allow access in Settings."
        );
        return;
      }
      result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images", "videos"],
        quality: 0.85,
        allowsMultipleSelection: true,
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (isIosPhotosAccessError(msg)) {
        Alert.alert(
          "Photo library error",
          "iOS could not load that item from Photos. Please try another video, or use Files/imported media if available."
        );
        return;
      }
      Alert.alert("Picker failed", msg || "Unable to open photo library.");
      return;
    }

    if (result.canceled || !result.assets?.length) return;
    const nextFiles: PendingIncidentUpload[] = result.assets.map((asset) => {
      const uri = asset.uri;
      const name = asset.fileName || uri.split("/").pop() || "incident-media.bin";
      const type = guessMimeType(name, asset.mimeType);
      return {
        uri,
        name,
        type,
        kind: inferIncidentAttachmentKind(name, type),
        size: typeof (asset as any).fileSize === "number" ? (asset as any).fileSize : null,
      };
    });
    addPendingIncidentFiles(nextFiles);
  }

  async function pickIncidentDocument() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "*/*",
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.length) return;
      const nextFiles: PendingIncidentUpload[] = [];
      for (const asset of result.assets) {
        const uri = String(asset.uri || "").trim();
        if (!uri) continue;
        const name = String(asset.name || uri.split("/").pop() || "incident-file.bin");
        const type = guessMimeType(name, asset.mimeType);
        nextFiles.push({
          uri,
          name,
          type,
          kind: inferIncidentAttachmentKind(name, type),
          size: typeof asset.size === "number" ? asset.size : null,
        });
      }
      addPendingIncidentFiles(nextFiles);
    } catch (err: any) {
      Alert.alert("File picker failed", String(err?.message ?? err ?? "Unable to open file picker."));
    }
  }

  function promptIncidentUploadSource() {
    Alert.alert("Upload Source", "Choose where to pick the file from.", [
      { text: "Gallery", onPress: () => { pickIncidentMedia().catch(() => {}); } },
      { text: "Files (PDF/CAD/etc)", onPress: () => { pickIncidentDocument().catch(() => {}); } },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  const uploadPendingIncidentFiles = async (authToken: string, incidentId: number) => {
    const failures: string[] = [];
    for (const file of pendingIncidentFiles) {
      try {
        await uploadIncidentAttachment(
          authToken,
          incidentId,
          { uri: file.uri, name: file.name, type: file.type },
          { kind: file.kind }
        );
      } catch (err: any) {
        failures.push(`${file.name}: ${String(err?.message ?? err)}`);
      }
    }
    return failures;
  };

  const onCreate = async () => {
    const token = await getToken();
    if (!token) return;
    if (isDetailRoute && !canEditIncidentInForm) {
      router.replace("/(tabs)/incidents/track");
      return;
    }
    const lat = normalizeCoordinateValue(latitude);
    const lon = normalizeCoordinateValue(longitude);
    if (!firstObservedAt.trim()) {
      Alert.alert("Missing Date", "First observed date is required.");
      return;
    }
    if (lat == null || lon == null) {
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
        post_mile: normalizePostMileValue(postMile) ?? "",
      };
      const selectedFileCount = pendingIncidentFiles.length;
      let savedIncidentId = editingIncidentId;
      if (editingIncidentId) {
        await updateIncident(token, editingIncidentId, payload);
      } else {
        const created = await createIncident(token, payload);
        savedIncidentId = created.incident.id;
      }
      const uploadFailures = savedIncidentId
        ? await uploadPendingIncidentFiles(token, savedIncidentId)
        : [];
      resetCreateForm();
      if (isDetailRoute) {
        router.replace("/(tabs)/incidents/track");
      }
      await load();
      if (selectedFileCount > 0) {
        const uploadedCount = selectedFileCount - uploadFailures.length;
        if (uploadFailures.length) {
          Alert.alert(
            "Incident saved",
            `${uploadedCount} of ${selectedFileCount} files uploaded. ${uploadFailures.slice(0, 2).join("\n")}`
          );
        } else {
          Alert.alert("Files uploaded", `${selectedFileCount} file${selectedFileCount === 1 ? "" : "s"} attached to this incident.`);
        }
      }
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
      const lat = normalizeCoordinateValue(pos.coords.latitude);
      const lon = normalizeCoordinateValue(pos.coords.longitude);
      if (lat == null || lon == null) {
        Alert.alert("Location Error", "Unable to read a valid coordinate.");
        return;
      }
      setLatitude(formatCoordinate(lat));
      setLongitude(formatCoordinate(lon));

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

      const route = normalizeRoute(geo.route || "");
      const routeAllowed = countyCode ? routesForCounty(countyCode) : [];
      const allowedRouteValues = routeAllowed.map(normalizeRoute).filter(Boolean);
      const normalizedRoute = route && (routeAllowed.length === 0 || allowedRouteValues.includes(normalizeRoute(route))) ? normalizeRoute(route) : "";
      if (normalizedRoute) {
        setRouteValue(normalizedRoute);
      }

      if (geo.post_mile?.trim()) {
        setPostMile(normalizePostMileInput(geo.post_mile));
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

  const openBranchRouting = async (incident: Incident) => {
    const token = await getToken();
    if (!token) return;
    setBranchRouteIncident(incident);
    setBranchChiefOptions([]);
    setBranchChiefOptionsLoading(true);
    setErr(null);
    try {
      const res = await getOfficeChiefBranchOptions(token, incident.id);
      setBranchChiefOptions(res.items ?? []);
    } catch (e: any) {
      if (!isSessionExpiredError(e)) setErr(String(e?.message ?? e));
    } finally {
      setBranchChiefOptionsLoading(false);
    }
  };

  const onAssignBranchChief = async (branchChiefUserId: number) => {
    const token = await getToken();
    if (!token || !branchRouteIncident) return;
    setBusy(true);
    setErr(null);
    try {
      await assignIncidentToBranchChief(token, branchRouteIncident.id, branchChiefUserId);
      setBranchRouteIncident(null);
      setBranchChiefOptions([]);
      await load();
      Alert.alert("Routed", "This case is now with the selected branch chief.");
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

  const selectCandidateForReview = async (locationId: number) => {
    const token = await getToken();
    if (!token) return;
    setSelectedLocationId(locationId);
    setReviewLoading(true);
    try {
      await loadLocationTimeline(locationId, token);
    } catch (e: any) {
      if (!isSessionExpiredError(e)) setErr(String(e?.message ?? e));
    } finally {
      setReviewLoading(false);
    }
  };

  const onCoordinatorLinkExisting = async () => {
    const token = await getToken();
    if (!token || !reviewIncident || !selectedLocationId) return;
    setReviewBusy(true);
    setErr(null);
    try {
      const res = await linkIncidentLocation(token, reviewIncident.id, {
        mode: "EXISTING",
        location_id: selectedLocationId,
        comment: coordinatorComment.trim() || null,
      });
      setReviewIncident((prev) => (
        prev ? { ...prev, location_id: res.location_id, location_match_status: res.location_match_status } : prev
      ));
      await load();
      await loadLocationTimeline(selectedLocationId, token);
      Alert.alert("Location linked", "This incident will now append to the selected location case.");
    } catch (e: any) {
      if (!isSessionExpiredError(e)) setErr(String(e?.message ?? e));
    } finally {
      setReviewBusy(false);
    }
  };

  const onCoordinatorCreateNewLocation = async () => {
    const token = await getToken();
    if (!token || !reviewIncident) return;
    setReviewBusy(true);
    setErr(null);
    try {
      const res = await linkIncidentLocation(token, reviewIncident.id, {
        mode: "CREATE_NEW",
        comment: coordinatorComment.trim() || null,
      });
      setSelectedLocationId(res.location_id);
      setReviewIncident((prev) => (
        prev ? { ...prev, location_id: res.location_id, location_match_status: res.location_match_status } : prev
      ));
      await load();
      await loadLocationTimeline(res.location_id, token);
      Alert.alert("New case created", "A new location case record is ready for this incident.");
    } catch (e: any) {
      if (!isSessionExpiredError(e)) setErr(String(e?.message ?? e));
    } finally {
      setReviewBusy(false);
    }
  };

  const onCoordinatorRequestRevision = async () => {
    const token = await getToken();
    if (!token || !reviewIncident) return;
    if (!coordinatorComment.trim()) {
      Alert.alert("Comment required", "Add a note so the maintenance crew knows what to correct.");
      return;
    }
    setReviewBusy(true);
    setErr(null);
    try {
      await requestIncidentRevisionByCoordinator(
        token,
        reviewIncident.id,
        coordinatorComment.trim(),
        ["district", "county", "route", "post_mile", "latitude", "longitude", "description"]
      );
      await load();
      closeCoordinatorReview();
      Alert.alert("Revision requested", "The maintenance crew can now update the incident.");
    } catch (e: any) {
      if (!isSessionExpiredError(e)) setErr(String(e?.message ?? e));
    } finally {
      setReviewBusy(false);
    }
  };

  const onCoordinatorForward = async () => {
    const token = await getToken();
    if (!token || !reviewIncident) return;
    if (!reviewIncident.location_id && !selectedLocationId) {
      Alert.alert("Location required", "Link this incident to an existing case or create a new one before forwarding.");
      return;
    }
    setReviewBusy(true);
    setErr(null);
    try {
      const res = await forwardIncidentByCoordinator(token, reviewIncident.id, coordinatorComment.trim() || null);
      await load();
      closeCoordinatorReview();
      Alert.alert(
        "Incident approved",
        res.linked_submission_id
          ? `A draft form was created for this case as Draft #${res.linked_submission_id}.`
          : "The incident was forwarded successfully."
      );
      if (res.linked_submission_id) openDraft(res.linked_submission_id);
    } catch (e: any) {
      if (!isSessionExpiredError(e)) setErr(String(e?.message ?? e));
    } finally {
      setReviewBusy(false);
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
  const reviewMapBounds = useMemo(
    () => computeReviewBounds(reviewIncident, reviewCandidates),
    [reviewIncident, reviewCandidates]
  );
  const reviewMapPreviewUrl = useMemo(
    () => buildMapPreviewUrlForBounds(reviewMapBounds) ?? buildMapPreviewUrl(reviewIncident?.latitude ?? null, reviewIncident?.longitude ?? null),
    [reviewIncident?.latitude, reviewIncident?.longitude, reviewMapBounds]
  );
  const incidentScreenTitle = isOfficeChiefMobile || isBranchChiefMobile ? "Cases" : "Incidents";
  const incidentScreenSubtitle = isOfficeChiefMobile
    ? "Review approved cases in your office and route them to the right branch chief."
    : isBranchChiefMobile
      ? "Review office-routed cases in your office."
      : "Create incidents and process them through the assigned workflow.";

  if (isIncidentFormRoute && isWorker) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: palette.bg }]}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
          <ScrollView
            ref={createScrollRef}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
            contentContainerStyle={[
              styles.createScrollContent,
              isDetailRoute ? { paddingBottom: 48 } : { paddingBottom: 28 },
            ]}
          >
            <View style={styles.innerCreate}>
              {isDetailRoute ? (
                <View style={styles.detailTopRow}>
                  <Pressable onPress={() => router.replace("/(tabs)/incidents/track")} hitSlop={8}>
                    <Text style={[styles.detailBackText, { color: palette.primary }]}>Back</Text>
                  </Pressable>
                  <Text style={[styles.detailTopTitle, { color: palette.text }]}>Incident Details</Text>
                  {canEditIncidentInForm && !isMaintenanceWorkerMobile ? (
                    <Pressable
                      style={[styles.detailSaveBtn, { backgroundColor: palette.panel, borderColor: palette.border }]}
                      onPress={onCreate}
                      disabled={busy}
                    >
                      <Text style={[styles.detailSaveText, { color: palette.primary }]}>{busy ? "..." : "Save"}</Text>
                    </Pressable>
                  ) : (
                    <View style={styles.detailSaveSpacer} />
                  )}
                </View>
              ) : null}
              {!isDetailRoute ? (
                <>
                  <Text style={[styles.title, { color: palette.text }]}>Create Incident</Text>
                  <Text style={[styles.sub, { color: palette.muted }]}>
                    Create an incident report and send it into workflow.
                  </Text>
                </>
              ) : null}

              <View style={styles.formCard} testID="incident-create-card">
                <View style={styles.row2}>
                  <View style={styles.half}>
                    <SelectField
                      label="District *"
                      value={district}
                      placeholder="Select district"
                      editable={canEditField("district")}
                      onPress={() => setDistrictPickerOpen(true)}
                      palette={palette}
                    />
                  </View>
                  <View style={styles.half}>
                    <SelectField
                      label="County *"
                      value={countyLabelValue}
                      placeholder={district ? "Select county" : "Select district first"}
                      editable={canEditField("county") && !!district}
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
                      editable={canEditField("route") && !!county}
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
                        onBlur={() => setPostMile((prev) => normalizePostMileInput(prev))}
                        onFocus={() => scrollToCreateField("postMile")}
                        editable={canEditField("post_mile")}
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
                        onBlur={() => setLatitude((prev) => formatCoordinate(prev))}
                        onFocus={() => scrollToCreateField("latitude")}
                        editable={canEditField("latitude")}
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
                        onBlur={() => setLongitude((prev) => formatCoordinate(prev))}
                        onFocus={() => scrollToCreateField("longitude")}
                        editable={canEditField("longitude")}
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
                  editable={canEditField("first_observed_at")}
                  onPress={() => openIncidentDatePicker("firstObservedAt")}
                  palette={palette}
                />
                <SelectField
                  label="First Occurred (YYYY-MM-DD, optional)"
                  value={firstOccurredAt}
                  placeholder="Select date"
                  editable={canEditField("first_occurred_at")}
                  onPress={() => openIncidentDatePicker("firstOccurredAt")}
                  palette={palette}
                />
                <View onLayout={(e) => registerCreateField("description", e.nativeEvent.layout.y)}>
                  <FormField
                    label="Description"
                    value={description}
                    onChangeText={setDescription}
                    onFocus={() => scrollToCreateField("description")}
                    editable={canEditField("description")}
                    multiline
                    placeholder="Description"
                    palette={palette}
                  />
                </View>
                {canEditIncidentInForm ? (
                  <View style={styles.incidentUploadSection}>
                    <Text style={[styles.labelText, { color: palette.muted }]}>Supporting Files</Text>
                    <Text style={[styles.uploadHelpText, { color: palette.muted }]}>
                      Add photos, videos, PDFs, CAD, or other files. They upload after the incident is saved.
                    </Text>
                    <View style={styles.uploadActionRow}>
                      <Pressable
                        style={[styles.btn, styles.uploadActionBtn, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}
                        onPress={promptIncidentUploadSource}
                        disabled={busy}
                      >
                        <Text style={{ color: palette.text, fontWeight: "700" }}>Add Files</Text>
                      </Pressable>
                    </View>
                    {pendingIncidentFiles.length === 0 ? (
                      <Text style={[styles.uploadEmptyText, { color: palette.muted }]}>No files selected.</Text>
                    ) : (
                      <View style={styles.pendingUploadList}>
                        {pendingIncidentFiles.map((file, index) => {
                          const sizeLabel = formatFileSize(file.size);
                          return (
                            <View
                              key={`${file.uri}-${index}`}
                              style={[styles.pendingUploadRow, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}
                            >
                              <View style={{ flex: 1 }}>
                                <Text style={{ color: palette.text, fontWeight: "700" }} numberOfLines={1}>{file.name}</Text>
                                <Text style={{ color: palette.muted, fontSize: 12 }}>
                                  {sizeLabel ? `${file.kind} - ${sizeLabel}` : file.kind}
                                </Text>
                              </View>
                              <Pressable onPress={() => removePendingIncidentFile(index)} disabled={busy} hitSlop={8}>
                                <Text style={{ color: palette.danger, fontWeight: "800" }}>Remove</Text>
                              </Pressable>
                            </View>
                          );
                        })}
                      </View>
                    )}
                  </View>
                ) : null}
                <View style={[styles.row2, styles.actionsRow]}>
                  {!isDetailRoute ? (
                    <>
                      <Pressable style={[styles.btn, { borderColor: palette.border }]} onPress={onGpsAutofill} disabled={!canEditIncidentInForm}>
                        <Text style={{ color: palette.text, fontWeight: "700" }}>GPS Autofill</Text>
                      </Pressable>
                      <Pressable style={[styles.btn, { borderColor: palette.border, backgroundColor: palette.panelSoft }]} onPress={onConfirmClearForm} disabled={busy || !canEditIncidentInForm}>
                        <Text style={{ color: palette.danger, fontWeight: "700" }}>Clear Incident</Text>
                      </Pressable>
                    </>
                  ) : null}
                  {!isDetailRoute ? (
                    <Pressable style={[styles.btn, { backgroundColor: palette.primary }]} onPress={onCreate} disabled={busy}>
                      <Text style={{ color: "#fff", fontWeight: "700" }}>
                        {busy ? "Working..." : "Create Incident"}
                      </Text>
                    </Pressable>
                  ) : null}
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
        <Text style={[styles.title, { color: palette.text }]}>{incidentScreenTitle}</Text>
        <Text style={[styles.sub, { color: palette.muted }]}>{incidentScreenSubtitle}</Text>

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
            const itemLabel = isOfficeChiefMobile || isBranchChiefMobile ? "Case" : "Incident";
            const incidentTitle =
              item.title?.trim() ||
              `${itemLabel} ${item.district ?? "Unknown district"} / ${item.route ?? "Unknown route"} / PM ${formatPostMileLabel(item.post_mile, "?")}`;
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
                  #{item.id} | {formatCoordinate(item.latitude)}, {formatCoordinate(item.longitude)}
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
                  {canCoordinatorReview && item.current_stage === "COORDINATOR_REVIEW" ? (
                    <Pressable
                      style={[styles.smallBtn, { borderColor: palette.border }]}
                      onPress={() => openCoordinatorReview(item)}
                    >
                      <Text style={{ color: palette.text, fontWeight: "700" }}>Review Location</Text>
                    </Pressable>
                  ) : null}
                  {isOfficeChiefMobile && item.current_stage === "OFFICE_CHIEF_REVIEW" ? (
                    <Pressable
                      style={[styles.smallBtn, { borderColor: palette.border }]}
                      onPress={() => openBranchRouting(item)}
                    >
                      <Text style={{ color: palette.text, fontWeight: "700" }}>Route to Branch Chief</Text>
                    </Pressable>
                  ) : null}
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
              {busy
                ? "Loading incidents..."
                : isMaintenanceWorkerMobile
                  ? "No incidents pending coordinator review."
                  : isOfficeChiefMobile
                    ? "No cases are waiting for office chief review."
                    : isBranchChiefMobile
                      ? "No cases are waiting for branch chief review."
                      : "No incidents yet."}
            </Text>
          }
        />
      </View>

      <Modal visible={reviewIncident != null} transparent animationType="fade" onRequestClose={closeCoordinatorReview}>
        <Pressable style={styles.modalBackdrop} onPress={closeCoordinatorReview}>
          <Pressable style={[styles.modalCard, styles.reviewModalCard, { backgroundColor: palette.panel, borderColor: palette.border }]}>
            <Text style={[styles.modalTitle, { color: palette.text }]}>Coordinator Review</Text>
            {reviewIncident ? (
              <ScrollView style={{ maxHeight: "88%" }} contentContainerStyle={{ paddingBottom: 8 }}>
                <Text style={[styles.reviewHeadline, { color: palette.text }]}>
                  {reviewIncident.title?.trim() || `Incident #${reviewIncident.id}`}
                </Text>
                <Text style={{ color: palette.muted, marginTop: 2 }}>
                  Review nearby cases, choose whether this belongs to an existing location, and then approve to create the draft form.
                </Text>

                <View style={[styles.reviewInfoCard, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}>
                  <Text style={[styles.reviewSectionTitle, { color: palette.text }]}>Current Incident</Text>
                  <Text style={{ color: palette.muted }}>{formatLocationLine(reviewIncident)}</Text>
                  <Text style={{ color: palette.muted }}>
                    {formatCoordinate(reviewIncident.latitude)}, {formatCoordinate(reviewIncident.longitude)}
                  </Text>
                  <Text style={{ color: palette.muted }}>Observed: {formatTimestamp(reviewIncident.first_observed_at)}</Text>
                  {reviewMapPreviewUrl ? (
                    <View style={styles.reviewMapWrap}>
                      <Image source={{ uri: reviewMapPreviewUrl }} style={styles.reviewMapPreview} />
                      {reviewCandidates.map((candidate) => {
                        const pos = markerPosition(candidate.latitude, candidate.longitude, reviewMapBounds);
                        if (!pos) return null;
                        const selected = selectedLocationId === candidate.id;
                        return (
                          <Pressable
                            key={`marker-${candidate.id}`}
                            style={[
                              styles.mapMarker,
                              styles.mapCandidateMarker,
                              {
                                left: pos.left,
                                top: pos.top,
                                borderColor: selected ? palette.primary : "#fff",
                                backgroundColor: selected ? palette.primary : "rgba(10,26,47,0.88)",
                              },
                            ]}
                            onPress={() => selectCandidateForReview(candidate.id)}
                          >
                            <Text style={styles.mapMarkerText}>{candidate.id}</Text>
                          </Pressable>
                        );
                      })}
                      {(() => {
                        const pos = markerPosition(reviewIncident.latitude, reviewIncident.longitude, reviewMapBounds);
                        if (!pos) return null;
                        return (
                          <View
                            style={[
                              styles.mapMarker,
                              styles.mapIncidentMarker,
                              { left: pos.left, top: pos.top, borderColor: "#fff" },
                            ]}
                          >
                            <Text style={styles.mapMarkerText}>N</Text>
                          </View>
                        );
                      })()}
                    </View>
                  ) : null}
                  <View style={styles.mapLegendRow}>
                    <View style={styles.mapLegendItem}>
                      <View style={[styles.mapLegendDot, { backgroundColor: "#c2410c" }]} />
                      <Text style={{ color: palette.muted, fontSize: 12 }}>New incident</Text>
                    </View>
                    <View style={styles.mapLegendItem}>
                      <View style={[styles.mapLegendDot, { backgroundColor: palette.primary }]} />
                      <Text style={{ color: palette.muted, fontSize: 12 }}>Selected case</Text>
                    </View>
                    <View style={styles.mapLegendItem}>
                      <View style={[styles.mapLegendDot, { backgroundColor: "#10233c" }]} />
                      <Text style={{ color: palette.muted, fontSize: 12 }}>Nearby case</Text>
                    </View>
                  </View>
                </View>

                <Text style={[styles.reviewSectionTitle, { color: palette.text }]}>Nearby Existing Cases</Text>
                {reviewLoading ? (
                  <ActivityIndicator style={{ marginVertical: 14 }} color={palette.primary} />
                ) : reviewCandidates.length === 0 ? (
                  <View style={[styles.reviewInfoCard, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}>
                    <Text style={{ color: palette.muted }}>No nearby saved location cases were found.</Text>
                  </View>
                ) : (
                  reviewCandidates.map((candidate) => {
                    const selected = selectedLocationId === candidate.id;
                    return (
                      <Pressable
                        key={candidate.id}
                        style={[
                          styles.reviewCandidateCard,
                          {
                            borderColor: selected ? palette.primary : palette.border,
                            backgroundColor: selected ? palette.panelSoft : palette.panel,
                          },
                        ]}
                        onPress={() => selectCandidateForReview(candidate.id)}
                      >
                        <Text style={{ color: palette.text, fontWeight: "700" }}>
                          {formatLocationDisplayName(candidate, `Location #${candidate.id}`)}
                        </Text>
                        <Text style={{ color: palette.muted, marginTop: 2 }}>{formatLocationLine(candidate)}</Text>
                        <Text style={{ color: palette.muted, fontSize: 12 }}>
                          Match score: {candidate.match_score} | Updated: {formatTimestamp(candidate.updated_at)}
                        </Text>
                      </Pressable>
                    );
                  })
                )}

                {reviewTimeline ? (
                  <View style={[styles.reviewInfoCard, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}>
                    <Text style={[styles.reviewSectionTitle, { color: palette.text }]}>
                      Selected Case Timeline: {formatLocationDisplayName(reviewTimeline.location, `Location #${reviewTimeline.location.id}`)}
                    </Text>
                    <Text style={{ color: palette.muted }}>
                      {reviewTimeline.incident_count} incidents, {reviewTimeline.submission_count} engineer forms
                    </Text>
                    {reviewTimeline.incidents.slice(0, 3).map((entry) => (
                      <View key={`inc-${entry.id}`} style={styles.timelineRow}>
                        <Text style={{ color: palette.text, fontWeight: "700" }}>Incident #{entry.id}</Text>
                        <Text style={{ color: palette.muted, fontSize: 12 }}>
                          {entry.current_stage} | {formatTimestamp(entry.first_observed_at)}
                        </Text>
                      </View>
                    ))}
                    {reviewTimeline.submissions.slice(0, 3).map((entry) => (
                      <Pressable key={`sub-${entry.id}`} style={styles.timelineRow} onPress={() => openDraft(entry.id)}>
                        <Text style={{ color: palette.text, fontWeight: "700" }}>Form #{entry.id}</Text>
                        <Text style={{ color: palette.muted, fontSize: 12 }}>
                          {entry.status} | {formatTimestamp(entry.created_at)}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}

                <View style={{ marginTop: 8 }}>
                  <Text style={[styles.labelText, { color: palette.muted }]}>Coordinator Comment</Text>
                  <TextInput
                    value={coordinatorComment}
                    onChangeText={setCoordinatorComment}
                    multiline
                    placeholder="Add context for the case decision or revision request"
                    placeholderTextColor={palette.muted}
                    style={[
                      styles.input,
                      styles.inputMultiline,
                      { borderColor: palette.border, backgroundColor: palette.panelSoft, color: palette.text },
                    ]}
                  />
                </View>

                <View style={[styles.actions, { marginTop: 10 }]}>
                  <Pressable
                    style={[styles.reviewActionBtn, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}
                    onPress={onCoordinatorLinkExisting}
                    disabled={reviewBusy || !selectedLocationId}
                  >
                    <Text style={{ color: palette.text, fontWeight: "700" }}>Use Existing Case</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.reviewActionBtn, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}
                    onPress={onCoordinatorCreateNewLocation}
                    disabled={reviewBusy}
                  >
                    <Text style={{ color: palette.text, fontWeight: "700" }}>Create New Case</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.reviewActionBtn, { borderColor: palette.border, backgroundColor: "#4a1d1f" }]}
                    onPress={onCoordinatorRequestRevision}
                    disabled={reviewBusy}
                  >
                    <Text style={{ color: "#fecaca", fontWeight: "700" }}>Request Revision</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.reviewActionBtn, { borderColor: palette.primary, backgroundColor: palette.primary }]}
                    onPress={onCoordinatorForward}
                    disabled={reviewBusy}
                  >
                    <Text style={{ color: "#fff", fontWeight: "700" }}>{reviewBusy ? "Working..." : "Approve and Create Form"}</Text>
                  </Pressable>
                </View>
              </ScrollView>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={branchRouteIncident != null} transparent animationType="fade" onRequestClose={() => setBranchRouteIncident(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setBranchRouteIncident(null)}>
          <Pressable style={[styles.modalCard, { backgroundColor: palette.panel, borderColor: palette.border }]}>
            <Text style={[styles.modalTitle, { color: palette.text }]}>Route Case to Branch Chief</Text>
            <Text style={{ color: palette.muted, marginBottom: 10 }}>
              {branchRouteIncident
                ? branchRouteIncident.title?.trim() || `Case #${branchRouteIncident.id}`
                : ""}
            </Text>
            {branchChiefOptionsLoading ? (
              <ActivityIndicator style={{ marginVertical: 18 }} color={palette.primary} />
            ) : (
              <FlatList
                data={branchChiefOptions}
                keyExtractor={(item) => String(item.id)}
                renderItem={({ item }) => (
                  <Pressable
                    style={[styles.userRow, { borderColor: palette.border }]}
                    onPress={() => onAssignBranchChief(item.id)}
                  >
                    <Text style={{ color: palette.text, fontWeight: "700" }}>{item.full_name}</Text>
                    <Text style={{ color: palette.muted, fontSize: 12 }}>{item.email}</Text>
                    <Text style={{ color: palette.muted, fontSize: 12 }}>
                      Office: {item.metadata?.office_code || "-"} {item.metadata?.office_location ? `| ${item.metadata.office_location}` : ""}
                    </Text>
                  </Pressable>
                )}
                ListEmptyComponent={
                  <Text style={{ color: palette.muted, paddingVertical: 14 }}>
                    No branch chiefs are configured for this office yet.
                  </Text>
                }
                style={{ maxHeight: 280 }}
              />
            )}
            <Pressable style={[styles.btn, { borderColor: palette.border, marginTop: 8 }]} onPress={() => setBranchRouteIncident(null)}>
              <Text style={{ color: palette.text, fontWeight: "700" }}>Close</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

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
  createScrollContent: { paddingBottom: 18, flexGrow: 1 },
  detailTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  detailBackText: {
    fontSize: 14,
    fontWeight: "700",
  },
  detailTopTitle: {
    fontSize: 17,
    fontWeight: "800",
  },
  detailSaveBtn: {
    minWidth: 58,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 5,
    elevation: 2,
  },
  detailSaveText: {
    fontSize: 13,
    fontWeight: "700",
  },
  detailSaveSpacer: {
    width: 58,
    height: 34,
  },
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
  incidentUploadSection: {
    marginTop: 4,
    marginBottom: 10,
  },
  uploadHelpText: {
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 8,
  },
  uploadActionRow: {
    flexDirection: "row",
    gap: 8,
  },
  uploadActionBtn: {
    flexGrow: 0,
    flexBasis: 150,
  },
  uploadEmptyText: {
    fontSize: 12,
    marginTop: 6,
  },
  pendingUploadList: {
    gap: 6,
    marginTop: 8,
  },
  pendingUploadRow: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
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
  reviewModalCard: {
    maxWidth: 760,
    width: "100%",
    alignSelf: "center",
    maxHeight: "92%",
  },
  modalTitle: { fontSize: 18, fontWeight: "800" },
  reviewHeadline: {
    fontSize: 16,
    fontWeight: "800",
    marginTop: 10,
  },
  reviewSectionTitle: {
    fontSize: 14,
    fontWeight: "800",
    marginBottom: 6,
  },
  reviewInfoCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginTop: 10,
  },
  reviewCandidateCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginTop: 8,
  },
  reviewMapPreview: {
    width: "100%",
    height: 180,
    borderRadius: 10,
    marginTop: 10,
    backgroundColor: "#dbe4f0",
  },
  reviewMapWrap: {
    marginTop: 10,
    position: "relative",
  },
  mapMarker: {
    position: "absolute",
    width: 26,
    height: 26,
    marginLeft: -13,
    marginTop: -13,
    borderRadius: 13,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  mapIncidentMarker: {
    backgroundColor: "#c2410c",
  },
  mapCandidateMarker: {},
  mapMarkerText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "800",
  },
  mapLegendRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginTop: 10,
  },
  mapLegendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  mapLegendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  reviewActionBtn: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  timelineRow: {
    borderTopWidth: 1,
    borderTopColor: "rgba(120,130,150,0.24)",
    paddingTop: 8,
    marginTop: 8,
  },
  userRow: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
  },
});

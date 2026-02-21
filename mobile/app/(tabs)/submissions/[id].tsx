import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, Alert, Image, ActivityIndicator, StyleSheet, Linking, Modal, Animated, Easing, Platform } from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { useLocalSearchParams, router } from "expo-router";

import { apiFetch, isSessionExpiredError } from "../../../src/api/client";
import { getApiBaseCandidates, getApiBaseUrl } from "../../../src/api/baseUrl";
import { getToken } from "../../../src/auth/tokenStore";
import { getGisaLookups, getSubmission, patchSubmission, replaceActions, replaceIncidentTypes, reviewSubmission, submitSubmission } from "../../../src/api/submissions";
import { useUiSettings } from "../../../src/ui/UiSettingsContext";
import { buildSubmissionDescriptor } from "../../../src/utils/submissionLabel";
import { enrichPointFromArcgisClient } from "../../../src/utils/arcgisEnrichment";
import {
  CALTRANS_COUNTIES,
  CALTRANS_DISTRICTS,
  countyCodeFromNameOrCode,
  countyDisplayLabel,
  districtForCounty,
  routesForCounty,
} from "../../../src/utils/caltransLookups";

type OptionItem = { code: string; label: string };
type UserInfo = { id: number; roles: string[] };
type Lookups = {
  distribution: OptionItem[];
  highway_status: OptionItem[];
  incident_types: OptionItem[];
  actions: { immediate: OptionItem[]; follow_up: OptionItem[] };
};
type SubmissionDetail = {
  submission: { id: number; created_by_user_id: number; title?: string | null; status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED"; created_at: string; updated_at: string; submitted_at?: string | null; reviewed_at?: string | null; review_comment?: string | null };
  gisa: any | null;
  incident_types: string[];
  actions: { immediate: string[]; follow_up: string[] };
  photos: { id: number; file_name: string; mime_type: string }[];
  workflow_events: { id: number; event_type: string; from_status?: string | null; to_status?: string | null; comment?: string | null; created_at: string }[];
};

type FormState = Record<string, string> & { pavement_ground_cracks: "UNKNOWN" | "YES" | "NO"; indented_by_rocks: "UNKNOWN" | "YES" | "NO" };
type FieldErrorMap = Partial<Record<keyof FormState, string>>;
const EMPTY_FORM: FormState = {
  report_date: "", district: "", county: "", route: "", post_mile: "", ea: "", project_id: "", date_incident_reported: "", district_contact: "",
  latitude: "", longitude: "", distribution_code: "", highway_status_code: "", lanes_closed_count: "",
  crack_length_ft: "", crack_horizontal_in: "", crack_vertical_in: "", crack_depth_in: "", settlement_in: "", bulge_in: "",
  observations_notes: "", geometry_json: "", pavement_ground_cracks: "UNKNOWN", indented_by_rocks: "UNKNOWN",
};

const n = (v: string) => (v.trim() ? v.trim() : null);
const f = (v: string, name: string) => { if (!v.trim()) return null; const x = Number(v); if (Number.isNaN(x)) throw new Error(`${name} must be numeric`); return x; };
const i = (v: string, name: string) => { if (!v.trim()) return null; const x = Number(v); if (Number.isNaN(x) || !Number.isInteger(x)) throw new Error(`${name} must be a whole number`); return x; };
const triToBool = (v: "UNKNOWN" | "YES" | "NO") => (v === "YES" ? true : false);
const boolToTri = (v: any) => (v === true ? "YES" : v === false ? "NO" : "UNKNOWN");
const isPlayServicesUnavailableError = (msg: string) =>
  /LocationServices\.API is not available|SERVICE_INVALID|Google Play services/i.test(msg);

function tryExtractRouteFromAddressLine(text: string): string | null {
  const m = text.match(/\b(?:I|US|CA|SR)[-\s]?(\d{1,3})\b/i) || text.match(/\b(\d{1,3})\b/);
  return m?.[1] ?? null;
}

function parseYmd(value: string): Date | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mm = Number(m[2]) - 1;
  const d = Number(m[3]);
  const dt = new Date(y, mm, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mm || dt.getDate() !== d) return null;
  return dt;
}

function toYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function monthLabel(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function normalizeDownloadUrl(rawUrl: string, apiBaseUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const badHosts = new Set(["host.docker.internal", "127.0.0.1", "localhost"]);
    if (!badHosts.has(u.hostname.toLowerCase())) return rawUrl;

    const api = new URL(apiBaseUrl);
    u.hostname = api.hostname;
    return u.toString();
  } catch {
    return rawUrl;
  }
}

function Chip({
  label,
  active,
  onPress,
  disabled,
  palette,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  disabled?: boolean;
  palette?: { primary: string; border: string; panelSoft: string; text: string };
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.chip,
        {
          borderColor: palette?.border ?? "#c8d5ea",
          backgroundColor: palette?.panelSoft ?? "#f9fbff",
        },
        active ? [styles.chipOn, { borderColor: palette?.primary ?? "#1d4ed8" }] : null,
        disabled ? { opacity: 0.6 } : null,
      ]}
    >
      <Text style={[styles.chipText, { color: palette?.text ?? "#334155" }, active ? [styles.chipTextOn, { color: palette?.primary ?? "#1d4ed8" }] : null]}>{label}</Text>
    </Pressable>
  );
}

function Field({
  label,
  value,
  onChangeText,
  editable,
  multiline,
  keyboardType,
  palette,
  error,
}: {
  label: string;
  value: string;
  onChangeText?: (v: string) => void;
  editable: boolean;
  multiline?: boolean;
  keyboardType?: "default" | "numeric" | "decimal-pad" | "number-pad";
  palette?: { muted: string; border: string; panel: string; text: string };
  error?: string;
}) {
  return (
    <View style={{ marginTop: 8 }}>
      <View style={styles.labelRow}>
        <Text style={[styles.label, { color: error ? "#dc2626" : (palette?.muted ?? "#465978") }]}>{label}</Text>
        {error ? (
          <View style={styles.errorIcon}>
            <Text style={styles.errorIconText}>i</Text>
          </View>
        ) : null}
      </View>
      <TextInput value={value} onChangeText={onChangeText} editable={editable} multiline={multiline} keyboardType={keyboardType ?? "default"} style={[styles.input, { borderColor: error ? "#ef4444" : (palette?.border ?? "#ccd8ea"), backgroundColor: palette?.panel ?? "#fdfefe", color: palette?.text ?? "#1b2a40" }, multiline ? { minHeight: 90, textAlignVertical: "top" } : null, !editable ? styles.inputDisabled : null]} />
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
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
  palette?: { muted: string; border: string; panel: string; text: string };
  error?: string;
}) {
  const textValue = value.trim() || placeholder;
  return (
    <View style={{ marginTop: 8 }}>
      <View style={styles.labelRow}>
        <Text style={[styles.label, { color: error ? "#dc2626" : (palette?.muted ?? "#465978") }]}>{label}</Text>
        {error ? (
          <View style={styles.errorIcon}>
            <Text style={styles.errorIconText}>i</Text>
          </View>
        ) : null}
      </View>
      <Pressable
        disabled={!editable}
        onPress={onPress}
        style={[
          styles.input,
          {
            borderColor: error ? "#ef4444" : (palette?.border ?? "#ccd8ea"),
            backgroundColor: palette?.panel ?? "#fdfefe",
            opacity: editable ? 1 : 0.7,
            justifyContent: "center",
          },
        ]}
      >
        <Text style={{ color: value.trim() ? (palette?.text ?? "#1b2a40") : (palette?.muted ?? "#6b7280") }}>
          {textValue}
        </Text>
      </Pressable>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

function CollapsibleSection({
  title,
  open,
  onToggle,
  children,
  palette,
  compact,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  palette: { panel: string; border: string; text: string; muted: string };
  compact: boolean;
}) {
  const isIOS = Platform.OS === "ios";
  return (
    <View style={[styles.section, isIOS ? styles.iosSection : null, { backgroundColor: palette.panel, borderColor: palette.border, padding: compact ? 10 : 12 }]}>
      <Pressable onPress={onToggle} style={styles.sectionHeader}>
        <Text style={[styles.sectionTitle, { color: palette.text }]}>{title}</Text>
        <Text style={[styles.sectionChevron, { color: palette.muted }]}>{open ? (isIOS ? "⌄" : "v") : ">"}</Text>
      </Pressable>
      {open ? <View style={styles.sectionBody}>{children}</View> : null}
    </View>
  );
}

export default function SubmissionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { palette, density } = useUiSettings();
  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<UserInfo | null>(null);
  const [lookups, setLookups] = useState<Lookups | null>(null);
  const [data, setData] = useState<SubmissionDetail | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [incidentTypes, setIncidentTypes] = useState<string[]>([]);
  const [immediateActions, setImmediateActions] = useState<string[]>([]);
  const [followUpActions, setFollowUpActions] = useState<string[]>([]);
  const [fieldErrors, setFieldErrors] = useState<FieldErrorMap>({});
  const [photoUrls, setPhotoUrls] = useState<Record<number, string>>({});
  const [failedPreviewIds, setFailedPreviewIds] = useState<Record<number, boolean>>({});
  const [fullscreenPhoto, setFullscreenPhoto] = useState<{ uri: string; name: string } | null>(null);
  const [reviewComment, setReviewComment] = useState("");
  const [enrichmentHint, setEnrichmentHint] = useState("");
  const [districtPickerOpen, setDistrictPickerOpen] = useState(false);
  const [countyPickerOpen, setCountyPickerOpen] = useState(false);
  const [routePickerOpen, setRoutePickerOpen] = useState(false);
  const [datePickerKey, setDatePickerKey] = useState<"report_date" | "date_incident_reported" | null>(null);
  const [calendarYear, setCalendarYear] = useState(() => new Date().getFullYear());
  const [calendarMonth, setCalendarMonth] = useState(() => new Date().getMonth());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [openSections, setOpenSections] = useState({
    header: false,
    location: false,
    incidentTypes: false,
    roadwayStatus: false,
    pavementSlope: false,
    actions: false,
    observations: false,
  });
  const apiBaseUrl = useMemo(() => getApiBaseUrl(), []);
  const isIOS = Platform.OS === "ios";
  const compact = density === "compact";
  const fullscreenProgress = useRef(new Animated.Value(0)).current;

  const mapPreviewUrl = useMemo(() => {
    const lat = Number(form.latitude);
    const lon = Number(form.longitude);
    if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
    const span = 0.006;
    const bbox = `${lon - span},${lat - span},${lon + span},${lat + span}`;
    return `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${encodeURIComponent(bbox)}&bboxSR=4326&imageSR=4326&size=1200,600&format=jpg&f=image`;
  }, [form.latitude, form.longitude]);

  const countyRouteOptions = useMemo(() => routesForCounty(form.county), [form.county]);
  const countiesForDistrict = useMemo(
    () => (form.district ? CALTRANS_COUNTIES.filter((c) => c.district === form.district) : CALTRANS_COUNTIES),
    [form.district]
  );
  const countyLabelValue = useMemo(() => countyDisplayLabel(form.county), [form.county]);

  const calendarDays = useMemo(() => {
    const firstDay = new Date(calendarYear, calendarMonth, 1).getDay();
    const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
    const cells: (number | null)[] = [];
    for (let i = 0; i < firstDay; i += 1) cells.push(null);
    for (let d = 1; d <= daysInMonth; d += 1) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [calendarYear, calendarMonth]);

  useEffect(() => {
    (async () => {
      const t = await getToken();
      setToken(t);
      if (!t) { Alert.alert("Not logged in", "Please log in again."); router.replace("/(auth)/login"); }
    })().catch(() => { Alert.alert("Auth error", "Please log in again."); router.replace("/(auth)/login"); });
  }, []);

  const hydratePhotoUrls = useCallback(async (authToken: string, photos: { id: number }[]) => {
    const next: Record<number, string> = {};
    await Promise.all(photos.map(async (p) => {
      try {
        const r = await apiFetch<{ download_url: string }>(`/attachments/${p.id}/download-url`, { token: authToken });
        next[p.id] = normalizeDownloadUrl(r.download_url, apiBaseUrl);
      } catch {}
    }));
    setPhotoUrls(next);
  }, [apiBaseUrl]);

  const load = useCallback(async () => {
    if (!token || !id) return;
    setLoading(true);
    try {
      const [meRes, subRes, lookRes] = await Promise.all([
        apiFetch<UserInfo>("/auth/me", { token }),
        getSubmission(token, id) as Promise<SubmissionDetail>,
        getGisaLookups(token) as Promise<Lookups>,
      ]);
      setMe(meRes); setData(subRes); setLookups(lookRes);
      const g = subRes.gisa || {};
      const countyCode = countyCodeFromNameOrCode(g.county ?? "");
      const districtValue = g.district ? String(g.district).padStart(2, "0") : (districtForCounty(countyCode) ?? "");
      setForm({
        ...EMPTY_FORM,
        report_date: g.report_date ?? "", district: districtValue, county: countyCode ?? "", route: g.route ?? "", post_mile: g.post_mile ?? "", ea: g.ea ?? "", project_id: g.project_id ?? "", date_incident_reported: g.date_incident_reported ?? "", district_contact: g.district_contact ?? "",
        latitude: g.latitude != null ? String(g.latitude) : "", longitude: g.longitude != null ? String(g.longitude) : "",
        distribution_code: g.distribution_code ?? "", highway_status_code: g.highway_status_code ?? "", lanes_closed_count: g.lanes_closed_count != null ? String(g.lanes_closed_count) : "",
        pavement_ground_cracks: boolToTri(g.pavement_ground_cracks), crack_length_ft: g.crack_length_ft != null ? String(g.crack_length_ft) : "", crack_horizontal_in: g.crack_horizontal_in != null ? String(g.crack_horizontal_in) : "", crack_vertical_in: g.crack_vertical_in != null ? String(g.crack_vertical_in) : "", crack_depth_in: g.crack_depth_in != null ? String(g.crack_depth_in) : "", settlement_in: g.settlement_in != null ? String(g.settlement_in) : "", bulge_in: g.bulge_in != null ? String(g.bulge_in) : "", indented_by_rocks: boolToTri(g.indented_by_rocks),
        observations_notes: g.observations_notes ?? "", geometry_json: g.geometry_json ? JSON.stringify(g.geometry_json, null, 2) : "",
      });
      setIncidentTypes(subRes.incident_types ?? []);
      setImmediateActions(subRes.actions?.immediate ?? []);
      setFollowUpActions(subRes.actions?.follow_up ?? []);
      setFieldErrors({});
      setReviewComment(subRes.submission.review_comment ?? "");
      await hydratePhotoUrls(token, subRes.photos ?? []);
    } catch (err: any) {
      if (isSessionExpiredError(err)) return;
      Alert.alert("Load failed", err?.message ?? "Unable to load submission");
    } finally {
      setLoading(false);
    }
  }, [token, id, hydratePhotoUrls]);

  useEffect(() => { load(); }, [load]);

  const setVal = (k: keyof FormState, v: any) => {
    setForm((p) => ({ ...p, [k]: v }));
    setFieldErrors((prev) => {
      if (!prev[k]) return prev;
      const next = { ...prev };
      delete next[k];
      return next;
    });
  };
  const toggle = (list: string[], code: string) => (list.includes(code) ? list.filter((x) => x !== code) : [...list, code]);
  const toggleSection = (key: keyof typeof openSections) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  function openDatePicker(key: "report_date" | "date_incident_reported") {
    const parsed = parseYmd(form[key]);
    const ref = parsed ?? new Date();
    setCalendarYear(ref.getFullYear());
    setCalendarMonth(ref.getMonth());
    setDatePickerKey(key);
  }

  function selectDate(day: number) {
    if (!datePickerKey) return;
    const next = new Date(calendarYear, calendarMonth, day);
    setVal(datePickerKey, toYmd(next));
    setDatePickerKey(null);
  }

  async function enrichRouteAndPostmile(lat: number, lon: number) {
    try {
      const geo = await enrichPointFromArcgisClient(lat, lon);
      const countyCode = countyCodeFromNameOrCode(geo.county ?? "");
      const district = geo.district ? String(geo.district).padStart(2, "0") : districtForCounty(countyCode);
      const route = geo.route?.trim() || "";
      const routeAllowed = countyCode ? routesForCounty(countyCode) : [];
      const normalizedRoute = route && (routeAllowed.length === 0 || routeAllowed.includes(route)) ? route : "";

      if (countyCode) setVal("county", countyCode);
      if (district) setVal("district", district);
      if (normalizedRoute) setVal("route", normalizedRoute);
      if (geo.post_mile?.trim()) setVal("post_mile", geo.post_mile.trim());

      if (geo.post_mile?.trim()) {
        setEnrichmentHint("Route and postmile auto-filled from ArcGIS.");
      } else if (normalizedRoute) {
        setEnrichmentHint("Route auto-filled from ArcGIS. Postmile unavailable at this point.");
      } else {
        setEnrichmentHint("ArcGIS enrichment ran, but no nearby route/postmile match was found.");
      }
    } catch {
      setEnrichmentHint("ArcGIS enrichment unavailable right now.");
    }
  }

  function validateRequiredFields(): boolean {
    const nextErrors: FieldErrorMap = {};
    const required: { key: keyof FormState; label: string; section: keyof typeof openSections }[] = [
      { key: "district", label: "District", section: "header" },
      { key: "county", label: "County", section: "header" },
      { key: "latitude", label: "Latitude", section: "location" },
      { key: "longitude", label: "Longitude", section: "location" },
    ];

    const sectionsToOpen = new Set<keyof typeof openSections>();
    for (const r of required) {
      const raw = String(form[r.key] ?? "").trim();
      if (!raw) {
        nextErrors[r.key] = `${r.label} is required.`;
        sectionsToOpen.add(r.section);
      }
    }

    setFieldErrors(nextErrors);
    if (sectionsToOpen.size > 0) {
      setOpenSections((prev) => ({
        ...prev,
        ...Object.fromEntries(Array.from(sectionsToOpen).map((s) => [s, true])),
      }));
      Alert.alert(
        "Almost there",
        "Please fill the highlighted required fields before continuing."
      );
      return false;
    }
    return true;
  }

  async function saveDraft() {
    if (!token || !id) return;
    if (!validateRequiredFields()) return;
    let geometry: any = null;
    if (form.geometry_json.trim()) {
      try {
        geometry = JSON.parse(form.geometry_json);
      } catch {
        setFieldErrors((prev) => ({ ...prev, geometry_json: "Geometry JSON is invalid." }));
        setOpenSections((prev) => ({ ...prev, location: true }));
        Alert.alert("Almost there", "Please fix the highlighted Geometry JSON field.");
        return;
      }
    }
    setBusy(true);
    try {
      await patchSubmission(token, id, {
        report_date: n(form.report_date), district: n(form.district), county: n(form.county), route: n(form.route), post_mile: n(form.post_mile), ea: n(form.ea), project_id: n(form.project_id), date_incident_reported: n(form.date_incident_reported), district_contact: n(form.district_contact),
        latitude: f(form.latitude, "Latitude"), longitude: f(form.longitude, "Longitude"),
        distribution_code: n(form.distribution_code), highway_status_code: n(form.highway_status_code), lanes_closed_count: i(form.lanes_closed_count, "Lanes closed count"),
        pavement_ground_cracks: triToBool(form.pavement_ground_cracks), crack_length_ft: f(form.crack_length_ft, "Crack length"), crack_horizontal_in: f(form.crack_horizontal_in, "Crack horizontal"), crack_vertical_in: f(form.crack_vertical_in, "Crack vertical"), crack_depth_in: f(form.crack_depth_in, "Crack depth"), settlement_in: f(form.settlement_in, "Settlement"), bulge_in: f(form.bulge_in, "Bulge"), indented_by_rocks: triToBool(form.indented_by_rocks),
        observations_notes: n(form.observations_notes), geometry_json: geometry,
      });
      await replaceIncidentTypes(token, id, incidentTypes);
      await replaceActions(token, id, { immediate: immediateActions, follow_up: followUpActions });
      Alert.alert("Saved", "Draft saved.");
      await load();
    } catch (err: any) {
      if (isSessionExpiredError(err)) return;
      Alert.alert("Save failed", err?.message ?? "Unable to save");
    } finally { setBusy(false); }
  }

  async function submitDraft() {
    if (!token || !id) return;
    if (!validateRequiredFields()) return;
    setBusy(true);
    try { await submitSubmission(token, id); Alert.alert("Submitted", "Sent for review."); await load(); }
    catch (err: any) { if (isSessionExpiredError(err)) return; Alert.alert("Submit failed", err?.message ?? "Unable to submit"); }
    finally { setBusy(false); }
  }

  async function review(decision: "APPROVE" | "REJECT") {
    if (!token || !id) return;
    setBusy(true);
    try { await reviewSubmission(token, id, decision, n(reviewComment) ?? undefined); Alert.alert("Updated", `Submission ${decision === "APPROVE" ? "approved" : "rejected"}.`); await load(); }
    catch (err: any) { if (isSessionExpiredError(err)) return; Alert.alert("Review failed", err?.message ?? "Unable to review"); }
    finally { setBusy(false); }
  }

  async function pickPhoto() {
    if (!token || !id) return;
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.85 });
    if (result.canceled) return;
    const asset = result.assets[0];
    const uri = asset.uri;
    const guessedName = asset.fileName || uri.split("/").pop() || "photo.jpg";
    const ext = (guessedName.split(".").pop() || "jpg").toLowerCase();
    const mimeType = asset.mimeType || (ext === "png" ? "image/png" : "image/jpeg");

    setBusy(true);
    try {
      const baseCandidates = [apiBaseUrl, ...getApiBaseCandidates()]
        .map((u) => u.replace(/\/+$/, ""))
        .filter((u, idx, arr) => arr.indexOf(u) === idx);
      let lastErr = "";
      let ok = false;

      for (const base of baseCandidates) {
        const formData = new FormData();
        formData.append("file", { uri, name: guessedName, type: mimeType } as any);
        try {
          const resp = await fetch(`${base}/submissions/${id}/photos`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: formData,
          });
          if (!resp.ok) {
            lastErr = `${resp.status} ${await resp.text().catch(() => "")}`;
            continue;
          }
          ok = true;
          break;
        } catch (err: any) {
          lastErr = String(err?.message ?? err);
        }
      }

      if (!ok) {
        throw new Error(
          `Could not reach upload endpoint. Last error: ${lastErr || "Network request failed"}.`
        );
      }

      await load();
    } catch (err: any) {
      if (isSessionExpiredError(err)) return;
      Alert.alert(
        "Photo upload failed",
        `${err?.message ?? "Unable to upload"}\n\nTip: For physical devices, set EXPO_PUBLIC_API_URL to your computer LAN IP (e.g. http://192.168.x.x:8000).`
      );
    }
    finally { setBusy(false); }
  }

  async function autofillLocation(opts?: { silent?: boolean }) {
    const silent = !!opts?.silent;
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        if (!silent) Alert.alert("Permission denied", "Location permission required.");
        return;
      }

      let playServicesUnavailable = false;
      if (Platform.OS === "android") {
        try {
          await Location.enableNetworkProviderAsync();
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          if (isPlayServicesUnavailableError(msg)) {
            playServicesUnavailable = true;
          }
        }
      }

      const servicesEnabled = await Location.hasServicesEnabledAsync();
      if (!servicesEnabled) {
        if (!silent) Alert.alert("Location disabled", "Enable location services and try again.");
        return;
      }

      const applyReverseGeocode = async (lat: number, lon: number) => {
        try {
          const list = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lon });
          const item = list?.[0];
          if (!item) return;
          const countyRaw = (item.subregion || "").replace(/\s+County$/i, "").trim();
          const countyCode = countyCodeFromNameOrCode(countyRaw);
          if (countyCode) setVal("county", countyCode);
          const guessedDistrict = districtForCounty(countyCode ?? countyRaw);
          if (guessedDistrict) setVal("district", guessedDistrict);
          const routeGuess = tryExtractRouteFromAddressLine([item.name, item.street, item.city].filter(Boolean).join(" "));
          if (routeGuess) {
            const options = routesForCounty(countyCode ?? "");
            if (options.length === 0 || options.includes(routeGuess)) {
              setVal("route", routeGuess);
            }
          }
        } catch {}
      };

      let usedImmediate = false;
      const lastKnown = await Location.getLastKnownPositionAsync({
        maxAge: 1000 * 60 * 60 * 24,
      });
      if (lastKnown) {
        setVal("latitude", String(lastKnown.coords.latitude));
        setVal("longitude", String(lastKnown.coords.longitude));
        await applyReverseGeocode(lastKnown.coords.latitude, lastKnown.coords.longitude);
        await enrichRouteAndPostmile(lastKnown.coords.latitude, lastKnown.coords.longitude);
        usedImmediate = true;
      }

      if (playServicesUnavailable && !usedImmediate) {
        if (!silent) {
          Alert.alert(
            "Location unavailable on this emulator",
            "This Android image does not have working Google Play Location Services. Use manual lat/lon entry, or run an emulator image with Google Play."
          );
        }
        return;
      }

      let fresh: Location.LocationObject | null = null;
      if (!playServicesUnavailable) {
        const fromCurrent = await Promise.race([
          Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
            mayShowUserSettingsDialog: true,
          }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
        ]);
        if (fromCurrent) {
          fresh = fromCurrent;
        } else {
          await new Promise<void>((resolve) => {
            let done = false;
            let subscription: Location.LocationSubscription | null = null;
            const finish = (next?: Location.LocationObject | null) => {
              if (done) return;
              done = true;
              if (subscription) subscription.remove();
              if (next) fresh = next;
              resolve();
            };
            Location.watchPositionAsync(
              {
                accuracy: Location.Accuracy.Balanced,
                timeInterval: 1000,
                distanceInterval: 0,
              },
              (next) => finish(next)
            )
              .then((sub) => {
                subscription = sub;
                setTimeout(() => finish(null), 15000);
              })
              .catch(() => finish(null));
          });
        }
      }

      if (fresh) {
        setVal("latitude", String(fresh.coords.latitude));
        setVal("longitude", String(fresh.coords.longitude));
        await applyReverseGeocode(fresh.coords.latitude, fresh.coords.longitude);
        await enrichRouteAndPostmile(fresh.coords.latitude, fresh.coords.longitude);
        return;
      }

      if (usedImmediate) {
        if (!silent) Alert.alert("Location captured", "Using recent location. GPS refresh is still pending.");
        return;
      }

      if (!lastKnown) {
        if (playServicesUnavailable) {
          if (!silent) {
            Alert.alert(
              "Location unavailable on this emulator",
              "This Android image does not have working Google Play Location Services. Use manual lat/lon entry, or run an emulator image with Google Play."
            );
          }
          return;
        }
        if (!silent) {
          Alert.alert(
            "Location unavailable",
            "Could not get location. In Android emulator, open Extended controls > Location and send a point."
          );
        }
        return;
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (isPlayServicesUnavailableError(msg)) {
        if (!silent) {
          Alert.alert(
            "Location unavailable on this emulator",
            "This Android image does not have working Google Play Location Services. Use manual lat/lon entry, or run an emulator image with Google Play."
          );
        }
        return;
      }
      if (!silent) Alert.alert("Location failed", msg || "Unable to fetch location.");
    }
  }

  const canEditCandidate =
    !!data &&
    !!me &&
    (data.submission.status === "DRAFT" || data.submission.status === "REJECTED") &&
    (me.roles?.includes("ADMIN") || (me.roles?.includes("FIELD_WORKER") && me.id === data.submission.created_by_user_id));

  useEffect(() => {
    if (!canEditCandidate) return;
    const hasLatLon = form.latitude.trim() && form.longitude.trim();
    if (hasLatLon) return;
    autofillLocation({ silent: true }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEditCandidate, form.latitude, form.longitude]);

  useEffect(() => {
    if (!canEditCandidate) return;
    const lat = Number(form.latitude);
    const lon = Number(form.longitude);
    if (Number.isNaN(lat) || Number.isNaN(lon)) return;
    if (form.route.trim() && form.post_mile.trim()) return;
    enrichRouteAndPostmile(lat, lon).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEditCandidate, form.latitude, form.longitude]);

  if (!token || loading || !data || !lookups || !me) return <View style={styles.center}><ActivityIndicator size="large" /></View>;
  const roles = new Set(me.roles || []);
  const isOwner = me.id === data.submission.created_by_user_id;
  const canEdit = (data.submission.status === "DRAFT" || data.submission.status === "REJECTED") && (roles.has("ADMIN") || (roles.has("FIELD_WORKER") && isOwner));
  const canReview = data.submission.status === "SUBMITTED" && (roles.has("REVIEWER") || roles.has("ADMIN"));
  const latestPhoto = data.photos.length ? data.photos[data.photos.length - 1] : null;
  const stepOrder = data.submission.status === "REJECTED"
    ? ["DRAFT", "SUBMITTED", "REJECTED"]
    : ["DRAFT", "SUBMITTED", "APPROVED"];
  const currentStepIdx = stepOrder.indexOf(data.submission.status);
  const submissionUpdatedAt = data?.submission.updated_at ?? "";
  const eventDate: Record<string, string> = {};
  for (const ev of data.workflow_events || []) {
    const key = String(ev.to_status || ev.event_type || "").toUpperCase();
    if (key && !eventDate[key]) eventDate[key] = ev.created_at;
  }

  function previewSource(photoId: number) {
    const queryToken = encodeURIComponent(token || "");
    return {
      uri: `${apiBaseUrl}/attachments/${photoId}/content?access_token=${queryToken}&ts=${encodeURIComponent(submissionUpdatedAt)}`,
    } as const;
  }

  async function openPhotoFallback(photoId: number) {
    const url = `${apiBaseUrl}/attachments/${photoId}/content?access_token=${encodeURIComponent(token || "")}&ts=${encodeURIComponent(submissionUpdatedAt)}`;
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert("Preview unavailable", "Could not open image URL on this device.");
    }
  }

  function openFullscreen(photoId: number, name: string) {
    const source = previewSource(photoId);
    if (!source?.uri) return;
    fullscreenProgress.setValue(0);
    setFullscreenPhoto({ uri: source.uri, name });
    requestAnimationFrame(() => {
      Animated.spring(fullscreenProgress, {
        toValue: 1,
        damping: 18,
        stiffness: 170,
        mass: 0.8,
        useNativeDriver: true,
      }).start();
    });
  }

  function closeFullscreen() {
    Animated.timing(fullscreenProgress, {
      toValue: 0,
      duration: 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(() => setFullscreenPhoto(null));
  }

  return (
    <View style={{ flex: 1, backgroundColor: palette.bg }}>
    <ScrollView
      style={[styles.container, { backgroundColor: palette.bg }]}
      contentInsetAdjustmentBehavior={isIOS ? "automatic" : "never"}
      keyboardDismissMode={isIOS ? "interactive" : "on-drag"}
      contentContainerStyle={[styles.contentWrap, { padding: compact ? 10 : 14, gap: compact ? 8 : 10 }]}
    >
      <Text style={[styles.title, { color: palette.text }]}>{buildSubmissionDescriptor({
        id: data.submission.id,
        created_at: data.submission.created_at,
        district: form.district || data.gisa?.district,
        county: form.county || data.gisa?.county,
        route: form.route || data.gisa?.route,
        post_mile: form.post_mile || data.gisa?.post_mile,
      })}</Text>
      <Text style={[styles.status, { color: palette.muted }]}>Status: {data.submission.status}</Text>
        <CollapsibleSection title="Header Info" open={openSections.header} onToggle={() => toggleSection("header")} palette={palette} compact={compact}>
        <SelectField
          palette={palette}
          label="Report Date (YYYY-MM-DD)"
          value={form.report_date}
          placeholder="Select date"
          editable={canEdit}
          onPress={() => openDatePicker("report_date")}
          error={fieldErrors.report_date}
        />
        <SelectField
          palette={palette}
          label="District *"
          value={form.district ? `District ${form.district}` : ""}
          placeholder="Select district"
          editable={canEdit}
          onPress={() => setDistrictPickerOpen(true)}
          error={fieldErrors.district}
        />
        <SelectField
          palette={palette}
          label="County *"
          value={countyLabelValue}
          placeholder={form.district ? "Select county" : "Select district first"}
          editable={canEdit && !!form.district}
          onPress={() => setCountyPickerOpen(true)}
          error={fieldErrors.county}
        />
        <SelectField
          palette={palette}
          label="Route"
          value={form.route}
          placeholder={form.county ? "Select route" : "Select county first"}
          editable={canEdit && !!form.county}
          onPress={() => setRoutePickerOpen(true)}
          error={fieldErrors.route}
        />
        <Field palette={palette} label="Post Mile" value={form.post_mile} editable={canEdit} onChangeText={(v) => setVal("post_mile", v)} error={fieldErrors.post_mile} />
        <Field palette={palette} label="EA" value={form.ea} editable={canEdit} onChangeText={(v) => setVal("ea", v)} error={fieldErrors.ea} />
        <Field palette={palette} label="Project ID" value={form.project_id} editable={canEdit} keyboardType="number-pad" onChangeText={(v) => setVal("project_id", v)} error={fieldErrors.project_id} />
        <SelectField
          palette={palette}
          label="Date Incident Reported (YYYY-MM-DD)"
          value={form.date_incident_reported}
          placeholder="Select date"
          editable={canEdit}
          onPress={() => openDatePicker("date_incident_reported")}
          error={fieldErrors.date_incident_reported}
        />
        <Field palette={palette} label="District Contact" value={form.district_contact} editable={canEdit} onChangeText={(v) => setVal("district_contact", v)} error={fieldErrors.district_contact} />
      </CollapsibleSection>

      <CollapsibleSection title="Location" open={openSections.location} onToggle={() => toggleSection("location")} palette={palette} compact={compact}>
        <Pressable
          style={[styles.mapPreviewCard, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}
          onPress={() =>
            router.push({
              pathname: "/(tabs)/submissions/map",
              params: {
                id: String(id ?? ""),
                latitude: form.latitude,
                longitude: form.longitude,
              },
            })
          }
          disabled={busy}
        >
          <Text style={[styles.label, { color: palette.muted }]}>Map Preview (Tap to Open)</Text>
          {mapPreviewUrl ? (
            <Image source={{ uri: mapPreviewUrl }} style={styles.locationMapPreview} />
          ) : (
            <Text style={[styles.muted, { color: palette.muted }]}>
              Fetching/awaiting location...
            </Text>
          )}
          <Text style={[styles.muted, { color: palette.muted }]}>
            Geometry: {form.geometry_json.trim() ? "Available" : "None"}
          </Text>
          {enrichmentHint ? (
            <Text style={[styles.muted, { color: palette.muted }]}>{enrichmentHint}</Text>
          ) : null}
        </Pressable>
        <Field palette={palette} label="Latitude *" value={form.latitude} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("latitude", v)} error={fieldErrors.latitude} />
        <Field palette={palette} label="Longitude *" value={form.longitude} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("longitude", v)} error={fieldErrors.longitude} />
      </CollapsibleSection>

      <CollapsibleSection title="Incident Types" open={openSections.incidentTypes} onToggle={() => toggleSection("incidentTypes")} palette={palette} compact={compact}>
        <View style={styles.chips}>
          {lookups.incident_types.map((o) => (
            <Chip key={o.code} label={o.label} palette={palette} active={incidentTypes.includes(o.code)} disabled={!canEdit} onPress={() => canEdit && setIncidentTypes((p) => toggle(p, o.code))} />
          ))}
        </View>
      </CollapsibleSection>

      <CollapsibleSection title="Roadway Status" open={openSections.roadwayStatus} onToggle={() => toggleSection("roadwayStatus")} palette={palette} compact={compact}>
        <Text style={styles.label}>Distribution</Text>
        <View style={styles.chips}>
          {lookups.distribution.map((o) => (
            <Chip key={o.code} label={o.label} palette={palette} active={form.distribution_code === o.code} disabled={!canEdit} onPress={() => canEdit && setVal("distribution_code", form.distribution_code === o.code ? "" : o.code)} />
          ))}
        </View>
        <Text style={styles.label}>Highway Status</Text>
        <View style={styles.chips}>
          {lookups.highway_status.map((o) => (
            <Chip key={o.code} label={o.label} palette={palette} active={form.highway_status_code === o.code} disabled={!canEdit} onPress={() => canEdit && setVal("highway_status_code", form.highway_status_code === o.code ? "" : o.code)} />
          ))}
        </View>
        <Field palette={palette} label="Lane(s) Closed Count" value={form.lanes_closed_count} editable={canEdit} keyboardType="number-pad" onChangeText={(v) => setVal("lanes_closed_count", v)} error={fieldErrors.lanes_closed_count} />
      </CollapsibleSection>

      <CollapsibleSection title="Pavement / Slope Condition" open={openSections.pavementSlope} onToggle={() => toggleSection("pavementSlope")} palette={palette} compact={compact}>
        <Text style={styles.label}>Pavement/Ground Cracks</Text>
        <View style={styles.chips}>{(["YES", "NO", "UNKNOWN"] as const).map((c) => <Chip key={c} label={c} palette={palette} active={form.pavement_ground_cracks === c} disabled={!canEdit} onPress={() => canEdit && setVal("pavement_ground_cracks", c)} />)}</View>
        <Field palette={palette} label="Crack Length (ft)" value={form.crack_length_ft} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("crack_length_ft", v)} error={fieldErrors.crack_length_ft} />
        <Field palette={palette} label="Crack Horizontal (in)" value={form.crack_horizontal_in} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("crack_horizontal_in", v)} error={fieldErrors.crack_horizontal_in} />
        <Field palette={palette} label="Crack Vertical (in)" value={form.crack_vertical_in} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("crack_vertical_in", v)} error={fieldErrors.crack_vertical_in} />
        <Field palette={palette} label="Crack Depth (in)" value={form.crack_depth_in} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("crack_depth_in", v)} error={fieldErrors.crack_depth_in} />
        <Field palette={palette} label="Settlement (in)" value={form.settlement_in} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("settlement_in", v)} error={fieldErrors.settlement_in} />
        <Field palette={palette} label="Bulge (in)" value={form.bulge_in} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("bulge_in", v)} error={fieldErrors.bulge_in} />
        <Text style={styles.label}>Indented by Rocks</Text>
        <View style={styles.chips}>{(["YES", "NO", "UNKNOWN"] as const).map((c) => <Chip key={c} label={c} palette={palette} active={form.indented_by_rocks === c} disabled={!canEdit} onPress={() => canEdit && setVal("indented_by_rocks", c)} />)}</View>
      </CollapsibleSection>

      <CollapsibleSection title="Actions" open={openSections.actions} onToggle={() => toggleSection("actions")} palette={palette} compact={compact}>
        <Text style={styles.label}>Immediate</Text>
        <View style={styles.chips}>{lookups.actions.immediate.map((o) => <Chip key={o.code} label={o.label} palette={palette} active={immediateActions.includes(o.code)} disabled={!canEdit} onPress={() => canEdit && setImmediateActions((p) => toggle(p, o.code))} />)}</View>
        <Text style={styles.label}>Follow-Up</Text>
        <View style={styles.chips}>{lookups.actions.follow_up.map((o) => <Chip key={o.code} label={o.label} palette={palette} active={followUpActions.includes(o.code)} disabled={!canEdit} onPress={() => canEdit && setFollowUpActions((p) => toggle(p, o.code))} />)}</View>
      </CollapsibleSection>

      <CollapsibleSection title="Observations" open={openSections.observations} onToggle={() => toggleSection("observations")} palette={palette} compact={compact}>
        <Field palette={palette} label="Notes" value={form.observations_notes} editable={canEdit} multiline onChangeText={(v) => setVal("observations_notes", v)} error={fieldErrors.observations_notes} />
      </CollapsibleSection>

      {canEdit ? (
          <View style={[styles.section, { backgroundColor: palette.panel, borderColor: palette.border, padding: compact ? 10 : 12 }]}>
            <Text style={styles.sectionTitle}>Draft Actions</Text>
            <Pressable style={[styles.btnPrimary, { backgroundColor: palette.primary }]} onPress={saveDraft} disabled={busy}><Text style={styles.btnPrimaryText}>{busy ? "Working..." : "Save Draft"}</Text></Pressable>
          <Pressable style={[styles.btnPrimary, { backgroundColor: palette.success, marginTop: 8 }]} onPress={submitDraft} disabled={busy}><Text style={styles.btnPrimaryText}>{busy ? "Working..." : (data.submission.status === "REJECTED" ? "Resubmit for Review" : "Submit for Review")}</Text></Pressable>
          <Pressable style={[styles.btnGhost, { marginTop: 8, borderColor: palette.border, backgroundColor: palette.panelSoft }]} onPress={pickPhoto} disabled={busy}><Text style={[styles.btnGhostText, { color: palette.text }]}>{busy ? "Working..." : "Upload Photo"}</Text></Pressable>
          <Text style={[styles.label, { marginTop: 12 }]}>Latest Photo Preview</Text>
          {!latestPhoto ? (
            <Text style={[styles.muted, { marginTop: 6 }]}>No photo uploaded yet.</Text>
          ) : (
            <View style={{ marginTop: 8 }}>
              <Text style={{ fontWeight: "600", color: palette.text, marginBottom: 4 }}>{latestPhoto.file_name}</Text>
              {!failedPreviewIds[latestPhoto.id] ? (
                <Pressable onPress={() => openFullscreen(latestPhoto.id, latestPhoto.file_name)}>
                  <Image
                    source={previewSource(latestPhoto.id)}
                    style={styles.photoPreviewCompact}
                    onError={() => setFailedPreviewIds((prev) => ({ ...prev, [latestPhoto.id]: true }))}
                  />
                </Pressable>
              ) : (
                <View>
                  <Text style={[styles.muted, { color: palette.muted }]}>In-app preview failed.</Text>
                  {!!photoUrls[latestPhoto.id] && (
                    <Pressable style={[styles.btnGhost, { marginTop: 8, borderColor: palette.border, backgroundColor: palette.panelSoft }]} onPress={() => openPhotoFallback(latestPhoto.id)}>
                      <Text style={[styles.btnGhostText, { color: palette.text }]}>Open Photo Link</Text>
                    </Pressable>
                  )}
                </View>
              )}
            </View>
          )}
        </View>
      ) : null}

      {canReview ? (
        <View style={[styles.section, { backgroundColor: palette.panel, borderColor: palette.border, padding: compact ? 10 : 12 }]}>
          <Text style={styles.sectionTitle}>Reviewer Decision</Text>
          <Field palette={palette} label="Review Comment" value={reviewComment} editable={!busy} multiline onChangeText={setReviewComment} />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable style={[styles.btnPrimary, { flex: 1, backgroundColor: palette.success }]} onPress={() => review("APPROVE")} disabled={busy}><Text style={styles.btnPrimaryText}>{busy ? "Working..." : "Approve"}</Text></Pressable>
            <Pressable style={[styles.btnPrimary, { flex: 1, backgroundColor: palette.danger }]} onPress={() => review("REJECT")} disabled={busy}><Text style={styles.btnPrimaryText}>{busy ? "Working..." : "Reject"}</Text></Pressable>
          </View>
        </View>
      ) : null}

      <View style={[styles.section, { backgroundColor: palette.panel, borderColor: palette.border, padding: compact ? 10 : 12 }]}>
        <Text style={styles.sectionTitle}>Photos</Text>
        {data.photos.length === 0 ? <Text style={styles.muted}>No photos uploaded.</Text> : data.photos.map((p) => (
          <View key={p.id} style={{ marginTop: 8 }}>
            <Text style={{ fontWeight: "600", color: palette.text, marginBottom: 4 }}>{p.file_name}</Text>
            {!failedPreviewIds[p.id] ? (
              <Pressable onPress={() => openFullscreen(p.id, p.file_name)}>
                <Image
                  source={previewSource(p.id)}
                  style={styles.photo}
                  onError={() => setFailedPreviewIds((prev) => ({ ...prev, [p.id]: true }))}
                />
              </Pressable>
            ) : (
              <View>
                <Text style={[styles.muted, { color: palette.muted }]}>In-app preview failed.</Text>
                {!!photoUrls[p.id] && (
                  <Pressable style={[styles.btnGhost, { marginTop: 8, borderColor: palette.border, backgroundColor: palette.panelSoft }]} onPress={() => openPhotoFallback(p.id)}>
                    <Text style={[styles.btnGhostText, { color: palette.text }]}>Open Photo Link</Text>
                  </Pressable>
                )}
              </View>
            )}
          </View>
        ))}
      </View>

      <View style={[styles.section, { backgroundColor: palette.panel, borderColor: palette.border, padding: compact ? 10 : 12 }]}>
        <Text style={styles.sectionTitle}>Workflow Status</Text>
        <View style={styles.workflowInlineWrap}>
          <View style={styles.workflowInlineTrack} />
          <View
            style={[
              styles.workflowInlineProgress,
              { width: `${((Math.max(0, currentStepIdx) + 1) / stepOrder.length) * 100}%` },
            ]}
          />
          {stepOrder.map((step, idx) => {
            const done = currentStepIdx >= idx;
            const leftPct = (idx / (stepOrder.length - 1)) * 100;
            return (
              <View key={step} style={[styles.workflowInlinePointWrap, { left: `${leftPct}%` }]}>
                <View style={[styles.workflowInlineDot, done ? styles.workflowInlineDotDone : null]} />
                <Text style={[styles.workflowInlineLabel, done ? styles.workflowInlineLabelDone : null]}>{idx + 1}</Text>
              </View>
            );
          })}
        </View>
        <Text style={[styles.muted, { marginTop: 6, color: palette.muted }]}>
          {stepOrder[currentStepIdx] || data.submission.status} {eventDate[stepOrder[currentStepIdx]] ? `• ${eventDate[stepOrder[currentStepIdx]]}` : ""}
        </Text>
      </View>
    </ScrollView>
    <Modal visible={districtPickerOpen} transparent animationType="fade" onRequestClose={() => setDistrictPickerOpen(false)}>
      <Pressable style={styles.pickerBackdrop} onPress={() => setDistrictPickerOpen(false)}>
        <Pressable style={[styles.pickerSheet, { backgroundColor: palette.panel, borderColor: palette.border }]}>
          <Text style={[styles.pickerTitle, { color: palette.text }]}>Select District</Text>
          <ScrollView style={{ maxHeight: 340 }}>
            {CALTRANS_DISTRICTS.map((d) => (
              <Pressable
                key={d}
                style={[styles.pickerItem, form.district === d ? { backgroundColor: palette.panelSoft } : null]}
                onPress={() => {
                  setForm((prev) => {
                    const countyMatch = prev.county
                      ? CALTRANS_COUNTIES.find((c) => c.code === prev.county)
                      : null;
                    const countyStillValid = !!countyMatch && countyMatch.district === d;
                    const nextCounty = countyStillValid ? prev.county : "";
                    const nextRoute =
                      countyStillValid && prev.route && countyMatch?.routes.includes(prev.route)
                        ? prev.route
                        : "";
                    return { ...prev, district: d, county: nextCounty, route: nextRoute };
                  });
                  setFieldErrors((prev) => {
                    const next = { ...prev };
                    delete next.district;
                    delete next.county;
                    delete next.route;
                    return next;
                  });
                  setDistrictPickerOpen(false);
                }}
              >
                <Text style={{ color: palette.text, fontWeight: "600" }}>{`District ${d}`}</Text>
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
          {form.district ? (
            <Text style={{ color: palette.muted, marginBottom: 6 }}>
              Showing counties in District {form.district}
            </Text>
          ) : null}
          <ScrollView style={{ maxHeight: 340 }}>
            {countiesForDistrict.map((c) => (
              <Pressable
                key={c.code}
                style={[styles.pickerItem, form.county === c.code ? { backgroundColor: palette.panelSoft } : null]}
                onPress={() => {
                  setVal("county", c.code);
                  setVal("district", c.district);
                  if (form.route && !c.routes.includes(form.route)) {
                    setVal("route", "");
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
          {!form.county ? (
            <Text style={{ color: palette.muted }}>Select county first.</Text>
          ) : null}
          <ScrollView style={{ maxHeight: 340 }}>
            {countyRouteOptions.map((r) => (
              <Pressable
                key={r}
                style={[styles.pickerItem, form.route === r ? { backgroundColor: palette.panelSoft } : null]}
                onPress={() => {
                  setVal("route", r);
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

    <Modal visible={!!datePickerKey} transparent animationType="fade" onRequestClose={() => setDatePickerKey(null)}>
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
              <Pressable key={`${day ?? "x"}-${idx}`} disabled={!day} onPress={() => day && selectDate(day)} style={[styles.calendarCell, !day ? { opacity: 0 } : null]}>
                <Text style={{ color: palette.text }}>{day ?? ""}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.calendarActions}>
            <Pressable
              onPress={() => {
                if (datePickerKey) setVal(datePickerKey, "");
                setDatePickerKey(null);
              }}
              style={[styles.calendarActionBtn, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}
            >
              <Text style={{ color: palette.text, fontWeight: "700" }}>Clear</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                if (datePickerKey) setVal(datePickerKey, toYmd(new Date()));
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
    <Modal visible={!!fullscreenPhoto} transparent animationType="none" onRequestClose={closeFullscreen}>
      <Pressable style={styles.fullscreenBackdrop} onPress={closeFullscreen}>
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFillObject,
            styles.fullscreenBackdropTint,
            { opacity: fullscreenProgress.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }) },
          ]}
        />
        <Animated.View
          style={[
            styles.fullscreenFrame,
            {
              opacity: fullscreenProgress.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
              transform: [
                { scale: fullscreenProgress.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) },
                { translateY: fullscreenProgress.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) },
              ],
            },
          ]}
        >
          {!!fullscreenPhoto && (
            <>
              <Image
                source={{ uri: fullscreenPhoto.uri, headers: { Authorization: `Bearer ${token}` } }}
                style={styles.fullscreenImage}
                resizeMode="contain"
              />
              <Text style={styles.fullscreenCaption}>{fullscreenPhoto.name}</Text>
            </>
          )}
        </Animated.View>
      </Pressable>
    </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Platform.OS === "ios" ? "#f2f2f7" : "#eef3fb" },
  contentWrap: { padding: 14, gap: 10, paddingBottom: Platform.OS === "ios" ? 34 : 28 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  title: { fontSize: Platform.OS === "ios" ? 22 : 24, fontWeight: "800", color: "#16253a", letterSpacing: Platform.OS === "ios" ? 0.2 : 0 },
  status: { marginTop: 4, marginBottom: 6, color: "#4b5f7f", fontWeight: Platform.OS === "ios" ? "600" : "700" },
  section: {
    backgroundColor: "#fff",
    borderRadius: Platform.OS === "ios" ? 12 : 14,
    borderWidth: Platform.OS === "ios" ? StyleSheet.hairlineWidth : 1,
    borderColor: "#d7e2f1",
    padding: 12,
    shadowColor: "#10233f",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: Platform.OS === "ios" ? 0.08 : 0.06,
    shadowRadius: Platform.OS === "ios" ? 8 : 10,
    elevation: Platform.OS === "ios" ? 0 : 1,
  },
  iosSection: {
    marginHorizontal: 2,
  },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionBody: { marginTop: 4 },
  sectionTitle: { fontWeight: Platform.OS === "ios" ? "700" : "800", color: "#1b2a40", fontSize: Platform.OS === "ios" ? 23 / 1.45 : 22 / 1.45, marginBottom: 4 },
  sectionChevron: { fontSize: Platform.OS === "ios" ? 18 : 16, color: "#6b7280", fontWeight: "700", marginBottom: 1 },
  labelRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  label: { color: "#465978", fontSize: 13, fontWeight: Platform.OS === "ios" ? "600" : "700" },
  errorIcon: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: "#ef4444",
    alignItems: "center",
    justifyContent: "center",
  },
  errorIconText: { color: "#fff", fontSize: 10, fontWeight: "800", lineHeight: 12 },
  errorText: { color: "#dc2626", fontSize: 11, marginTop: 4, fontWeight: "600" },
  input: {
    borderWidth: Platform.OS === "ios" ? StyleSheet.hairlineWidth : 1,
    borderColor: "#ccd8ea",
    borderRadius: Platform.OS === "ios" ? 10 : 8,
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === "ios" ? 10 : 8,
    color: "#1b2a40",
    backgroundColor: Platform.OS === "ios" ? "#f7f8fc" : "#fdfefe",
    fontSize: Platform.OS === "ios" ? 16 : 14,
  },
  inputDisabled: { backgroundColor: "#f9fafb", color: "#6b7280" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
  chip: { borderWidth: 1, borderColor: "#c8d5ea", borderRadius: 999, paddingVertical: 6, paddingHorizontal: 10, backgroundColor: "#f9fbff" },
  chipOn: { backgroundColor: "#dbeafe", borderColor: "#1d4ed8" },
  chipText: { color: "#334155", fontSize: 12, fontWeight: "700" },
  chipTextOn: { color: "#1d4ed8" },
  btnPrimary: { backgroundColor: "#1d4ed8", borderRadius: Platform.OS === "ios" ? 12 : 8, paddingVertical: Platform.OS === "ios" ? 12 : 10, alignItems: "center" },
  btnPrimaryText: { color: "#fff", fontWeight: "700" },
  btnGhost: { borderWidth: Platform.OS === "ios" ? StyleSheet.hairlineWidth : 1, borderColor: "#c8d5ea", borderRadius: Platform.OS === "ios" ? 12 : 8, paddingVertical: Platform.OS === "ios" ? 12 : 10, alignItems: "center", backgroundColor: "#f8fbff", marginTop: 8 },
  btnGhostText: { color: "#1f2937", fontWeight: "700" },
  mapPreviewCard: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    gap: 4,
  },
  locationMapPreview: {
    width: "100%",
    height: 180,
    borderRadius: 8,
    backgroundColor: "#dbe7f8",
    marginTop: 4,
    marginBottom: 4,
  },
  muted: { color: "#6f809d" },
  photoPreviewCompact: { width: "100%", height: 160, borderRadius: 8, backgroundColor: "#e5e7eb" },
  photo: { width: "100%", height: 220, borderRadius: 8, backgroundColor: "#e5e7eb" },
  eventRow: { borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 8, padding: 8, gap: 2, marginTop: 8 },
  workflowInlineWrap: { marginTop: 8, height: 28, justifyContent: "center", position: "relative" },
  workflowInlineTrack: { position: "absolute", left: 0, right: 0, height: 3, borderRadius: 2, backgroundColor: "#cbd5e1" },
  workflowInlineProgress: { position: "absolute", left: 0, height: 3, borderRadius: 2, backgroundColor: "#1d4ed8" },
  workflowInlinePointWrap: { position: "absolute", top: -8, width: 22, marginLeft: -11, alignItems: "center" },
  workflowInlineDot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1, borderColor: "#94a3b8", backgroundColor: "#fff" },
  workflowInlineDotDone: { backgroundColor: "#1d4ed8", borderColor: "#1d4ed8" },
  workflowInlineLabel: { marginTop: 2, fontSize: 10, color: "#64748b", fontWeight: "700" },
  workflowInlineLabelDone: { color: "#1e3a8a" },
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
  },
  fullscreenBackdrop: {
    flex: 1,
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  fullscreenBackdropTint: {
    backgroundColor: "rgba(8,14,24,0.92)",
  },
  fullscreenFrame: {
    width: "100%",
    maxWidth: 1100,
    alignItems: "center",
  },
  fullscreenImage: {
    width: "100%",
    height: "84%",
    maxHeight: 780,
    borderRadius: 12,
    backgroundColor: "#0b1220",
  },
  fullscreenCaption: {
    marginTop: 10,
    color: "#e5edff",
    fontSize: 13,
    fontWeight: "700",
  },
});


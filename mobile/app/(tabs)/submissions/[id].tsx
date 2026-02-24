import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, Alert, Image, ActivityIndicator, StyleSheet, Linking, Modal, Animated, Easing, Platform } from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";
import { useLocalSearchParams, router, useNavigation, usePathname } from "expo-router";

import { apiFetch, isSessionExpiredError } from "../../../src/api/client";
import { getApiBaseCandidates, getApiBaseUrl } from "../../../src/api/baseUrl";
import { getToken } from "../../../src/auth/tokenStore";
import { generateSubmissionGisaPdf, getGisaLookups, getSubmission, getSubmissionGisaPdf, patchSubmission, replaceActions, replaceIncidentTypes, reviewSubmission, submitSubmission } from "../../../src/api/submissions";
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
  submission: { id: number; created_by_user_id: number; title?: string | null; status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED"; created_at: string; updated_at: string; submitted_at?: string | null; reviewed_at?: string | null; review_comment?: string | null; can_edit?: boolean; can_manage_permissions?: boolean };
  gisa: any | null;
  incident_types: string[];
  actions: { immediate: string[]; follow_up: string[] };
  photos: { id: number; file_name: string; mime_type: string }[];
  workflow_events: { id: number; event_type: string; from_status?: string | null; to_status?: string | null; comment?: string | null; created_at: string }[];
};

type FormState = Record<string, string> & { pavement_ground_cracks: "UNKNOWN" | "YES" | "NO"; indented_by_rocks: "UNKNOWN" | "YES" | "NO" };
type DistrictContact = {
  id: string;
  first_name: string;
  last_name: string;
  s_number: string;
  phone: string;
  cell_phone: string;
};
type DraftEditorState = {
  form: FormState;
  incidentTypes: string[];
  immediateActions: string[];
  followUpActions: string[];
  districtContacts: DistrictContact[];
};
type DraftLocalCache = DraftEditorState & {
  version: number;
  submission_id: string;
  saved_at: string;
  server_updated_at?: string | null;
};
type FieldErrorMap = Partial<Record<keyof FormState, string>>;
const DRAFT_LOCAL_CACHE_VERSION = 1;
const EMPTY_FORM: FormState = {
  report_date: "", district: "", county: "", route: "", post_mile: "", ea: "", project_id: "", date_incident_reported: "", district_contact: "",
  latitude: "", longitude: "", distribution_code: "", highway_status_code: "", lanes_closed_count: "",
  crack_length_ft: "", crack_horizontal_in: "", crack_vertical_in: "", crack_depth_in: "", settlement_in: "", bulge_in: "",
  failure_rock_fall: "", failure_topple: "", failure_slide: "", failure_spread: "", failure_flow: "", failure_compound: "", failure_erosion: "", failure_surficial_failure: "", failure_scoured_toe: "", failure_washout: "",
  distribution_advancing: "", distribution_retrogressive: "", distribution_enlarging: "", distribution_widening: "", distribution_moving: "", distribution_confined: "",
  material_rock: "", material_soil: "", material_bedding: "", material_joints: "", material_fractures: "",
  est_soil_pct: "", est_clay_pct: "", est_silt_pct: "", est_sand_pct: "", est_gravel_pct: "",
  water_dry: "", water_moist: "", water_wet: "", water_flowing: "", water_seep: "", water_spring: "",
  vegetation_trees: "", vegetation_bushes_shrubs: "", vegetation_groundcover: "",
  drainage_clogged_inlet: "", drainage_compromised_drains: "", drainage_surface_runoff: "", drainage_torrent_surge_flood: "",
  impact_impacted_adj_utilities: "", impact_maybe_adj_utilities: "", impact_adj_utilities: "", impact_impacted_adj_properties: "", impact_maybe_adj_properties: "", impact_adj_properties: "", impact_impacted_adj_structure: "", impact_maybe_adj_structure: "", impact_adj_structure: "",
  measure_slope_height_ft: "", measure_original_slope_deg: "", measure_landslide_width_ft: "", measure_landslide_length_ft: "", measure_main_scarp_height_ft: "", measure_landslide_slope_deg: "", measure_roadway_length_ft: "", measure_roadway_width_ft: "",
  observations_notes: "", geometry_json: "", pavement_ground_cracks: "UNKNOWN", indented_by_rocks: "UNKNOWN",
};

const n = (v: string) => (v.trim() ? v.trim() : null);
const f = (v: string, name: string) => { if (!v.trim()) return null; const x = Number(v); if (Number.isNaN(x)) throw new Error(`${name} must be numeric`); return x; };
const i = (v: string, name: string) => { if (!v.trim()) return null; const x = Number(v); if (Number.isNaN(x) || !Number.isInteger(x)) throw new Error(`${name} must be a whole number`); return x; };
const triToBool = (v: "UNKNOWN" | "YES" | "NO") => (v === "YES" ? true : false);
const boolToTri = (v: any) => (v === true ? "YES" : v === false ? "NO" : "UNKNOWN");
const ynToBool = (v: string) => (v === "YES" ? true : v === "NO" ? false : null);
const boolToYn = (v: any) => (v === true ? "YES" : v === false ? "NO" : "");
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

function createEmptyDistrictContact(): DistrictContact {
  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    first_name: "",
    last_name: "",
    s_number: "",
    phone: "",
    cell_phone: "",
  };
}

function parseDistrictContacts(raw: string): DistrictContact[] {
  const value = (raw || "").trim();
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => ({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      first_name: String(item?.first_name ?? ""),
      last_name: String(item?.last_name ?? ""),
      s_number: String(item?.s_number ?? ""),
      phone: String(item?.phone ?? ""),
      cell_phone: String(item?.cell_phone ?? ""),
    }));
  } catch {
    return [
      {
        ...createEmptyDistrictContact(),
        first_name: value,
      },
    ];
  }
}

function serializeDistrictContacts(contacts: DistrictContact[]): string {
  const normalized = contacts
    .map((c) => ({
      first_name: c.first_name.trim(),
      last_name: c.last_name.trim(),
      s_number: c.s_number.trim(),
      phone: c.phone.trim(),
      cell_phone: c.cell_phone.trim(),
    }))
    .filter((c) => Object.values(c).some((v) => !!v));
  return normalized.length ? JSON.stringify(normalized) : "";
}

function draftCacheKey(submissionId: string): string {
  return `draft_local_cache:${submissionId}`;
}

async function getDraftCache(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function setDraftCache(key: string, value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, value);
  } catch {}
}

async function removeDraftCache(key: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {}
}

function normalizeCachedForm(raw: any): FormState {
  const next: FormState = { ...EMPTY_FORM, ...(raw || {}) };
  next.pavement_ground_cracks =
    raw?.pavement_ground_cracks === "YES" || raw?.pavement_ground_cracks === "NO" || raw?.pavement_ground_cracks === "UNKNOWN"
      ? raw.pavement_ground_cracks
      : "UNKNOWN";
  next.indented_by_rocks =
    raw?.indented_by_rocks === "YES" || raw?.indented_by_rocks === "NO" || raw?.indented_by_rocks === "UNKNOWN"
      ? raw.indented_by_rocks
      : "UNKNOWN";
  return next;
}

function normalizeCachedContacts(raw: any): DistrictContact[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => ({
    id: String(item?.id || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    first_name: String(item?.first_name ?? ""),
    last_name: String(item?.last_name ?? ""),
    s_number: String(item?.s_number ?? ""),
    phone: String(item?.phone ?? ""),
    cell_phone: String(item?.cell_phone ?? ""),
  }));
}

function normalizeCachedEditorState(raw: any): DraftEditorState {
  return {
    form: normalizeCachedForm(raw?.form),
    incidentTypes: Array.isArray(raw?.incidentTypes) ? raw.incidentTypes.map((x: any) => String(x)) : [],
    immediateActions: Array.isArray(raw?.immediateActions) ? raw.immediateActions.map((x: any) => String(x)) : [],
    followUpActions: Array.isArray(raw?.followUpActions) ? raw.followUpActions.map((x: any) => String(x)) : [],
    districtContacts: normalizeCachedContacts(raw?.districtContacts),
  };
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

function DropdownBlock({
  title,
  open,
  onToggle,
  children,
  palette,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  palette: { panel: string; border: string; text: string; muted: string };
}) {
  return (
    <View style={[styles.dropdownBlock, { backgroundColor: palette.panel, borderColor: palette.border }]}>
      <Pressable onPress={onToggle} style={styles.dropdownBlockHeader}>
        <Text style={[styles.dropdownBlockTitle, { color: palette.text }]}>{title}</Text>
        <Text style={[styles.sectionChevron, { color: palette.muted }]}>{open ? "v" : ">"}</Text>
      </Pressable>
      {open ? <View style={{ marginTop: 6 }}>{children}</View> : null}
    </View>
  );
}

export default function SubmissionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const navigation = useNavigation<any>();
  const pathname = usePathname();
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
  const [districtContacts, setDistrictContacts] = useState<DistrictContact[]>([]);
  const [openDistrictContactIds, setOpenDistrictContactIds] = useState<Record<string, boolean>>({});
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
    actions: false,
    observations: false,
  });
  const [openPaperBlocks, setOpenPaperBlocks] = useState({
    distributionMain: false,
    highwayStatusMain: false,
    incidentType: false,
    material: false,
    waterContent: false,
    pavementGroundStatus: false,
    vegetation: false,
    waterDrainage: false,
    measurements: false,
  });
  const apiBaseUrl = useMemo(() => getApiBaseUrl(), []);
  const isIOS = Platform.OS === "ios";
  const compact = density === "compact";
  const fullscreenProgress = useRef(new Animated.Value(0)).current;
  const cacheHydratedRef = useRef(false);
  const suppressCacheWriteRef = useRef(false);
  const serverSnapshotRef = useRef<string>("");

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

  const buildEditorState = useCallback(
    (overrides?: Partial<DraftEditorState>): DraftEditorState => ({
      form: overrides?.form ?? form,
      incidentTypes: overrides?.incidentTypes ?? incidentTypes,
      immediateActions: overrides?.immediateActions ?? immediateActions,
      followUpActions: overrides?.followUpActions ?? followUpActions,
      districtContacts: overrides?.districtContacts ?? districtContacts,
    }),
    [form, incidentTypes, immediateActions, followUpActions, districtContacts]
  );

  const applyEditorState = useCallback((state: DraftEditorState) => {
    setForm(state.form);
    setIncidentTypes(state.incidentTypes);
    setImmediateActions(state.immediateActions);
    setFollowUpActions(state.followUpActions);
    setDistrictContacts(state.districtContacts);
    setOpenDistrictContactIds(Object.fromEntries(state.districtContacts.map((c, idx) => [c.id, idx === 0])));
  }, []);

  const clearDraftLocalCache = useCallback(async () => {
    if (!id) return;
    await removeDraftCache(draftCacheKey(id));
  }, [id]);

  const hydratePhotoUrls = useCallback(async (authToken: string, photos: { id: number }[]) => {
    const next: Record<number, string> = {};
    await Promise.all(photos.map(async (p) => {
      next[p.id] = `${apiBaseUrl}/attachments/${p.id}/content?access_token=${encodeURIComponent(authToken)}`;
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
      const loadedDistrictContacts = parseDistrictContacts(g.district_contact ?? "");
      const countyCode = countyCodeFromNameOrCode(g.county ?? "");
      const districtValue = g.district ? String(g.district).padStart(2, "0") : (districtForCounty(countyCode) ?? "");
      const loadedForm: FormState = {
        ...EMPTY_FORM,
        report_date: g.report_date ?? "", district: districtValue, county: countyCode ?? "", route: g.route ?? "", post_mile: g.post_mile ?? "", ea: g.ea ?? "", project_id: g.project_id ?? "", date_incident_reported: g.date_incident_reported ?? "", district_contact: g.district_contact ?? "",
        latitude: g.latitude != null ? String(g.latitude) : "", longitude: g.longitude != null ? String(g.longitude) : "",
        distribution_code: g.distribution_code ?? "", highway_status_code: g.highway_status_code ?? "", lanes_closed_count: g.lanes_closed_count != null ? String(g.lanes_closed_count) : "",
        pavement_ground_cracks: boolToTri(g.pavement_ground_cracks), crack_length_ft: g.crack_length_ft != null ? String(g.crack_length_ft) : "", crack_horizontal_in: g.crack_horizontal_in != null ? String(g.crack_horizontal_in) : "", crack_vertical_in: g.crack_vertical_in != null ? String(g.crack_vertical_in) : "", crack_depth_in: g.crack_depth_in != null ? String(g.crack_depth_in) : "", settlement_in: g.settlement_in != null ? String(g.settlement_in) : "", bulge_in: g.bulge_in != null ? String(g.bulge_in) : "", indented_by_rocks: boolToTri(g.indented_by_rocks),
        failure_rock_fall: boolToYn(g.failure_rock_fall), failure_topple: boolToYn(g.failure_topple), failure_slide: boolToYn(g.failure_slide), failure_spread: boolToYn(g.failure_spread), failure_flow: boolToYn(g.failure_flow), failure_compound: boolToYn(g.failure_compound), failure_erosion: boolToYn(g.failure_erosion), failure_surficial_failure: boolToYn(g.failure_surficial_failure), failure_scoured_toe: boolToYn(g.failure_scoured_toe), failure_washout: boolToYn(g.failure_washout),
        distribution_advancing: boolToYn(g.distribution_advancing), distribution_retrogressive: boolToYn(g.distribution_retrogressive), distribution_enlarging: boolToYn(g.distribution_enlarging), distribution_widening: boolToYn(g.distribution_widening), distribution_moving: boolToYn(g.distribution_moving), distribution_confined: boolToYn(g.distribution_confined),
        material_rock: boolToYn(g.material_rock), material_soil: boolToYn(g.material_soil), material_bedding: boolToYn(g.material_bedding), material_joints: boolToYn(g.material_joints), material_fractures: boolToYn(g.material_fractures),
        est_soil_pct: g.est_soil_pct != null ? String(g.est_soil_pct) : "", est_clay_pct: g.est_clay_pct != null ? String(g.est_clay_pct) : "", est_silt_pct: g.est_silt_pct != null ? String(g.est_silt_pct) : "", est_sand_pct: g.est_sand_pct != null ? String(g.est_sand_pct) : "", est_gravel_pct: g.est_gravel_pct != null ? String(g.est_gravel_pct) : "",
        water_dry: boolToYn(g.water_dry), water_moist: boolToYn(g.water_moist), water_wet: boolToYn(g.water_wet), water_flowing: boolToYn(g.water_flowing), water_seep: boolToYn(g.water_seep), water_spring: boolToYn(g.water_spring),
        vegetation_trees: g.vegetation_trees ?? "", vegetation_bushes_shrubs: g.vegetation_bushes_shrubs ?? "", vegetation_groundcover: g.vegetation_groundcover ?? "",
        drainage_clogged_inlet: boolToYn(g.drainage_clogged_inlet), drainage_compromised_drains: boolToYn(g.drainage_compromised_drains), drainage_surface_runoff: boolToYn(g.drainage_surface_runoff), drainage_torrent_surge_flood: boolToYn(g.drainage_torrent_surge_flood),
        impact_impacted_adj_utilities: boolToYn(g.impact_impacted_adj_utilities), impact_maybe_adj_utilities: boolToYn(g.impact_maybe_adj_utilities), impact_adj_utilities: g.impact_adj_utilities ?? "", impact_impacted_adj_properties: boolToYn(g.impact_impacted_adj_properties), impact_maybe_adj_properties: boolToYn(g.impact_maybe_adj_properties), impact_adj_properties: g.impact_adj_properties ?? "", impact_impacted_adj_structure: boolToYn(g.impact_impacted_adj_structure), impact_maybe_adj_structure: boolToYn(g.impact_maybe_adj_structure), impact_adj_structure: g.impact_adj_structure ?? "",
        measure_slope_height_ft: g.measure_slope_height_ft != null ? String(g.measure_slope_height_ft) : "", measure_original_slope_deg: g.measure_original_slope_deg != null ? String(g.measure_original_slope_deg) : "", measure_landslide_width_ft: g.measure_landslide_width_ft != null ? String(g.measure_landslide_width_ft) : "", measure_landslide_length_ft: g.measure_landslide_length_ft != null ? String(g.measure_landslide_length_ft) : "", measure_main_scarp_height_ft: g.measure_main_scarp_height_ft != null ? String(g.measure_main_scarp_height_ft) : "", measure_landslide_slope_deg: g.measure_landslide_slope_deg != null ? String(g.measure_landslide_slope_deg) : "", measure_roadway_length_ft: g.measure_roadway_length_ft != null ? String(g.measure_roadway_length_ft) : "", measure_roadway_width_ft: g.measure_roadway_width_ft != null ? String(g.measure_roadway_width_ft) : "",
        observations_notes: g.observations_notes ?? "", geometry_json: g.geometry_json ? JSON.stringify(g.geometry_json, null, 2) : "",
      };
      const loadedState: DraftEditorState = {
        form: loadedForm,
        districtContacts: loadedDistrictContacts,
        incidentTypes: subRes.incident_types ?? [],
        immediateActions: subRes.actions?.immediate ?? [],
        followUpActions: subRes.actions?.follow_up ?? [],
      };

      suppressCacheWriteRef.current = true;
      applyEditorState(loadedState);
      serverSnapshotRef.current = JSON.stringify(loadedState);

      const isDraftEditable =
        (subRes.submission.status === "DRAFT" || subRes.submission.status === "REJECTED") &&
        !!subRes.submission.can_edit;
      if (isDraftEditable && id) {
        try {
          const rawCache = await getDraftCache(draftCacheKey(id));
          if (rawCache) {
            const parsed = JSON.parse(rawCache);
            if (Number(parsed?.version) === DRAFT_LOCAL_CACHE_VERSION) {
              const cachedState = normalizeCachedEditorState(parsed);
              const cachedSnapshot = JSON.stringify(cachedState);
              if (cachedSnapshot !== serverSnapshotRef.current) {
                const shouldRestore = await new Promise<boolean>((resolve) => {
                  Alert.alert(
                    "Unsaved Local Changes",
                    "Restore unsaved changes stored on this device for this draft?",
                    [
                      {
                        text: "Discard Local",
                        style: "destructive",
                        onPress: () => resolve(false),
                      },
                      {
                        text: "Restore",
                        onPress: () => resolve(true),
                      },
                    ],
                    { cancelable: false }
                  );
                });
                if (shouldRestore) {
                  applyEditorState(cachedState);
                } else {
                  await removeDraftCache(draftCacheKey(id));
                }
              } else {
                await removeDraftCache(draftCacheKey(id));
              }
            } else {
              await removeDraftCache(draftCacheKey(id));
            }
          }
        } catch {}
      } else if (id) {
        await removeDraftCache(draftCacheKey(id));
      }

      setTimeout(() => {
        suppressCacheWriteRef.current = false;
        cacheHydratedRef.current = true;
      }, 0);
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

  useEffect(() => {
    if (!id || !data || loading) return;
    if (!cacheHydratedRef.current || suppressCacheWriteRef.current) return;
    const isDraftEditable =
      (data.submission.status === "DRAFT" || data.submission.status === "REJECTED") &&
      !!data.submission.can_edit;
    if (!isDraftEditable) return;

    const editorState = buildEditorState();
    const snapshot = JSON.stringify(editorState);
    const key = draftCacheKey(id);

    if (serverSnapshotRef.current && snapshot === serverSnapshotRef.current) {
      removeDraftCache(key).catch(() => {});
      return;
    }

    const timer = setTimeout(() => {
      const payload: DraftLocalCache = {
        version: DRAFT_LOCAL_CACHE_VERSION,
        submission_id: String(id),
        saved_at: new Date().toISOString(),
        server_updated_at: data.submission.updated_at ?? null,
        ...editorState,
      };
      setDraftCache(key, JSON.stringify(payload)).catch(() => {});
    }, 400);

    return () => clearTimeout(timer);
  }, [
    id,
    data,
    loading,
    form,
    incidentTypes,
    immediateActions,
    followUpActions,
    districtContacts,
    buildEditorState,
  ]);

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
  const togglePaperBlock = (key: keyof typeof openPaperBlocks) => {
    setOpenPaperBlocks((prev) => ({ ...prev, [key]: !prev[key] }));
  };
  const contactDisplayName = (contact: DistrictContact, idx: number) => {
    const full = `${contact.first_name} ${contact.last_name}`.trim();
    return full || `Contact ${idx + 1}`;
  };
  const syncDistrictContacts = (nextContacts: DistrictContact[]) => {
    setDistrictContacts(nextContacts);
    setVal("district_contact", serializeDistrictContacts(nextContacts));
  };
  const addDistrictContact = () => {
    if (!canEdit) return;
    const nextContact = createEmptyDistrictContact();
    syncDistrictContacts([...districtContacts, nextContact]);
    setOpenDistrictContactIds((prev) => ({ ...prev, [nextContact.id]: true }));
  };
  const updateDistrictContact = (
    idToUpdate: string,
    field: "first_name" | "last_name" | "s_number" | "phone" | "cell_phone",
    value: string
  ) => {
    if (!canEdit) return;
    const next = districtContacts.map((contact) =>
      contact.id === idToUpdate ? { ...contact, [field]: value } : contact
    );
    syncDistrictContacts(next);
  };
  const toggleDistrictContact = (idToToggle: string) => {
    setOpenDistrictContactIds((prev) => ({ ...prev, [idToToggle]: !prev[idToToggle] }));
  };
  const removeDistrictContact = (idToRemove: string) => {
    if (!canEdit) return;
    const next = districtContacts.filter((contact) => contact.id !== idToRemove);
    syncDistrictContacts(next);
    setOpenDistrictContactIds((prev) => {
      const updated = { ...prev };
      delete updated[idToRemove];
      return updated;
    });
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
        failure_rock_fall: ynToBool(form.failure_rock_fall), failure_topple: ynToBool(form.failure_topple), failure_slide: ynToBool(form.failure_slide), failure_spread: ynToBool(form.failure_spread), failure_flow: ynToBool(form.failure_flow), failure_compound: ynToBool(form.failure_compound), failure_erosion: ynToBool(form.failure_erosion), failure_surficial_failure: ynToBool(form.failure_surficial_failure), failure_scoured_toe: ynToBool(form.failure_scoured_toe), failure_washout: ynToBool(form.failure_washout),
        distribution_advancing: ynToBool(form.distribution_advancing), distribution_retrogressive: ynToBool(form.distribution_retrogressive), distribution_enlarging: ynToBool(form.distribution_enlarging), distribution_widening: ynToBool(form.distribution_widening), distribution_moving: ynToBool(form.distribution_moving), distribution_confined: ynToBool(form.distribution_confined),
        material_rock: ynToBool(form.material_rock), material_soil: ynToBool(form.material_soil), material_bedding: ynToBool(form.material_bedding), material_joints: ynToBool(form.material_joints), material_fractures: ynToBool(form.material_fractures),
        est_soil_pct: f(form.est_soil_pct, "Estimated soil %"), est_clay_pct: f(form.est_clay_pct, "Estimated clay %"), est_silt_pct: f(form.est_silt_pct, "Estimated silt %"), est_sand_pct: f(form.est_sand_pct, "Estimated sand %"), est_gravel_pct: f(form.est_gravel_pct, "Estimated gravel %"),
        water_dry: ynToBool(form.water_dry), water_moist: ynToBool(form.water_moist), water_wet: ynToBool(form.water_wet), water_flowing: ynToBool(form.water_flowing), water_seep: ynToBool(form.water_seep), water_spring: ynToBool(form.water_spring),
        vegetation_trees: n(form.vegetation_trees), vegetation_bushes_shrubs: n(form.vegetation_bushes_shrubs), vegetation_groundcover: n(form.vegetation_groundcover),
        drainage_clogged_inlet: ynToBool(form.drainage_clogged_inlet), drainage_compromised_drains: ynToBool(form.drainage_compromised_drains), drainage_surface_runoff: ynToBool(form.drainage_surface_runoff), drainage_torrent_surge_flood: ynToBool(form.drainage_torrent_surge_flood),
        impact_impacted_adj_utilities: ynToBool(form.impact_impacted_adj_utilities), impact_maybe_adj_utilities: ynToBool(form.impact_maybe_adj_utilities), impact_adj_utilities: n(form.impact_adj_utilities), impact_impacted_adj_properties: ynToBool(form.impact_impacted_adj_properties), impact_maybe_adj_properties: ynToBool(form.impact_maybe_adj_properties), impact_adj_properties: n(form.impact_adj_properties), impact_impacted_adj_structure: ynToBool(form.impact_impacted_adj_structure), impact_maybe_adj_structure: ynToBool(form.impact_maybe_adj_structure), impact_adj_structure: n(form.impact_adj_structure),
        measure_slope_height_ft: f(form.measure_slope_height_ft, "Slope height"), measure_original_slope_deg: f(form.measure_original_slope_deg, "Original slope"), measure_landslide_width_ft: f(form.measure_landslide_width_ft, "Landslide width"), measure_landslide_length_ft: f(form.measure_landslide_length_ft, "Landslide length"), measure_main_scarp_height_ft: f(form.measure_main_scarp_height_ft, "Main scarp height"), measure_landslide_slope_deg: f(form.measure_landslide_slope_deg, "Landslide slope"), measure_roadway_length_ft: f(form.measure_roadway_length_ft, "Roadway length"), measure_roadway_width_ft: f(form.measure_roadway_width_ft, "Roadway width"),
        observations_notes: n(form.observations_notes), geometry_json: geometry,
      });
      await replaceIncidentTypes(token, id, incidentTypes);
      await replaceActions(token, id, { immediate: immediateActions, follow_up: followUpActions });
      Alert.alert("Saved", "Draft saved.");
      await clearDraftLocalCache();
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
    try {
      await submitSubmission(token, id);
      Alert.alert("Submitted", "Sent for review.");
      await clearDraftLocalCache();
      await load();
    }
    catch (err: any) {
      if (isSessionExpiredError(err)) return;
      const raw = String(err?.message ?? "Unable to submit");
      let detail = raw;
      const jsonMatch = raw.match(/:\s*(\{.*\})\s*$/);
      if (jsonMatch?.[1]) {
        try {
          const parsed = JSON.parse(jsonMatch[1]);
          if (parsed?.detail) detail = String(parsed.detail);
        } catch {}
      }
      const missingMatch = detail.match(/missing required fields \[([^\]]+)\]/i);
      if (missingMatch?.[1]) {
        const missing = missingMatch[1]
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean);
        if (missing.length === 1 && missing[0].toLowerCase() === "photo") {
          Alert.alert("Cannot Submit Yet", "Please upload at least one photo before submitting.");
          return;
        }
        Alert.alert(
          "Cannot Submit Yet",
          `Please complete required items before submitting: ${missing.join(", ")}.`
        );
        return;
      }
      Alert.alert("Submit failed", detail || "Unable to submit");
    }
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
    !!data.submission.can_edit;

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

  const draftEntryStatus = pathname.startsWith("/drafts/");
  useLayoutEffect(() => {
    if (!data) return;
    navigation.setOptions({
      title: draftEntryStatus ? "Draft" : "Submission",
      gestureEnabled: !draftEntryStatus,
      headerLeft: draftEntryStatus
        ? () => (
            <Pressable onPress={() => router.replace("/(tabs)/drafts")} style={{ paddingHorizontal: 6, paddingVertical: 2 }}>
              <Text style={{ color: palette.primary, fontWeight: "700" }}>Back</Text>
            </Pressable>
          )
        : undefined,
    });
  }, [data, draftEntryStatus, navigation, palette.primary]);

  useEffect(() => {
    if (!data || !draftEntryStatus) return;
    const unsub = navigation.addListener("beforeRemove", (e: any) => {
      const actionType = String(e?.data?.action?.type || "");
      if (!["GO_BACK", "POP", "POP_TO_TOP"].includes(actionType)) return;
      e.preventDefault();
      router.replace("/(tabs)/drafts");
    });
    return unsub;
  }, [data, draftEntryStatus, navigation]);

  if (!token || loading || !data || !lookups || !me) return <View style={styles.center}><ActivityIndicator size="large" /></View>;
  const roles = new Set(me.roles || []);
  const canEdit = (data.submission.status === "DRAFT" || data.submission.status === "REJECTED") && !!data.submission.can_edit;
  const canReview = data.submission.status === "SUBMITTED" && (roles.has("REVIEWER") || roles.has("ADMIN"));
  const isDraftEntry = draftEntryStatus;
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
  const failureKeys = ["failure_rock_fall", "failure_topple", "failure_slide", "failure_spread", "failure_flow", "failure_compound", "failure_erosion", "failure_surficial_failure", "failure_scoured_toe", "failure_washout"];
  const materialKeys = ["material_rock", "material_soil", "material_bedding", "material_joints", "material_fractures"];
  const anyFailureSelected = failureKeys.some((k) => form[k] === "YES");
  const anyMaterialSelected = materialKeys.some((k) => form[k] === "YES");
  const materialRockSelected = form.material_rock === "YES";
  const materialSoilSelected = form.material_soil === "YES";
  const waterFlowingSelected = form.water_flowing === "YES";
  const highwayLanesClosedSelected = form.highway_status_code === "LANES_CLOSED";
  const closeHighwayEnabled = immediateActions.includes("CLOSE_ONE_DIRECTION") || immediateActions.includes("CLOSE_BOTH_DIRECTIONS");
  const openHighwayTrafficSelected = immediateActions.includes("OPEN_HIGHWAY_TRAFFIC") || followUpActions.includes("OPEN_HIGHWAY_TRAFFIC");
  const recommendedActions: { key: string; label: string; code?: string; immediate: boolean; followUp: boolean }[] = [
    { key: "OPEN_HIGHWAY_TRAFFIC", label: "Open Highway Traffic", code: "OPEN_HIGHWAY_TRAFFIC", immediate: true, followUp: true },
    { key: "CLOSE_HIGHWAY_SHOULDER", label: "Open Highway Shoulder", code: "CLOSE_HIGHWAY_SHOULDER", immediate: true, followUp: true },
    { key: "CLOSE_HIGHWAY_PARENT", label: "Close Highway", immediate: true, followUp: false },
    { key: "REMOVE_DEBRIS", label: "Remove Landslide Debris from the Highway", code: "REMOVE_DEBRIS", immediate: true, followUp: false },
    { key: "PLACE_K_RAIL", label: "Place K-Rail or Fence", code: "PLACE_K_RAIL", immediate: true, followUp: false },
    { key: "COVER_SLOPE_PLASTIC", label: "Cover Slope with Plastic", code: "COVER_SLOPE_PLASTIC", immediate: true, followUp: false },
    { key: "DIVERT_SURFACE_WATER", label: "Divert Surface Water Runoff", code: "DIVERT_SURFACE_WATER", immediate: true, followUp: false },
    { key: "REMOVE_CULVERT_BLOCKAGE", label: "Remove Culvert Blockage", code: "REMOVE_CULVERT_BLOCKAGE", immediate: true, followUp: false },
    { key: "DEWATER", label: "Dewater with Pump, Trench, etc.", code: "DEWATER", immediate: true, followUp: false },
    { key: "DEWATER_HORIZONTAL_DRAINS", label: "Dewater with Horizontal Drains", code: "DEWATER_HORIZONTAL_DRAINS", immediate: true, followUp: true },
    { key: "TEMP_SHORING", label: "Construct Temporary Shoring", code: "TEMP_SHORING", immediate: true, followUp: true },
    { key: "BUTTRESS_TOE", label: "Buttress Toe of Landslide", code: "BUTTRESS_TOE", immediate: true, followUp: true },
    { key: "PLACE_ROCK_SLOPE_PROTECTION", label: "Place Rock Slope Protection (ref. Manual)", code: "PLACE_ROCK_SLOPE_PROTECTION", immediate: true, followUp: true },
    { key: "ROUTINE_VISUAL_MONITOR", label: "Routine Visual Monitor", code: "ROUTINE_VISUAL_MONITOR", immediate: true, followUp: true },
    { key: "RECONSTRUCT_SLOPE", label: "Reconstruct Slope to Original Condition", code: "RECONSTRUCT_SLOPE", immediate: true, followUp: true },
    { key: "RECONSTRUCT_SLOPE_GEOSYNTHETICS", label: "Reconstruct Slope with Geosynthetics", code: "RECONSTRUCT_SLOPE_GEOSYNTHETICS", immediate: true, followUp: true },
    { key: "REPAIR_CULVERT_DRAINAGE_PIPE", label: "Repair Culvert/Drainage Pipe", code: "REPAIR_CULVERT_DRAINAGE_PIPE", immediate: false, followUp: true },
    { key: "EROSION_CONTROL", label: "Install Erosion Control - by Dist. Landscape", code: "EROSION_CONTROL", immediate: false, followUp: true },
    { key: "SURVEY_SITE_DIST_SURVEY", label: "Survey the Site - by Dist. Survey", code: "SURVEY_SITE_DIST_SURVEY", immediate: false, followUp: true },
    { key: "GEOLOGIC_MAPPING", label: "Perform Geological Mapping", code: "GEOLOGIC_MAPPING", immediate: false, followUp: true },
    { key: "SUBSURFACE_EXPLORATION", label: "Perform Subsurface Exploration", code: "SUBSURFACE_EXPLORATION", immediate: false, followUp: true },
    { key: "DETAILED_DESIGN_PLANS", label: "Perform Detailed Design & Produce Plans", code: "DETAILED_DESIGN_PLANS", immediate: false, followUp: true },
  ];

  const toggleActionByGroup = (code: string, group: "IMMEDIATE" | "FOLLOW_UP") => {
    if (!canEdit) return;
    if (group === "IMMEDIATE") {
      setImmediateActions((prev) => (prev.includes(code) ? prev.filter((x) => x !== code) : [...prev, code]));
      return;
    }
    setFollowUpActions((prev) => (prev.includes(code) ? prev.filter((x) => x !== code) : [...prev, code]));
  };

  const toggleCloseHighwayParent = () => {
    if (!canEdit) return;
    if (closeHighwayEnabled) {
      setImmediateActions((prev) => prev.filter((x) => x !== "CLOSE_ONE_DIRECTION" && x !== "CLOSE_BOTH_DIRECTIONS"));
      return;
    }
    setImmediateActions((prev) => (prev.includes("CLOSE_ONE_DIRECTION") ? prev : [...prev, "CLOSE_ONE_DIRECTION"]));
  };

  const toggleCloseHighwayDirection = (code: "CLOSE_ONE_DIRECTION" | "CLOSE_BOTH_DIRECTIONS") => {
    if (!canEdit) return;
    setImmediateActions((prev) => {
      const base = prev.filter((x) => x !== "CLOSE_ONE_DIRECTION" && x !== "CLOSE_BOTH_DIRECTIONS");
      if (prev.includes(code)) return base;
      return [...base, code];
    });
  };
  const setImpactSelection = (
    impactedKey: "impact_impacted_adj_utilities" | "impact_impacted_adj_properties" | "impact_impacted_adj_structure",
    maybeKey: "impact_maybe_adj_utilities" | "impact_maybe_adj_properties" | "impact_maybe_adj_structure",
    target: "IMPACTED" | "MAYBE"
  ) => {
    if (!canEdit) return;
    if (target === "IMPACTED") {
      const next = form[impactedKey] === "YES" ? "" : "YES";
      setVal(impactedKey as keyof FormState, next);
      if (next === "YES") setVal(maybeKey as keyof FormState, "");
      return;
    }
    const next = form[maybeKey] === "YES" ? "" : "YES";
    setVal(maybeKey as keyof FormState, next);
    if (next === "YES") setVal(impactedKey as keyof FormState, "");
  };

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

  async function generateGisaPdf() {
    if (!token || !id) return;
    setBusy(true);
    try {
      const resp = await generateSubmissionGisaPdf(token, id);
      const url = `${apiBaseUrl}/attachments/${resp.attachment_id}/content?access_token=${encodeURIComponent(token)}`;
      await Linking.openURL(url);
    } catch (err: any) {
      if (isSessionExpiredError(err)) return;
      Alert.alert("PDF generation failed", err?.message ?? "Unable to generate GISA PDF");
    } finally {
      setBusy(false);
    }
  }

  async function openLatestGisaPdf() {
    if (!token || !id) return;
    setBusy(true);
    try {
      const resp = await getSubmissionGisaPdf(token, id);
      const url = `${apiBaseUrl}/attachments/${resp.attachment_id}/content?access_token=${encodeURIComponent(token)}`;
      await Linking.openURL(url);
    } catch (err: any) {
      if (isSessionExpiredError(err)) return;
      Alert.alert("No PDF yet", "Generate the GISA PDF first, then open it.");
    } finally {
      setBusy(false);
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
      <Text style={[styles.title, { color: palette.text }]}>{isDraftEntry ? "Draft" : "Submission"}</Text>
      <Text style={[styles.muted, { color: palette.muted }]}>
        {buildSubmissionDescriptor({
          id: data.submission.id,
          created_at: data.submission.created_at,
          district: form.district || data.gisa?.district,
          county: form.county || data.gisa?.county,
          route: form.route || data.gisa?.route,
          post_mile: form.post_mile || data.gisa?.post_mile,
        })}
      </Text>
      <Text style={[styles.status, { color: palette.muted }]}>Status: {data.submission.status}</Text>
        <CollapsibleSection title="GISA Header" open={openSections.header} onToggle={() => toggleSection("header")} palette={palette} compact={compact}>
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
        <Text style={styles.label}>District Contacts</Text>
        {districtContacts.length === 0 ? (
          <Text style={[styles.muted, { marginTop: 6, color: palette.muted }]}>No district contacts added yet.</Text>
        ) : (
          districtContacts.map((contact, idx) => {
            const isOpen = !!openDistrictContactIds[contact.id];
            return (
              <View key={contact.id} style={[styles.contactCard, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}>
                <Pressable style={styles.contactCardHeader} onPress={() => toggleDistrictContact(contact.id)}>
                  <Text style={[styles.contactCardTitle, { color: palette.text }]}>{contactDisplayName(contact, idx)}</Text>
                  <Text style={[styles.sectionChevron, { color: palette.muted }]}>{isOpen ? "v" : ">"}</Text>
                </Pressable>
                {isOpen ? (
                  <View style={{ marginTop: 6 }}>
                    <Field palette={palette} label="First Name" value={contact.first_name} editable={canEdit} onChangeText={(v) => updateDistrictContact(contact.id, "first_name", v)} />
                    <Field palette={palette} label="Last Name" value={contact.last_name} editable={canEdit} onChangeText={(v) => updateDistrictContact(contact.id, "last_name", v)} />
                    <Field palette={palette} label="S Number" value={contact.s_number} editable={canEdit} onChangeText={(v) => updateDistrictContact(contact.id, "s_number", v)} />
                    <Field palette={palette} label="Phone" value={contact.phone} editable={canEdit} onChangeText={(v) => updateDistrictContact(contact.id, "phone", v)} />
                    <Field palette={palette} label="Cell Phone" value={contact.cell_phone} editable={canEdit} onChangeText={(v) => updateDistrictContact(contact.id, "cell_phone", v)} />
                    {canEdit ? (
                      <Pressable
                        style={[styles.btnGhost, { marginTop: 10, borderColor: palette.border, backgroundColor: palette.panel }]}
                        onPress={() => removeDistrictContact(contact.id)}
                      >
                        <Text style={[styles.btnGhostText, { color: palette.danger }]}>Remove Contact</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}
              </View>
            );
          })
        )}
        {fieldErrors.district_contact ? <Text style={styles.errorText}>{fieldErrors.district_contact}</Text> : null}
        <Pressable
          style={[styles.btnGhost, { marginTop: 10, borderColor: palette.border, backgroundColor: palette.panelSoft }]}
          onPress={addDistrictContact}
          disabled={!canEdit}
        >
          <Text style={[styles.btnGhostText, { color: palette.text }]}>Add District Contact</Text>
        </Pressable>
      </CollapsibleSection>

      <CollapsibleSection title="Location" open={openSections.location} onToggle={() => toggleSection("location")} palette={palette} compact={compact}>
        <Pressable
          style={[styles.mapPreviewCard, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}
          onPress={() =>
            router.push({
              pathname: (isDraftEntry ? "/(tabs)/drafts/map" : "/(tabs)/submissions/map") as any,
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

      <View>
        <View style={{ gap: compact ? 8 : 10 }}>
        <DropdownBlock title="Distribution" open={openPaperBlocks.distributionMain} onToggle={() => togglePaperBlock("distributionMain")} palette={palette}>
          <View style={styles.chips}>
            {lookups.distribution.map((o) => (
              <Chip key={o.code} label={o.label} palette={palette} active={form.distribution_code === o.code} disabled={!canEdit} onPress={() => canEdit && setVal("distribution_code", form.distribution_code === o.code ? "" : o.code)} />
            ))}
          </View>
        </DropdownBlock>

        <DropdownBlock title="Highway Status" open={openPaperBlocks.highwayStatusMain} onToggle={() => togglePaperBlock("highwayStatusMain")} palette={palette}>
          <View style={styles.chips}>
            {lookups.highway_status.map((o) => (
              <Chip
                key={o.code}
                label={o.label}
                palette={palette}
                active={form.highway_status_code === o.code}
                disabled={!canEdit}
                onPress={() => {
                  if (!canEdit) return;
                  const next = form.highway_status_code === o.code ? "" : o.code;
                  setVal("highway_status_code", next);
                  if (next !== "LANES_CLOSED") setVal("lanes_closed_count", "");
                }}
              />
            ))}
          </View>
          {highwayLanesClosedSelected ? (
            <Field
              palette={palette}
              label="Lane(s) Closed Count"
              value={form.lanes_closed_count}
              editable={canEdit}
              keyboardType="number-pad"
              onChangeText={(v) => setVal("lanes_closed_count", v)}
              error={fieldErrors.lanes_closed_count}
            />
          ) : null}
        </DropdownBlock>

        <DropdownBlock title="Incident Type" open={openPaperBlocks.incidentType} onToggle={() => togglePaperBlock("incidentType")} palette={palette}>
          <View style={styles.chips}>
            {[
              ["failure_rock_fall", "Rock Fall"], ["failure_topple", "Topple"], ["failure_slide", "Slide"], ["failure_spread", "Spread"], ["failure_flow", "Flow"],
              ["failure_compound", "Compound"], ["failure_erosion", "Erosion"], ["failure_surficial_failure", "Surficial Failure"], ["failure_scoured_toe", "Scoured Toe"], ["failure_washout", "Washout"],
            ].map(([key, label]) => (
              <Chip key={key} label={label} palette={palette} active={form[key] === "YES"} disabled={!canEdit} onPress={() => canEdit && setVal(key as keyof FormState, form[key] === "YES" ? "NO" : "YES")} />
            ))}
          </View>
        </DropdownBlock>

        <DropdownBlock title="Material" open={openPaperBlocks.material} onToggle={() => togglePaperBlock("material")} palette={palette}>
          <View style={styles.chips}>
            {[["material_rock", "Rock"], ["material_soil", "Soil"]].map(([key, label]) => (
              <Chip key={key} label={label} palette={palette} active={form[key] === "YES"} disabled={!canEdit} onPress={() => canEdit && setVal(key as keyof FormState, form[key] === "YES" ? "NO" : "YES")} />
            ))}
          </View>
          {materialRockSelected ? (
            <View style={styles.chips}>
              {[["material_bedding", "Bedding"], ["material_joints", "Joints"], ["material_fractures", "Fractures"]].map(([key, label]) => (
                <Chip key={key} label={label} palette={palette} active={form[key] === "YES"} disabled={!canEdit} onPress={() => canEdit && setVal(key as keyof FormState, form[key] === "YES" ? "NO" : "YES")} />
              ))}
            </View>
          ) : null}
          {materialSoilSelected ? (
            <View>
              <Field palette={palette} label="Clay Est %" value={form.est_clay_pct} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("est_clay_pct", v)} />
              <Field palette={palette} label="Silt Est %" value={form.est_silt_pct} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("est_silt_pct", v)} />
              <Field palette={palette} label="Sand Est %" value={form.est_sand_pct} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("est_sand_pct", v)} />
              <Field palette={palette} label="Gravel Est %" value={form.est_gravel_pct} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("est_gravel_pct", v)} />
            </View>
          ) : null}
        </DropdownBlock>

        <DropdownBlock title="Pavement / Ground Status" open={openPaperBlocks.pavementGroundStatus} onToggle={() => togglePaperBlock("pavementGroundStatus")} palette={palette}>
          <Text style={styles.label}>Pavement/Ground Cracks</Text>
          <View style={styles.chips}>
            {(["YES", "NO", "UNKNOWN"] as const).map((c) => (
              <Chip
                key={`cracks-${c}`}
                label={c}
                palette={palette}
                active={form.pavement_ground_cracks === c}
                disabled={!canEdit}
                onPress={() => {
                  if (!canEdit) return;
                  setVal("pavement_ground_cracks", c);
                  if (c !== "YES") {
                    setVal("crack_length_ft", "");
                    setVal("crack_horizontal_in", "");
                    setVal("crack_vertical_in", "");
                    setVal("crack_depth_in", "");
                    setVal("settlement_in", "");
                    setVal("bulge_in", "");
                  }
                }}
              />
            ))}
          </View>
          {form.pavement_ground_cracks === "YES" ? (
            <>
              <Field palette={palette} label="Length (feet)" value={form.crack_length_ft} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("crack_length_ft", v)} error={fieldErrors.crack_length_ft} />
              <Field palette={palette} label="Horizontal Disp (inches)" value={form.crack_horizontal_in} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("crack_horizontal_in", v)} error={fieldErrors.crack_horizontal_in} />
              <Field palette={palette} label="Vertical Disp (inches)" value={form.crack_vertical_in} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("crack_vertical_in", v)} error={fieldErrors.crack_vertical_in} />
              <Field palette={palette} label="Depth of Crack (inches)" value={form.crack_depth_in} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("crack_depth_in", v)} error={fieldErrors.crack_depth_in} />
            </>
          ) : null}
          <Field palette={palette} label="Settlement (inches)" value={form.settlement_in} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("settlement_in", v)} error={fieldErrors.settlement_in} />
          <Field palette={palette} label="Bulge (inches)" value={form.bulge_in} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("bulge_in", v)} error={fieldErrors.bulge_in} />
          <Text style={styles.label}>Indented by Rocks</Text>
          <View style={styles.chips}>
            {(["YES", "NO", "UNKNOWN"] as const).map((c) => (
              <Chip key={`paper-${c}`} label={c} palette={palette} active={form.indented_by_rocks === c} disabled={!canEdit} onPress={() => canEdit && setVal("indented_by_rocks", c)} />
            ))}
          </View>
        </DropdownBlock>

        <DropdownBlock title="Vegetation on Slope" open={openPaperBlocks.vegetation} onToggle={() => togglePaperBlock("vegetation")} palette={palette}>
          <Field palette={palette} label="Trees Coverage %" value={form.vegetation_trees} editable={canEdit} onChangeText={(v) => setVal("vegetation_trees", v)} />
          <Field palette={palette} label="Bushes/Shrubs Coverage %" value={form.vegetation_bushes_shrubs} editable={canEdit} onChangeText={(v) => setVal("vegetation_bushes_shrubs", v)} />
          <Field palette={palette} label="Groundcover Coverage %" value={form.vegetation_groundcover} editable={canEdit} onChangeText={(v) => setVal("vegetation_groundcover", v)} />
        </DropdownBlock>

        <DropdownBlock title="Water / Drainage" open={openPaperBlocks.waterDrainage} onToggle={() => togglePaperBlock("waterDrainage")} palette={palette}>
          <View style={styles.chips}>
            {[["drainage_clogged_inlet", "Clogged Inlet"], ["drainage_compromised_drains", "Compromised Drains"], ["drainage_surface_runoff", "Surface Runoff"], ["drainage_torrent_surge_flood", "Torrent/Surge/Flood"]].map(([key, label]) => (
              <Chip key={key} label={label} palette={palette} active={form[key] === "YES"} disabled={!canEdit} onPress={() => canEdit && setVal(key as keyof FormState, form[key] === "YES" ? "NO" : "YES")} />
            ))}
          </View>
          <View style={[styles.recommendedHeaderRow, { marginTop: 10 }]}>
            <Text style={[styles.recommendedHeaderCell, { color: palette.text }]}>Impacted</Text>
            <Text style={[styles.recommendedHeaderCell, { color: palette.text }]}>May be Impacted</Text>
            <View style={styles.recommendedLabelSpacer} />
          </View>
          {[
            ["impact_impacted_adj_utilities", "impact_maybe_adj_utilities", "Adjacent Utilities"],
            ["impact_impacted_adj_properties", "impact_maybe_adj_properties", "Adjacent Properties"],
            ["impact_impacted_adj_structure", "impact_maybe_adj_structure", "Adjacent Structures"],
          ].map(([impactedKey, maybeKey, label]) => (
            <View key={label} style={styles.recommendedRow}>
              <Pressable
                style={[styles.matrixBox, { borderColor: palette.border, backgroundColor: form[impactedKey] === "YES" ? palette.primary : palette.panel }]}
                onPress={() => setImpactSelection(impactedKey as any, maybeKey as any, "IMPACTED")}
                disabled={!canEdit}
              />
              <Pressable
                style={[styles.matrixBox, { borderColor: palette.border, backgroundColor: form[maybeKey] === "YES" ? palette.primary : palette.panel }]}
                onPress={() => setImpactSelection(impactedKey as any, maybeKey as any, "MAYBE")}
                disabled={!canEdit}
              />
              <Text style={[styles.recommendedLabel, { color: palette.text }]}>{label}</Text>
            </View>
          ))}
        </DropdownBlock>

        <DropdownBlock title="Water Content" open={openPaperBlocks.waterContent} onToggle={() => togglePaperBlock("waterContent")} palette={palette}>
          <View style={styles.chips}>
            {[["water_dry", "Dry"], ["water_moist", "Moist"], ["water_wet", "Wet"]].map(([key, label]) => (
              <Chip key={key} label={label} palette={palette} active={form[key] === "YES"} disabled={!canEdit} onPress={() => canEdit && setVal(key as keyof FormState, form[key] === "YES" ? "NO" : "YES")} />
            ))}
            <Chip
              key="water_flowing"
              label="Flowing"
              palette={palette}
              active={form.water_flowing === "YES"}
              disabled={!canEdit}
              onPress={() => {
                if (!canEdit) return;
                const next = form.water_flowing === "YES" ? "NO" : "YES";
                setVal("water_flowing", next);
                if (next !== "YES") {
                  setVal("water_seep", "");
                  setVal("water_spring", "");
                }
              }}
            />
          </View>
          {waterFlowingSelected ? (
            <View style={styles.chips}>
              {[["water_seep", "Seep"], ["water_spring", "Spring"]].map(([key, label]) => (
                <Chip key={key} label={label} palette={palette} active={form[key] === "YES"} disabled={!canEdit} onPress={() => canEdit && setVal(key as keyof FormState, form[key] === "YES" ? "NO" : "YES")} />
              ))}
            </View>
          ) : null}
        </DropdownBlock>

        {anyFailureSelected ? (
          <DropdownBlock title="Measurements" open={openPaperBlocks.measurements} onToggle={() => togglePaperBlock("measurements")} palette={palette}>
            <Field palette={palette} label="Slope Height (ft)" value={form.measure_slope_height_ft} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("measure_slope_height_ft", v)} />
            <Field palette={palette} label="Original Slope (deg)" value={form.measure_original_slope_deg} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("measure_original_slope_deg", v)} />
            <Field palette={palette} label="Landslide Width (ft)" value={form.measure_landslide_width_ft} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("measure_landslide_width_ft", v)} />
            <Field palette={palette} label="Landslide Length (ft)" value={form.measure_landslide_length_ft} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("measure_landslide_length_ft", v)} />
            <Field palette={palette} label="Main Scarp Height (ft)" value={form.measure_main_scarp_height_ft} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("measure_main_scarp_height_ft", v)} />
            <Field palette={palette} label="Landslide Slope (deg)" value={form.measure_landslide_slope_deg} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("measure_landslide_slope_deg", v)} />
            <Field palette={palette} label="Roadway Length (ft)" value={form.measure_roadway_length_ft} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("measure_roadway_length_ft", v)} />
            <Field palette={palette} label="Roadway Width (ft)" value={form.measure_roadway_width_ft} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("measure_roadway_width_ft", v)} />
          </DropdownBlock>
        ) : null}
        </View>
      </View>

      <CollapsibleSection title="Recommended Actions" open={openSections.actions} onToggle={() => toggleSection("actions")} palette={palette} compact={compact}>
        <View style={styles.recommendedHeaderRow}>
          <Text style={[styles.recommendedHeaderCell, { color: palette.text }]}>Immediate Actions</Text>
          <Text style={[styles.recommendedHeaderCell, { color: palette.text }]}>Follow-up Actions</Text>
          <View style={styles.recommendedLabelSpacer} />
        </View>
        {recommendedActions.map((item) => {
          const immediateChecked = item.code ? immediateActions.includes(item.code) : closeHighwayEnabled;
          const followUpChecked = item.code ? followUpActions.includes(item.code) : false;
          return (
            <View key={item.key}>
              <View style={styles.recommendedRow}>
                {item.immediate ? (
                  <Pressable
                    style={[styles.matrixBox, { borderColor: palette.border, backgroundColor: immediateChecked ? palette.primary : palette.panel }]}
                    onPress={() => {
                      if (!canEdit) return;
                      if (item.key === "CLOSE_HIGHWAY_PARENT") {
                        toggleCloseHighwayParent();
                        return;
                      }
                      if (item.code) toggleActionByGroup(item.code, "IMMEDIATE");
                    }}
                    disabled={!canEdit}
                  />
                ) : (
                  <View style={styles.matrixCellSpacer} />
                )}
                {item.followUp ? (
                  <Pressable
                    style={[styles.matrixBox, { borderColor: palette.border, backgroundColor: followUpChecked ? palette.primary : palette.panel }]}
                    onPress={() => item.code && toggleActionByGroup(item.code, "FOLLOW_UP")}
                    disabled={!canEdit || !item.code}
                  />
                ) : (
                  <View style={styles.matrixCellSpacer} />
                )}
                <Text style={[styles.recommendedLabel, { color: palette.text }]}>{item.label}</Text>
              </View>
              {item.key === "OPEN_HIGHWAY_TRAFFIC" && openHighwayTrafficSelected ? (
                <View style={styles.childActionWrap}>
                  <Field
                    palette={palette}
                    label="Lanes"
                    value={form.lanes_closed_count}
                    editable={canEdit}
                    keyboardType="number-pad"
                    onChangeText={(v) => setVal("lanes_closed_count", v)}
                    error={fieldErrors.lanes_closed_count}
                  />
                </View>
              ) : null}
              {item.key === "CLOSE_HIGHWAY_PARENT" && closeHighwayEnabled ? (
                <View style={styles.childActionWrap}>
                  <View style={styles.closeDirectionRow}>
                    <Pressable
                      style={[styles.matrixBox, { borderColor: palette.border, backgroundColor: immediateActions.includes("CLOSE_ONE_DIRECTION") ? palette.primary : palette.panel }]}
                      onPress={() => toggleCloseHighwayDirection("CLOSE_ONE_DIRECTION")}
                      disabled={!canEdit}
                    />
                    <Text style={[styles.recommendedLabel, { color: palette.text }]}>One Direction</Text>
                    <Pressable
                      style={[styles.matrixBox, { borderColor: palette.border, backgroundColor: immediateActions.includes("CLOSE_BOTH_DIRECTIONS") ? palette.primary : palette.panel, marginLeft: 14 }]}
                      onPress={() => toggleCloseHighwayDirection("CLOSE_BOTH_DIRECTIONS")}
                      disabled={!canEdit}
                    />
                    <Text style={[styles.recommendedLabel, { color: palette.text }]}>Both Directions</Text>
                  </View>
                </View>
              ) : null}
            </View>
          );
        })}
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
        <Text style={styles.sectionTitle}>GISA PDF</Text>
        <Pressable
          style={[styles.btnPrimary, { backgroundColor: palette.primary }]}
          onPress={generateGisaPdf}
          disabled={busy}
        >
          <Text style={styles.btnPrimaryText}>{busy ? "Working..." : "Generate GISA PDF"}</Text>
        </Pressable>
        <Pressable
          style={[styles.btnGhost, { marginTop: 8, borderColor: palette.border, backgroundColor: palette.panelSoft }]}
          onPress={openLatestGisaPdf}
          disabled={busy}
        >
          <Text style={[styles.btnGhostText, { color: palette.text }]}>{busy ? "Working..." : "Open Latest GISA PDF"}</Text>
        </Pressable>
      </View>

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
  recommendedHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 4,
    marginBottom: 8,
  },
  recommendedHeaderCell: {
    width: 26,
    marginRight: 10,
    fontSize: 11,
    fontWeight: "800",
    textAlign: "center",
  },
  recommendedLabelSpacer: {
    flex: 1,
  },
  recommendedRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 6,
  },
  matrixBox: {
    width: 20,
    height: 20,
    borderWidth: 1,
    borderRadius: 4,
    marginRight: 10,
  },
  matrixCellSpacer: {
    width: 20,
    height: 20,
    marginRight: 10,
  },
  recommendedLabel: {
    fontSize: 15,
    fontWeight: "600",
    flexShrink: 1,
  },
  childActionWrap: {
    marginLeft: 62,
    marginTop: 2,
    marginBottom: 8,
  },
  closeDirectionRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
  },
  dropdownBlock: {
    marginTop: 0,
    borderWidth: Platform.OS === "ios" ? StyleSheet.hairlineWidth : 1,
    borderRadius: Platform.OS === "ios" ? 12 : 14,
    padding: Platform.OS === "ios" ? 10 : 12,
    shadowColor: "#10233f",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: Platform.OS === "ios" ? 0.08 : 0.06,
    shadowRadius: Platform.OS === "ios" ? 8 : 10,
    elevation: Platform.OS === "ios" ? 0 : 1,
  },
  dropdownBlockHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  dropdownBlockTitle: {
    fontWeight: Platform.OS === "ios" ? "700" : "800",
    fontSize: Platform.OS === "ios" ? 23 / 1.45 : 22 / 1.45,
  },
  contactCard: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
  },
  contactCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  contactCardTitle: {
    fontSize: 14,
    fontWeight: "700",
  },
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


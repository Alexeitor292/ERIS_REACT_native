import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, Alert, Image, ActivityIndicator, StyleSheet, Linking, Modal, Animated, Easing, LayoutAnimation, Platform, UIManager, PanResponder, useWindowDimensions } from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as Haptics from "expo-haptics";
import * as Location from "expo-location";
import { useFocusEffect, useLocalSearchParams, router, useNavigation, usePathname } from "expo-router";

import { apiFetch, isSessionExpiredError } from "../../../src/api/client";
import { getApiBaseUrl } from "../../../src/api/baseUrl";
import { getToken } from "../../../src/auth/tokenStore";
import { generateSubmissionGisaPdf, getGisaLookups, getSubmission, getSubmissionGisaPdf, notifyCoordinator as notifyCoordinatorApi, patchSubmission, replaceActions, replaceIncidentTypes, reviewSubmission, submitSubmission, uploadSubmissionAttachment, type GisaRoadInventoryContext } from "../../../src/api/submissions";
import { terrainLabel, explainRoadInventoryField } from "../../../src/roadInventory/roadInventoryGlossary";
import { enqueueOfflineOp } from "../../../src/offline/queue";
import { triggerOfflineSyncNow } from "../../../src/offline/syncLoop";
import {
  deleteLocalDraft,
  getLocalDraft,
  isLocalDraftId,
  listLocalDrafts,
  saveLocalDraft,
} from "../../../src/offline/localDrafts";
import { readLookupsCache, writeLookupsCache } from "../../../src/offline/lookupsCache";
import { deleteLargeItemAsync, getLargeItemAsync, setLargeItemAsync } from "../../../src/offline/secureStoreLarge";
import { useUiSettings } from "../../../src/ui/UiSettingsContext";
import {
  convertCaliforniaStatePlaneFeetToLatLon,
  convertLatLonToCaliforniaStatePlaneFeet,
  formatCaliforniaStatePlaneFeet,
  getCaliforniaStatePlaneZone,
} from "../../../src/utils/californiaCoordinateSystem";
import { buildSubmissionDescriptor } from "../../../src/utils/submissionLabel";
import { enrichPointFromArcgisClient } from "../../../src/utils/arcgisEnrichment";
import { formatCoordinate, normalizeCoordinateValue, normalizePostMileInput, normalizePostMileValue, normalizeRouteInput, normalizeRouteValue } from "../../../src/utils/precision";
import { prepareUploadFile } from "../../../src/utils/uploadFile";
import {
  CALTRANS_COUNTIES,
  CALTRANS_DISTRICTS,
  countyCodeFromNameOrCode,
  countyDisplayLabel,
  districtForCounty,
  routesForCounty,
} from "../../../src/utils/caltransLookups";
import { MeasurementDiagramRenderer } from "../../../src/components/MeasurementDiagramRenderer";

type OptionItem = { code: string; label: string };
type UserInfo = { id: number; roles: string[] };
type Lookups = {
  distribution: OptionItem[];
  highway_status: OptionItem[];
  incident_types: OptionItem[];
  actions: { immediate: OptionItem[]; follow_up: OptionItem[] };
};
const EMPTY_LOOKUPS: Lookups = {
  distribution: [],
  highway_status: [],
  incident_types: [],
  actions: { immediate: [], follow_up: [] },
};
type SubmissionDetail = {
  submission: { id: number; created_by_user_id: number; title?: string | null; status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED"; created_at: string; updated_at: string; submitted_at?: string | null; reviewed_at?: string | null; review_comment?: string | null; can_edit?: boolean; can_manage_permissions?: boolean };
  gisa: any | null;
  incident_types: string[];
  actions: { immediate: string[]; follow_up: string[] };
  photos: { id: number; file_name: string; mime_type: string }[];
  attachments?: { id: number; file_name: string; mime_type: string; kind?: string; section_key?: string | null }[];
  workflow_events: { id: number; event_type: string; from_status?: string | null; to_status?: string | null; comment?: string | null; created_at: string }[];
};

type FormState = Record<string, string> & {
  pavement_ground_cracks: "" | "YES" | "NO";
  indented_by_rocks: "" | "YES" | "NO";
};
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
type PavementAnnotationId = "crack" | "settlement" | "bulge" | "rocks";
type PavementAnnotationPoint = { x: number; y: number };
type PavementAnnotationLayout = Record<PavementAnnotationId, { x: number; y: number; placed: boolean; rangeEnd: PavementAnnotationPoint | null }>;
const PAVEMENT_ANNOTATION_FIELD = "pavement_ground_annotation_layout" as const;
const PAVEMENT_ANNOTATION_ORDER: PavementAnnotationId[] = ["crack", "settlement", "bulge", "rocks"];
const DEFAULT_PAVEMENT_ANNOTATION_LAYOUT: PavementAnnotationLayout = {
  crack: { x: 0.08, y: 0.12, placed: false, rangeEnd: null },
  settlement: { x: 0.58, y: 0.18, placed: false, rangeEnd: null },
  bulge: { x: 0.2, y: 0.58, placed: false, rangeEnd: null },
  rocks: { x: 0.62, y: 0.62, placed: false, rangeEnd: null },
};
const PAVEMENT_ANNOTATION_TITLES: Record<PavementAnnotationId, string> = {
  crack: "Crack",
  settlement: "Settlement",
  bulge: "Bulge",
  rocks: "Indented by Rocks",
};

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function parsePavementAnnotationPoint(raw: any): PavementAnnotationPoint | null {
  if (!raw || !Number.isFinite(Number(raw.x)) || !Number.isFinite(Number(raw.y))) return null;
  return {
    x: clamp01(Number(raw.x)),
    y: clamp01(Number(raw.y)),
  };
}

function parsePavementAnnotationLayout(raw: any): PavementAnnotationLayout {
  if (!raw || typeof raw !== "string") return { ...DEFAULT_PAVEMENT_ANNOTATION_LAYOUT };
  try {
    const parsed = JSON.parse(raw);
    const next = { ...DEFAULT_PAVEMENT_ANNOTATION_LAYOUT };
    PAVEMENT_ANNOTATION_ORDER.forEach((id) => {
      const item = parsed?.[id];
      if (item && Number.isFinite(Number(item.x)) && Number.isFinite(Number(item.y))) {
        next[id] = {
          x: clamp01(Number(item.x)),
          y: clamp01(Number(item.y)),
          placed: typeof item.placed === "boolean" ? item.placed : true,
          rangeEnd: parsePavementAnnotationPoint(item.rangeEnd),
        };
      }
    });
    return next;
  } catch {
    return { ...DEFAULT_PAVEMENT_ANNOTATION_LAYOUT };
  }
}

function stringifyPavementAnnotationLayout(layout: PavementAnnotationLayout): string {
  const normalized = { ...DEFAULT_PAVEMENT_ANNOTATION_LAYOUT };
  PAVEMENT_ANNOTATION_ORDER.forEach((id) => {
    normalized[id] = {
      x: clamp01(Number(layout[id]?.x ?? DEFAULT_PAVEMENT_ANNOTATION_LAYOUT[id].x)),
      y: clamp01(Number(layout[id]?.y ?? DEFAULT_PAVEMENT_ANNOTATION_LAYOUT[id].y)),
      placed: !!layout[id]?.placed,
      rangeEnd: parsePavementAnnotationPoint(layout[id]?.rangeEnd),
    };
  });
  return JSON.stringify(normalized);
}

function pavementAnnotationShortSummary(id: PavementAnnotationId, form: FormState): string {
  if (id === "crack") {
    if (form.pavement_ground_cracks === "NO") return "No crack";
    if (form.pavement_ground_cracks !== "YES") return "Tap to add";
    return form.crack_length_ft.trim() ? `${form.crack_length_ft.trim()} ft` : "Add measures";
  }
  if (id === "settlement") {
    return form.settlement_in.trim() ? `${form.settlement_in.trim()} in` : "Tap to add";
  }
  if (id === "bulge") {
    return form.bulge_in.trim() ? `${form.bulge_in.trim()} in` : "Tap to add";
  }
  if (form.indented_by_rocks === "YES") return "Yes";
  if (form.indented_by_rocks === "NO") return "No";
  return "Tap to set";
}

function pavementAnnotationLongSummary(id: PavementAnnotationId, form: FormState): string {
  if (id === "crack") {
    if (form.pavement_ground_cracks === "NO") return "Marked as no cracks.";
    if (form.pavement_ground_cracks !== "YES") return "Not set yet.";
    return [
      `Length ${form.crack_length_ft.trim() || "--"} ft`,
      `Horiz ${form.crack_horizontal_in.trim() || "--"} in`,
      `Vert ${form.crack_vertical_in.trim() || "--"} in`,
      `Depth ${form.crack_depth_in.trim() || "--"} in`,
    ].join("  |  ");
  }
  if (id === "settlement") {
    return form.settlement_in.trim() ? `${form.settlement_in.trim()} inches recorded.` : "Not set yet.";
  }
  if (id === "bulge") {
    return form.bulge_in.trim() ? `${form.bulge_in.trim()} inches recorded.` : "Not set yet.";
  }
  if (form.indented_by_rocks === "YES") return "Marked as yes.";
  if (form.indented_by_rocks === "NO") return "Marked as no.";
  return "Not set yet.";
}

function pavementAnnotationHasValue(id: PavementAnnotationId, form: FormState): boolean {
  if (id === "crack") return form.pavement_ground_cracks === "YES" || form.pavement_ground_cracks === "NO";
  if (id === "settlement") return !!form.settlement_in.trim();
  if (id === "bulge") return !!form.bulge_in.trim();
  return form.indented_by_rocks === "YES" || form.indented_by_rocks === "NO";
}

const EMPTY_FORM: FormState = {
  report_date: "", district: "", county: "", route: "", post_mile: "", ea: "", project_id: "", date_incident_reported: "", district_contact: "",
  latitude: "", longitude: "", distribution_code: "", highway_status_cause: "", highway_status_code: "", lanes_closed_count: "", open_highway_traffic_lanes_count: "",
  crack_length_ft: "", crack_horizontal_in: "", crack_vertical_in: "", crack_depth_in: "", settlement_in: "", bulge_in: "",
  failure_rock_fall: "", failure_topple: "", failure_slide: "", failure_spread: "", failure_flow: "", failure_compound: "", failure_erosion: "", failure_surficial_failure: "", failure_scoured_toe: "", failure_washout: "",
  incident_type_description: "",
  distribution_advancing: "", distribution_retrogressive: "", distribution_enlarging: "", distribution_widening: "", distribution_moving: "", distribution_confined: "",
  material_rock: "", material_soil: "", material_bedding: "", material_joints: "", material_fractures: "",
  material_pavement_type: "",
  est_soil_pct: "", est_clay_pct: "", est_silt_pct: "", est_sand_pct: "", est_gravel_pct: "", est_boulder_pct: "",
  est_rock_pct: "",
  est_debris_clay_silt_pct: "", est_debris_sand_pct: "", est_debris_gravel_pct: "", est_debris_boulder_pct: "",
  water_dry: "", water_moist: "", water_wet: "", water_flowing: "", water_seep: "", water_spring: "",
  vegetation_trees: "", vegetation_bushes_shrubs: "", vegetation_groundcover: "",
  drainage_clogged_inlet: "", drainage_compromised_drains: "", drainage_surface_runoff: "", drainage_torrent_surge_flood: "",
  impact_impacted_adj_utilities: "", impact_maybe_adj_utilities: "", impact_adj_utilities: "", impact_impacted_adj_properties: "", impact_maybe_adj_properties: "", impact_adj_properties: "", impact_impacted_adj_structure: "", impact_maybe_adj_structure: "", impact_adj_structure: "",
  measure_slope_height_ft: "", measure_original_slope_deg: "", measure_landslide_width_ft: "", measure_landslide_length_ft: "", measure_main_scarp_height_ft: "", measure_landslide_slope_deg: "", measure_roadway_length_ft: "", measure_roadway_width_ft: "",
  record_of_event_notes: "", maintenance_history_notes: "", geotechnical_assessment_notes: "", recommendations_notes: "", sketchpad_notes: "",
  observations_notes: "", geometry_json: "", pavement_ground_cracks: "", indented_by_rocks: "", pavement_ground_annotation_layout: "",
};

const MEMO_SECTIONS = [
  { key: "record_of_event", label: "Record of Event", field: "record_of_event_notes" },
  { key: "maintenance_history", label: "Maintenance History", field: "maintenance_history_notes" },
  { key: "observation", label: "Observation", field: "observations_notes" },
  { key: "geotechnical_assessment", label: "Geotechnical Assessment", field: "geotechnical_assessment_notes" },
] as const;

const GALLERY_SOURCE_SECTIONS = [
  { key: "submission", label: "Submission", figureSection: 1 },
  { key: "distribution", label: "Distribution", figureSection: 2 },
  { key: "highway_status", label: "Highway Status", figureSection: 3 },
  { key: "incident_type", label: "Incident Type", figureSection: 4 },
  { key: "material", label: "Material", figureSection: 5 },
  { key: "pavement_ground_status", label: "Pavement / Ground Status", figureSection: 6 },
  { key: "vegetation_slope", label: "Vegetation on Slope", figureSection: 7 },
  { key: "water_drainage", label: "Water / Drainage", figureSection: 8 },
  { key: "water_content", label: "Water Content", figureSection: 9 },
  { key: "measurements", label: "Measurements", figureSection: 10 },
  { key: "record_of_event", label: "Record of Event", figureSection: 11 },
  { key: "maintenance_history", label: "Maintenance History", figureSection: 12 },
  { key: "observation", label: "Observation", figureSection: 13 },
  { key: "geotechnical_assessment", label: "Geotechnical Assessment", figureSection: 14 },
  { key: "sketchpad", label: "Sketchpad", figureSection: 15 },
] as const;

type GallerySource = (typeof GALLERY_SOURCE_SECTIONS)[number] | { key: string; label: string; figureSection: number };
type GalleryImage = {
  id: number;
  file_name: string;
  mime_type: string;
  kind?: string;
  section_key?: string | null;
  sourceLabel: string;
  figureLabel: string;
};
type FigureCitationRequest = {
  fieldLabel: string;
  onSelect: (image: GalleryImage) => void;
};

const GALLERY_SOURCE_BY_KEY: Map<string, (typeof GALLERY_SOURCE_SECTIONS)[number]> = new Map(GALLERY_SOURCE_SECTIONS.map((section) => [section.key, section]));
const UNKNOWN_GALLERY_SOURCE_SECTION = GALLERY_SOURCE_SECTIONS.length + 1;

function titleFromSectionKey(sectionKey: string): string {
  return sectionKey
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function gallerySourceForSectionKey(sectionKey?: string | null): GallerySource {
  const normalized = String(sectionKey || "").trim() || "submission";
  const known = GALLERY_SOURCE_BY_KEY.get(normalized);
  return known ?? { key: normalized, label: titleFromSectionKey(normalized), figureSection: UNKNOWN_GALLERY_SOURCE_SECTION };
}


const n = (v: string) => (v.trim() ? v.trim() : null);
const f = (v: string, name: string) => { if (!v.trim()) return null; const x = Number(v); if (Number.isNaN(x)) throw new Error(`${name} must be numeric`); return x; };
const i = (v: string, name: string) => { if (!v.trim()) return null; const x = Number(v); if (Number.isNaN(x) || !Number.isInteger(x)) throw new Error(`${name} must be a whole number`); return x; };
const parseStatePlaneFeetValue = (value: string) => {
  const raw = value.trim().replace(/,/g, "");
  if (!raw) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
};
const pct = (v: string, name: string) => {
  if (!v.trim()) return null;
  const x = Number(v);
  if (Number.isNaN(x)) throw new Error(`${name} must be numeric`);
  if (x < 0 || x > 100) throw new Error(`${name} must be between 0 and 100`);
  return x;
};
const triToBool = (v: "" | "YES" | "NO") =>
  v === "YES" ? true : v === "NO" ? false : null;
const normalizeBool = (v: any): boolean | null => {
  if (v === true || v === 1 || v === "1") return true;
  if (v === false || v === 0 || v === "0") return false;
  return null;
};
const boolToTri = (v: any): "" | "YES" | "NO" => {
  const b = normalizeBool(v);
  return b === true ? "YES" : b === false ? "NO" : "";
};
const ynToBool = (v: string) => (v === "YES" ? true : v === "NO" ? false : null);
const boolToYn = (v: any) => {
  const b = normalizeBool(v);
  return b === true ? "YES" : b === false ? "NO" : "";
};
const isPlayServicesUnavailableError = (msg: string) =>
  /LocationServices\.API is not available|SERVICE_INVALID|Google Play services/i.test(msg);
const isIosPhotosAccessError = (msg: string) =>
  /PHPhotosErrorDomain|error 3164/i.test(msg);
const isLocalAttachmentUri = (uri?: string | null) =>
  !!uri && /^(file|content|ph|assets-library):/i.test(String(uri).trim());

function inferAttachmentKind(name: string, mimeType: string): "PHOTO" | "VIDEO" | "DOC" | "SKETCH" {
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

function ymdFromTimestamp(value?: string | null): string {
  if (!value) return "";
  const m = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m?.[1]) return m[1];
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return toYmd(parsed);
}

function monthLabel(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function isDarkHexColor(value?: string | null): boolean {
  if (!value) return false;
  const hex = value.replace("#", "").trim();
  const normalized = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return false;
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.45;
}

const INCIDENT_TYPE_CODE_BY_FORM_KEY: Record<string, string> = {
  failure_rock_fall: "ROCK_FALL",
  failure_topple: "TOPPLE",
  failure_slide: "SLIDE",
  failure_spread: "SPREAD",
  failure_flow: "FLOW",
  failure_compound: "COMPOUND",
  failure_erosion: "EROSION",
  failure_surficial_failure: "SURFICIAL_SLOUGHING",
  failure_scoured_toe: "SCOURED_TOE",
  failure_washout: "WASHOUT",
};
const INCIDENT_TYPE_FORM_CODES = new Set(Object.values(INCIDENT_TYPE_CODE_BY_FORM_KEY));
type IncidentTypeOption = { key?: string; code: string; label: string };
const INCIDENT_TYPE_OPTIONS: IncidentTypeOption[] = [
  { key: "failure_rock_fall", code: "ROCK_FALL", label: "Rock Fall" },
  { key: "failure_topple", code: "TOPPLE", label: "Topple" },
  { key: "failure_slide", code: "SLIDE", label: "Slide" },
  { key: "failure_spread", code: "SPREAD", label: "Spread" },
  { key: "failure_flow", code: "FLOW", label: "Flow" },
  { key: "failure_compound", code: "COMPOUND", label: "Compound" },
  { key: "failure_erosion", code: "EROSION", label: "Erosion" },
  { key: "failure_surficial_failure", code: "SURFICIAL_SLOUGHING", label: "Surficial Sloughing" },
  { key: "failure_scoured_toe", code: "SCOURED_TOE", label: "Scoured Toe" },
  { key: "failure_washout", code: "WASHOUT", label: "Washout" },
  { code: "SINK_HOLE", label: "Sink Hole" },
  { code: "DEPRESSION", label: "Depression" },
  { code: "HEAVING", label: "Heaving" },
] as const;

function isLikelyOfflineError(message: string): boolean {
  const m = String(message || "");
  return /network request failed|failed to fetch|could not reach upload endpoint|timeout|internal server error/i.test(m);
}

const DISTRIBUTION_ICON_SOURCE: Record<string, any> = {
  ADVANCING: require("../../../assets/distribution-icons/advancing.png"),
  RETROGRESSING: require("../../../assets/distribution-icons/retrogressing.png"),
  ENLARGING: require("../../../assets/distribution-icons/enlarging.png"),
  WIDENING: require("../../../assets/distribution-icons/widening.png"),
  MOVING: require("../../../assets/distribution-icons/moving.png"),
  CONFINED: require("../../../assets/distribution-icons/confined.png"),
};

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
  const safe = String(submissionId || "").replace(/[^a-zA-Z0-9._-]/g, "_");
  return `draft_local_cache_${safe}`;
}

function attachmentUriCacheKey(submissionId: string): string {
  const safe = String(submissionId || "").replace(/[^a-zA-Z0-9._-]/g, "_");
  return `draft_local_attachment_uris_${safe}`;
}

async function getDraftCache(key: string): Promise<string | null> {
  try {
    return await getLargeItemAsync(key);
  } catch {
    return null;
  }
}

async function setDraftCache(key: string, value: string): Promise<void> {
  try {
    await setLargeItemAsync(key, value);
  } catch {}
}

async function removeDraftCache(key: string): Promise<void> {
  try {
    await deleteLargeItemAsync(key);
  } catch {}
}

async function getAttachmentUriCache(key: string): Promise<Record<number, string>> {
  try {
    const raw = await getLargeItemAsync(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const next: Record<number, string> = {};
    for (const [attachmentId, uri] of Object.entries(parsed)) {
      const numericId = Number(attachmentId);
      if (!numericId || typeof uri !== "string" || !uri.trim()) continue;
      next[numericId] = uri;
    }
    return next;
  } catch {
    return {};
  }
}

async function setAttachmentUriCache(key: string, value: Record<number, string>): Promise<void> {
  try {
    await setLargeItemAsync(key, JSON.stringify(value));
  } catch {}
}

async function removeAttachmentUriCache(key: string): Promise<void> {
  try {
    await deleteLargeItemAsync(key);
  } catch {}
}

function normalizeCachedForm(raw: any): FormState {
  const next: FormState = { ...EMPTY_FORM, ...(raw || {}) };
  next.pavement_ground_cracks =
    raw?.pavement_ground_cracks === "YES" || raw?.pavement_ground_cracks === "NO" ? raw.pavement_ground_cracks : "";
  next.indented_by_rocks =
    raw?.indented_by_rocks === "YES" || raw?.indented_by_rocks === "NO" ? raw.indented_by_rocks : "";
  next.pavement_ground_annotation_layout =
    typeof raw?.pavement_ground_annotation_layout === "string" ? raw.pavement_ground_annotation_layout : "";
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
  const normalizedForm = enforceFormBusinessRules(normalizeCachedForm(raw?.form));
  return {
    form: normalizedForm,
    incidentTypes: Array.isArray(raw?.incidentTypes) ? raw.incidentTypes.map((x: any) => String(x)) : [],
    immediateActions: Array.isArray(raw?.immediateActions) ? raw.immediateActions.map((x: any) => String(x)) : [],
    followUpActions: Array.isArray(raw?.followUpActions) ? raw.followUpActions.map((x: any) => String(x)) : [],
    districtContacts: normalizeCachedContacts(raw?.districtContacts),
  };
}

function enforceFormBusinessRules(input: FormState): FormState {
  const next: FormState = { ...input };

  const incidentKeys = [
    "failure_rock_fall",
    "failure_topple",
    "failure_slide",
    "failure_spread",
    "failure_flow",
    "failure_compound",
    "failure_erosion",
    "failure_surficial_failure",
    "failure_scoured_toe",
    "failure_washout",
  ] as const;
  incidentKeys.forEach((k) => {
    next[k] = next[k] === "YES" ? "YES" : "NO";
  });

  next.material_rock = next.material_rock === "YES" ? "YES" : "NO";
  next.material_soil = next.material_soil === "YES" ? "YES" : "NO";
  const rockSubs = ["material_bedding", "material_joints", "material_fractures"] as const;
  rockSubs.forEach((k) => {
    next[k] = next[k] === "YES" ? "YES" : "NO";
  });
  if (next.material_rock !== "YES") {
    next.material_bedding = "NO";
    next.material_joints = "NO";
    next.material_fractures = "NO";
    next.est_rock_pct = "";
  }
  if (next.material_soil !== "YES") {
    next.est_soil_pct = "";
    next.est_clay_pct = "";
    next.est_silt_pct = "";
    next.est_sand_pct = "";
    next.est_gravel_pct = "";
    next.est_boulder_pct = "";
  }

  if (next.pavement_ground_cracks !== "YES" && next.pavement_ground_cracks !== "NO") next.pavement_ground_cracks = "";
  if (next.indented_by_rocks !== "YES" && next.indented_by_rocks !== "NO") next.indented_by_rocks = "";

  const drainageKeys = [
    "drainage_clogged_inlet",
    "drainage_compromised_drains",
    "drainage_surface_runoff",
    "drainage_torrent_surge_flood",
  ] as const;
  const selectedDrainage = drainageKeys.find((k) => next[k] === "YES");
  drainageKeys.forEach((k) => {
    next[k] = k === selectedDrainage ? "YES" : "NO";
  });

  const baseWaterKeys = ["water_dry", "water_moist", "water_wet", "water_flowing"] as const;
  const selectedWater = baseWaterKeys.find((k) => next[k] === "YES");
  baseWaterKeys.forEach((k) => {
    next[k] = k === selectedWater ? "YES" : "NO";
  });
  if (next.water_flowing === "YES") {
    const flowingSub = next.water_seep === "YES" ? "water_seep" : next.water_spring === "YES" ? "water_spring" : null;
    next.water_seep = flowingSub === "water_seep" ? "YES" : "NO";
    next.water_spring = flowingSub === "water_spring" ? "YES" : "NO";
  } else {
    next.water_seep = "NO";
    next.water_spring = "NO";
  }

  return next;
}

// Tap-only wrapper that proactively releases the responder on vertical drag, allowing
// the parent ScrollView to scroll even when the touch starts over a button/field.
// Replaces Pressable in form elements where scroll-through is needed.
function ScrollSafePressable({
  onPress,
  disabled,
  style,
  children,
}: {
  onPress: () => void;
  disabled?: boolean;
  style?: any;
  children: React.ReactNode;
}) {
  const activeRef = useRef(false);
  const startYRef = useRef(0);
  return (
    <View
      accessible
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      style={style}
      onStartShouldSetResponder={() => !disabled}
      onResponderTerminationRequest={() => true}
      onResponderGrant={(e) => {
        activeRef.current = true;
        startYRef.current = e.nativeEvent.pageY;
      }}
      onResponderMove={(e) => {
        if (!activeRef.current) return;
        if (Math.abs(e.nativeEvent.pageY - startYRef.current) > 8) {
          activeRef.current = false;
        }
      }}
      onResponderRelease={() => {
        if (activeRef.current) onPress();
        activeRef.current = false;
      }}
      onResponderTerminate={() => {
        activeRef.current = false;
      }}
    >
      {children}
    </View>
  );
}

function Chip({
  label,
  active,
  onPress,
  disabled,
  palette,
  iconLeft,
  iconRight,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  disabled?: boolean;
  palette?: { primary: string; border: string; panelSoft: string; text: string };
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
}) {
  const { componentScale, textScale } = useUiSettings();
  const scale = Math.max(1, componentScale);
  return (
    <ScrollSafePressable
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.chip,
        {
          paddingVertical: Math.round(6 * scale),
          paddingHorizontal: Math.round(10 * scale),
        },
        {
          borderColor: palette?.border ?? "#c8d5ea",
          backgroundColor: palette?.panelSoft ?? "#f9fbff",
        },
        active ? [styles.chipOn, { borderColor: palette?.primary ?? "#1d4ed8" }] : null,
        disabled ? { opacity: 0.6 } : null,
      ]}
    >
      <View style={[styles.chipInner, { gap: Math.round(6 * scale) }]}>
        {iconLeft ? <View style={[styles.chipIconWrap, { width: Math.round(18 * scale), height: Math.round(18 * scale) }]}>{iconLeft}</View> : null}
        <Text
          style={[
            styles.chipText,
            { color: palette?.text ?? "#334155", fontSize: Math.round(12 * scale) },
            active ? [styles.chipTextOn, { color: palette?.primary ?? "#1d4ed8" }] : null,
          ]}
          maxFontSizeMultiplier={textScale}
        >
          {label}
        </Text>
        {iconRight ? <View style={[styles.chipIconWrap, { width: Math.round(18 * scale), height: Math.round(18 * scale) }]}>{iconRight}</View> : null}
      </View>
    </ScrollSafePressable>
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
  onBlur,
  citationImages,
  onCitationTrigger,
  onCitationPress,
}: {
  label: string;
  value: string;
  onChangeText?: (v: string) => void;
  editable: boolean;
  multiline?: boolean;
  keyboardType?: "default" | "numeric" | "decimal-pad" | "number-pad";
  palette?: { muted: string; border: string; panel: string; panelSoft: string; text: string };
  error?: string;
  onBlur?: () => void;
  citationImages?: GalleryImage[];
  onCitationTrigger?: (request: FigureCitationRequest) => void;
  onCitationPress?: (image: GalleryImage) => void;
}) {
  const { componentScale, textScale } = useUiSettings();
  const scale = Math.max(1, componentScale);
  const selectionRef = useRef({ start: value.length, end: value.length });
  const inputRef = useRef<any>(null);
  const [focused, setFocused] = useState(false);
  const byLabel = citationImages?.length
    ? new Map(citationImages.map((img) => [img.figureLabel, img]))
    : null;

  const startEditing = useCallback(() => {
    setFocused(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  function renderRichText() {
    if (!value) return null;
    const parts: React.ReactNode[] = [];
    const regex = /Figure\s+\d+\.\d+/g;
    let lastIndex = 0;
    let match;
    while ((match = regex.exec(value)) !== null) {
      if (match.index > lastIndex) {
        parts.push(<Text key={`t${lastIndex}`}>{value.slice(lastIndex, match.index)}</Text>);
      }
      const label = match[0].replace(/\s+/g, " ").trim();
      const img = byLabel?.get(label);
      parts.push(
        <Text
          key={`f${match.index}`}
          style={{ color: "#3b82f6" }}
          onPress={img && onCitationPress ? () => onCitationPress(img) : undefined}
        >
          {match[0]}
        </Text>
      );
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < value.length) {
      parts.push(<Text key={`t${lastIndex}`}>{value.slice(lastIndex)}</Text>);
    }
    return parts;
  }

  const insertFigureCitation = useCallback(
    (nextValue: string, slashIndex: number, image: GalleryImage) => {
      const before = nextValue.slice(0, slashIndex);
      const after = nextValue.slice(slashIndex + 1);
      const leadingSpace = before && !/\s$/.test(before) ? " " : "";
      const trailingSpace = after && !/^\s/.test(after) ? " " : "";
      onChangeText?.(`${before}${leadingSpace}${image.figureLabel}${trailingSpace}${after}`);
    },
    [onChangeText]
  );

  const handleChangeText = useCallback(
    (nextValue: string) => {
      const previousValue = value ?? "";
      const previousSelection = selectionRef.current;
      onChangeText?.(nextValue);

      if (!editable || !onCitationTrigger || !onChangeText) return;
      const delta = nextValue.length - previousValue.length;
      let slashIndex = -1;
      if (delta > 0 && previousSelection.start <= previousValue.length) {
        const inserted = nextValue.slice(previousSelection.start, previousSelection.start + delta);
        const insertedSlashIndex = inserted.lastIndexOf("/");
        if (insertedSlashIndex >= 0) {
          slashIndex = previousSelection.start + insertedSlashIndex;
        }
      }
      if (slashIndex < 0) {
        const estimatedCursor = Math.min(nextValue.length, previousSelection.start + Math.max(delta, 0));
        if (nextValue[estimatedCursor - 1] === "/" && previousValue[previousSelection.start - 1] !== "/") {
          slashIndex = estimatedCursor - 1;
        }
      }
      if (slashIndex < 0) return;
      onCitationTrigger({
        fieldLabel: label,
        onSelect: (image) => insertFigureCitation(nextValue, slashIndex, image),
      });
    },
    [editable, insertFigureCitation, label, onChangeText, onCitationTrigger, value]
  );

  return (
    <View style={{ marginTop: Math.round(8 * scale) }}>
      <View style={[styles.labelRow, { gap: Math.round(6 * scale) }]}>
        <Text
          style={[styles.label, { color: error ? "#dc2626" : (palette?.muted ?? "#465978"), fontSize: Math.round(13 * scale) }]}
          maxFontSizeMultiplier={textScale}
        >
          {label}
        </Text>
        {error ? (
          <View style={[styles.errorIcon, { width: Math.round(16 * scale), height: Math.round(16 * scale), borderRadius: Math.round(8 * scale) }]}>
            <Text style={[styles.errorIconText, { fontSize: Math.round(10 * scale), lineHeight: Math.round(12 * scale) }]} maxFontSizeMultiplier={textScale}>i</Text>
          </View>
        ) : null}
      </View>
      {!focused && !editable ? (
        <Text
          maxFontSizeMultiplier={textScale}
          style={[
            styles.input,
            {
              borderColor: error ? "#ef4444" : (palette?.border ?? "#ccd8ea"),
              backgroundColor: palette?.panelSoft ?? "#f7f8fc",
              color: palette?.text ?? "#1b2a40",
              borderRadius: Math.round((Platform.OS === "ios" ? 10 : 8) * scale),
              paddingHorizontal: Math.round(10 * scale),
              paddingVertical: Math.round((Platform.OS === "ios" ? 10 : 8) * scale),
              fontSize: Math.round((Platform.OS === "ios" ? 16 : 14) * scale),
              opacity: 0.85,
            },
            multiline ? { minHeight: Math.round(90 * scale) } : null,
          ]}
        >
          {renderRichText()}
        </Text>
      ) : !focused && editable ? (
        <ScrollSafePressable
          onPress={startEditing}
          style={[
            styles.input,
            {
              borderColor: error ? "#ef4444" : (palette?.border ?? "#ccd8ea"),
              backgroundColor: palette?.panelSoft ?? "#f7f8fc",
              borderRadius: Math.round((Platform.OS === "ios" ? 10 : 8) * scale),
              paddingHorizontal: Math.round(10 * scale),
              paddingVertical: Math.round((Platform.OS === "ios" ? 10 : 8) * scale),
            },
            multiline ? { minHeight: Math.round(90 * scale) } : null,
          ]}
        >
          <Text
            maxFontSizeMultiplier={textScale}
            style={{
              color: palette?.text ?? "#1b2a40",
              fontSize: Math.round((Platform.OS === "ios" ? 16 : 14) * scale),
            }}
          >
            {renderRichText()}
          </Text>
        </ScrollSafePressable>
      ) : (
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={handleChangeText}
          onSelectionChange={(event) => {
            selectionRef.current = event.nativeEvent.selection;
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => { setFocused(false); onBlur?.(); }}
          editable={editable}
          autoFocus
          multiline={multiline}
          scrollEnabled={multiline ? false : undefined}
          keyboardType={keyboardType ?? "default"}
          maxFontSizeMultiplier={textScale}
          style={[
            styles.input,
            {
              borderColor: error ? "#ef4444" : (palette?.border ?? "#ccd8ea"),
              backgroundColor: palette?.panelSoft ?? "#f7f8fc",
              color: palette?.text ?? "#1b2a40",
              borderRadius: Math.round((Platform.OS === "ios" ? 10 : 8) * scale),
              paddingHorizontal: Math.round(10 * scale),
              paddingVertical: Math.round((Platform.OS === "ios" ? 10 : 8) * scale),
              fontSize: Math.round((Platform.OS === "ios" ? 16 : 14) * scale),
            },
            multiline ? { minHeight: Math.round(90 * scale), textAlignVertical: "top" } : null,
          ]}
        />
      )}
      {error ? <Text style={[styles.errorText, { fontSize: Math.round(11 * scale), marginTop: Math.round(4 * scale) }]} maxFontSizeMultiplier={textScale}>{error}</Text> : null}
    </View>
  );
}

function FigureCitationPicker({
  visible,
  request,
  galleryImages,
  palette,
  failedPreviewIds,
  previewSource,
  onPreviewError,
  onClose,
}: {
  visible: boolean;
  request: FigureCitationRequest | null;
  galleryImages: GalleryImage[];
  palette: { bg: string; panel: string; panelSoft: string; border: string; text: string; muted: string; primary: string };
  failedPreviewIds: Record<number, boolean>;
  previewSource: (photoId: number) => { uri: string };
  onPreviewError: (photoId: number) => void;
  onClose: () => void;
}) {
  const { componentScale, textScale } = useUiSettings();
  const scale = Math.max(1, componentScale);
  const grouped = galleryImages.reduce<{ key: string; label: string; images: GalleryImage[] }[]>((acc, image) => {
    const key = image.section_key || "submission";
    const existing = acc.find((section) => section.key === key);
    if (existing) {
      existing.images.push(image);
    } else {
      acc.push({ key, label: image.sourceLabel, images: [image] });
    }
    return acc;
  }, []);
  const tileWidth = Math.round(118 * scale);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.figurePickerBackdrop} onPress={onClose}>
        <Pressable
          style={[styles.figurePickerPanel, { backgroundColor: palette.panel, borderColor: palette.border }]}
          onPress={(event) => event.stopPropagation()}
        >
          <View style={styles.figurePickerHeader}>
            <View style={styles.figurePickerHeaderCopy}>
              <Text style={[styles.figurePickerTitle, { color: palette.text }]} maxFontSizeMultiplier={textScale}>
                Cite Image
              </Text>
              <Text style={[styles.figurePickerSubtitle, { color: palette.muted }]} maxFontSizeMultiplier={textScale}>
                {request ? `Insert into ${request.fieldLabel}` : "Select a figure"}
              </Text>
            </View>
            <Pressable style={[styles.figurePickerClose, { borderColor: palette.border, backgroundColor: palette.panelSoft }]} onPress={onClose}>
              <Text style={[styles.figurePickerCloseText, { color: palette.text }]} maxFontSizeMultiplier={textScale}>Close</Text>
            </Pressable>
          </View>
          {galleryImages.length === 0 ? (
            <View style={[styles.figurePickerEmpty, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}>
              <Text style={[styles.figurePickerEmptyText, { color: palette.muted }]} maxFontSizeMultiplier={textScale}>
                No uploaded images yet. Upload a photo first, then type / to cite it here.
              </Text>
            </View>
          ) : (
            <ScrollView style={styles.figurePickerScroll} contentContainerStyle={styles.figurePickerScrollContent}>
              {grouped.map((section) => (
                <View key={`figure-picker-${section.key}`} style={styles.figurePickerSection}>
                  <Text style={[styles.figurePickerSectionTitle, { color: palette.text }]} maxFontSizeMultiplier={textScale}>
                    {section.label}
                  </Text>
                  <View style={styles.figurePickerGrid}>
                    {section.images.map((image) => {
                      const previewFailed = !!failedPreviewIds[image.id];
                      return (
                        <Pressable
                          key={`figure-picker-image-${image.id}`}
                          style={[styles.figurePickerTile, { width: tileWidth, borderColor: palette.border, backgroundColor: palette.panelSoft }]}
                          onPress={() => {
                            request?.onSelect(image);
                            onClose();
                          }}
                        >
                          <View style={styles.figurePickerImageWrap}>
                            {!previewFailed ? (
                              <Image
                                source={previewSource(image.id)}
                                style={styles.figurePickerImage}
                                resizeMode="cover"
                                onError={() => onPreviewError(image.id)}
                              />
                            ) : (
                              <View style={styles.figurePickerFallback}>
                                <Text style={styles.figurePickerFallbackText}>Image</Text>
                              </View>
                            )}
                            <View style={styles.figurePickerBadge}>
                              <Text style={styles.figurePickerBadgeText} numberOfLines={1} maxFontSizeMultiplier={textScale}>
                                {image.figureLabel}
                              </Text>
                            </View>
                          </View>
                          <Text style={[styles.figurePickerFileName, { color: palette.muted }]} numberOfLines={1} maxFontSizeMultiplier={textScale}>
                            {image.file_name}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ))}
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
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
  palette?: { muted: string; border: string; panel: string; panelSoft: string; text: string };
  error?: string;
}) {
  const { componentScale, textScale } = useUiSettings();
  const scale = Math.max(1, componentScale);
  const textValue = value.trim() || placeholder;
  return (
    <View style={{ marginTop: Math.round(8 * scale) }}>
      <View style={[styles.labelRow, { gap: Math.round(6 * scale) }]}>
        <Text style={[styles.label, { color: error ? "#dc2626" : (palette?.muted ?? "#465978"), fontSize: Math.round(13 * scale) }]} maxFontSizeMultiplier={textScale}>{label}</Text>
        {error ? (
          <View style={[styles.errorIcon, { width: Math.round(16 * scale), height: Math.round(16 * scale), borderRadius: Math.round(8 * scale) }]}>
            <Text style={[styles.errorIconText, { fontSize: Math.round(10 * scale), lineHeight: Math.round(12 * scale) }]} maxFontSizeMultiplier={textScale}>i</Text>
          </View>
        ) : null}
      </View>
      <ScrollSafePressable
        disabled={!editable}
        onPress={onPress}
        style={[
          styles.input,
          {
            borderColor: error ? "#ef4444" : (palette?.border ?? "#ccd8ea"),
            backgroundColor: palette?.panelSoft ?? "#f7f8fc",
            opacity: editable ? 1 : 0.7,
            justifyContent: "center",
            borderRadius: Math.round((Platform.OS === "ios" ? 10 : 8) * scale),
            paddingHorizontal: Math.round(10 * scale),
            paddingVertical: Math.round((Platform.OS === "ios" ? 10 : 8) * scale),
            minHeight: Math.round(44 * scale),
          },
        ]}
      >
        <Text style={{ color: value.trim() ? (palette?.text ?? "#1b2a40") : (palette?.muted ?? "#6b7280"), fontSize: Math.round((Platform.OS === "ios" ? 16 : 14) * scale) }} maxFontSizeMultiplier={textScale}>
          {textValue}
        </Text>
      </ScrollSafePressable>
      {error ? <Text style={[styles.errorText, { fontSize: Math.round(11 * scale), marginTop: Math.round(4 * scale) }]} maxFontSizeMultiplier={textScale}>{error}</Text> : null}
    </View>
  );
}

type MaterialSectionKey = "slope" | "pavement" | "debris";

function MaterialSectionBubble({
  label,
  active,
  onPress,
  palette,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  palette: { primary: string; border: string; panelSoft: string; text: string };
}) {
  const { componentScale, textScale } = useUiSettings();
  const scale = Math.max(1, componentScale);

  return (
    <ScrollSafePressable
      onPress={onPress}
      style={[
        styles.materialSectionBubble,
        {
          minHeight: Math.round(44 * scale),
          paddingHorizontal: Math.round(12 * scale),
          paddingVertical: Math.round(8 * scale),
          borderColor: active ? palette.primary : palette.border,
          backgroundColor: active ? palette.primary : palette.panelSoft,
        },
      ]}
    >
      <Text
        style={[
          styles.materialSectionBubbleText,
          {
            color: active ? "#ffffff" : palette.text,
            fontSize: Math.round(12 * scale),
          },
        ]}
        maxFontSizeMultiplier={textScale}
      >
        {label}
      </Text>
    </ScrollSafePressable>
  );
}

function MaterialSubsection({
  title,
  children,
  palette,
}: {
  title: string;
  children: React.ReactNode;
  palette: { border: string; text: string; panelSoft: string };
}) {
  return (
    <View style={[styles.materialSubsectionCard, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}>
      <Text style={[styles.materialSubsectionTitle, { color: palette.text }]}>{title}</Text>
      <View style={styles.materialSubsectionBody}>{children}</View>
    </View>
  );
}

function SteppedPercentInput({
  label,
  value,
  editable,
  palette,
  onChange,
}: {
  label: string;
  value: string;
  editable: boolean;
  palette: { panel: string; panelSoft: string; border: string; text: string; muted: string; primary: string };
  onChange: (value: string) => void;
}) {
  const { componentScale, textScale } = useUiSettings();
  const scale = Math.max(1, componentScale);
  const thumbSize = Math.round(30 * scale);
  const thumbTouchSize = Math.round(46 * scale);
  const trackHeight = thumbTouchSize;
  const railHeight = Math.round(12 * scale);
  const numericValue = Math.max(0, Math.min(100, Number(value || 0) || 0));
  const stepValue = Math.round(numericValue / 5) * 5;
  const [trackWidth, setTrackWidth] = useState(0);
  const [interactionStep, setInteractionStep] = useState<number | null>(null);
  const dragActiveRef = useRef(false);
  const hasSliderMovedRef = useRef(false);
  const dragStartStepRef = useRef(stepValue);
  const currentStepRef = useRef(stepValue);
  const thumbLeftRef = useRef(0);
  const lastHapticStepRef = useRef(stepValue);
  const displayStepValue = interactionStep ?? stepValue;

  useEffect(() => {
    if (dragActiveRef.current) return;
    lastHapticStepRef.current = stepValue;
    setInteractionStep(null);
  }, [stepValue]);

  const previewStepValue = useCallback(
    (next: number) => {
      if (!editable) return null;
      const clamped = Math.max(0, Math.min(100, Math.round(next / 5) * 5));
      setInteractionStep(clamped);
      if (clamped !== lastHapticStepRef.current) {
        lastHapticStepRef.current = clamped;
        void Haptics.selectionAsync().catch(() => {});
      }
      return clamped;
    },
    [editable]
  );
  const usableTrackWidth = Math.max(trackWidth - thumbSize, 1);
  const thumbLeft = trackWidth > thumbSize ? usableTrackWidth * (displayStepValue / 100) : 0;
  currentStepRef.current = displayStepValue;
  thumbLeftRef.current = thumbLeft;
  const fillWidth = trackWidth > 0 ? Math.min(trackWidth, Math.max(thumbSize / 2, thumbLeft + thumbSize / 2)) : 0;
  const updateValueFromDrag = useCallback(
    (dx: number) => {
      if (!editable) return null;
      const ratio = clamp01(dragStartStepRef.current / 100 + dx / usableTrackWidth);
      return previewStepValue(ratio * 100);
    },
    [editable, previewStepValue, usableTrackWidth]
  );
  const commitValueFromDrag = useCallback(
    (dx: number) => {
      const next = updateValueFromDrag(dx);
      if (next == null) return;
      onChange(String(next));
    },
    [onChange, updateValueFromDrag]
  );
  const thumbResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: (evt) => {
          if (!editable || trackWidth <= thumbSize) return false;
          const hitboxLeft = thumbLeftRef.current - (thumbTouchSize - thumbSize) / 2;
          const touchX = evt.nativeEvent.locationX;
          return touchX >= hitboxLeft && touchX <= hitboxLeft + thumbTouchSize;
        },
        onStartShouldSetPanResponderCapture: () => false,
        onMoveShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponderCapture: () => false,
        onPanResponderGrant: () => {
          dragActiveRef.current = true;
          hasSliderMovedRef.current = false;
          dragStartStepRef.current = currentStepRef.current;
          lastHapticStepRef.current = currentStepRef.current;
          setInteractionStep(currentStepRef.current);
        },
        onPanResponderMove: (_evt, gesture) => {
          if (Math.abs(gesture.dx) > 3) hasSliderMovedRef.current = true;
          updateValueFromDrag(gesture.dx);
        },
        onPanResponderRelease: (_evt, gesture) => {
          commitValueFromDrag(gesture.dx);
          dragActiveRef.current = false;
          hasSliderMovedRef.current = false;
        },
        onPanResponderTerminate: (_evt, gesture) => {
          commitValueFromDrag(gesture.dx);
          dragActiveRef.current = false;
          hasSliderMovedRef.current = false;
        },
        onPanResponderTerminationRequest: () => !hasSliderMovedRef.current,
        onShouldBlockNativeResponder: () => true,
      }),
    [commitValueFromDrag, editable, thumbSize, thumbTouchSize, trackWidth, updateValueFromDrag]
  );

  return (
    <View style={styles.materialPercentControl}>
      <View style={styles.materialPercentLabelRow}>
        <Text
          style={[styles.label, { color: palette.muted, fontSize: Math.round(13 * scale) }]}
          maxFontSizeMultiplier={textScale}
        >
          {label}
        </Text>
        <Text
          style={[styles.materialPercentValue, { color: palette.text, fontSize: Math.round(13 * scale) }]}
          maxFontSizeMultiplier={textScale}
        >
          {`${displayStepValue}%`}
        </Text>
      </View>
      <View style={styles.materialPercentSliderRow}>
        <View
          {...(editable ? thumbResponder.panHandlers : {})}
          style={[
            styles.materialPercentTrackShell,
            {
              height: trackHeight,
              opacity: editable ? 1 : 0.6,
            },
          ]}
          onLayout={(evt) => {
            const nextWidth = Math.round(evt.nativeEvent.layout.width);
            setTrackWidth((current) => (current === nextWidth ? current : nextWidth));
          }}
        >
          <View
            style={[
              styles.materialPercentTrackRail,
              {
                height: railHeight,
                borderColor: palette.border,
                backgroundColor: palette.panel,
              },
            ]}
          >
            <View
              style={[
                styles.materialPercentTrackFill,
                {
                  width: fillWidth,
                  backgroundColor: palette.primary,
                },
              ]}
            />
          </View>
          <View style={styles.materialPercentTickRow} pointerEvents="none">
            {Array.from({ length: 21 }, (_, idx) => {
              const currentStep = idx * 5;
              const active = currentStep <= displayStepValue;
              return (
                <View key={`${label}-${currentStep}`} style={styles.materialPercentTickSlot}>
                  <View
                    style={[
                      styles.materialPercentTick,
                      {
                        backgroundColor: active ? "#ffffff" : palette.border,
                        height: idx % 2 === 0 ? Math.round(10 * scale) : Math.round(7 * scale),
                        opacity: active ? 0.95 : 0.8,
                      },
                    ]}
                  />
                </View>
              );
            })}
          </View>
          <View
            pointerEvents="none"
            style={[
              styles.materialPercentThumbHitbox,
              {
                width: thumbTouchSize,
                height: thumbTouchSize,
                left: thumbLeft - (thumbTouchSize - thumbSize) / 2,
                top: Math.round((trackHeight - thumbTouchSize) / 2),
              },
            ]}
          >
            <View
              style={[
                styles.materialPercentThumb,
                {
                  width: thumbSize,
                  height: thumbSize,
                  borderColor: palette.primary,
                  backgroundColor: palette.panelSoft,
                },
              ]}
            >
              <View
                style={[
                  styles.materialPercentThumbCore,
                  {
                    backgroundColor: palette.primary,
                    width: Math.round(8 * scale),
                    height: Math.round(8 * scale),
                    borderRadius: Math.round(4 * scale),
                  },
                ]}
              />
            </View>
          </View>
        </View>
        <View style={styles.materialPercentRangeRow}>
          <Text
            style={[styles.materialPercentRangeText, { color: palette.muted, fontSize: Math.round(11 * scale) }]}
            maxFontSizeMultiplier={textScale}
          >
            0%
          </Text>
          <Text
            style={[styles.materialPercentRangeText, { color: palette.muted, fontSize: Math.round(11 * scale) }]}
            maxFontSizeMultiplier={textScale}
          >
            100%
          </Text>
        </View>
      </View>
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
  const { componentScale, textScale } = useUiSettings();
  const scale = Math.max(1, componentScale);
  const isIOS = Platform.OS === "ios";
  return (
    <View style={[styles.section, isIOS ? styles.iosSection : null, { backgroundColor: palette.panel, borderColor: palette.border, padding: Math.round((compact ? 10 : 12) * scale), borderRadius: Math.round((isIOS ? 12 : 14) * scale) }]}>
      <ScrollSafePressable onPress={onToggle} style={styles.sectionHeader}>
        <Text style={[styles.sectionTitle, { color: palette.text, fontSize: Math.round((isIOS ? 23 / 1.45 : 22 / 1.45) * scale) }]} maxFontSizeMultiplier={textScale}>{title}</Text>
        <Text style={[styles.sectionChevron, { color: palette.muted, fontSize: Math.round((isIOS ? 18 : 16) * scale) }]} maxFontSizeMultiplier={textScale}>{open ? (isIOS ? "⌄" : "v") : ">"}</Text>
      </ScrollSafePressable>
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
  const { componentScale, textScale } = useUiSettings();
  const scale = Math.max(1, componentScale);
  return (
    <View style={[styles.dropdownBlock, { backgroundColor: palette.panel, borderColor: palette.border, borderRadius: Math.round((Platform.OS === "ios" ? 12 : 14) * scale), padding: Math.round((Platform.OS === "ios" ? 10 : 12) * scale) }]}>
      <ScrollSafePressable onPress={onToggle} style={styles.dropdownBlockHeader}>
        <Text style={[styles.dropdownBlockTitle, { color: palette.text, fontSize: Math.round((Platform.OS === "ios" ? 23 / 1.45 : 22 / 1.45) * scale) }]} maxFontSizeMultiplier={textScale}>{title}</Text>
        <Text style={[styles.sectionChevron, { color: palette.muted, fontSize: Math.round((Platform.OS === "ios" ? 18 : 16) * scale) }]} maxFontSizeMultiplier={textScale}>{open ? "v" : ">"}</Text>
      </ScrollSafePressable>
      {open ? <View style={{ marginTop: Math.round(6 * scale) }}>{children}</View> : null}
    </View>
  );
}

type AnnotationPalette = {
  primary: string;
  border: string;
  panel: string;
  panelSoft: string;
  text: string;
  muted: string;
};

function PavementDrawerToken({
  id,
  title,
  summary,
  placed,
  active,
  editable,
  palette,
  onSelect,
  onDragStart,
  onDragMove,
  onDragEnd,
}: {
  id: PavementAnnotationId;
  title: string;
  summary: string;
  placed: boolean;
  active: boolean;
  editable: boolean;
  palette: AnnotationPalette;
  onSelect: (id: PavementAnnotationId) => void;
  onDragStart: (id: PavementAnnotationId, pageX: number, pageY: number) => void;
  onDragMove: (id: PavementAnnotationId, pageX: number, pageY: number) => void;
  onDragEnd: (id: PavementAnnotationId, pageX: number, pageY: number, moved: boolean) => void;
}) {
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onStartShouldSetPanResponderCapture: () => false,
        onMoveShouldSetPanResponder: (_evt, gesture) =>
          editable && Math.abs(gesture.dx) > 6 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
        onMoveShouldSetPanResponderCapture: (_evt, gesture) =>
          editable && Math.abs(gesture.dx) > 6 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
        onPanResponderGrant: (evt) => {
          onDragStart(id, evt.nativeEvent.pageX, evt.nativeEvent.pageY);
        },
        onPanResponderMove: (evt) => {
          onDragMove(id, evt.nativeEvent.pageX, evt.nativeEvent.pageY);
        },
        onPanResponderRelease: (evt) => {
          onDragEnd(id, evt.nativeEvent.pageX, evt.nativeEvent.pageY, true);
        },
        onPanResponderTerminate: (evt) => {
          onDragEnd(id, evt.nativeEvent.pageX, evt.nativeEvent.pageY, true);
        },
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => true,
      }),
    [editable, id, onDragEnd, onDragMove, onDragStart, onSelect]
  );

  return (
    <View
      {...(editable ? responder.panHandlers : {})}
      style={[
        styles.annotationDrawerToken,
        {
          borderColor: active ? palette.primary : palette.border,
          backgroundColor: active ? palette.panelSoft : palette.panel,
          opacity: editable ? 1 : 0.75,
        },
      ]}
    >
      <Pressable onPress={() => onSelect(id)}>
        <View style={styles.annotationDrawerTokenHeader}>
          <Text style={[styles.annotationDrawerTokenTitle, { color: palette.text }]}>{title}</Text>
          <Text style={[styles.annotationDrawerTokenStatus, { color: placed ? palette.primary : palette.muted }]}>
            {placed ? "On Photo" : "Not Placed"}
          </Text>
        </View>
        <Text
          numberOfLines={active ? 4 : 1}
          style={[styles.annotationDrawerTokenSummary, { color: active ? palette.text : palette.muted }]}
        >
          {summary}
        </Text>
        {active ? (
          <Text style={[styles.annotationDrawerTokenHint, { color: palette.muted }]}>
            {editable ? "Swipe left onto the photo or tap to edit." : "Tap to view details."}
          </Text>
        ) : null}
      </Pressable>
    </View>
  );
}

function PavementCanvasMarker({
  id,
  glyph,
  left,
  top,
  active,
  editable,
  variant = "anchor",
  palette,
  onSelect,
  onDragStart,
  onDragMove,
  onDragEnd,
}: {
  id: PavementAnnotationId;
  glyph: string;
  left: number;
  top: number;
  active: boolean;
  editable: boolean;
  variant?: "anchor" | "rangeEnd";
  palette: AnnotationPalette;
  onSelect: (id: PavementAnnotationId, handle: "anchor" | "rangeEnd") => void;
  onDragStart: (id: PavementAnnotationId, handle: "anchor" | "rangeEnd") => void;
  onDragMove: (id: PavementAnnotationId, handle: "anchor" | "rangeEnd", dx: number, dy: number) => void;
  onDragEnd: (id: PavementAnnotationId, handle: "anchor" | "rangeEnd", moved: boolean) => void;
}) {
  const movedRef = useRef(false);
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => editable,
        onStartShouldSetPanResponderCapture: () => editable,
        onMoveShouldSetPanResponder: () => editable,
        onMoveShouldSetPanResponderCapture: () => editable,
        onPanResponderGrant: () => {
          movedRef.current = false;
          onDragStart(id, variant);
        },
        onPanResponderMove: (_evt, gesture) => {
          if (Math.abs(gesture.dx) > 2 || Math.abs(gesture.dy) > 2) movedRef.current = true;
          onDragMove(id, variant, gesture.dx, gesture.dy);
        },
        onPanResponderRelease: (_evt, gesture) => {
          const moved = movedRef.current || Math.abs(gesture.dx) > 2 || Math.abs(gesture.dy) > 2;
          onDragEnd(id, variant, moved);
          if (!moved) onSelect(id, variant);
        },
        onPanResponderTerminate: (_evt, gesture) => {
          const moved = movedRef.current || Math.abs(gesture.dx) > 2 || Math.abs(gesture.dy) > 2;
          onDragEnd(id, variant, moved);
          if (!moved) onSelect(id, variant);
        },
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => true,
      }),
    [editable, id, onDragEnd, onDragMove, onDragStart, onSelect, variant]
  );

  return (
    <View
      {...(editable ? responder.panHandlers : {})}
      style={[
        styles.annotationMarker,
        {
          left,
          top,
          borderColor: active ? "#ffffff" : palette.primary,
          backgroundColor:
            variant === "anchor"
              ? active
                ? palette.primary
                : "rgba(255,255,255,0.85)"
              : active
                ? "#f8fbff"
                : "rgba(255,255,255,0.65)",
        },
        variant === "rangeEnd" ? styles.annotationMarkerRangeEnd : null,
      ]}
    >
      {variant === "anchor" ? (
        <Text style={[styles.annotationMarkerText, { color: active ? "#ffffff" : palette.primary }]}>{glyph}</Text>
      ) : (
        <View style={[styles.annotationMarkerRangeEndDot, { backgroundColor: active ? palette.primary : "#0f172a" }]} />
      )}
    </View>
  );
}

function PavementGroundAnnotator({
  form,
  fieldErrors,
  canEdit,
  busy,
  palette,
  imageSource,
  imageName,
  onUploadPhoto,
  setVal,
}: {
  form: FormState;
  fieldErrors: FieldErrorMap;
  canEdit: boolean;
  busy: boolean;
  palette: AnnotationPalette;
  imageSource?: { uri: string } | null;
  imageName?: string | null;
  onUploadPhoto: () => void;
  setVal: (key: keyof FormState, value: string) => void;
}) {
  const MARKER_SIZE = 32;
  const { width: windowWidth } = useWindowDimensions();
  const stageRef = useRef<View | null>(null);
  const markerDragRef = useRef<null | { id: PavementAnnotationId; handle: "anchor" | "rangeEnd"; originLeft: number; originTop: number; left: number; top: number }>(null);
  const lastPersistedLayoutRef = useRef(form.pavement_ground_annotation_layout);
  const drawerProgress = useRef(new Animated.Value(0)).current;
  const [annotationLayout, setAnnotationLayout] = useState<PavementAnnotationLayout>(() =>
    parsePavementAnnotationLayout(form.pavement_ground_annotation_layout)
  );
  const [activeAnnotation, setActiveAnnotation] = useState<PavementAnnotationId | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [imageAspectRatio, setImageAspectRatio] = useState(4 / 3);
  const [stageAreaSize, setStageAreaSize] = useState({ width: 0, height: 0 });
  const [stageBounds, setStageBounds] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const [drawerDrag, setDrawerDrag] = useState<null | { id: PavementAnnotationId; x: number; y: number }>(null);
  const [markerDrag, setMarkerDrag] = useState<null | { id: PavementAnnotationId; handle: "anchor" | "rangeEnd"; originLeft: number; originTop: number; left: number; top: number }>(null);
  const [canvasPopoverAnnotation, setCanvasPopoverAnnotation] = useState<PavementAnnotationId | null>(null);

  useEffect(() => {
    if (form.pavement_ground_annotation_layout === lastPersistedLayoutRef.current) return;
    setAnnotationLayout(parsePavementAnnotationLayout(form.pavement_ground_annotation_layout));
    lastPersistedLayoutRef.current = form.pavement_ground_annotation_layout;
  }, [form.pavement_ground_annotation_layout]);

  useEffect(() => {
    if (!imageSource) {
      setActiveAnnotation(null);
      setStageAreaSize({ width: 0, height: 0 });
      setStageBounds({ x: 0, y: 0, width: 0, height: 0 });
      setMarkerDrag(null);
      setDrawerDrag(null);
      setCanvasPopoverAnnotation(null);
      setImageAspectRatio(4 / 3);
    }
  }, [imageSource]);

  useEffect(() => {
    Animated.spring(drawerProgress, {
      toValue: drawerOpen ? 1 : 0,
      damping: 20,
      mass: 0.95,
      stiffness: 180,
      overshootClamping: false,
      useNativeDriver: true,
    }).start();
  }, [drawerOpen, drawerProgress]);

  useEffect(() => {
    if (editorOpen) {
      setDrawerOpen(true);
      return;
    }
    setDrawerOpen(false);
    setDrawerDrag(null);
    setMarkerDrag(null);
    setCanvasPopoverAnnotation(null);
    markerDragRef.current = null;
  }, [editorOpen]);

  const persistAnnotationLayout = useCallback(
    (next: PavementAnnotationLayout) => {
      const serialized = stringifyPavementAnnotationLayout(next);
      lastPersistedLayoutRef.current = serialized;
      setAnnotationLayout(next);
      setVal(PAVEMENT_ANNOTATION_FIELD as keyof FormState, serialized);
    },
    [setVal]
  );

  const stageSize = useMemo(() => {
    const width = stageAreaSize.width;
    const height = stageAreaSize.height;
    if (!width || !height) return { width: 0, height: 0 };
    const areaRatio = width / height;
    if (imageAspectRatio >= areaRatio) {
      return { width, height: width / imageAspectRatio };
    }
    return { width: height * imageAspectRatio, height };
  }, [imageAspectRatio, stageAreaSize.height, stageAreaSize.width]);

  const refreshStageBounds = useCallback(() => {
    requestAnimationFrame(() => {
      stageRef.current?.measureInWindow((x, y, width, height) => {
        if (Number.isFinite(x) && Number.isFinite(y) && width > 0 && height > 0) {
          setStageBounds({ x, y, width, height });
        }
      });
    });
  }, []);

  const markerStageBounds = useMemo(() => {
    const maxLeft = Math.max(0, stageSize.width - MARKER_SIZE);
    const maxTop = Math.max(0, stageSize.height - MARKER_SIZE);
    return { maxLeft, maxTop };
  }, [MARKER_SIZE, stageSize.height, stageSize.width]);

  const clampMarkerPosition = useCallback(
    (left: number, top: number) => ({
      left: Math.max(0, Math.min(left, markerStageBounds.maxLeft)),
      top: Math.max(0, Math.min(top, markerStageBounds.maxTop)),
    }),
    [markerStageBounds.maxLeft, markerStageBounds.maxTop]
  );

  const getLayoutPosition = useCallback(
    (point: PavementAnnotationPoint | null | undefined) => {
      if (!point) return null;
      return clampMarkerPosition(point.x * markerStageBounds.maxLeft, point.y * markerStageBounds.maxTop);
    },
    [clampMarkerPosition, markerStageBounds.maxLeft, markerStageBounds.maxTop]
  );

  const commitMarkerPosition = useCallback(
    (id: PavementAnnotationId, left: number, top: number, placed = true) => {
      const nextPosition = clampMarkerPosition(left, top);
      const current = annotationLayout[id];
      const next: PavementAnnotationLayout = {
        ...annotationLayout,
        [id]: {
          x: markerStageBounds.maxLeft > 0 ? nextPosition.left / markerStageBounds.maxLeft : 0,
          y: markerStageBounds.maxTop > 0 ? nextPosition.top / markerStageBounds.maxTop : 0,
          placed,
          rangeEnd: current.rangeEnd,
        },
      };
      persistAnnotationLayout(next);
      return nextPosition;
    },
    [annotationLayout, clampMarkerPosition, markerStageBounds.maxLeft, markerStageBounds.maxTop, persistAnnotationLayout]
  );

  const commitRangeEndPosition = useCallback(
    (id: PavementAnnotationId, left: number, top: number) => {
      const nextPosition = clampMarkerPosition(left, top);
      const current = annotationLayout[id];
      const next: PavementAnnotationLayout = {
        ...annotationLayout,
        [id]: {
          ...current,
          rangeEnd: {
            x: markerStageBounds.maxLeft > 0 ? nextPosition.left / markerStageBounds.maxLeft : 0,
            y: markerStageBounds.maxTop > 0 ? nextPosition.top / markerStageBounds.maxTop : 0,
          },
        },
      };
      persistAnnotationLayout(next);
      return nextPosition;
    },
    [annotationLayout, clampMarkerPosition, markerStageBounds.maxLeft, markerStageBounds.maxTop, persistAnnotationLayout]
  );

  useEffect(() => {
    if (!editorOpen) return;
    const timer = setTimeout(refreshStageBounds, 60);
    return () => clearTimeout(timer);
  }, [editorOpen, refreshStageBounds, stageSize.height, stageSize.width]);

  const placeAnnotationAtPoint = useCallback(
    (id: PavementAnnotationId, pageX: number, pageY: number) => {
      if (stageBounds.width <= 0 || stageBounds.height <= 0) return false;
      if (
        pageX < stageBounds.x ||
        pageX > stageBounds.x + stageBounds.width ||
        pageY < stageBounds.y ||
        pageY > stageBounds.y + stageBounds.height
      ) {
        return false;
      }
      const nextLeft = pageX - stageBounds.x - MARKER_SIZE / 2;
      const nextTop = pageY - stageBounds.y - MARKER_SIZE / 2;
      commitMarkerPosition(id, nextLeft, nextTop, true);
      return true;
    },
    [MARKER_SIZE, commitMarkerPosition, stageBounds.height, stageBounds.width, stageBounds.x, stageBounds.y]
  );

  const resetPositions = useCallback(() => {
    const next: PavementAnnotationLayout = { ...annotationLayout };
    PAVEMENT_ANNOTATION_ORDER.forEach((id) => {
      next[id] = {
        ...DEFAULT_PAVEMENT_ANNOTATION_LAYOUT[id],
        placed: annotationLayout[id]?.placed ?? false,
        rangeEnd: annotationLayout[id]?.rangeEnd ?? null,
      };
    });
    persistAnnotationLayout(next);
  }, [annotationLayout, persistAnnotationLayout]);

  const removePlacement = useCallback(
    (id: PavementAnnotationId) => {
      const next: PavementAnnotationLayout = {
        ...annotationLayout,
        [id]: {
          ...annotationLayout[id],
          placed: false,
          rangeEnd: null,
        },
      };
      persistAnnotationLayout(next);
      if (activeAnnotation === id) setActiveAnnotation(null);
      if (canvasPopoverAnnotation === id) setCanvasPopoverAnnotation(null);
    },
    [activeAnnotation, annotationLayout, canvasPopoverAnnotation, persistAnnotationLayout]
  );

  const clearCrackMeasurements = useCallback(() => {
    setVal("crack_length_ft", "");
    setVal("crack_horizontal_in", "");
    setVal("crack_vertical_in", "");
    setVal("crack_depth_in", "");
  }, [setVal]);

  const glyphForAnnotation = useCallback((id: PavementAnnotationId) => {
    if (id === "crack") return "C";
    if (id === "settlement") return "S";
    if (id === "bulge") return "B";
    return "R";
  }, []);

  const annotationRows = useMemo(
    () =>
      PAVEMENT_ANNOTATION_ORDER.map((id) => ({
        id,
        title: PAVEMENT_ANNOTATION_TITLES[id],
        shortSummary: pavementAnnotationShortSummary(id, form),
        longSummary: pavementAnnotationLongSummary(id, form),
        hasValue: pavementAnnotationHasValue(id, form),
        placed: annotationLayout[id]?.placed ?? false,
      })),
    [annotationLayout, form]
  );

  const selectAnnotationFromDrawer = useCallback(
    (id: PavementAnnotationId) => {
      setActiveAnnotation(id);
      setCanvasPopoverAnnotation(null);
      setDrawerOpen(true);
    },
    []
  );

  const selectAnnotationFromCanvas = useCallback(
    (id: PavementAnnotationId, _handle?: "anchor" | "rangeEnd") => {
      setActiveAnnotation(id);
      setCanvasPopoverAnnotation(id);
      setDrawerOpen(false);
    },
    []
  );

  const beginDrawerDrag = useCallback((id: PavementAnnotationId, pageX: number, pageY: number) => {
    refreshStageBounds();
    setDrawerDrag({ id, x: pageX, y: pageY });
  }, [refreshStageBounds]);

  const moveDrawerDrag = useCallback((id: PavementAnnotationId, pageX: number, pageY: number) => {
    setDrawerDrag((current) => (current?.id === id ? { id, x: pageX, y: pageY } : { id, x: pageX, y: pageY }));
  }, []);

  const endDrawerDrag = useCallback(
    (id: PavementAnnotationId, pageX: number, pageY: number, moved: boolean) => {
      if (moved) {
        placeAnnotationAtPoint(id, pageX, pageY);
      }
      setDrawerDrag(null);
    },
    [placeAnnotationAtPoint]
  );

  const beginMarkerDrag = useCallback(
    (id: PavementAnnotationId, handle: "anchor" | "rangeEnd") => {
      const layout = annotationLayout[id];
      const point =
        handle === "rangeEnd"
          ? getLayoutPosition(layout.rangeEnd)
          : {
              left: layout.x * markerStageBounds.maxLeft,
              top: layout.y * markerStageBounds.maxTop,
            };
      if (!point) return;
      const next = {
        id,
        handle,
        originLeft: point.left,
        originTop: point.top,
        left: point.left,
        top: point.top,
      };
      markerDragRef.current = next;
      setMarkerDrag(next);
    },
    [annotationLayout, getLayoutPosition, markerStageBounds.maxLeft, markerStageBounds.maxTop]
  );

  const moveMarkerDrag = useCallback(
    (id: PavementAnnotationId, handle: "anchor" | "rangeEnd", dx: number, dy: number) => {
      const current = markerDragRef.current;
      if (!current || current.id !== id || current.handle !== handle) return;
      const nextPosition = clampMarkerPosition(current.originLeft + dx, current.originTop + dy);
      const next = {
        ...current,
        left: nextPosition.left,
        top: nextPosition.top,
      };
      markerDragRef.current = next;
      setMarkerDrag(next);
    },
    [clampMarkerPosition]
  );

  const endMarkerDrag = useCallback(
    (id: PavementAnnotationId, handle: "anchor" | "rangeEnd", moved: boolean) => {
      const current = markerDragRef.current;
      if (moved && current?.id === id && current.handle === handle) {
        if (handle === "rangeEnd") {
          commitRangeEndPosition(id, current.left, current.top);
        } else {
          commitMarkerPosition(id, current.left, current.top, true);
        }
      }
      markerDragRef.current = null;
      setMarkerDrag(null);
    },
    [commitMarkerPosition, commitRangeEndPosition]
  );

  const addRangeReference = useCallback(
    (id: PavementAnnotationId) => {
      const current = annotationLayout[id];
      const anchorLeft = current.x * markerStageBounds.maxLeft;
      const anchorTop = current.y * markerStageBounds.maxTop;
      const defaultOffset = Math.max(54, Math.min(markerStageBounds.maxLeft * 0.22, 120));
      const nextPosition = clampMarkerPosition(anchorLeft + defaultOffset, anchorTop);
      const next: PavementAnnotationLayout = {
        ...annotationLayout,
        [id]: {
          ...current,
          rangeEnd: {
            x: markerStageBounds.maxLeft > 0 ? nextPosition.left / markerStageBounds.maxLeft : current.x,
            y: markerStageBounds.maxTop > 0 ? nextPosition.top / markerStageBounds.maxTop : current.y,
          },
        },
      };
      persistAnnotationLayout(next);
    },
    [annotationLayout, clampMarkerPosition, markerStageBounds.maxLeft, markerStageBounds.maxTop, persistAnnotationLayout]
  );

  const removeRangeReference = useCallback(
    (id: PavementAnnotationId) => {
      const current = annotationLayout[id];
      const next: PavementAnnotationLayout = {
        ...annotationLayout,
        [id]: {
          ...current,
          rangeEnd: null,
        },
      };
      persistAnnotationLayout(next);
    },
    [annotationLayout, persistAnnotationLayout]
  );

  const renderAnnotationFields = (mode: "drawer" | "popover" = "drawer") => {
    const popoverMode = mode === "popover";
    const headingColor = popoverMode ? "#f8fbff" : palette.text;
    const secondaryColor = popoverMode ? "rgba(248,251,255,0.9)" : palette.muted;
    const panelBg = popoverMode ? "rgba(255,255,255,0.06)" : palette.panel;
    if (!activeAnnotation) {
      return <Text style={[styles.annotationDrawerEmptyText, { color: palette.muted }]}>Tap a label in the drawer or a marker on the photo to edit it.</Text>;
    }

    return (
      <>
        {!popoverMode ? (
          <Text style={[styles.pickerTitle, styles.annotationFieldTitle, { color: headingColor }]}>{PAVEMENT_ANNOTATION_TITLES[activeAnnotation]}</Text>
        ) : null}

        {activeAnnotation === "crack" ? (
          <>
            <Text style={[styles.label, styles.annotationFieldLabel, { color: secondaryColor }]}>Pavement/Ground Cracks</Text>
            <View style={styles.chips}>
              {(["YES", "NO"] as const).map((choice) => (
                <Chip
                  key={`annot-crack-${choice}`}
                  label={choice}
                  palette={palette}
                  active={form.pavement_ground_cracks === choice}
                  disabled={!canEdit}
                  onPress={() => {
                    if (!canEdit) return;
                    setVal("pavement_ground_cracks", choice);
                    if (choice !== "YES") {
                      clearCrackMeasurements();
                    }
                  }}
                />
              ))}
            </View>
            {form.pavement_ground_cracks === "YES" ? (
              <>
                <Field palette={{ ...palette, muted: secondaryColor, panel: panelBg, panelSoft: panelBg, text: headingColor }} label="Length (feet)" value={form.crack_length_ft} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("crack_length_ft", v)} error={fieldErrors.crack_length_ft} />
                <Field palette={{ ...palette, muted: secondaryColor, panel: panelBg, panelSoft: panelBg, text: headingColor }} label="Horizontal Disp (inches)" value={form.crack_horizontal_in} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("crack_horizontal_in", v)} error={fieldErrors.crack_horizontal_in} />
                <Field palette={{ ...palette, muted: secondaryColor, panel: panelBg, panelSoft: panelBg, text: headingColor }} label="Vertical Disp (inches)" value={form.crack_vertical_in} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("crack_vertical_in", v)} error={fieldErrors.crack_vertical_in} />
                <Field palette={{ ...palette, muted: secondaryColor, panel: panelBg, panelSoft: panelBg, text: headingColor }} label="Depth of Crack (inches)" value={form.crack_depth_in} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("crack_depth_in", v)} error={fieldErrors.crack_depth_in} />
              </>
            ) : null}
          </>
        ) : null}

        {activeAnnotation === "settlement" ? (
          <Field palette={{ ...palette, muted: secondaryColor, panel: panelBg, panelSoft: panelBg, text: headingColor }} label="Settlement (inches)" value={form.settlement_in} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("settlement_in", v)} error={fieldErrors.settlement_in} />
        ) : null}

        {activeAnnotation === "bulge" ? (
          <Field palette={{ ...palette, muted: secondaryColor, panel: panelBg, panelSoft: panelBg, text: headingColor }} label="Bulge (inches)" value={form.bulge_in} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("bulge_in", v)} error={fieldErrors.bulge_in} />
        ) : null}

        {activeAnnotation === "rocks" ? (
          <>
            <Text style={[styles.label, styles.annotationFieldLabel, { color: secondaryColor }]}>Indented by Rocks</Text>
            <View style={styles.chips}>
              {(["YES", "NO"] as const).map((choice) => (
                <Chip
                  key={`annot-rocks-${choice}`}
                  label={choice}
                  palette={palette}
                  active={form.indented_by_rocks === choice}
                  disabled={!canEdit}
                  onPress={() => {
                    if (!canEdit) return;
                    setVal("indented_by_rocks", choice);
                  }}
                />
              ))}
            </View>
          </>
        ) : null}

        {annotationLayout[activeAnnotation]?.placed ? (
          <>
            <View style={styles.annotationDetailActions}>
              {annotationLayout[activeAnnotation]?.rangeEnd ? (
                <Pressable
                  style={[styles.btnGhost, styles.annotationDetailActionBtn, { borderColor: palette.border, backgroundColor: panelBg }]}
                  onPress={() => removeRangeReference(activeAnnotation)}
                  disabled={!canEdit}
                >
                  <Text style={[styles.btnGhostText, { color: headingColor }]}>Remove Range</Text>
                </Pressable>
              ) : (
                <Pressable
                  style={[styles.btnGhost, styles.annotationDetailActionBtn, { borderColor: palette.border, backgroundColor: panelBg }]}
                  onPress={() => addRangeReference(activeAnnotation)}
                  disabled={!canEdit}
                >
                  <Text style={[styles.btnGhostText, { color: headingColor }]}>Add Range</Text>
                </Pressable>
              )}
              <Pressable
                style={[styles.btnGhost, styles.annotationDetailActionBtn, { borderColor: palette.border, backgroundColor: panelBg }]}
                onPress={() => removePlacement(activeAnnotation)}
                disabled={!canEdit}
              >
                <Text style={[styles.btnGhostText, { color: headingColor }]}>Remove</Text>
              </Pressable>
            </View>
          </>
        ) : null}
      </>
    );
  };

  const placedCount = annotationRows.filter((item) => item.placed).length;
  const drawerWidth = Math.min(360, Math.max(260, Math.round(windowWidth * 0.78)));
  const drawerTranslateX = drawerProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [drawerWidth + 24, 0],
  });
  const activeAnnotationLayout = activeAnnotation ? annotationLayout[activeAnnotation] : null;
  const activePopoverLayout = canvasPopoverAnnotation ? annotationLayout[canvasPopoverAnnotation] : null;
  const activeAnnotationAnchorPosition =
    canvasPopoverAnnotation && activePopoverLayout
      ? markerDrag?.id === canvasPopoverAnnotation && markerDrag.handle === "anchor"
        ? { left: markerDrag.left, top: markerDrag.top }
        : {
            left: activePopoverLayout.x * markerStageBounds.maxLeft,
            top: activePopoverLayout.y * markerStageBounds.maxTop,
          }
      : null;
  const activeCanvasPopupWidth = Math.min(320, Math.max(240, stageSize.width - 24));
  const activeCanvasPopupStyle = useMemo(() => {
    if (!canvasPopoverAnnotation || drawerOpen || !activePopoverLayout?.placed || !activeAnnotationAnchorPosition) return null;
    const preferredLeft = activeAnnotationAnchorPosition.left + MARKER_SIZE + 10;
    const fallbackLeft = activeAnnotationAnchorPosition.left - activeCanvasPopupWidth - 10;
    const usePreferredSide = preferredLeft + activeCanvasPopupWidth <= stageSize.width - 8;
    const left = Math.max(
      8,
      Math.min(
        usePreferredSide ? preferredLeft : fallbackLeft,
        Math.max(8, stageSize.width - activeCanvasPopupWidth - 8)
      )
    );
    const preferredTop = activeAnnotationAnchorPosition.top - 8;
    const top = Math.max(8, Math.min(preferredTop, Math.max(8, stageSize.height - 240)));
    return { left, top, width: activeCanvasPopupWidth, side: usePreferredSide ? "right" : "left" as const };
  }, [
    MARKER_SIZE,
    activeAnnotationAnchorPosition,
    activePopoverLayout?.placed,
    activeCanvasPopupWidth,
    canvasPopoverAnnotation,
    drawerOpen,
    stageSize.height,
    stageSize.width,
  ]);

  return (
    <View style={[styles.annotationCard, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}>
      <Text style={[styles.annotationIntro, { color: palette.text }]}>
        Upload a pavement photo, then place compact markers from the right-side label drawer in the fullscreen editor.
      </Text>
      {imageName ? (
        <Text style={[styles.annotationSubtle, { color: palette.muted }]}>Using latest section photo: {imageName}</Text>
      ) : (
        <Text style={[styles.annotationSubtle, { color: palette.muted }]}>Upload a section photo first to unlock the fullscreen annotation editor.</Text>
      )}

      <View style={styles.annotationToolbar}>
        <Pressable
          style={[styles.btnGhost, styles.annotationToolbarButton, { borderColor: palette.border, backgroundColor: palette.panel }]}
          onPress={onUploadPhoto}
          disabled={!canEdit || busy}
        >
          <Text style={[styles.btnGhostText, { color: palette.text }]}>
            {busy ? "Working..." : imageSource ? "Upload Another Photo" : "Upload Photo"}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.btnGhost, styles.annotationToolbarButton, { borderColor: palette.border, backgroundColor: palette.panel }]}
          onPress={() => {
            setEditorOpen(true);
            if (!activeAnnotation) setActiveAnnotation("crack");
          }}
          disabled={busy}
        >
          <Text style={[styles.btnGhostText, { color: palette.text }]}>Open Full Screen Editor</Text>
        </Pressable>
        <Pressable
          style={[styles.btnGhost, styles.annotationToolbarButton, { borderColor: palette.border, backgroundColor: palette.panel }]}
          onPress={resetPositions}
          disabled={!canEdit || busy}
        >
          <Text style={[styles.btnGhostText, { color: palette.text }]}>Reset Placed Marker Positions</Text>
        </Pressable>
      </View>

      {imageSource ? (
        <Pressable
          style={[styles.annotationPreviewShell, { borderColor: palette.border, backgroundColor: palette.panel }]}
          onPress={() => setEditorOpen(true)}
        >
          <Image
            source={imageSource}
            style={styles.annotationPreviewImage}
            resizeMode="cover"
            onLoad={(event) => {
              const source = event.nativeEvent.source;
              if (source?.width && source?.height) {
                setImageAspectRatio(source.width / source.height);
              }
            }}
          />
          <View style={styles.annotationPreviewOverlay}>
            <Text style={styles.annotationPreviewOverlayText}>
              {placedCount ? `${placedCount} marker${placedCount === 1 ? "" : "s"} placed` : "Open Full Screen Editor"}
            </Text>
          </View>
        </Pressable>
      ) : (
        <View style={[styles.annotationEmptyState, { borderColor: palette.border, backgroundColor: palette.panel }]}>
          <Text style={[styles.annotationEmptyTitle, { color: palette.text }]}>No pavement photo yet</Text>
          <Text style={[styles.annotationSubtle, { color: palette.muted }]}>
            Upload a picture for this section to start dropping markers onto the image.
          </Text>
        </View>
      )}

      <View style={styles.annotationSummaryList}>
        {annotationRows.map((item) => (
          <Pressable
            key={`summary-${item.id}`}
            style={[styles.annotationSummaryRow, { borderColor: palette.border, backgroundColor: palette.panel }]}
            onPress={() => {
              setActiveAnnotation(item.id);
              setEditorOpen(true);
            }}
          >
            <View
              style={[
                styles.annotationSummaryDot,
                { backgroundColor: item.placed ? palette.primary : palette.border },
              ]}
            />
            <View style={{ flex: 1 }}>
              <Text style={[styles.annotationSummaryTitle, { color: palette.text }]}>{item.title}</Text>
              <Text style={[styles.annotationSummaryText, { color: palette.muted }]}>{item.longSummary}</Text>
            </View>
            <Text style={[styles.annotationSummaryAction, { color: palette.primary }]}>
              {item.placed ? "Placed" : "Place"}
            </Text>
          </Pressable>
        ))}
      </View>

      <Modal visible={editorOpen} animationType="slide" onRequestClose={() => setEditorOpen(false)}>
        <View style={[styles.annotationEditorScreen, { backgroundColor: "#091321" }]}>
          <View style={styles.annotationEditorTopBar}>
            <Text style={styles.annotationEditorTitle}>Pavement Photo Editor</Text>
            <View style={styles.annotationEditorTopBarSpacer} />
            <View style={styles.annotationEditorHeaderActions}>
              <Pressable
                style={[
                  styles.annotationEditorCloseBtn,
                  styles.annotationEditorHeaderBtn,
                  drawerOpen ? styles.annotationEditorDrawerToggleBtnActive : null,
                ]}
                onPress={() => setDrawerOpen((current) => !current)}
              >
                <Text style={styles.annotationEditorCloseText}>{drawerOpen ? "Hide Labels" : "Show Labels"}</Text>
              </Pressable>
              <Pressable
                style={[styles.annotationEditorCloseBtn, styles.annotationEditorHeaderBtn]}
                onPress={() => setEditorOpen(false)}
              >
                <Text style={styles.annotationEditorCloseText}>Done</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.annotationEditorBody}>
            <View style={styles.annotationEditorCanvasArea} onLayout={(event) => setStageAreaSize(event.nativeEvent.layout)}>
              {imageSource ? (
                <View
                  ref={stageRef}
                  collapsable={false}
                  onLayout={refreshStageBounds}
                  style={[
                    styles.annotationEditorStage,
                    {
                      width: stageSize.width || 0,
                      height: stageSize.height || 0,
                    },
                  ]}
                >
                  <Image source={imageSource} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
                  {annotationRows
                    .filter((item) => item.placed)
                    .map((item) => {
                      const layout = annotationLayout[item.id];
                      const anchorLeft =
                        markerDrag?.id === item.id && markerDrag.handle === "anchor"
                          ? markerDrag.left
                          : layout.x * markerStageBounds.maxLeft;
                      const anchorTop =
                        markerDrag?.id === item.id && markerDrag.handle === "anchor"
                          ? markerDrag.top
                          : layout.y * markerStageBounds.maxTop;
                      const rangeEndPosition =
                        markerDrag?.id === item.id && markerDrag.handle === "rangeEnd"
                          ? { left: markerDrag.left, top: markerDrag.top }
                          : getLayoutPosition(layout.rangeEnd);
                      const lineStartX = anchorLeft + MARKER_SIZE / 2;
                      const lineStartY = anchorTop + MARKER_SIZE / 2;
                      const lineEndX = rangeEndPosition ? rangeEndPosition.left + MARKER_SIZE / 2 : null;
                      const lineEndY = rangeEndPosition ? rangeEndPosition.top + MARKER_SIZE / 2 : null;
                      const lineDeltaX = lineEndX != null ? lineEndX - lineStartX : 0;
                      const lineDeltaY = lineEndY != null ? lineEndY - lineStartY : 0;
                      const lineLength = Math.sqrt(lineDeltaX * lineDeltaX + lineDeltaY * lineDeltaY);
                      const lineAngle = Math.atan2(lineDeltaY, lineDeltaX);
                      const lineCenterX = rangeEndPosition && lineEndX != null ? (lineStartX + lineEndX) / 2 : 0;
                      const lineCenterY = rangeEndPosition && lineEndY != null ? (lineStartY + lineEndY) / 2 : 0;
                      return (
                        <View key={`marker-${item.id}`}>
                          {rangeEndPosition && lineEndX != null && lineEndY != null ? (
                            <View
                              pointerEvents="none"
                              style={[
                                styles.annotationRangeLine,
                                {
                                  left: lineCenterX - lineLength / 2,
                                  top: lineCenterY - 1,
                                  width: lineLength,
                                  transform: [{ rotateZ: `${lineAngle}rad` }],
                                  backgroundColor: activeAnnotation === item.id ? "#f8fbff" : "rgba(248,251,255,0.86)",
                                },
                              ]}
                            >
                              <View
                                style={[
                                  styles.annotationRangeCap,
                                  { backgroundColor: activeAnnotation === item.id ? "#f8fbff" : "rgba(248,251,255,0.86)" },
                                ]}
                              />
                              <View
                                style={[
                                  styles.annotationRangeCap,
                                  styles.annotationRangeCapEnd,
                                  { backgroundColor: activeAnnotation === item.id ? "#f8fbff" : "rgba(248,251,255,0.86)" },
                                ]}
                              />
                            </View>
                          ) : null}
                          <PavementCanvasMarker
                            id={item.id}
                            glyph={glyphForAnnotation(item.id)}
                            left={anchorLeft}
                            top={anchorTop}
                          active={activeAnnotation === item.id}
                          editable={canEdit}
                          palette={palette}
                          onSelect={selectAnnotationFromCanvas}
                          onDragStart={beginMarkerDrag}
                          onDragMove={moveMarkerDrag}
                          onDragEnd={endMarkerDrag}
                          />
                          {rangeEndPosition ? (
                            <PavementCanvasMarker
                              id={item.id}
                              glyph=""
                              left={rangeEndPosition.left}
                              top={rangeEndPosition.top}
                              active={activeAnnotation === item.id}
                              editable={canEdit}
                              variant="rangeEnd"
                              palette={palette}
                              onSelect={selectAnnotationFromCanvas}
                              onDragStart={beginMarkerDrag}
                              onDragMove={moveMarkerDrag}
                              onDragEnd={endMarkerDrag}
                            />
                          ) : null}
                        </View>
                      );
                    })}
                  {activeCanvasPopupStyle ? (
                    <View style={styles.annotationCanvasPopoverLayer}>
                      <Pressable style={StyleSheet.absoluteFillObject} onPress={() => setCanvasPopoverAnnotation(null)} />
                      <Pressable
                        style={[
                          styles.annotationCanvasPopover,
                          {
                            left: activeCanvasPopupStyle.left,
                            top: activeCanvasPopupStyle.top,
                            width: activeCanvasPopupStyle.width,
                            borderColor: palette.border,
                            backgroundColor: "rgba(9,19,33,0.94)",
                          },
                        ]}
                      >
                        <View
                          style={[
                            styles.annotationCanvasPopoverArrow,
                            activeCanvasPopupStyle.side === "left" ? styles.annotationCanvasPopoverArrowLeft : styles.annotationCanvasPopoverArrowRight,
                            activeCanvasPopupStyle.side === "left"
                              ? { borderLeftColor: "rgba(9,19,33,0.94)" }
                              : { borderRightColor: "rgba(9,19,33,0.94)" },
                          ]}
                        />
                        <View style={styles.annotationCanvasPopoverHeader}>
                          <Text style={styles.annotationCanvasPopoverHeaderTitle}>
                            {canvasPopoverAnnotation ? PAVEMENT_ANNOTATION_TITLES[canvasPopoverAnnotation] : ""}
                          </Text>
                          <Pressable style={styles.annotationCanvasPopoverCloseBtn} onPress={() => setCanvasPopoverAnnotation(null)}>
                            <Text style={styles.annotationCanvasPopoverCloseText}>X</Text>
                          </Pressable>
                        </View>
                        <ScrollView
                          style={styles.annotationCanvasPopoverScroll}
                          contentContainerStyle={styles.annotationCanvasPopoverScrollContent}
                          keyboardShouldPersistTaps="handled"
                        >
                          {renderAnnotationFields("popover")}
                        </ScrollView>
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              ) : (
                <View style={styles.annotationEditorEmpty}>
                  <Text style={styles.annotationEditorEmptyTitle}>Upload a section photo to annotate</Text>
                  <Text style={styles.annotationEditorEmptyText}>Once a photo is attached, this editor stays clean and only shows compact markers that you place.</Text>
                  <Pressable style={[styles.btnPrimary, { backgroundColor: palette.primary, minWidth: 180 }]} onPress={onUploadPhoto} disabled={!canEdit || busy}>
                    <Text style={styles.btnPrimaryText}>{busy ? "Working..." : "Upload Photo"}</Text>
                  </Pressable>
                </View>
              )}
            </View>

            <Animated.View
              pointerEvents={drawerOpen ? "auto" : "none"}
              style={[
                styles.annotationEditorDrawer,
                {
                  transform: [{ translateX: drawerTranslateX }],
                  width: drawerWidth,
                  borderColor: palette.border,
                  backgroundColor: palette.panelSoft,
                },
              ]}
            >
              <Text style={[styles.annotationEditorDrawerTitle, { color: palette.text }]}>Labels</Text>
              <Text style={[styles.annotationEditorDrawerHelp, { color: palette.muted }]}>
                Swipe a label left onto the photo. Tap a label or marker any time to reopen its detail form.
              </Text>
              <ScrollView
                style={styles.annotationEditorDrawerScroll}
                contentContainerStyle={styles.annotationEditorDrawerScrollContent}
                scrollEnabled={!drawerDrag}
                keyboardShouldPersistTaps="handled"
              >
                {annotationRows.map((item) => (
                  <PavementDrawerToken
                    key={`drawer-${item.id}`}
                    id={item.id}
                    title={item.title}
                    summary={item.longSummary}
                    placed={item.placed}
                    active={activeAnnotation === item.id}
                    editable={canEdit}
                    palette={palette}
                    onSelect={selectAnnotationFromDrawer}
                    onDragStart={beginDrawerDrag}
                    onDragMove={moveDrawerDrag}
                    onDragEnd={endDrawerDrag}
                  />
                ))}

                <View style={[styles.annotationEditorDetailPanel, { borderColor: palette.border, backgroundColor: palette.panel }]}>
                  {renderAnnotationFields()}
                </View>
              </ScrollView>
            </Animated.View>
          </View>

          {drawerDrag ? (
            <View
              pointerEvents="none"
              style={[
                styles.annotationDragGhost,
                {
                  left: drawerDrag.x - 60,
                  top: drawerDrag.y - 22,
                },
              ]}
            >
              <Text style={styles.annotationDragGhostText}>{PAVEMENT_ANNOTATION_TITLES[drawerDrag.id]}</Text>
            </View>
          ) : null}
        </View>
      </Modal>
    </View>
  );
}

export default function SubmissionDetailScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = useMemo(() => {
    const raw = params.id;
    if (Array.isArray(raw)) return String(raw[0] ?? "");
    return String(raw ?? "");
  }, [params.id]);
  const isLocalId = useMemo(() => isLocalDraftId(String(id ?? "")), [id]);
  const navigation = useNavigation<any>();
  const pathname = usePathname();
  const { palette: basePalette, density, componentScale, textScale, isAccessibilityLayout } = useUiSettings();
  const { width: windowWidth } = useWindowDimensions();
  const palette = useMemo(() => {
    if (!isDarkHexColor(basePalette?.bg)) return basePalette;
    return {
      ...basePalette,
      panel: "#132746",
      panelSoft: "#1b355d",
      border: "#3b5a88",
      text: "#f4f8ff",
      muted: "#c0d1f0",
    };
  }, [basePalette]);
  const isDarkTheme = useMemo(() => isDarkHexColor(palette.bg), [palette.bg]);
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
  const [localAttachmentUris, setLocalAttachmentUris] = useState<Record<number, string>>({});
  const [failedPreviewIds, setFailedPreviewIds] = useState<Record<number, boolean>>({});
  const [fullscreenPhoto, setFullscreenPhoto] = useState<{ uri: string; name: string; isLocal: boolean } | null>(null);
  const [figureCitationRequest, setFigureCitationRequest] = useState<FigureCitationRequest | null>(null);
  const [selectedSectionKey, setSelectedSectionKey] = useState<string | null>(null);
  const [reviewComment, setReviewComment] = useState("");
  const [enrichmentHint, setEnrichmentHint] = useState("");
  const [showLocationCoordinates, setShowLocationCoordinates] = useState(false);
  const [showNorthingEasting, setShowNorthingEasting] = useState(false);
  const [northingInput, setNorthingInput] = useState("");
  const [eastingInput, setEastingInput] = useState("");
  const [statePlaneInputError, setStatePlaneInputError] = useState("");
  const [districtPickerOpen, setDistrictPickerOpen] = useState(false);
  const [countyPickerOpen, setCountyPickerOpen] = useState(false);
  const [routePickerOpen, setRoutePickerOpen] = useState(false);
  const [lanesClosedPickerOpen, setLanesClosedPickerOpen] = useState(false);
  const [immediateActionsPickerOpen, setImmediateActionsPickerOpen] = useState(false);
  const [followUpActionsPickerOpen, setFollowUpActionsPickerOpen] = useState(false);
  const [datePickerKey, setDatePickerKey] = useState<"report_date" | "date_incident_reported" | null>(null);
  const [calendarYear, setCalendarYear] = useState(() => new Date().getFullYear());
  const [calendarMonth, setCalendarMonth] = useState(() => new Date().getMonth());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notifyMessage, setNotifyMessage] = useState("");
  const [openSections, setOpenSections] = useState({
    header: false,
    location: false,
    actions: false,
    engineerMemo: false,
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
  const [riDetailsOpen, setRiDetailsOpen] = useState(false);
  const [activeMaterialSection, setActiveMaterialSection] = useState<MaterialSectionKey>("slope");
  const [activeStep, setActiveStep] = useState(0);
  const apiBaseUrl = useMemo(() => getApiBaseUrl(), []);
  const isIOS = Platform.OS === "ios";
  const compact = density === "compact";
  const fullscreenProgress = useRef(new Animated.Value(0)).current;
  const cacheHydratedRef = useRef(false);
  const suppressCacheWriteRef = useRef(false);
  const serverSnapshotRef = useRef<string>("");
  const refreshGeometryOnFocusRef = useRef(false);

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
  const statePlaneZone = useMemo(() => getCaliforniaStatePlaneZone(form.county), [form.county]);
  const statePlaneCoordinates = useMemo(() => {
    if (!statePlaneZone) return null;
    const latitude = normalizeCoordinateValue(form.latitude);
    const longitude = normalizeCoordinateValue(form.longitude);
    if (latitude == null || longitude == null) {
      return {
        countyCode: "",
        zone: statePlaneZone,
        northing: Number.NaN,
        easting: Number.NaN,
        units: "US survey ft" as const,
      };
    }
    return convertLatLonToCaliforniaStatePlaneFeet({ latitude, longitude, county: form.county });
  }, [form.county, form.latitude, form.longitude, statePlaneZone]);

  useEffect(() => {
    if (statePlaneCoordinates) {
      setNorthingInput(formatCaliforniaStatePlaneFeet(statePlaneCoordinates.northing));
      setEastingInput(formatCaliforniaStatePlaneFeet(statePlaneCoordinates.easting));
    } else {
      setNorthingInput("");
      setEastingInput("");
    }
    setStatePlaneInputError("");
  }, [statePlaneCoordinates?.northing, statePlaneCoordinates?.easting, statePlaneCoordinates?.zone]);

  const toggleAssessmentSection = useCallback((key: string) => {
    if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
      UIManager.setLayoutAnimationEnabledExperimental(true);
    }
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setSelectedSectionKey((prev) => (prev === key ? null : key));
  }, []);

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

  const incidentTypesFromFormState = useCallback((state: FormState): string[] => {
    return Object.entries(INCIDENT_TYPE_CODE_BY_FORM_KEY)
      .filter(([k]) => (state as any)[k] === "YES")
      .map(([, code]) => code);
  }, []);

  const clearDraftLocalCache = useCallback(async () => {
    if (!id) return;
    if (isLocalDraftId(id)) {
      await deleteLocalDraft(id);
      return;
    }
    await removeDraftCache(draftCacheKey(id));
  }, [id]);

  const hydrateAttachmentUrls = useCallback(async (authToken: string, files: { id: number }[]) => {
    const next: Record<number, string> = {};
    await Promise.all(files.map(async (p) => {
      try {
        const resp = await apiFetch<{ download_url: string }>(`/attachments/${p.id}/download-url`, { token: authToken });
        next[p.id] = resp.download_url;
      } catch {
        // fallback to content proxy if download-url fails (e.g. offline or permission error)
        next[p.id] = `${apiBaseUrl}/attachments/${p.id}/content?access_token=${encodeURIComponent(authToken)}`;
      }
    }));
    setPhotoUrls(next);
  }, [apiBaseUrl]);

  const hydrateLocalAttachmentUris = useCallback(async (submissionId: string, files: { id: number }[]) => {
    if (!submissionId || isLocalDraftId(submissionId)) {
      setLocalAttachmentUris({});
      return;
    }
    const cached = await getAttachmentUriCache(attachmentUriCacheKey(submissionId));
    const allowed = new Set(files.map((file) => Number(file.id)).filter((value) => Number.isFinite(value) && value > 0));
    const next: Record<number, string> = {};
    for (const [attachmentIdRaw, uri] of Object.entries(cached)) {
      const attachmentId = Number(attachmentIdRaw);
      if (!allowed.has(attachmentId) || !isLocalAttachmentUri(uri)) continue;
      next[attachmentId] = uri;
    }
    setLocalAttachmentUris(next);
    if (Object.keys(next).length !== Object.keys(cached).length) {
      await setAttachmentUriCache(attachmentUriCacheKey(submissionId), next);
    }
  }, []);

  const registerLocalAttachmentUri = useCallback((attachmentId: number | null | undefined, uri: string) => {
    if (!attachmentId || !uri) return;
    setLocalAttachmentUris((prev) => {
      const next = { ...prev, [attachmentId]: uri };
      if (id && !isLocalDraftId(id)) {
        setAttachmentUriCache(attachmentUriCacheKey(id), next).catch(() => {});
      }
      return next;
    });
  }, [id]);

  const getAttachmentUri = useCallback((attachmentId: number) => {
    const localUri = localAttachmentUris[attachmentId];
    if (isLocalAttachmentUri(localUri)) return localUri;
    const remoteUri = photoUrls[attachmentId];
    if (remoteUri) return remoteUri;
    const queryToken = encodeURIComponent(token || "");
    return `${apiBaseUrl}/attachments/${attachmentId}/content?access_token=${queryToken}`;
  }, [apiBaseUrl, localAttachmentUris, photoUrls, token]);

  const load = useCallback(async () => {
    if (!token || !id) return;
    setLoading(true);
    try {
      let lookRes: Lookups = EMPTY_LOOKUPS;
      try {
        lookRes = await (getGisaLookups(token) as Promise<Lookups>);
        await writeLookupsCache(lookRes);
      } catch {
        const cached = await readLookupsCache<Lookups>();
        lookRes = cached ?? EMPTY_LOOKUPS;
      }
      setLookups(lookRes);

      let meRes: UserInfo = { id: 0, roles: [] };
      try {
        meRes = await apiFetch<UserInfo>("/auth/me", { token });
      } catch {
        // Keep local edit mode available even if /auth/me is temporarily unreachable.
      }
      setMe(meRes);

      if (isLocalId) {
        const local = await getLocalDraft(id);
        if (!local) {
          const knownLocalDrafts = await listLocalDrafts().catch(() => []);
          const ids = knownLocalDrafts.map((x) => x.localId).join(", ");
          Alert.alert(
            "Draft unavailable",
            `Local draft was not found on this device.\n\nid=${id}\nindex=${ids || "(none)"}`
          );
          router.replace("/(tabs)/drafts");
          return;
        }

        const loadedState: DraftEditorState = {
          form: enforceFormBusinessRules({ ...EMPTY_FORM, ...(local.editor?.form || {}) }),
          districtContacts: normalizeCachedContacts(local.editor?.districtContacts),
          incidentTypes: Array.isArray(local.editor?.incidentTypes) ? local.editor.incidentTypes : [],
          immediateActions: Array.isArray(local.editor?.immediateActions) ? local.editor.immediateActions : [],
          followUpActions: Array.isArray(local.editor?.followUpActions) ? local.editor.followUpActions : [],
        };

        suppressCacheWriteRef.current = true;
        applyEditorState(loadedState);
        serverSnapshotRef.current = JSON.stringify(loadedState);
        setData({
          submission: {
            id: -1,
            created_by_user_id: meRes.id,
            title: null,
            status: "DRAFT",
            created_at: local.createdAt,
            updated_at: local.updatedAt,
            submitted_at: null,
            reviewed_at: null,
            review_comment: null,
            can_edit: true,
            can_manage_permissions: false,
          },
          gisa: null,
          incident_types: loadedState.incidentTypes,
          actions: { immediate: loadedState.immediateActions, follow_up: loadedState.followUpActions },
          photos: [],
          attachments: [],
          workflow_events: [],
        });
        setTimeout(() => {
          suppressCacheWriteRef.current = false;
          cacheHydratedRef.current = true;
        }, 0);
        setFieldErrors({});
        setReviewComment("");
        setPhotoUrls({});
        return;
      }

      const subRes = (await getSubmission(token, id)) as SubmissionDetail;
      setData(subRes);
      const g = subRes.gisa || {};
      const loadedDistrictContacts = parseDistrictContacts(g.district_contact ?? "");
      const countyCode = countyCodeFromNameOrCode(g.county ?? "");
      const districtValue = g.district ? String(g.district).padStart(2, "0") : (districtForCounty(countyCode) ?? "");
      const loadedIncidentTypeCodes = new Set((subRes.incident_types ?? []).map((x) => String(x)));
      const incidentYn = (key: string, value: any) =>
        value === true || value === 1 || value === "1" || loadedIncidentTypeCodes.has(INCIDENT_TYPE_CODE_BY_FORM_KEY[key])
          ? "YES"
          : "NO";
      const loadedForm: FormState = {
        ...EMPTY_FORM,
        report_date: g.report_date ?? ymdFromTimestamp(subRes.submission.created_at), district: districtValue, county: countyCode ?? "", route: normalizeRouteInput(g.route), post_mile: normalizePostMileInput(g.post_mile), ea: g.ea ?? "", project_id: g.project_id ?? "", date_incident_reported: g.date_incident_reported ?? "", district_contact: g.district_contact ?? "",
        latitude: formatCoordinate(g.latitude), longitude: formatCoordinate(g.longitude),
        distribution_code: g.distribution_code ?? "", highway_status_cause: g.highway_status_cause ?? "", highway_status_code: g.highway_status_code ?? "", lanes_closed_count: g.lanes_closed_count != null ? String(g.lanes_closed_count) : "", open_highway_traffic_lanes_count: g.open_highway_traffic_lanes_count != null ? String(g.open_highway_traffic_lanes_count) : "",
        pavement_ground_cracks: boolToTri(g.pavement_ground_cracks), crack_length_ft: g.crack_length_ft != null ? String(g.crack_length_ft) : "", crack_horizontal_in: g.crack_horizontal_in != null ? String(g.crack_horizontal_in) : "", crack_vertical_in: g.crack_vertical_in != null ? String(g.crack_vertical_in) : "", crack_depth_in: g.crack_depth_in != null ? String(g.crack_depth_in) : "", settlement_in: g.settlement_in != null ? String(g.settlement_in) : "", bulge_in: g.bulge_in != null ? String(g.bulge_in) : "", indented_by_rocks: boolToTri(g.indented_by_rocks),
        failure_rock_fall: incidentYn("failure_rock_fall", g.failure_rock_fall), failure_topple: incidentYn("failure_topple", g.failure_topple), failure_slide: incidentYn("failure_slide", g.failure_slide), failure_spread: incidentYn("failure_spread", g.failure_spread), failure_flow: incidentYn("failure_flow", g.failure_flow), failure_compound: incidentYn("failure_compound", g.failure_compound), failure_erosion: incidentYn("failure_erosion", g.failure_erosion), failure_surficial_failure: incidentYn("failure_surficial_failure", g.failure_surficial_failure), failure_scoured_toe: incidentYn("failure_scoured_toe", g.failure_scoured_toe), failure_washout: incidentYn("failure_washout", g.failure_washout),
        incident_type_description: g.incident_type_description ?? "",
        distribution_advancing: boolToYn(g.distribution_advancing), distribution_retrogressive: boolToYn(g.distribution_retrogressive), distribution_enlarging: boolToYn(g.distribution_enlarging), distribution_widening: boolToYn(g.distribution_widening), distribution_moving: boolToYn(g.distribution_moving), distribution_confined: boolToYn(g.distribution_confined),
        material_rock: boolToYn(g.material_rock), material_soil: boolToYn(g.material_soil), material_bedding: boolToYn(g.material_bedding), material_joints: boolToYn(g.material_joints), material_fractures: boolToYn(g.material_fractures),
        material_pavement_type: g.material_pavement_type === "CONCRETE" || g.material_pavement_type === "ASPHALT" ? g.material_pavement_type : "",
        est_soil_pct: g.est_soil_pct != null ? String(g.est_soil_pct) : "", est_rock_pct: g.est_rock_pct != null ? String(g.est_rock_pct) : "", est_clay_pct: g.est_clay_pct != null ? String(g.est_clay_pct) : "", est_silt_pct: g.est_silt_pct != null ? String(g.est_silt_pct) : "", est_sand_pct: g.est_sand_pct != null ? String(g.est_sand_pct) : "", est_gravel_pct: g.est_gravel_pct != null ? String(g.est_gravel_pct) : "", est_boulder_pct: g.est_boulder_pct != null ? String(g.est_boulder_pct) : "",
        est_debris_clay_silt_pct: g.est_debris_clay_silt_pct != null ? String(g.est_debris_clay_silt_pct) : "", est_debris_sand_pct: g.est_debris_sand_pct != null ? String(g.est_debris_sand_pct) : "", est_debris_gravel_pct: g.est_debris_gravel_pct != null ? String(g.est_debris_gravel_pct) : "", est_debris_boulder_pct: g.est_debris_boulder_pct != null ? String(g.est_debris_boulder_pct) : "",
        water_dry: boolToYn(g.water_dry), water_moist: boolToYn(g.water_moist), water_wet: boolToYn(g.water_wet), water_flowing: boolToYn(g.water_flowing), water_seep: boolToYn(g.water_seep), water_spring: boolToYn(g.water_spring),
        vegetation_trees: g.vegetation_trees ?? "", vegetation_bushes_shrubs: g.vegetation_bushes_shrubs ?? "", vegetation_groundcover: g.vegetation_groundcover ?? "",
        drainage_clogged_inlet: boolToYn(g.drainage_clogged_inlet), drainage_compromised_drains: boolToYn(g.drainage_compromised_drains), drainage_surface_runoff: boolToYn(g.drainage_surface_runoff), drainage_torrent_surge_flood: boolToYn(g.drainage_torrent_surge_flood),
        impact_impacted_adj_utilities: boolToYn(g.impact_impacted_adj_utilities), impact_maybe_adj_utilities: boolToYn(g.impact_maybe_adj_utilities), impact_adj_utilities: g.impact_adj_utilities ?? "", impact_impacted_adj_properties: boolToYn(g.impact_impacted_adj_properties), impact_maybe_adj_properties: boolToYn(g.impact_maybe_adj_properties), impact_adj_properties: g.impact_adj_properties ?? "", impact_impacted_adj_structure: boolToYn(g.impact_impacted_adj_structure), impact_maybe_adj_structure: boolToYn(g.impact_maybe_adj_structure), impact_adj_structure: g.impact_adj_structure ?? "",
        measure_slope_height_ft: g.measure_slope_height_ft != null ? String(g.measure_slope_height_ft) : "", measure_original_slope_deg: g.measure_original_slope_deg != null ? String(g.measure_original_slope_deg) : "", measure_landslide_width_ft: g.measure_landslide_width_ft != null ? String(g.measure_landslide_width_ft) : "", measure_landslide_length_ft: g.measure_landslide_length_ft != null ? String(g.measure_landslide_length_ft) : "", measure_main_scarp_height_ft: g.measure_main_scarp_height_ft != null ? String(g.measure_main_scarp_height_ft) : "", measure_landslide_slope_deg: g.measure_landslide_slope_deg != null ? String(g.measure_landslide_slope_deg) : "", measure_roadway_length_ft: g.measure_roadway_length_ft != null ? String(g.measure_roadway_length_ft) : "", measure_roadway_width_ft: g.measure_roadway_width_ft != null ? String(g.measure_roadway_width_ft) : "",
        record_of_event_notes: g.record_of_event_notes ?? "", maintenance_history_notes: g.maintenance_history_notes ?? "", geotechnical_assessment_notes: g.geotechnical_assessment_notes ?? "", recommendations_notes: g.recommendations_notes ?? "", sketchpad_notes: g.sketchpad_notes ?? "",
        observations_notes: g.observations_notes ?? "", geometry_json: g.geometry_json ? JSON.stringify(g.geometry_json, null, 2) : "", pavement_ground_annotation_layout: g.pavement_ground_annotation_layout_json ? JSON.stringify(g.pavement_ground_annotation_layout_json) : "",
      };
      const normalizedLoadedForm = enforceFormBusinessRules(loadedForm);
      const loadedState: DraftEditorState = {
        form: normalizedLoadedForm,
        districtContacts: loadedDistrictContacts,
        incidentTypes: Array.from(new Set([...(subRes.incident_types ?? []).map((x) => String(x)), ...incidentTypesFromFormState(normalizedLoadedForm)])),
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
      const loadedAttachments = subRes.attachments ?? subRes.photos ?? [];
      await hydrateAttachmentUrls(token, loadedAttachments);
      await hydrateLocalAttachmentUris(String(id), loadedAttachments);
    } catch (err: any) {
      if (isSessionExpiredError(err)) return;
      Alert.alert("Load failed", err?.message ?? "Unable to load submission");
    } finally {
      setLoading(false);
    }
  }, [token, id, isLocalId, hydrateAttachmentUrls, hydrateLocalAttachmentUris, applyEditorState, incidentTypesFromFormState]);

  useEffect(() => { load(); }, [load]);

  useFocusEffect(
    useCallback(() => {
      if (!refreshGeometryOnFocusRef.current) return;
      refreshGeometryOnFocusRef.current = false;
      if (!token || !id || isLocalId) return;

      let cancelled = false;
      (async () => {
        try {
          const latest = await getSubmission(token, id);
          if (cancelled) return;
          const geomText = latest.gisa?.geometry_json
            ? JSON.stringify(latest.gisa.geometry_json, null, 2)
            : "";
          setData((prev) => (prev ? { ...prev, gisa: latest.gisa } : prev));
          setForm((prev) => ({ ...prev, geometry_json: geomText }));
          setFieldErrors((prev) => {
            if (!prev.geometry_json) return prev;
            const next = { ...prev };
            delete next.geometry_json;
            return next;
          });
        } catch {
          // Keep current form state if refresh fails.
        }
      })();

      return () => {
        cancelled = true;
      };
    }, [token, id, isLocalId])
  );

  useEffect(() => {
    if (!id || !data || loading) return;
    if (!cacheHydratedRef.current || suppressCacheWriteRef.current) return;
    const isDraftEditable =
      (data.submission.status === "DRAFT" || data.submission.status === "REJECTED") &&
      !!data.submission.can_edit;
    if (!isDraftEditable) return;

    const editorState = buildEditorState();
    const snapshot = JSON.stringify(editorState);
    if (isLocalId) {
      const timer = setTimeout(() => {
        saveLocalDraft(id, {
          editor: editorState as any,
          serverUpdatedAt: null,
          syncState: "LOCAL_ONLY",
          lastError: null,
        }).catch(() => {});
      }, 250);
      return () => clearTimeout(timer);
    }
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
    isLocalId,
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
  const applyStatePlaneInputs = useCallback(() => {
    const northing = parseStatePlaneFeetValue(northingInput);
    const easting = parseStatePlaneFeetValue(eastingInput);

    if (northing == null || easting == null) {
      setStatePlaneInputError("Northing and easting must be numeric.");
      return;
    }

    const converted = convertCaliforniaStatePlaneFeetToLatLon({
      northing,
      easting,
      county: form.county,
    });

    if (!converted) {
      setStatePlaneInputError("Unable to convert northing/easting for the selected county.");
      return;
    }

    setVal("latitude", formatCoordinate(converted.latitude));
    setVal("longitude", formatCoordinate(converted.longitude));
    setNorthingInput(formatCaliforniaStatePlaneFeet(northing));
    setEastingInput(formatCaliforniaStatePlaneFeet(easting));
    setStatePlaneInputError("");
  }, [eastingInput, form.county, northingInput]);
  const toggleSection = (key: keyof typeof openSections) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };
  const togglePaperBlock = (key: keyof typeof openPaperBlocks) => {
    setOpenPaperBlocks((prev) => ({ ...prev, [key]: !prev[key] }));
  };
  const FORM_STEPS = ["Header", "GISA Body", "Assessment", "Actions", "Gallery"] as const;
  const STEP_LABELS: string[] = isAccessibilityLayout
    ? ["Hdr", "Body", "Assess", "Acts", "Gallery"]
    : [...FORM_STEPS];
  const goNextStep = () => setActiveStep((prev) => Math.min(prev + 1, FORM_STEPS.length - 1));
  const goPrevStep = () => setActiveStep((prev) => Math.max(prev - 1, 0));
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
      const route = normalizeRouteInput(geo.route);
      const routeAllowed = countyCode ? routesForCounty(countyCode) : [];
      const normalizedRoute = route && (routeAllowed.length === 0 || routeAllowed.includes(route)) ? route : "";

      if (countyCode) setVal("county", countyCode);
      if (district) setVal("district", district);
      if (normalizedRoute) setVal("route", normalizedRoute);
      if (geo.post_mile?.trim()) setVal("post_mile", normalizePostMileInput(geo.post_mile));

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

  const validateDraftMinimumFields = useCallback((): boolean => {
    const nextErrors: FieldErrorMap = {};
    const required: { key: keyof FormState; label: string; section: keyof typeof openSections }[] = [
      { key: "district", label: "District", section: "header" },
      { key: "county", label: "County", section: "header" },
      { key: "route", label: "Route", section: "header" },
      { key: "post_mile", label: "Post Mile", section: "header" },
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
  }, [form]);

  const validateSubmitRequiredFields = useCallback((): boolean => {
    if (!validateDraftMinimumFields()) return false;
    if (!String(form.geotechnical_assessment_notes ?? "").trim()) {
      setFieldErrors((prev) => ({ ...prev, geotechnical_assessment_notes: "Geotechnical Assessment is required." }));
      setOpenSections((prev) => ({ ...prev, engineerMemo: true }));
      setActiveStep(2);
      Alert.alert("Cannot Submit Yet", "Geotechnical Assessment is required before submitting.");
      return false;
    }
    return true;
  }, [form.geotechnical_assessment_notes, validateDraftMinimumFields]);

  const validateSoilPercentForSubmit = useCallback((): boolean => {
    if (form.material_soil !== "YES") return true;
    const clayRaw = String(form.est_clay_pct ?? "").trim();
    const siltRaw = String(form.est_silt_pct ?? "").trim();
    const clayValue = clayRaw ? Number(clayRaw) : 0;
    const siltValue = siltRaw ? Number(siltRaw) : 0;
    if (Number.isNaN(clayValue) || Number.isNaN(siltValue)) {
      setActiveStep(1);
      setActiveMaterialSection("slope");
      setOpenPaperBlocks((prev) => ({ ...prev, material: true }));
      Alert.alert("Cannot Submit Yet", "Clay/Silt percentage must be numeric.");
      return false;
    }
    const fields: [keyof FormState, string][] = [
      ["est_sand_pct", "Sand"],
      ["est_gravel_pct", "Gravel"],
      ["est_boulder_pct", "Boulder"],
    ];
    let total = clayValue + siltValue;
    for (const [key, label] of fields) {
      const raw = String(form[key] ?? "").trim();
      const value = raw ? Number(raw) : 0;
      if (Number.isNaN(value)) {
        setActiveStep(1);
        setActiveMaterialSection("slope");
        setOpenPaperBlocks((prev) => ({ ...prev, material: true }));
        Alert.alert("Cannot Submit Yet", `${label} percentage must be numeric.`);
        return false;
      }
      total += value;
    }
    const delta = total - 100;
    if (total === 100) return true;
    const dir = delta > 0 ? "over" : "under";
    setActiveStep(1);
    setActiveMaterialSection("slope");
    setOpenPaperBlocks((prev) => ({ ...prev, material: true }));
    Alert.alert(
      "Cannot Submit Yet",
      `Material Soil percentages must total 100%. Current total is ${total.toFixed(2)}% (${dir} by ${Math.abs(delta).toFixed(2)}%).`
    );
    return false;
  }, [form]);

  const validateDebrisPercentForSubmit = useCallback((): boolean => {
    const fields: [keyof FormState, string][] = [
      ["est_debris_clay_silt_pct", "Debris Clay/Silt"],
      ["est_debris_sand_pct", "Debris Sand"],
      ["est_debris_gravel_pct", "Debris Gravel/Cobbles"],
      ["est_debris_boulder_pct", "Debris Boulder"],
    ];
    const hasDebrisValue = fields.some(([key]) => String(form[key] ?? "").trim());
    if (!hasDebrisValue) return true;
    let total = 0;
    for (const [key, label] of fields) {
      const raw = String(form[key] ?? "").trim();
      const value = raw ? Number(raw) : 0;
      if (Number.isNaN(value)) {
        setActiveStep(1);
        setActiveMaterialSection("debris");
        setOpenPaperBlocks((prev) => ({ ...prev, material: true }));
        Alert.alert("Cannot Submit Yet", `${label} percentage must be numeric.`);
        return false;
      }
      total += value;
    }
    const delta = total - 100;
    if (total === 100) return true;
    const dir = delta > 0 ? "over" : "under";
    setActiveStep(1);
    setActiveMaterialSection("debris");
    setOpenPaperBlocks((prev) => ({ ...prev, material: true }));
    Alert.alert(
      "Cannot Submit Yet",
      `Landslide Debris percentages must total 100%. Current total is ${total.toFixed(2)}% (${dir} by ${Math.abs(delta).toFixed(2)}%).`
    );
    return false;
  }, [form]);

  const validateActionGroups = useCallback((): { ok: boolean; message?: string } => {
    const immediateAllowed = new Set((lookups?.actions?.immediate ?? []).map((x: any) => String(x.code)));
    const followUpAllowed = new Set((lookups?.actions?.follow_up ?? []).map((x: any) => String(x.code)));

    const invalidImmediate = immediateActions.filter((code) => !immediateAllowed.has(String(code)));
    const invalidFollowUp = followUpActions.filter((code) => !followUpAllowed.has(String(code)));
    const wrongImmediate = immediateActions.filter((code) => followUpAllowed.has(String(code)));
    const wrongFollowUp = followUpActions.filter((code) => immediateAllowed.has(String(code)));

    const problems: string[] = [];
    if (invalidImmediate.length) problems.push(`Immediate has unknown code(s): ${invalidImmediate.join(", ")}`);
    if (invalidFollowUp.length) problems.push(`Follow-up has unknown code(s): ${invalidFollowUp.join(", ")}`);
    if (wrongImmediate.length) problems.push(`Immediate has FOLLOW_UP code(s): ${wrongImmediate.join(", ")}`);
    if (wrongFollowUp.length) problems.push(`Follow-up has IMMEDIATE code(s): ${wrongFollowUp.join(", ")}`);

    if (problems.length) {
      return {
        ok: false,
        message: `Action group mismatch detected.\n${problems.join("\n")}`,
      };
    }
    return { ok: true };
  }, [lookups, immediateActions, followUpActions]);

  const saveDraft = useCallback(async (opts?: { silent?: boolean }): Promise<boolean> => {
    if (!token || !id) return false;
    if (!validateDraftMinimumFields()) return false;
    const actionGroupValidation = validateActionGroups();
    if (!actionGroupValidation.ok) {
      Alert.alert("Cannot Save Yet", actionGroupValidation.message ?? "Action group mismatch detected.");
      return false;
    }
    const normalizedForm = enforceFormBusinessRules(form);
    setForm(normalizedForm);
    let geometry: any = null;
    if (normalizedForm.geometry_json.trim()) {
      try {
        geometry = JSON.parse(normalizedForm.geometry_json);
      } catch {
        setFieldErrors((prev) => ({ ...prev, geometry_json: "Geometry JSON is invalid." }));
        setOpenSections((prev) => ({ ...prev, location: true }));
        Alert.alert("Almost there", "Please fix the highlighted Geometry JSON field.");
        return false;
      }
    }
    let pavementAnnotationLayoutPayload: Record<string, any> | null = null;
    if (normalizedForm.pavement_ground_annotation_layout.trim()) {
      try {
        pavementAnnotationLayoutPayload = JSON.parse(normalizedForm.pavement_ground_annotation_layout);
      } catch {
        pavementAnnotationLayoutPayload = parsePavementAnnotationLayout(normalizedForm.pavement_ground_annotation_layout);
      }
    }
    setBusy(true);
    const patchPayload = {
      report_date: n(normalizedForm.report_date), district: n(normalizedForm.district), county: n(normalizedForm.county), route: normalizeRouteValue(normalizedForm.route), post_mile: normalizePostMileValue(normalizedForm.post_mile), ea: n(normalizedForm.ea), project_id: n(normalizedForm.project_id), date_incident_reported: n(normalizedForm.date_incident_reported), district_contact: n(normalizedForm.district_contact),
      latitude: normalizeCoordinateValue(f(normalizedForm.latitude, "Latitude")), longitude: normalizeCoordinateValue(f(normalizedForm.longitude, "Longitude")),
      distribution_code: n(normalizedForm.distribution_code), highway_status_cause: n(normalizedForm.highway_status_cause), highway_status_code: n(normalizedForm.highway_status_code), lanes_closed_count: i(normalizedForm.lanes_closed_count, "Lanes closed count"), open_highway_traffic_lanes_count: i(normalizedForm.open_highway_traffic_lanes_count, "Open highway traffic lanes count"),
      pavement_ground_cracks: triToBool(normalizedForm.pavement_ground_cracks), crack_length_ft: f(normalizedForm.crack_length_ft, "Crack length"), crack_horizontal_in: f(normalizedForm.crack_horizontal_in, "Crack horizontal"), crack_vertical_in: f(normalizedForm.crack_vertical_in, "Crack vertical"), crack_depth_in: f(normalizedForm.crack_depth_in, "Crack depth"), settlement_in: f(normalizedForm.settlement_in, "Settlement"), bulge_in: f(normalizedForm.bulge_in, "Bulge"), indented_by_rocks: triToBool(normalizedForm.indented_by_rocks),
      failure_rock_fall: ynToBool(normalizedForm.failure_rock_fall), failure_topple: ynToBool(normalizedForm.failure_topple), failure_slide: ynToBool(normalizedForm.failure_slide), failure_spread: ynToBool(normalizedForm.failure_spread), failure_flow: ynToBool(normalizedForm.failure_flow), failure_compound: ynToBool(normalizedForm.failure_compound), failure_erosion: ynToBool(normalizedForm.failure_erosion), failure_surficial_failure: ynToBool(normalizedForm.failure_surficial_failure), failure_scoured_toe: ynToBool(normalizedForm.failure_scoured_toe), failure_washout: ynToBool(normalizedForm.failure_washout), incident_type_description: n(normalizedForm.incident_type_description),
      distribution_advancing: ynToBool(normalizedForm.distribution_advancing), distribution_retrogressive: ynToBool(normalizedForm.distribution_retrogressive), distribution_enlarging: ynToBool(normalizedForm.distribution_enlarging), distribution_widening: ynToBool(normalizedForm.distribution_widening), distribution_moving: ynToBool(normalizedForm.distribution_moving), distribution_confined: ynToBool(normalizedForm.distribution_confined),
      material_rock: ynToBool(normalizedForm.material_rock), material_soil: ynToBool(normalizedForm.material_soil), material_bedding: ynToBool(normalizedForm.material_bedding), material_joints: ynToBool(normalizedForm.material_joints), material_fractures: ynToBool(normalizedForm.material_fractures), material_pavement_type: n(normalizedForm.material_pavement_type),
      est_soil_pct: f(normalizedForm.est_soil_pct, "Estimated soil %"), est_rock_pct: f(normalizedForm.est_rock_pct, "Estimated rock formation %"), est_clay_pct: f(normalizedForm.est_clay_pct, "Estimated clay %"), est_silt_pct: f(normalizedForm.est_silt_pct, "Estimated silt %"), est_sand_pct: f(normalizedForm.est_sand_pct, "Estimated sand %"), est_gravel_pct: f(normalizedForm.est_gravel_pct, "Estimated gravel/cobbles %"), est_boulder_pct: f(normalizedForm.est_boulder_pct, "Estimated boulder %"),
      est_debris_clay_silt_pct: f(normalizedForm.est_debris_clay_silt_pct, "Estimated landslide debris clay/silt %"), est_debris_sand_pct: f(normalizedForm.est_debris_sand_pct, "Estimated landslide debris sand %"), est_debris_gravel_pct: f(normalizedForm.est_debris_gravel_pct, "Estimated landslide debris gravel/cobbles %"), est_debris_boulder_pct: f(normalizedForm.est_debris_boulder_pct, "Estimated landslide debris boulder %"),
      water_dry: ynToBool(normalizedForm.water_dry), water_moist: ynToBool(normalizedForm.water_moist), water_wet: ynToBool(normalizedForm.water_wet), water_flowing: ynToBool(normalizedForm.water_flowing), water_seep: ynToBool(normalizedForm.water_seep), water_spring: ynToBool(normalizedForm.water_spring),
      vegetation_trees: pct(normalizedForm.vegetation_trees, "Trees Coverage %"), vegetation_bushes_shrubs: pct(normalizedForm.vegetation_bushes_shrubs, "Bushes/Shrubs Coverage %"), vegetation_groundcover: pct(normalizedForm.vegetation_groundcover, "Groundcover Coverage %"),
      drainage_clogged_inlet: ynToBool(normalizedForm.drainage_clogged_inlet), drainage_compromised_drains: ynToBool(normalizedForm.drainage_compromised_drains), drainage_surface_runoff: ynToBool(normalizedForm.drainage_surface_runoff), drainage_torrent_surge_flood: ynToBool(normalizedForm.drainage_torrent_surge_flood),
      impact_impacted_adj_utilities: ynToBool(normalizedForm.impact_impacted_adj_utilities), impact_maybe_adj_utilities: ynToBool(normalizedForm.impact_maybe_adj_utilities), impact_adj_utilities: n(normalizedForm.impact_adj_utilities), impact_impacted_adj_properties: ynToBool(normalizedForm.impact_impacted_adj_properties), impact_maybe_adj_properties: ynToBool(normalizedForm.impact_maybe_adj_properties), impact_adj_properties: n(normalizedForm.impact_adj_properties), impact_impacted_adj_structure: ynToBool(normalizedForm.impact_impacted_adj_structure), impact_maybe_adj_structure: ynToBool(normalizedForm.impact_maybe_adj_structure), impact_adj_structure: n(normalizedForm.impact_adj_structure),
      measure_slope_height_ft: f(normalizedForm.measure_slope_height_ft, "Slope height"), measure_original_slope_deg: f(normalizedForm.measure_original_slope_deg, "Original slope"), measure_landslide_width_ft: f(normalizedForm.measure_landslide_width_ft, "Landslide width"), measure_landslide_length_ft: f(normalizedForm.measure_landslide_length_ft, "Landslide length"), measure_main_scarp_height_ft: f(normalizedForm.measure_main_scarp_height_ft, "Main scarp height"), measure_landslide_slope_deg: f(normalizedForm.measure_landslide_slope_deg, "Landslide slope"), measure_roadway_length_ft: f(normalizedForm.measure_roadway_length_ft, "Roadway length"), measure_roadway_width_ft: f(normalizedForm.measure_roadway_width_ft, "Roadway width"),
      record_of_event_notes: n(normalizedForm.record_of_event_notes), maintenance_history_notes: n(normalizedForm.maintenance_history_notes), geotechnical_assessment_notes: n(normalizedForm.geotechnical_assessment_notes), recommendations_notes: n(normalizedForm.recommendations_notes), sketchpad_notes: n(normalizedForm.sketchpad_notes),
      observations_notes: n(normalizedForm.observations_notes), geometry_json: geometry, pavement_ground_annotation_layout_json: pavementAnnotationLayoutPayload,
    };
    const incidentItems = Array.from(new Set([
      ...incidentTypesFromFormState(normalizedForm),
      ...incidentTypes.filter((code) => !INCIDENT_TYPE_FORM_CODES.has(code)),
    ]));
    if (isLocalId) {
      try {
        await saveLocalDraft(id, {
          editor: {
            form: normalizedForm,
            incidentTypes: incidentItems,
            immediateActions,
            followUpActions,
            districtContacts,
          } as any,
          syncState: "LOCAL_ONLY",
          lastError: null,
        });
        await enqueueOfflineOp("CREATE_SUBMISSION_FOR_LOCAL_DRAFT", { localId: id });
        await enqueueOfflineOp("PATCH_SUBMISSION", { submissionId: id, patch: patchPayload });
        await enqueueOfflineOp("REPLACE_INCIDENT_TYPES", { submissionId: id, items: incidentItems });
        await enqueueOfflineOp("REPLACE_ACTIONS", {
          submissionId: id,
          immediate: immediateActions,
          follow_up: followUpActions,
        });
        if (!opts?.silent) Alert.alert("Saved Offline", "Local draft saved and queued for automatic sync.");
        triggerOfflineSyncNow().catch(() => {});
      } catch (err: any) {
        Alert.alert("Save failed", String(err?.message ?? err));
        return false;
      } finally {
        setBusy(false);
      }
      return true;
    }
    try {
      await patchSubmission(token, id, patchPayload);
      // Source of truth is the visible form chips; keep API payload derived from form.
      await replaceIncidentTypes(token, id, incidentItems);
      await replaceActions(token, id, { immediate: immediateActions, follow_up: followUpActions });
      if (!opts?.silent) Alert.alert("Saved", "Draft saved.");
      await clearDraftLocalCache();
      await load();
      return true;
    } catch (err: any) {
      if (isSessionExpiredError(err)) return false;
      const msg = String(err?.message ?? "Unable to save");
      if (isLikelyOfflineError(msg)) {
        await enqueueOfflineOp("PATCH_SUBMISSION", { submissionId: id, patch: patchPayload });
        await enqueueOfflineOp("REPLACE_INCIDENT_TYPES", { submissionId: id, items: incidentItems });
        await enqueueOfflineOp("REPLACE_ACTIONS", {
          submissionId: id,
          immediate: immediateActions,
          follow_up: followUpActions,
        });
        if (!opts?.silent) Alert.alert("Saved Offline", "Changes were stored locally and will sync automatically once connectivity is back.");
        triggerOfflineSyncNow().catch(() => {});
        return true;
      } else {
        Alert.alert("Save failed", msg);
        return false;
      }
    } finally { setBusy(false); }
  }, [
    token,
    id,
    validateDraftMinimumFields,
    validateActionGroups,
    form,
    incidentTypesFromFormState,
    immediateActions,
    followUpActions,
    districtContacts,
    isLocalId,
    clearDraftLocalCache,
    load,
  ]);

  async function submitDraft() {
    if (!token || !id) return;
    if (!validateSubmitRequiredFields()) return;
    if (!validateSoilPercentForSubmit()) return;
    if (!validateDebrisPercentForSubmit()) return;
    if (isLocalId) {
      await saveDraft();
      await enqueueOfflineOp("SUBMIT_SUBMISSION", { submissionId: id, comment: null });
      Alert.alert("Queued For Submit", "This local draft will be submitted automatically when connectivity returns.");
      triggerOfflineSyncNow().catch(() => {});
      return;
    }
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
      if (isLikelyOfflineError(raw)) {
        await enqueueOfflineOp("SUBMIT_SUBMISSION", { submissionId: id, comment: null });
        Alert.alert("Queued For Submit", "Submission will be automatically sent when network connectivity returns.");
        triggerOfflineSyncNow().catch(() => {});
        return;
      }
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

  async function notifyCoordinatorNow() {
    if (!token || !id) return;
    if (isLocalId) {
      Alert.alert("Save Required", "This must be a server draft before notifying the coordinator.");
      return;
    }
    if (!immediateActions.length) {
      Alert.alert("Immediate Action Required", "Select at least one Immediate Action before notifying.");
      return;
    }
    const message = notifyMessage.trim();
    if (!message) {
      Alert.alert("Message Required", "Please add a justification message before notifying.");
      return;
    }
    const saved = await saveDraft({ silent: true });
    if (!saved) return;
    setBusy(true);
    try {
      await notifyCoordinatorApi(token, id, message);
      setNotifyMessage("");
      Alert.alert("Coordinator Notified", "Immediate actions were sent to the maintenance coordinator.");
      await load();
    } catch (err: any) {
      if (isSessionExpiredError(err)) return;
      Alert.alert("Notify failed", String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  async function review(decision: "APPROVE" | "REJECT") {
    if (!token || !id) return;
    setBusy(true);
    try { await reviewSubmission(token, id, decision, n(reviewComment) ?? undefined); Alert.alert("Updated", `Submission ${decision === "APPROVE" ? "approved" : "rejected"}.`); await load(); }
    catch (err: any) { if (isSessionExpiredError(err)) return; Alert.alert("Review failed", err?.message ?? "Unable to review"); }
    finally { setBusy(false); }
  }

  async function pickAndUploadAttachment(sectionKey?: string | null) {
    if (!token || !id) return;
    let result: ImagePicker.ImagePickerResult;
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          "Permission required",
          "Photo library access is required to upload files. Please allow access in Settings."
        );
        return;
      }
      result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images", "videos"],
        quality: 0.85,
        allowsMultipleSelection: false,
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
      } else {
        Alert.alert("Picker failed", msg || "Unable to open photo library.");
        return;
      }
    }

    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    const uri = asset.uri;
    const guessedName = asset.fileName || uri.split("/").pop() || "attachment.bin";
    const ext = (guessedName.split(".").pop() || "").toLowerCase();
    let mimeType = asset.mimeType || "application/octet-stream";
    if (!asset.mimeType) {
      if (ext === "png") mimeType = "image/png";
      else if (ext === "jpg" || ext === "jpeg") mimeType = "image/jpeg";
      else if (ext === "mp4") mimeType = "video/mp4";
      else if (ext === "mov") mimeType = "video/quicktime";
    }
    let file: { uri: string; name: string; type: string };
    try {
      file = await prepareUploadFile({ uri, name: guessedName, type: mimeType });
    } catch (err: any) {
      Alert.alert("File unavailable", String(err?.message ?? err ?? "Unable to access the selected file."));
      return;
    }
    const kind = inferAttachmentKind(file.name, file.type);

    if (isLocalId) {
      await enqueueOfflineOp("CREATE_SUBMISSION_FOR_LOCAL_DRAFT", { localId: id });
      await enqueueOfflineOp("UPLOAD_ATTACHMENT", {
        submissionId: id,
        file,
        sectionKey: sectionKey ?? null,
        kind,
      });
      Alert.alert("Upload Queued", "Attachment saved locally and will upload after sync.");
      triggerOfflineSyncNow().catch(() => {});
      return;
    }

    setBusy(true);
    try {
      const uploaded = await uploadSubmissionAttachment(
        token,
        id,
        file,
        { sectionKey: sectionKey ?? null, kind }
      );
      registerLocalAttachmentUri(Number(uploaded?.attachment_id), file.uri);
      await load();
    } catch (err: any) {
      if (isSessionExpiredError(err)) return;
      const msg = String(err?.message ?? "Unable to upload");
      if (isLikelyOfflineError(msg)) {
        await enqueueOfflineOp("UPLOAD_ATTACHMENT", {
          submissionId: id,
          file,
          sectionKey: sectionKey ?? null,
          kind,
        });
        Alert.alert("Upload Queued", "Attachment was queued and will upload automatically when connectivity is restored.");
        triggerOfflineSyncNow().catch(() => {});
      } else {
        Alert.alert(
          "Upload failed",
          `${msg}\n\nTip: For physical devices, set EXPO_PUBLIC_API_URL to your computer LAN IP (e.g. http://192.168.x.x:8000).`
        );
      }
    }
    finally { setBusy(false); }
  }

  async function pickAndUploadDocument(sectionKey?: string | null) {
    if (!token || !id) return;
    let DocumentPicker: any = null;
    try {
      const dynamicImport = new Function("m", "return import(m)") as (moduleName: string) => Promise<any>;
      DocumentPicker = await dynamicImport("expo-document-picker");
    } catch {
      Alert.alert(
        "Module missing",
        "expo-document-picker is required for CAD/PDF/doc uploads. Run: npx expo install expo-document-picker"
      );
      return;
    }

    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "*/*",
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];
      const uri = String(asset.uri || "").trim();
      if (!uri) {
        Alert.alert("File picker error", "Selected file is missing URI.");
        return;
      }
      const name = String(asset.name || "attachment.bin");
      const mimeType = String(asset.mimeType || "application/octet-stream");
      const file = await prepareUploadFile({ uri, name, type: mimeType });
      const kind = inferAttachmentKind(file.name, file.type);

      if (isLocalId) {
        await enqueueOfflineOp("CREATE_SUBMISSION_FOR_LOCAL_DRAFT", { localId: id });
        await enqueueOfflineOp("UPLOAD_ATTACHMENT", {
          submissionId: id,
          file,
          sectionKey: sectionKey ?? null,
          kind,
        });
        Alert.alert("Upload Queued", "File saved locally and will upload after sync.");
        triggerOfflineSyncNow().catch(() => {});
        return;
      }

      setBusy(true);
      try {
        const uploaded = await uploadSubmissionAttachment(
          token,
          id,
          file,
          { sectionKey: sectionKey ?? null, kind }
        );
        registerLocalAttachmentUri(Number(uploaded?.attachment_id), file.uri);
        await load();
      } catch (err: any) {
        if (isSessionExpiredError(err)) return;
        const msg = String(err?.message ?? err ?? "Unable to upload selected file.");
        if (isLikelyOfflineError(msg)) {
          await enqueueOfflineOp("UPLOAD_ATTACHMENT", {
            submissionId: id,
            file,
            sectionKey: sectionKey ?? null,
            kind,
          });
          Alert.alert("Upload Queued", "File was queued and will upload automatically when connectivity is restored.");
          triggerOfflineSyncNow().catch(() => {});
        } else {
          Alert.alert("Upload failed", msg);
        }
      } finally {
        setBusy(false);
      }
    } catch (err: any) {
      Alert.alert("File picker failed", String(err?.message ?? err ?? "Unable to open file picker."));
    }
  }

  function promptUploadSource(sectionKey?: string | null) {
    Alert.alert("Upload Source", "Choose where to pick the file from.", [
      { text: "Gallery", onPress: () => { pickAndUploadAttachment(sectionKey).catch(() => {}); } },
      { text: "Files (CAD/PDF/etc)", onPress: () => { pickAndUploadDocument(sectionKey).catch(() => {}); } },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  async function openNativeSketchpad() {
    if (!token || !id) return;
    if (Platform.OS !== "ios") {
      Alert.alert("Unavailable", "Native Apple Pencil sketching is currently available only on iOS.");
      return;
    }

    let bridge: typeof import("../../../src/arcgis/ArcGISNative") | null = null;
    try {
      bridge = await import("../../../src/arcgis/ArcGISNative");
    } catch {
      Alert.alert("Unavailable", "Sketchpad native module is not included in this build.");
      return;
    }
    if (!bridge?.isArcGisNativeAvailable?.()) {
      Alert.alert("Unavailable", "Sketchpad native module is not included in this build.");
      return;
    }

    setBusy(true);
    try {
      await bridge.clearSketch().catch(() => {});
      await bridge.startPencilSketch();
      const uri = await bridge.getSketchImagePath();
      const fileName = uri.split("/").pop() || `gisa-sketch-${Date.now()}.png`;
      const file = await prepareUploadFile({ uri, name: fileName, type: "image/png" });

      if (isLocalId) {
        await enqueueOfflineOp("CREATE_SUBMISSION_FOR_LOCAL_DRAFT", { localId: id });
        await enqueueOfflineOp("UPLOAD_ATTACHMENT", {
          submissionId: id,
          file,
          sectionKey: "sketchpad",
          kind: "SKETCH",
        });
        Alert.alert("Sketch queued", "The sketch was saved locally and will upload after sync.");
        triggerOfflineSyncNow().catch(() => {});
        return;
      }

      try {
        const uploaded = await uploadSubmissionAttachment(token, id, file, { sectionKey: "sketchpad", kind: "SKETCH" });
        registerLocalAttachmentUri(Number(uploaded?.attachment_id), file.uri);
        await load();
      } catch (err: any) {
        if (isSessionExpiredError(err)) return;
        const msg = String(err?.message ?? err ?? "Unable to upload sketch.");
        if (isLikelyOfflineError(msg)) {
          await enqueueOfflineOp("UPLOAD_ATTACHMENT", {
            submissionId: id,
            file,
            sectionKey: "sketchpad",
            kind: "SKETCH",
          });
          Alert.alert("Sketch queued", "The sketch was queued and will upload automatically when connectivity is restored.");
          triggerOfflineSyncNow().catch(() => {});
          return;
        }
        throw err;
      }
    } catch (err: any) {
      if (isSessionExpiredError(err)) return;
      const msg = String(err?.message ?? err ?? "Unable to save sketch.");
      if (msg.includes("No sketch image found")) {
        Alert.alert("Sketch not saved", "Draw and save a sketch before closing the sketchpad.");
      } else if (!/cancel/i.test(msg)) {
        Alert.alert("Sketch failed", msg);
      }
    } finally {
      setBusy(false);
    }
  }

  async function pickPhoto() {
    try {
      promptUploadSource(null);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      Alert.alert("Upload failed", msg || "Unable to pick/upload media.");
    }
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
          const routeGuess = normalizeRouteInput(tryExtractRouteFromAddressLine([item.name, item.street, item.city].filter(Boolean).join(" ")));
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
        setVal("latitude", formatCoordinate(lastKnown.coords.latitude));
        setVal("longitude", formatCoordinate(lastKnown.coords.longitude));
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
        setVal("latitude", formatCoordinate(fresh.coords.latitude));
        setVal("longitude", formatCoordinate(fresh.coords.longitude));
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
      headerRight:
        draftEntryStatus && canEditCandidate
          ? () => (
              <Pressable
                onPress={() => {
                  if (!busy) saveDraft();
                }}
                style={{ paddingHorizontal: 6, paddingVertical: 2, opacity: busy ? 0.6 : 1 }}
                disabled={busy}
              >
                <Text style={{ color: palette.primary, fontWeight: "700" }}>{busy ? "Saving..." : "Save"}</Text>
              </Pressable>
            )
          : undefined,
    });
  }, [data, draftEntryStatus, navigation, palette.primary, canEditCandidate, busy, saveDraft]);

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

  const openMapEditor = useCallback(() => {
    refreshGeometryOnFocusRef.current = true;
    router.push({
      pathname: (draftEntryStatus ? "/(tabs)/drafts/map" : "/(tabs)/submissions/map") as any,
      params: {
        id: String(id ?? ""),
        latitude: form.latitude,
        longitude: form.longitude,
      },
    });
  }, [draftEntryStatus, form.latitude, form.longitude, id]);

  const openLocationInGoogleMaps = useCallback(async () => {
    const lat = normalizeCoordinateValue(form.latitude);
    const lon = normalizeCoordinateValue(form.longitude);
    if (lat == null || lon == null) {
      Alert.alert("Location required", "Enter a valid latitude and longitude before opening Google Maps.");
      return;
    }

    const coordinatePair = `${lat},${lon}`;
    const query = encodeURIComponent(coordinatePair);
    const url = `https://www.google.com/maps/place/${query}/@${coordinatePair},17z`;
    try {
      await Linking.openURL(url);
    } catch (err: any) {
      Alert.alert("Google Maps failed", String(err?.message ?? err ?? "Unable to open Google Maps."));
    }
  }, [form.latitude, form.longitude]);

  useEffect(() => {
    setShowLocationCoordinates(false);
    setFullscreenPhoto(null);
    setFigureCitationRequest(null);
    if (!id || isLocalDraftId(id)) {
      setLocalAttachmentUris({});
    }
  }, [id]);

  useEffect(() => {
    if (fieldErrors.latitude || fieldErrors.longitude) {
      setShowLocationCoordinates(true);
    }
  }, [fieldErrors.latitude, fieldErrors.longitude]);

  if (!token || loading || !data || !lookups || !me) return <View style={styles.center}><ActivityIndicator size="large" /></View>;
  const roles = new Set(me.roles || []);
  const canEdit = (data.submission.status === "DRAFT" || data.submission.status === "REJECTED") && !!data.submission.can_edit;
  const canReview = data.submission.status === "SUBMITTED" && (roles.has("REVIEWER") || roles.has("ADMIN"));
  const isDraftEntry = draftEntryStatus;
  const allAttachments = data.attachments ?? data.photos;
  const sectionAttachments = allAttachments.filter((a: any) => !!a.section_key);
  const sectionAttachmentIds = new Set(sectionAttachments.map((a: any) => Number(a.id)));
  const generalPhotos = data.photos;
  const photoIdSet = new Set(data.photos.map((p) => Number(p.id)));
  const latestPhoto = data.photos.length ? data.photos[data.photos.length - 1] : null;
  const galleryColumns = isAccessibilityLayout || windowWidth < 360 ? 2 : windowWidth >= 780 ? 4 : 3;
  const galleryGap = Math.round(8 * componentScale);
  const galleryImages: GalleryImage[] = (() => {
    const imageById = new Map<number, { id: number; file_name: string; mime_type: string; kind?: string; section_key?: string | null }>();
    const orderedIds: number[] = [];
    const addImage = (file: any, fallbackSectionKey?: string | null) => {
      const idValue = Number(file?.id);
      if (!Number.isFinite(idValue) || idValue <= 0) return;
      const mimeType = String(file?.mime_type || "");
      const isPreviewableImage = photoIdSet.has(idValue) || mimeType.toLowerCase().startsWith("image/");
      if (!isPreviewableImage) return;
      const existing = imageById.get(idValue);
      const next = {
        id: idValue,
        file_name: String(file?.file_name || `Image ${idValue}`),
        mime_type: mimeType || existing?.mime_type || "image/*",
        kind: file?.kind ?? existing?.kind,
        section_key: file?.section_key ?? existing?.section_key ?? fallbackSectionKey ?? null,
      };
      if (!existing) orderedIds.push(idValue);
      imageById.set(idValue, next);
    };

    (allAttachments ?? []).forEach((file: any) => addImage(file, null));
    (generalPhotos ?? []).forEach((file: any) => addImage(file, null));

    const figureCounts = new Map<string, number>();
    return orderedIds.map((imageId) => {
      const image = imageById.get(imageId)!;
      const source = gallerySourceForSectionKey(image.section_key);
      const currentCount = (figureCounts.get(source.key) ?? 0) + 1;
      figureCounts.set(source.key, currentCount);
      return {
        ...image,
        sourceLabel: source.label,
        figureLabel: `Figure ${source.figureSection}.${currentCount}`,
      };
    });
  })();
  const galleryRows: GalleryImage[][] = [];
  for (let index = 0; index < galleryImages.length; index += galleryColumns) {
    galleryRows.push(galleryImages.slice(index, index + galleryColumns));
  }
  const figureCitationFieldProps = {
    citationImages: galleryImages,
    onCitationTrigger: setFigureCitationRequest,
    onCitationPress: openCitedFigure,
  };
  const pavementSectionPhoto =
    [...sectionAttachments]
      .reverse()
      .find(
        (file: any) =>
          file.section_key === "pavement_ground_status" &&
          (photoIdSet.has(Number(file.id)) || String(file.mime_type || "").toLowerCase().startsWith("image/"))
      ) ?? null;
  const submissionUpdatedAt = data?.submission.updated_at ?? "";
  const drainageKeys = ["drainage_clogged_inlet", "drainage_compromised_drains", "drainage_surface_runoff", "drainage_torrent_surge_flood"];
  const baseWaterKeys = ["water_dry", "water_moist", "water_wet", "water_flowing"];
  const materialRockSelected = form.material_rock === "YES";
  const materialSoilSelected = form.material_soil === "YES";
  const claySiltPercentValue = (() => {
    const clayRaw = String(form.est_clay_pct ?? "").trim();
    const siltRaw = String(form.est_silt_pct ?? "").trim();
    if (!clayRaw && !siltRaw) return "";
    const clayValue = clayRaw ? Number(clayRaw) : 0;
    const siltValue = siltRaw ? Number(siltRaw) : 0;
    if (!Number.isFinite(clayValue) || !Number.isFinite(siltValue)) return "";
    const combined = Math.max(0, Math.min(100, Math.round((clayValue + siltValue) / 5) * 5));
    return String(combined);
  })();
  const waterFlowingSelected = form.water_flowing === "YES";
  const highwayLanesClosedSelected = form.highway_status_code === "LANES_CLOSED";
  const openHighwayTrafficSelected = immediateActions.includes("OPEN_HIGHWAY_TRAFFIC") || followUpActions.includes("OPEN_HIGHWAY_TRAFFIC");
  const showHighwayStatusOptions = !!(
    form.highway_status_cause.trim() ||
    form.highway_status_code ||
    form.lanes_closed_count ||
    form.open_highway_traffic_lanes_count ||
    openHighwayTrafficSelected
  );
  const immediateActionOptions = lookups.actions.immediate ?? [];
  const followUpActionOptions = lookups.actions.follow_up ?? [];
  const actionLabelByCode: Record<string, string> = {};
  [...immediateActionOptions, ...followUpActionOptions].forEach((x) => {
    actionLabelByCode[String(x.code)] = String(x.label || x.code);
  });
  const selectedImmediateLabel = immediateActions.length
    ? immediateActions.map((code) => actionLabelByCode[code] ?? code).join(", ")
    : "";
  const selectedFollowUpLabel = followUpActions.length
    ? followUpActions.map((code) => actionLabelByCode[code] ?? code).join(", ")
    : "";
  const canNotifyCoordinatorNow = canEdit && !isLocalId && immediateActions.length > 0;

  const toggleIncidentType = (option: IncidentTypeOption) => {
    if (!canEdit) return;
    const active = incidentTypes.includes(option.code) || (!!option.key && form[option.key] === "YES");
    const selecting = !active;
    setIncidentTypes((prev) => {
      const without = prev.filter((code) => code !== option.code);
      return selecting ? [...without, option.code] : without;
    });
    if (option.key) {
      setForm((prev) => ({ ...prev, [option.key as string]: selecting ? "YES" : "NO" }));
    }
  };

  const toggleMaterialSection = (key: "material_rock" | "material_soil") => {
    if (!canEdit) return;
    const selecting = form[key] !== "YES";
    setVal(key, selecting ? "YES" : "NO");
    if (key === "material_soil" && !selecting) {
      setVal("est_soil_pct", "");
      setVal("est_clay_pct", "");
      setVal("est_silt_pct", "");
      setVal("est_sand_pct", "");
      setVal("est_gravel_pct", "");
      setVal("est_boulder_pct", "");
    }
    if (key === "material_rock" && !selecting) {
      setVal("est_rock_pct", "");
      setVal("material_bedding", "NO");
      setVal("material_joints", "NO");
      setVal("material_fractures", "NO");
    }
  };

  const setPercentStep = (
    key: "est_soil_pct" | "est_rock_pct" | "est_clay_pct" | "est_silt_pct" | "est_sand_pct" | "est_gravel_pct" | "est_boulder_pct" | "est_debris_clay_silt_pct" | "est_debris_sand_pct" | "est_debris_gravel_pct" | "est_debris_boulder_pct",
    value: string
  ) => {
    if (!canEdit) return;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      setVal(key, "");
      return;
    }
    const stepped = Math.max(0, Math.min(100, Math.round(numeric / 5) * 5));
    setVal(key, String(stepped));
  };

  const setClaySiltPercentStep = (value: string) => {
    if (!canEdit) return;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      setVal("est_clay_pct", "");
      setVal("est_silt_pct", "");
      return;
    }
    const stepped = Math.max(0, Math.min(100, Math.round(numeric / 5) * 5));
    setVal("est_clay_pct", String(stepped));
    setVal("est_silt_pct", "0");
  };

  const selectRockSubtype = (key: "material_bedding" | "material_joints" | "material_fractures") => {
    if (!canEdit || form.material_rock !== "YES") return;
    const selecting = form[key] !== "YES";
    setVal(key, selecting ? "YES" : "NO");
  };

  const selectSingleDrainage = (key: string) => {
    if (!canEdit) return;
    const selecting = form[key] !== "YES";
    drainageKeys.forEach((k) => setVal(k as keyof FormState, k === key && selecting ? "YES" : "NO"));
  };

  const selectBaseWaterContent = (key: string) => {
    if (!canEdit) return;
    const selecting = form[key] !== "YES";
    baseWaterKeys.forEach((k) => setVal(k as keyof FormState, k === key && selecting ? "YES" : "NO"));
    if (!selecting || key !== "water_flowing") {
      setVal("water_seep", "NO");
      setVal("water_spring", "NO");
    }
  };

  const selectFlowingSubtype = (key: "water_seep" | "water_spring") => {
    if (!canEdit || form.water_flowing !== "YES") return;
    const selecting = form[key] !== "YES";
    setVal("water_seep", key === "water_seep" && selecting ? "YES" : "NO");
    setVal("water_spring", key === "water_spring" && selecting ? "YES" : "NO");
  };

  const toggleActionByGroup = (code: string, group: "IMMEDIATE" | "FOLLOW_UP") => {
    if (!canEdit) return;
    if (group === "IMMEDIATE") {
      setImmediateActions((prev) => {
        return prev.includes(code) ? prev.filter((x) => x !== code) : [...prev, code];
      });
      return;
    }
    setFollowUpActions((prev) => {
      return prev.includes(code) ? prev.filter((x) => x !== code) : [...prev, code];
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

  function remoteAttachmentUri(attachmentId: number) {
    const remoteUri = photoUrls[attachmentId];
    if (remoteUri) return remoteUri;
    const queryToken = encodeURIComponent(token || "");
    return `${apiBaseUrl}/attachments/${attachmentId}/content?access_token=${queryToken}`;
  }

  function handleAttachmentPreviewError(attachmentId: number) {
    const localUri = localAttachmentUris[attachmentId];
    if (isLocalAttachmentUri(localUri)) {
      setLocalAttachmentUris((prev) => {
        if (!prev[attachmentId]) return prev;
        const next = { ...prev };
        delete next[attachmentId];
        if (id && !isLocalDraftId(id)) {
          setAttachmentUriCache(attachmentUriCacheKey(id), next).catch(() => {});
        }
        return next;
      });
      setFailedPreviewIds((prev) => {
        if (!prev[attachmentId]) return prev;
        const next = { ...prev };
        delete next[attachmentId];
        return next;
      });
      return;
    }
    setFailedPreviewIds((prev) => ({ ...prev, [attachmentId]: true }));
  }

  function previewSource(photoId: number) {
    const uri = getAttachmentUri(photoId);
    return { uri } as const;
  }

  async function openPhotoFallback(photoId: number) {
    const url = getAttachmentUri(photoId);
    const remoteUrl = remoteAttachmentUri(photoId);
    try {
      await Linking.openURL(url);
    } catch {
      if (remoteUrl && remoteUrl !== url) {
        try {
          await Linking.openURL(remoteUrl);
          return;
        } catch {
          // Fall through to the user-facing alert below.
        }
      }
      Alert.alert("Preview unavailable", "Could not open this image on this device.");
    }
  }

  async function openFullscreenInDeviceEditor() {
    if (!fullscreenPhoto?.uri) return;
    if (!fullscreenPhoto.isLocal) {
      Alert.alert(
        "Local Editor Unavailable",
        "This image is currently loaded from the server. Photos picked on this device during this editing session can open in the device's native editor."
      );
      return;
    }
    try {
      await Linking.openURL(fullscreenPhoto.uri);
    } catch {
      Alert.alert("Editor unavailable", "Could not open this image in a device editor.");
    }
  }

  function renderTaggedSectionMedia(sectionKey: string, opts?: { hideUploadButton?: boolean }) {
    const tagged = sectionAttachments.filter((a: any) => a.section_key === sectionKey);
    return (
      <View style={{ marginTop: 8 }}>
        {!opts?.hideUploadButton ? (
          <View style={styles.sectionAttachmentActions}>
            <Pressable
              style={[styles.btnGhost, styles.sectionAttachmentActionBtn, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}
              onPress={() => promptUploadSource(sectionKey)}
              disabled={!canEdit || busy}
            >
              <Text style={[styles.btnGhostText, { color: palette.text }]}>{busy ? "Working..." : "Upload Photo"}</Text>
            </Pressable>
            {sectionKey === "sketchpad" ? (
              <Pressable
                style={[styles.btnGhost, styles.sectionAttachmentActionBtn, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}
                onPress={() => openNativeSketchpad().catch(() => {})}
                disabled={!canEdit || busy}
              >
                <Text style={[styles.btnGhostText, { color: palette.text }]}>
                  {busy ? "Working..." : Platform.OS === "ios" ? "Open Sketchpad" : "Sketchpad (iOS only)"}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {tagged.length ? (
          tagged.map((file: any) => {
            const isPreviewableImage = photoIdSet.has(Number(file.id)) || String(file.mime_type || "").toLowerCase().startsWith("image/");
            return (
              <View key={`${sectionKey}-${file.id}`} style={styles.sectionAttachmentRow}>
                <Text style={{ fontWeight: "600", color: palette.text }}>{file.file_name}</Text>
                {isPreviewableImage && !failedPreviewIds[file.id] ? (
                  <Pressable onPress={() => openFullscreen(file.id, file.file_name)} style={{ marginTop: 6 }}>
                    <Image
                      source={previewSource(file.id)}
                      style={styles.photoPreviewCompact}
                      onError={() => handleAttachmentPreviewError(file.id)}
                    />
                  </Pressable>
                ) : (
                  <Pressable onPress={() => openPhotoFallback(file.id)} style={{ marginTop: 6 }}>
                    <Text style={[styles.muted, { color: palette.muted }]}>Open file</Text>
                  </Pressable>
                )}
              </View>
            );
          })
        ) : (
          <Text style={[styles.muted, { marginTop: 8, color: palette.muted }]}>
            {sectionKey === "sketchpad" ? "No sketch or photo uploaded for this section yet." : "No photo uploaded for this section yet."}
          </Text>
        )}
      </View>
    );
  }

  async function generateGisaPdf() {
    if (!token || !id) return;
    setBusy(true);
    try {
      const resp = await generateSubmissionGisaPdf(token, id);
      await Linking.openURL(resp.download_url);
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
      await Linking.openURL(resp.download_url);
    } catch (err: any) {
      if (isSessionExpiredError(err)) return;
      Alert.alert("No PDF yet", "Generate the GISA PDF first, then open it.");
    } finally {
      setBusy(false);
    }
  }

  function openFullscreen(photoId: number, name: string) {
    const uri = getAttachmentUri(photoId);
    if (!uri) return;
    fullscreenProgress.setValue(0);
    setFullscreenPhoto({ uri, name, isLocal: isLocalAttachmentUri(uri) });
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

  function openCitedFigure(image: GalleryImage) {
    openFullscreen(image.id, `${image.figureLabel} - ${image.file_name}`);
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
      canCancelContentTouches
      keyboardDismissMode={isIOS ? "interactive" : "on-drag"}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[styles.contentWrap, { padding: Math.round((compact ? 10 : 14) * componentScale), gap: Math.round((compact ? 8 : 10) * componentScale) }]}
    >
      <Text style={[styles.title, { color: palette.text, fontSize: Math.round((isIOS ? 22 : 24) * componentScale) }]} maxFontSizeMultiplier={textScale}>{isDraftEntry ? "Draft" : "Submission"}</Text>
      <Text style={[styles.muted, { color: palette.muted, fontSize: Math.round(12 * componentScale) }]} maxFontSizeMultiplier={textScale}>
        {buildSubmissionDescriptor({
          id: data.submission.id,
          created_at: data.submission.created_at,
          district: form.district || data.gisa?.district,
          county: form.county || data.gisa?.county,
          route: form.route || data.gisa?.route,
          post_mile: form.post_mile || data.gisa?.post_mile,
        })}
      </Text>
      <Text style={[styles.status, { color: palette.muted, fontSize: Math.round(13 * componentScale) }]} maxFontSizeMultiplier={textScale}>Status: {data.submission.status}</Text>
      <View style={[styles.stepTabsRow, { gap: Math.max(4, Math.round(4 * componentScale)) }]}>
        {STEP_LABELS.map((step, idx) => (
          <ScrollSafePressable
            key={step}
            onPress={() => setActiveStep(idx)}
            style={[
              styles.stepTab,
              { paddingHorizontal: Math.round(4 * componentScale), paddingVertical: Math.round(7 * componentScale), borderRadius: Math.round(10 * componentScale) },
              idx === activeStep
                ? [
                    styles.stepTabActive,
                    {
                      borderColor: palette.primary,
                      backgroundColor: isDarkTheme ? palette.panelSoft : "#dbeafe",
                    },
                  ]
                : [
                    styles.stepTabInactive,
                    {
                      borderColor: palette.border,
                      backgroundColor: isDarkTheme ? palette.panel : "#f8fafc",
                    },
                  ],
            ]}
          >
            <Text style={[styles.stepTabIndex, { color: idx <= activeStep ? palette.primary : palette.muted }]}>{idx + 1}</Text>
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.72}
              style={[styles.stepTabLabel, { color: idx === activeStep ? palette.text : palette.muted, fontSize: Math.max(12, Math.round(12 * componentScale)), lineHeight: Math.max(13, Math.round(13 * componentScale)) }]}
              maxFontSizeMultiplier={textScale}
            >
              {step}
            </Text>
          </ScrollSafePressable>
        ))}
      </View>
      <Text style={[styles.muted, { color: palette.muted, fontSize: Math.round(12 * componentScale) }]} maxFontSizeMultiplier={textScale}>Step {activeStep + 1} of {FORM_STEPS.length}</Text>
      <View style={activeStep === 0 ? undefined : styles.hidden}>
        <View style={styles.stepSectionStack}>
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
        <Field palette={palette} label="Post Mile" value={form.post_mile} editable={canEdit} onChangeText={(v) => setVal("post_mile", v)} onBlur={() => setVal("post_mile", normalizePostMileInput(form.post_mile))} error={fieldErrors.post_mile} />
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
                <ScrollSafePressable style={styles.contactCardHeader} onPress={() => toggleDistrictContact(contact.id)}>
                  <Text style={[styles.contactCardTitle, { color: palette.text }]}>{contactDisplayName(contact, idx)}</Text>
                  <Text style={[styles.sectionChevron, { color: palette.muted }]}>{isOpen ? "v" : ">"}</Text>
                </ScrollSafePressable>
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
        <ScrollSafePressable
          style={[styles.mapPreviewCard, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}
          onPress={openMapEditor}
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
        </ScrollSafePressable>
        <View style={styles.locationActionRow}>
          <Pressable
            style={[styles.btnGhost, styles.locationActionButton, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}
            onPress={openLocationInGoogleMaps}
            disabled={busy}
          >
            <Text style={[styles.btnGhostText, { color: palette.text }]}>Open in Google Maps</Text>
          </Pressable>
          <Pressable
            style={[styles.btnGhost, styles.locationActionButton, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}
            onPress={() => setShowLocationCoordinates((prev) => !prev)}
            disabled={busy}
          >
            <Text style={[styles.btnGhostText, { color: palette.text }]}>
              {showLocationCoordinates ? "Hide Lat/Lon" : "Show Lat/Lon"}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.btnGhost, styles.locationActionButton, { borderColor: palette.border, backgroundColor: palette.panelSoft }]}
            onPress={() => setShowNorthingEasting((prev) => !prev)}
            disabled={busy || !statePlaneCoordinates}
          >
            <Text style={[styles.btnGhostText, { color: palette.text }]}>
              {showNorthingEasting ? "Hide N/E" : "Show N/E"}
            </Text>
          </Pressable>
        </View>
        {showLocationCoordinates ? (
          <View style={styles.locationCoordinateRow}>
            <View style={styles.locationCoordinateField}>
              <Field palette={palette} label="Latitude *" value={form.latitude} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("latitude", v)} onBlur={() => setVal("latitude", formatCoordinate(form.latitude))} error={fieldErrors.latitude} />
            </View>
            <View style={styles.locationCoordinateField}>
              <Field palette={palette} label="Longitude *" value={form.longitude} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("longitude", v)} onBlur={() => setVal("longitude", formatCoordinate(form.longitude))} error={fieldErrors.longitude} />
            </View>
          </View>
        ) : null}
        {showNorthingEasting && statePlaneCoordinates ? (
          <View style={{ marginTop: 8 }}>
            <Text style={[styles.muted, { color: palette.muted }]}>
              CCS83 Zone {statePlaneCoordinates.zone} • {statePlaneCoordinates.units}
            </Text>
            <View style={styles.locationCoordinateRow}>
              <View style={styles.locationCoordinateField}>
                <Field
                  palette={palette}
                  label="Northing"
                  value={northingInput}
                  editable={canEdit}
                  keyboardType="decimal-pad"
                  onChangeText={(v) => {
                    setNorthingInput(v);
                    if (statePlaneInputError) setStatePlaneInputError("");
                  }}
                  onBlur={applyStatePlaneInputs}
                  error={statePlaneInputError || undefined}
                />
              </View>
              <View style={styles.locationCoordinateField}>
                <Field
                  palette={palette}
                  label="Easting"
                  value={eastingInput}
                  editable={canEdit}
                  keyboardType="decimal-pad"
                  onChangeText={(v) => {
                    setEastingInput(v);
                    if (statePlaneInputError) setStatePlaneInputError("");
                  }}
                  onBlur={applyStatePlaneInputs}
                  error={statePlaneInputError || undefined}
                />
              </View>
            </View>
            {statePlaneInputError ? <Text style={styles.errorText}>{statePlaneInputError}</Text> : null}
          </View>
        ) : null}
      </CollapsibleSection>
        <View style={styles.stepNavRow}>
          <View style={styles.stepNavSpacer} />
          <Pressable style={[styles.btnPrimary, styles.stepNavBtn, { backgroundColor: palette.primary }]} onPress={goNextStep}>
            <Text style={styles.btnPrimaryText}>Continue</Text>
          </Pressable>
        </View>
        </View>
      </View>

      <View style={activeStep === 1 ? undefined : styles.hidden}>
        <View style={styles.stepSectionStack}>
        <DropdownBlock title="Distribution" open={openPaperBlocks.distributionMain} onToggle={() => togglePaperBlock("distributionMain")} palette={palette}>
          <View style={styles.chips}>
            {lookups.distribution.map((o) => (
              <Chip
                key={o.code}
                label={o.label}
                palette={palette}
                active={form.distribution_code === o.code}
                disabled={!canEdit}
                onPress={() => canEdit && setVal("distribution_code", form.distribution_code === o.code ? "" : o.code)}
                iconLeft={
                  DISTRIBUTION_ICON_SOURCE[o.code] ? (
                    <Image
                      source={DISTRIBUTION_ICON_SOURCE[o.code]}
                      style={styles.distributionIcon}
                      resizeMode="contain"
                    />
                  ) : null
                }
              />
            ))}
          </View>
          {renderTaggedSectionMedia("distribution")}
        </DropdownBlock>

        <DropdownBlock title="Highway Status" open={openPaperBlocks.highwayStatusMain} onToggle={() => togglePaperBlock("highwayStatusMain")} palette={palette}>
          <Field
            palette={palette}
            label="Cause Of Highway Status"
            value={form.highway_status_cause}
            editable={canEdit}
            onChangeText={(v) => setVal("highway_status_cause", v)}
            {...figureCitationFieldProps}
          />
          {showHighwayStatusOptions ? (
            <>
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
                <SelectField
                  palette={palette}
                  label="Lane(s) Closed Count"
                  value={form.lanes_closed_count}
                  placeholder="Select lanes closed"
                  editable={canEdit}
                  onPress={() => setLanesClosedPickerOpen(true)}
                  error={fieldErrors.lanes_closed_count}
                />
              ) : null}
            </>
          ) : (
            <Text style={[styles.muted, { color: palette.muted }]}>
              Enter the cause above to reveal the highway status options.
            </Text>
          )}
          {renderTaggedSectionMedia("highway_status")}
        </DropdownBlock>

        <DropdownBlock title="Incident Type" open={openPaperBlocks.incidentType} onToggle={() => togglePaperBlock("incidentType")} palette={palette}>
          <View style={styles.chips}>
            {INCIDENT_TYPE_OPTIONS.map((option) => (
              <Chip
                key={option.code}
                label={option.label}
                palette={palette}
                active={incidentTypes.includes(option.code) || (!!option.key && form[option.key] === "YES")}
                disabled={!canEdit}
                onPress={() => toggleIncidentType(option)}
              />
            ))}
          </View>
          <Field
            palette={palette}
            label="Incident Type Description"
            value={form.incident_type_description}
            editable={canEdit}
            multiline
            onChangeText={(v) => setVal("incident_type_description", v)}
            {...figureCitationFieldProps}
          />
          {renderTaggedSectionMedia("incident_type")}
        </DropdownBlock>

        <DropdownBlock title="Material" open={openPaperBlocks.material} onToggle={() => togglePaperBlock("material")} palette={palette}>
          <View style={styles.materialSectionBubbleRow}>
            <MaterialSectionBubble
              label="Slope"
              active={activeMaterialSection === "slope"}
              onPress={() => setActiveMaterialSection("slope")}
              palette={palette}
            />
            <MaterialSectionBubble
              label="Pavement"
              active={activeMaterialSection === "pavement"}
              onPress={() => setActiveMaterialSection("pavement")}
              palette={palette}
            />
            <MaterialSectionBubble
              label="Landslide Debris"
              active={activeMaterialSection === "debris"}
              onPress={() => setActiveMaterialSection("debris")}
              palette={palette}
            />
          </View>

          {activeMaterialSection === "slope" ? (
            <MaterialSubsection title="Slope" palette={palette}>
              <View style={styles.materialSlopeStack}>
                <View pointerEvents="box-none" style={[styles.materialInlineGroup, { borderColor: palette.border, backgroundColor: palette.panel }]}>
                  <View style={styles.materialInlineHeader}>
                    <Text style={[styles.materialInlineTitle, { color: palette.text }]}>Soil</Text>
                    <Chip
                      label={materialSoilSelected ? "YES" : "NO"}
                      palette={palette}
                      active={materialSoilSelected}
                      disabled={!canEdit}
                      onPress={() => toggleMaterialSection("material_soil")}
                    />
                  </View>
                  {materialSoilSelected ? (
                    <View style={styles.materialInlineBody}>
                      <SteppedPercentInput label="Soil Est %" value={form.est_soil_pct} editable={canEdit} palette={palette} onChange={(v) => setPercentStep("est_soil_pct", v)} />
                      <SteppedPercentInput label="Clay/Silt Est %" value={claySiltPercentValue} editable={canEdit} palette={palette} onChange={setClaySiltPercentStep} />
                      <SteppedPercentInput label="Sand Est %" value={form.est_sand_pct} editable={canEdit} palette={palette} onChange={(v) => setPercentStep("est_sand_pct", v)} />
                      <SteppedPercentInput label="Gravel/Cobbles Est %" value={form.est_gravel_pct} editable={canEdit} palette={palette} onChange={(v) => setPercentStep("est_gravel_pct", v)} />
                      <SteppedPercentInput label="Boulder Est %" value={form.est_boulder_pct} editable={canEdit} palette={palette} onChange={(v) => setPercentStep("est_boulder_pct", v)} />
                    </View>
                  ) : null}
                </View>

                <View pointerEvents="box-none" style={[styles.materialInlineGroup, { borderColor: palette.border, backgroundColor: palette.panel }]}>
                  <View style={styles.materialInlineHeader}>
                    <Text style={[styles.materialInlineTitle, { color: palette.text }]}>Rock Formation</Text>
                    <Chip
                      label={materialRockSelected ? "YES" : "NO"}
                      palette={palette}
                      active={materialRockSelected}
                      disabled={!canEdit}
                      onPress={() => toggleMaterialSection("material_rock")}
                    />
                  </View>
                  {materialRockSelected ? (
                    <View style={styles.materialInlineBody}>
                      <SteppedPercentInput
                      label="Rock Formation Est %"
                      value={form.est_rock_pct}
                      editable={canEdit}
                      palette={palette}
                      onChange={(v) => setPercentStep("est_rock_pct", v)}
                    />
                      <View style={styles.chips}>
                        {[["material_bedding", "Bedding"], ["material_joints", "Joint"], ["material_fractures", "Fracture"]].map(([key, label]) => (
                          <Chip
                            key={key}
                            label={label}
                            palette={palette}
                            active={form[key] === "YES"}
                            disabled={!canEdit}
                            onPress={() => selectRockSubtype(key as "material_bedding" | "material_joints" | "material_fractures")}
                          />
                        ))}
                      </View>
                    </View>
                  ) : null}
                </View>
              </View>
            </MaterialSubsection>
          ) : null}

          {activeMaterialSection === "pavement" ? (
            <MaterialSubsection title="Pavement" palette={palette}>
              <View style={styles.materialSectionBubbleRow}>
                <MaterialSectionBubble
                  label="Concrete"
                  active={form.material_pavement_type === "CONCRETE"}
                  onPress={() => canEdit && setVal("material_pavement_type", form.material_pavement_type === "CONCRETE" ? "" : "CONCRETE")}
                  palette={palette}
                />
                <MaterialSectionBubble
                  label="Asphalt"
                  active={form.material_pavement_type === "ASPHALT"}
                  onPress={() => canEdit && setVal("material_pavement_type", form.material_pavement_type === "ASPHALT" ? "" : "ASPHALT")}
                  palette={palette}
                />
              </View>
            </MaterialSubsection>
          ) : null}

          {activeMaterialSection === "debris" ? (
            <MaterialSubsection title="Landslide Debris" palette={palette}>
              <View pointerEvents="box-none" style={styles.materialInlineBody}>
                <SteppedPercentInput label="Clay/Silt Est %" value={form.est_debris_clay_silt_pct} editable={canEdit} palette={palette} onChange={(v) => setPercentStep("est_debris_clay_silt_pct", v)} />
                <SteppedPercentInput label="Sand Est %" value={form.est_debris_sand_pct} editable={canEdit} palette={palette} onChange={(v) => setPercentStep("est_debris_sand_pct", v)} />
                <SteppedPercentInput label="Gravel/Cobbles Est %" value={form.est_debris_gravel_pct} editable={canEdit} palette={palette} onChange={(v) => setPercentStep("est_debris_gravel_pct", v)} />
                <SteppedPercentInput label="Boulder Est %" value={form.est_debris_boulder_pct} editable={canEdit} palette={palette} onChange={(v) => setPercentStep("est_debris_boulder_pct", v)} />
              </View>
            </MaterialSubsection>
          ) : null}
          {renderTaggedSectionMedia("material")}
        </DropdownBlock>

        <DropdownBlock title="Pavement / Ground Status" open={openPaperBlocks.pavementGroundStatus} onToggle={() => togglePaperBlock("pavementGroundStatus")} palette={palette}>
          <PavementGroundAnnotator
            form={form}
            fieldErrors={fieldErrors}
            canEdit={canEdit}
            busy={busy}
            palette={palette}
            imageSource={pavementSectionPhoto ? previewSource(Number(pavementSectionPhoto.id)) : null}
            imageName={pavementSectionPhoto?.file_name ?? null}
            onUploadPhoto={() => {
              pickAndUploadAttachment("pavement_ground_status").catch(() => {});
            }}
            setVal={setVal}
          />
          {renderTaggedSectionMedia("pavement_ground_status", { hideUploadButton: true })}
        </DropdownBlock>

        <DropdownBlock title="Vegetation on Slope" open={openPaperBlocks.vegetation} onToggle={() => togglePaperBlock("vegetation")} palette={palette}>
          <Field palette={palette} label="Trees Coverage %" value={form.vegetation_trees} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("vegetation_trees", v)} />
          <Field palette={palette} label="Bushes/Shrubs Coverage %" value={form.vegetation_bushes_shrubs} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("vegetation_bushes_shrubs", v)} />
          <Field palette={palette} label="Groundcover Coverage %" value={form.vegetation_groundcover} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("vegetation_groundcover", v)} />
          {renderTaggedSectionMedia("vegetation_slope")}
        </DropdownBlock>

        <DropdownBlock title="Water / Drainage" open={openPaperBlocks.waterDrainage} onToggle={() => togglePaperBlock("waterDrainage")} palette={palette}>
          <View style={styles.chips}>
            {[["drainage_clogged_inlet", "Clogged Inlet"], ["drainage_compromised_drains", "Compromised Drains"], ["drainage_surface_runoff", "Surface Runoff"], ["drainage_torrent_surge_flood", "Torrent/Surge/Flood"]].map(([key, label]) => (
              <Chip key={key} label={label} palette={palette} active={form[key] === "YES"} disabled={!canEdit} onPress={() => selectSingleDrainage(key)} />
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
          {renderTaggedSectionMedia("water_drainage")}
        </DropdownBlock>

        <DropdownBlock title="Water Content" open={openPaperBlocks.waterContent} onToggle={() => togglePaperBlock("waterContent")} palette={palette}>
          <View style={styles.chips}>
            {[["water_dry", "Dry"], ["water_moist", "Moist"], ["water_wet", "Wet"]].map(([key, label]) => (
              <Chip key={key} label={label} palette={palette} active={form[key] === "YES"} disabled={!canEdit} onPress={() => selectBaseWaterContent(key)} />
            ))}
            <Chip
              key="water_flowing"
              label="Flowing"
              palette={palette}
              active={form.water_flowing === "YES"}
              disabled={!canEdit}
              onPress={() => selectBaseWaterContent("water_flowing")}
            />
          </View>
          {waterFlowingSelected ? (
            <View style={styles.chips}>
              {[["water_seep", "Seep"], ["water_spring", "Spring"]].map(([key, label]) => (
                <Chip key={key} label={label} palette={palette} active={form[key] === "YES"} disabled={!canEdit} onPress={() => selectFlowingSubtype(key as "water_seep" | "water_spring")} />
              ))}
            </View>
          ) : null}
          {renderTaggedSectionMedia("water_content")}
        </DropdownBlock>

        <DropdownBlock title="Measurements" open={openPaperBlocks.measurements} onToggle={() => togglePaperBlock("measurements")} palette={palette}>
            {(() => {
              const riCtx = (data?.gisa?.road_inventory_context ?? null) as GisaRoadInventoryContext | null;
              const riSnapshot = riCtx?.snapshot ?? null;
              const snap = riSnapshot as Record<string, unknown> | null;
              return (
                <>
                  <View style={[riInfoStyles.card, { borderColor: riCtx ? "#065f46" : palette.border, backgroundColor: palette.panelSoft }]}>
                    {riCtx ? (
                      <>
                        <Text style={[riInfoStyles.title, { color: "#34d399" }]}>Road inventory context active</Text>
                        {/* Primary fields with friendly labels */}
                        {snap?.county_code != null ? (
                          <View style={riInfoStyles.row}>
                            <Text style={[riInfoStyles.label, { color: palette.muted }]}>County:</Text>
                            <Text style={[riInfoStyles.value, { color: palette.text }]}>{String(snap.county_code)}</Text>
                          </View>
                        ) : null}
                        {snap?.route_name != null ? (
                          <View style={riInfoStyles.row}>
                            <Text style={[riInfoStyles.label, { color: palette.muted }]}>Route:</Text>
                            <Text style={[riInfoStyles.value, { color: palette.text }]}>{String(snap.route_name)}</Text>
                          </View>
                        ) : null}
                        {(snap?.begin_pm != null || snap?.end_pm != null) ? (
                          <View style={riInfoStyles.row}>
                            <Text style={[riInfoStyles.label, { color: palette.muted }]}>Postmile range:</Text>
                            <Text style={[riInfoStyles.value, { color: palette.text }]}>{String(snap?.begin_pm ?? "?")} – {String(snap?.end_pm ?? "?")} mi</Text>
                          </View>
                        ) : null}
                        {/* Terrain — friendly label from glossary */}
                        {(snap?.terrain_code != null || snap?.THY_TERRAIN_CODE != null) ? (
                          <View style={riInfoStyles.row}>
                            <Text style={[riInfoStyles.label, { color: palette.muted }]}>Terrain:</Text>
                            <Text style={[riInfoStyles.value, { color: palette.text }]}>
                              {terrainLabel(String(snap?.terrain_code ?? snap?.THY_TERRAIN_CODE))}
                            </Text>
                          </View>
                        ) : null}
                        {/* Lane counts */}
                        {(snap?.left_lanes != null || snap?.right_lanes != null) ? (
                          <View style={riInfoStyles.row}>
                            <Text style={[riInfoStyles.label, { color: palette.muted }]}>Lanes:</Text>
                            <Text style={[riInfoStyles.value, { color: palette.text }]}>
                              {snap?.left_lanes != null ? `${snap.left_lanes} LT` : "? LT"}{" / "}{snap?.right_lanes != null ? `${snap.right_lanes} RT` : "? RT"}
                            </Text>
                          </View>
                        ) : null}
                        <View style={riInfoStyles.row}>
                          <Text style={[riInfoStyles.label, { color: palette.muted }]}>Match method:</Text>
                          <Text style={[riInfoStyles.value, { color: palette.text }]}>{riCtx.match_method ?? "—"}</Text>
                        </View>
                        {/* Expandable raw details */}
                        <Pressable
                          onPress={() => setRiDetailsOpen((v) => !v)}
                          style={{ marginTop: 4 }}
                          accessibilityRole="button"
                          accessibilityLabel={riDetailsOpen ? "Hide road inventory details" : "Show road inventory details"}
                        >
                          <Text style={{ fontSize: 10, color: "#34d399", fontWeight: "600" }}>
                            {riDetailsOpen ? "▲ Hide field details" : "▼ Field meanings & raw values"}
                          </Text>
                        </Pressable>
                        {riDetailsOpen && snap ? (
                          <View style={{ marginTop: 6, gap: 3, borderTopWidth: 1, borderTopColor: "#1e3a2e", paddingTop: 6 }}>
                            <Text style={{ fontSize: 9, color: "#64748b", fontStyle: "italic", marginBottom: 2 }}>
                              Road inventory values from the CA Highways (HICOMP) dataset. Dataset v{riCtx.dataset_version_id}, segment {riCtx.segment_id}.
                            </Text>
                            {Object.entries(snap).map(([key, val]) => {
                              const ex = explainRoadInventoryField(key, val);
                              return (
                                <View key={key} style={{ gap: 0 }}>
                                  <View style={riInfoStyles.row}>
                                    <Text style={[riInfoStyles.label, { color: palette.muted, fontSize: 10, minWidth: 90 }]}>{ex.label}:</Text>
                                    <Text style={[riInfoStyles.value, { color: palette.text, fontSize: 10 }]}>{ex.displayValue}</Text>
                                  </View>
                                  {ex.description ? (
                                    <Text style={{ fontSize: 8, color: "#475569", marginLeft: 96, marginTop: -1, fontStyle: "italic" }}>{ex.description}</Text>
                                  ) : null}
                                </View>
                              );
                            })}
                          </View>
                        ) : null}
                        <Text style={{ fontSize: 9, color: "#34d399", marginTop: 4, fontStyle: "italic" }}>
                          Road inventory values from the published CA Highways dataset.
                        </Text>
                      </>
                    ) : (
                      <Text style={[riInfoStyles.title, { color: palette.muted }]}>No road inventory context attached. Diagram uses form / default roadway assumptions.</Text>
                    )}
                  </View>
                  <Text style={{ fontSize: 10, color: riCtx ? "#34d399" : palette.muted, marginTop: 4, marginBottom: 2 }}>
                    Diagram source: {riCtx ? "Road inventory snapshot" : "Form / default assumptions"}
                  </Text>
                  <MeasurementDiagramRenderer
                    formValues={form}
                    roadInventorySnapshot={riSnapshot}
                    elevationProfile={data?.gisa?.elevation_profile ?? null}
                  />
                </>
              );
            })()}
            <Field palette={palette} label="Slope Height, ft (H)" value={form.measure_slope_height_ft} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("measure_slope_height_ft", v)} />
            <Field palette={palette} label="Original Slope, deg (α)" value={form.measure_original_slope_deg} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("measure_original_slope_deg", v)} />
            <Field palette={palette} label="Landslide Width, ft (Wd)" value={form.measure_landslide_width_ft} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("measure_landslide_width_ft", v)} />
            <Field palette={palette} label="Landslide Length, ft (Ld)" value={form.measure_landslide_length_ft} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("measure_landslide_length_ft", v)} />
            <Field palette={palette} label="Main Scarp Height, ft (Hs)" value={form.measure_main_scarp_height_ft} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("measure_main_scarp_height_ft", v)} />
            <Field palette={palette} label="Landslide Slope, deg (β)" value={form.measure_landslide_slope_deg} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("measure_landslide_slope_deg", v)} />
            <Field palette={palette} label="Length of Roadway Encroached, ft (Lr)" value={form.measure_roadway_length_ft} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("measure_roadway_length_ft", v)} />
            <Field palette={palette} label="Width of Roadway Encroached, ft (Wr)" value={form.measure_roadway_width_ft} editable={canEdit} keyboardType="decimal-pad" onChangeText={(v) => setVal("measure_roadway_width_ft", v)} />
            {renderTaggedSectionMedia("measurements")}
          </DropdownBlock>
        <View style={styles.stepNavRow}>
          <Pressable style={[styles.btnGhost, styles.stepNavGhostBtn, styles.stepNavBtn, { borderColor: palette.border, backgroundColor: palette.panelSoft }]} onPress={goPrevStep}>
            <Text style={[styles.btnGhostText, { color: palette.text }]}>Previous</Text>
          </Pressable>
          <Pressable style={[styles.btnPrimary, styles.stepNavBtn, { backgroundColor: palette.primary }]} onPress={goNextStep}>
            <Text style={styles.btnPrimaryText}>Continue</Text>
          </Pressable>
        </View>
        </View>
      </View>

      <View style={activeStep === 2 ? undefined : styles.hidden}>
      <View style={styles.stepSectionStack}>
      {MEMO_SECTIONS.map((item) => (
        <DropdownBlock
          key={item.key}
          title={item.label}
          open={selectedSectionKey === item.key}
          onToggle={() => toggleAssessmentSection(item.key)}
          palette={palette}
        >
          <Field
            palette={palette}
            label={`${item.label} Notes`}
            value={form[item.field]}
            editable={canEdit}
            multiline
            onChangeText={(v) => setVal(item.field as keyof FormState, v)}
            error={fieldErrors[item.field as keyof FormState]}
            {...figureCitationFieldProps}
          />
          {renderTaggedSectionMedia(item.key)}
        </DropdownBlock>
      ))}
      <DropdownBlock
        title="Sketchpad"
        open={selectedSectionKey === "sketchpad"}
        onToggle={() => toggleAssessmentSection("sketchpad")}
        palette={palette}
      >
        <Field
          palette={palette}
          label="Sketchpad Notes"
          value={form.sketchpad_notes}
          editable={canEdit}
          multiline
          onChangeText={(v) => setVal("sketchpad_notes", v)}
          {...figureCitationFieldProps}
        />
        {renderTaggedSectionMedia("sketchpad")}
      </DropdownBlock>

      <View style={styles.stepNavRow}>
        <Pressable style={[styles.btnGhost, styles.stepNavGhostBtn, styles.stepNavBtn, { borderColor: palette.border, backgroundColor: palette.panelSoft }]} onPress={goPrevStep}>
          <Text style={[styles.btnGhostText, { color: palette.text }]}>Previous</Text>
        </Pressable>
        <Pressable style={[styles.btnPrimary, styles.stepNavBtn, { backgroundColor: palette.primary }]} onPress={goNextStep}>
          <Text style={styles.btnPrimaryText}>Continue</Text>
        </Pressable>
      </View>
      </View>
      </View>

      <View style={activeStep === 3 ? undefined : styles.hidden}>
      <View style={styles.stepSectionStack}>
      <View style={[styles.section, { backgroundColor: palette.panel, borderColor: palette.border, padding: compact ? 10 : 12 }]}>
        <Text style={styles.sectionTitle}>Immediate Actions</Text>
        <SelectField
          palette={palette}
          label="Immediate Actions"
          value={selectedImmediateLabel}
          placeholder="Select immediate actions"
          editable={canEdit}
          onPress={() => setImmediateActionsPickerOpen(true)}
        />
        {openHighwayTrafficSelected ? (
          <Field
            palette={palette}
            label="Open Highway Traffic Lanes"
            value={form.open_highway_traffic_lanes_count}
            editable={canEdit}
            keyboardType="number-pad"
            onChangeText={(v) => setVal("open_highway_traffic_lanes_count", v)}
            error={fieldErrors.open_highway_traffic_lanes_count}
          />
        ) : null}
        {immediateActions.length > 0 ? (
          <>
            <Field
              palette={palette}
              label="Emergency Justification Message"
              value={notifyMessage}
              editable={canEdit && !isLocalId}
              multiline
              onChangeText={setNotifyMessage}
              {...figureCitationFieldProps}
            />
            <Pressable
              style={[styles.btnPrimary, { backgroundColor: palette.primary, marginTop: 8, opacity: canNotifyCoordinatorNow ? 1 : 0.65 }]}
              onPress={notifyCoordinatorNow}
              disabled={busy || !canNotifyCoordinatorNow}
            >
              <Text style={styles.btnPrimaryText}>{busy ? "Working..." : "Notify Coordinator"}</Text>
            </Pressable>
            {!canNotifyCoordinatorNow ? (
              <Text style={[styles.muted, { marginTop: 8, color: palette.muted }]}>
                Save draft with required location fields to notify the coordinator.
              </Text>
            ) : null}
          </>
        ) : null}
      </View>
      <View style={[styles.section, { backgroundColor: palette.panel, borderColor: palette.border, padding: compact ? 10 : 12 }]}>
        <Text style={styles.sectionTitle}>Follow-up Actions</Text>
        <SelectField
          palette={palette}
          label="Follow-up Actions"
          value={selectedFollowUpLabel}
          placeholder="Select follow-up actions"
          editable={canEdit}
          onPress={() => setFollowUpActionsPickerOpen(true)}
        />
      </View>
      <View style={styles.stepNavRow}>
        <Pressable style={[styles.btnGhost, styles.stepNavGhostBtn, styles.stepNavBtn, { borderColor: palette.border, backgroundColor: palette.panelSoft }]} onPress={goPrevStep}>
          <Text style={[styles.btnGhostText, { color: palette.text }]}>Previous</Text>
        </Pressable>
        <Pressable style={[styles.btnPrimary, styles.stepNavBtn, { backgroundColor: palette.primary }]} onPress={goNextStep}>
          <Text style={styles.btnPrimaryText}>Continue</Text>
        </Pressable>
      </View>
      </View>
      </View>

      {activeStep === 4 && canEdit && (
          <View style={[styles.section, { backgroundColor: palette.panel, borderColor: palette.border, padding: compact ? 10 : 12 }]}>
            <Text style={styles.sectionTitle}>Submission</Text>
          <Pressable style={[styles.btnPrimary, { backgroundColor: palette.success, marginTop: 8 }]} onPress={submitDraft} disabled={busy}><Text style={styles.btnPrimaryText}>{busy ? "Working..." : (data.submission.status === "REJECTED" ? "Resubmit for Review" : "Submit for Review")}</Text></Pressable>
          <Pressable style={[styles.btnGhost, { marginTop: 8, borderColor: palette.border, backgroundColor: palette.panelSoft }]} onPress={pickPhoto} disabled={busy}><Text style={[styles.btnGhostText, { color: palette.text }]}>{busy ? "Working..." : "Upload Media / File"}</Text></Pressable>
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
                    onError={() => handleAttachmentPreviewError(latestPhoto.id)}
                  />
                </Pressable>
              ) : (
                <View>
                  <Text style={[styles.muted, { color: palette.muted }]}>In-app preview failed.</Text>
                  {!!(photoUrls[latestPhoto.id] || localAttachmentUris[latestPhoto.id]) && (
                    <Pressable style={[styles.btnGhost, { marginTop: 8, borderColor: palette.border, backgroundColor: palette.panelSoft }]} onPress={() => openPhotoFallback(latestPhoto.id)}>
                      <Text style={[styles.btnGhostText, { color: palette.text }]}>Open Photo</Text>
                    </Pressable>
                  )}
                </View>
              )}
            </View>
          )}
        </View>
      )}

      {activeStep === 3 && canReview && (
        <View style={[styles.section, { backgroundColor: palette.panel, borderColor: palette.border, padding: compact ? 10 : 12 }]}>
          <Text style={styles.sectionTitle}>Reviewer Decision</Text>
          <Field palette={palette} label="Review Comment" value={reviewComment} editable={!busy} multiline onChangeText={setReviewComment} {...figureCitationFieldProps} />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable style={[styles.btnPrimary, { flex: 1, backgroundColor: palette.success }]} onPress={() => review("APPROVE")} disabled={busy}><Text style={styles.btnPrimaryText}>{busy ? "Working..." : "Approve"}</Text></Pressable>
            <Pressable style={[styles.btnPrimary, { flex: 1, backgroundColor: palette.danger }]} onPress={() => review("REJECT")} disabled={busy}><Text style={styles.btnPrimaryText}>{busy ? "Working..." : "Reject"}</Text></Pressable>
          </View>
        </View>
      )}

      <View style={[styles.section, activeStep === 4 ? null : styles.hidden, { backgroundColor: palette.panel, borderColor: palette.border, padding: compact ? 10 : 12 }]}>
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

      <View style={[styles.section, activeStep === 4 ? null : styles.hidden, { backgroundColor: palette.panel, borderColor: palette.border, padding: compact ? 10 : 12 }]}>
        <Text style={styles.sectionTitle}>Gallery</Text>
        {galleryImages.length === 0 ? (
          <Text style={[styles.muted, { color: palette.muted }]}>No photos uploaded yet.</Text>
        ) : (
          <View style={styles.galleryGrid}>
            {galleryRows.map((row, rowIndex) => (
              <View key={`gallery-row-${rowIndex}`} style={[styles.galleryRow, rowIndex ? { marginTop: galleryGap } : null]}>
                {row.map((file, columnIndex) => {
                  const previewFailed = !!failedPreviewIds[file.id];
                  return (
                    <ScrollSafePressable
                      key={`gallery-image-${file.id}`}
                      style={[styles.galleryTile, columnIndex ? { marginLeft: galleryGap } : null]}
                      onPress={() => {
                        if (previewFailed) {
                          openPhotoFallback(file.id).catch(() => {});
                          return;
                        }
                        openFullscreen(file.id, file.file_name);
                      }}
                    >
                      <View style={[styles.galleryImageWrap, { backgroundColor: palette.panelSoft }]}>
                        {!previewFailed ? (
                          <Image
                            source={previewSource(file.id)}
                            style={styles.galleryImage}
                            resizeMode="cover"
                            onError={() => handleAttachmentPreviewError(file.id)}
                          />
                        ) : (
                          <View style={styles.galleryFallback}>
                            <Text style={styles.galleryFallbackText}>Tap to open</Text>
                          </View>
                        )}
                        <View style={styles.galleryFigureBadge}>
                          <Text style={styles.galleryFigureText} numberOfLines={1}>{file.figureLabel}</Text>
                        </View>
                        <View style={styles.gallerySourceBadge}>
                          <Text style={styles.gallerySourceText} numberOfLines={1}>{file.sourceLabel}</Text>
                        </View>
                      </View>
                      <Text style={[styles.galleryCaption, { color: palette.muted }]} numberOfLines={1}>
                        {file.file_name}
                      </Text>
                    </ScrollSafePressable>
                  );
                })}
                {row.length < galleryColumns
                  ? Array.from({ length: galleryColumns - row.length }, (_, fillerIndex) => (
                      <View
                        key={`gallery-row-${rowIndex}-filler-${fillerIndex}`}
                        style={[styles.galleryTile, styles.galleryTileFiller, { marginLeft: galleryGap }]}
                      />
                    ))
                  : null}
              </View>
            ))}
          </View>
        )}
      </View>

      <View style={[styles.section, styles.hidden, { backgroundColor: palette.panel, borderColor: palette.border, padding: compact ? 10 : 12 }]}>
        <Text style={styles.sectionTitle}>Section Media</Text>
        {sectionAttachments.length === 0 ? <Text style={styles.muted}>No section-tagged files uploaded.</Text> : sectionAttachments.map((file: any) => (
          <Pressable key={`gallery-attach-${file.id}`} style={styles.sectionAttachmentRow} onPress={() => openPhotoFallback(file.id)}>
            <Text style={{ fontWeight: "600", color: palette.text }}>{file.file_name}</Text>
            <Text style={[styles.muted, { color: palette.muted }]}>{`${file.kind || "DOC"}${file.section_key ? ` • ${file.section_key}` : ""}`}</Text>
          </Pressable>
        ))}
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

    <Modal visible={lanesClosedPickerOpen} transparent animationType="fade" onRequestClose={() => setLanesClosedPickerOpen(false)}>
      <Pressable style={styles.pickerBackdrop} onPress={() => setLanesClosedPickerOpen(false)}>
        <Pressable style={[styles.pickerSheet, { backgroundColor: palette.panel, borderColor: palette.border }]}>
          <Text style={[styles.pickerTitle, { color: palette.text }]}>Lane(s) Closed Count</Text>
          <ScrollView style={{ maxHeight: 340 }}>
            {Array.from({ length: 4 }, (_, idx) => String(idx + 1)).map((count) => (
              <Pressable
                key={count}
                style={[styles.pickerItem, form.lanes_closed_count === count ? { backgroundColor: palette.panelSoft } : null]}
                onPress={() => {
                  setVal("lanes_closed_count", count);
                  setLanesClosedPickerOpen(false);
                }}
              >
                <Text style={{ color: palette.text, fontWeight: "600" }}>{count}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>

    <Modal visible={immediateActionsPickerOpen} transparent animationType="fade" onRequestClose={() => setImmediateActionsPickerOpen(false)}>
      <Pressable style={styles.pickerBackdrop} onPress={() => setImmediateActionsPickerOpen(false)}>
        <Pressable style={[styles.pickerSheet, { backgroundColor: palette.panel, borderColor: palette.border }]}>
          <Text style={[styles.pickerTitle, { color: palette.text }]}>Immediate Actions</Text>
          <ScrollView style={{ maxHeight: 340 }}>
            {immediateActionOptions.map((item) => {
              const checked = immediateActions.includes(item.code);
              return (
                <Pressable
                  key={item.code}
                  style={[styles.actionOptionRow, { borderColor: palette.border, backgroundColor: checked ? palette.panelSoft : palette.panel }]}
                  onPress={() => toggleActionByGroup(item.code, "IMMEDIATE")}
                >
                  <View style={[styles.actionCheck, { borderColor: palette.border, backgroundColor: checked ? palette.primary : palette.panel }]} />
                  <Text style={{ color: palette.text, flex: 1 }}>{item.label}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
          <Pressable style={[styles.btnPrimary, { backgroundColor: palette.primary, marginTop: 8 }]} onPress={() => setImmediateActionsPickerOpen(false)}>
            <Text style={styles.btnPrimaryText}>Done</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>

    <Modal visible={followUpActionsPickerOpen} transparent animationType="fade" onRequestClose={() => setFollowUpActionsPickerOpen(false)}>
      <Pressable style={styles.pickerBackdrop} onPress={() => setFollowUpActionsPickerOpen(false)}>
        <Pressable style={[styles.pickerSheet, { backgroundColor: palette.panel, borderColor: palette.border }]}>
          <Text style={[styles.pickerTitle, { color: palette.text }]}>Follow-up Actions</Text>
          <ScrollView style={{ maxHeight: 340 }}>
            {followUpActionOptions.map((item) => {
              const checked = followUpActions.includes(item.code);
              return (
                <Pressable
                  key={item.code}
                  style={[styles.actionOptionRow, { borderColor: palette.border, backgroundColor: checked ? palette.panelSoft : palette.panel }]}
                  onPress={() => toggleActionByGroup(item.code, "FOLLOW_UP")}
                >
                  <View style={[styles.actionCheck, { borderColor: palette.border, backgroundColor: checked ? palette.primary : palette.panel }]} />
                  <Text style={{ color: palette.text, flex: 1 }}>{item.label}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
          <Pressable style={[styles.btnPrimary, { backgroundColor: palette.primary, marginTop: 8 }]} onPress={() => setFollowUpActionsPickerOpen(false)}>
            <Text style={styles.btnPrimaryText}>Done</Text>
          </Pressable>
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
    <FigureCitationPicker
      visible={!!figureCitationRequest}
      request={figureCitationRequest}
      galleryImages={galleryImages}
      palette={palette}
      failedPreviewIds={failedPreviewIds}
      previewSource={previewSource}
      onPreviewError={handleAttachmentPreviewError}
      onClose={() => setFigureCitationRequest(null)}
    />
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
                source={
                  fullscreenPhoto.isLocal
                    ? { uri: fullscreenPhoto.uri }
                    : { uri: fullscreenPhoto.uri, headers: { Authorization: `Bearer ${token}` } }
                }
                style={styles.fullscreenImage}
                resizeMode="contain"
              />
              <Text style={styles.fullscreenCaption}>{fullscreenPhoto.name}</Text>
              <Pressable style={styles.fullscreenEditBtn} onPress={openFullscreenInDeviceEditor}>
                <Text style={styles.fullscreenEditText}>Open in Device Editor</Text>
              </Pressable>
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
  contentWrap: { padding: 14, gap: 10, paddingBottom: Platform.OS === "ios" ? 26 : 20 },
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
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
  chip: { borderWidth: 1, borderColor: "#c8d5ea", borderRadius: 999, paddingVertical: 6, paddingHorizontal: 10, backgroundColor: "#f9fbff" },
  chipInner: { flexDirection: "row", alignItems: "center", gap: 6 },
  chipIconWrap: { width: 18, height: 18, alignItems: "center", justifyContent: "center" },
  distributionIcon: { width: 18, height: 18 },
  chipOn: { backgroundColor: "#dbeafe", borderColor: "#1d4ed8" },
  chipText: { color: "#334155", fontSize: 12, fontWeight: "700" },
  chipTextOn: { color: "#1d4ed8" },
  btnPrimary: { backgroundColor: "#1d4ed8", borderRadius: Platform.OS === "ios" ? 12 : 8, paddingVertical: Platform.OS === "ios" ? 12 : 10, alignItems: "center" },
  btnPrimaryText: { color: "#fff", fontWeight: "700" },
  btnGhost: { borderWidth: Platform.OS === "ios" ? StyleSheet.hairlineWidth : 1, borderColor: "#c8d5ea", borderRadius: Platform.OS === "ios" ? 12 : 8, paddingVertical: Platform.OS === "ios" ? 12 : 10, alignItems: "center", backgroundColor: "#f8fbff", marginTop: 8 },
  btnGhostText: { color: "#1f2937", fontWeight: "700" },
  sectionAttachmentActions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  sectionAttachmentActionBtn: { flexGrow: 1, flexShrink: 1, minWidth: 150 },
  mapPreviewCard: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    gap: 4,
  },
  measurementDiagramWrap: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
  },
  measurementDiagram: {
    width: "100%",
    height: 220,
  },
  locationMapPreview: {
    width: "100%",
    height: 180,
    borderRadius: 8,
    backgroundColor: "#dbe7f8",
    marginTop: 4,
    marginBottom: 4,
  },
  locationCoordinateRow: {
    flexDirection: "row",
    gap: 8,
  },
  locationCoordinateField: {
    flex: 1,
    minWidth: 0,
  },
  locationActionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 8,
  },
  locationActionButton: {
    flex: 1,
    minWidth: 150,
    marginTop: 0,
  },
  muted: { color: "#6f809d" },
  photoPreviewCompact: { width: "100%", height: 160, borderRadius: 8, backgroundColor: "#e5e7eb" },
  photo: { width: "100%", height: 220, borderRadius: 8, backgroundColor: "#e5e7eb" },
  galleryGrid: {
    marginTop: 8,
  },
  galleryRow: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  galleryTile: {
    flex: 1,
    minWidth: 0,
  },
  galleryTileFiller: {
    opacity: 0,
  },
  galleryImageWrap: {
    position: "relative",
    overflow: "hidden",
    borderRadius: 8,
    aspectRatio: 1,
  },
  galleryImage: {
    width: "100%",
    height: "100%",
  },
  galleryFallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(15,23,42,0.12)",
  },
  galleryFallbackText: {
    color: "#334155",
    fontSize: 11,
    fontWeight: "800",
  },
  galleryFigureBadge: {
    position: "absolute",
    left: 5,
    top: 5,
    maxWidth: "84%",
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 3,
    backgroundColor: "rgba(15,23,42,0.78)",
  },
  galleryFigureText: {
    color: "#fff",
    fontSize: 9,
    fontWeight: "900",
  },
  gallerySourceBadge: {
    position: "absolute",
    left: 5,
    right: 5,
    bottom: 5,
    borderRadius: 7,
    paddingHorizontal: 6,
    paddingVertical: 4,
    backgroundColor: "rgba(15,23,42,0.72)",
  },
  gallerySourceText: {
    color: "#fff",
    fontSize: 9,
    fontWeight: "800",
  },
  galleryCaption: {
    marginTop: 4,
    fontSize: 11,
    fontWeight: "600",
  },
  figureCitationChipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 6,
  },
  figureCitationChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  figureCitationChipText: {
    fontSize: 11,
    fontWeight: "800",
  },
  figurePickerBackdrop: {
    flex: 1,
    backgroundColor: "rgba(15,23,42,0.42)",
    justifyContent: "flex-end",
  },
  figurePickerPanel: {
    maxHeight: "82%",
    borderTopWidth: 1,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: Platform.OS === "ios" ? 24 : 16,
  },
  figurePickerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  figurePickerHeaderCopy: {
    flex: 1,
  },
  figurePickerTitle: {
    fontSize: 18,
    fontWeight: "900",
  },
  figurePickerSubtitle: {
    marginTop: 2,
    fontSize: 12,
    fontWeight: "700",
  },
  figurePickerClose: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  figurePickerCloseText: {
    fontSize: 12,
    fontWeight: "800",
  },
  figurePickerEmpty: {
    marginTop: 12,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 18,
  },
  figurePickerEmptyText: {
    fontSize: 13,
    lineHeight: 19,
    fontWeight: "700",
  },
  figurePickerScroll: {
    marginTop: 10,
  },
  figurePickerScrollContent: {
    paddingBottom: 12,
  },
  figurePickerSection: {
    marginTop: 12,
  },
  figurePickerSectionTitle: {
    fontSize: 14,
    fontWeight: "900",
    marginBottom: 8,
  },
  figurePickerGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  figurePickerTile: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 6,
  },
  figurePickerImageWrap: {
    position: "relative",
    aspectRatio: 1,
    borderRadius: 9,
    overflow: "hidden",
  },
  figurePickerImage: {
    width: "100%",
    height: "100%",
  },
  figurePickerFallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(15,23,42,0.12)",
  },
  figurePickerFallbackText: {
    color: "#334155",
    fontSize: 11,
    fontWeight: "900",
  },
  figurePickerBadge: {
    position: "absolute",
    left: 5,
    top: 5,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 3,
    backgroundColor: "rgba(15,23,42,0.78)",
  },
  figurePickerBadgeText: {
    color: "#fff",
    fontSize: 9,
    fontWeight: "900",
  },
  figurePickerFileName: {
    marginTop: 5,
    fontSize: 10,
    fontWeight: "700",
  },
  eventRow: { borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 8, padding: 8, gap: 2, marginTop: 8 },
  sectionAttachmentRow: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: "#d6e0ef",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  annotationCard: {
    marginTop: 6,
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
  },
  annotationIntro: {
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 20,
  },
  annotationSubtle: {
    marginTop: 6,
    fontSize: 12,
    lineHeight: 18,
  },
  annotationToolbar: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 10,
  },
  annotationToolbarButton: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 150,
    marginTop: 0,
  },
  annotationCanvasShell: {
    marginTop: 10,
    borderWidth: 1,
    borderRadius: 12,
    overflow: "hidden",
  },
  annotationCanvas: {
    width: "100%",
    minHeight: 240,
    position: "relative",
    backgroundColor: "#d7e3f5",
  },
  annotationEmptyState: {
    marginTop: 10,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 18,
    gap: 6,
  },
  annotationEmptyTitle: {
    fontSize: 15,
    fontWeight: "800",
  },
  annotationPreviewShell: {
    marginTop: 10,
    borderWidth: 1,
    borderRadius: 16,
    overflow: "hidden",
    position: "relative",
  },
  annotationPreviewImage: {
    width: "100%",
    height: 220,
    backgroundColor: "#d7e3f5",
  },
  annotationPreviewOverlay: {
    position: "absolute",
    right: 12,
    bottom: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    backgroundColor: "rgba(9,19,33,0.76)",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
  },
  annotationPreviewOverlayText: {
    color: "#f8fbff",
    fontSize: 12,
    fontWeight: "800",
  },
  annotationTag: {
    position: "absolute",
    borderWidth: 1,
    borderRadius: 12,
    minWidth: 110,
    maxWidth: 164,
    shadowColor: "#0f172a",
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  annotationTagPressable: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  annotationTagTitle: {
    fontSize: 12,
    fontWeight: "800",
  },
  annotationTagSummary: {
    marginTop: 2,
    fontSize: 11,
    fontWeight: "600",
  },
  annotationSummaryList: {
    marginTop: 12,
    gap: 8,
  },
  annotationSummaryRow: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  annotationSummaryDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  annotationSummaryTitle: {
    fontSize: 14,
    fontWeight: "800",
  },
  annotationSummaryText: {
    marginTop: 2,
    fontSize: 12,
    lineHeight: 17,
  },
  annotationSummaryAction: {
    fontSize: 12,
    fontWeight: "800",
  },
  annotationEditorScreen: {
    flex: 1,
    position: "relative",
  },
  annotationEditorTopBar: {
    position: "absolute",
    top: Platform.OS === "ios" ? 10 : 8,
    left: 10,
    right: 10,
    zIndex: 5,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingTop: Platform.OS === "ios" ? 44 : 8,
    paddingHorizontal: 8,
    paddingBottom: 0,
  },
  annotationEditorTitle: {
    color: "#f8fbff",
    fontSize: 18,
    fontWeight: "800",
    flexShrink: 1,
  },
  annotationEditorSubtitle: {
    color: "#c2d1e6",
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
    maxWidth: 720,
  },
  annotationEditorCloseBtn: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    backgroundColor: "rgba(9,19,33,0.72)",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 9,
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  annotationEditorCloseText: {
    color: "#f8fbff",
    fontSize: 12,
    fontWeight: "800",
  },
  annotationEditorTopBarSpacer: {
    flex: 1,
    minWidth: 8,
  },
  annotationEditorHeaderActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexShrink: 0,
  },
  annotationEditorHeaderBtn: {
    flexShrink: 0,
  },
  annotationEditorDrawerToggleBtnActive: {
    backgroundColor: "rgba(78,132,255,0.22)",
    borderColor: "rgba(113,164,255,0.4)",
  },
  annotationEditorBody: {
    flex: 1,
    position: "relative",
    backgroundColor: "#050d18",
    overflow: "hidden",
  },
  annotationEditorCanvasArea: {
    flex: 1,
    paddingHorizontal: 0,
    paddingVertical: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  annotationEditorStage: {
    position: "relative",
    overflow: "hidden",
    maxWidth: "100%",
    maxHeight: "100%",
    borderRadius: 0,
    borderWidth: 0,
    backgroundColor: "#10253f",
  },
  annotationEditorEmpty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    gap: 10,
  },
  annotationEditorEmptyTitle: {
    color: "#f8fbff",
    fontSize: 18,
    fontWeight: "800",
    textAlign: "center",
  },
  annotationEditorEmptyText: {
    color: "#c2d1e6",
    fontSize: 13,
    lineHeight: 20,
    textAlign: "center",
    maxWidth: 420,
  },
  annotationDragGhost: {
    position: "absolute",
    borderWidth: 1,
    borderColor: "#d7e3f5",
    backgroundColor: "rgba(248,250,252,0.96)",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    shadowColor: "#0f172a",
    shadowOpacity: 0.16,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 4,
  },
  annotationDragGhostText: {
    color: "#0f172a",
    fontSize: 12,
    fontWeight: "800",
  },
  annotationEditorDrawer: {
    position: "absolute",
    top: 12,
    right: 0,
    bottom: 12,
    borderWidth: 1,
    borderLeftWidth: 1,
    borderTopLeftRadius: 22,
    borderBottomLeftRadius: 22,
    paddingHorizontal: 14,
    paddingVertical: 16,
    shadowColor: "#020817",
    shadowOpacity: 0.28,
    shadowRadius: 18,
    shadowOffset: { width: -8, height: 0 },
    elevation: 14,
  },
  annotationEditorDrawerTitle: {
    fontSize: 18,
    fontWeight: "800",
  },
  annotationEditorDrawerHelp: {
    marginTop: 4,
    fontSize: 12,
    lineHeight: 18,
  },
  annotationEditorDrawerScroll: {
    flex: 1,
    marginTop: 12,
  },
  annotationEditorDrawerScrollContent: {
    paddingBottom: 28,
  },
  annotationDrawerToken: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginBottom: 10,
  },
  annotationDrawerTokenHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  annotationDrawerTokenTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: "800",
  },
  annotationDrawerTokenStatus: {
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
  },
  annotationDrawerTokenSummary: {
    marginTop: 5,
    fontSize: 12,
    lineHeight: 17,
  },
  annotationDrawerTokenHint: {
    marginTop: 6,
    fontSize: 11,
    lineHeight: 16,
  },
  annotationMarker: {
    position: "absolute",
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#0f172a",
    shadowOpacity: 0.22,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  annotationMarkerText: {
    fontSize: 12,
    fontWeight: "900",
  },
  annotationMarkerRangeEnd: {
    backgroundColor: "rgba(248,251,255,0.8)",
  },
  annotationMarkerRangeEndDot: {
    width: 10,
    height: 10,
    borderRadius: 999,
  },
  annotationEditorDetailPanel: {
    marginTop: 6,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  annotationDrawerEmptyText: {
    fontSize: 12,
    lineHeight: 18,
  },
  annotationFieldTitle: {
    marginBottom: 6,
  },
  annotationFieldLabel: {
    fontSize: 12,
    fontWeight: "700",
  },
  annotationModalHint: {
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 4,
  },
  annotationRangeHint: {
    marginTop: 10,
    fontSize: 12,
    lineHeight: 18,
  },
  annotationDetailActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 12,
  },
  annotationDetailActionBtn: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 132,
    marginTop: 0,
  },
  annotationRangeLine: {
    position: "absolute",
    height: 2,
  },
  annotationRangeCap: {
    position: "absolute",
    left: 0,
    top: -6,
    width: 2,
    height: 14,
    borderRadius: 999,
  },
  annotationRangeCapEnd: {
    right: 0,
  },
  annotationCanvasPopover: {
    position: "absolute",
    maxHeight: 260,
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 6,
    shadowColor: "#020817",
    shadowOpacity: 0.28,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  annotationCanvasPopoverLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 6,
  },
  annotationCanvasPopoverArrow: {
    position: "absolute",
    top: 18,
    width: 0,
    height: 0,
    borderTopWidth: 10,
    borderBottomWidth: 10,
    borderTopColor: "transparent",
    borderBottomColor: "transparent",
  },
  annotationCanvasPopoverArrowRight: {
    left: -12,
    borderRightWidth: 12,
    borderLeftWidth: 0,
    borderLeftColor: "transparent",
  },
  annotationCanvasPopoverArrowLeft: {
    right: -12,
    borderLeftWidth: 12,
    borderRightWidth: 0,
    borderRightColor: "transparent",
  },
  annotationCanvasPopoverScroll: {
    maxHeight: 248,
  },
  annotationCanvasPopoverScrollContent: {
    paddingHorizontal: 12,
    paddingBottom: 12,
  },
  annotationCanvasPopoverHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.1)",
  },
  annotationCanvasPopoverHeaderTitle: {
    color: "#f8fbff",
    fontSize: 15,
    fontWeight: "800",
    flex: 1,
    paddingRight: 8,
  },
  annotationCanvasPopoverCloseBtn: {
    width: 28,
    height: 28,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.16)",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  annotationCanvasPopoverCloseText: {
    color: "#f8fbff",
    fontSize: 12,
    fontWeight: "900",
  },
  materialSubsectionCard: {
    marginTop: 10,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  materialSectionBubbleRow: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: 8,
  },
  materialSectionBubble: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  materialSectionBubbleText: {
    fontWeight: "800",
    textAlign: "center",
  },
  materialSubsectionTitle: {
    fontSize: 15,
    fontWeight: "800",
  },
  materialSubsectionBody: {
    marginTop: 10,
  },
  materialToggleColumn: {
    gap: 10,
  },
  materialToggleRow: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  materialToggleCopy: {
    flex: 1,
  },
  materialToggleTitle: {
    fontSize: 14,
    fontWeight: "800",
  },
  materialToggleSubtitle: {
    marginTop: 2,
    fontSize: 12,
    lineHeight: 17,
  },
  materialSlopeStack: {
    gap: 10,
  },
  materialInlineGroup: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  materialInlineHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  materialInlineTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: "800",
  },
  materialInlineBody: {
    marginTop: 10,
  },
  materialPercentControl: {
    marginTop: 4,
  },
  materialPercentLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 6,
  },
  materialPercentValue: {
    fontSize: 13,
    fontWeight: "800",
  },
  materialPercentSliderRow: {
    gap: 6,
  },
  materialPercentTrackShell: {
    position: "relative",
    justifyContent: "center",
  },
  materialPercentTrackRail: {
    borderWidth: 1,
    borderRadius: 999,
    overflow: "hidden",
  },
  materialPercentTrackFill: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 999,
  },
  materialPercentTickRow: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 4,
  },
  materialPercentTickSlot: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  materialPercentTick: {
    width: 2,
    borderRadius: 999,
  },
  materialPercentThumbHitbox: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
  },
  materialPercentThumb: {
    borderWidth: 1,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#0f172a",
    shadowOpacity: 0.14,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  materialPercentThumbCore: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  materialPercentRangeRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  materialPercentRangeText: {
    fontSize: 11,
    fontWeight: "700",
  },
  hidden: { display: "none" },
  stepTabsRow: {
    flexDirection: "row",
    gap: 4,
    marginTop: 4,
  },
  stepTab: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 4,
    paddingVertical: 7,
    minWidth: 0,
    flex: 1,
    alignItems: "center",
  },
  stepTabActive: { backgroundColor: "#dbeafe" },
  stepTabInactive: { backgroundColor: "#f8fafc" },
  stepTabIndex: { fontSize: 11, fontWeight: "800" },
  stepTabLabel: { fontSize: 12, fontWeight: "700", marginTop: 2, textAlign: "center", lineHeight: 13 },
  stepNavRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 10,
    marginBottom: 4,
  },
  stepSectionStack: {
    gap: 10,
  },
  stepNavBtn: {
    flex: 1,
  },
  stepNavGhostBtn: {
    marginTop: 0,
  },
  stepNavSpacer: {
    flex: 1,
  },
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
    marginBottom: 0,
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
  actionOptionRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    marginBottom: 8,
    gap: 8,
  },
  actionCheck: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1,
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
  fullscreenEditBtn: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: "#93c5fd",
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: "rgba(15, 23, 42, 0.75)",
  },
  fullscreenEditText: {
    color: "#dbeafe",
    fontWeight: "700",
  },
});

const riInfoStyles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginTop: 8,
    marginBottom: 4,
    gap: 3,
  },
  title: {
    fontSize: 11,
    fontWeight: "700",
    marginBottom: 2,
  },
  row: {
    flexDirection: "row",
    gap: 6,
  },
  label: {
    fontSize: 11,
    fontWeight: "600",
    minWidth: 58,
  },
  value: {
    fontSize: 11,
    flex: 1,
  },
});



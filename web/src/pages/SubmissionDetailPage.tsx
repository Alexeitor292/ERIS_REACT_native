import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import type { GisaElevationProfile, GisaLookups, SubmissionDetail } from "../api/types";
import { friendlyFieldLabel, friendlyFieldValue, fieldDescription, terrainLabel } from "../utils/roadInventoryGlossary";
import AppShell from "../ui/AppShell";
import { useAuth } from "../auth/AuthContext";
import { getToken } from "../auth/token";
import { appConfig } from "../config";
import SubmissionArcGisMap from "../components/SubmissionArcGisMap";
import {
  convertCaliforniaStatePlaneFeetToLatLon,
  convertLatLonToCaliforniaStatePlaneFeet,
  formatCaliforniaStatePlaneFeet,
  getCaliforniaStatePlaneZone,
} from "../utils/californiaCoordinateSystem";
import { buildSubmissionDisplayTitle } from "../utils/submissionLabel";
import { CALIFORNIA_COUNTIES, CALTRANS_DISTRICTS, countiesForDistrict, countyNameFromNameOrCode, districtForCounty, routesForDistrictCounty } from "../utils/caltransLookups";
import { formatCoordinate, normalizeCoordinateValue, normalizePostMileInput, normalizePostMileValue, normalizeRouteInput, normalizeRouteValue } from "../utils/precision";

type Tri = "UNKNOWN" | "YES" | "NO";
type Draft = Record<string, string> & {
  pavement_ground_cracks: Tri;
  indented_by_rocks: Tri;
  failure_rock_fall: Tri;
  failure_topple: Tri;
  failure_slide: Tri;
  failure_spread: Tri;
  failure_flow: Tri;
  failure_compound: Tri;
  failure_erosion: Tri;
  failure_surficial_failure: Tri;
  failure_scoured_toe: Tri;
  failure_washout: Tri;
  distribution_advancing: Tri;
  distribution_retrogressive: Tri;
  distribution_enlarging: Tri;
  distribution_widening: Tri;
  distribution_moving: Tri;
  distribution_confined: Tri;
  material_rock: Tri;
  material_soil: Tri;
  material_bedding: Tri;
  material_joints: Tri;
  material_fractures: Tri;
  water_dry: Tri;
  water_moist: Tri;
  water_wet: Tri;
  water_flowing: Tri;
  water_seep: Tri;
  water_spring: Tri;
  drainage_clogged_inlet: Tri;
  drainage_compromised_drains: Tri;
  drainage_surface_runoff: Tri;
  drainage_torrent_surge_flood: Tri;
  impact_impacted_adj_utilities: Tri;
  impact_maybe_adj_utilities: Tri;
  impact_impacted_adj_properties: Tri;
  impact_maybe_adj_properties: Tri;
  impact_impacted_adj_structure: Tri;
  impact_maybe_adj_structure: Tri;
};
type SharedUser = { user_id: number; email: string; full_name: string; granted_by_user_id: number; created_at: string };
type AdminUser = { id: number; email: string; full_name: string; is_active: boolean; roles: string[] };
type DistrictContact = {
  id: string;
  first_name: string;
  last_name: string;
  s_number: string;
  phone: string;
  cell_phone: string;
};

const EMPTY: Draft = {
  report_date: "", district: "", county: "", route: "", post_mile: "", ea: "", project_id: "", date_incident_reported: "", district_contact: "",
  latitude: "", longitude: "", distribution_code: "", highway_status_cause: "", highway_status_code: "", lanes_closed_count: "", open_highway_traffic_lanes_count: "",
  crack_length_ft: "", crack_horizontal_in: "", crack_vertical_in: "", crack_depth_in: "", settlement_in: "", bulge_in: "",
  est_soil_pct: "", est_clay_pct: "", est_silt_pct: "", est_sand_pct: "", est_gravel_pct: "",
  vegetation_trees: "", vegetation_bushes_shrubs: "", vegetation_groundcover: "",
  impact_adj_utilities: "", impact_adj_properties: "", impact_adj_structure: "",
  measure_slope_height_ft: "", measure_original_slope_deg: "", measure_landslide_width_ft: "", measure_landslide_length_ft: "", measure_main_scarp_height_ft: "", measure_landslide_slope_deg: "", measure_roadway_length_ft: "", measure_roadway_width_ft: "",
  record_of_event_notes: "", maintenance_history_notes: "", geotechnical_assessment_notes: "", recommendations_notes: "", sketchpad_notes: "",
  observations_notes: "", geometry_json: "", pavement_ground_cracks: "UNKNOWN", indented_by_rocks: "UNKNOWN",
  failure_rock_fall: "UNKNOWN", failure_topple: "UNKNOWN", failure_slide: "UNKNOWN", failure_spread: "UNKNOWN", failure_flow: "UNKNOWN", failure_compound: "UNKNOWN", failure_erosion: "UNKNOWN", failure_surficial_failure: "UNKNOWN", failure_scoured_toe: "UNKNOWN", failure_washout: "UNKNOWN",
  incident_type_description: "",
  distribution_advancing: "UNKNOWN", distribution_retrogressive: "UNKNOWN", distribution_enlarging: "UNKNOWN", distribution_widening: "UNKNOWN", distribution_moving: "UNKNOWN", distribution_confined: "UNKNOWN",
  material_rock: "UNKNOWN", material_soil: "UNKNOWN", material_bedding: "UNKNOWN", material_joints: "UNKNOWN", material_fractures: "UNKNOWN",
  water_dry: "UNKNOWN", water_moist: "UNKNOWN", water_wet: "UNKNOWN", water_flowing: "UNKNOWN", water_seep: "UNKNOWN", water_spring: "UNKNOWN",
  drainage_clogged_inlet: "UNKNOWN", drainage_compromised_drains: "UNKNOWN", drainage_surface_runoff: "UNKNOWN", drainage_torrent_surge_flood: "UNKNOWN",
  impact_impacted_adj_utilities: "UNKNOWN", impact_maybe_adj_utilities: "UNKNOWN", impact_impacted_adj_properties: "UNKNOWN", impact_maybe_adj_properties: "UNKNOWN", impact_impacted_adj_structure: "UNKNOWN", impact_maybe_adj_structure: "UNKNOWN",
};

const t = (v: unknown) => (v == null ? "" : String(v));
const nt = (v: string) => (v.trim() ? v.trim() : null);
const triToBool = (v: Tri) => (v === "YES" ? true : v === "NO" ? false : null);
const boolToTri = (v: unknown): Tri => (v === true ? "YES" : v === false ? "NO" : "UNKNOWN");
const nf = (v: string, n: string) => { if (!v.trim()) return null; const x = Number(v); if (Number.isNaN(x)) throw new Error(`${n} must be numeric`); return x; };
const ni = (v: string, n: string) => { if (!v.trim()) return null; const x = Number(v); if (Number.isNaN(x) || !Number.isInteger(x)) throw new Error(`${n} must be whole number`); return x; };
const parseStatePlaneFeetValue = (value: string) => {
  const raw = value.trim().replace(/,/g, "");
  if (!raw) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
};
const np = (v: string, n: string) => {
  if (!v.trim()) return null;
  const x = Number(v);
  if (Number.isNaN(x)) throw new Error(`${n} must be numeric`);
  if (x < 0 || x > 100) throw new Error(`${n} must be between 0 and 100`);
  return x;
};
const DISTRIBUTION_ICON_SRC: Record<string, string> = {
  ADVANCING: "/distribution-icons/advancing.png",
  RETROGRESSING: "/distribution-icons/retrogressing.png",
  ENLARGING: "/distribution-icons/enlarging.png",
  WIDENING: "/distribution-icons/widening.png",
  MOVING: "/distribution-icons/moving.png",
  CONFINED: "/distribution-icons/confined.png",
};
const LANES_CLOSED_OPTIONS = Array.from({ length: 4 }, (_, idx) => String(idx + 1));
const DASHBOARD_LAYOUT_KEY = "eris_submission_layout_v1";
const DASHBOARD_LAYOUT_PROFILES_KEY = "eris_submission_layout_profiles_v1";
const DASHBOARD_DEFAULT_ORDER = [
  "report_header",
  "location",
  "distribution",
  "highway_status",
  "incident_type",
  "material",
  "pavement_ground_status",
  "vegetation_on_slope",
  "water_drainage",
  "water_content",
  "measurements",
] as const;
type DashboardCardId = (typeof DASHBOARD_DEFAULT_ORDER)[number];
type DashboardCardLayout = { width: number; height: number };
type DashboardCardPosition = { x: number; y: number };
type DashboardLayoutState = {
  order: DashboardCardId[];
  sizes: Record<DashboardCardId, DashboardCardLayout>;
  positions: Partial<Record<DashboardCardId, DashboardCardPosition>>;
};
const DASHBOARD_MIN_CARD_WIDTH = 320;
const DASHBOARD_MAX_CARD_WIDTH = 1600;
const DASHBOARD_MIN_CARD_HEIGHT = 150;
const DASHBOARD_MAX_CARD_HEIGHT = 980;
const DASHBOARD_LAYOUT_GAP = 12;
const DASHBOARD_TIDY_SNAP = 8;
const DASHBOARD_DEFAULT_SIZES: Record<DashboardCardId, DashboardCardLayout> = {
  report_header: { width: 1052, height: 300 },
  location: { width: 520, height: 300 },
  distribution: { width: 520, height: 250 },
  highway_status: { width: 520, height: 250 },
  incident_type: { width: 520, height: 250 },
  material: { width: 520, height: 250 },
  pavement_ground_status: { width: 520, height: 360 },
  vegetation_on_slope: { width: 520, height: 260 },
  water_drainage: { width: 520, height: 470 },
  water_content: { width: 520, height: 250 },
  measurements: { width: 520, height: 470 },
};
const DASHBOARD_DEFAULT_POSITIONS: Partial<Record<DashboardCardId, DashboardCardPosition>> = {
  report_header: { x: 12, y: 12 },
  location: { x: 1076, y: 12 },
  incident_type: { x: 12, y: 324 },
  distribution: { x: 544, y: 324 },
  highway_status: { x: 1076, y: 324 },
  material: { x: 12, y: 586 },
  water_content: { x: 544, y: 586 },
  pavement_ground_status: { x: 1076, y: 586 },
  vegetation_on_slope: { x: 12, y: 848 },
  measurements: { x: 544, y: 848 },
  water_drainage: { x: 1076, y: 958 },
};
const DASHBOARD_CARD_TITLES: Record<DashboardCardId, string> = {
  report_header: "Report Header",
  location: "Location",
  distribution: "Distribution",
  highway_status: "Highway Status",
  incident_type: "Incident Type",
  material: "Material",
  pavement_ground_status: "Pavement / Ground Status",
  vegetation_on_slope: "Vegetation on Slope",
  water_drainage: "Water / Drainage",
  water_content: "Water Content",
  measurements: "Measurements",
};
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
];

function S({ s }: { s: string }) {
  const c = s === "APPROVED" ? "bg-[color:color-mix(in_oklab,var(--good)_16%,transparent)] text-[var(--good)] border-[color:color-mix(in_oklab,var(--good)_48%,transparent)]" : s === "REJECTED" ? "bg-[color:color-mix(in_oklab,var(--bad)_16%,transparent)] text-[var(--bad)] border-[color:color-mix(in_oklab,var(--bad)_48%,transparent)]" : s === "SUBMITTED" ? "bg-[color:color-mix(in_oklab,var(--brand)_16%,transparent)] text-[var(--brand)] border-[color:color-mix(in_oklab,var(--brand)_48%,transparent)]" : "bg-[var(--panel-soft)] text-[var(--ink)] border-[var(--line)]";
  return <span className={`inline-flex rounded border px-2 py-0.5 text-xs font-medium ${c}`}>{s}</span>;
}
function R({ l, v }: { l: string; v: unknown }) {
  return <div className="grid grid-cols-3 gap-3 border-b border-[var(--line)]/70 py-1.5 text-sm last:border-b-0"><div className="text-muted">{l}</div><div className="col-span-2 font-medium">{v == null || v === "" ? "-" : String(v)}</div></div>;
}
function Section({ title, children, open = false }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="border-t border-[var(--line)]/60 py-3" open={open}>
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted select-none">{title}</summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

function pointFromLatLon(gisa: any): any | null {
  const lat = Number(gisa?.latitude);
  const lon = Number(gisa?.longitude);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
  return { type: "Point", coordinates: [lon, lat] };
}

function normalizeCounty(value: string): string {
  return value.replace(/\s+County$/i, "").trim();
}

function tryExtractRoute(addressText: string): string | null {
  const m = addressText.match(/\b(?:I|US|CA|SR)[-\s]?(\d{1,3})\b/i) || addressText.match(/\b(\d{1,3})\b/);
  return normalizeRouteValue(m?.[1] ?? null);
}

function normalizeDistrictValue(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const n = Number(raw);
  if (!Number.isNaN(n) && Number.isInteger(n) && n >= 1 && n <= 12) return String(n);
  return raw;
}

function districtContactRaw(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseDistrictContacts(raw: string): DistrictContact[] {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : typeof parsed === "object" && parsed !== null ? [parsed] : [];
  return rows.map((item, idx) => {
    const rec = item as Record<string, unknown>;
    return {
      id: `${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 7)}`,
      first_name: String(rec.first_name ?? ""),
      last_name: String(rec.last_name ?? ""),
      s_number: String(rec.s_number ?? ""),
      phone: String(rec.phone ?? ""),
      cell_phone: String(rec.cell_phone ?? ""),
    };
  });
}

function serializeDistrictContacts(contacts: DistrictContact[]): string {
  const normalized = contacts.map((c) => ({
    first_name: c.first_name.trim(),
    last_name: c.last_name.trim(),
    s_number: c.s_number.trim(),
    phone: c.phone.trim(),
    cell_phone: c.cell_phone.trim(),
  }));
  return JSON.stringify(normalized);
}

function reorderCards(order: DashboardCardId[], dragId: DashboardCardId, overId: DashboardCardId): DashboardCardId[] {
  if (dragId === overId) return [...order];
  const next = order.filter((id) => id !== dragId);
  const overIndex = next.indexOf(overId);
  if (overIndex < 0) next.push(dragId);
  else next.splice(overIndex, 0, dragId);
  return next;
}

function buildDefaultDashboardLayout(): DashboardLayoutState {
  return {
    order: [...DASHBOARD_DEFAULT_ORDER],
    sizes: { ...DASHBOARD_DEFAULT_SIZES },
    positions: { ...DASHBOARD_DEFAULT_POSITIONS },
  };
}

function normalizeDashboardLayout(raw: Partial<DashboardLayoutState> | null | undefined): DashboardLayoutState {
  const base = buildDefaultDashboardLayout();
  if (!raw) return base;
  const order = Array.isArray(raw.order)
    ? raw.order.filter((x): x is DashboardCardId => DASHBOARD_DEFAULT_ORDER.includes(x as DashboardCardId))
    : [];
  const mergedOrder = [
    ...order,
    ...DASHBOARD_DEFAULT_ORDER.filter((id) => !order.includes(id)),
  ] as DashboardCardId[];
  const sizes: Record<DashboardCardId, DashboardCardLayout> = { ...base.sizes };
  for (const id of DASHBOARD_DEFAULT_ORDER) {
    const next = (raw.sizes as any)?.[id];
    if (!next) continue;
    const legacyCol = Number(next.colSpan);
    const legacyRow = Number(next.rowSpan);
    if (!Number.isNaN(legacyCol) || !Number.isNaN(legacyRow)) {
      sizes[id] = {
        width: Math.min(
          DASHBOARD_MAX_CARD_WIDTH,
          Math.max(DASHBOARD_MIN_CARD_WIDTH, Math.round(((Number.isNaN(legacyCol) ? 6 : legacyCol) / 12) * 1400))
        ),
        height: Math.min(
          DASHBOARD_MAX_CARD_HEIGHT,
          Math.max(DASHBOARD_MIN_CARD_HEIGHT, Math.round((Number.isNaN(legacyRow) ? 1 : legacyRow) * 170))
        ),
      };
      continue;
    }
    sizes[id] = {
      width: Math.min(
        DASHBOARD_MAX_CARD_WIDTH,
        Math.max(DASHBOARD_MIN_CARD_WIDTH, Number(next.width) || base.sizes[id].width)
      ),
      height: Math.min(
        DASHBOARD_MAX_CARD_HEIGHT,
        Math.max(DASHBOARD_MIN_CARD_HEIGHT, Number(next.height) || base.sizes[id].height)
      ),
    };
  }
  const positions: Partial<Record<DashboardCardId, DashboardCardPosition>> = { ...base.positions };
  for (const id of DASHBOARD_DEFAULT_ORDER) {
    const next = (raw as any).positions?.[id];
    if (!next) continue;
    const x = Number(next.x);
    const y = Number(next.y);
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    positions[id] = { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) };
  }
  return { order: mergedOrder, sizes, positions };
}

export default function SubmissionDetailPage() {
  const { id } = useParams();
  const sid = Number(id);
  const invalid = !id || Number.isNaN(sid) || sid <= 0;
  const { me } = useAuth();

  const [data, setData] = useState<SubmissionDetail | null>(null);
  const [lookups, setLookups] = useState<GisaLookups | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState<number | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [submitNote, setSubmitNote] = useState("");
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [inc, setInc] = useState<string[]>([]);
  const [imm, setImm] = useState<string[]>([]);
  const [fol, setFol] = useState<string[]>([]);
  const [districtContacts, setDistrictContacts] = useState<DistrictContact[]>([]);
  const [openDistrictContactIds, setOpenDistrictContactIds] = useState<Record<string, boolean>>({});
  const [geom, setGeom] = useState<any | null>(null);
  const [shareQuery, setShareQuery] = useState("");
  const [shareCandidates, setShareCandidates] = useState<AdminUser[]>([]);
  const [sharedWith, setSharedWith] = useState<SharedUser[]>([]);
  const [geoBusy, setGeoBusy] = useState(false);
  const [geoSaveState, setGeoSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [geoSaveMessage, setGeoSaveMessage] = useState("");
  const [showNorthingEasting, setShowNorthingEasting] = useState(false);
  const [northingInput, setNorthingInput] = useState("");
  const [eastingInput, setEastingInput] = useState("");
  const [statePlaneInputError, setStatePlaneInputError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [layoutMode, setLayoutMode] = useState(false);
  const layoutCanvasRef = useRef<HTMLDivElement | null>(null);
  const [layoutCanvasHeight, setLayoutCanvasHeight] = useState(720);
  const [selectedCardId, setSelectedCardId] = useState<DashboardCardId | null>(null);
  const [dragState, setDragState] = useState<{
    id: DashboardCardId;
    startX: number;
    startY: number;
    cardX: number;
    cardY: number;
    x: number;
    y: number;
    active: boolean;
    overId: DashboardCardId | null;
  } | null>(null);
  const [resizeState, setResizeState] = useState<{
    id: DashboardCardId;
    mode: "right" | "left" | "bottom" | "bottomRight" | "bottomLeft";
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
    startCardX: number;
    startCardY: number;
  } | null>(null);
  const [activeLayoutProfile, setActiveLayoutProfile] = useState("Default");
  const [layoutProfiles, setLayoutProfiles] = useState<Record<string, DashboardLayoutState>>({
    Default: buildDefaultDashboardLayout(),
  });
  const [dashboardLayout, setDashboardLayout] = useState<DashboardLayoutState>(() => buildDefaultDashboardLayout());
  const [elevFetching, setElevFetching] = useState(false);
  const [elevError, setElevError] = useState<string | null>(null);
  const [bearingInput, setBearingInput] = useState<string>("");
  const [riDetailsOpen, setRiDetailsOpen] = useState(false);

  const canReview = !!me?.roles?.some((r) => r === "REVIEWER" || r === "ADMIN");
  const canEdit = !!me?.roles?.some((r) => r === "FIELD_WORKER" || r === "ADMIN") && (data?.submission.status === "DRAFT" || data?.submission.status === "REJECTED");
  const canAct = canReview && data?.submission.status === "SUBMITTED";
  const canManageSharing = !!me?.roles?.includes("ADMIN");
  const canDeleteSubmission =
    !!data?.submission &&
    (me?.roles?.includes("ADMIN") ||
      (data.submission.status === "DRAFT" && me?.id === data.submission.created_by_user_id));
  const tog = (arr: string[], code: string) => (arr.includes(code) ? arr.filter((x) => x !== code) : [...arr, code]);
  const statePlaneZone = useMemo(() => getCaliforniaStatePlaneZone(draft.county), [draft.county]);
  const statePlaneCoordinates = useMemo(() => {
    if (!statePlaneZone) return null;
    const latitude = normalizeCoordinateValue(draft.latitude);
    const longitude = normalizeCoordinateValue(draft.longitude);
    if (latitude == null || longitude == null) {
      return {
        countyCode: "",
        zone: statePlaneZone,
        northing: Number.NaN,
        easting: Number.NaN,
        units: "US survey ft" as const,
      };
    }
    return convertLatLonToCaliforniaStatePlaneFeet({ latitude, longitude, county: draft.county });
  }, [draft.county, draft.latitude, draft.longitude, statePlaneZone]);

  useEffect(() => {
    if (statePlaneCoordinates) {
      setNorthingInput(formatCaliforniaStatePlaneFeet(statePlaneCoordinates.northing));
      setEastingInput(formatCaliforniaStatePlaneFeet(statePlaneCoordinates.easting));
    } else {
      setNorthingInput("");
      setEastingInput("");
    }
    setStatePlaneInputError(null);
  }, [statePlaneCoordinates?.northing, statePlaneCoordinates?.easting, statePlaneCoordinates?.zone]);

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
      county: draft.county,
    });

    if (!converted) {
      setStatePlaneInputError("Unable to convert northing/easting for the selected county.");
      return;
    }

    setDraft((prev) => ({
      ...prev,
      latitude: formatCoordinate(converted.latitude),
      longitude: formatCoordinate(converted.longitude),
    }));
    setNorthingInput(formatCaliforniaStatePlaneFeet(northing));
    setEastingInput(formatCaliforniaStatePlaneFeet(easting));
    setStatePlaneInputError(null);
  }, [draft.county, eastingInput, northingInput, statePlaneZone]);

  useEffect(() => {
    try {
      const baseProfiles: Record<string, DashboardLayoutState> = {
        Default: buildDefaultDashboardLayout(),
      };
      const rawProfiles = localStorage.getItem(DASHBOARD_LAYOUT_PROFILES_KEY);
      if (rawProfiles) {
        const parsedProfiles = JSON.parse(rawProfiles) as {
          active?: string;
          profiles?: Record<string, Partial<DashboardLayoutState>>;
        };
        const mergedProfiles: Record<string, DashboardLayoutState> = { ...baseProfiles };
        for (const [name, profile] of Object.entries(parsedProfiles.profiles ?? {})) {
          mergedProfiles[name] = normalizeDashboardLayout(profile);
        }
        const active = parsedProfiles.active && mergedProfiles[parsedProfiles.active]
          ? parsedProfiles.active
          : "Default";
        setLayoutProfiles(mergedProfiles);
        setActiveLayoutProfile(active);
        setDashboardLayout(mergedProfiles[active]);
        return;
      }

      const rawLegacy = localStorage.getItem(DASHBOARD_LAYOUT_KEY);
      if (rawLegacy) {
        const parsedLegacy = JSON.parse(rawLegacy) as Partial<DashboardLayoutState>;
        const legacyLayout = normalizeDashboardLayout(parsedLegacy);
        const mergedProfiles: Record<string, DashboardLayoutState> = {
          ...baseProfiles,
          "My Layout": legacyLayout,
        };
        setLayoutProfiles(mergedProfiles);
        setActiveLayoutProfile("My Layout");
        setDashboardLayout(legacyLayout);
      } else {
        setLayoutProfiles(baseProfiles);
        setActiveLayoutProfile("Default");
        setDashboardLayout(baseProfiles.Default);
      }
    } catch {
      // ignore malformed saved layout
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(DASHBOARD_LAYOUT_KEY, JSON.stringify(dashboardLayout));
    } catch {
      // ignore
    }
  }, [dashboardLayout]);
  useEffect(() => {
    setLayoutProfiles((prev) => ({ ...prev, [activeLayoutProfile]: dashboardLayout }));
  }, [dashboardLayout, activeLayoutProfile]);
  useEffect(() => {
    try {
      localStorage.setItem(
        DASHBOARD_LAYOUT_PROFILES_KEY,
        JSON.stringify({
          active: activeLayoutProfile,
          profiles: layoutProfiles,
        })
      );
    } catch {
      // ignore
    }
  }, [layoutProfiles, activeLayoutProfile]);
  useEffect(() => {
    if (!layoutMode) {
      setSelectedCardId(null);
    }
  }, [layoutMode]);

  function soilPercentValidationMessage(): string | null {
    if (draft.material_soil !== "YES") return null;
    const fields: Array<[string, string]> = [
      ["est_clay_pct", "Clay"],
      ["est_silt_pct", "Silt"],
      ["est_sand_pct", "Sand"],
      ["est_gravel_pct", "Gravel"],
    ];
    let total = 0;
    for (const [key, label] of fields) {
      const raw = String(draft[key] ?? "").trim();
      const value = raw ? Number(raw) : 0;
      if (Number.isNaN(value)) return `${label} percentage must be numeric.`;
      total += value;
    }
    const delta = total - 100;
    if (total === 100) return null;
    const dir = delta > 0 ? "over" : "under";
    return `Material Soil percentages must total 100%. Current total is ${total.toFixed(2)}% (${dir} by ${Math.abs(delta).toFixed(2)}%).`;
  }

  async function load() {
    setBusy(true); setErr(null);
    try {
      const [d, l, geomRes] = await Promise.all([
        api<SubmissionDetail>(`/submissions/${sid}`),
        api<GisaLookups>("/gisa/lookups"),
        api<{ submission_id: number; geometry: any | null }>(`/submissions/${sid}/geometry`).catch(() => null),
      ]);
      setData(d);
      setLookups(l);
      setReviewNote(d.submission.review_comment ?? "");
      setGeom(geomRes?.geometry ?? d.gisa?.geometry_json ?? pointFromLatLon(d.gisa) ?? null);
      const gisa: any = d.gisa || {};
      const districtContactText = districtContactRaw(gisa.district_contact);
      const loadedDistrictContacts = parseDistrictContacts(districtContactText);
      const loadedIncidentTypeCodes = new Set((d.incident_types ?? []).map((x) => String(x)));
      const incidentTri = (key: string, value: unknown): Tri =>
        value === true || value === 1 || value === "1" || loadedIncidentTypeCodes.has(INCIDENT_TYPE_CODE_BY_FORM_KEY[key])
          ? "YES"
          : "NO";
      setDraft({
        ...EMPTY,
        report_date: t(gisa.report_date),
        district: normalizeDistrictValue(gisa.district) || normalizeDistrictValue(districtForCounty(gisa.county)),
        county: countyNameFromNameOrCode(gisa.county) ?? t(gisa.county),
        route: normalizeRouteInput(gisa.route),
        post_mile: normalizePostMileInput(gisa.post_mile),
        ea: t(gisa.ea),
        project_id: t(gisa.project_id),
        date_incident_reported: t(gisa.date_incident_reported),
        district_contact: districtContactText,
        latitude: formatCoordinate(gisa.latitude), longitude: formatCoordinate(gisa.longitude), distribution_code: t(gisa.distribution_code), highway_status_cause: t(gisa.highway_status_cause), highway_status_code: t(gisa.highway_status_code), lanes_closed_count: t(gisa.lanes_closed_count), open_highway_traffic_lanes_count: t(gisa.open_highway_traffic_lanes_count),
        pavement_ground_cracks: boolToTri(gisa.pavement_ground_cracks), crack_length_ft: t(gisa.crack_length_ft), crack_horizontal_in: t(gisa.crack_horizontal_in), crack_vertical_in: t(gisa.crack_vertical_in), crack_depth_in: t(gisa.crack_depth_in), settlement_in: t(gisa.settlement_in), bulge_in: t(gisa.bulge_in), indented_by_rocks: boolToTri(gisa.indented_by_rocks),
        failure_rock_fall: incidentTri("failure_rock_fall", gisa.failure_rock_fall), failure_topple: incidentTri("failure_topple", gisa.failure_topple), failure_slide: incidentTri("failure_slide", gisa.failure_slide), failure_spread: incidentTri("failure_spread", gisa.failure_spread), failure_flow: incidentTri("failure_flow", gisa.failure_flow), failure_compound: incidentTri("failure_compound", gisa.failure_compound), failure_erosion: incidentTri("failure_erosion", gisa.failure_erosion), failure_surficial_failure: incidentTri("failure_surficial_failure", gisa.failure_surficial_failure), failure_scoured_toe: incidentTri("failure_scoured_toe", gisa.failure_scoured_toe), failure_washout: incidentTri("failure_washout", gisa.failure_washout),
        incident_type_description: t(gisa.incident_type_description),
        distribution_advancing: boolToTri(gisa.distribution_advancing), distribution_retrogressive: boolToTri(gisa.distribution_retrogressive), distribution_enlarging: boolToTri(gisa.distribution_enlarging), distribution_widening: boolToTri(gisa.distribution_widening), distribution_moving: boolToTri(gisa.distribution_moving), distribution_confined: boolToTri(gisa.distribution_confined),
        material_rock: boolToTri(gisa.material_rock), material_soil: boolToTri(gisa.material_soil), material_bedding: boolToTri(gisa.material_bedding), material_joints: boolToTri(gisa.material_joints), material_fractures: boolToTri(gisa.material_fractures),
        est_soil_pct: t(gisa.est_soil_pct), est_clay_pct: t(gisa.est_clay_pct), est_silt_pct: t(gisa.est_silt_pct), est_sand_pct: t(gisa.est_sand_pct), est_gravel_pct: t(gisa.est_gravel_pct),
        water_dry: boolToTri(gisa.water_dry), water_moist: boolToTri(gisa.water_moist), water_wet: boolToTri(gisa.water_wet), water_flowing: boolToTri(gisa.water_flowing), water_seep: boolToTri(gisa.water_seep), water_spring: boolToTri(gisa.water_spring),
        vegetation_trees: t(gisa.vegetation_trees), vegetation_bushes_shrubs: t(gisa.vegetation_bushes_shrubs), vegetation_groundcover: t(gisa.vegetation_groundcover),
        drainage_clogged_inlet: boolToTri(gisa.drainage_clogged_inlet), drainage_compromised_drains: boolToTri(gisa.drainage_compromised_drains), drainage_surface_runoff: boolToTri(gisa.drainage_surface_runoff), drainage_torrent_surge_flood: boolToTri(gisa.drainage_torrent_surge_flood),
        impact_impacted_adj_utilities: boolToTri(gisa.impact_impacted_adj_utilities), impact_maybe_adj_utilities: boolToTri(gisa.impact_maybe_adj_utilities), impact_adj_utilities: t(gisa.impact_adj_utilities), impact_impacted_adj_properties: boolToTri(gisa.impact_impacted_adj_properties), impact_maybe_adj_properties: boolToTri(gisa.impact_maybe_adj_properties), impact_adj_properties: t(gisa.impact_adj_properties), impact_impacted_adj_structure: boolToTri(gisa.impact_impacted_adj_structure), impact_maybe_adj_structure: boolToTri(gisa.impact_maybe_adj_structure), impact_adj_structure: t(gisa.impact_adj_structure),
        measure_slope_height_ft: t(gisa.measure_slope_height_ft), measure_original_slope_deg: t(gisa.measure_original_slope_deg), measure_landslide_width_ft: t(gisa.measure_landslide_width_ft), measure_landslide_length_ft: t(gisa.measure_landslide_length_ft), measure_main_scarp_height_ft: t(gisa.measure_main_scarp_height_ft), measure_landslide_slope_deg: t(gisa.measure_landslide_slope_deg), measure_roadway_length_ft: t(gisa.measure_roadway_length_ft), measure_roadway_width_ft: t(gisa.measure_roadway_width_ft),
        record_of_event_notes: t(gisa.record_of_event_notes), maintenance_history_notes: t(gisa.maintenance_history_notes), geotechnical_assessment_notes: t(gisa.geotechnical_assessment_notes), recommendations_notes: t(gisa.recommendations_notes), sketchpad_notes: t(gisa.sketchpad_notes),
        observations_notes: t(gisa.observations_notes), geometry_json: gisa.geometry_json ? JSON.stringify(gisa.geometry_json, null, 2) : "",
      });
      setDistrictContacts(loadedDistrictContacts);
      setOpenDistrictContactIds(
        Object.fromEntries(loadedDistrictContacts.map((contact) => [contact.id, false]))
      );
      setInc(d.incident_types ?? []);
      setImm(d.actions?.immediate ?? []);
      setFol(d.actions?.follow_up ?? []);
      if (canManageSharing) {
        const sharedRes = await api<{ items: SharedUser[] }>(`/submissions/${sid}/shared-with`);
        setSharedWith(sharedRes.items ?? []);
      } else {
        setSharedWith([]);
      }
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load");
    } finally {
      setBusy(false);
    }
  }

  async function persistDraft() {
    if (!canEdit) return;
    let geometry: Record<string, unknown> | null = null;
    if (draft.geometry_json.trim()) {
      const parsed = JSON.parse(draft.geometry_json);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Geometry JSON must be object");
      geometry = parsed as Record<string, unknown>;
    }
    const incidentItems = Array.from(new Set([
      ...Object.entries(INCIDENT_TYPE_CODE_BY_FORM_KEY)
        .filter(([key]) => draft[key] === "YES")
        .map(([, code]) => code),
      ...inc.filter((code) => !INCIDENT_TYPE_FORM_CODES.has(code)),
    ]));
    await api(`/submissions/${sid}/gisa`, { method: "PATCH", body: JSON.stringify({
      report_date: nt(draft.report_date), district: nt(draft.district), county: nt(draft.county), route: normalizeRouteValue(draft.route), post_mile: normalizePostMileValue(draft.post_mile), ea: nt(draft.ea), project_id: nt(draft.project_id), date_incident_reported: nt(draft.date_incident_reported), district_contact: nt(draft.district_contact),
      latitude: normalizeCoordinateValue(nf(draft.latitude, "Latitude")), longitude: normalizeCoordinateValue(nf(draft.longitude, "Longitude")), distribution_code: nt(draft.distribution_code), highway_status_cause: nt(draft.highway_status_cause), highway_status_code: nt(draft.highway_status_code), lanes_closed_count: ni(draft.lanes_closed_count, "Lanes closed count"), open_highway_traffic_lanes_count: ni(draft.open_highway_traffic_lanes_count, "Open highway lanes"),
      pavement_ground_cracks: triToBool(draft.pavement_ground_cracks), crack_length_ft: nf(draft.crack_length_ft, "Crack length"), crack_horizontal_in: nf(draft.crack_horizontal_in, "Crack horizontal"), crack_vertical_in: nf(draft.crack_vertical_in, "Crack vertical"), crack_depth_in: nf(draft.crack_depth_in, "Crack depth"), settlement_in: nf(draft.settlement_in, "Settlement"), bulge_in: nf(draft.bulge_in, "Bulge"), indented_by_rocks: triToBool(draft.indented_by_rocks),
      failure_rock_fall: triToBool(draft.failure_rock_fall), failure_topple: triToBool(draft.failure_topple), failure_slide: triToBool(draft.failure_slide), failure_spread: triToBool(draft.failure_spread), failure_flow: triToBool(draft.failure_flow), failure_compound: triToBool(draft.failure_compound), failure_erosion: triToBool(draft.failure_erosion), failure_surficial_failure: triToBool(draft.failure_surficial_failure), failure_scoured_toe: triToBool(draft.failure_scoured_toe), failure_washout: triToBool(draft.failure_washout), incident_type_description: nt(draft.incident_type_description),
      distribution_advancing: triToBool(draft.distribution_advancing), distribution_retrogressive: triToBool(draft.distribution_retrogressive), distribution_enlarging: triToBool(draft.distribution_enlarging), distribution_widening: triToBool(draft.distribution_widening), distribution_moving: triToBool(draft.distribution_moving), distribution_confined: triToBool(draft.distribution_confined),
      material_rock: triToBool(draft.material_rock), material_soil: triToBool(draft.material_soil), material_bedding: triToBool(draft.material_bedding), material_joints: triToBool(draft.material_joints), material_fractures: triToBool(draft.material_fractures),
      est_soil_pct: nf(draft.est_soil_pct, "Estimated soil %"), est_clay_pct: nf(draft.est_clay_pct, "Estimated clay %"), est_silt_pct: nf(draft.est_silt_pct, "Estimated silt %"), est_sand_pct: nf(draft.est_sand_pct, "Estimated sand %"), est_gravel_pct: nf(draft.est_gravel_pct, "Estimated gravel %"),
      water_dry: triToBool(draft.water_dry), water_moist: triToBool(draft.water_moist), water_wet: triToBool(draft.water_wet), water_flowing: triToBool(draft.water_flowing), water_seep: triToBool(draft.water_seep), water_spring: triToBool(draft.water_spring),
      vegetation_trees: np(draft.vegetation_trees, "Trees Coverage %"), vegetation_bushes_shrubs: np(draft.vegetation_bushes_shrubs, "Bushes/Shrubs Coverage %"), vegetation_groundcover: np(draft.vegetation_groundcover, "Groundcover Coverage %"),
      drainage_clogged_inlet: triToBool(draft.drainage_clogged_inlet), drainage_compromised_drains: triToBool(draft.drainage_compromised_drains), drainage_surface_runoff: triToBool(draft.drainage_surface_runoff), drainage_torrent_surge_flood: triToBool(draft.drainage_torrent_surge_flood),
      impact_impacted_adj_utilities: triToBool(draft.impact_impacted_adj_utilities), impact_maybe_adj_utilities: triToBool(draft.impact_maybe_adj_utilities), impact_adj_utilities: nt(draft.impact_adj_utilities), impact_impacted_adj_properties: triToBool(draft.impact_impacted_adj_properties), impact_maybe_adj_properties: triToBool(draft.impact_maybe_adj_properties), impact_adj_properties: nt(draft.impact_adj_properties), impact_impacted_adj_structure: triToBool(draft.impact_impacted_adj_structure), impact_maybe_adj_structure: triToBool(draft.impact_maybe_adj_structure), impact_adj_structure: nt(draft.impact_adj_structure),
      measure_slope_height_ft: nf(draft.measure_slope_height_ft, "Slope height"), measure_original_slope_deg: nf(draft.measure_original_slope_deg, "Original slope"), measure_landslide_width_ft: nf(draft.measure_landslide_width_ft, "Landslide width"), measure_landslide_length_ft: nf(draft.measure_landslide_length_ft, "Landslide length"), measure_main_scarp_height_ft: nf(draft.measure_main_scarp_height_ft, "Main scarp height"), measure_landslide_slope_deg: nf(draft.measure_landslide_slope_deg, "Landslide slope"), measure_roadway_length_ft: nf(draft.measure_roadway_length_ft, "Roadway length"), measure_roadway_width_ft: nf(draft.measure_roadway_width_ft, "Roadway width"),
      record_of_event_notes: nt(draft.record_of_event_notes), maintenance_history_notes: nt(draft.maintenance_history_notes), geotechnical_assessment_notes: nt(draft.geotechnical_assessment_notes), recommendations_notes: nt(draft.recommendations_notes), sketchpad_notes: nt(draft.sketchpad_notes),
      observations_notes: nt(draft.observations_notes), geometry_json: geometry,
    })});
    await api(`/submissions/${sid}/gisa/incident-types`, { method: "PUT", body: JSON.stringify({ items: incidentItems }) });
    await api(`/submissions/${sid}/gisa/actions`, { method: "PUT", body: JSON.stringify({ immediate: imm, follow_up: fol }) });
  }

  async function saveDraft() { setBusy(true); setErr(null); try { await persistDraft(); await load(); } catch (e: any) { setErr(e?.message ?? "Save failed"); setBusy(false); } }
  async function submitDraft() {
    const soilMsg = soilPercentValidationMessage();
    if (soilMsg) {
      setErr(soilMsg);
      return;
    }
    setBusy(true); setErr(null); try { await persistDraft(); await api(`/submissions/${sid}/submit`, { method: "POST", body: JSON.stringify({ comment: submitNote.trim() || null }) }); setSubmitNote(""); await load(); } catch (e: any) { setErr(e?.message ?? "Submit failed"); setBusy(false); }
  }
  async function review(decision: "APPROVE" | "REJECT") { setBusy(true); setErr(null); try { await api(`/submissions/${sid}/review`, { method: "POST", body: JSON.stringify({ decision, comment: reviewNote.trim() || null }) }); await load(); } catch (e: any) { setErr(e?.message ?? "Review failed"); setBusy(false); } }
  async function searchShareCandidates() {
    if (!canManageSharing) return;
    const q = shareQuery.trim();
    if (!q) {
      setShareCandidates([]);
      return;
    }
    try {
      const res = await api<{ items: AdminUser[] }>(`/admin/users?q=${encodeURIComponent(q)}`);
      setShareCandidates((res.items ?? []).filter((u) => u.id !== data?.submission.created_by_user_id));
    } catch (e: any) {
      setErr(e?.message ?? "User search failed");
    }
  }
  async function addShare(userId: number) {
    if (!canManageSharing) return;
    setBusy(true); setErr(null);
    try {
      await api(`/submissions/${sid}/share`, { method: "POST", body: JSON.stringify({ user_id: userId }) });
      await load();
    } catch (e: any) {
      setErr(e?.message ?? "Share failed");
      setBusy(false);
    }
  }
  async function removeShare(userId: number) {
    if (!canManageSharing) return;
    setBusy(true); setErr(null);
    try {
      await api(`/submissions/${sid}/share/${userId}`, { method: "DELETE" });
      await load();
    } catch (e: any) {
      setErr(e?.message ?? "Unshare failed");
      setBusy(false);
    }
  }
  async function fetchElevation(force: boolean) {
    const parsedBearing = bearingInput.trim() ? parseFloat(bearingInput) : NaN;
    const road_bearing_deg = isFinite(parsedBearing) && parsedBearing >= 0 && parsedBearing < 360
      ? parsedBearing : null;
    setElevFetching(true); setElevError(null);
    try {
      await api<{ elevation_profile: GisaElevationProfile }>(
        `/submissions/${sid}/gisa/elevation-profile`,
        { method: "POST", body: JSON.stringify({ force, road_bearing_deg }) },
      );
      await load();
    } catch (e: any) {
      setElevError(e?.message ?? "Elevation fetch failed");
    } finally {
      setElevFetching(false);
    }
  }
  async function openDownloadUrl(id: number) {
    setDownloading(id);
    try {
      const data = await api<{ download_url: string }>(`/attachments/${id}/download-url`);
      window.open(data.download_url, "_blank", "noopener,noreferrer");
    } catch (e: any) {
      setErr(e?.message ?? "Download failed");
    } finally {
      setDownloading(null);
    }
  }

  const onMapGeometryChange = useCallback(
    async (nextGeometry: any | null) => {
      setGeom(nextGeometry);
      setDraft((d) => ({
        ...d,
        geometry_json: nextGeometry ? JSON.stringify(nextGeometry, null, 2) : "",
      }));

      if (!canEdit || invalid) return;

      setGeoSaveState("saving");
      setGeoSaveMessage(nextGeometry ? "Saving map geometry..." : "Clearing map geometry...");
      try {
        await api(`/submissions/${sid}/gisa`, {
          method: "PATCH",
          body: JSON.stringify({ geometry_json: nextGeometry }),
        });
        setGeoSaveState("saved");
        setGeoSaveMessage(nextGeometry ? "Map geometry saved." : "Map geometry cleared.");
      } catch (e: any) {
        setGeoSaveState("error");
        setGeoSaveMessage(e?.message ?? "Map geometry save failed.");
      }
    },
    [canEdit, invalid, sid]
  );

  async function onDeleteSubmission() {
    if (!data || !canDeleteSubmission) return;
    const ok = window.confirm(
      data.submission.status === "DRAFT"
        ? "Delete this draft?"
        : "Delete this submitted/reviewed record? This cannot be undone."
    );
    if (!ok) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/submissions/${sid}`, { method: "DELETE" });
      window.location.href = "/submissions";
    } catch (e: any) {
      setErr(e?.message ?? "Delete failed");
      setBusy(false);
    }
  }

  async function autofillFromGps() {
    if (!canEdit || !navigator.geolocation) return;
    setGeoBusy(true);
    setErr(null);
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 30000,
        });
      });

      const lat = position.coords.latitude;
      const lon = position.coords.longitude;

      setDraft((prev) => ({ ...prev, latitude: formatCoordinate(lat), longitude: formatCoordinate(lon) }));

      const reverseUrl =
        `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?` +
        `location=${encodeURIComponent(`${lon},${lat}`)}&f=pjson&langCode=en`;
      const geocodeRes = await fetch(reverseUrl);
      if (!geocodeRes.ok) return;
      const geocode = await geocodeRes.json();
      const addr = geocode?.address ?? {};
      const countyRaw = String(addr.Subregion ?? addr.County ?? "").trim();
      const county = countyRaw ? normalizeCounty(countyRaw) : "";
      const districtGuess = districtForCounty(county);
      const routeGuess = tryExtractRoute(
        [addr.StreetName, addr.Match_addr, addr.LongLabel, addr.ShortLabel].filter(Boolean).join(" ")
      );

      setDraft((prev) => ({
        ...prev,
        county: county || prev.county,
        district: districtGuess || prev.district,
        route: routeGuess || prev.route,
      }));
    } catch {
      // keep lat/lon if available; silent fallthrough with generic error
      setErr("Could not fully autofill from GPS. Latitude/Longitude may still be available.");
    } finally {
      setGeoBusy(false);
    }
  }

  useEffect(() => { if (!invalid) load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [sid, canManageSharing]);

  // Prefill bearing from road inventory snapshot when available
  useEffect(() => {
    const snapBearing = data?.gisa?.road_inventory_context?.snapshot?.road_bearing_deg;
    if (snapBearing != null && bearingInput === "") {
      setBearingInput(String(snapBearing));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.gisa?.road_inventory_context?.snapshot?.road_bearing_deg]);

  const box = "rounded-xl border border-[var(--line)] bg-[var(--panel)] p-3";
  const label = "mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted";
  const input = "w-full rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2.5 py-2 text-sm";
  const chip = "rounded-full border px-2.5 py-1 text-xs";
  const ynChip = (active: boolean) => (active ? "border-[var(--brand)] text-[var(--brand)]" : "border-[var(--line)] text-[var(--ink)]");
  const drainageKeys = ["drainage_clogged_inlet", "drainage_compromised_drains", "drainage_surface_runoff", "drainage_torrent_surge_flood"] as const;
  const baseWaterKeys = ["water_dry", "water_moist", "water_wet", "water_flowing"] as const;
  const materialRockSelected = draft.material_rock === "YES";
  const materialSoilSelected = draft.material_soil === "YES";
  const waterFlowingSelected = draft.water_flowing === "YES";
  const highwayLanesClosedSelected = draft.highway_status_code === "LANES_CLOSED";
  const openHighwayTrafficSelected = imm.includes("OPEN_HIGHWAY_TRAFFIC") || fol.includes("OPEN_HIGHWAY_TRAFFIC");
  const showHighwayStatusOptions = !!(
    draft.highway_status_cause.trim() ||
    draft.highway_status_code ||
    draft.lanes_closed_count ||
    draft.open_highway_traffic_lanes_count ||
    openHighwayTrafficSelected
  );
  const countyOptions = draft.district ? countiesForDistrict(draft.district) : CALIFORNIA_COUNTIES;
  const routeOptions = routesForDistrictCounty(draft.district, draft.county);
  const visibleCardIds: DashboardCardId[] = [...DASHBOARD_DEFAULT_ORDER];
  const previewOrder = dragState?.active && dragState.overId
    ? reorderCards(dashboardLayout.order, dragState.id, dragState.overId)
    : dashboardLayout.order;
  const orderedVisibleCardIds: DashboardCardId[] = [
    ...previewOrder.filter((id) => visibleCardIds.includes(id)),
    ...visibleCardIds.filter((id) => !previewOrder.includes(id)),
  ];
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const tidyLayoutPositions = (
    layout: DashboardLayoutState,
    ids: DashboardCardId[],
    canvasWidth: number
  ): DashboardLayoutState => {
    const placed: Array<{ id: DashboardCardId; x: number; y: number; w: number; h: number }> = [];
    const nextPositions: Partial<Record<DashboardCardId, DashboardCardPosition>> = { ...layout.positions };
    const sorted = [...ids].sort((a, b) => {
      const pa = layout.positions[a] ?? { x: DASHBOARD_LAYOUT_GAP, y: DASHBOARD_LAYOUT_GAP };
      const pb = layout.positions[b] ?? { x: DASHBOARD_LAYOUT_GAP, y: DASHBOARD_LAYOUT_GAP };
      return pa.y - pb.y || pa.x - pb.x;
    });

    const overlaps = (x: number, y: number, w: number, h: number) =>
      placed.some((p) => x < p.x + p.w && x + w > p.x && y < p.y + p.h && y + h > p.y);

    for (const id of sorted) {
      const size = layout.sizes[id] ?? DASHBOARD_DEFAULT_SIZES[id];
      const width = Math.min(size.width, Math.max(DASHBOARD_MIN_CARD_WIDTH, canvasWidth - DASHBOARD_LAYOUT_GAP * 2));
      const height = size.height;
      const base = layout.positions[id] ?? { x: DASHBOARD_LAYOUT_GAP, y: DASHBOARD_LAYOUT_GAP };
      let x = Math.round(base.x / DASHBOARD_TIDY_SNAP) * DASHBOARD_TIDY_SNAP;
      let y = Math.round(base.y / DASHBOARD_TIDY_SNAP) * DASHBOARD_TIDY_SNAP;
      x = clamp(x, DASHBOARD_LAYOUT_GAP, Math.max(DASHBOARD_LAYOUT_GAP, canvasWidth - width - DASHBOARD_LAYOUT_GAP));
      y = Math.max(DASHBOARD_LAYOUT_GAP, y);

      let safety = 0;
      while (overlaps(x, y, width, height) && safety < 3000) {
        if (x + width + DASHBOARD_LAYOUT_GAP <= canvasWidth - DASHBOARD_LAYOUT_GAP) {
          x += DASHBOARD_LAYOUT_GAP;
        } else {
          x = DASHBOARD_LAYOUT_GAP;
          y += DASHBOARD_LAYOUT_GAP;
        }
        safety += 1;
      }

      nextPositions[id] = { x, y };
      placed.push({ id, x, y, w: width, h: height });
    }

    return { ...layout, positions: nextPositions };
  };
  const layoutProfileNames = Object.keys(layoutProfiles);
  const loadLayoutProfile = (name: string) => {
    const selected = layoutProfiles[name];
    if (!selected) return;
    const normalized = normalizeDashboardLayout(selected);
    setActiveLayoutProfile(name);
    setDashboardLayout(normalized);
  };
  const saveCurrentLayoutAsProfile = () => {
    const input = window.prompt("Save layout as (profile name):", activeLayoutProfile === "Default" ? "My Layout" : activeLayoutProfile);
    const name = (input ?? "").trim();
    if (!name) return;
    setLayoutProfiles((prev) => ({ ...prev, [name]: normalizeDashboardLayout(dashboardLayout) }));
    setActiveLayoutProfile(name);
  };
  const deleteActiveLayoutProfile = () => {
    if (activeLayoutProfile === "Default") return;
    const ok = window.confirm(`Delete layout profile "${activeLayoutProfile}"?`);
    if (!ok) return;
    setLayoutProfiles((prev) => {
      const next = { ...prev };
      delete next[activeLayoutProfile];
      return next;
    });
    setActiveLayoutProfile("Default");
    setDashboardLayout(buildDefaultDashboardLayout());
  };

  useEffect(() => {
    const canvasWidth = Math.max(720, layoutCanvasRef.current?.clientWidth ?? 1400);
    setDashboardLayout((prev) => {
      let x = DASHBOARD_LAYOUT_GAP;
      let y = DASHBOARD_LAYOUT_GAP;
      let rowHeight = 0;
      let changed = false;
      const nextPositions: Partial<Record<DashboardCardId, DashboardCardPosition>> = { ...prev.positions };
      for (const id of orderedVisibleCardIds) {
        if (nextPositions[id]) continue;
        const cardSize = prev.sizes[id] ?? DASHBOARD_DEFAULT_SIZES[id];
        const cardWidth = Math.min(cardSize.width, canvasWidth - DASHBOARD_LAYOUT_GAP * 2);
        if (x + cardWidth > canvasWidth - DASHBOARD_LAYOUT_GAP && x > DASHBOARD_LAYOUT_GAP) {
          x = DASHBOARD_LAYOUT_GAP;
          y += rowHeight + DASHBOARD_LAYOUT_GAP;
          rowHeight = 0;
        }
        nextPositions[id] = { x, y };
        x += cardWidth + DASHBOARD_LAYOUT_GAP;
        rowHeight = Math.max(rowHeight, cardSize.height);
        changed = true;
      }
      if (!changed) return prev;
      return { ...prev, positions: nextPositions };
    });
  }, [orderedVisibleCardIds]);

  useEffect(() => {
    let bottom = 620;
    for (const id of orderedVisibleCardIds) {
      const p = dashboardLayout.positions[id] ?? { x: DASHBOARD_LAYOUT_GAP, y: DASHBOARD_LAYOUT_GAP };
      const s = dashboardLayout.sizes[id] ?? DASHBOARD_DEFAULT_SIZES[id];
      bottom = Math.max(bottom, p.y + s.height + DASHBOARD_LAYOUT_GAP);
    }
    setLayoutCanvasHeight(bottom);
  }, [orderedVisibleCardIds, dashboardLayout.positions, dashboardLayout.sizes]);

  const startDragCard = (id: DashboardCardId, e: React.MouseEvent) => {
    if (!layoutMode || e.button !== 0) return;
    e.preventDefault();
    const p = dashboardLayout.positions[id] ?? { x: DASHBOARD_LAYOUT_GAP, y: DASHBOARD_LAYOUT_GAP };
    setDragState({
      id,
      startX: e.clientX,
      startY: e.clientY,
      cardX: p.x,
      cardY: p.y,
      x: e.clientX,
      y: e.clientY,
      active: false,
      overId: null,
    });
  };
  const startResizeCard = (id: DashboardCardId, mode: "right" | "left" | "bottom" | "bottomRight" | "bottomLeft", e: React.MouseEvent) => {
    if (!layoutMode || e.button !== 0) return;
    e.preventDefault();
    const cur = dashboardLayout.sizes[id] ?? DASHBOARD_DEFAULT_SIZES[id];
    const p = dashboardLayout.positions[id] ?? { x: DASHBOARD_LAYOUT_GAP, y: DASHBOARD_LAYOUT_GAP };
    setResizeState({
      id,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      startWidth: cur.width,
      startHeight: cur.height,
      startCardX: p.x,
      startCardY: p.y,
    });
  };

  useEffect(() => {
    if (!layoutMode) return;
    const overlapsOtherCards = (
      targetId: DashboardCardId,
      targetX: number,
      targetY: number,
      targetW: number,
      targetH: number,
      layout: DashboardLayoutState
    ) => {
      for (const otherId of orderedVisibleCardIds) {
        if (otherId === targetId) continue;
        const op = layout.positions[otherId] ?? { x: DASHBOARD_LAYOUT_GAP, y: DASHBOARD_LAYOUT_GAP };
        const os = layout.sizes[otherId] ?? DASHBOARD_DEFAULT_SIZES[otherId];
        const intersects =
          targetX < op.x + os.width &&
          targetX + targetW > op.x &&
          targetY < op.y + os.height &&
          targetY + targetH > op.y;
        if (intersects) return true;
      }
      return false;
    };

    const onMove = (e: MouseEvent) => {
      if (resizeState) {
        const dx = e.clientX - resizeState.startX;
        const dy = e.clientY - resizeState.startY;
        const canvasWidth = Math.max(720, layoutCanvasRef.current?.clientWidth ?? 1400);
        setDashboardLayout((prev) => {
          const startX = resizeState.startCardX;
          const startY = resizeState.startCardY;
          const startW = resizeState.startWidth;
          const startH = resizeState.startHeight;
          let nextX = startX;
          let nextW = startW;
          const startRight = startX + startW;

          if (resizeState.mode === "left" || resizeState.mode === "bottomLeft") {
            nextX = Math.round(clamp(startX + dx, 0, startRight - DASHBOARD_MIN_CARD_WIDTH));
            nextW = Math.round(clamp(startRight - nextX, DASHBOARD_MIN_CARD_WIDTH, DASHBOARD_MAX_CARD_WIDTH));
            nextX = Math.min(nextX, Math.max(0, canvasWidth - nextW));
          } else if (resizeState.mode !== "bottom") {
            nextW = Math.round(clamp(startW + dx, DASHBOARD_MIN_CARD_WIDTH, Math.min(DASHBOARD_MAX_CARD_WIDTH, canvasWidth - startX)));
          }

          const nextH = Math.round(clamp(
            resizeState.mode === "left" || resizeState.mode === "right" ? startH : startH + dy,
            DASHBOARD_MIN_CARD_HEIGHT,
            DASHBOARD_MAX_CARD_HEIGHT
          ));

          if (overlapsOtherCards(resizeState.id, nextX, startY, nextW, nextH, prev)) {
            return prev;
          }

          return {
            ...prev,
            sizes: {
              ...prev.sizes,
              [resizeState.id]: { width: nextW, height: nextH },
            },
            positions: {
              ...prev.positions,
              [resizeState.id]: { x: nextX, y: startY },
            },
          };
        });
        return;
      }
      if (dragState) {
        const moved = Math.hypot(e.clientX - dragState.startX, e.clientY - dragState.startY) > 6;
        const canvasWidth = Math.max(720, layoutCanvasRef.current?.clientWidth ?? 1400);
        const size = dashboardLayout.sizes[dragState.id] ?? DASHBOARD_DEFAULT_SIZES[dragState.id];
        const nextX = Math.round(clamp(dragState.cardX + (e.clientX - dragState.startX), 0, Math.max(0, canvasWidth - size.width)));
        const nextY = Math.max(0, Math.round(dragState.cardY + (e.clientY - dragState.startY)));
        setDashboardLayout((prev) => {
          if (overlapsOtherCards(dragState.id, nextX, nextY, size.width, size.height, prev)) {
            return prev;
          }
          return {
            ...prev,
            positions: {
              ...prev.positions,
              [dragState.id]: { x: nextX, y: nextY },
            },
          };
        });
        setDragState((prev) => prev ? ({
          ...prev,
          x: e.clientX,
          y: e.clientY,
          active: prev.active || moved,
          overId: null,
        }) : prev);
      }
    };
    const onUp = () => {
      setDragState(null);
      setResizeState(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [layoutMode, dragState, resizeState, dashboardLayout.sizes, orderedVisibleCardIds]);

  const cardFrameProps = (id: DashboardCardId) => {
    const isGhostTarget = dragState?.active && dragState.overId === id && dragState.id !== id;
    const isDragging = dragState?.active && dragState.id === id;
    const isSelected = selectedCardId === id;
    const onCardMouseDown = (e: React.MouseEvent) => {
      if (!layoutMode || e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest("[data-layout-resize]")) return;
      if (!isSelected) {
        setSelectedCardId(id);
        return;
      }
      const interactive = target.closest("input, select, textarea, button, a, label, summary");
      if (interactive) return;
      startDragCard(id, e);
    };
    return {
      "data-card-id": id,
      className: `${box} relative overflow-auto ${layoutMode ? "pt-8" : ""} ${layoutMode && isSelected ? "ring-4 ring-[color:color-mix(in_oklab,var(--brand)_68%,transparent)] shadow-[0_0_0_2px_color-mix(in_oklab,var(--panel)_70%,transparent)]" : ""} ${layoutMode && isSelected ? "cursor-grab active:cursor-grabbing" : ""} ${isDragging ? "opacity-35" : ""} ${isGhostTarget ? "ring-2 ring-[var(--brand)]" : ""}`,
      onMouseDown: onCardMouseDown,
      style: {
        position: "absolute",
        left: `${dashboardLayout.positions[id]?.x ?? DASHBOARD_LAYOUT_GAP}px`,
        top: `${dashboardLayout.positions[id]?.y ?? DASHBOARD_LAYOUT_GAP}px`,
        width: `${dashboardLayout.sizes[id]?.width ?? DASHBOARD_DEFAULT_SIZES[id].width}px`,
        height: `${dashboardLayout.sizes[id]?.height ?? DASHBOARD_DEFAULT_SIZES[id].height}px`,
        zIndex: isSelected ? 20 : 1,
      } as CSSProperties,
    };
  };
  const layoutTools = (id: DashboardCardId) =>
    layoutMode && selectedCardId === id ? (
      <>
        <div className="pointer-events-none absolute left-2 right-2 top-2 z-[2] h-6 rounded border border-dashed border-[var(--line)] bg-[var(--panel)]/70 px-2 text-[10px] leading-6 text-muted">
          Selected: drag anywhere in this card
        </div>
        <div data-layout-resize className="absolute bottom-0 right-0 top-0 z-[3] w-2 cursor-ew-resize" onMouseDown={(e) => startResizeCard(id, "right", e)} />
        <div data-layout-resize className="absolute bottom-0 left-0 top-0 z-[3] w-2 cursor-ew-resize" onMouseDown={(e) => startResizeCard(id, "left", e)} />
        <div data-layout-resize className="absolute bottom-0 left-0 right-0 z-[3] h-2 cursor-ns-resize" onMouseDown={(e) => startResizeCard(id, "bottom", e)} />
        <div data-layout-resize className="absolute bottom-0 right-0 z-[4] h-4 w-4 cursor-nwse-resize bg-[var(--panel)]/85" onMouseDown={(e) => startResizeCard(id, "bottomRight", e)} />
        <div data-layout-resize className="absolute bottom-0 left-0 z-[4] h-4 w-4 cursor-nesw-resize bg-[var(--panel)]/85" onMouseDown={(e) => startResizeCard(id, "bottomLeft", e)} />
      </>
    ) : null;
  const contactDisplayName = (contact: DistrictContact, idx: number) => {
    const full = `${contact.first_name} ${contact.last_name}`.trim();
    return full || `Contact ${idx + 1}`;
  };
  const syncDistrictContacts = (nextContacts: DistrictContact[]) => {
    setDistrictContacts(nextContacts);
    setDraft((d) => ({ ...d, district_contact: serializeDistrictContacts(nextContacts) }));
  };
  const addDistrictContact = () => {
    if (!canEdit) return;
    const nextContact: DistrictContact = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      first_name: "",
      last_name: "",
      s_number: "",
      phone: "",
      cell_phone: "",
    };
    const nextContacts = [...districtContacts, nextContact];
    syncDistrictContacts(nextContacts);
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

  const toggleIncidentType = (option: IncidentTypeOption) => {
    if (!canEdit) return;
    const active = inc.includes(option.code) || (!!option.key && draft[option.key] === "YES");
    const selecting = !active;
    setInc((prev) => {
      const without = prev.filter((code) => code !== option.code);
      return selecting ? [...without, option.code] : without;
    });
    if (option.key) {
      setDraft((prev) => ({ ...prev, [option.key as string]: selecting ? "YES" : "NO" }));
    }
  };
  const selectMaterialPrimary = (key: "material_rock" | "material_soil") => {
    if (!canEdit) return;
    const selecting = draft[key] !== "YES";
    if (!selecting) {
      setDraft((prev) => ({
        ...prev,
        material_rock: "NO",
        material_soil: "NO",
        material_bedding: "NO",
        material_joints: "NO",
        material_fractures: "NO",
        est_clay_pct: "",
        est_silt_pct: "",
        est_sand_pct: "",
        est_gravel_pct: "",
      }));
      return;
    }
    if (key === "material_rock") {
      setDraft((prev) => ({
        ...prev,
        material_rock: "YES",
        material_soil: "NO",
        est_clay_pct: "",
        est_silt_pct: "",
        est_sand_pct: "",
        est_gravel_pct: "",
      }));
      return;
    }
    setDraft((prev) => ({
      ...prev,
      material_soil: "YES",
      material_rock: "NO",
      material_bedding: "NO",
      material_joints: "NO",
      material_fractures: "NO",
    }));
  };
  const selectRockSubtype = (key: "material_bedding" | "material_joints" | "material_fractures") => {
    if (!canEdit || draft.material_rock !== "YES") return;
    const selecting = draft[key] !== "YES";
    setDraft((prev) => ({
      ...prev,
      material_bedding: key === "material_bedding" && selecting ? "YES" : "NO",
      material_joints: key === "material_joints" && selecting ? "YES" : "NO",
      material_fractures: key === "material_fractures" && selecting ? "YES" : "NO",
    }));
  };
  const selectSingleDrainage = (key: typeof drainageKeys[number]) => {
    if (!canEdit) return;
    const selecting = draft[key] !== "YES";
    setDraft((prev) => {
      const next = { ...prev };
      for (const k of drainageKeys) next[k] = k === key && selecting ? "YES" : "NO";
      return next;
    });
  };
  const selectBaseWaterContent = (key: typeof baseWaterKeys[number]) => {
    if (!canEdit) return;
    const selecting = draft[key] !== "YES";
    setDraft((prev) => {
      const next = { ...prev };
      for (const k of baseWaterKeys) next[k] = k === key && selecting ? "YES" : "NO";
      if (!selecting || key !== "water_flowing") {
        next.water_seep = "NO";
        next.water_spring = "NO";
      }
      return next;
    });
  };
  const selectFlowingSubtype = (key: "water_seep" | "water_spring") => {
    if (!canEdit || draft.water_flowing !== "YES") return;
    const selecting = draft[key] !== "YES";
    setDraft((prev) => ({
      ...prev,
      water_seep: key === "water_seep" && selecting ? "YES" : "NO",
      water_spring: key === "water_spring" && selecting ? "YES" : "NO",
    }));
  };
  const setImpactSelection = (
    impactedKey: "impact_impacted_adj_utilities" | "impact_impacted_adj_properties" | "impact_impacted_adj_structure",
    maybeKey: "impact_maybe_adj_utilities" | "impact_maybe_adj_properties" | "impact_maybe_adj_structure",
    target: "IMPACTED" | "MAYBE"
  ) => {
    if (!canEdit) return;
    if (target === "IMPACTED") {
      const next = draft[impactedKey] === "YES" ? "UNKNOWN" : "YES";
      setDraft((prev) => ({ ...prev, [impactedKey]: next, [maybeKey]: next === "YES" ? "UNKNOWN" : prev[maybeKey] }));
      return;
    }
    const next = draft[maybeKey] === "YES" ? "UNKNOWN" : "YES";
    setDraft((prev) => ({ ...prev, [maybeKey]: next, [impactedKey]: next === "YES" ? "UNKNOWN" : prev[impactedKey] }));
  };
  useEffect(() => {
    if (!highwayLanesClosedSelected && draft.lanes_closed_count) {
      setDraft((prev) => ({ ...prev, lanes_closed_count: "" }));
    }
  }, [highwayLanesClosedSelected, draft.lanes_closed_count]);
  useEffect(() => {
    if (!openHighwayTrafficSelected && draft.open_highway_traffic_lanes_count) {
      setDraft((prev) => ({ ...prev, open_highway_traffic_lanes_count: "" }));
    }
  }, [openHighwayTrafficSelected, draft.open_highway_traffic_lanes_count]);
  useEffect(() => {
    if (draft.pavement_ground_cracks === "NO") {
      setDraft((prev) => ({
        ...prev,
        crack_length_ft: "",
        crack_horizontal_in: "",
        crack_vertical_in: "",
        crack_depth_in: "",
      }));
    }
  }, [draft.pavement_ground_cracks]);
  useEffect(() => {
    const items = Object.entries(INCIDENT_TYPE_CODE_BY_FORM_KEY)
      .filter(([k]) => draft[k] === "YES")
      .map(([, code]) => code);
    setInc((prev) => Array.from(new Set([
      ...items,
      ...prev.filter((code) => !INCIDENT_TYPE_FORM_CODES.has(code)),
    ])));
  }, [
    draft.failure_rock_fall,
    draft.failure_topple,
    draft.failure_slide,
    draft.failure_spread,
    draft.failure_flow,
    draft.failure_compound,
    draft.failure_erosion,
    draft.failure_surficial_failure,
    draft.failure_scoured_toe,
    draft.failure_washout,
  ]);
  return (
    <AppShell title={invalid ? "Submission" : (data ? buildSubmissionDisplayTitle({
      id: data.submission.id,
      created_at: data.submission.created_at,
      district: data.gisa?.district,
      county: data.gisa?.county,
      route: data.gisa?.route,
      post_mile: data.gisa?.post_mile,
    }) : `Submission ${sid}`)}>
      <div className="p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <Link className="text-sm underline text-muted" to="/submissions">{"<-"} Back to submissions</Link>
            {data?.submission ? <div className="mt-2"><S s={data.submission.status} /></div> : null}
          </div>
          <div className="flex gap-2">
            <div className="relative">
              <button
                onClick={() => setMenuOpen((prev) => !prev)}
                disabled={invalid}
                className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm hover:brightness-95 disabled:opacity-60"
                title="Submission options"
              >
                ...
              </button>
              {menuOpen ? (
                <div className="absolute right-0 top-10 z-10 min-w-36 rounded-md border border-[var(--line)] bg-[var(--panel)] p-1 shadow-lg">
                  <button
                    onClick={load}
                    className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--panel-soft)]"
                  >
                    Refresh
                  </button>
                  {canDeleteSubmission ? (
                    <button
                      onClick={onDeleteSubmission}
                      className="block w-full rounded px-2 py-1.5 text-left text-xs text-red-600 hover:bg-[color:color-mix(in_oklab,var(--bad)_12%,transparent)]"
                    >
                      Delete
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
            <button onClick={load} disabled={busy || invalid} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm hover:brightness-95 disabled:opacity-60">Refresh</button>
            <button onClick={() => review("APPROVE")} disabled={busy || invalid || !canAct} className="rounded-md bg-[var(--brand)] px-3 py-2 text-sm text-white hover:brightness-95 disabled:opacity-60">Approve</button>
            <button onClick={() => review("REJECT")} disabled={busy || invalid || !canAct} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm hover:brightness-95 disabled:opacity-60">Reject</button>
          </div>
        </div>

        {err && <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>}
        {invalid && <div className="mt-4 rounded-md border border-[var(--line)] bg-[var(--panel-soft)] p-4 text-sm text-muted">Invalid submission id.</div>}
        {!invalid && !data && <div className="mt-4 text-sm text-muted">{busy ? "Loading..." : "No data."}</div>}

        {!invalid && data && (
          <div className="mt-4 space-y-3">
            <section className="pt-1">
                <fieldset disabled={!canEdit} className="contents">
                <div className="mt-3 rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold uppercase tracking-wide text-[var(--brand)]">Location And ERIS Map</div>
                    <button onClick={autofillFromGps} disabled={busy || geoBusy} className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-1.5 text-xs disabled:opacity-60">{geoBusy ? "Detecting..." : "Use GPS Autofill"}</button>
                  </div>
                  <SubmissionArcGisMap
                    geojson={geom}
                    location={{ latitude: draft.latitude ? Number(draft.latitude) : null, longitude: draft.longitude ? Number(draft.longitude) : null }}
                    height={300}
                    editable={canEdit}
                    onGeometryChange={onMapGeometryChange}
                  />
                  {geoSaveMessage ? (
                    <div className={`mt-2 text-xs ${geoSaveState === "error" ? "text-red-700" : "text-muted"}`}>
                      {geoSaveMessage}
                    </div>
                  ) : null}
                </div>
                <div className="mt-3 rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold uppercase tracking-wide text-[var(--brand)]">GISA Sheet Layout</div>
                    <div className="flex items-center gap-2 flex-wrap justify-end">
                      <select
                        className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1 text-xs"
                        value={activeLayoutProfile}
                        onChange={(e) => loadLayoutProfile(e.target.value)}
                      >
                        {layoutProfileNames.map((name) => (
                          <option key={name} value={name}>{name}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={saveCurrentLayoutAsProfile}
                        className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1 text-xs"
                      >
                        Save As
                      </button>
                      {activeLayoutProfile !== "Default" ? (
                        <button
                          type="button"
                          onClick={deleteActiveLayoutProfile}
                          className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1 text-xs text-red-700"
                        >
                          Delete
                        </button>
                      ) : null}
                      {layoutMode ? (
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedCardId(null);
                            const defaultLayout = buildDefaultDashboardLayout();
                            setDashboardLayout(defaultLayout);
                          }}
                          className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1 text-xs"
                        >
                          Reset Layout
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => {
                          if (layoutMode) {
                            const canvasWidth = Math.max(720, layoutCanvasRef.current?.clientWidth ?? 1400);
                            setDashboardLayout((prev) => tidyLayoutPositions(prev, orderedVisibleCardIds, canvasWidth));
                            setSelectedCardId(null);
                            setLayoutMode(false);
                            return;
                          }
                          setLayoutMode(true);
                        }}
                        className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1 text-xs"
                      >
                        {layoutMode ? "Done Layout" : "Customize Layout"}
                      </button>
                    </div>
                  </div>
                  {layoutMode ? (
                    <div className="mb-2 text-xs text-muted">Click a container to select it, then drag anywhere inside to move. Resize handles appear only on the selected container.</div>
                  ) : null}
                  <div
                    ref={layoutCanvasRef}
                    className={layoutMode
                      ? "relative min-h-[620px] rounded-md border border-dashed border-[var(--line)]/70 bg-[color:color-mix(in_oklab,var(--panel-soft)_65%,transparent)]"
                      : "relative min-h-[620px] rounded-md"}
                    style={{ height: `${layoutCanvasHeight}px` }}
                  >
                    <div {...cardFrameProps("report_header")}>
                      {layoutTools("report_header")}
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--brand)]">Report Header</div>
                      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2">
                        <div>
                          <label className={label}>Report Date (YYYY-MM-DD)</label>
                          <input className={input} value={draft.report_date} onChange={(e)=>setDraft((d)=>({...d,report_date:e.target.value}))} />
                        </div>
                        <div>
                          <label className={label}>Date Incident Reported</label>
                          <input className={input} value={draft.date_incident_reported} onChange={(e)=>setDraft((d)=>({...d,date_incident_reported:e.target.value}))} />
                        </div>
                        <div>
                          <label className={label}>District</label>
                          <select
                            className={input}
                            value={draft.district}
                            onChange={(e) =>
                              setDraft((d) => {
                                const district = e.target.value;
                                const nextCountyOptions = countiesForDistrict(district);
                                const county = nextCountyOptions.includes(d.county) ? d.county : "";
                                const nextRouteOptions = routesForDistrictCounty(district, county);
                                const route = nextRouteOptions.includes(d.route) ? d.route : "";
                                return { ...d, district, county, route };
                              })
                            }
                          >
                            <option value="">Select district</option>
                            {CALTRANS_DISTRICTS.map((d) => <option key={d} value={d}>{`District ${d}`}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className={label}>County</label>
                          <select
                            className={input}
                            value={draft.county}
                            onChange={(e) =>
                              setDraft((d) => {
                                const county = e.target.value;
                                const routeChoices = routesForDistrictCounty(d.district, county);
                                const route = routeChoices.includes(d.route) ? d.route : "";
                                return { ...d, county, route };
                              })
                            }
                            disabled={!draft.district}
                          >
                            <option value="">Select county</option>
                            {countyOptions.map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className={label}>Highway (Route)</label>
                          <select
                            className={input}
                            value={draft.route}
                            onChange={(e)=>setDraft((d)=>({...d,route:e.target.value}))}
                            disabled={!draft.district || !draft.county}
                          >
                            <option value="">Select route</option>
                            {routeOptions.map((r) => <option key={r} value={r}>{r}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className={label}>Post Mile</label>
                          <input className={input} value={draft.post_mile} onChange={(e)=>setDraft((d)=>({...d,post_mile:e.target.value}))} onBlur={()=>setDraft((d)=>({...d,post_mile: normalizePostMileInput(d.post_mile)}))} />
                        </div>
                        <div>
                          <label className={label}>EA</label>
                          <input className={input} value={draft.ea} onChange={(e)=>setDraft((d)=>({...d,ea:e.target.value}))} />
                        </div>
                        <div>
                          <label className={label}>Project ID</label>
                          <input className={input} value={draft.project_id} onChange={(e)=>setDraft((d)=>({...d,project_id:e.target.value}))} />
                        </div>
                        <div className="col-span-full">
                          <label className={label}>District Contacts</label>
                          {districtContacts.length === 0 ? (
                            <div className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm text-muted">
                              No district contacts added yet.
                            </div>
                          ) : (
                            <div className="space-y-2">
                              {districtContacts.map((contact, idx) => {
                                const isOpen = !!openDistrictContactIds[contact.id];
                                return (
                                  <div key={contact.id} className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] p-2">
                                    <button
                                      type="button"
                                      className="flex w-full items-center justify-between rounded px-1 py-1 text-left hover:bg-[var(--panel)]"
                                      onClick={() => toggleDistrictContact(contact.id)}
                                    >
                                      <span className="text-sm font-medium">{contactDisplayName(contact, idx)}</span>
                                      <span className="text-xs text-muted">{isOpen ? "v" : ">"}</span>
                                    </button>
                                    {isOpen ? (
                                      <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2">
                                        <div><label className={label}>First Name</label><input className={input} value={contact.first_name} onChange={(e) => updateDistrictContact(contact.id, "first_name", e.target.value)} disabled={!canEdit} /></div>
                                        <div><label className={label}>Last Name</label><input className={input} value={contact.last_name} onChange={(e) => updateDistrictContact(contact.id, "last_name", e.target.value)} disabled={!canEdit} /></div>
                                        <div><label className={label}>S Number</label><input className={input} value={contact.s_number} onChange={(e) => updateDistrictContact(contact.id, "s_number", e.target.value)} disabled={!canEdit} /></div>
                                        <div><label className={label}>Phone</label><input className={input} value={contact.phone} onChange={(e) => updateDistrictContact(contact.id, "phone", e.target.value)} disabled={!canEdit} /></div>
                                        <div><label className={label}>Cell Phone</label><input className={input} value={contact.cell_phone} onChange={(e) => updateDistrictContact(contact.id, "cell_phone", e.target.value)} disabled={!canEdit} /></div>
                                        {canEdit ? (
                                          <div className="col-span-full">
                                            <button
                                              type="button"
                                              className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-xs text-red-700"
                                              onClick={() => removeDistrictContact(contact.id)}
                                            >
                                              Remove Contact
                                            </button>
                                          </div>
                                        ) : null}
                                      </div>
                                    ) : null}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          {draft.district_contact.trim() && districtContacts.length === 0 ? (
                            <details className="mt-2 rounded-md border border-[var(--line)] bg-[var(--panel-soft)] p-2">
                              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted">
                                Raw Contact Data
                              </summary>
                              <textarea
                                className="mt-2 w-full rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-2 text-xs font-mono"
                                rows={5}
                                value={draft.district_contact}
                                onChange={(e) => setDraft((d) => ({ ...d, district_contact: e.target.value }))}
                                disabled={!canEdit}
                              />
                            </details>
                          ) : null}
                          <div className="mt-2">
                            <button
                              type="button"
                              onClick={addDistrictContact}
                              disabled={!canEdit}
                              className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1 text-xs disabled:opacity-60"
                            >
                              Add District Contact
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div {...cardFrameProps("location")}>
                      {layoutTools("location")}
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--brand)]">Location</div>
                        <div className="flex flex-wrap items-center gap-2">
                          <button onClick={autofillFromGps} disabled={busy || geoBusy} className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1 text-xs disabled:opacity-60">{geoBusy ? "Detecting..." : "GPS Autofill"}</button>
                          <button
                            type="button"
                            onClick={() => setShowNorthingEasting((prev) => !prev)}
                            disabled={!statePlaneCoordinates}
                            className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1 text-xs disabled:opacity-60"
                          >
                            {showNorthingEasting ? "Hide N/E" : "Show N/E"}
                          </button>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className={label}>Latitude</label>
                          <input type="number" step="0.000001" inputMode="decimal" className={input} value={draft.latitude} onChange={(e)=>setDraft((d)=>({...d,latitude:e.target.value}))} onBlur={()=>setDraft((d)=>({...d,latitude: formatCoordinate(d.latitude)}))} />
                        </div>
                        <div>
                          <label className={label}>Longitude</label>
                          <input type="number" step="0.000001" inputMode="decimal" className={input} value={draft.longitude} onChange={(e)=>setDraft((d)=>({...d,longitude:e.target.value}))} onBlur={()=>setDraft((d)=>({...d,longitude: formatCoordinate(d.longitude)}))} />
                        </div>
                      </div>
                      {showNorthingEasting && statePlaneCoordinates ? (
                        <div className="mt-2 rounded-md border border-[var(--line)]/70 bg-[var(--panel)] p-2">
                          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
                            CCS83 Zone {statePlaneCoordinates.zone} · {statePlaneCoordinates.units}
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className={label}>Northing</label>
                                <input
                                  type="number"
                                  step="0.001"
                                  inputMode="decimal"
                                  className={input}
                                  value={northingInput}
                                  onChange={(e) => {
                                    setNorthingInput(e.target.value);
                                    if (statePlaneInputError) setStatePlaneInputError(null);
                                  }}
                                  onBlur={applyStatePlaneInputs}
                                  disabled={!canEdit}
                                />
                            </div>
                            <div>
                              <label className={label}>Easting</label>
                                <input
                                  type="number"
                                  step="0.001"
                                  inputMode="decimal"
                                  className={input}
                                  value={eastingInput}
                                  onChange={(e) => {
                                    setEastingInput(e.target.value);
                                    if (statePlaneInputError) setStatePlaneInputError(null);
                                  }}
                                  onBlur={applyStatePlaneInputs}
                                  disabled={!canEdit}
                                />
                            </div>
                          </div>
                          {statePlaneInputError ? (
                            <div className="mt-2 text-xs text-[var(--bad)]">{statePlaneInputError}</div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>

                    <div {...cardFrameProps("distribution")}>
                      {layoutTools("distribution")}
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--brand)]">Distribution</div>
                      <label className={label}>Distribution</label>
                      <div className="mb-2 flex flex-wrap gap-2">
                        {(lookups?.distribution ?? []).map((x) => {
                          const active = draft.distribution_code === x.code;
                          return (
                            <button
                              key={x.code}
                              type="button"
                              onClick={() => setDraft((d) => ({ ...d, distribution_code: active ? "" : x.code }))}
                              className={`inline-flex items-center gap-2 rounded border px-2 py-1.5 text-xs ${active ? "border-[var(--brand)] text-[var(--brand)]" : "border-[var(--line)] text-[var(--ink)]"}`}
                            >
                              <img src={DISTRIBUTION_ICON_SRC[x.code] ?? ""} alt="" aria-hidden className="h-10 w-10 object-contain" />
                              <span>{x.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div {...cardFrameProps("highway_status")}>
                      {layoutTools("highway_status")}
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--brand)]">Highway Status</div>
                      <div className="mb-3">
                        <label className={label}>Cause Of Highway Status</label>
                        <input
                          type="text"
                          className={input}
                          value={draft.highway_status_cause}
                          onChange={(e) => setDraft((d) => ({ ...d, highway_status_cause: e.target.value }))}
                          disabled={!canEdit}
                          placeholder="Describe the cause before choosing a highway status"
                        />
                      </div>
                      {showHighwayStatusOptions ? (
                        <>
                          <label className={label}>Highway Status</label>
                          <div className="mb-2 flex flex-wrap gap-2">
                            {(lookups?.highway_status ?? []).map((x) => {
                              const active = draft.highway_status_code === x.code;
                              return (
                                <button key={x.code} type="button" onClick={() => canEdit && setDraft((d) => ({ ...d, highway_status_code: active ? "" : x.code }))} className={`${chip} ${ynChip(active)}`}>
                                  {x.label}
                                </button>
                              );
                            })}
                          </div>
                          <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2">
                            {highwayLanesClosedSelected ? (
                              <div>
                                <label className={label}>Lane(s) Closed Count</label>
                                <select className={input} value={draft.lanes_closed_count} onChange={(e)=>setDraft((d)=>({...d,lanes_closed_count:e.target.value}))}>
                                  <option value="">Select lanes closed</option>
                                  {LANES_CLOSED_OPTIONS.map((v) => <option key={`lanes-closed-${v}`} value={v}>{v}</option>)}
                                </select>
                              </div>
                            ) : null}
                            {openHighwayTrafficSelected ? (
                              <div>
                                <label className={label}>Open Highway Traffic Lanes</label>
                                <input type="number" step="1" inputMode="numeric" className={input} value={draft.open_highway_traffic_lanes_count} onChange={(e)=>setDraft((d)=>({...d,open_highway_traffic_lanes_count:e.target.value}))} />
                              </div>
                            ) : null}
                          </div>
                        </>
                      ) : (
                        <div className="text-xs text-muted">Enter the cause above to reveal the highway status options.</div>
                      )}
                    </div>

                    <div {...cardFrameProps("incident_type")}>
                      {layoutTools("incident_type")}
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--brand)]">Incident Type</div>
                      <div className="grid grid-cols-2 gap-2">
                        {INCIDENT_TYPE_OPTIONS.map((option) => (
                          <button
                            key={option.code}
                            type="button"
                            onClick={() => toggleIncidentType(option)}
                            className={`${chip} text-left ${ynChip(inc.includes(option.code) || (!!option.key && draft[option.key] === "YES"))}`}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                      <div className="mt-3">
                        <label className={label}>Incident Type Description</label>
                        <textarea
                          className={`${input} min-h-24`}
                          value={draft.incident_type_description}
                          onChange={(e) => setDraft((d) => ({ ...d, incident_type_description: e.target.value }))}
                          disabled={!canEdit}
                        />
                      </div>
                    </div>

                    <div {...cardFrameProps("material")}>
                      {layoutTools("material")}
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--brand)]">Material</div>
                      <div className="mb-2 flex gap-2">
                        <button type="button" onClick={() => selectMaterialPrimary("material_rock")} className={`${chip} ${ynChip(materialRockSelected)}`}>Rock</button>
                        <button type="button" onClick={() => selectMaterialPrimary("material_soil")} className={`${chip} ${ynChip(materialSoilSelected)}`}>Soil</button>
                      </div>
                      {materialRockSelected ? (
                        <div className="mb-2 flex flex-wrap gap-2">
                          <button type="button" onClick={() => selectRockSubtype("material_bedding")} className={`${chip} ${ynChip(draft.material_bedding === "YES")}`}>Bedding</button>
                          <button type="button" onClick={() => selectRockSubtype("material_joints")} className={`${chip} ${ynChip(draft.material_joints === "YES")}`}>Joints</button>
                          <button type="button" onClick={() => selectRockSubtype("material_fractures")} className={`${chip} ${ynChip(draft.material_fractures === "YES")}`}>Fractures</button>
                        </div>
                      ) : null}
                      {materialSoilSelected ? (
                        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2">
                          <div><label className={label}>Clay Est %</label><input type="number" step="any" inputMode="decimal" className={input} value={draft.est_clay_pct} onChange={(e)=>setDraft((d)=>({...d,est_clay_pct:e.target.value}))} /></div>
                          <div><label className={label}>Silt Est %</label><input type="number" step="any" inputMode="decimal" className={input} value={draft.est_silt_pct} onChange={(e)=>setDraft((d)=>({...d,est_silt_pct:e.target.value}))} /></div>
                          <div><label className={label}>Sand Est %</label><input type="number" step="any" inputMode="decimal" className={input} value={draft.est_sand_pct} onChange={(e)=>setDraft((d)=>({...d,est_sand_pct:e.target.value}))} /></div>
                          <div><label className={label}>Gravel Est %</label><input type="number" step="any" inputMode="decimal" className={input} value={draft.est_gravel_pct} onChange={(e)=>setDraft((d)=>({...d,est_gravel_pct:e.target.value}))} /></div>
                        </div>
                      ) : null}
                    </div>

                    <div {...cardFrameProps("pavement_ground_status")}>
                      {layoutTools("pavement_ground_status")}
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--brand)]">Pavement / Ground Status</div>
                      <label className={label}>Pavement/Ground Cracks</label>
                      <div className="mb-2 flex gap-2">
                        {(["YES", "NO"] as const).map((c) => (
                          <button key={`crack-${c}`} type="button" onClick={() => canEdit && setDraft((d) => ({ ...d, pavement_ground_cracks: c }))} className={`${chip} ${ynChip(draft.pavement_ground_cracks === c)}`}>
                            {c}
                          </button>
                        ))}
                      </div>
                      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2">
                        {draft.pavement_ground_cracks === "YES" ? (
                          <>
                            <div><label className={label}>Length (feet)</label><input type="number" step="any" inputMode="decimal" className={input} value={draft.crack_length_ft} onChange={(e)=>setDraft((d)=>({...d,crack_length_ft:e.target.value}))} /></div>
                            <div><label className={label}>Horizontal Disp (inches)</label><input type="number" step="any" inputMode="decimal" className={input} value={draft.crack_horizontal_in} onChange={(e)=>setDraft((d)=>({...d,crack_horizontal_in:e.target.value}))} /></div>
                            <div><label className={label}>Vertical Disp (inches)</label><input type="number" step="any" inputMode="decimal" className={input} value={draft.crack_vertical_in} onChange={(e)=>setDraft((d)=>({...d,crack_vertical_in:e.target.value}))} /></div>
                            <div><label className={label}>Depth of Crack (inches)</label><input type="number" step="any" inputMode="decimal" className={input} value={draft.crack_depth_in} onChange={(e)=>setDraft((d)=>({...d,crack_depth_in:e.target.value}))} /></div>
                          </>
                        ) : null}
                        <div><label className={label}>Settlement (inches)</label><input type="number" step="any" inputMode="decimal" className={input} value={draft.settlement_in} onChange={(e)=>setDraft((d)=>({...d,settlement_in:e.target.value}))} /></div>
                        <div><label className={label}>Bulge (inches)</label><input type="number" step="any" inputMode="decimal" className={input} value={draft.bulge_in} onChange={(e)=>setDraft((d)=>({...d,bulge_in:e.target.value}))} /></div>
                      </div>
                      <label className={`${label} mt-2`}>Indented by Rocks</label>
                      <div className="flex gap-2">
                        {(["YES", "NO"] as const).map((c) => (
                          <button key={`rock-${c}`} type="button" onClick={() => canEdit && setDraft((d) => ({ ...d, indented_by_rocks: c }))} className={`${chip} ${ynChip(draft.indented_by_rocks === c)}`}>
                            {c}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div {...cardFrameProps("vegetation_on_slope")}>
                      {layoutTools("vegetation_on_slope")}
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--brand)]">Vegetation on Slope</div>
                      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2">
                        <div><label className={label}>Trees Coverage %</label><input type="number" step="0.01" min="0" max="100" inputMode="decimal" className={input} value={draft.vegetation_trees} onChange={(e)=>setDraft((d)=>({...d,vegetation_trees:e.target.value}))} /></div>
                        <div><label className={label}>Bushes/Shrubs Coverage %</label><input type="number" step="0.01" min="0" max="100" inputMode="decimal" className={input} value={draft.vegetation_bushes_shrubs} onChange={(e)=>setDraft((d)=>({...d,vegetation_bushes_shrubs:e.target.value}))} /></div>
                        <div className="col-span-full"><label className={label}>Groundcover Coverage %</label><input type="number" step="0.01" min="0" max="100" inputMode="decimal" className={input} value={draft.vegetation_groundcover} onChange={(e)=>setDraft((d)=>({...d,vegetation_groundcover:e.target.value}))} /></div>
                      </div>
                    </div>

                    <div {...cardFrameProps("water_drainage")}>
                      {layoutTools("water_drainage")}
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--brand)]">Water / Drainage</div>
                      <div className="mb-2 flex flex-wrap gap-2">
                        {[["drainage_clogged_inlet", "Clogged Inlet"], ["drainage_compromised_drains", "Compromised Drains"], ["drainage_surface_runoff", "Surface Runoff"], ["drainage_torrent_surge_flood", "Torrent/Surge/Flood"]].map(([key, text]) => (
                          <button key={key} type="button" onClick={() => selectSingleDrainage(key as typeof drainageKeys[number])} className={`${chip} ${ynChip(draft[key] === "YES")}`}>{text}</button>
                        ))}
                      </div>
                      <div className="grid grid-cols-1 gap-2">
                        {[["impact_impacted_adj_utilities", "impact_maybe_adj_utilities", "Adjacent Utilities"], ["impact_impacted_adj_properties", "impact_maybe_adj_properties", "Adjacent Properties"], ["impact_impacted_adj_structure", "impact_maybe_adj_structure", "Adjacent Structures"]].map(([imp, may, text]) => (
                          <div key={text} className="grid grid-cols-[auto_auto_1fr] items-center gap-2">
                            <button type="button" onClick={() => setImpactSelection(imp as any, may as any, "IMPACTED")} className={`${chip} ${ynChip(draft[imp] === "YES")}`}>Impacted</button>
                            <button type="button" onClick={() => setImpactSelection(imp as any, may as any, "MAYBE")} className={`${chip} ${ynChip(draft[may] === "YES")}`}>Maybe</button>
                            <span className="text-sm">{text}</span>
                          </div>
                        ))}
                        <div><label className={label}>Adjacent Utilities Notes</label><input className={input} value={draft.impact_adj_utilities} onChange={(e)=>setDraft((d)=>({...d,impact_adj_utilities:e.target.value}))} /></div>
                        <div><label className={label}>Adjacent Properties Notes</label><input className={input} value={draft.impact_adj_properties} onChange={(e)=>setDraft((d)=>({...d,impact_adj_properties:e.target.value}))} /></div>
                        <div><label className={label}>Adjacent Structures Notes</label><input className={input} value={draft.impact_adj_structure} onChange={(e)=>setDraft((d)=>({...d,impact_adj_structure:e.target.value}))} /></div>
                      </div>
                    </div>

                    <div {...cardFrameProps("water_content")}>
                      {layoutTools("water_content")}
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--brand)]">Water Content</div>
                      <div className="mb-2 flex flex-wrap gap-2">
                        {[["water_dry", "Dry"], ["water_moist", "Moist"], ["water_wet", "Wet"], ["water_flowing", "Flowing"]].map(([key, text]) => (
                          <button key={key} type="button" onClick={() => selectBaseWaterContent(key as typeof baseWaterKeys[number])} className={`${chip} ${ynChip(draft[key] === "YES")}`}>{text}</button>
                        ))}
                      </div>
                      {waterFlowingSelected ? (
                        <div className="mb-2 flex gap-2">
                          <button type="button" onClick={() => selectFlowingSubtype("water_seep")} className={`${chip} ${ynChip(draft.water_seep === "YES")}`}>Seep</button>
                          <button type="button" onClick={() => selectFlowingSubtype("water_spring")} className={`${chip} ${ynChip(draft.water_spring === "YES")}`}>Spring</button>
                        </div>
                      ) : null}
                    </div>

                    <div {...cardFrameProps("measurements")}>
                        {layoutTools("measurements")}
                        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--brand)]">Measurements</div>
                        {data.gisa?.road_inventory_context ? (() => {
                          const ri = data.gisa!.road_inventory_context!;
                          const sn = ri.snapshot ?? {};
                          const terrainCode = (sn.terrain_code ?? sn.THY_TERRAIN_CODE) as string | null | undefined;
                          return (
                            <div className="mb-2 rounded border border-[color:color-mix(in_oklab,var(--good)_32%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_8%,transparent)] px-2.5 py-2 text-xs">
                              <div className="mb-1 font-semibold text-[var(--good)]">Road inventory context</div>
                              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted">
                                {sn.county_code != null && <span>County: <span className="text-[var(--ink)]">{String(sn.county_code)}</span></span>}
                                {sn.route_name != null && <span>Route: <span className="text-[var(--ink)]">{String(sn.route_name)}</span></span>}
                                {(sn.begin_pm != null || sn.end_pm != null) && (
                                  <span className="col-span-2">Postmile: <span className="text-[var(--ink)]">{String(sn.begin_pm ?? "?")} – {String(sn.end_pm ?? "?")} mi</span></span>
                                )}
                                {terrainCode && (
                                  <span className="col-span-2">Terrain: <span className="text-[var(--ink)]">{terrainLabel(terrainCode)}</span></span>
                                )}
                                {(sn.left_lanes != null || sn.right_lanes != null) && (
                                  <span>Lanes: <span className="text-[var(--ink)]">{sn.left_lanes != null ? `${sn.left_lanes} LT` : "?"} / {sn.right_lanes != null ? `${sn.right_lanes} RT` : "?"}</span></span>
                                )}
                                <span>Match: <span className="text-[var(--ink)]">{ri.match_method ?? "—"}</span></span>
                                {ri.checked_at && <span>Checked: <span className="text-[var(--ink)]">{ri.checked_at.slice(0, 10)}</span></span>}
                              </div>
                              {/* Expandable field details */}
                              <button
                                type="button"
                                onClick={() => setRiDetailsOpen((v) => !v)}
                                className="mt-1.5 text-[10px] font-medium text-[var(--good)] hover:opacity-80"
                              >
                                {riDetailsOpen ? "▲ Hide field details" : "▼ Field meanings & raw values"}
                              </button>
                              {riDetailsOpen && Object.keys(sn).length > 0 && (
                                <div className="mt-2 border-t border-[color:color-mix(in_oklab,var(--good)_20%,transparent)] pt-2">
                                  <div className="mb-1 text-[9px] italic text-[var(--good)]">
                                    CA Highways (HICOMP) dataset — v{ri.dataset_version_id}, segment {ri.segment_id}. Raw field names shown for traceability.
                                  </div>
                                  <div className="grid grid-cols-1 gap-y-1">
                                    {Object.entries(sn).map(([key, val]) => (
                                      <div key={key} className="text-[10px]">
                                        <span className="font-medium text-[var(--ink)]">{friendlyFieldLabel(key)}: </span>
                                        <span className="text-[var(--ink)]">{friendlyFieldValue(key, val)}</span>
                                        <span className="ml-1 text-[var(--muted)] opacity-60">({key})</span>
                                        {fieldDescription(key) && (
                                          <div className="text-[9px] italic text-muted pl-2">{fieldDescription(key)}</div>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                              <div className="mt-1 text-[10px] italic text-[var(--good)]">
                                Road inventory values from the published CA Highways dataset.
                              </div>
                            </div>
                          );
                        })() : (
                          <div className="mb-2 text-xs italic text-muted">No road inventory context. Diagram uses form / default roadway assumptions.</div>
                        )}
                        {/* Elevation profile panel */}
                        {(() => {
                          const ep = data.gisa?.elevation_profile;
                          const epMeta = (ep?.profile as Record<string, unknown> | null | undefined)?.metadata as Record<string, unknown> | null | undefined;
                          const bearingUsed = epMeta?.road_bearing_deg_used as number | null | undefined;
                          const bearingSource = epMeta?.road_bearing_source as string | null | undefined;
                          const bearingNote = bearingUsed != null
                            ? `${bearingUsed}° (${bearingSource ?? "request"})`
                            : "not set — classification may be UNKNOWN";
                          return ep ? (
                            <div className="mb-2 rounded border border-[color:color-mix(in_oklab,var(--brand)_28%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_6%,transparent)] px-2.5 py-2 text-xs">
                              <div className="mb-1.5 flex items-center justify-between">
                                <span className="font-semibold text-[var(--brand)]">Elevation profile</span>
                                <button
                                  disabled={elevFetching}
                                  onClick={() => fetchElevation(true)}
                                  className="rounded bg-[var(--brand)] px-2 py-0.5 text-[10px] font-medium text-white opacity-80 hover:opacity-100 disabled:opacity-40"
                                >
                                  {elevFetching ? "Refreshing…" : "Refresh"}
                                </button>
                              </div>
                              {/* Bearing input for re-fetch */}
                              <div className="mb-1.5 flex items-center gap-2">
                                <label className="shrink-0 text-[10px] text-muted">Road bearing (deg):</label>
                                <input
                                  type="number" min="0" max="359" step="1"
                                  placeholder="0–359"
                                  value={bearingInput}
                                  onChange={(e) => setBearingInput(e.target.value)}
                                  className="w-20 rounded border border-[var(--line)] bg-[var(--panel)] px-1.5 py-0.5 text-[10px] text-[var(--ink)]"
                                />
                                <span className="text-[9px] italic text-muted">Optional. Needed for left/right terrain classification.</span>
                              </div>
                              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted">
                                <span>Source: <span className="text-[var(--ink)]">{ep.source ?? "—"}</span></span>
                                <span>Classification: <span className="text-[var(--ink)]">{ep.classification ?? "—"}</span></span>
                                {ep.confidence != null && (
                                  <span>Confidence: <span className="text-[var(--ink)]">{(ep.confidence * 100).toFixed(0)}%</span></span>
                                )}
                                {ep.checked_at && (
                                  <span>Checked: <span className="text-[var(--ink)]">{ep.checked_at.slice(0, 10)}</span></span>
                                )}
                                <span className="col-span-2">Bearing: <span className={`${bearingUsed != null ? "text-[var(--ink)]" : "text-[var(--muted)] italic"}`}>{bearingNote}</span></span>
                              </div>
                              {ep.error && (
                                <div className="mt-1 text-[10px] text-[var(--error)]">{ep.error}</div>
                              )}
                              {elevError && <div className="mt-1 text-[10px] text-[var(--error)]">{elevError}</div>}
                            </div>
                          ) : (
                            <div className="mb-2 rounded border border-[color:color-mix(in_oklab,var(--brand)_15%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_4%,transparent)] px-2.5 py-2 text-xs">
                              <div className="mb-1.5 font-semibold text-[var(--brand)]">Elevation profile</div>
                              <div className="mb-1.5 flex items-center gap-2">
                                <label className="shrink-0 text-[10px] text-muted">Road bearing (deg):</label>
                                <input
                                  type="number" min="0" max="359" step="1"
                                  placeholder="0–359"
                                  value={bearingInput}
                                  onChange={(e) => setBearingInput(e.target.value)}
                                  className="w-20 rounded border border-[var(--line)] bg-[var(--panel)] px-1.5 py-0.5 text-[10px] text-[var(--ink)]"
                                />
                                <span className="text-[9px] italic text-muted">Needed for terrain classification.</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-xs italic text-muted">No elevation profile fetched.</span>
                                <button
                                  disabled={elevFetching}
                                  onClick={() => fetchElevation(false)}
                                  className="rounded bg-[var(--brand)] px-2 py-0.5 text-[10px] font-medium text-white opacity-80 hover:opacity-100 disabled:opacity-40"
                                >
                                  {elevFetching ? "Fetching…" : "Fetch Elevation Profile"}
                                </button>
                              </div>
                              {elevError && <div className="mt-1 text-[10px] text-[var(--error)]">{elevError}</div>}
                            </div>
                          );
                        })()}
                        <div className="rounded border border-[var(--line)] bg-[var(--panel-soft)] p-2">
                          <img src="/measurement/landslide.png" alt="Landslide measurement reference with symbols H, alpha, Wd, Ld, Hs, beta, Lr, Wr" className="max-h-64 w-full object-contain" />
                        </div>
                        <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2">
                          <div><label className={label}>Slope Height, ft (H)</label><input type="number" step="any" inputMode="decimal" className={input} value={draft.measure_slope_height_ft} onChange={(e)=>setDraft((d)=>({...d,measure_slope_height_ft:e.target.value}))} /></div>
                          <div><label className={label}>Original Slope, deg (alpha)</label><input type="number" step="any" inputMode="decimal" className={input} value={draft.measure_original_slope_deg} onChange={(e)=>setDraft((d)=>({...d,measure_original_slope_deg:e.target.value}))} /></div>
                          <div><label className={label}>Landslide Width, ft (Wd)</label><input type="number" step="any" inputMode="decimal" className={input} value={draft.measure_landslide_width_ft} onChange={(e)=>setDraft((d)=>({...d,measure_landslide_width_ft:e.target.value}))} /></div>
                          <div><label className={label}>Landslide Length, ft (Ld)</label><input type="number" step="any" inputMode="decimal" className={input} value={draft.measure_landslide_length_ft} onChange={(e)=>setDraft((d)=>({...d,measure_landslide_length_ft:e.target.value}))} /></div>
                          <div><label className={label}>Main Scarp Height, ft (Hs)</label><input type="number" step="any" inputMode="decimal" className={input} value={draft.measure_main_scarp_height_ft} onChange={(e)=>setDraft((d)=>({...d,measure_main_scarp_height_ft:e.target.value}))} /></div>
                          <div><label className={label}>Landslide Slope, deg (beta)</label><input type="number" step="any" inputMode="decimal" className={input} value={draft.measure_landslide_slope_deg} onChange={(e)=>setDraft((d)=>({...d,measure_landslide_slope_deg:e.target.value}))} /></div>
                          <div><label className={label}>Length of Roadway Encroached, ft (Lr)</label><input type="number" step="any" inputMode="decimal" className={input} value={draft.measure_roadway_length_ft} onChange={(e)=>setDraft((d)=>({...d,measure_roadway_length_ft:e.target.value}))} /></div>
                          <div><label className={label}>Width of Roadway Encroached, ft (Wr)</label><input type="number" step="any" inputMode="decimal" className={input} value={draft.measure_roadway_width_ft} onChange={(e)=>setDraft((d)=>({...d,measure_roadway_width_ft:e.target.value}))} /></div>
                        </div>
                    </div>
                  </div>
                  {layoutMode && dragState?.active ? (
                    <div
                      className="pointer-events-none fixed z-50 rounded-md border border-[var(--line)] bg-[var(--panel)]/95 px-2 py-1 text-xs shadow-lg"
                      style={{ left: dragState.x + 14, top: dragState.y + 14 }}
                    >
                      Moving: {DASHBOARD_CARD_TITLES[dragState.id]}
                    </div>
                  ) : null}
                </div>
                <textarea className="mt-2 w-full rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" rows={3} placeholder="Observations" value={draft.observations_notes} onChange={(e)=>setDraft((d)=>({...d,observations_notes:e.target.value}))} />
                <textarea className="mt-2 w-full rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" rows={2} placeholder="Record of Event Notes" value={draft.record_of_event_notes} onChange={(e)=>setDraft((d)=>({...d,record_of_event_notes:e.target.value}))} />
                <textarea className="mt-2 w-full rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" rows={2} placeholder="Maintenance History Notes" value={draft.maintenance_history_notes} onChange={(e)=>setDraft((d)=>({...d,maintenance_history_notes:e.target.value}))} />
                <textarea className="mt-2 w-full rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" rows={2} placeholder="Geotechnical Assessment Notes" value={draft.geotechnical_assessment_notes} onChange={(e)=>setDraft((d)=>({...d,geotechnical_assessment_notes:e.target.value}))} />
                <textarea className="mt-2 w-full rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" rows={2} placeholder="Recommendations Notes" value={draft.recommendations_notes} onChange={(e)=>setDraft((d)=>({...d,recommendations_notes:e.target.value}))} />
                <textarea className="mt-2 w-full rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" rows={2} placeholder="Sketchpad Notes" value={draft.sketchpad_notes} onChange={(e)=>setDraft((d)=>({...d,sketchpad_notes:e.target.value}))} />
                <textarea className="mt-2 w-full rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-mono" rows={4} placeholder='Geometry JSON {"type":"Point","coordinates":[...]} ' value={draft.geometry_json} onChange={(e)=>setDraft((d)=>({...d,geometry_json:e.target.value}))} />
                <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-2">
                  <div><div className="text-xs font-semibold uppercase text-muted">Immediate</div><div className="mt-1 flex flex-wrap gap-1">{(lookups?.actions?.immediate??[]).map((x)=><button key={x.code} type="button" onClick={()=>setImm((p)=>tog(p,x.code))} className={`rounded-full border px-2 py-1 text-xs ${imm.includes(x.code)?"border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_16%,transparent)] text-[var(--brand)]":"border-[var(--line)] bg-[var(--panel)] text-[var(--ink)]"}`}>{x.label}</button>)}</div></div>
                  <div><div className="text-xs font-semibold uppercase text-muted">Follow-Up</div><div className="mt-1 flex flex-wrap gap-1">{(lookups?.actions?.follow_up??[]).map((x)=><button key={x.code} type="button" onClick={()=>setFol((p)=>tog(p,x.code))} className={`rounded-full border px-2 py-1 text-xs ${fol.includes(x.code)?"border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_16%,transparent)] text-[var(--brand)]":"border-[var(--line)] bg-[var(--panel)] text-[var(--ink)]"}`}>{x.label}</button>)}</div></div>
                </div>
                </fieldset>
                {canEdit ? (
                  <>
                    <textarea className="mt-2 w-full rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" rows={2} placeholder="Submit comment (optional)" value={submitNote} onChange={(e)=>setSubmitNote(e.target.value)} />
                    <div className="mt-2 flex gap-2"><button onClick={saveDraft} disabled={busy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm disabled:opacity-60">Save Draft</button><button onClick={submitDraft} disabled={busy} className="rounded-md bg-[var(--good)] px-3 py-2 text-sm text-white disabled:opacity-60">{data.submission.status === "REJECTED" ? "Resubmit for Review" : "Submit for Review"}</button></div>
                  </>
                ) : null}
              </section>

            <Section title="Summary" open>
              <R l="Descriptor" v={buildSubmissionDisplayTitle({
                id: data.submission.id,
                created_at: data.submission.created_at,
                district: data.gisa?.district,
                county: data.gisa?.county,
                route: data.gisa?.route,
                post_mile: data.gisa?.post_mile,
              })} />
              <R l="Created" v={data.submission.created_at} />
              <R l="Updated" v={data.submission.updated_at} />
              <R l="Submitted" v={data.submission.submitted_at} />
              <R l="Reviewed" v={data.submission.reviewed_at} />
              <R l="Status" v={data.submission.status} />
            </Section>


            <Section title="Reviewer Note" open>
              <textarea value={reviewNote} onChange={(e)=>setReviewNote(e.target.value)} rows={3} disabled={busy||!canReview} className="w-full rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" />
            </Section>

            <Section title="Attachments">
              <div className="overflow-x-auto">{data.attachments.length===0?<div className="text-sm text-muted">No attachments.</div>:<table className="w-full border-collapse"><thead><tr className="border-b border-[var(--line)] text-left text-xs font-semibold uppercase tracking-wide text-muted"><th className="py-2 px-2">ID</th><th className="py-2 px-2">File</th><th className="py-2 px-2">Type</th><th className="py-2 px-2">Size</th><th className="py-2 px-2"></th></tr></thead><tbody>{data.attachments.map((a)=><tr key={a.id} className="border-b border-[var(--line)]/50"><td className="py-2 px-2 text-sm">{a.id}</td><td className="py-2 px-2 text-sm">{a.file_name}</td><td className="py-2 px-2 text-sm">{a.mime_type}</td><td className="py-2 px-2 text-sm">{a.file_size_bytes.toLocaleString()}</td><td className="py-2 px-2 text-sm"><button onClick={()=>openDownloadUrl(a.id)} disabled={downloading===a.id} className="rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-xs">{downloading===a.id?"Opening...":"Open Photo"}</button></td></tr>)}</tbody></table>}</div>
            </Section>

            <Section title="Workflow Events">
              <div>{data.workflow_events.length===0?<div className="text-sm text-muted">No workflow events.</div>:<ol className="space-y-2">{data.workflow_events.map((e)=><li key={e.id} className="rounded border border-[var(--line)] p-2 text-sm"><div className="text-xs text-muted">{e.created_at}</div><div className="font-medium">{e.event_type} ({e.from_status ?? "-"} {"->"} {e.to_status ?? "-"})</div><div className="text-xs text-muted">Actor {e.actor_user_id}{e.comment ? ` - ${e.comment}` : ""}</div></li>)}</ol>}</div>
            </Section>

            {canManageSharing && (
              <Section title="Access Sharing">
                <div className="flex gap-2">
                  <input
                    className="w-full rounded border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm"
                    placeholder="Search users by email or name"
                    value={shareQuery}
                    onChange={(e) => setShareQuery(e.target.value)}
                  />
                  <button onClick={searchShareCandidates} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm">Search</button>
                </div>
                {shareCandidates.length > 0 ? (
                  <div className="mt-2 space-y-1">
                    {shareCandidates.map((u) => (
                      <div key={u.id} className="flex items-center justify-between rounded border border-[var(--line)] p-2 text-sm">
                        <div>{u.full_name} ({u.email})</div>
                        <button onClick={() => addShare(u.id)} className="rounded border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1 text-xs">Grant Access</button>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted">Users with explicit access</div>
                {sharedWith.length === 0 ? (
                  <div className="mt-1 text-sm text-muted">No explicit grants yet.</div>
                ) : (
                  <div className="mt-2 space-y-1">
                    {sharedWith.map((u) => (
                      <div key={u.user_id} className="flex items-center justify-between rounded border border-[var(--line)] p-2 text-sm">
                        <div>{u.full_name} ({u.email})</div>
                        <button onClick={() => removeShare(u.user_id)} className="rounded border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1 text-xs">Revoke</button>
                      </div>
                    ))}
                  </div>
                )}
              </Section>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}




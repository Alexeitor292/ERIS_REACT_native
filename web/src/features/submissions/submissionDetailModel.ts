import { normalizeRouteValue } from "../../utils/precision";

export type Tri = "UNKNOWN" | "YES" | "NO";

export type SubmissionDraft = Record<string, string> & {
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

export type SharedUser = {
  user_id: number;
  email: string;
  full_name: string;
  granted_by_user_id: number;
  created_at: string;
};

export type AdminUser = {
  id: number;
  email: string;
  full_name: string;
  is_active: boolean;
  roles: string[];
};

export type DistrictContact = {
  id: string;
  first_name: string;
  last_name: string;
  s_number: string;
  phone: string;
  cell_phone: string;
};

export const EMPTY_SUBMISSION_DRAFT: SubmissionDraft = {
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

export const textValue = (value: unknown) => (value == null ? "" : String(value));
export const nullableText = (value: string) => (value.trim() ? value.trim() : null);
export const triToBool = (value: Tri) => value === "YES" ? true : value === "NO" ? false : null;
export const boolToTri = (value: unknown): Tri => value === true ? "YES" : value === false ? "NO" : "UNKNOWN";

export function nullableNumber(value: string, name: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) throw new Error(`${name} must be numeric`);
  return parsed;
}

export function nullableInteger(value: string, name: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || !Number.isInteger(parsed)) throw new Error(`${name} must be whole number`);
  return parsed;
}

export function nullablePercent(value: string, name: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) throw new Error(`${name} must be numeric`);
  if (parsed < 0 || parsed > 100) throw new Error(`${name} must be between 0 and 100`);
  return parsed;
}

export function parseStatePlaneFeetValue(value: string) {
  const raw = value.trim().replace(/,/g, "");
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export const DISTRIBUTION_ICON_SRC: Record<string, string> = {
  ADVANCING: "/distribution-icons/advancing.png",
  RETROGRESSING: "/distribution-icons/retrogressing.png",
  ENLARGING: "/distribution-icons/enlarging.png",
  WIDENING: "/distribution-icons/widening.png",
  MOVING: "/distribution-icons/moving.png",
  CONFINED: "/distribution-icons/confined.png",
};

export const LANES_CLOSED_OPTIONS = Array.from({ length: 4 }, (_, index) => String(index + 1));
export const DASHBOARD_LAYOUT_KEY = "eris_submission_layout_v1";
export const DASHBOARD_LAYOUT_PROFILES_KEY = "eris_submission_layout_profiles_v1";

export const DASHBOARD_DEFAULT_ORDER = [
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

export type DashboardCardId = (typeof DASHBOARD_DEFAULT_ORDER)[number];
export type DashboardCardLayout = { width: number; height: number };
export type DashboardCardPosition = { x: number; y: number };
export type DashboardLayoutState = {
  order: DashboardCardId[];
  sizes: Record<DashboardCardId, DashboardCardLayout>;
  positions: Partial<Record<DashboardCardId, DashboardCardPosition>>;
};

export const DASHBOARD_MIN_CARD_WIDTH = 320;
export const DASHBOARD_MAX_CARD_WIDTH = 1600;
export const DASHBOARD_MIN_CARD_HEIGHT = 150;
export const DASHBOARD_MAX_CARD_HEIGHT = 980;
export const DASHBOARD_LAYOUT_GAP = 12;
export const DASHBOARD_TIDY_SNAP = 8;

export const DASHBOARD_DEFAULT_SIZES: Record<DashboardCardId, DashboardCardLayout> = {
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

export const DASHBOARD_DEFAULT_POSITIONS: Partial<Record<DashboardCardId, DashboardCardPosition>> = {
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

export const DASHBOARD_CARD_TITLES: Record<DashboardCardId, string> = {
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

export const INCIDENT_TYPE_CODE_BY_FORM_KEY: Record<string, string> = {
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

export const INCIDENT_TYPE_FORM_CODES = new Set(Object.values(INCIDENT_TYPE_CODE_BY_FORM_KEY));
export type IncidentTypeOption = { key?: string; code: string; label: string };
export const INCIDENT_TYPE_OPTIONS: IncidentTypeOption[] = [
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

export function pointFromLatLon(gisa: any): any | null {
  const latitude = Number(gisa?.latitude);
  const longitude = Number(gisa?.longitude);
  if (Number.isNaN(latitude) || Number.isNaN(longitude)) return null;
  return { type: "Point", coordinates: [longitude, latitude] };
}

export function normalizeCounty(value: string) {
  return value.replace(/\s+County$/i, "").trim();
}

export function tryExtractRoute(addressText: string) {
  const match = addressText.match(/\b(?:I|US|CA|SR)[-\s]?(\d{1,3})\b/i) || addressText.match(/\b(\d{1,3})\b/);
  return normalizeRouteValue(match?.[1] ?? null);
}

export function normalizeDistrictValue(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const parsed = Number(raw);
  if (!Number.isNaN(parsed) && Number.isInteger(parsed) && parsed >= 1 && parsed <= 12) return String(parsed);
  return raw;
}

export function districtContactRaw(value: unknown) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function parseDistrictContacts(raw: string): DistrictContact[] {
  const text = String(raw ?? "").trim();
  if (!text) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  const rows = Array.isArray(parsed) ? parsed : typeof parsed === "object" && parsed !== null ? [parsed] : [];
  return rows.map((item, index) => {
    const record = item as Record<string, unknown>;
    return {
      id: `${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`,
      first_name: String(record.first_name ?? ""),
      last_name: String(record.last_name ?? ""),
      s_number: String(record.s_number ?? ""),
      phone: String(record.phone ?? ""),
      cell_phone: String(record.cell_phone ?? ""),
    };
  });
}

export function serializeDistrictContacts(contacts: DistrictContact[]) {
  return JSON.stringify(contacts.map((contact) => ({
    first_name: contact.first_name.trim(),
    last_name: contact.last_name.trim(),
    s_number: contact.s_number.trim(),
    phone: contact.phone.trim(),
    cell_phone: contact.cell_phone.trim(),
  })));
}

export function reorderCards(order: DashboardCardId[], dragId: DashboardCardId, overId: DashboardCardId): DashboardCardId[] {
  if (dragId === overId) return [...order];
  const next = order.filter((id) => id !== dragId);
  const overIndex = next.indexOf(overId);
  if (overIndex < 0) next.push(dragId);
  else next.splice(overIndex, 0, dragId);
  return next;
}

export function buildDefaultDashboardLayout(): DashboardLayoutState {
  return {
    order: [...DASHBOARD_DEFAULT_ORDER],
    sizes: { ...DASHBOARD_DEFAULT_SIZES },
    positions: { ...DASHBOARD_DEFAULT_POSITIONS },
  };
}

export function normalizeDashboardLayout(raw: Partial<DashboardLayoutState> | null | undefined): DashboardLayoutState {
  const base = buildDefaultDashboardLayout();
  if (!raw) return base;

  const order = Array.isArray(raw.order)
    ? raw.order.filter((value): value is DashboardCardId => DASHBOARD_DEFAULT_ORDER.includes(value as DashboardCardId))
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
        width: Math.min(DASHBOARD_MAX_CARD_WIDTH, Math.max(DASHBOARD_MIN_CARD_WIDTH, Math.round(((Number.isNaN(legacyCol) ? 6 : legacyCol) / 12) * 1400))),
        height: Math.min(DASHBOARD_MAX_CARD_HEIGHT, Math.max(DASHBOARD_MIN_CARD_HEIGHT, Math.round((Number.isNaN(legacyRow) ? 1 : legacyRow) * 170))),
      };
      continue;
    }

    sizes[id] = {
      width: Math.min(DASHBOARD_MAX_CARD_WIDTH, Math.max(DASHBOARD_MIN_CARD_WIDTH, Number(next.width) || base.sizes[id].width)),
      height: Math.min(DASHBOARD_MAX_CARD_HEIGHT, Math.max(DASHBOARD_MIN_CARD_HEIGHT, Number(next.height) || base.sizes[id].height)),
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

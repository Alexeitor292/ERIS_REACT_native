/**
 * Human-readable labels and value mappings for CA Highways road inventory
 * fields. Mirrors mobile/src/roadInventory/roadInventoryGlossary.ts.
 * Raw field names are always preserved for traceability.
 */

const TERRAIN_CODE_MAP: Record<string, string> = {
  F: "Flat",
  R: "Rolling",
  M: "Mountainous",
  H: "Hilly",
};

const MEDIAN_TYPE_MAP: Record<string, string> = {
  "0": "None (Undivided)",
  N: "None (Undivided)",
  P: "Painted Median",
  C: "Curbed Median",
  R: "Raised Median",
  K: "Concrete Barrier (K-rail)",
  B: "Concrete Barrier",
  D: "Depressed Median",
  M: "Median — unspecified",
};

type FieldDef = {
  label: string;
  description: string;
  unit?: string;
  valueMap?: Record<string, string>;
};

const FIELD_DEFS: Record<string, FieldDef> = {
  district_code: { label: "District", description: "Caltrans district (1–12) responsible for this segment." },
  county_code: { label: "County", description: "Caltrans county code (e.g., ALA = Alameda, LA = Los Angeles)." },
  route_name: { label: "Route", description: "State Highway route identifier (e.g., '101', '580E')." },
  route_suffix_code: { label: "Route Suffix", description: "Suffix modifier for the route (e.g., 'E' eastbound couplet)." },
  begin_pm: { label: "Begin Postmile", description: "Starting postmile for this segment.", unit: "mi" },
  end_pm: { label: "End Postmile", description: "Ending postmile for this segment.", unit: "mi" },
  pm_prefix_code: { label: "PM Prefix", description: "Postmile prefix (R = right, L = left, M = Metro)." },
  terrain_code: { label: "Terrain", description: "Terrain classification (F=Flat, R=Rolling, M=Mountainous, H=Hilly).", valueMap: TERRAIN_CODE_MAP },
  THY_TERRAIN_CODE: { label: "Terrain", description: "Terrain classification (F=Flat, R=Rolling, M=Mountainous, H=Hilly).", valueMap: TERRAIN_CODE_MAP },
  left_lanes: { label: "LT Lanes", description: "Through travel lanes in the left (upstation) direction." },
  right_lanes: { label: "RT Lanes", description: "Through travel lanes in the right (downstation) direction." },
  median_type: { label: "Median Type", description: "Type of median divider between opposing lanes.", valueMap: MEDIAN_TYPE_MAP },
  median_width: { label: "Median Width", description: "Width of the median.", unit: "ft" },
  design_speed: { label: "Design Speed", description: "Posted or design speed.", unit: "mph" },
  adt: { label: "ADT", description: "Annual Daily Traffic — average vehicles per day.", unit: "veh/day" },
  length_miles: { label: "Segment Length", description: "Length of this road segment.", unit: "mi" },
  landmark_short_desc: { label: "Landmark", description: "Nearby named landmark (bridge, interchange, community)." },
  segment_id: { label: "Segment ID", description: "Road inventory segment identifier." },
  dataset_version_id: { label: "Dataset Version", description: "CA Highways dataset version used for matching." },
  match_method: { label: "Match Method", description: "How this incident was matched to a road segment." },
  checked_at: { label: "Matched At", description: "When the road inventory match was recorded." },
};

function applyValueMap(valueMap: Record<string, string>, raw: string): string {
  const upper = raw.toUpperCase();
  return valueMap[raw] ? `${valueMap[raw]} (${raw})`
    : valueMap[upper] ? `${valueMap[upper]} (${raw})`
    : raw;
}

export function friendlyFieldLabel(key: string): string {
  return FIELD_DEFS[key]?.label ?? key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function friendlyFieldValue(key: string, value: unknown): string {
  const raw = value === null || value === undefined ? "—" : String(value);
  if (raw === "—") return raw;
  const def = FIELD_DEFS[key];
  if (def?.valueMap) return applyValueMap(def.valueMap, raw);
  if (def?.unit) return `${raw} ${def.unit}`;
  return raw;
}

export function fieldDescription(key: string): string | undefined {
  return FIELD_DEFS[key]?.description;
}

/** Returns e.g. "Mountainous (M)" for terrain_code "M". Falls back to raw. */
export function terrainLabel(code: string | null | undefined): string {
  if (!code) return "—";
  const upper = code.toUpperCase().trim();
  const name = TERRAIN_CODE_MAP[upper];
  return name ? `${name} (${upper})` : code;
}

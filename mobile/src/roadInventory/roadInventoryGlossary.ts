/**
 * Human-readable labels, descriptions, and value mappings for CA Highways
 * road inventory fields. These names come from the Caltrans HICOMP / HQ
 * road-segment schema. Raw field names are preserved for traceability.
 */

export type FieldDef = {
  label: string;
  description: string;
  unit?: string;
  valueMap?: Record<string, string>;
};

export type ExplainedField = {
  key: string;
  label: string;
  displayValue: string;
  rawValue: string;
  description?: string;
  unit?: string;
};

const TERRAIN_CODE_MAP: Record<string, string> = {
  F: "Flat",
  R: "Rolling",
  M: "Mountainous",
  H: "Hilly",
};

const SURFACE_TYPE_MAP: Record<string, string> = {
  A: "AC (Asphalt Concrete)",
  B: "Bituminous Surface Treatment",
  C: "PCC (Portland Cement Concrete)",
  G: "Gravel / Unpaved",
  O: "Other",
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

const FIELD_DEFS: Record<string, FieldDef> = {
  district: {
    label: "District",
    description: "Caltrans district number (1–12) responsible for this segment.",
  },
  district_code: {
    label: "District Code",
    description: "Caltrans district code (1–12) responsible for this segment.",
  },
  district_number: {
    label: "District No.",
    description: "Caltrans district number (1–12) responsible for this segment.",
  },
  county_code: {
    label: "County",
    description: "2- or 3-letter Caltrans county code (e.g., ALA = Alameda, LA = Los Angeles).",
  },
  county: {
    label: "County",
    description: "County name or code where this road segment is located.",
  },
  route: {
    label: "Route",
    description: "State Highway route number (e.g., 101, 280, 5).",
  },
  route_name: {
    label: "Route",
    description: "State Highway route identifier including suffix (e.g., '101', '1', '580E').",
  },
  route_suffix_code: {
    label: "Route Suffix",
    description: "Suffix modifier for the route (e.g., 'E' for eastbound couplet, 'N' for northbound).",
  },
  begin_pm: {
    label: "Begin Postmile",
    description: "Starting postmile (odometer-like distance marker along the route) for this segment.",
    unit: "mi",
  },
  end_pm: {
    label: "End Postmile",
    description: "Ending postmile for this segment.",
    unit: "mi",
  },
  post_mile: {
    label: "Postmile",
    description: "Postmile (PM) location on the route. Used by Caltrans to identify exact highway locations.",
    unit: "mi",
  },
  pm_prefix_code: {
    label: "PM Prefix",
    description: "Postmile prefix (e.g., 'R' for right side, 'L' for left, 'M' for Metro).",
  },
  terrain_code: {
    label: "Terrain",
    description: "Terrain classification of the surrounding landscape (F=Flat, R=Rolling, M=Mountainous, H=Hilly).",
    valueMap: TERRAIN_CODE_MAP,
  },
  THY_TERRAIN_CODE: {
    label: "Terrain",
    description: "Terrain classification of the surrounding landscape (F=Flat, R=Rolling, M=Mountainous, H=Hilly).",
    valueMap: TERRAIN_CODE_MAP,
  },
  left_lanes: {
    label: "Left Lanes",
    description: "Number of through travel lanes in the left (upstation/LT) direction.",
  },
  right_lanes: {
    label: "Right Lanes",
    description: "Number of through travel lanes in the right (downstation/RT) direction.",
  },
  lane_count: {
    label: "Lanes",
    description: "Total number of travel lanes on the roadway.",
  },
  left_traveled_way_width: {
    label: "LT Traveled Width",
    description: "Total width of left-direction travel lanes (edge to edge, excluding shoulders).",
    unit: "ft",
  },
  right_traveled_way_width: {
    label: "RT Traveled Width",
    description: "Total width of right-direction travel lanes (edge to edge, excluding shoulders).",
    unit: "ft",
  },
  left_outside_shoulder_width: {
    label: "LT Outside Shoulder",
    description: "Width of the outside (outer edge) shoulder on the left side.",
    unit: "ft",
  },
  right_outside_shoulder_width: {
    label: "RT Outside Shoulder",
    description: "Width of the outside shoulder on the right side.",
    unit: "ft",
  },
  left_inside_shoulder_width: {
    label: "LT Inside Shoulder",
    description: "Width of the inside (median-side) shoulder on the left side.",
    unit: "ft",
  },
  right_inside_shoulder_width: {
    label: "RT Inside Shoulder",
    description: "Width of the inside shoulder on the right side.",
    unit: "ft",
  },
  median: {
    label: "Median",
    description: "Presence and type of median dividing opposing travel directions.",
  },
  median_type: {
    label: "Median Type",
    description: "Type of median divider between opposing lanes.",
    valueMap: MEDIAN_TYPE_MAP,
  },
  median_width: {
    label: "Median Width",
    description: "Width of the median area between opposing lanes.",
    unit: "ft",
  },
  roadbed_width: {
    label: "Roadbed Width",
    description: "Total width of the roadbed from toe to toe of slopes (or curb to curb).",
    unit: "ft",
  },
  roadway_width: {
    label: "Roadway Width",
    description: "Total paved width including all travel lanes and shoulders.",
    unit: "ft",
  },
  facility_type: {
    label: "Facility Type",
    description: "Road classification (e.g., Freeway, Expressway, Conventional Highway, Local Road).",
  },
  urban_rural: {
    label: "Urban / Rural",
    description: "Whether the segment is classified as urban or rural for federal-aid purposes.",
  },
  direction: {
    label: "Direction",
    description: "Primary travel direction of this segment (N/S/E/W or undivided).",
  },
  left_surface_type: {
    label: "LT Surface Type",
    description: "Pavement surface type for the left direction lanes.",
    valueMap: SURFACE_TYPE_MAP,
  },
  right_surface_type: {
    label: "RT Surface Type",
    description: "Pavement surface type for the right direction lanes.",
    valueMap: SURFACE_TYPE_MAP,
  },
  design_speed: {
    label: "Design Speed",
    description: "Posted or design speed for this highway segment.",
    unit: "mph",
  },
  adt: {
    label: "ADT",
    description: "Annual Daily Traffic — average number of vehicles per day in both directions.",
    unit: "vehicles/day",
  },
  length_miles: {
    label: "Segment Length",
    description: "Length of this road inventory segment.",
    unit: "mi",
  },
  landmark_short_desc: {
    label: "Landmark",
    description: "Short description of a nearby named landmark (bridge, interchange, community).",
  },
  segment_id: {
    label: "Segment ID",
    description: "Internal road inventory segment identifier (used for traceability to CA Highways data).",
  },
  dataset_version_id: {
    label: "Dataset Version",
    description: "Version ID of the CA Highways road inventory dataset used for matching.",
  },
  match_method: {
    label: "Match Method",
    description: "How this incident was matched to a road segment (MOBILE_OFFLINE = matched from local device copy).",
  },
  checked_at: {
    label: "Matched At",
    description: "Timestamp when the road inventory match was recorded.",
  },
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function toSnakeFriendly(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function applyValueMap(valueMap: Record<string, string>, raw: string): string {
  const upper = raw.toUpperCase();
  if (valueMap[raw]) return `${valueMap[raw]} (${raw})`;
  if (valueMap[upper]) return `${valueMap[upper]} (${raw})`;
  return raw;
}

/**
 * Returns a human-readable explanation of a road inventory field and value.
 * Always preserves rawValue for traceability.
 */
export function explainRoadInventoryField(
  key: string,
  value: unknown,
): ExplainedField {
  const rawValue = value === null || value === undefined ? "—" : String(value);
  const def = FIELD_DEFS[key];

  const label = def?.label ?? toSnakeFriendly(key);
  const description = def?.description;
  const unit = def?.unit;

  let displayValue = rawValue;
  if (rawValue !== "—" && def?.valueMap) {
    displayValue = applyValueMap(def.valueMap, rawValue);
  } else if (unit && rawValue !== "—") {
    displayValue = `${rawValue} ${unit}`;
  }

  return { key, label, displayValue, rawValue, description, unit };
}

/**
 * Returns true if this field key is "well-known" (has a glossary entry).
 */
export function isKnownField(key: string): boolean {
  return key in FIELD_DEFS;
}

/**
 * Friendly terrain label from terrain_code value.
 * Returns e.g. "Mountainous (M)" or falls back to the raw value.
 */
export function terrainLabel(code: string | null | undefined): string {
  if (!code) return "—";
  const upper = code.toUpperCase().trim();
  const name = TERRAIN_CODE_MAP[upper];
  return name ? `${name} (${upper})` : code;
}

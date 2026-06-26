export type Me = { id: number; email: string; full_name?: string; roles: string[] };

export type AdminUser = {
  id: number;
  email: string;
  full_name: string;
  is_active: boolean;
  roles: string[];
};

export type Submission = {
  id: number;
  created_by_user_id: number;
  status: string;
  client_submission_uuid: string;
  title?: string | null;
  district?: string | null;
  county?: string | null;
  route?: string | null;
  post_mile?: string | null;
  created_at: string;
  updated_at?: string;
  submitted_at: string | null;
  reviewed_at?: string | null;
  reviewed_by_user_id?: number | null;
  review_comment?: string | null;
};

export type Attachment = {
  id: number;
  file_name: string;
  mime_type: string;
  file_size_bytes: number;
  storage_bucket: string | null;
  storage_key: string;
  uploaded_at: string | null;
  kind: string;
  sort_order: number;
};

export type WorkflowEvent = {
  id: number;
  actor_user_id: number;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  comment: string | null;
  created_at: string;
};

export type ClassificationReason =
  | "CLASSIFIED"
  | "ROAD_BEARING_UNAVAILABLE"
  | "INSUFFICIENT_VALID_SAMPLES"
  | "AMBIGUOUS_TERRAIN";

export type GisaElevationProfileMetadata = {
  road_bearing_deg_used: number | null;
  road_bearing_source: string | null;
  half_width_m: number;
  spacing_m: number;
  classification_requires_bearing: boolean;
  classification_reason?: ClassificationReason | null;
  classification_note?: string;
};

export type GisaElevationProfile = {
  source: string | null;
  checked_at: string | null;
  classification: string | null;
  classification_reason?: ClassificationReason | null;
  confidence: number | null;
  profile: {
    points?: Array<{
      offset_m: number;
      lat: number;
      lon: number;
      elevation_ft: number | null;
      source: string;
    }>;
    metadata?: GisaElevationProfileMetadata;
  } | null;
  error: string | null;
};

export type TerrainGridPoint = {
  row: number;
  column: number;
  along_offset_m?: number;
  cross_offset_m?: number;
  lat: number;
  lon: number;
  elevation_ft: number | null;
};

export type GisaTerrainGrid = {
  source: string | null;
  checked_at: string | null;
  road_bearing_deg_used: number | null;
  road_bearing_source: string | null;
  grid: {
    rows: number;
    columns: number;
    along_road_spacing_m: number;
    cross_road_spacing_m: number;
    extent_along_m?: number;
    extent_cross_m?: number;
    sample_count?: number;
    valid_sample_count?: number;
    points: TerrainGridPoint[];
  } | null;
  error: string | null;
};

export type Gisa = {
  submission_id: number;
  report_date: string | null;
  district: string | null;
  county: string | null;
  route: string | null;
  post_mile: string | null;
  ea: string | null;
  project_id: string | null;
  date_incident_reported: string | null;
  district_contact: string | null;
  latitude: number | null;
  longitude: number | null;
  distribution_code: string | null;
  highway_status_cause: string | null;
  highway_status_code: string | null;
  lanes_closed_count: number | null;
  open_highway_traffic_lanes_count: number | null;
  pavement_ground_cracks: boolean | null;
  crack_length_ft: number | null;
  crack_horizontal_in: number | null;
  crack_vertical_in: number | null;
  crack_depth_in: number | null;
  settlement_in: number | null;
  bulge_in: number | null;
  indented_by_rocks: boolean | null;
  incident_type_description: string | null;
  observations_notes: string | null;
  geometry_json: Record<string, unknown> | null;
  updated_by_user_id?: number | null;
  created_at?: string;
  updated_at: string;
  road_inventory_context?: RoadInventoryIncidentContext | null;
  elevation_profile?: GisaElevationProfile | null;
  elevation_terrain?: GisaTerrainGrid | null;
};

export type LookupItem = {
  code: string;
  label: string;
  sort_order?: number;
};

export type GisaLookups = {
  distribution: LookupItem[];
  highway_status: LookupItem[];
  incident_types: LookupItem[];
  actions: {
    immediate: LookupItem[];
    follow_up: LookupItem[];
  };
};

export type SubmissionDetail = {
  submission: Submission & { updated_at: string; submitted_at: string | null };
  gisa: Gisa | null;
  incident_types: string[];
  actions: { immediate: string[]; follow_up: string[] };
  photos: Attachment[];
  attachments: Attachment[];
  workflow_events: WorkflowEvent[];
};

export type RoadInventoryIncidentContext = {
  dataset_version_id: number;
  segment_id: number;
  match_method: string | null;
  checked_at: string | null;
  snapshot: Record<string, unknown> | null;
};

export type IncidentStatus = "NEW" | "IN_PROGRESS" | "RESOLVED";
export type IncidentStage =
  | "COORDINATOR_REVIEW"
  | "OFFICE_CHIEF_REVIEW"
  | "BRANCH_CHIEF_REVIEW"
  | "ENGINEER_ASSIGNED"
  | "RESOLVED";

export type IncidentAssignment = {
  assignment_id: number;
  assignee_user_id: number;
  assigned_by_user_id: number;
  assignment_stage: "COORDINATOR" | "OFFICE_CHIEF" | "BRANCH_CHIEF" | "ENGINEER";
  assignment_mode: "CLAIM" | "ASSIGN";
  assigned_at: string;
  assignee_email: string;
  assignee_name: string;
};

export type Incident = {
  id: number;
  title: string;
  incident_type: string | null;
  description: string | null;
  location_id: number | null;
  location_match_status: string | null;
  location_reviewed_by_user_id: number | null;
  location_reviewed_at: string | null;
  location_match_metadata: Record<string, unknown> | null;
  first_observed_at: string;
  first_occurred_at: string | null;
  latitude: number;
  longitude: number;
  district: string | null;
  county: string | null;
  route: string | null;
  post_mile: string | null;
  office_code: string | null;
  current_stage: IncidentStage;
  status: IncidentStatus;
  reporter_user_id: number;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by_user_id: number | null;
  resolution_comment: string | null;
  linked_submission_id: number | null;
  road_inventory_context: RoadInventoryIncidentContext | null;
  assignment: IncidentAssignment | null;
};

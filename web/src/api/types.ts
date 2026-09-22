/**
 * Account profile metadata (`users.metadata_json`) — a LEGACY MIRROR, never the
 * source. The org record (`UserOrg`, below) is where a person's office, branch
 * and classification live; the server re-renders these three keys from it so a
 * reader that has not migrated yet still resolves an office. No client writes
 * an org fact into `metadata`: org edits go to `PUT /admin/users/{id}/org`
 * (org model design §3.2).
 */
export type UserMetadata = {
  office_code?: string | null;
  office_location?: string | null;
  district?: string | null;
};

/** Availability is RENDERED beside a name — never used to filter or reorder a picker. */
export type OrgAvailability = "AVAILABLE" | "ROTATION_OUT" | "ACTING_ELSEWHERE" | "UNAVAILABLE";

/**
 * Where a person sits in the organization, resolved server-side
 * (`org_user_profiles` first, the `metadata_json` mirror second). Every field is
 * nullable: an account created before the org model has no profile row, and an
 * office with no branches has no branch to name.
 */
export type UserOrg = {
  office_id?: number | null;
  office_code?: string | null;
  office_name?: string | null;
  office_short_name?: string | null;
  office_unit_number?: string | null;
  office_is_active?: boolean | null;
  branch_id?: number | null;
  branch_letter?: string | null;
  branch_name?: string | null;
  branch_is_active?: boolean | null;
  home_city?: string | null;
  home_district?: string | null;
  classification_code?: string | null;
  classification_marker?: string | null;
  position_number?: string | null;
  job_title?: string | null;
  level_code?: string | null;
  supervisor_user_id?: number | null;
  availability?: OrgAvailability | null;
  available_from?: string | null;
  available_until?: string | null;
  source?: string | null;
  has_profile?: boolean | null;
};

export type Me = {
  id: number;
  email: string;
  full_name?: string;
  roles: string[];
  /** Legacy mirror; read `org` for anything organizational. */
  metadata?: UserMetadata;
  org?: UserOrg | null;
};

export type AdminUser = {
  id: number;
  email: string;
  full_name: string;
  is_active: boolean;
  roles: string[];
  /** Legacy mirror; read `org` for anything organizational. */
  metadata?: UserMetadata;
  /** Present only where the endpoint carries it; the admin page fetches the record per account otherwise. */
  org?: UserOrg | null;
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
  /** GISA form section the mobile app tagged this file with (attachment_links.section_key). */
  section_key?: string | null;
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
    partial?: boolean;
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

export type SubmissionPermissionUser = {
  id: number;
  email: string;
  full_name: string;
};

export type SubmissionPermissionGrant = {
  user_id: number;
  email: string;
  full_name: string;
};

export type SubmissionPermissions = {
  owner: SubmissionPermissionUser;
  readers: SubmissionPermissionGrant[];
  editors: SubmissionPermissionGrant[];
  can_manage: boolean;
  available_users: SubmissionPermissionUser[];
};

export type SubmissionDetail = {
  submission: Submission & {
    updated_at: string;
    submitted_at: string | null;
    can_edit?: boolean;
    can_manage_permissions?: boolean;
    /** Beside can_edit rather than only in the context: a legacy form has no context. */
    can_review?: boolean;
  };
  gisa: Gisa | null;
  incident_types: string[];
  actions: { immediate: string[]; follow_up: string[] };
  photos: Attachment[];
  attachments: Attachment[];
  workflow_events: WorkflowEvent[];
  /** Incident / assessment / Event Group this technical form belongs to (null for standalone forms). */
  context?: SubmissionWorkflowContext | null;
};

export type SubmissionWorkflowContext = {
  incident_id: number;
  incident_title: string | null;
  event_group_id: number | null;
  assessment_id: number | null;
  assessment_state: string | null;
  /** Absent on a legacy form with no linked assessment — copy must stay neutral then. */
  assessment_routing_path?: "BRANCH" | "SENIOR_ENGINEER" | null;
  /** Path-based review authority, decided server-side. */
  can_review?: boolean;
};

/** One file the reporter attached to a field report (GET /incidents/{id}/attachments). */
export type IncidentAttachment = {
  attachment_id: number;
  kind: "PHOTO" | "VIDEO" | "DOC" | "SKETCH" | string;
  file_name: string;
  mime_type: string;
  file_size_bytes: number | null;
  uploaded_at: string | null;
  /** When the device recorded the capture, not when it was uploaded. */
  captured_at: string | null;
  latitude: number | null;
  longitude: number | null;
  horizontal_accuracy_m: number | null;
  camera_heading_deg: number | null;
  heading_reference: string | null;
  location_source: string | null;
  download_url: string;
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
  /** Event Group the incident was accepted into (null until coordinator approval). */
  event_group_id?: number | null;
  /** Permanent identity minted at coordinator approval (null while awaiting intake). */
  incident_key?: string | null;
  status: IncidentStatus;
  reporter_user_id: number;
  /** Who filed the report. Null on rows served by a query that predates the join. */
  reporter_name?: string | null;
  reporter_email?: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by_user_id: number | null;
  resolved_by_name?: string | null;
  resolution_comment: string | null;
  /** The coordinator's triage decision. Null until the report has been triaged. */
  triage_disposition?: string | null;
  triage_notes?: string | null;
  triage_decided_by_user_id?: number | null;
  triage_decided_by_name?: string | null;
  triage_decided_at?: string | null;
  duplicate_of_incident_id?: number | null;
  duplicate_of_location_id?: number | null;
  linked_submission_id: number | null;
  road_inventory_context: RoadInventoryIncidentContext | null;
  assignment: IncidentAssignment | null;
};

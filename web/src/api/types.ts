export type Me = { id: number; email: string; full_name?: string; roles: string[] };

export type Submission = {
  id: number;
  created_by_user_id: number;
  status: string;
  client_submission_uuid: string;
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
  highway_status_code: string | null;
  lanes_closed_count: number | null;
  pavement_ground_cracks: boolean | null;
  crack_length_ft: number | null;
  crack_horizontal_in: number | null;
  crack_vertical_in: number | null;
  crack_depth_in: number | null;
  settlement_in: number | null;
  bulge_in: number | null;
  indented_by_rocks: boolean | null;
  observations_notes: string | null;
  geometry_json: Record<string, unknown> | null;
  updated_by_user_id?: number | null;
  created_at?: string;
  updated_at: string;
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

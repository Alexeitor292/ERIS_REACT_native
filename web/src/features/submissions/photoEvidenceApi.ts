import { api } from "../../api/client";

export type PhotoCorrection = {
  has_history: boolean;
  location_overridden: boolean;
  heading_overridden: boolean;
  location_override: { latitude: number | null; longitude: number | null } | null;
  heading_override_deg: number | null;
  corrected_by_user_id: number | null;
  corrected_at: string | null;
};

export type PhotoEvidence = {
  attachment_id: number;
  file_name: string;
  mime_type: string;
  section_key: string | null;
  source_scope: "SUBMISSION" | "INCIDENT" | string;
  captured_at: string | null;
  latitude: number | null;
  longitude: number | null;
  horizontal_accuracy_m: number | null;
  altitude_m: number | null;
  camera_heading_deg: number | null;
  heading_reference: string | null;
  location_source: string | null;
  heading_source: string | null;
  correction: PhotoCorrection;
  download_url: string;
};

export type PhotoEvidenceSummary = {
  photos_total: number;
  photos_geotagged: number;
  photos_with_heading: number;
  photos_unmapped: number;
};

export type PhotoMapResponse = {
  submission_id: number;
  incident_id: number | null;
  incident: { latitude: number | null; longitude: number | null };
  summary: PhotoEvidenceSummary;
  photos: PhotoEvidence[];
};

export function getSubmissionPhotoEvidence(submissionId: number): Promise<PhotoMapResponse> {
  return api<PhotoMapResponse>(`/submissions/${submissionId}/photo-map`);
}

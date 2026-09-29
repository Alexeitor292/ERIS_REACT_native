import { getToken } from "../auth/token";
import { appConfig } from "../config";
import { api } from "./client";

/** A captured point: the same place on the original ground and on the drone survey. */
export type SurveyPoint = {
  id: string;
  lon: number;
  lat: number;
  /** The terrain model (before), metres. */
  historical_m: number | null;
  /** The drone survey, lined up (now), metres. */
  actual_m: number | null;
  label?: string | null;
  captured_at: string;
};

/** The last before/after comparison saved with the survey (see siteTerrainModel.compareSurfaces). */
export type SavedComparison = {
  area_key: string;
  measured_at: string;
  offset_m: number;
  /** What "before" was: the terrain model, or an earlier survey (absent in comparisons saved before this was recorded). */
  baseline?: { kind: "terrain" } | { kind: "survey"; survey_id: number; title: string; offset_m: number };
  /** The section line the author drew, [lon, lat] points; absent when the section ran down the fall line. */
  section_line?: Array<[number, number]> | null;
  original: { slope_deg: number; height_m: number; low_m: number; high_m: number };
  updated: { slope_deg: number; height_m: number; low_m: number; high_m: number };
  coverage: number;
  max_loss_m: number;
  max_gain_m: number;
  mean_change_m: number;
  loss_m3: number;
  gain_m3: number;
  net_m3: number;
};

export type DroneSurvey = {
  id: number;
  label: string | null;
  source: string | null;
  captured_on: string | null;
  created_at: string | null;
  created_by: string | null;
  dsm_filename: string | null;
  ortho_filename: string | null;
  dsm_attachment_id: number | null;
  ortho_attachment_id: number | null;
  source_crs: string | null;
  bounds: { west: number; south: number; east: number; north: number };
  cols: number;
  rows: number;
  resolution_m: number | null;
  patch_size_bytes: number;
  has_overlay: boolean;
  overlay_corners: Array<[number, number]> | null;
  vertical_offset_m: number;
  offset_mode: "AUTO" | "MANUAL" | "NONE";
  stats: Record<string, unknown> | null;
  comparison: SavedComparison | null;
  points: SurveyPoint[];
  /** The survey of the same form this one is compared with (null: the terrain model). */
  compare_with_survey_id?: number | null;
};

export type NewSurveyMeta = {
  label?: string | null;
  source?: string | null;
  captured_on?: string | null;
  dsm_filename?: string | null;
  ortho_filename?: string | null;
  dsm_attachment_id?: number | null;
  ortho_attachment_id?: number | null;
  source_crs?: string | null;
  resolution_m?: number | null;
  vertical_offset_m: number;
  offset_mode: "AUTO" | "MANUAL" | "NONE";
  overlay_corners?: Array<[number, number]> | null;
  stats?: Record<string, unknown> | null;
};

const base = (submissionId: number) => `/submissions/${submissionId}/drone-surveys`;

export function listSurveys(submissionId: number) {
  return api<{ items: DroneSurvey[] }>(base(submissionId));
}

export function createSurvey(submissionId: number, meta: NewSurveyMeta, patch: Uint8Array, overlay?: { blob: Blob; mime: string } | null) {
  const form = new FormData();
  form.append("meta", JSON.stringify(meta));
  const bytes = patch.buffer.slice(patch.byteOffset, patch.byteOffset + patch.byteLength) as ArrayBuffer;
  form.append("patch", new Blob([bytes], { type: "application/octet-stream" }), "patch.bin");
  if (overlay) form.append("overlay", overlay.blob, `ortho.${overlay.mime.split("/")[1]}`);
  return api<DroneSurvey>(base(submissionId), { method: "POST", body: form });
}

export function updateSurvey(
  submissionId: number,
  surveyId: number,
  patch: Partial<{
    label: string | null;
    captured_on: string | null;
    vertical_offset_m: number;
    offset_mode: DroneSurvey["offset_mode"];
    comparison: SavedComparison | null;
    points: SurveyPoint[];
    alignment_spread_m: number | null;
    alignment_points: number;
    compare_with_survey_id: number | null;
  }>,
) {
  return api<DroneSurvey>(`${base(submissionId)}/${surveyId}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteSurvey(submissionId: number, surveyId: number) {
  return api<{ deleted: number }>(`${base(submissionId)}/${surveyId}`, { method: "DELETE" });
}

/** Keep the original file as an attachment of the form (Measurements), when it fits through the connection. */
export function archiveOriginal(submissionId: number, file: File) {
  const form = new FormData();
  form.append("file", file, file.name);
  return api<{ attachment_id: number }>(`/submissions/${submissionId}/attachments?section_key=measurements&kind=DOC`, { method: "POST", body: form });
}

async function fetchBinary(path: string): Promise<Response> {
  const token = getToken();
  const res = await fetch(`${appConfig.apiBaseUrl}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`Could not load the drone survey (${res.status}).`);
  return res;
}

export async function fetchPatch(submissionId: number, surveyId: number): Promise<ArrayBuffer> {
  return (await fetchBinary(`${base(submissionId)}/${surveyId}/patch`)).arrayBuffer();
}

export async function fetchOverlay(submissionId: number, surveyId: number): Promise<Blob> {
  return (await fetchBinary(`${base(submissionId)}/${surveyId}/overlay`)).blob();
}

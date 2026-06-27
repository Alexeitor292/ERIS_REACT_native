import { apiFetch } from "./client";
import { getApiBaseCandidates, getApiBaseUrl } from "./baseUrl";
import { prepareUploadFile } from "../utils/uploadFile";
import type { SceneAreaDescriptor } from "../arcgis/offlineScene";

export async function getSubmission(token: string, id: string) {
  return apiFetch(`/submissions/${id}`, { token });
}

export async function uploadSubmissionAttachment(
  token: string,
  submissionId: string,
  file: { uri: string; name: string; type: string },
  opts?: { sectionKey?: string | null; kind?: "PHOTO" | "VIDEO" | "DOC" | "SKETCH" }
) {
  const preparedFile = await prepareUploadFile(file);
  const params = new URLSearchParams();
  if (opts?.sectionKey) params.set("section_key", opts.sectionKey);
  if (opts?.kind) params.set("kind", opts.kind);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const baseCandidates = [getApiBaseUrl(), ...getApiBaseCandidates()]
    .map((u) => u.replace(/\/+$/, ""))
    .filter((u, idx, arr) => arr.indexOf(u) === idx);

  let lastError = "Network request failed";
  for (const base of baseCandidates) {
    const formData = new FormData();
    formData.append("file", preparedFile as any);
    try {
      const response = await fetch(`${base}/submissions/${submissionId}/attachments${suffix}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      if (response.ok) return response.json();
      lastError = `${response.status} ${await response.text().catch(() => "")}`;
    } catch (err: any) {
      lastError = String(err?.message ?? err);
    }
  }
  throw new Error(`Could not reach upload endpoint. Last error: ${lastError}.`);
}

export async function patchSubmission(token: string, id: string, patch: any) {
  return apiFetch(`/submissions/${id}/gisa`, { method: "PATCH", token, body: patch });
}

export async function replaceIncidentTypes(token: string, id: string, items: string[]) {
  return apiFetch(`/submissions/${id}/gisa/incident-types`, {
    method: "PUT",
    token,
    body: { items },
  });
}

export async function replaceActions(
  token: string,
  id: string,
  payload: { immediate: string[]; follow_up: string[] }
) {
  return apiFetch(`/submissions/${id}/gisa/actions`, {
    method: "PUT",
    token,
    body: payload,
  });
}

export async function submitSubmission(token: string, id: string, comment?: string) {
  return apiFetch(`/submissions/${id}/submit`, {
    method: "POST",
    token,
    body: { comment: comment ?? null },
  });
}

export async function notifyCoordinator(
  token: string,
  id: string,
  message: string
) {
  return apiFetch(`/submissions/${id}/notify-coordinator`, {
    method: "POST",
    token,
    body: { message },
  });
}

export async function reviewSubmission(
  token: string,
  id: string,
  decision: "APPROVE" | "REJECT",
  comment?: string
) {
  return apiFetch(`/submissions/${id}/review`, {
    method: "POST",
    token,
    body: { decision, comment: comment ?? null },
  });
}

export async function getGisaLookups(token: string) {
  return apiFetch("/gisa/lookups", { token });
}

export type GisaRoadInventoryContext = {
  dataset_version_id: number;
  segment_id: number | null;
  match_method: string | null;
  checked_at: string | null;
  snapshot: Record<string, unknown> | null;
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

export async function fetchElevationProfile(
  token: string,
  id: string,
  payload: { road_bearing_deg?: number | null; half_width_m?: number | null; spacing_m?: number | null; force?: boolean | null },
) {
  return apiFetch<{ elevation_profile: GisaElevationProfile }>(
    `/submissions/${id}/gisa/elevation-profile`,
    { method: "POST", token, body: payload },
  );
}

export async function buildTerrainGrid(
  token: string,
  id: string,
  payload: { road_bearing_deg?: number | null; force?: boolean | null } = {},
) {
  return apiFetch<{ terrain: GisaTerrainGrid; cached?: boolean }>(
    `/submissions/${id}/gisa/terrain-grid`,
    { method: "POST", token, body: payload },
  );
}

export async function getOfflineScenePackageDescriptor(
  token: string,
  id: string,
  radiusM?: number | null,
) {
  const q = radiusM != null ? `?radius_m=${encodeURIComponent(String(radiusM))}` : "";
  return apiFetch<SceneAreaDescriptor>(
    `/submissions/${id}/gisa/offline-scene-package${q}`,
    { method: "GET", token },
  );
}

export type GisaPdfResponse = {
  submission_id: number;
  attachment_id: number;
  file_name: string;
  content_type: string;
  file_size_bytes: number;
  sha256: string;
  download_url: string;
  expires_seconds: number;
  uploaded_at?: string;
};

export async function generateSubmissionGisaPdf(token: string, id: string) {
  return apiFetch<GisaPdfResponse>(`/submissions/${id}/gisa/pdf`, {
    method: "POST",
    token,
  });
}

export async function getSubmissionGisaPdf(token: string, id: string) {
  return apiFetch<GisaPdfResponse>(`/submissions/${id}/gisa/pdf`, {
    token,
  });
}

export async function patchSubmissionTitle(token: string, id: string, title: string | null) {
  return apiFetch(`/submissions/${id}/title`, {
    method: "PATCH",
    token,
    body: { title },
  });
}

export async function deleteSubmission(token: string, id: string) {
  return apiFetch(`/submissions/${id}`, {
    method: "DELETE",
    token,
  });
}

export type SubmissionPermissionUser = {
  id?: number;
  user_id?: number;
  email: string;
  full_name: string;
};

export type SubmissionPermissions = {
  owner: { id: number; email: string; full_name: string };
  readers: { user_id: number; email: string; full_name: string }[];
  editors: { user_id: number; email: string; full_name: string }[];
  can_manage: boolean;
  available_users: { id: number; email: string; full_name: string }[];
};

export async function getSubmissionPermissions(token: string, id: string) {
  return apiFetch<SubmissionPermissions>(`/submissions/${id}/permissions`, { token });
}

export async function replaceSubmissionPermissions(
  token: string,
  id: string,
  payload: { reader_user_ids: number[]; editor_user_ids: number[] }
) {
  return apiFetch(`/submissions/${id}/permissions`, {
    method: "PUT",
    token,
    body: payload,
  });
}

export type GeoEnrichment = {
  latitude: number;
  longitude: number;
  district?: string | null;
  county?: string | null;
  route?: string | null;
  post_mile?: string | null;
  source?: {
    reverse_geocode?: string | null;
    postmile_layer?: string | null;
    requested_by_user_id?: number;
  };
};

export async function enrichPoint(token: string, lat: number, lon: number) {
  const q = `/geo/enrich-point?lat=${encodeURIComponent(String(lat))}&lon=${encodeURIComponent(String(lon))}`;
  return apiFetch<GeoEnrichment>(q, { token });
}

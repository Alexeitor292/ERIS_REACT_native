import { apiFetch } from "./client";

export async function getSubmission(token: string, id: string) {
  return apiFetch(`/submissions/${id}`, { token });
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

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

import { api } from "./client";

export type CrossSectionProjectSource = "ERIS_MANUAL" | "CALTRANS_PROJECT_DB";

export type CrossSectionProject = {
  id: number;
  project_key: string;
  project_number: string | null;
  title: string;
  description: string | null;
  district: string | null;
  status: "ACTIVE" | "INACTIVE" | "ARCHIVED";
  source_system: CrossSectionProjectSource;
  external_project_id: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
  cross_section_count: number;
};

export type SavedCrossSectionPoint = {
  sequence_number: number;
  latitude: number;
  longitude: number;
  distance_m: number | null;
  elevation_m: number | null;
};

export type SavedCrossSectionSummary = {
  id: number;
  cross_section_key: string;
  project_id: number;
  name: string;
  notes: string | null;
  preferred_spacing_m: number | null;
  actual_spacing_m: number | null;
  dem_source: string;
  point_count: number;
  created_by_user_id: number;
  created_at: string;
  updated_at: string;
};

export type SavedCrossSectionDetail = SavedCrossSectionSummary & {
  project: CrossSectionProject | null;
  control_points: SavedCrossSectionPoint[];
  profile_snapshot: unknown | null;
};

export type CrossSectionSavePayload = {
  project_id: number;
  name: string;
  notes?: string | null;
  preferred_spacing_m?: number | null;
  actual_spacing_m?: number | null;
  dem_source?: string;
  control_points: Array<{
    latitude: number;
    longitude: number;
    distance_m?: number | null;
    elevation_m?: number | null;
  }>;
  profile_snapshot?: unknown | null;
};

export async function listCrossSectionProjects(query = "") {
  const params = new URLSearchParams({ status: "ACTIVE", limit: "250" });
  if (query.trim()) params.set("q", query.trim());
  return api<{ items: CrossSectionProject[] }>(`/terrain-cross-sections/projects?${params.toString()}`);
}

export async function createCrossSectionProject(payload: {
  project_number?: string | null;
  title: string;
  description?: string | null;
  district?: string | null;
}) {
  return api<{ project: CrossSectionProject }>("/terrain-cross-sections/projects", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function listProjectCrossSections(projectId: number) {
  return api<{ project: CrossSectionProject; items: SavedCrossSectionSummary[] }>(
    `/terrain-cross-sections/projects/${projectId}/cross-sections`,
  );
}

export async function getSavedCrossSection(crossSectionId: number) {
  return api<{ cross_section: SavedCrossSectionDetail }>(`/terrain-cross-sections/${crossSectionId}`);
}

export async function createSavedCrossSection(payload: CrossSectionSavePayload) {
  return api<{ cross_section: SavedCrossSectionDetail }>("/terrain-cross-sections", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateSavedCrossSection(crossSectionId: number, payload: CrossSectionSavePayload) {
  return api<{ cross_section: SavedCrossSectionDetail }>(`/terrain-cross-sections/${crossSectionId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

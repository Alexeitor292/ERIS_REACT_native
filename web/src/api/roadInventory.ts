import { api } from "./client";

export type RoadInventoryImportJob = {
  id: number;
  job_uuid: string;
  status: "queued" | "processing" | "succeeded" | "failed";
  stage: string;
  message: string | null;
  upload_filename: string;
  requested_version_tag: string | null;
  storage_key: string | null;
  file_size_bytes: number | null;
  dataset_version_id: number | null;
  row_count: number;
  skipped_count: number;
  warnings: string[];
  error_message: string | null;
  created_by: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string | null;
};

export type CreateImportJobResult = RoadInventoryImportJob;

export type RoadInventoryDataset = {
  id: number;
  version_tag: string;
  upload_filename: string;
  extract_date: string | null;
  row_count: number;
  skipped_count: number;
  status: "pending" | "published" | "superseded";
  uploaded_by: number;
  created_at: string;
  published_at: string | null;
};

export type UploadResult = {
  version_id: number;
  version_tag: string;
  row_count: number;
  skipped_count: number;
  warnings: string[];
  status: string;
};

export type RoadInventoryPackageMeta = {
  dataset_version_id: number;
  storage_key: string;
  size_bytes: number;
  sha256: string;
  generated_at: string;
  download_url: string | null;
};

export type RoadInventoryManifest = {
  version_id: number;
  version_tag: string;
  extract_date: string | null;
  row_count: number;
  published_at: string | null;
  package:
    | { available: false }
    | ({ available: true } & Omit<RoadInventoryPackageMeta, "dataset_version_id" | "storage_key">);
};

export type RoadSegment = {
  id: number;
  thy_id: number | null;
  district_code: string | null;
  county_code: string;
  route_name: string;
  route_suffix_code: string | null;
  pm_prefix_code: string | null;
  begin_pm: number;
  end_pm: number;
  length_miles: number | null;
  left_lanes: number | null;
  right_lanes: number | null;
  left_surface_type: string | null;
  right_surface_type: string | null;
  left_shoulder_width: number | null;
  right_shoulder_width: number | null;
  median_type: string | null;
  median_width: number | null;
  access_code: string | null;
  terrain_code: string | null;
  design_speed: number | null;
  adt: number | null;
  landmark_short_desc: string | null;
  functional_class_code: string | null;
  maintenance_service_level_code: string | null;
  federal_aid_code: string | null;
  scenic_freeway_code: string | null;
  extract_date: string | null;
};

export async function uploadRoadInventory(
  file: File,
  versionTag?: string,
): Promise<UploadResult> {
  const form = new FormData();
  form.append("file", file, file.name);
  const qs = versionTag ? `?version_tag=${encodeURIComponent(versionTag)}` : "";
  return api<UploadResult>(`/road-inventory/upload${qs}`, {
    method: "POST",
    body: form,
  });
}

export async function listRoadInventoryVersions(): Promise<RoadInventoryDataset[]> {
  return api<RoadInventoryDataset[]>("/road-inventory/versions");
}

export async function publishRoadInventoryVersion(id: number): Promise<void> {
  await api(`/road-inventory/versions/${id}/publish`, { method: "POST" });
}

export async function rollbackRoadInventoryVersion(id: number): Promise<void> {
  await api(`/road-inventory/versions/${id}/rollback`, { method: "POST" });
}

export async function getRoadInventoryManifest(): Promise<RoadInventoryManifest> {
  return api<RoadInventoryManifest>("/road-inventory/manifest");
}

export async function createRoadInventoryImportJob(
  file: File,
  versionTag?: string,
): Promise<CreateImportJobResult> {
  const form = new FormData();
  form.append("file", file, file.name);
  const qs = versionTag ? `?version_tag=${encodeURIComponent(versionTag)}` : "";
  return api<CreateImportJobResult>(`/road-inventory/import-jobs${qs}`, {
    method: "POST",
    body: form,
  });
}

export async function listRoadInventoryImportJobs(): Promise<RoadInventoryImportJob[]> {
  return api<RoadInventoryImportJob[]>("/road-inventory/import-jobs");
}

export async function getRoadInventoryImportJob(
  jobUuid: string,
): Promise<RoadInventoryImportJob> {
  return api<RoadInventoryImportJob>(`/road-inventory/import-jobs/${encodeURIComponent(jobUuid)}`);
}

export async function generateRoadInventoryPackage(
  datasetVersionId: number,
): Promise<RoadInventoryPackageMeta> {
  return api<RoadInventoryPackageMeta>(
    `/road-inventory/versions/${datasetVersionId}/package`,
    { method: "POST" },
  );
}

export async function getRoadInventoryPackage(): Promise<RoadInventoryPackageMeta> {
  return api<RoadInventoryPackageMeta>("/road-inventory/package");
}

export async function lookupRoadSegments(
  county: string,
  route: string,
  postmile: number,
  district?: string,
): Promise<RoadSegment[]> {
  const qs = new URLSearchParams({
    county,
    route,
    postmile: String(postmile),
  });
  if (district) qs.set("district", district);
  const result = await api<{ segments: RoadSegment[] }>(
    `/road-inventory/lookup?${qs.toString()}`,
  );
  return result.segments;
}

import { api } from "./client";

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

export type RoadInventoryManifest = {
  version_id: number;
  version_tag: string;
  extract_date: string | null;
  row_count: number;
  published_at: string | null;
  package: {
    available: boolean;
    download_url: string | null;
    file_size_bytes: number | null;
    sha256: string | null;
    generated_at: string | null;
  };
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

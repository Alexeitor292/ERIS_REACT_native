import { apiFetch } from "./client";

export type RoadInventoryManifest = {
  version_id: number;
  version_tag: string;
  extract_date: string | null;
  row_count: number;
  published_at: string | null;
  package:
    | { available: false }
    | {
        available: true;
        size_bytes: number;
        sha256: string;
        generated_at: string;
        download_url: string | null;
      };
};

export type RoadInventoryPackageMeta = {
  dataset_version_id: number;
  storage_key: string;
  size_bytes: number;
  sha256: string;
  generated_at: string;
  download_url: string | null;
};

export async function getRoadInventoryManifest(
  token: string,
): Promise<RoadInventoryManifest> {
  return apiFetch<RoadInventoryManifest>("/road-inventory/manifest", { token });
}

export async function getRoadInventoryPackage(
  token: string,
): Promise<RoadInventoryPackageMeta> {
  return apiFetch<RoadInventoryPackageMeta>("/road-inventory/package", {
    token,
  });
}

export async function downloadRoadInventoryPackage(
  downloadUrl: string,
): Promise<Uint8Array> {
  const res = await fetch(downloadUrl);
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }
  const buffer = await res.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Road inventory offline sync service.
 *
 * Sync flow:
 *   1. Fetch manifest from backend (requires auth).
 *   2. Verify a json_gz package is available with a download_url.
 *   3. Download the compressed bytes via fetch().
 *   4. Verify SHA256 of the compressed bytes against manifest.package.sha256.
 *   5. Gunzip with pako.
 *   6. Decode UTF-8, JSON.parse.
 *   7. Validate schema_version === 1.
 *   8. Persist segments to a local file (expo-file-system).
 *   9. Persist metadata to SecureStore.
 *
 * Lookup:
 *   loadSegments() reads the file on first call, then caches in memory.
 *   lookupLocalRoadSegments() filters by county/route/postmile and sorts
 *   by district match preference, then by shortest segment range.
 *
 * TODO: form integration — call lookupLocalRoadSegments() from incident or
 *   submission forms when county/route/postmile fields are known.
 */

import { File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { inflate } from "pako";
import { sha256 } from "js-sha256";

import {
  downloadRoadInventoryPackage,
  getRoadInventoryManifest,
} from "../api/roadInventory";

// ---------------------------------------------------------------------------
// Storage keys / paths
// ---------------------------------------------------------------------------

const META_KEY = "road_inventory_offline_meta_v1";
const SEGMENTS_FILENAME = "road_inventory_segments_v1.json";

function segmentsFile(): File {
  return new File(Paths.document, SEGMENTS_FILENAME);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RoadSegment = {
  id: number;
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
  median_type: string | null;
  median_width: number | null;
  terrain_code: string | null;
  design_speed: number | null;
  adt: number | null;
  landmark_short_desc: string | null;
};

export type LocalPackageMeta = {
  dataset_version_id: number;
  version_tag: string;
  extract_date: string | null;
  generated_at: string;
  row_count: number;
  sha256: string;
  synced_at: string;
};

export type RoadInventoryLocalStatus =
  | { available: false }
  | { available: true; meta: LocalPackageMeta };

// ---------------------------------------------------------------------------
// In-memory segments cache (cleared on sync / clear)
// ---------------------------------------------------------------------------

let segmentsCache: RoadSegment[] | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getLocalRoadInventoryStatus(): Promise<RoadInventoryLocalStatus> {
  try {
    const raw = await SecureStore.getItemAsync(META_KEY);
    if (!raw) return { available: false };
    const meta = JSON.parse(raw) as LocalPackageMeta;
    // Verify the segments file also exists
    if (!segmentsFile().exists) return { available: false };
    return { available: true, meta };
  } catch {
    return { available: false };
  }
}

export async function syncRoadInventoryPackage(
  token: string,
): Promise<LocalPackageMeta> {
  // 1. Fetch manifest
  const manifest = await getRoadInventoryManifest(token);

  if (!manifest.package.available) {
    throw new Error(
      "No mobile package has been generated yet. Ask an administrator to generate one from the web admin panel.",
    );
  }

  const pkg = manifest.package;
  if (!pkg.download_url) {
    throw new Error(
      "Package download URL is unavailable. Check MinIO configuration.",
    );
  }

  // 2. Download compressed bytes
  const compressed = await downloadRoadInventoryPackage(pkg.download_url);

  // 3. Verify SHA256
  const computedHash = sha256(compressed);
  if (computedHash !== pkg.sha256) {
    throw new Error(
      `Package integrity check failed: expected ${pkg.sha256.slice(0, 12)}… got ${computedHash.slice(0, 12)}…`,
    );
  }

  // 4. Gunzip
  let inflated: Uint8Array;
  try {
    inflated = inflate(compressed);
  } catch (e: any) {
    throw new Error(`Failed to decompress package: ${e?.message ?? e}`);
  }

  // 5. Decode + parse
  const decoder = new TextDecoder("utf-8");
  const jsonStr = decoder.decode(inflated);

  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e: any) {
    throw new Error(`Failed to parse package JSON: ${e?.message ?? e}`);
  }

  // 6. Validate
  if (parsed?.schema_version !== 1) {
    throw new Error(
      `Unsupported package schema_version: ${parsed?.schema_version}. Update the app.`,
    );
  }
  if (!Array.isArray(parsed?.segments)) {
    throw new Error("Package JSON is missing the segments array.");
  }

  const segments: RoadSegment[] = parsed.segments;

  // 7. Persist segments to file
  segmentsFile().write(JSON.stringify(segments));

  // 8. Persist metadata
  const meta: LocalPackageMeta = {
    dataset_version_id: manifest.version_id,
    version_tag: manifest.version_tag,
    extract_date: manifest.extract_date,
    generated_at: pkg.generated_at,
    row_count: segments.length,
    sha256: pkg.sha256,
    synced_at: new Date().toISOString(),
  };
  await SecureStore.setItemAsync(META_KEY, JSON.stringify(meta));

  // 9. Update in-memory cache
  segmentsCache = segments;

  return meta;
}

export async function clearLocalRoadInventoryPackage(): Promise<void> {
  segmentsCache = null;
  try {
    const f = segmentsFile();
    if (f.exists) f.delete();
  } catch {
    // ignore
  }
  try {
    await SecureStore.deleteItemAsync(META_KEY);
  } catch {
    // ignore
  }
}

export async function lookupLocalRoadSegments(params: {
  countyCode: string;
  routeName: string;
  postmile: number;
  districtCode?: string;
}): Promise<RoadSegment[]> {
  const segments = await loadSegments();
  if (!segments || segments.length === 0) return [];

  const county = params.countyCode.trim().toUpperCase();
  const route = normalizeRoute(params.routeName);
  const pm = params.postmile;

  const matches = segments.filter(
    (s) =>
      s.county_code.toUpperCase() === county &&
      s.route_name === route &&
      s.begin_pm <= pm &&
      s.end_pm >= pm,
  );

  matches.sort((a, b) => {
    // Prefer district match
    const dist = params.districtCode;
    const aMatch = dist && a.district_code === dist ? 0 : 1;
    const bMatch = dist && b.district_code === dist ? 0 : 1;
    if (aMatch !== bMatch) return aMatch - bMatch;
    // Then prefer shortest range
    return a.end_pm - a.begin_pm - (b.end_pm - b.begin_pm);
  });

  return matches;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function loadSegments(): Promise<RoadSegment[] | null> {
  if (segmentsCache !== null) return segmentsCache;
  try {
    const f = segmentsFile();
    if (!f.exists) return null;
    const content = await f.text();
    segmentsCache = JSON.parse(content) as RoadSegment[];
    return segmentsCache;
  } catch {
    return null;
  }
}

/**
 * Normalize a route string to match what the backend stores.
 * "001" → "1", "050" → "50", "US 101" → "101", "SR 99" → "99"
 */
function normalizeRoute(route: string): string {
  if (!route) return route;
  let r = route.trim();
  // Strip common prefix words
  r = r.replace(/^(US|SR|CA|HWY|HIGHWAY)\s+/i, "");
  // Strip leading zeros from numeric-looking strings
  r = r.replace(/^0+(\d+)$/, "$1");
  return r;
}

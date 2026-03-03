import { ARCGIS_MMPK_PATH, ARCGIS_MMPK_URL } from "../config";
import { getLargeItemAsync, setLargeItemAsync } from "./secureStoreLarge";

const MAP_PRELOAD_KEY = "offline_map_preload_registry_v1";

export type MapPreloadState = "PENDING" | "READY" | "FAILED";

export type MapPreloadRecord = {
  submissionId: number;
  incidentId: number;
  latitude: number;
  longitude: number;
  requestedAt: string;
  preparedAt: string | null;
  status: MapPreloadState;
  mmpkPath: string | null;
  error: string | null;
};

type Registry = {
  version: 1;
  items: MapPreloadRecord[];
};

function emptyRegistry(): Registry {
  return { version: 1, items: [] };
}

async function readRegistry(): Promise<Registry> {
  try {
    const raw = await getLargeItemAsync(MAP_PRELOAD_KEY);
    if (!raw) return emptyRegistry();
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || !Array.isArray(parsed?.items)) return emptyRegistry();
    return parsed as Registry;
  } catch {
    return emptyRegistry();
  }
}

async function writeRegistry(registry: Registry): Promise<void> {
  await setLargeItemAsync(MAP_PRELOAD_KEY, JSON.stringify(registry));
}

function upsertRecord(items: MapPreloadRecord[], next: MapPreloadRecord): MapPreloadRecord[] {
  const idx = items.findIndex((x) => x.submissionId === next.submissionId);
  if (idx < 0) return [next, ...items];
  const copy = [...items];
  copy[idx] = next;
  return copy;
}

export async function getMapPreloadBySubmission(submissionId: number): Promise<MapPreloadRecord | null> {
  const registry = await readRegistry();
  return registry.items.find((x) => x.submissionId === submissionId) ?? null;
}

export async function queueIncidentMapPreload(params: {
  incidentId: number;
  submissionId: number;
  latitude: number;
  longitude: number;
}): Promise<MapPreloadRecord> {
  const base: MapPreloadRecord = {
    incidentId: params.incidentId,
    submissionId: params.submissionId,
    latitude: params.latitude,
    longitude: params.longitude,
    requestedAt: new Date().toISOString(),
    preparedAt: null,
    status: "PENDING",
    mmpkPath: null,
    error: null,
  };
  const registry = await readRegistry();
  const queued = { ...base };
  await writeRegistry({ ...registry, items: upsertRecord(registry.items, queued) });

  try {
    const bridge = await import("../arcgis/ArcGISNative");
    if (!bridge?.isArcGisNativeAvailable?.()) {
      throw new Error("ArcGIS native bridge unavailable.");
    }
    let resolvedPath = ARCGIS_MMPK_PATH;
    if (ARCGIS_MMPK_URL) {
      resolvedPath = await bridge.downloadMmpk(ARCGIS_MMPK_URL);
    }
    if (!resolvedPath) {
      throw new Error("Configure EXPO_PUBLIC_ARCGIS_MMPK_URL or EXPO_PUBLIC_ARCGIS_MMPK_PATH.");
    }
    await bridge.loadMmpk(resolvedPath);
    const ready: MapPreloadRecord = {
      ...queued,
      preparedAt: new Date().toISOString(),
      status: "READY",
      mmpkPath: resolvedPath,
      error: null,
    };
    const after = await readRegistry();
    await writeRegistry({ ...after, items: upsertRecord(after.items, ready) });
    return ready;
  } catch (e: any) {
    const failed: MapPreloadRecord = {
      ...queued,
      preparedAt: new Date().toISOString(),
      status: "FAILED",
      mmpkPath: ARCGIS_MMPK_PATH || null,
      error: String(e?.message ?? e),
    };
    const after = await readRegistry();
    await writeRegistry({ ...after, items: upsertRecord(after.items, failed) });
    return failed;
  }
}

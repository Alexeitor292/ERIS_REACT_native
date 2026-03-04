import { apiFetch } from "../api/client";
import { getLargeItemAsync, setLargeItemAsync } from "./secureStoreLarge";

const ARCGIS_RUNTIME_CONFIG_CACHE_KEY = "offline_arcgis_runtime_config_v1";

export type ArcgisRuntimeConfig = {
  runtime_enabled: boolean;
  api_key: string | null;
  license_key: string | null;
  license_expires_at: string | null;
  mmpk_url: string | null;
  offline_ttl_hours: number;
  issued_at: string;
};

type CachedArcgisRuntimeConfig = {
  version: 1;
  payload: ArcgisRuntimeConfig;
  cached_at: string;
};

function isExpired(cache: CachedArcgisRuntimeConfig): boolean {
  const hours = Math.max(1, Number(cache.payload.offline_ttl_hours || 0));
  const issuedAtMs = Date.parse(cache.payload.issued_at || "");
  if (Number.isNaN(issuedAtMs)) return false;
  return Date.now() > issuedAtMs + hours * 60 * 60 * 1000;
}

export async function readCachedArcgisRuntimeConfig(): Promise<ArcgisRuntimeConfig | null> {
  try {
    const raw = await getLargeItemAsync(ARCGIS_RUNTIME_CONFIG_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedArcgisRuntimeConfig;
    if (!parsed || parsed.version !== 1 || !parsed.payload) return null;
    if (isExpired(parsed)) return null;
    return parsed.payload;
  } catch {
    return null;
  }
}

async function writeCachedArcgisRuntimeConfig(payload: ArcgisRuntimeConfig): Promise<void> {
  const body: CachedArcgisRuntimeConfig = {
    version: 1,
    payload,
    cached_at: new Date().toISOString(),
  };
  await setLargeItemAsync(ARCGIS_RUNTIME_CONFIG_CACHE_KEY, JSON.stringify(body));
}

export async function syncArcgisRuntimeConfig(token: string): Promise<ArcgisRuntimeConfig | null> {
  try {
    const online = await apiFetch<ArcgisRuntimeConfig>("/arcgis/runtime-config", { token });
    await writeCachedArcgisRuntimeConfig(online);
    return online;
  } catch {
    return readCachedArcgisRuntimeConfig();
  }
}


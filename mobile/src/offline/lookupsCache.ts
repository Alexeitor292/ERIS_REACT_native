import { getLargeItemAsync, setLargeItemAsync } from "./secureStoreLarge";

const LOOKUPS_CACHE_KEY = "offline_gisa_lookups_cache_v1";

export async function readLookupsCache<T = any>(): Promise<T | null> {
  try {
    const raw = await getLargeItemAsync(LOOKUPS_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeLookupsCache(payload: any): Promise<void> {
  try {
    await setLargeItemAsync(LOOKUPS_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // ignore cache write failures
  }
}

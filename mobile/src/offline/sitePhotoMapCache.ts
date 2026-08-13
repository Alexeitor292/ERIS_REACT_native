import { getLargeItemAsync, setLargeItemAsync } from "./secureStoreLarge";

const SITE_PHOTO_MAP_CACHE_PREFIX = "site_photo_map_payload_v1_";

type CachedSitePhotoMap = {
  version: 1;
  submissionId: string;
  cachedAt: string;
  payload: any;
};

function cacheKey(submissionId: string | number): string {
  const safe = String(submissionId || "").replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${SITE_PHOTO_MAP_CACHE_PREFIX}${safe}`;
}

function stripEphemeralServerUrls(payload: any): any {
  if (!payload || typeof payload !== "object") return payload;
  const photos = Array.isArray(payload.photos)
    ? payload.photos.map((photo: any) => {
        if (!photo || typeof photo !== "object") return photo;
        const { download_url: _downloadUrl, ...rest } = photo;
        return rest;
      })
    : [];
  return { ...payload, photos };
}

export async function writeSitePhotoMapCache(
  submissionId: string | number,
  payload: any,
): Promise<void> {
  const record: CachedSitePhotoMap = {
    version: 1,
    submissionId: String(submissionId),
    cachedAt: new Date().toISOString(),
    payload: stripEphemeralServerUrls(payload),
  };
  await setLargeItemAsync(cacheKey(submissionId), JSON.stringify(record));
}

export async function readSitePhotoMapCache(
  submissionId: string | number,
): Promise<any | null> {
  try {
    const raw = await getLargeItemAsync(cacheKey(submissionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedSitePhotoMap;
    if (
      parsed?.version !== 1 ||
      String(parsed?.submissionId ?? "") !== String(submissionId) ||
      !parsed?.payload ||
      typeof parsed.payload !== "object"
    ) {
      return null;
    }
    return parsed.payload;
  } catch {
    return null;
  }
}

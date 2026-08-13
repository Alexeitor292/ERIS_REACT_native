import { apiFetch } from "../api/client";
import { getLargeItemAsync, setLargeItemAsync } from "./secureStoreLarge";

const STORAGE_KEY = "offline_photo_correction_queue_v1";
const MAX_CAPTURE_LOCATION_ACCURACY_M = 20;
const MIN_CAPTURE_HEADING_ACCURACY_CODE = 2;

export type PhotoLocationOverride = {
  latitude: number;
  longitude: number;
};

export type PhotoCorrectionState = {
  attachment_id: number;
  location_override: PhotoLocationOverride | null;
  heading_override_deg: number | null;
};

type QueuedPhotoCorrection = PhotoCorrectionState & {
  localId: string;
  client_correction_uuid: string;
  submission_id: number;
  createdAt: string;
  attempts: number;
  lastError: string | null;
};

type PhotoMapPayloadLike = {
  submission_id?: unknown;
  photos?: any[];
  summary?: unknown;
  [key: string]: unknown;
};

export type PhotoCorrectionQueueSyncResult = {
  processed: number;
  remaining: number;
  firstError: string | null;
};

function makeCorrectionId(): string {
  return `photo_corr_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

function finite(value: unknown): number | null {
  const out = Number(value);
  return Number.isFinite(out) ? out : null;
}

function normalizeCorrection(raw: any): PhotoCorrectionState | null {
  const attachmentId = Number(raw?.attachment_id);
  if (!Number.isInteger(attachmentId) || attachmentId <= 0) return null;

  let locationOverride: PhotoLocationOverride | null = null;
  if (raw?.location_override != null) {
    const latitude = finite(raw.location_override.latitude);
    const longitude = finite(raw.location_override.longitude);
    if (latitude == null || longitude == null || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return null;
    }
    locationOverride = { latitude, longitude };
  }

  let headingOverride: number | null = null;
  if (raw?.heading_override_deg != null) {
    const heading = finite(raw.heading_override_deg);
    if (heading == null || heading < 0 || heading >= 360) return null;
    headingOverride = heading;
  }

  return {
    attachment_id: attachmentId,
    location_override: locationOverride,
    heading_override_deg: headingOverride,
  };
}

async function readQueue(): Promise<QueuedPhotoCorrection[]> {
  try {
    const raw = await getLargeItemAsync(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item: any) => {
      const normalized = normalizeCorrection(item);
      const submissionId = Number(item?.submission_id);
      const localId = String(item?.localId ?? "");
      const clientUuid = String(item?.client_correction_uuid ?? "");
      if (!normalized || !Number.isInteger(submissionId) || submissionId <= 0 || !localId.startsWith("photo_corr_") || !clientUuid) {
        return [];
      }
      return [{
        ...normalized,
        localId,
        client_correction_uuid: clientUuid,
        submission_id: submissionId,
        createdAt: String(item?.createdAt ?? new Date().toISOString()),
        attempts: Number.isFinite(Number(item?.attempts)) ? Number(item.attempts) : 0,
        lastError: item?.lastError ? String(item.lastError) : null,
      } satisfies QueuedPhotoCorrection];
    });
  } catch {
    return [];
  }
}

async function writeQueue(records: QueuedPhotoCorrection[]): Promise<void> {
  await setLargeItemAsync(STORAGE_KEY, JSON.stringify(records));
}

export async function enqueuePhotoCorrectionsForSync(
  submissionId: number,
  corrections: PhotoCorrectionState[],
): Promise<number> {
  if (!Number.isInteger(submissionId) || submissionId <= 0) return 0;
  const queue = await readQueue();
  const now = new Date().toISOString();
  let added = 0;

  for (const raw of corrections) {
    const correction = normalizeCorrection(raw);
    if (!correction) continue;
    const id = makeCorrectionId();
    queue.push({
      ...correction,
      localId: id,
      client_correction_uuid: id,
      submission_id: submissionId,
      createdAt: now,
      attempts: 0,
      lastError: null,
    });
    added += 1;
  }

  if (added > 0) await writeQueue(queue);
  return added;
}

export async function getQueuedPhotoCorrectionCount(): Promise<number> {
  return (await readQueue()).length;
}

let flushing = false;

export async function flushQueuedPhotoCorrections(token: string): Promise<PhotoCorrectionQueueSyncResult> {
  if (flushing) {
    return { processed: 0, remaining: await getQueuedPhotoCorrectionCount(), firstError: null };
  }

  flushing = true;
  try {
    let queue = await readQueue();
    let processed = 0;
    let firstError: string | null = null;

    while (queue.length > 0) {
      const current = queue[0];
      try {
        await apiFetch(
          `/submissions/${current.submission_id}/photo-map/photos/${current.attachment_id}/correction`,
          {
            method: "PUT",
            token,
            body: {
              client_correction_uuid: current.client_correction_uuid,
              location_override: current.location_override,
              heading_override_deg: current.heading_override_deg,
            },
          },
        );
        queue.shift();
        await writeQueue(queue);
        processed += 1;
      } catch (error: any) {
        const message = String(error?.message ?? error ?? "Photo correction sync failed");
        queue[0] = { ...current, attempts: current.attempts + 1, lastError: message };
        await writeQueue(queue);
        firstError = message;
        break;
      }
    }

    return { processed, remaining: queue.length, firstError };
  } finally {
    flushing = false;
  }
}

function capturedLocationIsMappable(photo: any): boolean {
  const captured = photo?.captured_metadata;
  const latitude = finite(captured?.latitude);
  const longitude = finite(captured?.longitude);
  const accuracy = finite(captured?.horizontal_accuracy_m);
  return latitude != null && longitude != null && accuracy != null
    && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
    && accuracy >= 0 && accuracy <= MAX_CAPTURE_LOCATION_ACCURACY_M;
}

function capturedHeadingIsMappable(photo: any): boolean {
  const captured = photo?.captured_metadata;
  const heading = finite(captured?.camera_heading_deg);
  const accuracyCode = Number(captured?.camera_heading_accuracy_code);
  return heading != null && heading >= 0 && heading < 360
    && Number.isInteger(accuracyCode) && accuracyCode >= MIN_CAPTURE_HEADING_ACCURACY_CODE
    && captured?.heading_reference === "TRUE_NORTH";
}

export async function applyQueuedPhotoCorrectionsToPayload<T extends PhotoMapPayloadLike>(payload: T): Promise<T> {
  const submissionId = Number(payload?.submission_id);
  if (!Number.isInteger(submissionId) || submissionId <= 0 || !Array.isArray(payload?.photos)) return payload;

  const pending = (await readQueue()).filter((item) => item.submission_id === submissionId);
  if (pending.length === 0) return payload;

  const latest = new Map<number, QueuedPhotoCorrection>();
  for (const item of pending) latest.set(item.attachment_id, item);

  const photos = payload.photos.map((photo: any) => {
    const correction = latest.get(Number(photo?.attachment_id));
    if (!correction) return photo;
    const next = { ...photo };

    if (correction.location_override) {
      next.latitude = correction.location_override.latitude;
      next.longitude = correction.location_override.longitude;
      next.horizontal_accuracy_m = null;
      next.altitude_m = null;
      next.location_source = "MANUAL";
    } else if (capturedLocationIsMappable(photo)) {
      next.latitude = Number(photo.captured_metadata.latitude);
      next.longitude = Number(photo.captured_metadata.longitude);
      next.horizontal_accuracy_m = Number(photo.captured_metadata.horizontal_accuracy_m);
      next.altitude_m = finite(photo.captured_metadata.altitude_m);
      next.location_source = photo.captured_metadata.location_source ?? null;
    } else {
      next.latitude = null;
      next.longitude = null;
      next.horizontal_accuracy_m = finite(photo?.captured_metadata?.horizontal_accuracy_m);
      next.altitude_m = null;
      next.location_source = null;
    }

    if (correction.heading_override_deg != null) {
      next.camera_heading_deg = correction.heading_override_deg;
      next.camera_heading_accuracy_code = null;
      next.heading_reference = "TRUE_NORTH";
      next.heading_source = "MANUAL";
    } else if (capturedHeadingIsMappable(photo)) {
      next.camera_heading_deg = Number(photo.captured_metadata.camera_heading_deg);
      next.camera_heading_accuracy_code = Number(photo.captured_metadata.camera_heading_accuracy_code);
      next.heading_reference = "TRUE_NORTH";
      next.heading_source = photo.captured_metadata.heading_source ?? null;
    } else {
      next.camera_heading_deg = null;
      next.camera_heading_accuracy_code = photo?.captured_metadata?.camera_heading_accuracy_code ?? null;
      next.heading_reference = null;
      next.heading_source = null;
    }

    next.correction = {
      ...(photo.correction ?? {}),
      location_overridden: correction.location_override != null,
      heading_overridden: correction.heading_override_deg != null,
      location_override: correction.location_override,
      heading_override_deg: correction.heading_override_deg,
      pending_local: true,
    };
    return next;
  });

  const mapped = photos.filter((photo: any) => photo.latitude != null && photo.longitude != null);
  const headed = mapped.filter((photo: any) => photo.camera_heading_deg != null);
  return {
    ...payload,
    photos,
    summary: {
      photos_total: photos.length,
      photos_geotagged: mapped.length,
      photos_with_heading: headed.length,
      photos_unmapped: photos.length - mapped.length,
    },
  } as T;
}

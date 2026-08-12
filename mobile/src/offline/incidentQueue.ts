import {
  createIncident,
  listIncidents,
  uploadIncidentAttachment,
  type Incident,
  type IncidentAttachmentKind,
  type IncidentCreatePayload,
} from "../api/incidents";
import { normalizeCoordinateValue, normalizePostMileInput } from "../utils/precision";
import { getLargeItemAsync, setLargeItemAsync } from "./secureStoreLarge";

const STORAGE_KEY = "offline_incident_queue_v1";
const UNCERTAIN_CREATE_WINDOW_MS = 90_000;

export type QueuedIncidentFile = {
  uri: string;
  name: string;
  type: string;
  kind: IncidentAttachmentKind;
  size?: number | null;
  uploaded: boolean;
};

export type QueuedIncidentRecord = {
  localId: string;
  createdAt: string;
  updatedAt: string;
  payload: IncidentCreatePayload;
  files: QueuedIncidentFile[];
  serverIncidentId: number | null;
  lastCreateAttemptAt: string | null;
  attempts: number;
  syncState: "PENDING" | "ERROR";
  lastError: string | null;
};

export type IncidentQueueSyncResult = {
  processed: number;
  remaining: number;
  firstError: string | null;
};

function makeLocalId(): string {
  return `local_incident_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function readQueue(): Promise<QueuedIncidentRecord[]> {
  try {
    const raw = await getLargeItemAsync(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x) => x && typeof x === "object" && String(x.localId || "").startsWith("local_incident_"))
      .map((x) => ({
        localId: String(x.localId),
        createdAt: String(x.createdAt || new Date().toISOString()),
        updatedAt: String(x.updatedAt || x.createdAt || new Date().toISOString()),
        payload: x.payload as IncidentCreatePayload,
        files: Array.isArray(x.files)
          ? x.files.map((file: any) => ({
              uri: String(file?.uri || ""),
              name: String(file?.name || "incident-file.bin"),
              type: String(file?.type || "application/octet-stream"),
              kind: String(file?.kind || "DOC") as IncidentAttachmentKind,
              size: typeof file?.size === "number" ? file.size : null,
              uploaded: !!file?.uploaded,
            }))
          : [],
        serverIncidentId:
          typeof x.serverIncidentId === "number" && Number.isFinite(x.serverIncidentId)
            ? x.serverIncidentId
            : null,
        lastCreateAttemptAt: x.lastCreateAttemptAt ? String(x.lastCreateAttemptAt) : null,
        attempts: Number.isFinite(Number(x.attempts)) ? Number(x.attempts) : 0,
        syncState: x.syncState === "ERROR" ? "ERROR" : "PENDING",
        lastError: x.lastError ? String(x.lastError) : null,
      } satisfies QueuedIncidentRecord));
  } catch {
    return [];
  }
}

async function writeQueue(records: QueuedIncidentRecord[]): Promise<void> {
  await setLargeItemAsync(STORAGE_KEY, JSON.stringify(records));
}

export async function enqueueIncidentForSync(
  payload: IncidentCreatePayload,
  files: Omit<QueuedIncidentFile, "uploaded">[] = [],
): Promise<QueuedIncidentRecord> {
  const queue = await readQueue();
  const now = new Date().toISOString();
  const record: QueuedIncidentRecord = {
    localId: makeLocalId(),
    createdAt: now,
    updatedAt: now,
    payload,
    files: files.map((file) => ({ ...file, uploaded: false })),
    serverIncidentId: null,
    lastCreateAttemptAt: null,
    attempts: 0,
    syncState: "PENDING",
    lastError: null,
  };
  queue.push(record);
  await writeQueue(queue);
  return record;
}

export async function listQueuedIncidents(): Promise<QueuedIncidentRecord[]> {
  return readQueue();
}

export async function getQueuedIncidentCount(): Promise<number> {
  return (await readQueue()).length;
}

function norm(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function sameCoordinate(a: unknown, b: unknown): boolean {
  const av = normalizeCoordinateValue(a as any);
  const bv = normalizeCoordinateValue(b as any);
  return av != null && bv != null && Math.abs(av - bv) <= 0.000001;
}

function sameOptionalDate(a: unknown, b: unknown): boolean {
  return String(a ?? "").slice(0, 10) === String(b ?? "").slice(0, 10);
}

function likelySameIncident(record: QueuedIncidentRecord, incident: Incident): boolean {
  const payload = record.payload;
  if (!sameCoordinate(payload.latitude, incident.latitude)) return false;
  if (!sameCoordinate(payload.longitude, incident.longitude)) return false;
  if (norm(payload.district) !== norm(incident.district)) return false;
  if (norm(payload.county) !== norm(incident.county)) return false;
  if (norm(payload.route).replace(/^0+/, "") !== norm(incident.route).replace(/^0+/, "")) return false;
  if (normalizePostMileInput(payload.post_mile) !== normalizePostMileInput(incident.post_mile)) return false;
  if (norm(payload.title) !== norm(incident.title)) return false;
  if (norm(payload.incident_type) !== norm(incident.incident_type)) return false;
  if (norm(payload.description) !== norm(incident.description)) return false;
  if (!sameOptionalDate(payload.first_observed_at, incident.first_observed_at)) return false;
  if (!sameOptionalDate(payload.first_occurred_at, incident.first_occurred_at)) return false;

  const attemptedAt = Date.parse(record.lastCreateAttemptAt || "");
  const serverCreatedAt = Date.parse(incident.created_at);
  if (!Number.isFinite(attemptedAt) || !Number.isFinite(serverCreatedAt)) return false;
  if (Math.abs(serverCreatedAt - attemptedAt) > UNCERTAIN_CREATE_WINDOW_MS) return false;
  return true;
}

/**
 * A POST can be committed server-side while its response is lost. Before a
 * previously-attempted local incident is POSTed again, reconcile against the
 * reporter-visible incident list. Reconciliation uses the exact timestamp that
 * was durably persisted immediately before the POST, plus the incident's full
 * location/date/text fingerprint. If reconciliation itself cannot be completed,
 * fail closed and do not perform another POST.
 */
async function reconcileUncertainCreate(
  token: string,
  record: QueuedIncidentRecord,
): Promise<number | null> {
  if (!record.lastCreateAttemptAt) return null;
  const response = await listIncidents(token, { limit: 200, scope: "mobile" });
  const match = (response.items ?? []).find((incident) => likelySameIncident(record, incident));
  return match?.id ?? null;
}

async function syncOne(
  token: string,
  record: QueuedIncidentRecord,
  persist: (next: QueuedIncidentRecord) => Promise<void>,
): Promise<QueuedIncidentRecord> {
  let next = { ...record, files: record.files.map((file) => ({ ...file })) };

  if (!next.serverIncidentId) {
    if (next.attempts > 0 && next.lastCreateAttemptAt) {
      const reconciledId = await reconcileUncertainCreate(token, next);
      if (reconciledId) {
        next.serverIncidentId = reconciledId;
        next.updatedAt = new Date().toISOString();
        next.lastError = null;
        next.syncState = "PENDING";
        await persist(next);
      }
    }

    if (!next.serverIncidentId) {
      // Persist the attempt boundary before the network mutation. If the server
      // commits but the response is lost, the next retry has a narrow, durable
      // time window for reconciliation and never needs to blind-POST.
      next.lastCreateAttemptAt = new Date().toISOString();
      next.updatedAt = next.lastCreateAttemptAt;
      next.lastError = null;
      next.syncState = "PENDING";
      await persist(next);

      const created = await createIncident(token, next.payload);
      next.serverIncidentId = created.incident.id;
      next.updatedAt = new Date().toISOString();
      next.lastError = null;
      next.syncState = "PENDING";
      await persist(next);
    }
  }

  for (let i = 0; i < next.files.length; i += 1) {
    if (next.files[i].uploaded) continue;
    const file = next.files[i];
    await uploadIncidentAttachment(
      token,
      next.serverIncidentId,
      { uri: file.uri, name: file.name, type: file.type },
      { kind: file.kind },
    );
    next.files[i] = { ...file, uploaded: true };
    next.updatedAt = new Date().toISOString();
    await persist(next);
  }

  return next;
}

let flushing = false;

export async function flushQueuedIncidents(token: string): Promise<IncidentQueueSyncResult> {
  if (flushing) {
    const remaining = await getQueuedIncidentCount();
    return { processed: 0, remaining, firstError: null };
  }

  flushing = true;
  try {
    let queue = await readQueue();
    let processed = 0;
    let firstError: string | null = null;

    while (queue.length > 0) {
      const current = queue[0];
      const persistHead = async (next: QueuedIncidentRecord) => {
        queue[0] = next;
        await writeQueue(queue);
      };

      try {
        await syncOne(token, current, persistHead);
        queue.shift();
        await writeQueue(queue);
        processed += 1;
      } catch (error: any) {
        const message = String(error?.message ?? error ?? "Incident sync failed");
        queue[0] = {
          ...queue[0],
          attempts: (queue[0].attempts ?? 0) + 1,
          syncState: "ERROR",
          lastError: message,
          updatedAt: new Date().toISOString(),
        };
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

import * as SecureStore from "expo-secure-store";
import {
  patchSubmission,
  replaceActions,
  replaceIncidentTypes,
  submitSubmission,
  uploadSubmissionAttachment,
} from "../api/submissions";
import { apiFetch } from "../api/client";
import {
  getLocalDraft,
  isLocalDraftId,
  markLocalDraftError,
  markLocalDraftSynced,
  resolveServerSubmissionId,
} from "./localDrafts";

const OFFLINE_QUEUE_KEY = "offline_sync_queue_v1";
const OFFLINE_QUEUE_META_KEY = "offline_sync_queue_meta_v2";
const OFFLINE_QUEUE_PART_PREFIX = "offline_sync_queue_part_";
const SECURESTORE_CHUNK_SIZE = 1800;

type QueueStorageMeta = {
  version: 2;
  parts: number;
};

type QueueOpType =
  | "CREATE_SUBMISSION_FOR_LOCAL_DRAFT"
  | "PATCH_SUBMISSION"
  | "REPLACE_INCIDENT_TYPES"
  | "REPLACE_ACTIONS"
  | "SUBMIT_SUBMISSION"
  | "UPLOAD_ATTACHMENT";

type QueuePayloadMap = {
  CREATE_SUBMISSION_FOR_LOCAL_DRAFT: { localId: string };
  PATCH_SUBMISSION: { submissionId: string; patch: any };
  REPLACE_INCIDENT_TYPES: { submissionId: string; items: string[] };
  REPLACE_ACTIONS: { submissionId: string; immediate: string[]; follow_up: string[] };
  SUBMIT_SUBMISSION: { submissionId: string; comment?: string | null };
  UPLOAD_ATTACHMENT: {
    submissionId: string;
    file: { uri: string; name: string; type: string };
    sectionKey?: string | null;
    kind?: "PHOTO" | "VIDEO" | "DOC" | "SKETCH";
  };
};

export type OfflineQueueItem<T extends QueueOpType = QueueOpType> = {
  id: string;
  type: T;
  payload: QueuePayloadMap[T] | any;
  createdAt: string;
  attempts: number;
  lastError?: string;
};

export type OfflineQueueSummary = {
  count: number;
  firstItemType?: QueueOpType;
  firstItemSubmissionId?: string | null;
  firstItemLastError?: string | null;
};

export type OfflineQueueDiagnosis = {
  count: number;
  head?: {
    type: QueueOpType;
    submissionId: string | null;
    resolvedSubmissionId: string | null;
    attempts: number;
    lastError: string | null;
    localDraftExists: boolean | null;
    localDraftServerId: string | null;
  };
};

function makeId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function queuePartKey(idx: number): string {
  return `${OFFLINE_QUEUE_PART_PREFIX}${idx}`;
}

function chunkText(value: string, size: number): string[] {
  if (!value) return [""];
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += size) {
    chunks.push(value.slice(i, i + size));
  }
  return chunks;
}

async function readQueueMeta(): Promise<QueueStorageMeta | null> {
  try {
    const raw = await SecureStore.getItemAsync(OFFLINE_QUEUE_META_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 2 || typeof parsed.parts !== "number" || parsed.parts < 0) {
      return null;
    }
    return parsed as QueueStorageMeta;
  } catch {
    return null;
  }
}

async function cleanupQueueParts(fromIdx: number, toIdxExclusive: number): Promise<void> {
  for (let i = fromIdx; i < toIdxExclusive; i += 1) {
    try {
      await SecureStore.deleteItemAsync(queuePartKey(i));
    } catch {
      // ignore cleanup failures
    }
  }
}

async function readQueue(): Promise<OfflineQueueItem[]> {
  try {
    const meta = await readQueueMeta();
    if (meta && meta.parts >= 0) {
      const parts: string[] = [];
      for (let i = 0; i < meta.parts; i += 1) {
        const part = await SecureStore.getItemAsync(queuePartKey(i));
        if (part == null) return [];
        parts.push(part);
      }
      const raw = parts.join("");
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed as OfflineQueueItem[];
    }

    // Legacy v1 fallback and one-time migration.
    const legacyRaw = await SecureStore.getItemAsync(OFFLINE_QUEUE_KEY);
    if (!legacyRaw) return [];
    const parsed = JSON.parse(legacyRaw);
    if (!Array.isArray(parsed)) return [];
    const items = parsed as OfflineQueueItem[];
    await writeQueue(items);
    return items;
  } catch {
    return [];
  }
}

async function writeQueue(items: OfflineQueueItem[]): Promise<void> {
  const payload = JSON.stringify(items);
  const chunks = chunkText(payload, SECURESTORE_CHUNK_SIZE);
  const prevMeta = await readQueueMeta();
  const prevParts = prevMeta?.parts ?? 0;

  for (let i = 0; i < chunks.length; i += 1) {
    await SecureStore.setItemAsync(queuePartKey(i), chunks[i]);
  }
  await SecureStore.setItemAsync(
    OFFLINE_QUEUE_META_KEY,
    JSON.stringify({ version: 2, parts: chunks.length } satisfies QueueStorageMeta)
  );

  if (prevParts > chunks.length) {
    await cleanupQueueParts(chunks.length, prevParts);
  }

  // Clean legacy key after successful v2 write.
  try {
    await SecureStore.deleteItemAsync(OFFLINE_QUEUE_KEY);
  } catch {
    // ignore legacy cleanup failures
  }
}

export async function enqueueOfflineOp<T extends QueueOpType>(
  type: T,
  payload: QueuePayloadMap[T]
): Promise<void> {
  const current = await readQueue();
  if (type === "CREATE_SUBMISSION_FOR_LOCAL_DRAFT") {
    const localId = String((payload as QueuePayloadMap["CREATE_SUBMISSION_FOR_LOCAL_DRAFT"]).localId || "");
    if (localId) {
      const alreadyQueued = current.some(
        (x) =>
          x.type === "CREATE_SUBMISSION_FOR_LOCAL_DRAFT" &&
          String((x.payload as QueuePayloadMap["CREATE_SUBMISSION_FOR_LOCAL_DRAFT"])?.localId || "") === localId
      );
      if (alreadyQueued) return;
    }
  }
  current.push({
    id: makeId(),
    type,
    payload,
    createdAt: new Date().toISOString(),
    attempts: 0,
  } as OfflineQueueItem<T>);
  await writeQueue(current);
}

export async function getOfflineQueueCount(): Promise<number> {
  const current = await readQueue();
  return current.length;
}

export async function getOfflineQueueSummary(): Promise<OfflineQueueSummary> {
  const current = await readQueue();
  if (!current.length) return { count: 0 };
  const first = current[0];
  const submissionId =
    String((first.payload as any)?.submissionId || (first.payload as any)?.localId || "").trim() || null;
  return {
    count: current.length,
    firstItemType: first.type,
    firstItemSubmissionId: submissionId,
    firstItemLastError: first.lastError ?? null,
  };
}

export async function clearOfflineQueue(): Promise<void> {
  await writeQueue([]);
}

export async function diagnoseOfflineQueue(): Promise<OfflineQueueDiagnosis> {
  const current = await readQueue();
  if (!current.length) return { count: 0 };

  const head = current[0];
  const submissionId =
    String((head.payload as any)?.submissionId || (head.payload as any)?.localId || "").trim() || null;
  const resolvedSubmissionId = submissionId
    ? await resolveServerSubmissionId(submissionId).catch(() => null)
    : null;

  let localDraftExists: boolean | null = null;
  let localDraftServerId: string | null = null;
  if (submissionId && isLocalDraftId(submissionId)) {
    const local = await getLocalDraft(submissionId).catch(() => null);
    localDraftExists = !!local;
    localDraftServerId = local?.serverId ?? null;
  }

  return {
    count: current.length,
    head: {
      type: head.type,
      submissionId,
      resolvedSubmissionId,
      attempts: head.attempts ?? 0,
      lastError: head.lastError ?? null,
      localDraftExists,
      localDraftServerId,
    },
  };
}

async function executeQueueItem(token: string, item: OfflineQueueItem): Promise<void> {
  const resolveSubmissionIdOrThrow = async (submissionId: string): Promise<string> => {
    const resolved = await resolveServerSubmissionId(submissionId);
    if (!resolved) {
      throw new Error(`Submission not yet mapped to server ID: ${submissionId}`);
    }
    return resolved;
  };

  switch (item.type) {
    case "CREATE_SUBMISSION_FOR_LOCAL_DRAFT": {
      const payload = item.payload as QueuePayloadMap["CREATE_SUBMISSION_FOR_LOCAL_DRAFT"];
      const localId = String(payload.localId || "");
      if (!isLocalDraftId(localId)) return;
      const localDraft = await getLocalDraft(localId);
      if (!localDraft) return;
      const existing = await resolveServerSubmissionId(localId);
      if (existing) return;
      const created = await apiFetch<{ submission_id: number }>("/submissions", { method: "POST", token });
      const serverId = String(created.submission_id);
      await markLocalDraftSynced(localId, serverId);
      return;
    }
    case "PATCH_SUBMISSION": {
      const payload = item.payload as QueuePayloadMap["PATCH_SUBMISSION"];
      const submissionId = await resolveSubmissionIdOrThrow(payload.submissionId);
      await patchSubmission(token, submissionId, payload.patch);
      return;
    }
    case "REPLACE_INCIDENT_TYPES": {
      const payload = item.payload as QueuePayloadMap["REPLACE_INCIDENT_TYPES"];
      const submissionId = await resolveSubmissionIdOrThrow(payload.submissionId);
      await replaceIncidentTypes(token, submissionId, payload.items);
      return;
    }
    case "REPLACE_ACTIONS": {
      const payload = item.payload as QueuePayloadMap["REPLACE_ACTIONS"];
      const submissionId = await resolveSubmissionIdOrThrow(payload.submissionId);
      await replaceActions(token, submissionId, {
        immediate: payload.immediate,
        follow_up: payload.follow_up,
      });
      return;
    }
    case "SUBMIT_SUBMISSION": {
      const payload = item.payload as QueuePayloadMap["SUBMIT_SUBMISSION"];
      const submissionId = await resolveSubmissionIdOrThrow(payload.submissionId);
      await submitSubmission(token, submissionId, payload.comment ?? undefined);
      return;
    }
    case "UPLOAD_ATTACHMENT": {
      const payload = item.payload as QueuePayloadMap["UPLOAD_ATTACHMENT"];
      const submissionId = await resolveSubmissionIdOrThrow(payload.submissionId);
      await uploadSubmissionAttachment(
        token,
        submissionId,
        payload.file,
        { sectionKey: payload.sectionKey ?? null, kind: payload.kind }
      );
      return;
    }
    default:
      return;
  }
}

let flushing = false;

export async function flushOfflineQueue(token: string): Promise<{ processed: number; remaining: number }> {
  if (flushing) return { processed: 0, remaining: await getOfflineQueueCount() };
  flushing = true;
  try {
    const queue = await readQueue();
    if (queue.length === 0) return { processed: 0, remaining: 0 };

    const survivors: OfflineQueueItem[] = [];
    let processed = 0;

    for (const item of queue) {
      try {
        await executeQueueItem(token, item);
        processed += 1;
      } catch (err: any) {
        const submissionId = String(
          (item.payload as any)?.submissionId ||
          (item.payload as any)?.localId ||
          ""
        );
        if (isLocalDraftId(submissionId)) {
          const localDraft = await getLocalDraft(submissionId).catch(() => null);
          if (!localDraft) {
            // Stale queue item for a deleted local draft; drop and continue.
            processed += 1;
            continue;
          }
          await markLocalDraftError(submissionId, String(err?.message ?? err));
        }
        survivors.push({
          ...item,
          attempts: (item.attempts ?? 0) + 1,
          lastError: String(err?.message ?? err),
        });
        // Stop at first failure to preserve ordering semantics.
        const remaining = queue.slice(queue.indexOf(item) + 1);
        survivors.push(...remaining);
        break;
      }
    }

    await writeQueue(survivors);
    return { processed, remaining: survivors.length };
  } finally {
    flushing = false;
  }
}

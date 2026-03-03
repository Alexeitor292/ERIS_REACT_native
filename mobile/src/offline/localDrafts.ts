import { deleteLargeItemAsync, getLargeItemAsync, setLargeItemAsync } from "./secureStoreLarge";

const LOCAL_DRAFT_INDEX_KEY = "offline_local_drafts_index_v1";

export type LocalDraftEditorState = {
  form: Record<string, any>;
  incidentTypes: string[];
  immediateActions: string[];
  followUpActions: string[];
  districtContacts: {
    id: string;
    first_name: string;
    last_name: string;
    s_number: string;
    phone: string;
    cell_phone: string;
  }[];
};

export type LocalDraftRecord = {
  localId: string;
  serverId: string | null;
  createdAt: string;
  updatedAt: string;
  serverUpdatedAt?: string | null;
  syncState: "LOCAL_ONLY" | "SYNCED" | "ERROR";
  lastError?: string | null;
  editor: LocalDraftEditorState;
};

type LocalDraftIndexEntry = {
  localId: string;
  serverId: string | null;
  createdAt: string;
  updatedAt: string;
  syncState: "LOCAL_ONLY" | "SYNCED" | "ERROR";
  lastError?: string | null;
};

function localDraftKey(localId: string): string {
  const safe = String(localId || "").replace(/[^a-zA-Z0-9._-]/g, "_");
  return `offline_local_draft_${safe}`;
}

function makeLocalId(): string {
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeIndexEntry(raw: any): LocalDraftIndexEntry | null {
  const localId = String(raw?.localId || "").trim();
  if (!localId) return null;
  return {
    localId,
    serverId: raw?.serverId ? String(raw.serverId) : null,
    createdAt: String(raw?.createdAt || new Date().toISOString()),
    updatedAt: String(raw?.updatedAt || new Date().toISOString()),
    syncState:
      raw?.syncState === "SYNCED" || raw?.syncState === "ERROR"
        ? raw.syncState
        : "LOCAL_ONLY",
    lastError: raw?.lastError ? String(raw.lastError) : null,
  };
}

async function readIndex(): Promise<LocalDraftIndexEntry[]> {
  try {
    const raw = await getLargeItemAsync(LOCAL_DRAFT_INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x) => normalizeIndexEntry(x))
      .filter((x): x is LocalDraftIndexEntry => !!x);
  } catch {
    return [];
  }
}

async function writeIndex(items: LocalDraftIndexEntry[]): Promise<void> {
  await setLargeItemAsync(LOCAL_DRAFT_INDEX_KEY, JSON.stringify(items));
}

async function removeIndexEntry(localId: string): Promise<void> {
  const current = await readIndex();
  const next = current.filter((x) => x.localId !== localId);
  await writeIndex(next);
}

export function isLocalDraftId(id: string): boolean {
  return String(id || "").startsWith("local_");
}

export async function listLocalDrafts(): Promise<LocalDraftIndexEntry[]> {
  const rows = await readIndex();
  if (rows.length === 0) return rows;

  const valid: LocalDraftIndexEntry[] = [];
  let changed = false;
  for (const row of rows) {
    try {
      const payload = await getLargeItemAsync(localDraftKey(row.localId));
      if (payload) valid.push(row);
      else changed = true;
    } catch {
      changed = true;
    }
  }
  if (changed) {
    await writeIndex(valid);
  }
  return valid;
}

export async function getLocalDraft(localId: string): Promise<LocalDraftRecord | null> {
  if (!isLocalDraftId(localId)) return null;
  try {
    const raw = await getLargeItemAsync(localDraftKey(localId));
    if (!raw) {
      await removeIndexEntry(localId);
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      localId: String(parsed.localId || localId),
      serverId: parsed.serverId ? String(parsed.serverId) : null,
      createdAt: String(parsed.createdAt || new Date().toISOString()),
      updatedAt: String(parsed.updatedAt || new Date().toISOString()),
      serverUpdatedAt: parsed.serverUpdatedAt ? String(parsed.serverUpdatedAt) : null,
      syncState:
        parsed.syncState === "SYNCED" || parsed.syncState === "ERROR"
          ? parsed.syncState
          : "LOCAL_ONLY",
      lastError: parsed.lastError ? String(parsed.lastError) : null,
      editor: {
        form: parsed.editor?.form && typeof parsed.editor.form === "object" ? parsed.editor.form : {},
        incidentTypes: Array.isArray(parsed.editor?.incidentTypes)
          ? parsed.editor.incidentTypes.map((x: any) => String(x))
          : [],
        immediateActions: Array.isArray(parsed.editor?.immediateActions)
          ? parsed.editor.immediateActions.map((x: any) => String(x))
          : [],
        followUpActions: Array.isArray(parsed.editor?.followUpActions)
          ? parsed.editor.followUpActions.map((x: any) => String(x))
          : [],
        districtContacts: Array.isArray(parsed.editor?.districtContacts)
          ? parsed.editor.districtContacts.map((x: any) => ({
              id: String(x?.id || `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`),
              first_name: String(x?.first_name ?? ""),
              last_name: String(x?.last_name ?? ""),
              s_number: String(x?.s_number ?? ""),
              phone: String(x?.phone ?? ""),
              cell_phone: String(x?.cell_phone ?? ""),
            }))
          : [],
      },
    };
  } catch {
    return null;
  }
}

async function upsertIndexForRecord(record: LocalDraftRecord): Promise<void> {
  const current = await readIndex();
  const nextEntry: LocalDraftIndexEntry = {
    localId: record.localId,
    serverId: record.serverId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    syncState: record.syncState,
    lastError: record.lastError ?? null,
  };
  const idx = current.findIndex((x) => x.localId === record.localId);
  if (idx >= 0) current[idx] = nextEntry;
  else current.push(nextEntry);
  await writeIndex(current.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)));
}

export async function createLocalDraft(editor: LocalDraftEditorState): Promise<LocalDraftRecord> {
  const now = new Date().toISOString();
  const record: LocalDraftRecord = {
    localId: makeLocalId(),
    serverId: null,
    createdAt: now,
    updatedAt: now,
    syncState: "LOCAL_ONLY",
    lastError: null,
    editor,
  };
  await setLargeItemAsync(localDraftKey(record.localId), JSON.stringify(record));
  await upsertIndexForRecord(record);
  return record;
}

export async function saveLocalDraft(localId: string, patch: Partial<LocalDraftRecord>): Promise<void> {
  const existing = await getLocalDraft(localId);
  if (!existing) throw new Error("Local draft not found.");
  const next: LocalDraftRecord = {
    ...existing,
    ...patch,
    localId: existing.localId,
    updatedAt: new Date().toISOString(),
  };
  await setLargeItemAsync(localDraftKey(localId), JSON.stringify(next));
  await upsertIndexForRecord(next);
}

export async function deleteLocalDraft(localId: string): Promise<void> {
  if (!isLocalDraftId(localId)) return;
  await deleteLargeItemAsync(localDraftKey(localId));
  await removeIndexEntry(localId);
}

export async function markLocalDraftSynced(localId: string, serverId: string): Promise<void> {
  const existing = await getLocalDraft(localId);
  if (!existing) return;
  await saveLocalDraft(localId, {
    serverId,
    syncState: "SYNCED",
    lastError: null,
  });
}

export async function markLocalDraftError(localId: string, message: string): Promise<void> {
  const existing = await getLocalDraft(localId);
  if (!existing) return;
  await saveLocalDraft(localId, {
    syncState: "ERROR",
    lastError: message,
  });
}

export async function resolveServerSubmissionId(inputId: string): Promise<string | null> {
  if (!isLocalDraftId(inputId)) return inputId;
  const record = await getLocalDraft(inputId);
  return record?.serverId ?? null;
}

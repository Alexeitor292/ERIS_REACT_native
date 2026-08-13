import * as FileSystem from "expo-file-system/legacy";

import { getLargeItemAsync, setLargeItemAsync } from "./secureStoreLarge";

export type LocalAttachmentUriMap = Record<number, string>;

const LOCAL_ATTACHMENT_CACHE_PREFIX = "draft_local_attachment_uris_";

function safeSubmissionId(submissionId: string | number): string {
  return String(submissionId || "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function localAttachmentUriCacheKey(submissionId: string | number): string {
  return `${LOCAL_ATTACHMENT_CACHE_PREFIX}${safeSubmissionId(submissionId)}`;
}

export function isLocalAttachmentUri(uri?: string | null): boolean {
  return !!uri && /^(file|content|ph|assets-library):/i.test(String(uri).trim());
}

export async function readLocalAttachmentUris(
  submissionId: string | number,
): Promise<LocalAttachmentUriMap> {
  try {
    const raw = await getLargeItemAsync(localAttachmentUriCacheKey(submissionId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const out: LocalAttachmentUriMap = {};
    for (const [attachmentIdRaw, uriRaw] of Object.entries(parsed)) {
      const attachmentId = Number(attachmentIdRaw);
      const uri = typeof uriRaw === "string" ? uriRaw.trim() : "";
      if (!Number.isInteger(attachmentId) || attachmentId <= 0 || !isLocalAttachmentUri(uri)) continue;
      out[attachmentId] = uri;
    }
    return out;
  } catch {
    return {};
  }
}

export async function writeLocalAttachmentUris(
  submissionId: string | number,
  value: LocalAttachmentUriMap,
): Promise<void> {
  await setLargeItemAsync(localAttachmentUriCacheKey(submissionId), JSON.stringify(value));
}

export async function registerLocalAttachmentUri(
  submissionId: string | number,
  attachmentId: number,
  uri: string,
): Promise<void> {
  if (!Number.isInteger(attachmentId) || attachmentId <= 0 || !isLocalAttachmentUri(uri)) return;
  const current = await readLocalAttachmentUris(submissionId);
  if (current[attachmentId] === uri) return;
  await writeLocalAttachmentUris(submissionId, { ...current, [attachmentId]: uri });
}

export async function resolveAvailableLocalAttachmentUri(
  submissionId: string | number,
  attachmentId: number,
): Promise<string | null> {
  const current = await readLocalAttachmentUris(submissionId);
  const uri = current[attachmentId];
  if (!isLocalAttachmentUri(uri)) return null;

  // Files staged by ERIS live under FileSystem.documentDirectory and must still
  // exist before native receives the URI. Other local schemes (content://,
  // ph://, assets-library://) are owned by the OS, so let the OS resolve them.
  if (/^file:/i.test(uri)) {
    try {
      const info = await FileSystem.getInfoAsync(uri);
      if (!info.exists) return null;
    } catch {
      return null;
    }
  }
  return uri;
}

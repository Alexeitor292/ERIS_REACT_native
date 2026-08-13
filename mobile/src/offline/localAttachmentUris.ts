import * as FileSystem from "expo-file-system/legacy";

import { getLargeItemAsync, setLargeItemAsync } from "./secureStoreLarge";

export type LocalAttachmentUriMap = Record<number, string>;

const LOCAL_ATTACHMENT_CACHE_PREFIX = "draft_local_attachment_uris_";
const STAGED_UPLOAD_DIR_NAME = "staged-uploads";

function safeSubmissionId(submissionId: string | number): string {
  return String(submissionId || "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function sanitizeFileName(name: string): string {
  const leaf = String(name || "").split(/[\\/]/).pop() || "";
  return leaf.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
}

function stagedUploadDirectoryUri(): string | null {
  const root = FileSystem.documentDirectory?.replace(/\/+$/, "");
  return root ? `${root}/${STAGED_UPLOAD_DIR_NAME}` : null;
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

async function existingFileUri(uri: string | null | undefined): Promise<string | null> {
  if (!isLocalAttachmentUri(uri)) return null;
  const normalized = String(uri).trim();
  if (!/^file:/i.test(normalized)) return normalized;
  try {
    const info = await FileSystem.getInfoAsync(normalized);
    return info.exists ? normalized : null;
  } catch {
    return null;
  }
}

async function recoverUniqueStagedFile(fileName?: string | null): Promise<string | null> {
  const sanitized = sanitizeFileName(fileName || "");
  const directory = stagedUploadDirectoryUri();
  if (!sanitized || !directory) return null;

  try {
    const info = await FileSystem.getInfoAsync(directory);
    if (!info.exists) return null;
    const entries = await FileSystem.readDirectoryAsync(directory);
    // prepareUploadFile prefixes each staged file with timestamp_random_. Only
    // recover automatically when the original filename identifies one file
    // unambiguously; two uploads named image.jpg must never be guessed between.
    const suffix = `_${sanitized}`;
    const matches = entries.filter((entry) => entry === sanitized || entry.endsWith(suffix));
    if (matches.length !== 1) return null;
    const candidate = `${directory}/${matches[0]}`;
    return await existingFileUri(candidate);
  } catch {
    return null;
  }
}

export async function resolveAvailableLocalAttachmentUri(
  submissionId: string | number,
  attachmentId: number,
  fileName?: string | null,
): Promise<string | null> {
  const current = await readLocalAttachmentUris(submissionId);
  const cached = await existingFileUri(current[attachmentId]);
  if (cached) return cached;

  // Old/offline-queued uploads may predate the attachment-id mapping. The file
  // itself is still durably staged in Documents; recover it only when filename
  // matching is unique, then persist the authoritative attachment-id mapping.
  const recovered = await recoverUniqueStagedFile(fileName);
  if (!recovered) return null;
  await registerLocalAttachmentUri(submissionId, attachmentId, recovered).catch(() => {});
  return recovered;
}

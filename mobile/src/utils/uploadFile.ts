import * as FileSystem from "expo-file-system/legacy";

export type UploadFileDescriptor = {
  uri: string;
  name: string;
  type: string;
};

const STAGED_UPLOAD_DIR_NAME = "staged-uploads";
const MISSING_FILE_MESSAGE =
  "Selected file is no longer available on this device. Please pick it again before uploading.";

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function getStagedUploadDirectoryUri(): string | null {
  if (!FileSystem.documentDirectory) return null;
  return `${trimTrailingSlashes(FileSystem.documentDirectory)}/${STAGED_UPLOAD_DIR_NAME}`;
}

function sanitizeFileName(name: string): string {
  const leafName = name.split(/[\\/]/).pop() || "upload.bin";
  const sanitized = leafName.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "upload.bin";
}

function inferExtensionFromMimeType(type: string): string {
  const mime = type.toLowerCase();
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/heic") return ".heic";
  if (mime === "image/heif") return ".heif";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/webp") return ".webp";
  if (mime === "video/mp4") return ".mp4";
  if (mime === "video/quicktime") return ".mov";
  if (mime === "application/pdf") return ".pdf";
  return "";
}

function normalizeFileName(name: string, type: string): string {
  const sanitized = sanitizeFileName(name);
  if (/\.[A-Za-z0-9]+$/.test(sanitized)) return sanitized;
  const inferredExtension = inferExtensionFromMimeType(type);
  return inferredExtension ? `${sanitized}${inferredExtension}` : sanitized;
}

function isStagedUploadUri(uri: string): boolean {
  const directoryUri = getStagedUploadDirectoryUri();
  return !!directoryUri && uri.startsWith(`${directoryUri}/`);
}

export async function prepareUploadFile(file: UploadFileDescriptor): Promise<UploadFileDescriptor> {
  const sourceUri = String(file.uri || "").trim();
  if (!sourceUri) {
    throw new Error("Selected file is missing its local path. Please pick it again.");
  }

  const normalizedType = String(file.type || "application/octet-stream");
  const fallbackName = sourceUri.split("/").pop() || "upload.bin";
  const normalizedName = normalizeFileName(file.name || fallbackName, normalizedType);

  if (isStagedUploadUri(sourceUri)) {
    const existingInfo = await FileSystem.getInfoAsync(sourceUri);
    if (existingInfo.exists) {
      return { uri: sourceUri, name: normalizedName, type: normalizedType };
    }
    throw new Error(MISSING_FILE_MESSAGE);
  }

  const sourceInfo = await FileSystem.getInfoAsync(sourceUri);
  if (!sourceInfo.exists) {
    throw new Error(MISSING_FILE_MESSAGE);
  }

  const directoryUri = getStagedUploadDirectoryUri();
  if (!directoryUri) {
    return { uri: sourceUri, name: normalizedName, type: normalizedType };
  }

  await FileSystem.makeDirectoryAsync(directoryUri, { intermediates: true });
  const stagedUri = `${directoryUri}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${normalizedName}`;
  await FileSystem.copyAsync({ from: sourceUri, to: stagedUri });

  const stagedInfo = await FileSystem.getInfoAsync(stagedUri);
  if (!stagedInfo.exists) {
    throw new Error("The app could not prepare the selected file for upload. Please try again.");
  }

  return {
    uri: stagedUri,
    name: normalizedName,
    type: normalizedType,
  };
}

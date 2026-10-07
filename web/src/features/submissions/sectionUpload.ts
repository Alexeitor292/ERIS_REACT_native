// Uploading a file to one section of a technical form: photos to /photos (their
// EXIF location and heading are read on the server), videos and documents to
// /attachments. XMLHttpRequest rather than fetch, for upload progress.

import { apiUrl } from "../../api/client";
import { getToken } from "../../auth/token";

/** The server's limit per file (MAX_UPLOAD_MB); Cloudflare refuses requests over 100 MB. */
export const MAX_UPLOAD_MB = 95;

export type UploadKind = "PHOTO" | "VIDEO" | "DOC";

export function uploadKind(file: Pick<File, "type" | "name">): UploadKind {
  const mime = (file.type || "").toLowerCase();
  if (mime.startsWith("image/")) return "PHOTO";
  if (mime.startsWith("video/") || /\.(mp4|mov|m4v|avi|webm|mkv)$/i.test(file.name)) return "VIDEO";
  return "DOC";
}

export function uploadSection(
  submissionId: number,
  sectionKey: string,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<void> {
  const kind = uploadKind(file);
  const path =
    kind === "PHOTO"
      ? `/submissions/${submissionId}/photos?section_key=${encodeURIComponent(sectionKey)}`
      : `/submissions/${submissionId}/attachments?section_key=${encodeURIComponent(sectionKey)}&kind=${kind}`;
  return new Promise((resolve, reject) => {
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      reject(new Error(`${file.name} is larger than ${MAX_UPLOAD_MB} MB. Shorten or compress it, or share a link in the notes.`));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiUrl(path));
    const token = getToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve();
        return;
      }
      let message = `Upload failed (${xhr.status})`;
      try {
        const detail = JSON.parse(xhr.responseText)?.detail;
        if (typeof detail === "string") message = detail;
      } catch {
        // keep the status message
      }
      if (xhr.status === 413) message = `${file.name} is larger than ${MAX_UPLOAD_MB} MB.`;
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error(`Could not upload ${file.name}. Check the connection and try again.`));
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
}

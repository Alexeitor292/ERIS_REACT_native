import { apiFetch } from "./client";

export async function presign(token: string, filename: string, mime_type: string, file_size_bytes: number) {
  return apiFetch<{
    bucket: string;
    object_key: string;
    upload_url: string;
    expires_seconds: number;
  }>("/attachments/presign", {
    method: "POST",
    token,
    body: { filename, mime_type, file_size_bytes },
  });
}

export async function complete(
  token: string,
  submission_id: number,
  object_key: string,
  file_name: string,
  mime_type: string,
  file_size_bytes: number
) {
  return apiFetch("/attachments/complete", {
    method: "POST",
    token,
    body: { submission_id, object_key, file_name, mime_type, file_size_bytes, sha256: null },
  });
}

export async function putToPresignedUrl(upload_url: string, fileUri: string, mimeType: string) {
  const resp = await fetch(fileUri);
  const blob = await resp.blob();

  const put = await fetch(upload_url, {
    method: "PUT",
    headers: { "Content-Type": mimeType },
    body: blob,
  });

  if (!put.ok) {
    const t = await put.text();
    throw new Error(`Upload failed ${put.status}: ${t}`);
  }
}

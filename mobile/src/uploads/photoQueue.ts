export type PendingPhoto = {
  localId: string;
  localUri: string;
  fileName: string;
  mimeType: string;
  status: "PENDING" | "UPLOADING" | "FAILED" | "DONE";
  error?: string;
  attachmentId?: number;
};

export async function uploadPhotoToBackend(params: {
  submissionId: number;
  token: string;
  fileUri: string;
  fileName: string;
  mimeType: string;
}): Promise<{ attachment_id: number; photo_id: number }> {
  const { submissionId, token, fileUri, fileName, mimeType } = params;

  const form = new FormData();
  form.append("file", {
    uri: fileUri,
    name: fileName,
    type: mimeType,
  } as any);

  // IMPORTANT: backend endpoint we’ll add: POST /submissions/{id}/photos
  const base = (await import("../api/baseUrl")).getApiBaseUrl();
  const res = await fetch(`${base}/submissions/${submissionId}/photos`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      // DO NOT set Content-Type manually for FormData in RN
    },
    body: form,
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Upload failed ${res.status}: ${t}`);
  }

  return await res.json();
}

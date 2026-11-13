import { mockDatabase } from "./mockDatabase";
export const MAX_UPLOAD_MB = 95;
export type UploadKind = "PHOTO" | "VIDEO" | "DOC";
export function uploadKind(file: Pick<File, "type" | "name">): UploadKind { return file.type.startsWith("image/") ? "PHOTO" : file.type.startsWith("video/") ? "VIDEO" : "DOC"; }
export async function uploadSection(id: number, section: string, file: File, onProgress: (fraction: number) => void): Promise<number | null> {
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) throw new Error("Choose a sample file smaller than 95 MB.");
  const form = new FormData(); form.append("file", file);
  const response = await mockDatabase.request(`/submissions/${id}/${uploadKind(file) === "PHOTO" ? "photos" : "attachments"}?section_key=${encodeURIComponent(section)}`, { method: "POST", body: form }) as { attachment_id: number };
  onProgress(1); return response.attachment_id;
}

import type { Attachment } from "../../api/types";

const WORKFLOW_EVENT_LABELS: Record<string, string> = {
  CREATE: "Submission created",
  SUBMIT: "Submitted for review",
  RESUBMIT: "Resubmitted for review",
  APPROVE: "Approved",
  REJECT: "Returned for correction",
  COORDINATOR_NOTIFIED: "Coordinator notified",
};

export function humanizeCode(value: string) {
  return value
    .trim()
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function workflowEventLabel(eventType: string) {
  const code = eventType.trim().toUpperCase();
  return WORKFLOW_EVENT_LABELS[code] ?? humanizeCode(code);
}

export function formatWorkflowTimestamp(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return String(bytes);
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb).toLocaleString()} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : mb.toFixed(0)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

export function attachmentTypeLabel(attachment: Attachment) {
  const kind = String(attachment.kind || "").trim().toUpperCase();
  const mime = String(attachment.mime_type || "").trim().toLowerCase();

  if (kind === "PHOTO" || mime.startsWith("image/")) return "Photo";
  if (mime === "application/pdf") return "PDF";
  if (kind === "DOC") return "Document";
  if (mime.startsWith("video/")) return "Video";
  if (mime.startsWith("audio/")) return "Audio";
  return kind ? humanizeCode(kind) : (attachment.mime_type || "File");
}

export function attachmentActionLabel(attachment: Attachment) {
  const type = attachmentTypeLabel(attachment);
  if (type === "Photo") return "Open photo";
  if (type === "PDF") return "Open PDF";
  return "Open file";
}

export function workflowTransitionLabel(event: {
  from_status: string | null;
  to_status: string | null;
}) {
  if (!event.from_status && !event.to_status) return null;
  if (!event.from_status && event.to_status) return `Status set to ${humanizeCode(event.to_status)}`;
  if (event.from_status && !event.to_status) return `Previous status: ${humanizeCode(event.from_status)}`;
  if (event.from_status === event.to_status) return `Status remained ${humanizeCode(event.to_status ?? "")}`;
  return `${humanizeCode(event.from_status ?? "")} → ${humanizeCode(event.to_status ?? "")}`;
}

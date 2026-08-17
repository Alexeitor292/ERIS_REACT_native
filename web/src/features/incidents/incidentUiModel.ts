import type { IncidentStatus } from "../../api/types";

export type IncidentCreateForm = {
  title: string;
  incident_type: string;
  description: string;
  first_observed_at: string;
  first_occurred_at: string;
  latitude: string;
  longitude: string;
  district: string;
  county: string;
  route: string;
  post_mile: string;
};

export const EMPTY_INCIDENT_FORM: IncidentCreateForm = {
  title: "",
  incident_type: "",
  description: "",
  first_observed_at: "",
  first_occurred_at: "",
  latitude: "",
  longitude: "",
  district: "",
  county: "",
  route: "",
  post_mile: "",
};

export type IncidentAttachmentKind = "PHOTO" | "VIDEO" | "DOC" | "SKETCH";

export type PendingIncidentUpload = {
  file: File;
  kind: IncidentAttachmentKind;
};

export function inferIncidentAttachmentKind(name: string, mimeType: string): IncidentAttachmentKind {
  const mime = (mimeType || "").toLowerCase();
  if (mime === "image/png" && /sketch/i.test(name)) return "SKETCH";
  if (mime.startsWith("image/")) return "PHOTO";
  if (mime.startsWith("video/")) return "VIDEO";
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "png" && /sketch/i.test(name)) return "SKETCH";
  if (["jpg", "jpeg", "png", "heic", "heif", "gif", "webp"].includes(ext)) return "PHOTO";
  if (["mp4", "mov", "m4v", "avi", "mkv", "webm"].includes(ext)) return "VIDEO";
  return "DOC";
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function incidentStatusLabel(status: IncidentStatus) {
  if (status === "IN_PROGRESS") return "In progress";
  if (status === "RESOLVED") return "Resolved";
  return "New";
}

export function incidentStatusBadgeClass(status: IncidentStatus) {
  if (status === "NEW") {
    return "border-[color:color-mix(in_oklab,var(--bad)_48%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_14%,transparent)] text-[var(--bad)]";
  }
  if (status === "IN_PROGRESS") {
    return "border-[color:color-mix(in_oklab,var(--brand)_48%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_12%,transparent)] text-[var(--brand)]";
  }
  return "border-[color:color-mix(in_oklab,var(--good)_48%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_12%,transparent)] text-[var(--good)]";
}

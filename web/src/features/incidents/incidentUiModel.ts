import type { IncidentStatus } from "../../api/types";
import type { ResolvedIncidentLocation } from "./incidentLocationModel";

/**
 * A report being written on the web. The location is one resolved value —
 * coordinates and District / County / Route / Post mile together, as Caltrans
 * gave them — never six loose fields that can disagree with each other.
 */
export type IncidentCreateForm = {
  title: string;
  description: string;
  first_observed_at: string;
  first_occurred_at: string;
  location: ResolvedIncidentLocation | null;
};

export const EMPTY_INCIDENT_FORM: IncidentCreateForm = {
  title: "",
  description: "",
  first_observed_at: "",
  first_occurred_at: "",
  location: null,
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

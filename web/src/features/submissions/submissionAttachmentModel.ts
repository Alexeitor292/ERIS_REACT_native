import type { Attachment } from "../../api/types";
import type { DashboardCardId } from "./submissionLayoutModel";

export type AttachmentMediaKind = "photo" | "video" | "document";
export type LibraryFilter = "ALL" | "PHOTOS" | "VIDEOS" | "DOCUMENTS";

export type SubmissionLibraryItem = {
  attachment: Attachment;
  media: AttachmentMediaKind;
  sectionKey: string | null;
  sectionLabel: string;
};

/**
 * Section identifiers used by the mobile GISA form when it tags an attachment
 * (`attachment_links.section_key`). The web form cards use slightly different ids,
 * so the mapping below is the single place that translates between the two.
 */
export const SECTION_KEY_LABELS: Record<string, string> = {
  submission: "Submission",
  distribution: "Distribution",
  highway_status: "Highway Status",
  incident_type: "Incident Type",
  material: "Material",
  pavement_ground_status: "Pavement / Ground Status",
  vegetation_slope: "Vegetation on Slope",
  vegetation_on_slope: "Vegetation on Slope",
  water_drainage: "Water / Drainage",
  water_content: "Water Content",
  measurements: "Measurements",
  record_of_event: "Record of Event",
  maintenance_history: "Maintenance History",
  observation: "Observation",
  geotechnical_assessment: "Geotechnical Assessment",
  recommendations: "Recommendations",
  sketchpad: "Sketchpad",
};

export const CARD_SECTION_KEYS: Partial<Record<DashboardCardId, readonly string[]>> = {
  distribution: ["distribution"],
  highway_status: ["highway_status"],
  incident_type: ["incident_type"],
  material: ["material"],
  pavement_ground_status: ["pavement_ground_status"],
  vegetation_on_slope: ["vegetation_slope", "vegetation_on_slope"],
  water_drainage: ["water_drainage"],
  water_content: ["water_content"],
  measurements: ["measurements"],
};

export const NOTES_SECTION_KEYS = {
  observations_notes: ["observation", "observations"],
  record_of_event_notes: ["record_of_event"],
  maintenance_history_notes: ["maintenance_history"],
  geotechnical_assessment_notes: ["geotechnical_assessment"],
  recommendations_notes: ["recommendations"],
  sketchpad_notes: ["sketchpad"],
} as const satisfies Record<string, readonly string[]>;

export function humanizeSectionKey(value: string) {
  return value
    .trim()
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function normalizeSectionKey(value: string | null | undefined): string | null {
  const key = String(value ?? "").trim().toLowerCase();
  return key ? key : null;
}

export function sectionLabel(sectionKey: string | null | undefined) {
  const key = normalizeSectionKey(sectionKey);
  if (!key) return "Submission";
  return SECTION_KEY_LABELS[key] ?? humanizeSectionKey(key);
}

/** Classify by MIME prefix; `kind` is only a fallback when the MIME type is missing. */
export function attachmentMediaKind(attachment: Pick<Attachment, "mime_type" | "kind">): AttachmentMediaKind {
  const mime = String(attachment.mime_type || "").trim().toLowerCase();
  if (mime.startsWith("image/")) return "photo";
  if (mime.startsWith("video/")) return "video";
  if (!mime) {
    const kind = String(attachment.kind || "").trim().toUpperCase();
    if (kind === "PHOTO" || kind === "SKETCH") return "photo";
    if (kind === "VIDEO") return "video";
  }
  return "document";
}

export function isPdfAttachment(attachment: Pick<Attachment, "mime_type" | "file_name">) {
  const mime = String(attachment.mime_type || "").trim().toLowerCase();
  if (mime === "application/pdf") return true;
  return /\.pdf$/i.test(String(attachment.file_name || ""));
}

export function buildLibraryItems(attachments: Attachment[]): SubmissionLibraryItem[] {
  return attachments.map((attachment) => {
    const sectionKey = normalizeSectionKey(attachment.section_key);
    return {
      attachment,
      media: attachmentMediaKind(attachment),
      sectionKey,
      sectionLabel: sectionLabel(sectionKey),
    };
  });
}

export function filterLibraryItems(items: SubmissionLibraryItem[], filter: LibraryFilter) {
  if (filter === "ALL") return items;
  const media: AttachmentMediaKind = filter === "PHOTOS" ? "photo" : filter === "VIDEOS" ? "video" : "document";
  return items.filter((item) => item.media === media);
}

export function libraryCounts(items: SubmissionLibraryItem[]) {
  const counts = { all: items.length, photos: 0, videos: 0, documents: 0 };
  for (const item of items) {
    if (item.media === "photo") counts.photos += 1;
    else if (item.media === "video") counts.videos += 1;
    else counts.documents += 1;
  }
  return counts;
}

export function itemsForSectionKeys(items: SubmissionLibraryItem[], keys: readonly string[]) {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  return items.filter((item) => item.sectionKey != null && wanted.has(item.sectionKey));
}

export function libraryCountLabel(counts: ReturnType<typeof libraryCounts>) {
  const parts: string[] = [];
  if (counts.photos) parts.push(`${counts.photos} photo${counts.photos === 1 ? "" : "s"}`);
  if (counts.videos) parts.push(`${counts.videos} video${counts.videos === 1 ? "" : "s"}`);
  if (counts.documents) parts.push(`${counts.documents} document${counts.documents === 1 ? "" : "s"}`);
  if (parts.length === 0) return "No files";
  return `${counts.all} item${counts.all === 1 ? "" : "s"} · ${parts.join(" · ")}`;
}

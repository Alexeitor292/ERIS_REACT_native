/**
 * What a maintenance coordinator needs in front of them to judge a field report
 * before any Event Group question is asked.
 *
 * Dependency-free on purpose: `node --test` runs this file directly under
 * `--experimental-strip-types`, so nothing here may import a component, an API
 * client or anything with an extension-less runtime import.
 */

export type ReviewAttachment = {
  attachment_id: number;
  kind: string;
  file_name: string;
  mime_type: string;
  file_size_bytes: number | null;
  captured_at: string | null;
  latitude: number | null;
  longitude: number | null;
  horizontal_accuracy_m: number | null;
  camera_heading_deg: number | null;
  download_url: string;
};

export type ReviewIncident = {
  id: number;
  title: string | null;
  incident_type: string | null;
  description: string | null;
  latitude: number;
  longitude: number;
  district: string | null;
  county: string | null;
  route: string | null;
  post_mile: string | null;
  first_observed_at: string;
  first_occurred_at: string | null;
  created_at: string;
  reporter_user_id: number;
  reporter_name?: string | null;
  reporter_email?: string | null;
  road_inventory_context?: { snapshot: Record<string, unknown> | null; match_method: string | null } | null;
};

/** Files that can be shown inline as an image; everything else gets a file row. */
export function isViewableImage(attachment: Pick<ReviewAttachment, "kind" | "mime_type">): boolean {
  return attachment.kind === "PHOTO" || attachment.kind === "SKETCH" || attachment.mime_type.startsWith("image/");
}

export type EvidenceSummary = {
  total: number;
  photos: number;
  videos: number;
  documents: number;
  /** Photos carrying a device-recorded position. */
  located: number;
};

export function summarizeEvidence(attachments: ReviewAttachment[]): EvidenceSummary {
  const summary: EvidenceSummary = { total: attachments.length, photos: 0, videos: 0, documents: 0, located: 0 };
  for (const attachment of attachments) {
    if (isViewableImage(attachment)) summary.photos += 1;
    else if (attachment.kind === "VIDEO" || attachment.mime_type.startsWith("video/")) summary.videos += 1;
    else summary.documents += 1;
    if (attachment.latitude !== null && attachment.longitude !== null) summary.located += 1;
  }
  return summary;
}

export function formatFileSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * How far the photo was taken from the reported pin, in metres. A photo shot a
 * kilometre away is the clearest signal that a report's location is wrong, and
 * it is the coordinator's job to catch that before the report is accepted.
 */
export function metresBetween(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const earthRadiusM = 6_371_008.8;
  const toRad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * toRad;
  const dLon = (b.longitude - a.longitude) * toRad;
  const lat1 = a.latitude * toRad;
  const lat2 = b.latitude * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function distanceLabel(metres: number): string {
  if (!Number.isFinite(metres)) return "";
  if (metres < 1000) return `${Math.round(metres)} m from the reported pin`;
  return `${(metres / 1609.344).toFixed(1)} mi from the reported pin`;
}

/** Metres beyond which a photo's own position is worth flagging to the coordinator. */
export const PHOTO_DISTANCE_WARNING_M = 500;

export type ReadinessCheck = {
  key: string;
  label: string;
  /** "ok" — nothing to look at. "attention" — a fact the coordinator should weigh. */
  status: "ok" | "attention";
  detail: string;
};

/**
 * The facts a coordinator would otherwise have to hunt for, stated plainly.
 *
 * Deliberately NOT a score and never a recommendation: nothing here decides
 * anything, blocks anything, or preselects a disposition. Every check names a
 * fact and leaves the judgement to the person.
 */
export function readinessChecks(incident: ReviewIncident, attachments: ReviewAttachment[]): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  const summary = summarizeEvidence(attachments);

  checks.push(
    summary.total === 0
      ? { key: "evidence", label: "Evidence", status: "attention", detail: "No photos or files were attached to this report." }
      : {
          key: "evidence",
          label: "Evidence",
          status: "ok",
          detail: [
            summary.photos ? `${summary.photos} photo${summary.photos === 1 ? "" : "s"}` : null,
            summary.videos ? `${summary.videos} video${summary.videos === 1 ? "" : "s"}` : null,
            summary.documents ? `${summary.documents} file${summary.documents === 1 ? "" : "s"}` : null,
          ].filter(Boolean).join(" · "),
        },
  );

  const described = (incident.description ?? "").trim();
  checks.push(
    described.length >= 20
      ? { key: "description", label: "Description", status: "ok", detail: "The reporter described what they saw." }
      : {
          key: "description",
          label: "Description",
          status: "attention",
          detail: described ? "The description is one line — it may not be enough to judge." : "The report carries no description.",
        },
  );

  const locationParts = [incident.district, incident.county, incident.route, incident.post_mile];
  const missingLocation = locationParts.some((part) => !String(part ?? "").trim());
  checks.push(
    missingLocation
      ? { key: "location", label: "Location", status: "attention", detail: "District, county, route and post mile are not all filled in." }
      : { key: "location", label: "Location", status: "ok", detail: "District, county, route and post mile are all recorded." },
  );

  const farPhotos = attachments.filter((attachment) => {
    if (attachment.latitude === null || attachment.longitude === null) return false;
    return metresBetween(incident, { latitude: attachment.latitude, longitude: attachment.longitude }) > PHOTO_DISTANCE_WARNING_M;
  });
  if (summary.located > 0) {
    checks.push(
      farPhotos.length
        ? {
            key: "photo-distance",
            label: "Photo positions",
            status: "attention",
            detail: `${farPhotos.length} of ${summary.located} located photo${summary.located === 1 ? "" : "s"} ${farPhotos.length === 1 ? "was" : "were"} taken more than 500 m from the reported pin.`,
          }
        : {
            key: "photo-distance",
            label: "Photo positions",
            status: "ok",
            detail: `${summary.located} located photo${summary.located === 1 ? "" : "s"} within 500 m of the reported pin.`,
          },
    );
  }

  const roadSnapshot = incident.road_inventory_context?.snapshot ?? null;
  checks.push(
    roadSnapshot
      ? { key: "road", label: "Road inventory", status: "ok", detail: "The report matched a Road Inventory segment." }
      : { key: "road", label: "Road inventory", status: "attention", detail: "No Road Inventory segment was matched for this location." },
  );

  return checks;
}

/** Road inventory fields worth a coordinator's glance, in the order they read best. */
export const ROAD_SUMMARY_KEYS = [
  "route_name",
  "begin_pm",
  "end_pm",
  "left_lanes",
  "right_lanes",
  "median_type",
  "terrain_code",
  "THY_TERRAIN_CODE",
  "design_speed",
  "adt",
  "landmark_short_desc",
] as const;

export function roadSummaryEntries(snapshot: Record<string, unknown> | null | undefined): Array<{ key: string; value: unknown }> {
  if (!snapshot) return [];
  const seenLabels = new Set<string>();
  const entries: Array<{ key: string; value: unknown }> = [];
  for (const key of ROAD_SUMMARY_KEYS) {
    const value = snapshot[key];
    if (value === null || value === undefined || value === "") continue;
    // terrain_code and THY_TERRAIN_CODE are the same fact under two names.
    const label = key === "THY_TERRAIN_CODE" ? "terrain_code" : key;
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);
    entries.push({ key, value });
  }
  return entries;
}

/** "Observed 2 Sep, filed 3 Sep" — the gap matters when a report arrives late. */
export function reportingDelayHours(incident: Pick<ReviewIncident, "first_observed_at" | "created_at">): number | null {
  const observed = Date.parse(incident.first_observed_at);
  const filed = Date.parse(incident.created_at);
  if (!Number.isFinite(observed) || !Number.isFinite(filed)) return null;
  return Math.max(0, (filed - observed) / 3_600_000);
}

/**
 * Hours below which the gap between seeing a problem and filing it is ordinary
 * field behaviour and not worth a coordinator's attention.
 */
export const REPORTING_DELAY_FLOOR_H = 12;

export function reportingDelayLabel(hours: number | null): string | null {
  if (hours === null || hours < REPORTING_DELAY_FLOOR_H) return null;
  if (hours < 48) return `Filed ${Math.round(hours)} h after it was first seen`;
  return `Filed ${Math.round(hours / 24)} days after it was first seen`;
}

import type { IncidentClassification } from "../incidents/incidentClassification";
import type { ProjectIncidentSummary, ProjectSummary } from "../projects/projectTypes";
import type { PhotoEvidence, PhotoEvidenceSummary } from "../submissions/photoEvidenceApi";

export type MissionCenterProjectPage = {
  items: ProjectSummary[];
  next_cursor: number | null;
  has_more: boolean;
};

export type MissionCenterIncident = ProjectIncidentSummary & {
  description: string | null;
  first_occurred_at: string | null;
  linked_submission_id: number | null;
};

export type MissionCenterIncidentGis = {
  incident: MissionCenterIncident;
  project: ProjectSummary | null;
  geometry: Record<string, unknown> | null;
  geometry_srid: number;
  geometry_source: string | null;
  photo_summary: PhotoEvidenceSummary;
  photos: PhotoEvidence[];
};

export type MissionCenterMode = "PROJECTS" | "PROJECT" | "INCIDENT";

const EARTH_RADIUS_M = 6_371_008.8;

export function cameraDirectionEndpoint(
  latitude: number,
  longitude: number,
  headingDeg: number,
  distanceM = 60,
): { latitude: number; longitude: number } {
  const heading = ((headingDeg % 360) + 360) % 360;
  const angularDistance = Math.max(0, distanceM) / EARTH_RADIUS_M;
  const bearing = heading * Math.PI / 180;
  const lat1 = latitude * Math.PI / 180;
  const lon1 = longitude * Math.PI / 180;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance)
    + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
    Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
  );

  return {
    latitude: lat2 * 180 / Math.PI,
    longitude: ((lon2 * 180 / Math.PI + 540) % 360) - 180,
  };
}

export function mappedPhotos(photos: PhotoEvidence[]): PhotoEvidence[] {
  return photos.filter((photo) => photo.latitude != null && photo.longitude != null);
}

export function headedPhotos(photos: PhotoEvidence[]): PhotoEvidence[] {
  return mappedPhotos(photos).filter((photo) => photo.camera_heading_deg != null);
}

export function projectSearchMatch(project: ProjectSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    project.id,
    project.title,
    project.description,
    project.district,
    project.county,
    project.route,
    project.post_mile,
  ].filter((value) => value != null).join(" ").toLowerCase();
  return haystack.includes(needle);
}

export function classificationForIncident(
  classifications: Record<number, IncidentClassification>,
  incidentId: number,
): IncidentClassification | undefined {
  return classifications[incidentId];
}

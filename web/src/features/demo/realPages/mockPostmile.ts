import type { ResolvedIncidentLocation, RoadQuery } from "../../incidents/incidentLocationModel";
export class CaltransUnavailableError extends Error {}
export async function resolveCoordinates(latitude: number, longitude: number): Promise<ResolvedIncidentLocation> {
  return { latitude, longitude, district: "04", county: "SON", route: "116", post_mile: "12.4", method: "ONLINE_COORDINATE_LOOKUP" };
}
export async function resolveRoad(_query: RoadQuery): Promise<ResolvedIncidentLocation> { return resolveCoordinates(38.4501, -122.9001); }

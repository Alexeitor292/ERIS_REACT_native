import { appConfig } from "../../config";
import { countyCodeFromNameOrCode } from "../../utils/caltransLookups";
import {
  coordinateQueryParams,
  coordinatesFromRoadFeatures,
  roadFromCoordinateFeatures,
  roadQueryParams,
  type PostmileFeature,
  type ResolvedIncidentLocation,
  type RoadQuery,
} from "./incidentLocationModel";

/**
 * The two Caltrans postmile lookups, run from the browser straight against the
 * public layer — the network half of the mobile app's online lookup. The rules
 * that pick the answer are in incidentLocationModel.ts.
 *
 * Both return null when Caltrans has no answer; they throw only when Caltrans
 * could not be reached, so the form can tell "not on a state highway" apart
 * from "try again".
 */

export class CaltransUnavailableError extends Error {
  constructor() {
    super("The Caltrans post mile service could not be reached. Check the connection and try again.");
  }
}

async function queryLayer(params: Record<string, string>): Promise<PostmileFeature[]> {
  const controller = new AbortController();
  // The phone waits 6.5 s; a desktop on a state network can afford a little more.
  const timer = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const url = `${appConfig.caltransPostmileLayerUrl.replace(/\/$/, "")}/query?${new URLSearchParams(params).toString()}`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new CaltransUnavailableError();
    const payload = await response.json();
    if (payload?.error) throw new CaltransUnavailableError();
    return Array.isArray(payload?.features) ? payload.features : [];
  } catch (error) {
    if (error instanceof CaltransUnavailableError) throw error;
    throw new CaltransUnavailableError();
  } finally {
    window.clearTimeout(timer);
  }
}

/** County as its three-letter code, the way the phone stores it. */
function withCountyCode(location: ResolvedIncidentLocation | null): ResolvedIncidentLocation | null {
  if (!location) return null;
  return { ...location, county: countyCodeFromNameOrCode(location.county) ?? location.county.toUpperCase() };
}

/** A point → its District / County / Route / Post mile. */
export async function resolveCoordinates(latitude: number, longitude: number): Promise<ResolvedIncidentLocation | null> {
  const features = await queryLayer(coordinateQueryParams(latitude, longitude));
  return withCountyCode(roadFromCoordinateFeatures(features, latitude, longitude));
}

/** District / County / Route / Post mile → its point. */
export async function resolveRoad(query: RoadQuery): Promise<ResolvedIncidentLocation | null> {
  const params = roadQueryParams(query);
  if (!params) return null;
  const features = await queryLayer(params);
  return withCountyCode(coordinatesFromRoadFeatures(features, query.postmile));
}

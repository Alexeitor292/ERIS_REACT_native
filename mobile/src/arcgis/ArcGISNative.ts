import { NativeModules } from "react-native";
import {
  applyQueuedPhotoCorrectionsToPayload,
  enqueuePhotoCorrectionsForSync,
  type PhotoCorrectionState,
} from "../offline/fieldPhotoMetadata";
import { resolveAvailableLocalAttachmentUri } from "../offline/localAttachmentUris";
import { triggerOfflineSyncNow } from "../offline/syncLoop";

type ArcGisNativeModule = {
  loadMmpk(path: string): Promise<void>;
  downloadMmpk(url: string): Promise<string>;
  setApiKey(apiKey: string): Promise<void>;
  setLicenseKey(licenseKey: string): Promise<void>;
  setMissionIncidents(incidentsJson: string): Promise<void>;
  setInitialLocation(latitude: number, longitude: number): Promise<void>;
  setInitialGeometry(esriJson: string): Promise<void>;
  startSketchPolygon(): Promise<void>;
  startMissionCenterMap(): Promise<void>;
  openSitePhotoMap(paramsJson: string): Promise<string>;
  startPencilSketch(): Promise<void>;
  getSketchGeoJson(): Promise<string>;
  getSketchImagePath(): Promise<string>;
  clearSketch(): Promise<void>;
  openOfflineTerrainScene(paramsJson: string): Promise<void>;
  sha256OfFile(path: string): Promise<string>;
  validateScenePackage(path: string): Promise<boolean>;
};

export type OpenOfflineSceneParams = {
  packagePath: string;
  packageFormat?: string;
  extractedDir?: string | null;
  incident: { lat: number; lon: number };
  incidentLabel?: string | null;
  geometry?: unknown | null;
  roadBearingDeg?: number | null;
  sampleExtent?: { minLat: number; minLon: number; maxLat: number; maxLon: number } | null;
  packageVersion?: string | null;
  downloadedAt?: string | null;
  sizeBytes?: number | null;
};

const { ArcGis } = NativeModules as { ArcGis: ArcGisNativeModule };
type ArcGisMethodName = keyof ArcGisNativeModule;

export function isArcGisNativeAvailable(): boolean { return !!ArcGis; }

function requireArcGisModule(): ArcGisNativeModule {
  if (!ArcGis) throw new Error("ArcGis native module not found. Did you run expo prebuild and rebuild the app?");
  return ArcGis;
}

function hasMethod(name: ArcGisMethodName): boolean {
  const mod = ArcGis as unknown as Record<string, unknown> | undefined;
  return !!mod && typeof mod[name] === "function";
}

export function supportsMissionCenterMap(): boolean {
  return hasMethod("setMissionIncidents") && hasMethod("startMissionCenterMap");
}

export function supportsSitePhotoMap(): boolean { return hasMethod("openSitePhotoMap"); }

async function preferLocalSitePhotoFiles(payload: any): Promise<any> {
  const submissionId = Number(payload?.submission_id);
  if (!Number.isInteger(submissionId) || submissionId <= 0 || !Array.isArray(payload?.photos)) return payload;
  const photos = await Promise.all(payload.photos.map(async (photo: any) => {
    const attachmentId = Number(photo?.attachment_id);
    if (!Number.isInteger(attachmentId) || attachmentId <= 0) return photo;
    const localUri = await resolveAvailableLocalAttachmentUri(
      submissionId,
      attachmentId,
      typeof photo?.file_name === "string" ? photo.file_name : null,
    );
    if (!localUri) return photo;
    return { ...photo, download_url: localUri, local_uri: localUri };
  }));
  return { ...payload, photos };
}

export async function openSitePhotoMap(payload: any): Promise<void> {
  if (!hasMethod("openSitePhotoMap")) throw new Error("Native Site Photo Map is missing in this app build. Rebuild the EAS development client.");
  const correctedPayload = await applyQueuedPhotoCorrectionsToPayload(payload);
  const preparedPayload = await preferLocalSitePhotoFiles(correctedPayload);
  const resultJson = await requireArcGisModule().openSitePhotoMap(JSON.stringify(preparedPayload));
  if (typeof resultJson !== "string" || resultJson.trim().length === 0) return;

  let parsed: any;
  try { parsed = JSON.parse(resultJson); }
  catch { throw new Error("Site Photo Map returned invalid correction data."); }

  const submissionId = Number(preparedPayload?.submission_id);
  const rawCorrections = Array.isArray(parsed?.corrections) ? parsed.corrections : [];
  const corrections: PhotoCorrectionState[] = rawCorrections
    .map((item: any) => ({
      attachment_id: Number(item?.attachment_id),
      location_override: item?.location_override == null ? null : {
        latitude: Number(item.location_override.latitude),
        longitude: Number(item.location_override.longitude),
      },
      heading_override_deg: item?.heading_override_deg == null ? null : Number(item.heading_override_deg),
    }))
    .filter((item: PhotoCorrectionState) => Number.isInteger(item.attachment_id) && item.attachment_id > 0);

  if (Number.isInteger(submissionId) && submissionId > 0 && corrections.length > 0) {
    const queued = await enqueuePhotoCorrectionsForSync(submissionId, corrections);
    if (queued > 0) triggerOfflineSyncNow().catch(() => {});
  }
}

export function supportsOfflineTerrainScene(): boolean { return hasMethod("openOfflineTerrainScene"); }
export function supportsScenePackageIntegrity(): boolean { return hasMethod("sha256OfFile") && hasMethod("validateScenePackage"); }

export async function sha256OfFile(path: string): Promise<string> {
  if (!hasMethod("sha256OfFile")) throw new Error("Native SHA-256 missing in this app build. Rebuild the app (EAS dev build).");
  return requireArcGisModule().sha256OfFile(path);
}

export async function validateScenePackage(path: string): Promise<boolean> {
  if (!hasMethod("validateScenePackage")) throw new Error("Native scene-package validation missing in this app build. Rebuild the app (EAS dev build).");
  return requireArcGisModule().validateScenePackage(path);
}

export async function openOfflineTerrainScene(params: OpenOfflineSceneParams): Promise<void> {
  if (!hasMethod("openOfflineTerrainScene")) throw new Error("Native 3D terrain viewer missing in this app build. Rebuild the EAS development client to include the latest native ArcGIS module.");
  return requireArcGisModule().openOfflineTerrainScene(JSON.stringify(params));
}

export async function loadMmpk(path: string) { return requireArcGisModule().loadMmpk(path); }
export async function downloadMmpk(url: string): Promise<string> { return requireArcGisModule().downloadMmpk(url); }
export async function setApiKey(apiKey: string) { return requireArcGisModule().setApiKey(apiKey); }
export async function setLicenseKey(licenseKey: string) { return requireArcGisModule().setLicenseKey(licenseKey); }

export async function setMissionIncidents(incidentsJson: string) {
  if (!hasMethod("setMissionIncidents")) throw new Error("ArcGIS Mission Center method missing in this app build. Rebuild the app to include latest ArcGIS module.");
  return requireArcGisModule().setMissionIncidents(incidentsJson);
}

export async function setInitialLocation(latitude: number, longitude: number) { return requireArcGisModule().setInitialLocation(latitude, longitude); }
export async function setInitialGeometry(esriJson: string) { return requireArcGisModule().setInitialGeometry(esriJson); }
export async function startSketchPolygon() { return requireArcGisModule().startSketchPolygon(); }

export async function startMissionCenterMap() {
  if (!hasMethod("startMissionCenterMap")) throw new Error("ArcGIS Mission Center launcher missing in this app build. Rebuild the app to include latest ArcGIS module.");
  return requireArcGisModule().startMissionCenterMap();
}

export async function startPencilSketch() {
  if (!hasMethod("startPencilSketch")) throw new Error("Pencil sketch launcher missing in this app build. Rebuild the app to include the latest native module.");
  return requireArcGisModule().startPencilSketch();
}

export async function getSketchGeometry(): Promise<any> {
  const s = await requireArcGisModule().getSketchGeoJson();
  return normalizeGeometryJson(JSON.parse(s));
}

export async function getSketchImagePath(): Promise<string> {
  if (!hasMethod("getSketchImagePath")) throw new Error("Sketch image export missing in this app build. Rebuild the app to include the latest native module.");
  return requireArcGisModule().getSketchImagePath();
}

export async function clearSketch() { return requireArcGisModule().clearSketch(); }

function webMercatorToWgs84XY(x: number, y: number): [number, number] {
  const lon = (x / 20037508.34) * 180;
  let lat = (y / 20037508.34) * 180;
  lat = (180 / Math.PI) * (2 * Math.atan(Math.exp((lat * Math.PI) / 180)) - Math.PI / 2);
  return [lon, lat];
}

function looksLikeWebMercatorCoord(coord: any): boolean {
  if (!Array.isArray(coord) || coord.length < 2) return false;
  const x = Number(coord[0]);
  const y = Number(coord[1]);
  if (Number.isNaN(x) || Number.isNaN(y)) return false;
  return Math.abs(x) > 180 || Math.abs(y) > 90;
}

function mapCoords(value: any, mapper: (coord: [number, number]) => [number, number]): any {
  if (!Array.isArray(value)) return value;
  if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    const [x, y] = mapper([Number(value[0]), Number(value[1])]);
    const out = [...value]; out[0] = x; out[1] = y; return out;
  }
  return value.map((v) => mapCoords(v, mapper));
}

function normalizeGeometryJson(raw: any): any {
  if (!raw || typeof raw !== "object") return raw;
  if (typeof raw.type === "string" && raw.coordinates) {
    if (looksLikeWebMercatorCoord(raw.coordinates)) return { ...raw, coordinates: mapCoords(raw.coordinates, ([x, y]) => webMercatorToWgs84XY(x, y)) };
    return raw;
  }
  const wkid = Number(raw?.spatialReference?.wkid ?? 0);
  const isWebMercator = wkid === 3857 || wkid === 102100;
  const convert = (coords: any) => isWebMercator || looksLikeWebMercatorCoord(coords)
    ? mapCoords(coords, ([x, y]) => webMercatorToWgs84XY(x, y)) : coords;
  if (typeof raw.x === "number" && typeof raw.y === "number") return { type: "Point", coordinates: convert([raw.x, raw.y]) };
  if (Array.isArray(raw.points)) return { type: "MultiPoint", coordinates: convert(raw.points) };
  if (Array.isArray(raw.paths)) {
    if (raw.paths.length === 1) return { type: "LineString", coordinates: convert(raw.paths[0]) };
    return { type: "MultiLineString", coordinates: convert(raw.paths) };
  }
  if (Array.isArray(raw.rings)) return { type: "Polygon", coordinates: convert(raw.rings) };
  return raw;
}

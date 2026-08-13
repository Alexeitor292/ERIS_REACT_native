import * as Location from "expo-location";

export type PhotoCaptureMetadata = {
  captured_at?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  horizontal_accuracy_m?: number | null;
  altitude_m?: number | null;
  camera_heading_deg?: number | null;
  camera_heading_accuracy_code?: number | null;
  heading_reference?: "TRUE_NORTH" | "MAGNETIC_NORTH" | "UNKNOWN" | null;
  location_source?: "DEVICE_AT_CAPTURE" | "EXIF_GPS" | "MANUAL" | "UNKNOWN" | null;
  heading_source?: "DEVICE_TRUE_HEADING" | "DEVICE_MAGNETIC_HEADING" | "EXIF_GPS_IMG_DIRECTION" | "MANUAL" | "UNKNOWN" | null;
  provenance?: { asset_id?: string | null; exif_tags_present?: string[] } | null;
};

export type CameraDirectionSnapshot = {
  heading: number;
  accuracyCode: number;
  reference: "TRUE_NORTH";
};

export type DeviceCaptureSnapshot = {
  capturedAt: string;
  position: Location.LocationObject | null;
  cameraDirection: CameraDirectionSnapshot | null;
};

type AssetLike = { assetId?: string | null; exif?: Record<string, unknown> | null };

export const MAX_MAPPED_PHOTO_ACCURACY_M = 20;
export const MIN_MAPPED_HEADING_ACCURACY_CODE = 2;

const finite = (value: unknown): number | null => {
  if (value == null || value === "") return null;
  const out = Number(value);
  return Number.isFinite(out) ? out : null;
};

export const normalizePhotoHeading = (value: unknown): number | null => {
  const out = finite(value);
  if (out == null) return null;
  return ((out % 360) + 360) % 360;
};

function coordinate(value: unknown, ref: unknown): number | null {
  const normalizedRef = String(ref || "").trim().toUpperCase();
  const direct = finite(value);
  if (direct != null) {
    if (["S", "W"].includes(normalizedRef)) return -Math.abs(direct);
    if (["N", "E"].includes(normalizedRef)) return Math.abs(direct);
    // iOS commonly returns an already-signed decimal coordinate without a Ref.
    // Preserve that sign instead of forcing west/south values positive.
    return direct;
  }
  if (!Array.isArray(value) || value.length < 3) return null;
  const d = finite(value[0]);
  const m = finite(value[1]);
  const sec = finite(value[2]);
  if (d == null || m == null || sec == null) return null;
  const magnitude = Math.abs(d) + Math.abs(m) / 60 + Math.abs(sec) / 3600;
  if (["S", "W"].includes(normalizedRef)) return -magnitude;
  if (["N", "E"].includes(normalizedRef)) return magnitude;
  return d < 0 ? -magnitude : magnitude;
}

function exifDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return match
    ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`
    : null;
}

function exifHeadingReference(value: unknown): "TRUE_NORTH" | "MAGNETIC_NORTH" | "UNKNOWN" | null {
  if (value == null || value === "") return null;
  const normalized = String(value).trim().toUpperCase();
  if (normalized === "T" || normalized === "TRUE" || normalized === "TRUE_NORTH") return "TRUE_NORTH";
  if (normalized === "M" || normalized === "MAGNETIC" || normalized === "MAGNETIC_NORTH") return "MAGNETIC_NORTH";
  return "UNKNOWN";
}

export function photoCaptureMetadataFromAsset(asset: AssetLike): PhotoCaptureMetadata | null {
  const exif = asset.exif;
  if (!exif) return null;

  const latitude = coordinate(exif.GPSLatitude, exif.GPSLatitudeRef);
  const longitude = coordinate(exif.GPSLongitude, exif.GPSLongitudeRef);
  const rawHorizontalAccuracy = finite(exif.GPSHPositioningError);
  const horizontalAccuracy = rawHorizontalAccuracy != null && rawHorizontalAccuracy >= 0
    ? rawHorizontalAccuracy
    : null;
  const validLocation =
    latitude != null && longitude != null &&
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;

  const heading = normalizePhotoHeading(exif.GPSImgDirection);
  const headingReference = exifHeadingReference(exif.GPSImgDirectionRef);
  const hasHeading = heading != null;

  const tags = [
    "GPSLatitude", "GPSLatitudeRef", "GPSLongitude", "GPSLongitudeRef",
    "GPSHPositioningError", "GPSAltitude", "GPSImgDirection",
    "GPSImgDirectionRef", "DateTimeOriginal",
  ].filter((key) => exif[key] != null);

  const out: PhotoCaptureMetadata = {
    captured_at: exifDate(exif.DateTimeOriginal ?? exif.DateTime),
    latitude: validLocation ? latitude : null,
    longitude: validLocation ? longitude : null,
    // Unknown or weak accuracy is evidence about uncertainty, not a reason to
    // erase an otherwise valid measured coordinate.
    horizontal_accuracy_m: validLocation ? horizontalAccuracy : null,
    altitude_m: validLocation ? finite(exif.GPSAltitude) : null,
    camera_heading_deg: hasHeading ? heading : null,
    camera_heading_accuracy_code: null,
    heading_reference: hasHeading ? (headingReference ?? "UNKNOWN") : null,
    location_source: validLocation ? "EXIF_GPS" : null,
    heading_source: hasHeading ? "EXIF_GPS_IMG_DIRECTION" : null,
    provenance: { asset_id: asset.assetId ?? null, exif_tags_present: tags },
  };
  return out.captured_at || out.latitude != null || out.camera_heading_deg != null || tags.length > 0 ? out : null;
}

export function photoCaptureMetadataFromDeviceSnapshot(
  snapshot: DeviceCaptureSnapshot,
): PhotoCaptureMetadata | null {
  const latitude = finite(snapshot.position?.coords.latitude);
  const longitude = finite(snapshot.position?.coords.longitude);
  const measuredPosition =
    snapshot.position && latitude != null && longitude != null &&
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
      ? snapshot.position
      : null;
  const rawPositionAccuracy = finite(snapshot.position?.coords.accuracy);
  const positionAccuracy = rawPositionAccuracy != null && rawPositionAccuracy >= 0
    ? rawPositionAccuracy
    : null;

  const direction = snapshot.cameraDirection;
  const reliableHeading =
    direction &&
    direction.reference === "TRUE_NORTH" &&
    Number.isFinite(direction.accuracyCode) &&
    direction.accuracyCode >= MIN_MAPPED_HEADING_ACCURACY_CODE
      ? normalizePhotoHeading(direction.heading)
      : null;

  if (!measuredPosition && reliableHeading == null) return null;

  return {
    captured_at: snapshot.capturedAt,
    latitude: measuredPosition?.coords.latitude ?? null,
    longitude: measuredPosition?.coords.longitude ?? null,
    horizontal_accuracy_m: measuredPosition ? positionAccuracy : null,
    altitude_m: measuredPosition?.coords.altitude ?? null,
    camera_heading_deg: reliableHeading,
    camera_heading_accuracy_code:
      reliableHeading != null && direction
        ? Math.max(0, Math.min(3, Math.round(direction.accuracyCode)))
        : null,
    heading_reference: reliableHeading != null ? "TRUE_NORTH" : null,
    location_source: measuredPosition ? "DEVICE_AT_CAPTURE" : null,
    heading_source: reliableHeading != null ? "DEVICE_TRUE_HEADING" : null,
    provenance: null,
  };
}

export function mergePhotoCaptureMetadata(
  primary: PhotoCaptureMetadata | null,
  fallback: PhotoCaptureMetadata | null,
): PhotoCaptureMetadata | null {
  if (!primary) return fallback;
  if (!fallback) return primary;
  return {
    captured_at: primary.captured_at ?? fallback.captured_at ?? null,
    latitude: primary.latitude ?? fallback.latitude ?? null,
    longitude: primary.longitude ?? fallback.longitude ?? null,
    horizontal_accuracy_m: primary.horizontal_accuracy_m ?? fallback.horizontal_accuracy_m ?? null,
    altitude_m: primary.altitude_m ?? fallback.altitude_m ?? null,
    camera_heading_deg: primary.camera_heading_deg ?? fallback.camera_heading_deg ?? null,
    camera_heading_accuracy_code:
      primary.camera_heading_accuracy_code ?? fallback.camera_heading_accuracy_code ?? null,
    heading_reference: primary.heading_reference ?? fallback.heading_reference ?? null,
    location_source: primary.location_source ?? fallback.location_source ?? null,
    heading_source: primary.heading_source ?? fallback.heading_source ?? null,
    provenance: fallback.provenance ?? primary.provenance ?? null,
  };
}

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

export type DeviceCaptureSnapshot = {
  capturedAt: string;
  position: Location.LocationObject | null;
  heading: Location.LocationHeadingObject | null;
};

type AssetLike = { assetId?: string | null; exif?: Record<string, unknown> | null };

export const MAX_MAPPED_PHOTO_ACCURACY_M = 20;
export const MIN_MAPPED_HEADING_ACCURACY_CODE = 3;

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
  const sign = ["S", "W"].includes(String(ref || "").toUpperCase()) ? -1 : 1;
  const direct = finite(value);
  if (direct != null) return Math.abs(direct) * sign;
  if (!Array.isArray(value) || value.length < 3) return null;
  const d = finite(value[0]);
  const m = finite(value[1]);
  const sec = finite(value[2]);
  if (d == null || m == null || sec == null) return null;
  return (Math.abs(d) + m / 60 + sec / 3600) * sign;
}

function exifDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return match
    ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`
    : null;
}

export function photoCaptureMetadataFromAsset(asset: AssetLike): PhotoCaptureMetadata | null {
  const exif = asset.exif;
  if (!exif) return null;

  const latitude = coordinate(exif.GPSLatitude, exif.GPSLatitudeRef);
  const longitude = coordinate(exif.GPSLongitude, exif.GPSLongitudeRef);
  const horizontalAccuracy = finite(exif.GPSHPositioningError);
  const validCoordinates =
    latitude != null && longitude != null &&
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
  // EXIF GPS without an uncertainty radius is not strong enough to place field
  // evidence. Keep the tags as provenance, but do not invent confidence.
  const validLocation =
    validCoordinates && horizontalAccuracy != null &&
    horizontalAccuracy >= 0 && horizontalAccuracy <= MAX_MAPPED_PHOTO_ACCURACY_M;

  // GPSImgDirection has no accuracy estimate. For the evidence map, direction is
  // therefore sourced from the live, quality-gated true-north device reading.
  const tags = [
    "GPSLatitude", "GPSLongitude", "GPSHPositioningError", "GPSAltitude",
    "GPSImgDirection", "GPSImgDirectionRef", "DateTimeOriginal",
  ].filter((key) => exif[key] != null);

  const out: PhotoCaptureMetadata = {
    captured_at: exifDate(exif.DateTimeOriginal ?? exif.DateTime),
    latitude: validLocation ? latitude : null,
    longitude: validLocation ? longitude : null,
    horizontal_accuracy_m: validLocation ? horizontalAccuracy : null,
    altitude_m: validLocation ? finite(exif.GPSAltitude) : null,
    camera_heading_deg: null,
    camera_heading_accuracy_code: null,
    heading_reference: null,
    location_source: validLocation ? "EXIF_GPS" : null,
    heading_source: null,
    provenance: { asset_id: asset.assetId ?? null, exif_tags_present: tags },
  };
  return out.captured_at || out.latitude != null || tags.length > 0 ? out : null;
}

export function photoCaptureMetadataFromDeviceSnapshot(
  snapshot: DeviceCaptureSnapshot,
): PhotoCaptureMetadata | null {
  const positionAccuracy = finite(snapshot.position?.coords.accuracy);
  const reliablePosition =
    snapshot.position && positionAccuracy != null && positionAccuracy >= 0 &&
    positionAccuracy <= MAX_MAPPED_PHOTO_ACCURACY_M
      ? snapshot.position
      : null;

  const reliableTrueHeading =
    snapshot.heading && snapshot.heading.trueHeading >= 0 &&
    snapshot.heading.accuracy >= MIN_MAPPED_HEADING_ACCURACY_CODE
      ? normalizePhotoHeading(snapshot.heading.trueHeading)
      : null;

  if (!reliablePosition && reliableTrueHeading == null) return null;

  return {
    captured_at: snapshot.capturedAt,
    latitude: reliablePosition?.coords.latitude ?? null,
    longitude: reliablePosition?.coords.longitude ?? null,
    horizontal_accuracy_m: reliablePosition ? positionAccuracy : null,
    altitude_m: reliablePosition?.coords.altitude ?? null,
    camera_heading_deg: reliableTrueHeading,
    camera_heading_accuracy_code:
      reliableTrueHeading != null && snapshot.heading
        ? Math.max(0, Math.min(3, Math.round(snapshot.heading.accuracy)))
        : null,
    heading_reference: reliableTrueHeading != null ? "TRUE_NORTH" : null,
    location_source: reliablePosition ? "DEVICE_AT_CAPTURE" : null,
    heading_source: reliableTrueHeading != null ? "DEVICE_TRUE_HEADING" : null,
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

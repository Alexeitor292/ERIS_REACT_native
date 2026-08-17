export function parseRoadBearingInput(value: string): number | null {
  const raw = value.trim();
  if (!raw) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed < 360 ? parsed : null;
}

export function bearingSourceLabel(source: string | null | undefined): string {
  if (source === "arcgis_postmile_geometry") return "auto from postmile geometry";
  if (source === "road_inventory_snapshot") return "road inventory snapshot";
  return source || "request";
}

export function bearingDisplayNote(
  bearingUsed: number | null | undefined,
  bearingSource: string | null | undefined,
): string {
  if (bearingUsed == null) return "not set — classification may be UNKNOWN";
  return `${Math.round(bearingUsed)}° (${bearingSourceLabel(bearingSource)})`;
}

export function elevationClassificationReasonNote(
  reason: string | null | undefined,
  metadataNote?: string | null,
): string | undefined {
  if (metadataNote) return metadataNote;
  if (reason === "ROAD_BEARING_UNAVAILABLE") {
    return "Road bearing could not be resolved, so only center elevation is available.";
  }
  if (reason === "INSUFFICIENT_VALID_SAMPLES") {
    return "Not enough valid USGS samples on both sides of the road to classify the terrain.";
  }
  if (reason === "AMBIGUOUS_TERRAIN") {
    return "Terrain is mixed/ambiguous: the sampled cross-section does not match a single shape.";
  }
  return undefined;
}

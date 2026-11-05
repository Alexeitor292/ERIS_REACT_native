// The terrain model the technical form measures against: USGS 3DEP, read through ERIS from the
// same tiles as the iPhone, so both get the same heights. The 3D map still shows Esri's ground,
// which is for looking at; values that get saved come from here. See docs/operations/map-licensing.md.

import { appConfig } from "../../config";
import { groundSpacingM, heightsAt, readElevationTile, type ElevationTile, type LonLat } from "./elevationTile";

export type { LonLat };

// Tiles never change under the same address, so one read is enough for the page.
const tiles = new Map<string, Promise<ElevationTile | null>>();

function tile(row: number, col: number): Promise<ElevationTile | null> {
  const key = `${row}/${col}`;
  let found = tiles.get(key);
  if (!found) {
    found = (async () => {
      // The session cookie authenticates this read.
      const response = await fetch(`${appConfig.apiBaseUrl}/elevation-tiles/${key}`, { credentials: "same-origin" });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Could not read the USGS elevation (${response.status}).`);
      return readElevationTile(await response.arrayBuffer());
    })();
    tiles.set(key, found);
    // A failure is not kept: the next measurement tries again.
    found.catch(() => tiles.delete(key));
  }
  return found;
}

/** Elevations (metres) at [lon, lat] points from USGS 3DEP, and how far apart they were read. */
export async function sampleElevations(points: LonLat[]): Promise<{ z: Array<number | null>; resolution: { min: number; max: number } | null }> {
  if (!points.length) return { z: [], resolution: null };
  const z = await heightsAt(points, tile);
  const spacing = groundSpacingM(points.reduce((sum, [, lat]) => sum + lat, 0) / points.length);
  return { z, resolution: { min: spacing, max: spacing } };
}

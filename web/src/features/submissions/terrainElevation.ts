// The terrain model the technical form measures against: Esri World Elevation
// (USGS 3DEP lidar where it exists), loaded once per page and queried at the
// finest resolution that covers every point asked for.

export type LonLat = [number, number];

let groundPromise: Promise<any> | null = null;

export function worldElevationGround(): Promise<any> {
  if (!groundPromise) {
    groundPromise = (async () => {
      const [{ default: esriConfig }, { default: ArcGisMap }] = await Promise.all([import("@arcgis/core/config"), import("@arcgis/core/Map")]);
      const apiKey = import.meta.env.VITE_ARCGIS_API_KEY;
      if (apiKey) esriConfig.apiKey = String(apiKey);
      const map = new ArcGisMap({ ground: "world-elevation" });
      await map.ground.loadAll();
      return map.ground;
    })().catch((error) => {
      groundPromise = null;
      throw error;
    });
  }
  return groundPromise;
}

/** Elevations (metres) at [lon, lat] points from Esri World Elevation, finest resolution that covers them all. */
export async function sampleElevations(points: LonLat[]): Promise<{ z: Array<number | null>; resolution: { min: number; max: number } | null }> {
  if (!points.length) return { z: [], resolution: null };
  const [ground, { default: Multipoint }] = await Promise.all([worldElevationGround(), import("@arcgis/core/geometry/Multipoint")]);
  const geometry = new Multipoint({ points: points.map(([lon, lat]) => [lon, lat]), spatialReference: { wkid: 4326 } });
  const result = await ground.queryElevation(geometry, { demResolution: "finest-contiguous", returnSampleInfo: true });
  const noData = result.noDataValue;
  const z: Array<number | null> = (result.geometry.points as number[][]).map((p) => (Number.isFinite(p[2]) && p[2] !== noData ? p[2] : null));
  const resolutions = ((result.sampleInfo ?? []) as Array<{ demResolution?: number }>)
    .map((info) => Number(info.demResolution))
    .filter((value) => Number.isFinite(value) && value > 0);
  return { z, resolution: resolutions.length ? { min: Math.min(...resolutions), max: Math.max(...resolutions) } : null };
}

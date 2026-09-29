// Looks up where the terrain under a point comes from (terrainSourceModel.ts
// says how to read it): the USGS 3DEP index inside the US, Esri's World
// Elevation Data Extents elsewhere. Answers are cached per ~100 m.

import { useEffect, useState } from "react";

import { pickEsriSource, pickUsgsSource, type TerrainSource } from "./terrainSourceModel";

const USGS_INDEX = "https://index.nationalmap.gov/arcgis/rest/services/3DEPElevationIndex/MapServer";
const USGS_ONE_METER = 18; // 1 m DEM products: the project each was made from
const USGS_SOURCE_UNITS = 11; // lidar work units behind the DEMs, with their flight dates
const USGS_THIRD_ARC = 21; // 1/3 arc-second DEM projects, with dates
const ESRI_EXTENTS = "https://elevation.arcgis.com/arcgis/rest/services/WorldElevation/DataExtents/MapServer";

const cache = new Map<string, Promise<TerrainSource | null>>();

async function json(url: string, signal?: AbortSignal): Promise<any> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json();
}

async function usgsLayer(layer: number, lon: number, lat: number, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
  const query = new URLSearchParams({
    f: "json",
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
    returnGeometry: "false",
  });
  const data = await json(`${USGS_INDEX}/${layer}/query?${query}`, signal);
  return (data.features ?? []).map((f: { attributes: Record<string, unknown> }) => f.attributes);
}

async function lookUp(lon: number, lat: number): Promise<TerrainSource | null> {
  try {
    const [oneMeter, units, thirdArc] = await Promise.all([
      usgsLayer(USGS_ONE_METER, lon, lat),
      usgsLayer(USGS_SOURCE_UNITS, lon, lat),
      usgsLayer(USGS_THIRD_ARC, lon, lat),
    ]);
    const usgs = pickUsgsSource(oneMeter, units, thirdArc);
    if (usgs) return usgs;
  } catch {
    // Outside the US, or the index is unavailable: ask Esri.
  }
  try {
    const d = 0.001;
    const query = new URLSearchParams({
      f: "json",
      geometry: `${lon},${lat}`,
      geometryType: "esriGeometryPoint",
      sr: "4326",
      layers: "all",
      tolerance: "0",
      mapExtent: `${lon - d},${lat - d},${lon + d},${lat + d}`,
      imageDisplay: "100,100,96",
      returnGeometry: "false",
    });
    const data = await json(`${ESRI_EXTENTS}/identify?${query}`);
    return pickEsriSource(data.results ?? []);
  } catch {
    return null;
  }
}

/** Where the terrain at a point comes from and when it was flown; null when nobody says. */
export function terrainSourceAt(lon: number, lat: number): Promise<TerrainSource | null> {
  const key = `${lon.toFixed(3)},${lat.toFixed(3)}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = lookUp(lon, lat);
    cache.set(key, pending);
    // Keep answers; forget a failed lookup so the next one tries again.
    pending.then((source) => { if (!source) cache.delete(key); });
  }
  return pending;
}

/** The terrain source at a point, for a component (null while looking, or when unknown). */
export function useTerrainSource(point: [number, number] | null): TerrainSource | null {
  const [source, setSource] = useState<TerrainSource | null>(null);
  const key = point ? `${point[0].toFixed(3)},${point[1].toFixed(3)}` : "";
  useEffect(() => {
    setSource(null);
    if (!point) return;
    let cancelled = false;
    terrainSourceAt(point[0], point[1]).then((s) => { if (!cancelled) setSource(s); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return source;
}

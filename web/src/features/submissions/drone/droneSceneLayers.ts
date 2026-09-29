// The drone survey in an ArcGIS view: its elevation patched into the terrain
// model (only inside the patch — everywhere else World Elevation stays), and
// its orthomosaic draped over the same ground.

import BaseElevationLayer from "@arcgis/core/layers/BaseElevationLayer";
import ElevationLayer from "@arcgis/core/layers/ElevationLayer";
import MediaLayer from "@arcgis/core/layers/MediaLayer";
import ImageElement from "@arcgis/core/layers/support/ImageElement";
import CornersGeoreference from "@arcgis/core/layers/support/CornersGeoreference";
import Point from "@arcgis/core/geometry/Point";

import { cellIndex, cellSizeM, edgeDistance, sampleGrid, type DroneGrid, type LonLat } from "./droneGrid";

export const WORLD_ELEVATION_URL = "https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer";

const R = 6378137;
const toLon = (x: number) => (x / R) * (180 / Math.PI);
const toLat = (y: number) => (Math.atan(Math.exp(y / R)) * 2 - Math.PI / 2) * (180 / Math.PI);
const toX = (lon: number) => (lon * Math.PI * R) / 180;
const toY = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

/** How far in from a survey's edge its heights take over completely from the terrain model, metres. */
const BLEND_M = 12;

/**
 * World Elevation with the drone survey's heights (plus its vertical offset)
 * wherever the survey has data. Near the survey's edges (and around holes in
 * it) the two blend over BLEND_M, so where they disagree the ground ramps
 * instead of standing up as a wall. Tiles away from the survey pass through untouched.
 */
export function createPatchedElevationLayer(grid: DroneGrid, offsetM: number): BaseElevationLayer {
  const bounds = { xmin: toX(grid.west), xmax: toX(grid.east), ymin: toY(grid.south), ymax: toY(grid.north) };
  const cell = cellSizeM(grid);
  const blendCells = Math.max(2, Math.min(60, Math.round(BLEND_M / Math.max(0.05, Math.min(cell.dx, cell.dy)))));
  const edge = edgeDistance(grid, blendCells);
  const Patched = (BaseElevationLayer as any).createSubclass({
    load(this: any) {
      this._base = new ElevationLayer({ url: WORLD_ELEVATION_URL });
      this.addResolvingPromise(
        this._base.load().then(() => {
          this.tileInfo = this._base.tileInfo;
          this.spatialReference = this._base.spatialReference;
          this.fullExtent = this._base.fullExtent;
        }),
      );
    },
    fetchTile(this: any, level: number, row: number, col: number, options: unknown) {
      return this._base.fetchTile(level, row, col, options).then((data: any) => {
        const lod = this.tileInfo.lods.find((l: any) => l.level === level) ?? this.tileInfo.lods[level];
        const [tileW, tileH] = this.tileInfo.size;
        const span = [tileW * lod.resolution, tileH * lod.resolution];
        const xmin = this.tileInfo.origin.x + col * span[0];
        const ymax = this.tileInfo.origin.y - row * span[1];
        if (xmin > bounds.xmax || xmin + span[0] < bounds.xmin || ymax < bounds.ymin || ymax - span[1] > bounds.ymax) return data;
        // Edit the heights in the tile World Elevation returned, and return that same
        // tile: the view hit-tests and queries the ground through its class (a plain
        // copy leaves the drone ground unclickable). Its min and max are read-only
        // and worked out on first use, so they come out right after the edit.
        const { width, height, values } = data as { width: number; height: number; values: Float32Array };
        const stepX = span[0] / (width - 1);
        const stepY = span[1] / (height - 1);
        for (let j = 0; j < height; j += 1) {
          const lat = toLat(ymax - j * stepY);
          for (let i = 0; i < width; i += 1) {
            const lon = toLon(xmin + i * stepX);
            const z = sampleGrid(grid, lon, lat);
            if (z == null) continue;
            const k = j * width + i;
            const w = Math.min(1, edge[cellIndex(grid, lon, lat)] / blendCells);
            values[k] = values[k] + w * (z + offsetM - values[k]);
          }
        }
        return data;
      });
    },
  });
  return new Patched({ title: "Drone survey elevation" }) as BaseElevationLayer;
}

/** The orthomosaic draped over the ground, on its four corners (top-left, top-right, bottom-right, bottom-left). */
export function createOrthomosaicLayer(url: string, corners: LonLat[], opacity = 1): MediaLayer {
  const at = ([lon, lat]: LonLat) => new Point({ longitude: lon, latitude: lat, spatialReference: { wkid: 4326 } });
  const element = new ImageElement({
    image: url,
    georeference: new CornersGeoreference({
      topLeft: at(corners[0]),
      topRight: at(corners[1]),
      bottomRight: at(corners[2]),
      bottomLeft: at(corners[3]),
    }),
  });
  return new MediaLayer({ source: [element], title: "Drone orthomosaic", opacity });
}

/**
 * Where the survey shown as now has data and the earlier survey does not, hatched:
 * there the "before" ground is the terrain model, not the earlier flight.
 * Draped over the now survey's extent; null when the earlier survey covers it all.
 */
export function createGapOverlayLayer(now: DroneGrid, before: DroneGrid): MediaLayer | null {
  const side = 768;
  const aspect = ((now.east - now.west) * Math.cos((((now.north + now.south) / 2) * Math.PI) / 180)) / (now.north - now.south);
  const width = aspect >= 1 ? side : Math.max(64, Math.round(side * aspect));
  const height = aspect >= 1 ? Math.max(64, Math.round(side / aspect)) : side;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const image = ctx.createImageData(width, height);
  let gaps = 0;
  for (let y = 0; y < height; y += 1) {
    const lat = now.north - ((y + 0.5) / height) * (now.north - now.south);
    for (let x = 0; x < width; x += 1) {
      const lon = now.west + ((x + 0.5) / width) * (now.east - now.west);
      if (sampleGrid(now, lon, lat) == null || sampleGrid(before, lon, lat) != null) continue;
      gaps += 1;
      const stripe = (x + y) % 10 < 4;
      const k = (y * width + x) * 4;
      image.data[k] = 15;
      image.data[k + 1] = 23;
      image.data[k + 2] = 42;
      image.data[k + 3] = stripe ? 150 : 60;
    }
  }
  if (!gaps) return null;
  ctx.putImageData(image, 0, 0);
  const corners: LonLat[] = [[now.west, now.north], [now.east, now.north], [now.east, now.south], [now.west, now.south]];
  const at = ([lon, lat]: LonLat) => new Point({ longitude: lon, latitude: lat, spatialReference: { wkid: 4326 } });
  const element = new ImageElement({
    image: canvas,
    georeference: new CornersGeoreference({ topLeft: at(corners[0]), topRight: at(corners[1]), bottomRight: at(corners[2]), bottomLeft: at(corners[3]) }),
  });
  return new MediaLayer({ source: [element], title: "No earlier survey here", opacity: 1 });
}

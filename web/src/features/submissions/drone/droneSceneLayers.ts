// The drone survey in an ArcGIS view: its elevation patched into the terrain
// model (only inside the patch — everywhere else World Elevation stays), and
// its orthomosaic draped over the same ground.

import BaseElevationLayer from "@arcgis/core/layers/BaseElevationLayer";
import ElevationLayer from "@arcgis/core/layers/ElevationLayer";
import MediaLayer from "@arcgis/core/layers/MediaLayer";
import ImageElement from "@arcgis/core/layers/support/ImageElement";
import CornersGeoreference from "@arcgis/core/layers/support/CornersGeoreference";
import Point from "@arcgis/core/geometry/Point";

import { sampleGrid, type DroneGrid, type LonLat } from "./droneGrid";

export const WORLD_ELEVATION_URL = "https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer";

const R = 6378137;
const toLon = (x: number) => (x / R) * (180 / Math.PI);
const toLat = (y: number) => (Math.atan(Math.exp(y / R)) * 2 - Math.PI / 2) * (180 / Math.PI);
const toX = (lon: number) => (lon * Math.PI * R) / 180;
const toY = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

/**
 * World Elevation with the drone survey's heights (plus its vertical offset)
 * wherever the survey has data. Tiles away from the survey pass through untouched.
 */
export function createPatchedElevationLayer(grid: DroneGrid, offsetM: number): BaseElevationLayer {
  const bounds = { xmin: toX(grid.west), xmax: toX(grid.east), ymin: toY(grid.south), ymax: toY(grid.north) };
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
            const z = sampleGrid(grid, toLon(xmin + i * stepX), lat);
            if (z != null) values[j * width + i] = z + offsetM;
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

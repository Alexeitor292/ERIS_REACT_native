import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const controller = fs.readFileSync(path.join(root, "plugins/arcgis-ios/ArcGisEristerrainSceneViewController.m"), "utf8");
const plugin = fs.readFileSync(path.join(root, "plugins/withArcGisIos.js"), "utf8");

const requiredController = [
  "esri-terrain.tpkx",
  "AGSTileCache",
  "initWithFileURL",
  "AGSArcGISTiledElevationSource",
  "initWithTileCache",
  "surface.elevationSources = @[elevation]",
  "surface.elevationExaggeration = 1.0",
  "AGSSceneView",
];
for (const token of requiredController) {
  if (!controller.includes(token)) throw new Error(`Esri offline terrain controller missing contract token: ${token}`);
}

for (const token of [
  "ArcGisEristerrainSceneViewController.m",
  "eristerrain_esri",
  "ArcGisEristerrainSceneViewController",
]) {
  if (!plugin.includes(token)) throw new Error(`ArcGIS iOS plugin missing Esri terrain routing token: ${token}`);
}

if (controller.includes("elevation3d.arcgis.com") || controller.includes("tiledbasemaps.arcgis.com")) {
  throw new Error("Native offline Terrain3D viewer must not contact an elevation service at render time.");
}

console.log("Esri offline Terrain3D native contract OK");

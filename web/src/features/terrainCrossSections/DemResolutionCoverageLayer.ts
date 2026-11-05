import MapImageLayer from "@arcgis/core/layers/MapImageLayer";

import { DEM_COVERAGE_CLASSES, demCoverageLayersMatch } from "./demResolutionCoverageModel";

const USGS_INDEX_URL = "https://index.nationalmap.gov/arcgis/rest/services/3DEPElevationIndex/MapServer";

/**
 * The finest elevation USGS has at each place, drawn by USGS as an image of the view. These
 * layers' shapes are too big to send to the browser: 16 MB for one layer over Sacramento, which
 * crashed the tab when they were drawn here.
 */
export function createDemResolutionCoverageLayer() {
  return new MapImageLayer({
    url: USGS_INDEX_URL,
    title: "USGS 3DEP coverage",
    visible: false,
    opacity: 0.4,
    // The coarsest first, so that the finest ends up on top and a colour means the finest there.
    sublayers: [...DEM_COVERAGE_CLASSES].reverse().map((coverageClass) => ({
      id: coverageClass.layerId,
      title: coverageClass.label,
      renderer: {
        type: "simple",
        symbol: {
          type: "simple-fill",
          color: [...coverageClass.rgb, 1],
          outline: { color: [...coverageClass.rgb, 1], width: 0 },
        },
      } as never,
    })),
  });
}

export function refreshDemResolutionCoverageLayer(layer: MapImageLayer) {
  layer.refresh();
}

/**
 * Whether each coverage layer is still what USGS's catalog calls it. Layer numbers in a service can
 * change: an earlier version of this overlay read Esri's catalog with numbers that were off by one,
 * and so showed 10 m where there was 1 m. Better to show no colours than the wrong ones.
 */
export async function demCoverageLayersAreRight(): Promise<boolean> {
  try {
    const response = await fetch(`${USGS_INDEX_URL}?f=json`);
    return response.ok && demCoverageLayersMatch(await response.json());
  } catch {
    return false;
  }
}

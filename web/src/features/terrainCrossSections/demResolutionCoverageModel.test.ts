import assert from "node:assert/strict";
import test from "node:test";

import {
  coverageShares,
  DEM_COVERAGE_CLASSES,
  demCoverageClassForPixelSize,
  demCoverageLayersMatch,
  pixelSizeFromUsgsResolution,
  readUsgsPoints,
  summarizeUsgsSamples,
} from "./demResolutionCoverageModel.ts";

test("each coverage class names the USGS catalog layer it must be", () => {
  // USGS's 3DEP Elevation Index, read 2026-11-04. An overlay that trusted layer numbers alone
  // once showed 10 m over Sacramento's 1 m lidar when the numbers moved.
  assert.deepEqual(DEM_COVERAGE_CLASSES.map(({ id, layerId, layerName }) => [id, layerId, layerName]), [
    ["1m", 1, "1 meter"],
    ["3m", 2, "1/9 arc-second"],
    ["10m", 4, "1/3 arc-second"],
    ["30m", 5, "1 arc-second"],
  ]);
});

test("colours are only shown while USGS's catalog still means what they say", () => {
  const today = [
    { id: 0, name: "DEM Product Index" }, { id: 1, name: "1 meter" }, { id: 2, name: "1/9 arc-second" },
    { id: 3, name: "5 meter (Alaska only)" }, { id: 4, name: "1/3 arc-second" }, { id: 5, name: "1 arc-second" },
  ];
  assert.equal(demCoverageLayersMatch({ layers: today }), true);
  // What happened with Esri's catalog: the same names, one number off.
  const moved = today.map((layer) => ({ ...layer, id: layer.id + 1 }));
  assert.equal(demCoverageLayersMatch({ layers: moved }), false);
  assert.equal(demCoverageLayersMatch({}), false);
  assert.equal(demCoverageLayersMatch(null), false);
});

test("USGS's sizes are read in metres or degrees", () => {
  assert.equal(pixelSizeFromUsgsResolution(1), 1);
  assert.ok(Math.abs(pixelSizeFromUsgsResolution(9.259259341472414e-5)! - 10.31) < 0.01);
  assert.ok(Math.abs(pixelSizeFromUsgsResolution(3.086419871794868e-5)! - 3.44) < 0.01);
  assert.ok(Math.abs(pixelSizeFromUsgsResolution(0.00027777778024417243)! - 30.9) < 0.1);
  assert.equal(pixelSizeFromUsgsResolution(0), null);
});

test("each source falls in the class it is known by", () => {
  assert.equal(demCoverageClassForPixelSize(1), "1m");
  assert.equal(demCoverageClassForPixelSize(3.44), "3m");
  assert.equal(demCoverageClassForPixelSize(10.31), "10m");
  assert.equal(demCoverageClassForPixelSize(30.9), "30m");
  assert.equal(demCoverageClassForPixelSize(0), null);
});

test("USGS's answer for a path becomes what it read, largest share first", () => {
  const lidar = { resolution: 1, value: "8.3", attributes: { Name: "CA_Sacramento_2017" } };
  const third = { resolution: 9.259259341472414e-5, value: "9.1", attributes: { Name: "n39w122" } };
  const none = { resolution: 1, value: "NoData" };
  const summary = summarizeUsgsSamples([lidar, lidar, lidar, third, none]);
  assert.equal(summary.min_pixel_size_m, 1);
  assert.ok(summary.mixed_resolution);
  assert.equal(summary.covered_sample_count, 4);
  assert.equal(summary.total_sample_count, 5);
  assert.deepEqual(summary.datasets.map((dataset) => [dataset.product_name, dataset.sample_count]), [["CA_Sacramento_2017", 3], ["n39w122", 1]]);
  assert.deepEqual(coverageShares(summary).map(({ id, share }) => [id, share]), [["1m", 0.75], ["10m", 0.25]]);
});

test("a path all on one source is not mixed", () => {
  const summary = summarizeUsgsSamples([{ resolution: 1, value: 8 }, { resolution: 1, value: 9 }]);
  assert.equal(summary.mixed_resolution, false);
  assert.equal(summarizeUsgsSamples([]).min_pixel_size_m, null);
});

const answering = (reply: (url: string, points: number[][]) => Response) => {
  const asked: Array<{ url: string; count: number }> = [];
  const send = (async (url: string, init?: RequestInit) => {
    const points = JSON.parse(new URLSearchParams(String(init?.body)).get("geometry")!).points as number[][];
    asked.push({ url, count: points.length });
    return reply(url, points);
  }) as typeof fetch;
  return { asked, send };
};
const lidar = (points: number[][]) => Response.json({
  samples: points.map((point, locationId) => ({ locationId, value: String(point[0] + 200), resolution: 1, attributes: { Name: "CA_Sacramento_2017" } })),
});

test("a long path is read in batches, each height at its own point", async () => {
  const { asked, send } = answering((_, points) => lidar(points));
  const points = Array.from({ length: 1800 }, (_, i): [number, number] => [-121 + i / 1e4, 38.5]);
  const { z, coverage } = await readUsgsPoints(points, send);
  assert.deepEqual(asked.map(({ count }) => count), [1000, 800]);
  assert.equal(z[0], points[0][0] + 200);
  assert.equal(z[1500], points[1500][0] + 200);
  assert.equal(coverage.min_pixel_size_m, 1);
  assert.equal(coverage.covered_sample_count, 1800);
});

test("a retry changes the address, because USGS repeats an error for the same one", async () => {
  let calls = 0;
  const { asked, send } = answering((_, points) => (calls++ === 0 ? new Response("Bad Gateway", { status: 502 }) : lidar(points)));
  const { z } = await readUsgsPoints([[-121, 38.5]], send);
  assert.equal(z[0], 79);
  assert.equal(new Set(asked.map(({ url }) => url)).size, 2);
});

test("no data stays missing, and USGS failing is an error rather than a flat line", async () => {
  const none = answering(() => Response.json({ samples: [{ locationId: 0, value: "NoData", resolution: 1 }, { locationId: 1, value: "5", resolution: 1 }] }));
  const { z } = await readUsgsPoints([[-121, 38.5], [-121.1, 38.5]], none.send);
  assert.deepEqual(z, [null, 5]);
  const down = answering(() => new Response("Bad Gateway", { status: 502 }));
  await assert.rejects(readUsgsPoints([[-121, 38.5]], down.send), /Could not read the USGS elevation \(status 502\)/);
  assert.equal(down.asked.length, 3);
});

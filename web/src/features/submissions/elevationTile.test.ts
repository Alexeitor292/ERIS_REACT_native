import assert from "node:assert/strict";
import test from "node:test";

import { groundSpacingM, heightInTile, heightsAt, readElevationTile, tileOf } from "./elevationTile.ts";

// A tile as USGS sends it: 17 x 17 heights near Hayward. UsgsElevationTests.swift reads this same one.
const REAL_TILE = "Q250WkltYWdlIAsAAAAIAAAAEQAAABEAAABhMlUwKqkTPwAAAAAAAAAAAAAAAAAAgD8BAAAAAQAAAJMCAACNkI5DAXD/dUNSIQGOB6MmOhBzwUHxBxfYa/ChUgNaGw9gTkABAACwkN6A1jsplFWOzrwUojQI4wVUH+90J3H6EQ5aPNNwbQMJdDAgwK2B1o4OAEunRFUIElneBEx4PUsYyJLw0hwHk2/BWMYT0FVk4XAE4wI2vAW0AbEHfq31QNQLV+4MeuQNfzYL/pLCtYsg7JCokVVHzlBogLd5BLsWMvy7YFrRcha5EGZxjU8cYABU8FEwj9+A4s5KrHqk2IjeyFEnX+jwcWHiD8lt0mf3EmgTxkk1c1dEazI1Y+mOiwXR1Fk4jYI1t1QYw0boJc8WtjnUToRFQ8SGFl5X7YSlZGtTmJH9BE0TEHI+9/APlMzTOfp2U2KtcKJJsow4i2VuSOydhYxYkXk3nXJZksNIMcW09FF/Sotw+WOco7sAyjIaRCyIXlf65oIeL2+BWcfPVKpWZ/FftZW2WsJRO4X5eECmLuPrdbKibcA+qI0kOWnQBSWel7ZnjX3kZRpgaNgxcNbGLVh4hHHdQFO70ycPicVqQOsjlqKYmxt6r9l8Zp1DclYllZfax2/g1rPly5nS5oovK+Bw/QSBXi3eX/aOz71RJ2D9efXecph+6YUCIG43KaDsXawR7NJ2s1TdUpITJb+l9vVYOGFJf88eE5nSZpcAWPt4WWV6cRhWfgV9e4Y2LxUoarS6LaqDeWOUh6n2WukeRKbogFG6FCqVa33eT0OiBi+XN7e97hrQa2aTCqXukm0mzYkzh7EEnKGbAW6vU9k+mYIp2Q37z3kb9L/nqx65ayfln9w+RkqlIrsuur3syvHJ2DKPi14wKxygVnUPujz99loUPapLri829LpyrsNQ4rs9O/TfGYFvPey2xL8rgz8Awr4AAAA=";
const bytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const near = (a: number, b: number, within = 0.001) => assert.ok(Math.abs(a - b) <= within, `${a} is not ${b}`);

test("a real tile reads as USGS's uncompressed answer to the same request", () => {
  const tile = readElevationTile(bytes(REAL_TILE));
  assert.equal(tile.width, 17);
  assert.equal(tile.height, 17);
  near(tile.values[0], 251.9324);
  near(tile.values[8 * 17 + 8], 259.3095);
  near(tile.values[288], 275.2982);
  near(tile.values.reduce((sum, value) => sum + value, 0), 75892.456, 0.05);
});

test("a place is read from the same tile at the same height as on the iPhone", async () => {
  const asked: string[] = [];
  const heights = await heightsAt([[-122.08, 37.67]], async (row, col) => {
    asked.push(`${row}/${col}`);
    return readElevationTile(bytes(REAL_TILE));
  });
  assert.deepEqual(asked, ["50710/21088"]);
  // UsgsElevationTests.swift expects this same height.
  near(heights[0]!, 268.28704101514217, 0.0001);
});

test("each tile is asked for once, and no data is only missing where it is missing", async () => {
  const flat = { width: 2, height: 2, values: new Float32Array([7.5, 7.5, 7.5, 7.5]) };
  const asked: string[] = [];
  const { col } = tileOf([-121.433, 35.866]);
  const heights = await heightsAt([[-121.433, 35.866], [-121.433, 35.866], [-120, 37]], async (row, c) => {
    asked.push(`${row}/${c}`);
    return c === col ? flat : null;
  });
  assert.deepEqual(heights, [7.5, 7.5, null]);
  assert.equal(asked.length, 2);
});

test("a failed tile fails the answer rather than passing for no data", async () => {
  await assert.rejects(heightsAt([[-120, 37]], async () => { throw new Error("down"); }), /down/);
});

test("heights are read between posts, and a hole is a hole", () => {
  const tile = { width: 2, height: 2, values: new Float32Array([0, 10, 20, 30]) };
  assert.equal(heightInTile(tile, 0, 0), 0);
  assert.equal(heightInTile(tile, 1, 1), 30);
  assert.equal(heightInTile(tile, 0.5, 0.5), 15);
  assert.equal(heightInTile({ ...tile, values: new Float32Array([NaN, 10, 20, 30]) }, 0.5, 0.5), null);
});

test("anything but a tile is refused", () => {
  assert.throws(() => readElevationTile(new TextEncoder().encode('{"error":404}')));
});

test("heights are never more than about a metre apart in California", () => {
  near(groundSpacingM(32.5), 1.007, 0.001);
  near(groundSpacingM(42), 0.888, 0.001);
});

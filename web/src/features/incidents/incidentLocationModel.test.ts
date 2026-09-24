import assert from "node:assert/strict";
import test from "node:test";

import {
  coordinatesFromRoadFeatures,
  incidentName,
  numericPostmile,
  roadFromCoordinateFeatures,
  roadLocationLabel,
  roadQueryParams,
  streetViewUrl,
  type PostmileFeature,
} from "./incidentLocationModel.ts";

// Shapes and values as the Caltrans SHN Postmiles Tenth layer returned them.
function marker(pm: number, align: "Left" | "Right", x: number, y: number, extra: Record<string, unknown> = {}): PostmileFeature {
  return {
    attributes: { District: 1, County: "HUM", Route: 101, PMPrefix: "", PM: pm, PMSuffix: "", PMRouteID: `HUM101...${align[0]}`, AlignCode: align, ...extra },
    geometry: { x, y },
  };
}

test("a point takes the district, county, route and post mile of the nearest marker, at the point itself", () => {
  const features = [
    marker(61.4000015, "Left", -124.16598045, 40.59760091),
    marker(61.5, "Left", -124.16732614, 40.59863789),
    marker(61.09999847, "Left", -124.16089763, 40.59552309),
  ];
  const resolved = roadFromCoordinateFeatures(features, 40.5987, -124.1674);
  assert.deepEqual(resolved, {
    latitude: 40.5987,
    longitude: -124.1674,
    district: "01",
    county: "HUM",
    route: "101",
    post_mile: "61.50",
    method: "ONLINE_COORDINATE_LOOKUP",
  });
});

test("a point with no marker nearby, or a marker missing a part, does not resolve", () => {
  assert.equal(roadFromCoordinateFeatures([], 40.6, -124.1), null);
  const noDistrict = marker(61.5, "Left", -124.1673, 40.5986, { District: null });
  assert.equal(roadFromCoordinateFeatures([noDistrict], 40.5986, -124.1673), null);
});

test("a post mile on a marker takes the marker's position, both alignments averaged", () => {
  const features = [marker(84, "Left", -124.08217353, 40.83619417), marker(84, "Right", -124.08179216, 40.8361705)];
  const resolved = coordinatesFromRoadFeatures(features, 84)!;
  assert.equal(resolved.method, "ONLINE_EXACT_POSTMILE");
  assert.equal(resolved.post_mile, "84.00");
  assert.equal(resolved.latitude, 40.836182);
  assert.equal(resolved.longitude, -124.081983);
  assert.equal(resolved.district, "01");
});

test("a post mile between markers is placed between them on one alignment", () => {
  // As Caltrans orders them by PM: the two alignments interleave.
  const features = [
    marker(84, "Left", -124.08217353, 40.83619417),
    marker(84, "Right", -124.08179216, 40.8361705),
    marker(84.09999847, "Right", -124.08177743, 40.8376047),
    marker(84.09999847, "Left", -124.08215951, 40.83764599),
  ];
  const resolved = coordinatesFromRoadFeatures(features, 84.05)!;
  assert.equal(resolved.method, "ONLINE_INTERPOLATED_POSTMILE");
  assert.equal(resolved.align_code, "Right");
  assert.equal(resolved.post_mile, "84.05");
  assert.ok(resolved.latitude > 40.83617 && resolved.latitude < 40.8376);
});

test("with no pair around it, the nearest marker counts within 0.12 miles and not beyond", () => {
  const lone = [marker(84, "Left", -124.08217353, 40.83619417)];
  assert.equal(coordinatesFromRoadFeatures(lone, 84.1)!.method, "ONLINE_NEAREST_POSTMILE");
  assert.equal(coordinatesFromRoadFeatures(lone, 84.2), null);
  assert.equal(coordinatesFromRoadFeatures([], 84), null);
});

test("the road query asks for markers a quarter mile either side, and nothing for an incomplete road", () => {
  const params = roadQueryParams({ district: "01", county: "hum", route: "101", postmile: 84.2 })!;
  assert.equal(params.where, "County='HUM' AND Route=101 AND District=1 AND PM>=83.95 AND PM<=84.45");
  assert.equal(params.orderByFields, "PM ASC");
  assert.equal(roadQueryParams({ district: "", county: "HUM", route: "101", postmile: 1 }), null);
  assert.equal(roadQueryParams({ district: "01", county: " ", route: "101", postmile: 1 }), null);
});

test("post miles with a prefix or suffix still give their number", () => {
  assert.equal(numericPostmile("R12.3"), 12.3);
  assert.equal(numericPostmile("12.30L"), 12.3);
  assert.equal(numericPostmile("84"), 84);
  assert.equal(numericPostmile("twelve"), null);
});

test("labels and links", () => {
  assert.equal(roadLocationLabel({ district: "01", county: "HUM", route: "101", post_mile: "84.20" }), "D01 · HUM · 101 · PM 84.20");
  assert.equal(streetViewUrl(40.605, -124.134), "https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=40.605,-124.134");
});

test("a report is named by district, county, route, post mile and the day it was first seen", () => {
  const location = { district: "04", county: "MRN", route: "1", post_mile: "12.3" };
  assert.equal(incidentName(location, "2026-09-22T06:40"), "04-MRN-001-12.300 - 09/22/26");
  assert.equal(incidentName({ district: "4", county: "mrn", route: "SR-101", post_mile: "R2.1" }, ""), "04-MRN-101-R2.1");
  assert.equal(incidentName(null, "2026-09-22T06:40"), null);
});

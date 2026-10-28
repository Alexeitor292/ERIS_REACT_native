import assert from "node:assert/strict";
import test from "node:test";

import { changesOf, crackSummary, crackTitle, draftOf, locationText, shapeText, trendText, type Crack } from "./crackModel.ts";

const crack: Crack = {
  id: 7, submission_id: 501, client_uuid: "u", sort_order: 1, label: null,
  latitude: 37.7312, longitude: -122.1975, location_source: "PHOTO", geometry_json: null,
  trend_deg: 35, orientation: "TRANSVERSE", length_ft: 12.5, width_in: 0.75, horizontal_disp_in: null,
  vertical_disp_in: 2.25, depth_in: 6, notes: null, photo_attachment_id: 41, annotations_json: null, revision: 3,
};

test("each crack is named by its label, or by its place in the list", () => {
  assert.equal(crackTitle(crack, 1), "Crack 2");
  assert.equal(crackTitle({ label: " NB shoulder " }, 0), "NB shoulder");
});

test("the summary says what is known about the crack", () => {
  assert.equal(crackSummary(crack), "12.5 ft long · 0.75 in wide · 2.25 in vertical · 6 in deep · trends 035° (NE–SW) · transverse");
  assert.equal(crackSummary({ ...crack, length_ft: null, width_in: null, vertical_disp_in: null, depth_in: null, trend_deg: null, orientation: null }),
    "No measurements yet");
});

test("a crack line's direction reads both ways", () => {
  assert.equal(trendText(0), "000° (N–S)");
  assert.equal(trendText(90), "090° (E–W)");
  assert.equal(trendText(135), "135° (SE–NW)");
  assert.equal(trendText(200), "020° (NNE–SSW)");
  assert.equal(trendText(null), null);
});

test("only what changed is sent, and blanks clear", () => {
  const draft = draftOf(crack);
  assert.deepEqual(changesOf(crack, draft), { changes: {} });
  assert.deepEqual(changesOf(crack, { ...draft, depth_in: "8", width_in: "", label: " Toe " }),
    { changes: { label: "Toe", width_in: null, depth_in: 8 } });
});

test("a typed location is marked as entered, and both parts go together", () => {
  const draft = draftOf(crack);
  assert.deepEqual(changesOf(crack, { ...draft, latitude: "37.7320" }),
    { changes: { latitude: 37.732, longitude: -122.1975, location_source: "MANUAL" } });
  assert.deepEqual(changesOf(crack, { ...draft, latitude: "", longitude: "" }),
    { changes: { latitude: null, longitude: null, location_source: null } });
  assert.deepEqual(changesOf(crack, { ...draft, latitude: "" }), { error: "Enter both latitude and longitude, or neither." });
});

test("a value the server would refuse is named before saving", () => {
  const draft = draftOf(crack);
  assert.deepEqual(changesOf(crack, { ...draft, length_ft: "-2" }), { error: "Length must be a number from 0 to 100000." });
  assert.deepEqual(changesOf(crack, { ...draft, trend_deg: "360" }), { error: "Direction must be a number from 0 to less than 360." });
  assert.deepEqual(changesOf(crack, { ...draft, width_in: "wide" }), { error: "Width must be a number from 0 to 100000." });
});

test("a label follows the measure it names", () => {
  assert.equal(shapeText({ type: "label", at: [0.5, 0.5], measure: "length_ft" }, crack), "Length 12.5 ft");
  assert.equal(shapeText({ type: "label", at: [0.5, 0.5], measure: "horizontal_disp_in" }, crack), "Horizontal displacement —");
  assert.equal(shapeText({ type: "label", at: [0.5, 0.5], text: "Scarp", measure: "length_ft" }, crack), "Scarp");
  assert.equal(shapeText({ type: "path", points: [[0, 0], [1, 1]] }, crack), null);
});

test("the location says where it came from", () => {
  assert.equal(locationText(crack), "37.731200, -122.197500 (approximate, from its photo)");
  assert.equal(locationText({ latitude: null, longitude: null, location_source: null }), null);
});

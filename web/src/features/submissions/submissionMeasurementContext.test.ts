import assert from "node:assert/strict";
import test from "node:test";

import {
  bearingDisplayNote,
  bearingSourceLabel,
  elevationClassificationReasonNote,
  parseRoadBearingInput,
} from "./submissionMeasurementContextModel.ts";

test("road bearing parsing preserves the accepted 0 through under-360 range", () => {
  assert.equal(parseRoadBearingInput(""), null);
  assert.equal(parseRoadBearingInput("   "), null);
  assert.equal(parseRoadBearingInput("0"), 0);
  assert.equal(parseRoadBearingInput("359"), 359);
  assert.equal(parseRoadBearingInput("12.5"), 12.5);
  assert.equal(parseRoadBearingInput("-1"), null);
  assert.equal(parseRoadBearingInput("360"), null);
  assert.equal(parseRoadBearingInput("not-a-number"), null);
});

test("bearing source labels preserve the existing provenance wording", () => {
  assert.equal(bearingSourceLabel("arcgis_postmile_geometry"), "auto from postmile geometry");
  assert.equal(bearingSourceLabel("road_inventory_snapshot"), "road inventory snapshot");
  assert.equal(bearingSourceLabel("operator"), "operator");
  assert.equal(bearingSourceLabel(null), "request");
});

test("bearing display note reports unavailable classification context", () => {
  assert.equal(bearingDisplayNote(null, null), "not set — classification may be UNKNOWN");
  assert.equal(bearingDisplayNote(91.6, "road_inventory_snapshot"), "92° (road inventory snapshot)");
});

test("elevation reason notes preserve classification explanations", () => {
  assert.equal(
    elevationClassificationReasonNote("ROAD_BEARING_UNAVAILABLE"),
    "Road bearing could not be resolved, so only center elevation is available.",
  );
  assert.equal(
    elevationClassificationReasonNote("INSUFFICIENT_VALID_SAMPLES"),
    "Not enough valid USGS samples on both sides of the road to classify the terrain.",
  );
  assert.equal(
    elevationClassificationReasonNote("AMBIGUOUS_TERRAIN"),
    "Terrain is mixed/ambiguous: the sampled cross-section does not match a single shape.",
  );
  assert.equal(elevationClassificationReasonNote("CLASSIFIED"), undefined);
});

test("explicit metadata explanation remains authoritative", () => {
  assert.equal(
    elevationClassificationReasonNote("AMBIGUOUS_TERRAIN", "Provider-specific explanation"),
    "Provider-specific explanation",
  );
});

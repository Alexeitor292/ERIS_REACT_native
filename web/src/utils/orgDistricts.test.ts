import assert from "node:assert/strict";
import test from "node:test";

import { districtLabel, normalizeDistrictCode, parseDistrictList, placeLabel } from "./orgDistricts.ts";

test("a district is stored zero-padded, however an admin types it", () => {
  assert.equal(normalizeDistrictCode("4"), "04");
  assert.equal(normalizeDistrictCode("04"), "04");
  assert.equal(normalizeDistrictCode(" 4 "), "04");
  assert.equal(normalizeDistrictCode("D4"), "04");
  assert.equal(normalizeDistrictCode("d11"), "11");
  assert.equal(normalizeDistrictCode("11"), "11");
});

test("anything that is not a district number is refused, not guessed at", () => {
  for (const value of ["", "  ", "abc", "4a", "0", "00", "123", "-4", "4.5", null, undefined]) {
    assert.equal(normalizeDistrictCode(value), null, `${String(value)} should not be a district`);
  }
});

test("a district list is normalized, de-duplicated and sorted, and names what it refused", () => {
  assert.deepEqual(parseDistrictList("1, 4, 05"), { districts: ["01", "04", "05"], invalid: [] });
  // Separators an admin actually uses, and a repeat of the same district.
  assert.deepEqual(parseDistrictList("07 08;11  12"), { districts: ["07", "08", "11", "12"], invalid: [] });
  assert.deepEqual(parseDistrictList("4, 04, D4"), { districts: ["04"], invalid: [] });
  assert.deepEqual(parseDistrictList(""), { districts: [], invalid: [] });
  // The bad token is named so the form can say which one it refused.
  assert.deepEqual(parseDistrictList("04, north, 05"), { districts: ["04", "05"], invalid: ["north"] });
});

test("a district reads as D4 and a place degrades one part at a time", () => {
  assert.equal(districtLabel("04"), "D4");
  assert.equal(districtLabel("11"), "D11");
  assert.equal(districtLabel(""), null);
  assert.equal(districtLabel(null), null);
  assert.equal(placeLabel("Oakland", "04"), "Oakland D4");
  assert.equal(placeLabel("Sacramento", null), "Sacramento");
  assert.equal(placeLabel(null, "07"), "D7");
  assert.equal(placeLabel(null, null), null);
  assert.equal(placeLabel("  ", "  "), null);
});

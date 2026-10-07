import assert from "node:assert/strict";
import test from "node:test";

import { districtWords, normalize, scoreEntry, search, type SearchEntry } from "./searchModel.ts";

const person = (name: string, role: string): SearchEntry => ({
  key: `p-${name}`, kind: "person", label: name, description: role, link: "/organization",
  fields: [{ text: name, weight: 3 }, { text: role, weight: 1 }],
});

const entries: SearchEntry[] = [
  person("John (West Office Chief)", "Office Chief · Office of Geotechnical Design West"),
  person("Maria (West Branch A Chief)", "Branch Chief · Branch A"),
  person("Martin (District 5 Maintenance Coordinator)", "Maintenance Coordinator · District 5"),
  {
    key: "i-10", kind: "incident", label: "05-SB-166-28.000 - 10/01/26", description: "Incident #10", link: "/incidents/10",
    fields: [{ text: "05-SB-166-28.000 - 10/01/26", weight: 3 }, { text: "Roadway slip-out on SR-166 along the Cuyama River", weight: 1 }, { text: districtWords("05"), weight: 1 }],
  },
];

test("names, words in any order, a district however it is typed", () => {
  assert.equal(search(entries, "john")[0].label, "John (West Office Chief)");
  assert.equal(search(entries, "chief west")[0].label, "John (West Office Chief)");
  assert.equal(search(entries, "cuyama slip")[0].key, "i-10");
  assert.equal(search(entries, "district 5").length >= 2, true);
  assert.equal(search(entries, "d5")[0].key, "i-10");
  assert.equal(search(entries, "166 28")[0].key, "i-10");
});

test("a typo is forgiven; a word that matches nothing is not", () => {
  assert.equal(search(entries, "jonh")[0].label, "John (West Office Chief)");
  assert.equal(search(entries, "cuyamma")[0].key, "i-10");
  assert.equal(scoreEntry(entries[0], "john zebra"), null);
});

test("the name counts more than the description", () => {
  const titleHit = person("Coordinator Board", "x");
  const roleHit = person("Someone", "Coordinator");
  assert.equal(search([roleHit, titleHit], "coordinator")[0].label, "Coordinator Board");
  assert.equal(normalize("05-MON-001-8.900"), "05 mon 001 8.900");
});

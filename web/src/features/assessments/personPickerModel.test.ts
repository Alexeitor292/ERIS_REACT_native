import assert from "node:assert/strict";
import test from "node:test";

import type { PickerGroup } from "../../api/assessments.ts";
import {
  availabilityNote,
  branchLabelOf,
  buildPickerSections,
  districtLabel,
  flattenPickerOptions,
  formatAvailabilityDate,
  groupDisabledReason,
  initialPickerValue,
  isChoiceMade,
  isOutOfBranchChoice,
  moveHighlight,
  personPlaceNote,
  placeLabel,
  selectablePickerOptions,
  selectedPerson,
  typeaheadIndex,
  workloadNote,
  type PickerPerson,
} from "./personPickerModel.ts";

function person(overrides: Partial<PickerPerson> & { id: number; full_name: string; group_key: string }): PickerPerson {
  return {
    email: `${overrides.full_name.toLowerCase().replace(/\s+/g, ".")}@dot.ca.gov`,
    metadata: {},
    office_code: "WEST",
    office_name: "Office of Geotechnical Design West",
    branch_id: null,
    branch_letter: null,
    branch_name: null,
    home_city: null,
    home_district: null,
    open_assessment_count: 0,
    awaiting_action_count: 0,
    availability: "AVAILABLE",
    available_from: null,
    available_until: null,
    ...overrides,
  };
}

const BRANCH_C: PickerGroup = {
  group_key: "b:3",
  label: "Branch C",
  branch_id: 3,
  branch_letter: "C",
  branch_name: "Branch C",
  home_city: "Oakland",
  home_district: "04",
  districts_covered: [],
  accepts_assignments: true,
  is_active: true,
};

const BRANCH_E_UNSTAFFED: PickerGroup = {
  group_key: "b:5",
  label: "Branch E",
  branch_id: 5,
  branch_letter: "E",
  branch_name: "Branch E",
  home_city: "San Bernardino",
  home_district: "08",
  districts_covered: [],
  accepts_assignments: false,
  is_active: true,
};

test("a single candidate is still not chosen for you", () => {
  const groups = [BRANCH_C];
  const items = [person({ id: 41, full_name: "A. Rivera", group_key: "b:3", branch_id: 3, branch_name: "Branch C" })];
  const sections = buildPickerSections(groups, items);

  assert.equal(initialPickerValue(sections), null);
  assert.equal(isChoiceMade(initialPickerValue(sections)), false);
  assert.equal(selectedPerson(sections, initialPickerValue(sections)), null);
  // and the option is there to be chosen — it is the SELECTION that is empty.
  assert.equal(flattenPickerOptions(sections).length, 1);
  assert.equal(selectedPerson(sections, 41)?.full_name, "A. Rivera");
});

test("no data shape yields a value without an explicit choice", () => {
  const shapes: Array<[PickerGroup[], PickerPerson[]]> = [
    [[], []],
    [[BRANCH_C], []],
    [[BRANCH_C], [person({ id: 1, full_name: "Solo", group_key: "b:3" })]],
    [[BRANCH_C, BRANCH_E_UNSTAFFED], [person({ id: 1, full_name: "Solo", group_key: "b:5" })]],
    [[], [person({ id: 9, full_name: "Orphan", group_key: "b:99" })]],
  ];
  for (const [groups, items] of shapes) {
    const sections = buildPickerSections(groups, items);
    assert.equal(initialPickerValue(sections), null);
    assert.equal(isChoiceMade(initialPickerValue(sections)), false);
  }
});

test("a rotated-out person is rendered with their return date, never dropped", () => {
  const away = person({
    id: 7,
    full_name: "B. Nakamura",
    group_key: "b:3",
    branch_id: 3,
    branch_name: "Branch C",
    availability: "ROTATION_OUT",
    available_until: "2027-02-05",
  });
  const sections = buildPickerSections([BRANCH_C], [person({ id: 6, full_name: "A. Rivera", group_key: "b:3" }), away]);

  assert.deepEqual(flattenPickerOptions(sections).map((p) => p.id), [6, 7]);
  assert.deepEqual(selectablePickerOptions(sections).map((p) => p.id), [6, 7]);
  assert.equal(availabilityNote(away), "Rotation out — back 2/5/27");
  assert.equal(availabilityNote({ availability: "AVAILABLE", available_until: null }), null);
  assert.equal(availabilityNote({ availability: "ACTING_ELSEWHERE", available_until: null }), "Acting elsewhere");
  assert.equal(availabilityNote({ availability: "UNAVAILABLE", available_until: "2026-11-30" }), "Unavailable — back 11/30/26");
});

test("a date-only return date does not shift a day in a western time zone", () => {
  assert.equal(formatAvailabilityDate("2027-02-05"), "2/5/27");
  assert.equal(formatAvailabilityDate("2027-02-05T00:00:00"), "2/5/27");
  assert.equal(formatAvailabilityDate(null), null);
  assert.equal(formatAvailabilityDate(""), null);
});

test("an unstaffed branch is returned disabled with its reason, not omitted", () => {
  const sections = buildPickerSections(
    [BRANCH_C, BRANCH_E_UNSTAFFED],
    [person({ id: 1, full_name: "A. Rivera", group_key: "b:3" }), person({ id: 2, full_name: "C. Ferrand", group_key: "b:5" })],
  );
  assert.deepEqual(sections.map((section) => section.label), ["Branch C", "Branch E"]);
  assert.equal(sections[0].disabledReason, null);
  assert.equal(sections[1].disabledReason, "Branch E is not staffed yet");
  // Rendered, but not choosable.
  assert.deepEqual(flattenPickerOptions(sections).map((p) => p.id), [1, 2]);
  assert.deepEqual(selectablePickerOptions(sections).map((p) => p.id), [1]);
  assert.equal(groupDisabledReason({ ...BRANCH_C, is_active: false }), "Branch C has been retired");
});

test("groups keep the server's order and an empty branch still appears", () => {
  const sections = buildPickerSections([BRANCH_C, BRANCH_E_UNSTAFFED], []);
  assert.equal(sections.length, 2);
  assert.deepEqual(sections.map((section) => section.items.length), [0, 0]);
  assert.equal(sections[0].place, "Oakland D4");
});

test("a person whose group is missing lands in a trailing group rather than vanishing", () => {
  const orphan = person({ id: 88, full_name: "Z. Unknown", group_key: "b:404" });
  const sections = buildPickerSections([BRANCH_C], [person({ id: 1, full_name: "A. Rivera", group_key: "b:3" }), orphan]);
  assert.equal(sections.length, 2);
  assert.equal(sections[1].label, "Not in a listed group");
  assert.deepEqual(flattenPickerOptions(sections).map((p) => p.id), [1, 88]);
});

test("workload reads about a third party and never becomes an ordering", () => {
  assert.equal(workloadNote({ open_assessment_count: 4, awaiting_action_count: 2 }), "4 open · 2 waiting on them");
  assert.equal(workloadNote({ open_assessment_count: 4, awaiting_action_count: 0 }), "4 open");
  assert.equal(workloadNote({ open_assessment_count: 0, awaiting_action_count: 0 }), "No open assessments");

  // Order comes from the payload; the model never re-sorts by load.
  const busy = person({ id: 1, full_name: "A. Rivera", group_key: "b:3", open_assessment_count: 9 });
  const idle = person({ id: 2, full_name: "B. Nakamura", group_key: "b:3", open_assessment_count: 0 });
  const sections = buildPickerSections([BRANCH_C], [busy, idle]);
  assert.deepEqual(flattenPickerOptions(sections).map((p) => p.id), [1, 2]);
});

test("location and branch labels degrade one part at a time", () => {
  assert.equal(districtLabel("04"), "D4");
  assert.equal(districtLabel("11"), "D11");
  assert.equal(districtLabel(null), null);
  assert.equal(placeLabel("Oakland", "04"), "Oakland D4");
  assert.equal(placeLabel("Sacramento", null), "Sacramento");
  assert.equal(placeLabel(null, "07"), "D7");
  assert.equal(placeLabel(null, null), null);
  assert.equal(branchLabelOf({ branch_name: "Districts Branch A", branch_letter: "A" }), "Districts Branch A");
  assert.equal(branchLabelOf({ branch_name: null, branch_letter: "F" }), "Branch F");
  assert.equal(branchLabelOf({ branch_name: null, branch_letter: null }), null);
  assert.equal(
    personPlaceNote(person({ id: 1, full_name: "A", group_key: "b:3", branch_name: "Branch C", home_city: "Oakland", home_district: "04" })),
    "Branch C · Oakland D4",
  );
});

test("keyboard movement wraps and typeahead cycles repeated letters", () => {
  const options = [
    person({ id: 1, full_name: "Ada Kessler", group_key: "b:3" }),
    person({ id: 2, full_name: "Bo Nakamura", group_key: "b:3" }),
    person({ id: 3, full_name: "Ana Ferrand", group_key: "b:3" }),
  ];
  assert.equal(moveHighlight(options, -1, 1), 0);
  assert.equal(moveHighlight(options, -1, -1), 2);
  assert.equal(moveHighlight(options, 2, 1), 0);
  assert.equal(moveHighlight(options, 0, -1), 2);
  assert.equal(moveHighlight([], 0, 1), -1);

  assert.equal(typeaheadIndex(options, "a", -1), 0);
  assert.equal(typeaheadIndex(options, "a", 0), 2);
  assert.equal(typeaheadIndex(options, "a", 2), 0);
  assert.equal(typeaheadIndex(options, "bo", -1), 1);
  assert.equal(typeaheadIndex(options, "zz", -1), -1);
});

test("an out-of-branch Staff choice is recognised before the server refuses it", () => {
  const inBranch = person({ id: 1, full_name: "A. Rivera", group_key: "b:3", branch_id: 3 });
  const elsewhere = person({ id: 2, full_name: "B. Nakamura", group_key: "b:4", branch_id: 4 });
  const noBranch = person({ id: 3, full_name: "C. Ferrand", group_key: "UNASSIGNED", branch_id: null });
  assert.equal(isOutOfBranchChoice(inBranch, 3), false);
  assert.equal(isOutOfBranchChoice(elsewhere, 3), true);
  // Unknown on either side is not a warning: the server decides, and a guess here
  // would tell a chief they are doing something irregular when they are not.
  assert.equal(isOutOfBranchChoice(noBranch, 3), false);
  assert.equal(isOutOfBranchChoice(elsewhere, null), false);
  assert.equal(isOutOfBranchChoice(null, 3), false);
});

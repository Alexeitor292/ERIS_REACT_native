import { test } from "node:test";
import assert from "node:assert/strict";

import { flownOutOfOrder, surveyName, surveyTitle } from "./surveyLabels.ts";

const survey = (id: number, label: string | null, file: string | null, date: string | null) => ({ id, label, dsm_filename: file, captured_on: date });

test("a survey is named by its label, else its file, else its number", () => {
  assert.equal(surveyName(survey(1, "After the storm", "dsm.tif", null)), "After the storm");
  assert.equal(surveyName(survey(2, "  ", "MudCr_2017_05_27_DSM.tif", null)), "MudCr_2017_05_27_DSM.tif");
  assert.equal(surveyName(survey(3, null, null, null)), "Survey 3");
  assert.equal(surveyTitle(survey(4, "Before", null, "2017-05-19")), "Before, 2017-05-19");
  assert.equal(surveyTitle(survey(5, "Undated", null, null)), "Undated");
});

test("a later survey chosen as before is flagged; undated ones are not", () => {
  const may19 = survey(1, null, "a.tif", "2017-05-19");
  const may27 = survey(2, null, "b.tif", "2017-05-27");
  assert.equal(flownOutOfOrder(may19, may27), false);
  assert.equal(flownOutOfOrder(may27, may19), true);
  assert.equal(flownOutOfOrder(may27, survey(3, null, "c.tif", null)), false);
  assert.equal(flownOutOfOrder(may19, may19), false);
});

import assert from "node:assert/strict";
import test from "node:test";

import { figureRegistry, figureText, memoNumber, stripFigurePrefix } from "./memoFigureModel.ts";

test("each memo numbers its own figures; citations can reach any of them", () => {
  const registry = figureRegistry({
    observations_notes: '<p>x</p><figure data-figure="12" data-caption="Scarp &amp; road" data-width="100"></figure><figure data-figure="13" data-caption="Toe"></figure>',
    recommendations_notes: '<figure data-figure="20" data-caption="Buttress sketch"></figure>',
  });
  assert.equal(registry.get(12)?.label, "1.1");
  assert.equal(registry.get(12)?.caption, "Scarp & road");
  assert.equal(registry.get(13)?.label, "1.2");
  assert.equal(registry.get(20)?.label, "3.1");
  assert.equal(memoNumber("geotechnical_assessment_notes"), 2);
  assert.equal(figureText(null), "Figure ?");
});

test("Word's caption numbers come off on the way back", () => {
  assert.equal(stripFigurePrefix("Figure 1.2. Toe at the river"), "Toe at the river");
  assert.equal(stripFigurePrefix("Fig 3: Buttress"), "Buttress");
  assert.equal(stripFigurePrefix("Toe"), "Toe");
});

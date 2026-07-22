// Deterministic tests for the divided-corridor inspection geometry.
// Run: node --test src/arcgis/dividedCorridorInspection.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildDividedCorridorInspection,
  MEDIAN_SEPARATION_DETAIL,
  MEDIAN_SEPARATION_LABEL,
  OUTSIDE_MARGIN_M,
  provenanceSummary,
  RENDERING_MODE_OBSERVED_DIVIDED_CORRIDOR,
  UNAVAILABLE,
  type DividedCorridorInput,
} from "./dividedCorridorInspection.ts";
import type { LonLat } from "./corridorModel.ts";

const M = 111_320.0;
const LAT = 38.5;
const LON = -121.5;
const cos = Math.cos((LAT * Math.PI) / 180);
/** east-running line at a north offset (metres) */
const eastLine = (offsetM: number, len = 400, step = 50): LonLat[] => {
  const out: LonLat[] = [];
  for (let d = -len; d <= len; d += step) out.push([LON + d / (M * cos), LAT + offsetM / M]);
  return out;
};
const IDS = { memberSourceFeatureIds: ["rA", "rB"], memberPartFeatureIds: ["pA", "pB"] };

/** Members at -10 m and +10 m => 20 m separation, corridor on the centre line. */
const base = (): DividedCorridorInput => ({
  stationLon: LON,
  stationLat: LAT,
  corridor: eastLine(0),
  memberA: eastLine(-10),
  memberB: eastLine(10),
  packagedSeparation: { median: 20, mean: 20, samples: 40 },
  ...IDS,
});

const ok = (r: ReturnType<typeof buildDividedCorridorInspection>) => {
  assert.equal(r.ok, true, `expected success, got ${r.ok === false ? r.reason : ""}`);
  return r as Extract<typeof r, { ok: true }>;
};

// ---- 1. straight parallel members -------------------------------------------

test("straight parallel members: offsets straddle zero, ~20 m separation, perpendicular axis", () => {
  const m = ok(buildDividedCorridorInspection(base()));
  assert.ok(Math.abs(m.separationM - 20) < 0.5, `separation ${m.separationM}`);
  assert.ok(m.memberA.offsetM < 0 && m.memberB.offsetM > 0, "members straddle the station");
  assert.ok(Math.abs(m.memberA.offsetM + 10) < 0.5);
  assert.ok(Math.abs(m.memberB.offsetM - 10) < 0.5);
  // cross axis must be perpendicular to the axial tangent
  const d = m.axialTangent.x * m.crossAxis.x + m.axialTangent.y * m.crossAxis.y;
  assert.ok(Math.abs(d) < 1e-6, `axis not perpendicular (dot=${d})`);
  // east-running road => axial tangent points along x
  assert.ok(Math.abs(Math.abs(m.axialTangent.x) - 1) < 1e-6);
  assert.ok(Math.abs(m.separationAlongAxisM - 20) < 0.5);
});

// ---- 2/3. coordinate-order invariance ---------------------------------------

test("reversed member coordinate order gives the same projections, axis and offsets", () => {
  const a = ok(buildDividedCorridorInspection(base()));
  const b = ok(buildDividedCorridorInspection({
    ...base(), memberA: [...eastLine(-10)].reverse(), memberB: [...eastLine(10)].reverse(),
  }));
  assert.ok(Math.abs(a.memberA.offsetM - b.memberA.offsetM) < 1e-6);
  assert.ok(Math.abs(a.memberB.offsetM - b.memberB.offsetM) < 1e-6);
  assert.ok(Math.abs(a.separationM - b.separationM) < 1e-6);
  assert.ok(Math.abs(a.crossAxis.x - b.crossAxis.x) < 1e-6 && Math.abs(a.crossAxis.y - b.crossAxis.y) < 1e-6);
  assert.deepEqual(a.sectionStart.map((v) => v.toFixed(9)), b.sectionStart.map((v) => v.toFixed(9)));
  assert.deepEqual(a.sectionEnd.map((v) => v.toFixed(9)), b.sectionEnd.map((v) => v.toFixed(9)));
});

test("reversing only ONE member still works (axial alignment) and claims no direction", () => {
  const m = ok(buildDividedCorridorInspection({ ...base(), memberB: [...eastLine(10)].reverse() }));
  assert.ok(Math.abs(m.separationM - 20) < 0.5);
  assert.ok(m.memberA.offsetM < 0 && m.memberB.offsetM > 0);
  assert.ok(!m.unavailable.every((u) => u !== "Traffic direction"), "traffic direction is unavailable");
});

test("reversed midpoint corridor order keeps observed geometry stable", () => {
  const a = ok(buildDividedCorridorInspection(base()));
  const b = ok(buildDividedCorridorInspection({ ...base(), corridor: [...eastLine(0)].reverse() }));
  assert.ok(Math.abs(a.separationM - b.separationM) < 1e-6);
  assert.ok(Math.abs(a.memberA.offsetM - b.memberA.offsetM) < 1e-6);
});

// ---- 4. curved members -------------------------------------------------------

test("curved paired members use LOCAL member tangents and a stable axial average", () => {
  const curve = (offsetM: number): LonLat[] => {
    const out: LonLat[] = [];
    for (let d = -400; d <= 400; d += 25) {
      const bend = (d * d) / 8000; // gentle curve north
      out.push([LON + d / (M * cos), LAT + (offsetM + bend) / M]);
    }
    return out;
  };
  const m = ok(buildDividedCorridorInspection({
    ...base(), corridor: curve(0), memberA: curve(-11), memberB: curve(11),
  }));
  assert.ok(Math.abs(m.separationM - 22) < 1.5, `separation ${m.separationM}`);
  assert.ok(m.memberA.offsetM < 0 && m.memberB.offsetM > 0);
  const n = Math.hypot(m.axialTangent.x, m.axialTangent.y);
  assert.ok(Math.abs(n - 1) < 1e-6, "axial tangent is a unit vector");
});

// ---- 5-8. fail closed --------------------------------------------------------

test("missing member A or B fails closed", () => {
  assert.deepEqual(buildDividedCorridorInspection({ ...base(), memberA: [] }), { ok: false, reason: "missing_member_a_geometry" });
  assert.deepEqual(buildDividedCorridorInspection({ ...base(), memberB: [] }), { ok: false, reason: "missing_member_b_geometry" });
  assert.equal(buildDividedCorridorInspection({ ...base(), corridor: [] }).ok, false);
});

test("malformed member references fail closed", () => {
  assert.deepEqual(
    buildDividedCorridorInspection({ ...base(), memberSourceFeatureIds: ["rA"] }),
    { ok: false, reason: "unresolved_member_references" },
  );
  assert.deepEqual(
    buildDividedCorridorInspection({ ...base(), memberPartFeatureIds: [] }),
    { ok: false, reason: "unresolved_member_references" },
  );
});

test("members on the SAME side of the station fail closed (no straddle)", () => {
  const r = buildDividedCorridorInspection({ ...base(), memberA: eastLine(10), memberB: eastLine(30) });
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, "members_do_not_straddle_station");
});

test("gross separation mismatch vs the packaged stats fails closed with a truthful reason", () => {
  // Geometry says 20 m; the package claims 80 m -> tolerance max(5, 20) = 20 -> reject.
  const r = buildDividedCorridorInspection({ ...base(), packagedSeparation: { median: 80 } });
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, "separation_inconsistent_with_package");
  // Within tolerance is accepted.
  assert.equal(buildDividedCorridorInspection({ ...base(), packagedSeparation: { median: 22 } }).ok, true);
});

test("implausible separations fail closed", () => {
  const tooClose = buildDividedCorridorInspection({
    ...base(), memberA: eastLine(-0.4), memberB: eastLine(0.4), packagedSeparation: null,
  });
  assert.equal(tooClose.ok, false);
  const tooFar = buildDividedCorridorInspection({
    ...base(), memberA: eastLine(-150), memberB: eastLine(150), packagedSeparation: null,
  });
  assert.equal(tooFar.ok, false);
  assert.equal((tooFar as { reason: string }).reason, "implausible_separation");
});

test("an invalid station fails closed and never throws", () => {
  assert.equal(buildDividedCorridorInspection({ ...base(), stationLat: Number.NaN }).ok, false);
  assert.doesNotThrow(() => buildDividedCorridorInspection({ ...base(), memberA: [[1]] as unknown as LonLat[] }));
});

// ---- 9. section extent -------------------------------------------------------

test("the section contains both members plus bounded outside margins", () => {
  const m = ok(buildDividedCorridorInspection(base()));
  assert.ok(m.sectionMinOffsetM < m.memberA.offsetM, "section starts outside member A");
  assert.ok(m.sectionMaxOffsetM > m.memberB.offsetM, "section ends outside member B");
  assert.ok(Math.abs((m.memberA.offsetM - m.sectionMinOffsetM) - OUTSIDE_MARGIN_M) < 1e-6);
  assert.ok(Math.abs((m.sectionMaxOffsetM - m.memberB.offsetM) - OUTSIDE_MARGIN_M) < 1e-6);
  // ~ -30 .. +30 for a 20 m separation with 20 m margins
  assert.ok(Math.abs(m.sectionMinOffsetM + 30) < 0.5 && Math.abs(m.sectionMaxOffsetM - 30) < 0.5);
  assert.equal(m.sectionStart.length, 2);
  assert.equal(m.sectionEnd.length, 2);
});

// ---- 11. rendering semantics --------------------------------------------------

test("rendering semantics forbid the schematic + DEFAULT two-way template", () => {
  const m = ok(buildDividedCorridorInspection(base()));
  assert.equal(m.rendering.rendering_mode, RENDERING_MODE_OBSERVED_DIVIDED_CORRIDOR);
  assert.equal(m.rendering.schematic_roadway_allowed, false);
  assert.equal(m.rendering.default_two_way_template_allowed, false);
});

test("observed vs unavailable provenance is explicit and truthful", () => {
  const m = ok(buildDividedCorridorInspection(base()));
  for (const o of ["Two packaged source carriageway centerlines", "Measured centerline-to-centerline separation"]) {
    assert.ok(m.observed.includes(o), `observed must include ${o}`);
  }
  for (const u of ["Pavement edges", "Lane count", "Median category", "Physical median width", "Traffic direction"]) {
    assert.ok(m.unavailable.includes(u), `unavailable must include ${u}`);
  }
  // Nothing may appear in both lists.
  assert.equal(m.observed.filter((o) => m.unavailable.includes(o)).length, 0);
});

// ---- 13/14. wording -----------------------------------------------------------

test("the interval label is exact and qualified centerline-to-centerline", () => {
  assert.equal(MEDIAN_SEPARATION_LABEL, "Median / separation area");
  assert.match(MEDIAN_SEPARATION_DETAIL, /between observed carriageway centerlines/i);
  assert.match(MEDIAN_SEPARATION_DETAIL, /Pavement edges and physical median width are unavailable/i);
  // never described as the physical median width
  assert.doesNotMatch(MEDIAN_SEPARATION_DETAIL, /physical median width is\b/i);
  assert.ok(UNAVAILABLE.includes("Physical median width"));
});

test("provenance summary is compact and states measured separation", () => {
  const m = ok(buildDividedCorridorInspection(base()));
  const s = provenanceSummary(m, "NAIP", 0.6);
  assert.match(s, /Observed divided corridor/);
  assert.match(s, /20\.0 m centerline separation/);
  assert.match(s, /NAIP/);
  assert.match(s, /0\.60 m\/px/);
  assert.ok(s.split("\n").length <= 2, "must stay compact");
});

// ---- 15. one immutable model shared by both modes -------------------------------

test("one model instance carries the station, axis, offsets and section for BOTH modes", () => {
  const m = ok(buildDividedCorridorInspection(base()));
  // Simulate the two children consuming the SAME object — neither may reproject.
  const immersive = m;
  const technical = m;
  assert.equal(immersive.stationLon, technical.stationLon);
  assert.equal(immersive.stationLat, technical.stationLat);
  assert.deepEqual(immersive.crossAxis, technical.crossAxis);
  assert.equal(immersive.memberA.offsetM, technical.memberA.offsetM);
  assert.equal(immersive.memberB.offsetM, technical.memberB.offsetM);
  assert.deepEqual(immersive.sectionStart, technical.sectionStart);
  assert.deepEqual(immersive.sectionEnd, technical.sectionEnd);
  // Rebuilding from the same input is deterministic (no hidden state).
  const again = ok(buildDividedCorridorInspection(base()));
  assert.deepEqual(again.sectionStart, m.sectionStart);
  assert.deepEqual(again.crossAxis, m.crossAxis);
});

// Each station component must be validated INDEPENDENTLY. The native mirror originally
// guarded snapLon's read on snapLat's type, so a malformed snapLon (NSNull) raised an
// unrecognized selector instead of failing closed. Both directions are pinned here.
test("a malformed station component fails closed with invalid_station, either side", () => {
  const bad: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null, undefined, "abc", {}];
  for (const v of bad) {
    const lonBad = buildDividedCorridorInspection({ ...base(), stationLon: v as number });
    assert.equal(lonBad.ok, false, `stationLon=${String(v)} must not build a model`);
    if (!lonBad.ok) assert.equal(lonBad.reason, "invalid_station");

    const latBad = buildDividedCorridorInspection({ ...base(), stationLat: v as number });
    assert.equal(latBad.ok, false, `stationLat=${String(v)} must not build a model`);
    if (!latBad.ok) assert.equal(latBad.reason, "invalid_station");
  }
  // A valid station still builds — the guard rejects malformed input, not all input.
  assert.equal(buildDividedCorridorInspection(base()).ok, true);
});

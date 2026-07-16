import { strict as assert } from "node:assert";
import { test } from "node:test";

import { buildDividedCorridorInspection } from "./dividedCorridorInspection.ts";
import {
  bearingOf,
  MAX_SECTION_SAMPLES,
  offsetFtOf,
  offsetToLonLat,
  planDividedSection,
  requiredAnchorOffsets,
  SECTION_SAMPLE_SPACING_M,
  sideForOffset,
  type SectionInput,
} from "./dividedSectionSampling.ts";

// A north-south corridor at a round station: crossAxis points east (member A west of the
// midpoint, member B east of it), so offsets map cleanly onto longitude.
const STATION = { lon: -121.5, lat: 38.5 };
const EAST = { x: 1, y: 0 };
const HUGE_GRID = { minLon: -122, minLat: 38, maxLon: -121, maxLat: 39 };

function input(over: Partial<SectionInput> = {}): SectionInput {
  return {
    station: STATION,
    crossAxis: EAST,
    sectionMinOffsetM: -30,
    sectionMaxOffsetM: 30,
    memberAOffsetM: -10,
    memberBOffsetM: 10,
    grid: HUGE_GRID,
    ...over,
  };
}

const ok = (p: ReturnType<typeof planDividedSection>) => {
  assert.equal(p.ok, true, `expected a plan, got ${p.ok === false ? p.reason : "?"}`);
  return p as Extract<typeof p, { ok: true }>;
};

// --- the reviewer's span proofs, driven by the REAL inspection model ------------------

// Build a real divided-corridor model with a given separation, so the span assertions are
// end-to-end from geometry, not from hand-fed section bounds.
function modelWithSeparation(sepM: number) {
  const dLon = (m: number) => m / (111_320.0 * Math.cos((STATION.lat * Math.PI) / 180));
  const half = sepM / 2;
  const line = (offsetM: number) => [
    [STATION.lon + dLon(offsetM), STATION.lat - 0.01],
    [STATION.lon + dLon(offsetM), STATION.lat + 0.01],
  ] as [number, number][];
  return buildDividedCorridorInspection({
    stationLon: STATION.lon,
    stationLat: STATION.lat,
    corridor: line(0),
    memberA: line(-half),
    memberB: line(half),
    memberSourceFeatureIds: ["rA", "rB"],
    memberPartFeatureIds: ["pA", "pB"],
  });
}

test("a 20 m separation requests roughly a 60 m section (separation + 2x20 m margins)", () => {
  const m = modelWithSeparation(20);
  assert.equal(m.ok, true);
  if (!m.ok) return;
  const span = m.sectionMaxOffsetM - m.sectionMinOffsetM;
  assert.ok(Math.abs(span - 60) < 0.5, `expected ~60 m, got ${span}`);

  const p = ok(planDividedSection(input({ sectionMinOffsetM: m.sectionMinOffsetM, sectionMaxOffsetM: m.sectionMaxOffsetM })));
  assert.ok(Math.abs(p.requestedSpanM - 60) < 0.5);
});

test("a 45 m stable median requests roughly an 85 m section", () => {
  const m = modelWithSeparation(45);
  assert.equal(m.ok, true);
  if (!m.ok) return;
  const span = m.sectionMaxOffsetM - m.sectionMinOffsetM;
  assert.ok(Math.abs(span - 85) < 0.5, `expected ~85 m, got ${span}`);
});

test("the DEFAULT ~40 m template slice cannot describe a divided section", () => {
  // The old path sampled DEFAULT shoulder edges +/-50 ft: for the 32 ft template that is
  // -66..+66 ft = ~40.2 m, regardless of the observed separation. Every real corridor
  // section must differ from it, or the terrain profile is the template's, not the road's.
  const DEFAULT_SPAN_M = (66 + 66) / 3.280839895;
  assert.ok(Math.abs(DEFAULT_SPAN_M - 40) < 0.5, `sanity: default span ~40 m, got ${DEFAULT_SPAN_M}`);
  for (const sep of [20, 45, 60]) {
    const m = modelWithSeparation(sep);
    assert.equal(m.ok, true);
    if (!m.ok) continue;
    const span = m.sectionMaxOffsetM - m.sectionMinOffsetM;
    assert.ok(Math.abs(span - DEFAULT_SPAN_M) > 5, `separation ${sep} m must not reduce to the DEFAULT ~40 m slice`);
  }
});

// --- section contract -----------------------------------------------------------------

test("the plan uses the model's section bounds as its sole extent", () => {
  const p = ok(planDividedSection(input({ sectionMinOffsetM: -42.5, sectionMaxOffsetM: 42.5 })));
  assert.equal(p.startOffsetM, -42.5);
  assert.equal(p.endOffsetM, 42.5);
  assert.equal(p.requestedSpanM, 85);
  assert.equal(p.truncated, false);
});

test("the section direction follows crossAxis, not a road bearing", () => {
  const east = ok(planDividedSection(input({ crossAxis: { x: 1, y: 0 } })));
  assert.ok(Math.abs(east.crossBearingDeg - 90) < 1e-6);
  // A due-east axis moves longitude only.
  assert.ok(Math.abs(east.end[1] - STATION.lat) < 1e-9);
  assert.ok(east.end[0] > STATION.lon);

  const north = ok(planDividedSection(input({ crossAxis: { x: 0, y: 1 } })));
  assert.ok(Math.abs(north.crossBearingDeg) < 1e-6);
  assert.ok(Math.abs(north.end[0] - STATION.lon) < 1e-9);
  assert.ok(north.end[1] > STATION.lat);

  // A diagonal axis must move both, and bearing must round-trip.
  const diag = ok(planDividedSection(input({ crossAxis: { x: Math.SQRT1_2, y: Math.SQRT1_2 } })));
  assert.ok(Math.abs(diag.crossBearingDeg - 45) < 1e-6);
  assert.ok(diag.end[0] > STATION.lon && diag.end[1] > STATION.lat);
});

test("sample offsets cover both members, the midpoint, and both outside margins", () => {
  const p = ok(planDividedSection(input()));
  const has = (o: number) => p.offsetsM.some((x) => Math.abs(x - o) < 1e-6);
  assert.ok(has(-10), "member A offset must be sampled explicitly");
  assert.ok(has(10), "member B offset must be sampled explicitly");
  assert.ok(has(0), "the midpoint station must be sampled explicitly");
  assert.ok(has(-30), "the clipped section start must be sampled");
  assert.ok(has(30), "the clipped section end must be sampled");
  // The margins beyond each member are real coverage, not just endpoints.
  assert.ok(p.offsetsM.some((x) => x < -10.5), "must sample outside member A");
  assert.ok(p.offsetsM.some((x) => x > 10.5), "must sample outside member B");
});

test("offsets are sorted, deduped, and never leave the clipped span", () => {
  const p = ok(planDividedSection(input()));
  for (let i = 1; i < p.offsetsM.length; i++) {
    assert.ok(p.offsetsM[i] > p.offsetsM[i - 1], "offsets must be strictly increasing (sorted + deduped)");
  }
  for (const o of p.offsetsM) {
    assert.ok(o >= p.startOffsetM - 1e-9 && o <= p.endOffsetM + 1e-9, `offset ${o} escaped the clipped span`);
  }
  assert.equal(p.offsetsM[0], p.startOffsetM);
  assert.equal(p.offsetsM[p.offsetsM.length - 1], p.endOffsetM);
});

test("spacing is dense enough for a continuous profile and bounded", () => {
  const p = ok(planDividedSection(input()));
  let maxGap = 0;
  for (let i = 1; i < p.offsetsM.length; i++) maxGap = Math.max(maxGap, p.offsetsM[i] - p.offsetsM[i - 1]);
  assert.ok(maxGap <= SECTION_SAMPLE_SPACING_M + 1e-6, `max gap ${maxGap} exceeds target spacing`);
  assert.ok(p.offsetsM.length <= MAX_SECTION_SAMPLES);

  // Even the widest plausible corridor stays bounded.
  const wide = ok(planDividedSection(input({ sectionMinOffsetM: -120, sectionMaxOffsetM: 120, memberAOffsetM: -100, memberBOffsetM: 100 })));
  assert.ok(wide.offsetsM.length <= MAX_SECTION_SAMPLES, `wide section produced ${wide.offsetsM.length} samples`);
});

// --- clipping / truncation ------------------------------------------------------------

test("a section crossing the package edge is clipped, marked truncated, and never extends past it", () => {
  // Grid ends 12 m east of the station.
  const eastEdgeM = 12;
  const cosLat = Math.cos((STATION.lat * Math.PI) / 180);
  const grid = { ...HUGE_GRID, maxLon: STATION.lon + eastEdgeM / (111_320.0 * cosLat) };
  const p = ok(planDividedSection(input({ grid })));

  assert.equal(p.truncated, true, "a cut section must report truncation");
  assert.ok(Math.abs(p.endOffsetM - eastEdgeM) < 0.01, `clipped end should sit at the edge, got ${p.endOffsetM}`);
  assert.equal(p.startOffsetM, -30, "the un-cut side must keep the requested extent");
  assert.ok(p.clippedSpanM < p.requestedSpanM);
  for (const o of p.offsetsM) assert.ok(o <= eastEdgeM + 1e-6, `sample at ${o} lies outside the package`);
  assert.ok(p.end[0] <= grid.maxLon + 1e-12, "the clipped endpoint must be inside the grid");
});

test("truncation that cuts past a member drops it from the required anchors (no invention)", () => {
  const cosLat = Math.cos((STATION.lat * Math.PI) / 180);
  // Grid ends 5 m east: member B (+10 m) is outside the package entirely.
  const grid = { ...HUGE_GRID, maxLon: STATION.lon + 5 / (111_320.0 * cosLat) };
  const p = ok(planDividedSection(input({ grid })));
  const required = requiredAnchorOffsets(p, -10, 10);
  assert.deepEqual(required, [-10], "member B has no packaged ground: it must not be a required sample");
  assert.ok(!p.offsetsM.some((o) => o > 5 + 1e-6), "nothing may be sampled beyond the package");
});

test("a section entirely outside the package fails closed", () => {
  const p = planDividedSection(input({ grid: { minLon: 10, minLat: 10, maxLon: 11, maxLat: 11 } }));
  assert.equal(p.ok, false);
  if (!p.ok) assert.equal(p.reason, "section_outside_package");
});

// --- fail-closed validation -----------------------------------------------------------

test("malformed input fails closed rather than guessing a section", () => {
  const bad: Array<[Partial<SectionInput>, string]> = [
    [{ station: { lon: Number.NaN, lat: 38.5 } }, "invalid_station"],
    [{ station: { lon: -121.5, lat: Number.POSITIVE_INFINITY } }, "invalid_station"],
    [{ crossAxis: { x: Number.NaN, y: 0 } }, "invalid_cross_axis"],
    [{ crossAxis: { x: 0, y: 0 } }, "invalid_cross_axis"],
    [{ crossAxis: { x: 5, y: 5 } }, "invalid_cross_axis"], // not a unit axis
    [{ sectionMinOffsetM: 30, sectionMaxOffsetM: -30 }, "invalid_section_extent"],
    [{ sectionMinOffsetM: Number.NaN }, "invalid_section_extent"],
    [{ memberAOffsetM: -999 }, "member_offset_outside_section"],
  ];
  for (const [over, reason] of bad) {
    const p = planDividedSection(input(over));
    assert.equal(p.ok, false, `${reason}: expected failure`);
    if (!p.ok) assert.equal(p.reason, reason);
  }
});

// --- unit helpers ---------------------------------------------------------------------

test("offsetToLonLat round-trips through the section bearing", () => {
  const p = offsetToLonLat(STATION, EAST, 100);
  const backM = (p[0] - STATION.lon) * 111_320.0 * Math.cos((STATION.lat * Math.PI) / 180);
  assert.ok(Math.abs(backM - 100) < 1e-6);
  assert.ok(Math.abs(p[1] - STATION.lat) < 1e-12);
});

test("bearingOf maps the local frame to compass degrees", () => {
  assert.ok(Math.abs(bearingOf({ x: 0, y: 1 })) < 1e-9);
  assert.ok(Math.abs(bearingOf({ x: 1, y: 0 }) - 90) < 1e-9);
  assert.ok(Math.abs(bearingOf({ x: 0, y: -1 }) - 180) < 1e-9);
  assert.ok(Math.abs(bearingOf({ x: -1, y: 0 }) - 270) < 1e-9);
});

test("offset sides and feet conversion match the technical renderer's expectations", () => {
  assert.equal(sideForOffset(-10), "LT");
  assert.equal(sideForOffset(10), "RT");
  assert.equal(sideForOffset(0), "CENTER");
  assert.ok(Math.abs(offsetFtOf(10) - 32.80839895) < 1e-6);
  assert.ok(Math.abs(offsetFtOf(-10) + 32.80839895) < 1e-6);
});

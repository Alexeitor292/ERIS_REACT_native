#!/usr/bin/env node
// Structural source-contract guard for the NATIVE divided-corridor inspection (Part 12).
//
// The pure model (src/arcgis/dividedCorridorInspection.ts) is unit-tested; the Objective-C
// mirror cannot be, so this script pins the parts that would otherwise drift silently. It
// is deliberately NOT a string-presence check: it extracts Objective-C method BODIES by
// brace matching and asserts on what each body does and does not do, and it reads the
// TypeScript model's own constants/fail-reasons so the two cannot diverge.
//
// Pinned invariants:
//   A. the inspection model is built EXACTLY ONCE, in the terrain controller, before the
//      inspection is presented, and a nil model fails closed (no fabricated schematic);
//      the same instance is threaded to the container and to BOTH children;
//   C. the divided technical path NEVER touches the roadway template (no shoulderEdgeFt /
//      deckSpans / buildDeckInto / buildLaneMarkingsInto, no DEFAULT lanes/widths/median);
//   D. the immersive scene draws BOTH observed member centerlines + station markers + the
//      measured separation annotation;
//   E. the inspection container has NO second acknowledgment, and carries a compact
//      expandable provenance control instead;
//   F. both children release SceneKit/image resources deterministically and idempotently.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OBJC = (name) => join(HERE, "..", "plugins", "arcgis-ios", name);
const TS = (name) => join(HERE, "..", "src", "arcgis", name);

const errors = [];
const fail = (tag, msg) => errors.push(`[${tag}] ${msg}`);

function stripComments(src) {
  return src
    .replace(/\r\n?/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/**
 * Extract the body of an Objective-C method by brace matching from its definition. Returns
 * null when the method is absent. `selector` is the definition prefix, e.g.
 * "- (void)buildScene" or "- (NSDictionary *)buildDividedCorridorInspectionForCandidate:".
 */
function methodBody(code, selector) {
  const at = code.indexOf(selector);
  if (at < 0) return null;
  const open = code.indexOf("{", at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return null;
}

const countOf = (code, re) => (code.match(re) || []).length;

const load = (p) => stripComments(readFileSync(p, "utf8"));
const terrain = load(OBJC("ErisTerrainSceneViewController.m"));
const container = load(OBJC("ErisInspectionViewController.m"));
const immersive = load(OBJC("ErisImmersiveCorridorViewController.m"));
const slice = load(OBJC("ErisRoadSliceSceneViewController.m"));
const tsModel = readFileSync(TS("dividedCorridorInspection.ts"), "utf8");

// ---- Parity: the Obj-C mirror must carry the TS model's constants + fail reasons ------
{
  const tag = "parity";
  // Numeric thresholds: TS name -> Obj-C constant name.
  const NUMERIC = [
    ["OUTSIDE_MARGIN_M", "kErisOutsideMarginM"],
    ["STRADDLE_TOLERANCE_M", "kErisStraddleToleranceM"],
    ["SEPARATION_TOLERANCE_ABS_M", "kErisSepTolAbsM"],
    ["SEPARATION_TOLERANCE_FRAC", "kErisSepTolFrac"],
    ["MIN_PLAUSIBLE_SEPARATION_M", "kErisMinPlausibleSepM"],
    ["MAX_PLAUSIBLE_SEPARATION_M", "kErisMaxPlausibleSepM"],
  ];
  for (const [tsName, objcName] of NUMERIC) {
    const tsMatch = tsModel.match(new RegExp(`export const ${tsName}\\s*=\\s*([-\\d.]+)`));
    if (!tsMatch) {
      fail(tag, `the TS model no longer exports ${tsName}; the native mirror cannot be checked.`);
      continue;
    }
    const objcMatch = terrain.match(new RegExp(`${objcName}\\s*=\\s*([-\\d.]+)`));
    if (!objcMatch) {
      fail(tag, `ErisTerrainSceneViewController.m must define ${objcName} mirroring ${tsName}.`);
      continue;
    }
    if (Number(tsMatch[1]) !== Number(objcMatch[1])) {
      fail(tag, `${objcName} (${objcMatch[1]}) must equal ${tsName} (${tsMatch[1]}).`);
    }
  }

  // Every fail reason the TS model can return must exist in the native mirror, so a native
  // rejection is explainable in the same vocabulary as the tested model.
  const tsReasons = [...tsModel.matchAll(/reason:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  if (tsReasons.length < 10) fail(tag, `expected the TS model to define its fail reasons; found ${tsReasons.length}.`);
  for (const reason of new Set(tsReasons)) {
    if (!terrain.includes(`@"${reason}"`)) {
      fail(tag, `native mirror must be able to report the TS fail reason "${reason}".`);
    }
  }

  // Shared user-facing strings must be identical, not paraphrased.
  const STRINGS = ["MEDIAN_SEPARATION_LABEL", "MEMBER_A_LABEL", "MEMBER_B_LABEL", "RENDERING_MODE_OBSERVED_DIVIDED_CORRIDOR"];
  for (const name of STRINGS) {
    const m = tsModel.match(new RegExp(`export const ${name}\\s*=\\s*"([^"]+)"`));
    if (!m) { fail(tag, `the TS model no longer exports ${name}.`); continue; }
    if (!terrain.includes(`@"${m[1]}"`)) fail(tag, `native mirror must use the exact ${name} text "${m[1]}".`);
  }
}

// ---- A: built exactly once, before presentation, fail-closed, threaded through --------
{
  const tag = "model-once";
  const build = methodBody(terrain, "- (NSDictionary *)buildDividedCorridorInspectionForCandidate:");
  if (!build) fail(tag, "ErisTerrainSceneViewController must implement buildDividedCorridorInspectionForCandidate:reason:.");

  // Exactly one CALL SITE: the model is built once per inspection, never re-derived.
  const callSites = countOf(terrain, /\[self buildDividedCorridorInspectionForCandidate:/g);
  if (callSites !== 1) fail(tag, `the inspection model must be built exactly once; found ${callSites} call sites.`);

  const inspect = methodBody(terrain, "- (void)inspectCandidate:");
  if (!inspect) {
    fail(tag, "ErisTerrainSceneViewController must implement inspectCandidate:selLat:selLon:.");
  } else {
    if (!/\[self buildDividedCorridorInspectionForCandidate:/.test(inspect)) {
      fail(tag, "inspectCandidate: must build the divided-corridor model before presenting the inspection.");
    }
    // Fail closed: a nil model must abort with a return, never fall through to presentation.
    if (!/inspectionGeometry\s*==\s*nil\s*\)\s*\{[\s\S]{0,600}?return;/.test(inspect)) {
      fail(tag, "inspectCandidate: must fail closed (return) when the divided-corridor model cannot be built.");
    }
    const buildAt = inspect.indexOf("buildDividedCorridorInspectionForCandidate:");
    const presentAt = inspect.indexOf("ErisInspectionViewController alloc");
    if (buildAt >= 0 && presentAt >= 0 && buildAt > presentAt) {
      fail(tag, "the inspection model must be built BEFORE the inspection controller is presented.");
    }
    if (!/initWithSlice:slice[\s\S]{0,200}inspectionGeometry:inspectionGeometry/.test(inspect)) {
      fail(tag, "the built model must be passed to ErisInspectionViewController.");
    }
    // buildCorridorModelAtLat: reads slice[@"inspectionGeometry"] to clip the member
    // centerlines. If the corridor were built first the members would silently vanish
    // from the immersive scene — a missing-evidence bug with no error surface.
    const storeAt = inspect.indexOf('slice[@"inspectionGeometry"] = inspectionGeometry');
    const corridorAt = inspect.indexOf("buildCorridorModelAtLat:");
    if (storeAt < 0) fail(tag, "inspectCandidate: must store the model on the slice for the corridor build.");
    else if (corridorAt >= 0 && storeAt > corridorAt) {
      fail(tag, "the model must be stored on the slice BEFORE buildCorridorModelAtLat: (it clips the member centerlines).");
    }
    // No fabricated divided roadway when the model is unavailable.
    if (/defaultTwoWayTemplateAllowed"\]\s*=\s*@YES/.test(inspect) || /schematicRoadwayAllowed"\]\s*=\s*@YES/.test(inspect)) {
      fail(tag, "a divided corridor must never enable the default two-way template or a schematic roadway.");
    }
  }

  // The container threads the SAME instance to both children — no copy, no rebuild.
  const containerLoad = methodBody(container, "- (void)viewDidLoad");
  if (!containerLoad) {
    fail(tag, "ErisInspectionViewController must implement viewDidLoad.");
  } else {
    const passes = countOf(containerLoad, /inspectionGeometry:self\.inspectionGeometry/g);
    if (passes !== 2) {
      fail(tag, `both children must receive self.inspectionGeometry (found ${passes} of 2 hand-offs).`);
    }
  }
  if (/buildDividedCorridorInspection/.test(container) && !/inspectionGeometry:self\.inspectionGeometry/.test(container)) {
    fail(tag, "the container must consume the shared model, never build its own.");
  }
  for (const [name, code] of [["immersive", immersive], ["technical", slice]]) {
    if (/buildDividedCorridorInspectionForCandidate/.test(code)) {
      fail(tag, `the ${name} child must not build its own inspection model.`);
    }
  }
}

// ---- L: station validation is per-component and fails closed (Part 13) ----------------
{
  const tag = "snap-validation";
  const build = methodBody(terrain, "- (NSDictionary *)buildDividedCorridorInspectionForCandidate:") || "";
  // The original guarded snapLon's read on snapLat's type, so an NSNull snapLon raised
  // unrecognized selector instead of failing closed.
  if (/snapLat"\]\s*respondsToSelector[\s\S]{0,40}\[cand\[@"snapLon"\]\s*doubleValue\]/.test(build)) {
    fail(tag, "snapLon must not be validated via snapLat's type — that crashes on a malformed value.");
  }
  if (!/rawLon\s*=\s*cand\[@"snapLon"\]/.test(build) || !/rawLat\s*=\s*cand\[@"snapLat"\]/.test(build)) {
    fail(tag, "each station component must be captured from its own key.");
  }
  if (!/\[rawLon isKindOfClass:\[NSNumber class\]\]/.test(build) || !/\[rawLat isKindOfClass:\[NSNumber class\]\]/.test(build)) {
    // NSString also answers -doubleValue, so a garbage string would become a valid 0.0.
    fail(tag, "each station component must be validated as an NSNumber independently.");
  }
  if (!/if\s*\(!isfinite\(lon0\)\s*\|\|\s*!isfinite\(lat0\)\)\s*ERIS_DC_FAIL\(@"invalid_station"\)/.test(build)) {
    fail(tag, "a malformed station must fail closed with invalid_station.");
  }
}

// ---- C: the divided technical path is template-free -----------------------------------
{
  const tag = "divided-technical";
  const TEMPLATE = /shoulderEdgeFt|deckSpans|buildDeckInto|buildLaneMarkingsInto/;

  if (!/- \(BOOL\)isObservedDividedCorridor/.test(slice)) {
    fail(tag, "ErisRoadSliceSceneViewController must gate the divided path on isObservedDividedCorridor.");
  }
  const dividedScene = methodBody(slice, "- (void)buildObservedDividedCorridorScene");
  if (!dividedScene) {
    fail(tag, "ErisRoadSliceSceneViewController must implement buildObservedDividedCorridorScene.");
  }

  // Every method reachable ONLY from the divided path must be template-free.
  const DIVIDED_METHODS = [
    "- (void)buildObservedDividedCorridorScene",
    "- (void)buildDividedGroundInto:",
    "- (NSArray<NSArray<NSValue *> *> *)dividedGroundRunsFt",
    "- (void)buildDividedGroundRun:",
    "- (double)dividedGroundElevAtFt:",
    "- (double)dividedExactGroundElevAtFt:",
    "- (void)addDividedMarkerInto:",
    "- (void)addSeparationDimensionInto:",
    "- (NSString *)dividedTechnicalText",
    "- (NSString *)dividedLegendText",
    "- (double)stationElevationFt:",
  ];
  for (const sel of DIVIDED_METHODS) {
    const body = methodBody(slice, sel);
    if (body == null) { fail(tag, `the divided path must implement ${sel.trim()}.`); continue; }
    if (TEMPLATE.test(body)) {
      fail(tag, `${sel.trim()} must not touch the roadway template (shoulderEdgeFt/deckSpans/buildDeckInto/buildLaneMarkingsInto).`);
    }
    // No DEFAULT lane counts, 12 ft lane widths, 32 ft totals or median assumptions.
    if (/lt_lane_count|rt_lane_count|lane_width_ft|median_width_ft|median_category|total_width_ft/.test(body)) {
      fail(tag, `${sel.trim()} must not consume DEFAULT roadway-template fields.`);
    }
    if (/\b12\b\s*\)|32\s*ft/.test(body)) {
      fail(tag, `${sel.trim()} must not embed default 12-ft lane / 32-ft total assumptions.`);
    }
  }

  // buildScene must branch to the divided path BEFORE computing any template geometry.
  const buildScene = methodBody(slice, "- (void)buildScene");
  if (!buildScene) {
    fail(tag, "ErisRoadSliceSceneViewController must implement buildScene.");
  } else {
    const branchAt = buildScene.indexOf("buildObservedDividedCorridorScene");
    const templateAt = buildScene.search(TEMPLATE);
    if (branchAt < 0) fail(tag, "buildScene must branch to buildObservedDividedCorridorScene.");
    else if (templateAt >= 0 && branchAt > templateAt) {
      fail(tag, "buildScene must take the divided branch before any roadway-template geometry is computed.");
    }
    if (!/return;/.test(buildScene.slice(0, branchAt >= 0 ? branchAt + 120 : 0))) {
      fail(tag, "the divided branch in buildScene must return without falling through to the deck path.");
    }
  }

  // The technical text must not present template values for a divided corridor.
  const techText = methodBody(slice, "- (NSString *)technicalText");
  if (!techText || !/isObservedDividedCorridor/.test(techText)) {
    fail(tag, "technicalText must branch to the divided text for an observed divided corridor.");
  }

  // The separation must be named and qualified, never called a median width.
  const dividedTech = methodBody(slice, "- (NSString *)dividedTechnicalText") || "";
  if (!/kSliceMedianSeparationLabel/.test(dividedTech)) fail(tag, "the divided technical text must label the separation area.");
  if (!/UNAVAILABLE/.test(dividedTech)) fail(tag, "the divided technical text must state what is UNAVAILABLE.");
  if (!/OBSERVED/.test(dividedTech)) fail(tag, "the divided technical text must state what was OBSERVED.");
  if (!/kSliceMedianSeparationDetail/.test(dividedTech)) {
    fail(tag, "the divided technical text must carry the pavement-edge/median limitation.");
  }
}

// ---- D: both member centerlines + markers + separation in the immersive scene ---------
{
  const tag = "divided-immersive";
  const overlay = methodBody(immersive, "- (void)buildDividedCorridorOverlay");
  if (!overlay) {
    fail(tag, "ErisImmersiveCorridorViewController must implement buildDividedCorridorOverlay.");
  } else {
    for (const key of ["memberAPartsXsZs", "memberBPartsXsZs"]) {
      if (!overlay.includes(key)) fail(tag, `the immersive overlay must draw ${key} (both observed centerlines).`);
    }
    for (const key of ["memberAStationXZ", "memberBStationXZ"]) {
      if (!overlay.includes(key)) fail(tag, `the immersive overlay must mark the station on ${key}.`);
    }
    if (!/markerAtEast:/.test(overlay)) fail(tag, "the immersive overlay must place station markers.");
    if (!/lineNodeFromPoints:/.test(overlay)) fail(tag, "the immersive overlay must draw the member centerlines as lines.");
  }
  const load2 = methodBody(immersive, "- (void)viewDidLoad") || "";
  if (!/isObservedDividedCorridor\]\)\s*\[self buildDividedCorridorOverlay\]/.test(load2)) {
    fail(tag, "the immersive scene must build the divided overlay when the model is an observed divided corridor.");
  }
  const annot = methodBody(immersive, "- (void)addSeparationAnnotation");
  if (!annot) {
    fail(tag, "ErisImmersiveCorridorViewController must implement addSeparationAnnotation.");
  } else {
    if (!/kCorMedianSeparationLabel/.test(annot)) fail(tag, "the separation annotation must use the shared separation label.");
    if (!/separationM/.test(annot)) fail(tag, "the separation annotation must state the MEASURED separation.");
    if (!/unavailable/i.test(annot)) fail(tag, "the separation annotation must state the pavement-edge limitation.");
    if (!/accessibilityLabel/.test(annot)) fail(tag, "the separation annotation must be accessible.");
  }
  // The corridor model must actually carry the member geometry the overlay needs.
  for (const key of ["memberAPartsXsZs", "memberBPartsXsZs", "memberAStationXZ", "memberBStationXZ"]) {
    if (!terrain.includes(`@"${key}"`)) fail(tag, `buildCorridorModelAtLat: must publish ${key}.`);
  }
  const corridorModel = methodBody(terrain, "- (NSDictionary *)buildCorridorModelAtLat:") || "";
  if (!/clipLineCoords:/.test(corridorModel)) {
    fail(tag, "member centerlines must be clipped with the same part-preserving clip as the selected road.");
  }
}

// ---- E: no second acknowledgment; compact expandable provenance -----------------------
{
  const tag = "provenance-ux";
  if (/@"Acknowledge"/.test(container) || /onAcknowledge/.test(container)) {
    fail(tag, "the inspection container must not carry a second Acknowledge control.");
  }
  for (const [name, code] of [["immersive", immersive], ["technical", slice]]) {
    if (/@"Acknowledge"/.test(code) || /onAcknowledge/.test(code)) {
      fail(tag, `the ${name} child must not carry an Acknowledge control.`);
    }
  }
  const bar = methodBody(container, "- (void)addProvenanceBar");
  if (!bar) {
    fail(tag, "the inspection container must implement the compact provenance bar.");
  } else {
    if (!/@"Details"/.test(bar)) fail(tag, "the provenance bar must expose a Details disclosure.");
    if (!/adjustsFontForContentSizeCategory\s*=\s*YES/.test(bar)) fail(tag, "the provenance bar must support Dynamic Type.");
    if (!/preferredFontForTextStyle/.test(bar)) fail(tag, "the provenance bar must use a preferred text style.");
    if (!/accessibilityLabel/.test(bar)) fail(tag, "the provenance bar must be accessible.");
    if (!/hidden\s*=\s*YES/.test(bar)) fail(tag, "the provenance detail must be collapsed by default (compact).");
  }
  const toggle = methodBody(container, "- (void)onToggleProvenance");
  if (!toggle) fail(tag, "the provenance disclosure must be toggleable.");
  else if (!/UIAccessibilityPostNotification/.test(toggle)) {
    fail(tag, "expanding provenance must announce the layout change to assistive technology.");
  }
  // The summary must state the measured separation for a divided corridor, never a lane claim.
  const summary = methodBody(container, "- (NSString *)provenanceSummaryText:") || "";
  if (!/separationM/.test(summary)) fail(tag, "the provenance summary must state the measured separation for a divided corridor.");
  const detail = methodBody(container, "- (NSString *)provenanceDetailText:") || "";
  if (!/Unavailable/.test(detail)) fail(tag, "the provenance detail must state what is unavailable.");

  // The immersive scene must not restate the roadway-layout provenance the bar now owns.
  const warn = methodBody(immersive, "- (void)addWarningOverlays:") || "";
  if (/roadLayoutSource|Default roadway assumptions/.test(warn)) {
    fail(tag, "the immersive warning block must not duplicate the container's roadway-layout provenance.");
  }
}

// ---- F: deterministic, idempotent scene teardown --------------------------------------
{
  const tag = "teardown";
  for (const [name, code] of [["immersive", immersive], ["technical", slice]]) {
    const body = methodBody(code, "- (void)releaseSceneResources");
    if (!body) { fail(tag, `the ${name} child must implement releaseSceneResources.`); continue; }
    if (!/if\s*\(self\.sceneReleased\)\s*return;/.test(body)) {
      fail(tag, `${name} releaseSceneResources must be idempotent (guard on sceneReleased).`);
    }
    if (!/playing\s*=\s*NO/.test(body)) fail(tag, `${name} releaseSceneResources must stop rendering.`);
    if (!/delegate\s*=\s*nil/.test(body)) fail(tag, `${name} releaseSceneResources must clear the scene delegate.`);
    if (!/pointOfView\s*=\s*nil/.test(body)) fail(tag, `${name} releaseSceneResources must clear the point of view.`);
    if (!/scene\s*=\s*nil/.test(body)) fail(tag, `${name} releaseSceneResources must drop the scene.`);
    if (!/diffuse\.contents\s*=\s*nil/.test(body)) fail(tag, `${name} releaseSceneResources must release material contents (decoded imagery).`);
    if (!/removeFromParentNode/.test(body)) fail(tag, `${name} releaseSceneResources must remove the scene nodes.`);
    const dealloc = methodBody(code, "- (void)dealloc") || "";
    if (!/releaseSceneResources/.test(dealloc)) fail(tag, `${name} dealloc must release scene resources.`);
  }
  if (!/self\.heights\s*=\s*nil/.test(methodBody(immersive, "- (void)releaseSceneResources") || "")) {
    fail(tag, "the immersive child must release the packaged elevation array.");
  }
  // The container drives teardown from every exit path.
  const release = methodBody(container, "- (void)releaseChildSceneResources");
  if (!release) fail(tag, "the container must implement releaseChildSceneResources.");
  else if (!/immersiveVC[\s\S]*releaseSceneResources[\s\S]*technicalVC[\s\S]*releaseSceneResources/.test(release)) {
    fail(tag, "the container must release BOTH children's scene resources.");
  }
  for (const sel of ["- (void)onClose", "- (void)viewDidDisappear:", "- (void)dealloc"]) {
    const body = methodBody(container, sel);
    if (!body) { fail(tag, `the container must implement ${sel.trim()}.`); continue; }
    if (!/releaseChildSceneResources/.test(body)) fail(tag, `the container must release child scenes from ${sel.trim()}.`);
  }
  // The inactive child is detached on a mode switch, so a child must not tear itself down
  // on disappear — that would destroy a scene the user is about to return to.
  for (const [name, code] of [["immersive", immersive], ["technical", slice]]) {
    const vd = methodBody(code, "- (void)viewDidDisappear:");
    if (vd && /releaseSceneResources/.test(vd)) {
      fail(tag, `the ${name} child must not release its scene on viewDidDisappear (the container swaps children).`);
    }
  }
  // Heavy decode/composition happens inside an autorelease pool.
  if (!/@autoreleasepool/.test(immersive)) fail(tag, "the immersive child must bound the drape build in an @autoreleasepool.");
}

// ---- G: the SECTION is the sole contract, end to end (Part 13) ------------------------
// The renderer being template-free is not enough: the terrain under it was still sampled
// along the DEFAULT template's axis and extent. These checks pin the data flow itself.
{
  const tag = "section-flow";
  const TEMPLATE_SECTION = /crossSectionRoad|XsShoulderEdgeFt|XsCrossBearing/;

  const section = methodBody(terrain, "- (NSDictionary *)buildDividedSectionForInspection:");
  if (!section) {
    fail(tag, "the terrain controller must build the divided section (buildDividedSectionForInspection:reason:).");
  } else {
    if (TEMPLATE_SECTION.test(section)) {
      fail(tag, "the divided section must not consult crossSectionRoad/XsShoulderEdgeFt/XsCrossBearing.");
    }
    if (/lane_count|lane_width_ft|median_width_ft|total_width_ft|shoulder/.test(section)) {
      fail(tag, "the divided section must not consume DEFAULT roadway-template fields.");
    }
    for (const key of ["crossAxis", "sectionMinOffsetM", "sectionMaxOffsetM"]) {
      if (!section.includes(`@"${key}"`)) fail(tag, `the divided section must derive its extent from the model's ${key}.`);
    }
    // Assert the clip RESULT is bound and consumed, not merely that the call appears: a
    // disabled clip (`BOOL inRect = YES; ... if (NO) [self clipSegAx:...]`) still contains
    // the text, and a presence check would pass while the section escaped the package.
    if (!/BOOL\s+inRect\s*=\s*\[self clipSegAx:/.test(section)) {
      fail(tag, "the divided section's in-rect flag must come from the clip itself.");
    }
    if (!/if\s*\(!inRect\)\s*ERIS_DS_FAIL\(@"section_outside_package"\)/.test(section)) {
      fail(tag, "a section outside the package must fail closed.");
    }
    if (!/startOff\s*=\s*minOff\s*\+\s*requestedSpan\s*\*\s*t0/.test(section) ||
        !/endOff\s*=\s*minOff\s*\+\s*requestedSpan\s*\*\s*t1/.test(section)) {
      fail(tag, "the clipped extent must be derived from the clip parameters (t0/t1).");
    }
    if (!/truncated\s*=\s*\(t0\s*>\s*1e-9\)\s*\|\|\s*\(t1\s*<\s*1\s*-\s*1e-9\)/.test(section)) {
      fail(tag, "truncation must be derived from the clip parameters.");
    }
    if (!/aoiMinLon|aoiMaxLon/.test(section)) fail(tag, "the divided section must clip against the packaged grid bounds.");
    if (!/sampleElevationMetersAtLat:/.test(section)) fail(tag, "the divided section must sample the packaged elevation grid.");
    // Anchors: both members, the midpoint and both clipped ends must be explicit samples.
    if (!/@\(startOff\), @\(endOff\), @\(offA\), @\(offB\), @\(0\.0\)/.test(section)) {
      fail(tag, "the section must sample the clipped ends, both member offsets and the midpoint explicitly.");
    }
    if (!/kErisSectionSampleSpacingM/.test(section)) fail(tag, "the section must lay out evenly spaced intermediate samples.");
    if (!/kErisMaxSectionSamples/.test(section)) fail(tag, "the section sample count must be bounded.");
    if (!/member_terrain_unavailable/.test(section)) {
      fail(tag, "the section must fail closed when a member centerline has no packaged terrain.");
    }
    if (!/@"truncated"/.test(section)) fail(tag, "the section must carry its truncation status.");
  }

  // The divided slice must come from the section, never from the template slice builder.
  const dividedSlice = methodBody(terrain, "- (NSDictionary *)buildDividedSliceSelectedLat:");
  if (!dividedSlice) {
    fail(tag, "the terrain controller must build the divided slice from the section (buildDividedSliceSelectedLat:...).");
  } else {
    if (/XsShoulderEdgeFt|XsCrossBearing|xsSample:/.test(dividedSlice)) {
      fail(tag, "the divided slice must not use template shoulder edges, cross bearing, or the template sampler.");
    }
    if (!/section\[@"samples"\]/.test(dividedSlice)) fail(tag, "the divided slice's samples must BE the section's samples.");
    if (!/section\[@"crossBearingDeg"\]/.test(dividedSlice)) {
      fail(tag, "the divided slice's cross-section bearing must come from the section (model crossAxis).");
    }
    if (!/@"keyMarkers":\s*@\{\}/.test(dividedSlice)) {
      fail(tag, "the divided slice must not carry shoulder-relative key markers.");
    }
  }

  // inspectCandidate: model -> section -> slice -> corridor, all before presentation.
  const inspect = methodBody(terrain, "- (void)inspectCandidate:") || "";
  const iModel = inspect.indexOf("buildDividedCorridorInspectionForCandidate:");
  const iSection = inspect.indexOf("buildDividedSectionForInspection:");
  const iSlice = inspect.indexOf("buildDividedSliceSelectedLat:");
  const iCorridor = inspect.indexOf("buildCorridorModelAtLat:");
  if (iSection < 0) fail(tag, "inspectCandidate: must build the divided section.");
  if (iModel >= 0 && iSection >= 0 && iModel > iSection) fail(tag, "the model must be built before the section.");
  if (iSection >= 0 && iSlice >= 0 && iSection > iSlice) fail(tag, "the section must be built before the slice.");
  if (iSlice >= 0 && iCorridor >= 0 && iSlice > iCorridor) fail(tag, "the slice must be built before the corridor model.");
  if (!/dividedSection\s*==\s*nil\s*\)\s*\{[\s\S]{0,600}?return;/.test(inspect)) {
    fail(tag, "inspectCandidate: must fail closed when the divided section cannot be measured.");
  }
  if (!/slice\[@"dividedSection"\]\s*=\s*dividedSection/.test(inspect)) {
    fail(tag, "the section must travel with the slice so the corridor build and both children share it.");
  }

  // The map slice line must be the model-derived one for a divided corridor.
  const drawFromSection = methodBody(terrain, "- (void)drawSliceLineFromSection:");
  if (!drawFromSection) fail(tag, "the terrain controller must draw the divided slice line from the section.");
  else if (TEMPLATE_SECTION.test(drawFromSection)) fail(tag, "the section slice line must not consult the roadway template.");
  else if (!/sliceLonLat/.test(drawFromSection)) fail(tag, "the section slice line must use the section's clipped points.");
  // The legacy template line must not be reachable on the divided path.
  if (/isDivided[\s\S]{0,200}drawSliceLineAtLat:/.test(inspect) && !/drawSliceLineFromSection:/.test(inspect)) {
    fail(tag, "a divided corridor must not be drawn with the template slice line.");
  }
  if (!/isDivided\)\s*\{\s*\[self drawSliceLineFromSection:/.test(inspect)) {
    fail(tag, "inspectCandidate: must draw the divided slice line from the section.");
  }

  // The corridor model's section plane must be the same clipped section.
  const corridorModel = methodBody(terrain, "- (NSDictionary *)buildCorridorModelAtLat:") || "";
  if (!/dividedSection/.test(corridorModel)) {
    fail(tag, "buildCorridorModelAtLat: must use the immutable section for a divided corridor's section plane.");
  }
  if (!/dividedSection\[@"sliceLonLat"\]/.test(corridorModel)) {
    fail(tag, "the immersive section plane must be built from the section's clipped points.");
  }
  if (!/sliceTruncated\s*=\s*\[dividedSection\[@"truncated"\] boolValue\]/.test(corridorModel)) {
    fail(tag, "the immersive truncation status must come from the section.");
  }
  // The template path must survive for non-divided roads.
  if (!/XsShoulderEdgeFt/.test(corridorModel)) {
    fail(tag, "the legacy (non-divided) section plane must keep its existing template behaviour.");
  }
}

// ---- H: no terrain endpoint extrapolation (Part 13) -----------------------------------
{
  const tag = "no-extrapolation";
  const elev = methodBody(slice, "- (double)dividedGroundElevAtFt:");
  if (!elev) {
    fail(tag, "the technical renderer must implement dividedGroundElevAtFt:found:.");
  } else {
    if (/if\s*\(offsetFt\s*<=\s*prev\.x\)\s*\{\s*if\s*\(found\)\s*\*found\s*=\s*YES;\s*return prev\.y;/.test(elev)) {
      fail(tag, "an offset before the first sample must not return the first sample as valid terrain.");
    }
    if (!/offsetFt\s*<\s*first\.x\s*-\s*eps\s*\|\|\s*offsetFt\s*>\s*last\.x\s*\+\s*eps/.test(elev)) {
      fail(tag, "dividedGroundElevAtFt: must reject offsets outside the real sampled range.");
    }
    // The out-of-range path must leave found = NO.
    const outOfRange = elev.slice(elev.indexOf("first.x - eps"), elev.indexOf("first.x - eps") + 220);
    if (/\*found\s*=\s*YES/.test(outOfRange)) fail(tag, "an out-of-range offset must report found = NO.");
  }
  const marker = methodBody(slice, "- (void)addDividedMarkerInto:");
  if (!marker) fail(tag, "the technical renderer must implement addDividedMarkerInto:.");
  else if (!/if\s*\(!found\)\s*return;/.test(marker)) {
    fail(tag, "a member marker must be omitted when its offset has no packaged terrain.");
  }
  const dim = methodBody(slice, "- (void)addSeparationDimensionInto:") || "";
  if (!/if\s*\(!fLo\s*\|\|\s*!fHi\)\s*return;/.test(dim)) {
    fail(tag, "the separation dimension must not span to an extrapolated elevation.");
  }
}

// ---- I: the divided pre-inspection gate tells the truth (Part 13) ---------------------
{
  const tag = "divided-gate";
  const gate = methodBody(terrain, "- (void)presentDividedCorridorGateForCandidate:");
  if (!gate) {
    fail(tag, "a divided corridor must have its own pre-inspection gate.");
  } else {
    if (/lane_count|lane_width_ft|median_width_ft|total_width_ft|XsShoulderEdgeFt|crossSectionRoad/.test(gate)) {
      fail(tag, "the divided gate must not read or list DEFAULT roadway-template values.");
    }
    if (/32-foot two-way roadway template/.test(gate) === false) {
      fail(tag, "the divided gate must state that the DEFAULT 32-foot two-way template will NOT be applied.");
    }
    if (/will not apply the DEFAULT/.test(gate) === false) {
      fail(tag, "the divided gate must state the template is not applied.");
    }
    for (const line of ["Observed:", "Unavailable:"]) {
      if (!gate.includes(line)) fail(tag, `the divided gate must have an explicit "${line}" section.`);
    }
    for (const item of ["Lane count and lane widths", "Shoulders", "Pavement edges", "Carriageway widths",
                        "Physical median width and category", "Traffic direction"]) {
      if (!gate.includes(item)) fail(tag, `the divided gate must list "${item}" as unavailable.`);
    }
    for (const item of ["Two packaged carriageway centerlines", "geometry-derived midpoint corridor",
                        "Measured centerline-to-centerline separation", "Packaged terrain and imagery"]) {
      if (!gate.includes(item)) fail(tag, `the divided gate must list "${item}" as observed.`);
    }
  }
  // The DEFAULT gate must remain intact for roads that genuinely use the template.
  const defGate = methodBody(terrain, "- (void)presentDefaultLayoutGateForCandidate:");
  if (!defGate) fail(tag, "the DEFAULT gate must remain for non-divided roads.");
  else {
    if (!/Total width: %g ft/.test(defGate)) fail(tag, "the DEFAULT gate must keep stating the template's total width.");
    if (!/32-foot layout is NOT observed highway geometry/.test(defGate)) {
      fail(tag, "the DEFAULT gate must keep its not-observed-geometry wording for a primary.");
    }
  }
  // Routing: divided -> divided gate; everything else -> unchanged behaviour.
  const cardInspect = methodBody(terrain, "- (void)onCardInspect") || "";
  if (!/kErisSelDividedCorridor\]\)\s*\{\s*\[self presentDividedCorridorGateForCandidate:/.test(cardInspect)) {
    fail(tag, "a divided corridor must route to its own gate before inspection.");
  }
  if (!/layoutRequiresAcknowledgment\]\)\s*\{\s*\[self presentDefaultLayoutGateForCandidate:/.test(cardInspect)) {
    fail(tag, "non-divided DEFAULT roads must still route to the DEFAULT gate.");
  }
}

// ---- J: ONE provenance record, real keys, all quality flags (Part 13) -----------------
{
  const tag = "provenance-flow";
  const build = methodBody(terrain, "- (NSDictionary *)buildInspectionProvenanceForSlice:");
  if (!build) {
    fail(tag, "the terrain controller must build ONE immutable provenance record.");
  } else {
    // Each published key must be read from its TRUE source (the corridor's own key names).
    const SOURCED = [
      ['imageryProvider', /XsStr\(corridor, @"imageryProvider"/],
      ['imageryMetersPerPixel', /XsNum\(corridor, @"imageryEffectiveMpp"/],
      ['imageryTileCount', /XsNum\(corridor, @"imageryTileCount"/],
      ['textureWidthPx', /corridor\[@"textureWidthPx"\]/],
      ['textureHeightPx', /corridor\[@"textureHeightPx"\]/],
      ['textureSourceLimited', /corridor\[@"textureSourceLimited"\]/],
      ['textureMemoryCapped', /corridor\[@"textureMemoryCapped"\]/],
      ['imageryPresent', /corridor\[@"hasImagery"\]/],
    ];
    for (const [key, re] of SOURCED) {
      if (!re.test(build)) fail(tag, `provenance ${key} must be read from the corridor model's real key.`);
      if (!build.includes(`@"${key}"`)) fail(tag, `provenance must publish ${key}.`);
    }
    for (const key of ["imageryLegacySingle", "sectionTruncated", "orientationSource", "orientationAuthoritative",
                       "pairingMethod", "pairingVersion", "elevationSource"]) {
      if (!build.includes(`@"${key}"`)) fail(tag, `provenance must publish ${key}.`);
    }
  }
  const present = methodBody(terrain, "- (void)inspectCandidate:") || "";
  if (!/buildInspectionProvenanceForSlice:/.test(present)) {
    fail(tag, "inspectCandidate: must build the provenance record before presenting.");
  }
  if (!/provenance:provenance/.test(present)) fail(tag, "the provenance record must be passed to the inspection.");

  // The container must render the record it is given, not re-read the slice.
  if (!/initWithSlice:.*\n?.*corridor:.*\n?.*inspectionGeometry:.*\n?.*provenance:/.test(container)) {
    fail(tag, "the container must accept the immutable provenance record.");
  }
  const bar = methodBody(container, "- (void)addProvenanceBar") || "";
  if (/slice\[@"provenance"\]/.test(bar)) {
    fail(tag, "the provenance bar must render the passed record, not re-read slice.provenance.");
  }
  const detail = methodBody(container, "- (NSString *)provenanceDetailText:") || "";
  for (const key of ["imageryPresent", "imageryLegacySingle", "textureSourceLimited", "textureMemoryCapped",
                     "sectionTruncated", "orientationAuthoritative"]) {
    if (!detail.includes(`@"${key}"`)) fail(tag, `the expanded provenance must surface the ${key} quality flag.`);
  }
  const summary = methodBody(container, "- (NSString *)provenanceSummaryText:") || "";
  if (!/imageryProvider/.test(summary) || !/imageryMetersPerPixel/.test(summary)) {
    fail(tag, "the collapsed bar must show provider and GSD when available.");
  }
  // imageryVintage was never produced anywhere; reading it can only ever yield nil.
  if (/imageryVintage/.test(container) && !/imageryVintage/.test(terrain)) {
    fail(tag, "the container reads imageryVintage, which nothing produces — remove it or publish it.");
  }
}

// ---- K: parity with the tested section-sampling model ---------------------------------
{
  const tag = "section-parity";
  const tsSection = readFileSync(TS("dividedSectionSampling.ts"), "utf8");
  const NUMERIC = [
    ["SECTION_SAMPLE_SPACING_M", "kErisSectionSampleSpacingM"],
    ["MAX_SECTION_SAMPLES", "kErisMaxSectionSamples"],
    ["OFFSET_EPSILON_M", "kErisOffsetEpsM"],
  ];
  for (const [tsName, objcName] of NUMERIC) {
    const t = tsSection.match(new RegExp(`export const ${tsName}\\s*=\\s*([\\d.e-]+)`));
    if (!t) { fail(tag, `the TS section model no longer exports ${tsName}.`); continue; }
    const o = terrain.match(new RegExp(`${objcName}\\s*=\\s*([\\d.e-]+)`));
    if (!o) { fail(tag, `the native mirror must define ${objcName} for ${tsName}.`); continue; }
    if (Number(t[1]) !== Number(o[1])) fail(tag, `${objcName} (${o[1]}) must equal ${tsName} (${t[1]}).`);
  }
  const tsReasons = [...tsSection.matchAll(/reason:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  for (const r of new Set(tsReasons)) {
    if (!terrain.includes(`@"${r}"`)) fail(tag, `the native section must be able to report the fail reason "${r}".`);
  }
}

// ---- M: member geometry validation is STRICTLY fail-closed ----------------------------
// Mutation battery: replacing rejection with `continue`, or reintroducing -doubleValue
// coercion, must fail CI. Skipping a malformed vertex and keeping its neighbours would
// invent a chord across it; -doubleValue turns the NSString "garbage" into 0.
{
  const tag = "strict-line-validation";
  const clean = methodBody(terrain, "- (NSArray *)cleanLonLatLine:");
  if (!clean) {
    fail(tag, "the native mirror must implement cleanLonLatLine:.");
  } else {
    if (/\bcontinue\s*;/.test(clean)) {
      fail(tag, "cleanLonLatLine: must never `continue` past a malformed vertex — it must reject the whole line.");
    }
    if (/respondsToSelector:\s*@selector\(doubleValue\)/.test(clean)) {
      fail(tag, "cleanLonLatLine: must not accept anything answering -doubleValue (NSString would coerce to 0).");
    }
    const numberChecks = countOf(clean, /isKindOfClass:\s*\[NSNumber class\]/g);
    if (numberChecks < 1) fail(tag, "cleanLonLatLine: must require real NSNumber components.");
    if (!/ErisIsBoolNumber/.test(clean)) {
      fail(tag, "cleanLonLatLine: must reject CFBoolean values (a bool is an NSNumber subclass).");
    }
    if (!/-180(\.0)?/.test(clean) || !/180(\.0)?/.test(clean) || !/-90(\.0)?/.test(clean) || !/90(\.0)?/.test(clean)) {
      fail(tag, "cleanLonLatLine: must enforce WGS84 bounds on longitude and latitude.");
    }
    if (!/isfinite\(lon\)\s*\|\|\s*!isfinite\(lat\)|!isfinite\(lon\)|!isfinite\(lat\)/.test(clean)) {
      fail(tag, "cleanLonLatLine: must reject non-finite coordinates.");
    }
    if (countOf(clean, /return nil;/g) < 4) {
      fail(tag, "cleanLonLatLine: must fail closed (return nil) on every invalid-input branch.");
    }
    if (/return\s+@\[\];/.test(clean)) {
      fail(tag, "cleanLonLatLine: must return nil (not an empty array) so the caller reports a fail-closed reason.");
    }
  }
  if (!/ErisIsBoolNumber/.test(terrain)) fail(tag, "the native mirror must define ErisIsBoolNumber.");
  // The TS mirror must be equally strict.
  if (!/typeof p\[0\] === "number"/.test(tsModel) || !/typeof p\[1\] === "number"/.test(tsModel)) {
    fail(tag, "dividedCorridorInspection.ts validCoord must require real numbers (not coercible values).");
  }
  if (!/p\[0\] >= -180 && p\[0\] <= 180 && p\[1\] >= -90 && p\[1\] <= 90/.test(tsModel)) {
    fail(tag, "dividedCorridorInspection.ts validCoord must enforce WGS84 bounds.");
  }
  if (!/c\.every\(validCoord\)/.test(tsModel)) {
    fail(tag, "dividedCorridorInspection.ts validLine must reject the whole line via `every` (never filter).");
  }
}

// ---- N: the DIVIDED candidate card never claims roadway-template dimensions -----------
// Mutation battery: removing the early return, or consulting the DEFAULT template / the
// global upstation hint from the divided branch, must fail CI.
{
  const tag = "divided-card-no-default";
  const divided = methodBody(terrain, "- (NSString *)dividedCandidateDetailText:");
  const detail = methodBody(terrain, "- (NSString *)candidateDetailText:");
  if (!divided) fail(tag, "the divided candidate card must have its OWN detail method.");
  if (!detail) {
    fail(tag, "candidateDetailText: must exist.");
  } else if (!/kErisSelDividedCorridor[\s\S]{0,160}return \[self dividedCandidateDetailText:/.test(detail)) {
    fail(tag, "candidateDetailText: must RETURN the divided text early, so single-road/DEFAULT messaging cannot follow.");
  }
  for (const [re, what] of [
    [/crossSectionLayoutSource/, "crossSectionLayoutSource"],
    [/crossSectionRoad/, "crossSectionRoad"],
    [/layoutRequiresAcknowledgment/, "layoutRequiresAcknowledgment"],
    [/upstationHintDeg/, "the global upstation hint"],
    [/total_width_ft/, "total width"],
    [/32 ft/, "the DEFAULT 32 ft template"],
    [/DEFAULT assumptions/, "DEFAULT roadway dimensions"],
    [/one-lane-each-way/, "the one-lane-each-way template"],
    [/not real highway dimensions/, "the DEFAULT-template warning"],
  ]) {
    if (divided && re.test(divided)) fail(tag, `the divided candidate card must not consult/print ${what}.`);
  }
  if (divided && !/orientationSource/.test(divided)) {
    fail(tag, "the divided card must state orientation provenance from the candidate's own orientationSource.");
  }
  if (divided && !/kErisDividedNoRoadwayDimensionsDetail/.test(divided)) {
    fail(tag, "the divided card must state explicitly that roadway dimensions are unavailable.");
  }
}

// ---- O: terrain NoData is never bridged (contiguous valid runs) ------------------------
// Mutation battery: reinstating a single flat filtered point list, drawing one shape across
// the whole section, interpolating across a gap, or accepting an interpolated critical
// anchor, must fail CI.
{
  const tag = "nodata-runs";
  if (/dividedGroundPointsFt/.test(slice)) {
    fail(tag, "the flat dividedGroundPointsFt list must not return — it silently reconnects across NoData.");
  }
  const runs = methodBody(slice, "- (NSArray<NSArray<NSValue *> *> *)dividedGroundRunsFt");
  if (!runs) {
    fail(tag, "the technical renderer must build contiguous valid runs (dividedGroundRunsFt).");
  } else {
    if (!/cur\.count/.test(runs) || !/runs addObject/.test(runs)) {
      fail(tag, "dividedGroundRunsFt must END the current run at every unusable sample.");
    }
    if (!/isEqualToString:@"OK"/.test(runs)) fail(tag, "only status OK samples may carry ground.");
    if (!/disnull\(ev\)/.test(runs) || !/isfinite\(\[ev doubleValue\]\)/.test(runs)) {
      fail(tag, "a null / non-finite elevation must end the run.");
    }
  }
  const exact = methodBody(slice, "- (double)dividedExactGroundElevAtFt:");
  if (!exact) {
    fail(tag, "critical anchors must resolve through dividedExactGroundElevAtFt: (exact sample only).");
  } else if (/prev\.y \+ \(p\.y - prev\.y\)/.test(exact)) {
    fail(tag, "the exact-anchor lookup must never interpolate.");
  }
  const ground = methodBody(slice, "- (void)buildDividedGroundInto:") || "";
  if (!/dividedRenderableGroundRunsFt/.test(ground) || !/buildDividedGroundRun:/.test(ground)) {
    fail(tag, "the ground profile must be drawn once PER RUN, never as one shape across the section.");
  }
  const elev = methodBody(slice, "- (double)dividedGroundElevAtFt:") || "";
  if (!/for \(NSArray<NSValue \*> \*run in \[self dividedGroundRunsFt\]\)/.test(elev)) {
    fail(tag, "dividedGroundElevAtFt: must interpolate only WITHIN a contiguous run.");
  }
  const marker = methodBody(slice, "- (void)addDividedMarkerInto:") || "";
  if (!/dividedExactGroundElevAtFt:/.test(marker)) {
    fail(tag, "a member/midpoint marker must stand on its EXACT anchor sample, never an interpolated one.");
  }
  const dim = methodBody(slice, "- (void)addSeparationDimensionInto:") || "";
  if (!/dividedExactGroundElevAtFt:/.test(dim)) {
    fail(tag, "the separation dimension needs both EXACT member anchors.");
  }
  // The section fails closed when the SELECTED midpoint station has no exact ground.
  const section = methodBody(terrain, "- (NSDictionary *)buildDividedSectionForInspection:") || "";
  if (!/midpointHasGround/.test(section) || !/@"station_terrain_unavailable"/.test(section)) {
    fail(tag, "the section must fail with station_terrain_unavailable when the midpoint anchor has no real ground.");
  }
  if (!/@"sliceValid"/.test(section)) {
    fail(tag, "the section must publish per-vertex sliceValid so renderers can split on terrain gaps.");
  }
  // The immersive plane must be split per valid run.
  const plane = methodBody(immersive, "- (void)buildCrossSectionPlane") || "";
  if (!/sliceXsZsRuns/.test(plane) || !/buildCrossSectionPlaneRun:/.test(plane)) {
    fail(tag, "the immersive section plane must be built per contiguous valid run, not across gaps.");
  }
  if (!/sliceXsZsRuns/.test(terrain)) {
    fail(tag, "the corridor model must publish sliceXsZsRuns (validity-split slice line).");
  }
}

if (errors.length > 0) {
  console.error("Divided-corridor native source-contract FAILED:\n  - " + errors.join("\n  - "));
  process.exit(1);
}
console.log(
  "Divided-corridor native source-contract OK — model built once and threaded immutably to both children, " +
    "template-free divided technical section, both observed centerlines + measured separation in the immersive scene, " +
    "single compact expandable provenance (no second acknowledgment), deterministic idempotent scene teardown, " +
    "native thresholds/fail-reasons/labels in parity with the tested TypeScript model.",
);

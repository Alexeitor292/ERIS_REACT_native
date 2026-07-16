#!/usr/bin/env node
// Static source-contract guard for the HIGHWAY-FIRST IMMERSIVE CROSS-SECTION milestone.
// Deterministic, comment-aware, no macOS needed (the macOS CI ios-native job is the full
// compile). Pins the native invariants across the four SceneKit controllers so the batch
// milestone cannot silently regress:
//   * physical draping is metre-derived (no worldSize-percentage physical lifts);
//   * the incident marker is a small ground ring, not a giant sphere;
//   * road snap features carry the ERIS road_class + display metadata;
//   * roads render class-aware (width/opacity) with a Road Display filter;
//   * selection is highway-first (per-class tolerances, priority ranking, bounded set);
//   * a candidate confirmation card precedes any inspection (no immediate modal);
//   * a saved/animated/restored map->inspection camera transition exists;
//   * inspection is an Immersive|Technical container sharing one slice model, immersive
//     is perspective, technical stays orthographic;
//   * orientation/default-layout limitations stay truthful; everything stays offline.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const P = (name) => join(HERE, "..", "plugins", "arcgis-ios", name);

function stripComments(src) {
  return src
    .replace(/\r\n?/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const NET = /NSURLSession|NSURLConnection|dataWithContentsOfURL:|URLWithString:|WKWebView|UIWebView|CFNetwork|https?:\/\//;
const WRITES = /writeToFile:|writeToURL:|createFileAtPath:|removeItemAtPath:|removeItemAtURL:/;
const errors = [];
const load = (name) => stripComments(readFileSync(P(name), "utf8"));
const checker = (tag, code) => ({
  req: (re, msg) => { if (!re.test(code)) errors.push(`[${tag}] ${msg}`); },
  forbid: (re, msg) => { if (re.test(code)) errors.push(`[${tag}] ${msg}`); },
});

// ---- Terrain VC: scale, classes, snapping, confirmation, transition ---------
{
  const code = load("ErisTerrainSceneViewController.m");
  const { req, forbid } = checker("terrain-vc", code);

  // Part 1: metre-derived physical scale; the old worldSize-percentage physical lifts gone.
  req(/sceneUnitsForMeters:/, "must expose the metre->scene-unit helper (sceneUnitsForMeters:).");
  req(/drapeLiftForLayer:/, "draped overlays must use the metre-derived drapeLiftForLayer:.");
  req(/kErisRoadDrapeLiftM\s*=\s*0\.30/, "road drape lift must be the 0.30 m constant.");
  forbid(/worldSize\s*\*\s*0\.018/, "the old ~27 m road lift (worldSize * 0.018) must be gone.");
  forbid(/worldSize\s*\*\s*0\.03(?!\d)/, "the old incident lift (worldSize * 0.03) must be gone.");
  forbid(/worldSize\s*\*\s*0\.025/, "the old incident radius (worldSize * 0.025) must be gone.");
  forbid(/sphereWithRadius:\s*self\.worldSize/, "markers must be metre-derived, not worldSize spheres.");

  // Part 2: restrained incident marker (ground ring, not a 75 m sphere).
  req(/kErisIncidentRingDiameterM/, "incident marker must use the metre-derived ground ring diameter.");
  req(/SCNTorus/, "incident marker must draw a ground ring (SCNTorus).");
  req(/Incident location/, "incident marker must carry an accessible identification.");

  // Part 3: road metadata preserved on every snap primitive.
  req(/snapFeatureForProps:/, "snap parser must build metadata-carrying primitives.");
  req(/road_class_label/, "snap metadata must include road_class_label.");
  req(/source_layer_id/, "snap metadata must include source_layer_id (display only).");
  req(/roadClass/, "snap metadata must carry roadClass.");

  // Part 4: class-aware rendering + Road Display control.
  req(/ErisRoadStyleForClass/, "roads must render with a per-class style (width/opacity).");
  req(/roadRibbonNodeFromCoords:/, "roads must render as width-bearing ribbons, not 1px lines only.");
  req(/@"Highways"/, "Road Display control must offer Highways.");
  req(/@"All roads"/, "Road Display control must offer All roads.");
  req(/applyRoadDisplayFilter/, "Road Display filter must gate class visibility.");

  // PR #51 FINAL review — Defect 1: main-map roads are REALLY clipped, not vertex-filtered.
  req(/clipLineCoordsToTerrainBounds:/, "main-map lines must be clipped to the terrain bounds (shared helper).");
  req(/-\s*\(void\)buildRoadsLayer\s*\{[\s\S]{0,2600}clipLineCoordsToTerrainBounds/, "buildRoadsLayer must clip each line to the terrain bounds.");
  req(/-\s*\(void\)highlightCandidate:[\s\S]{0,700}clipLineCoordsToTerrainBounds/, "the candidate highlight must use the same clipping.");
  forbid(/\[\s*inb\s+addObject/, "the old in-bounds-vertex-only road accumulation must be gone.");

  // Part 5: highway-first candidate search.
  req(/gatherCandidatesAtLat:/, "selection must gather a bounded candidate set (gatherCandidatesAtLat:).");
  req(/kErisSnapMaxPrimaryM\s*=\s*90/, "primary snap tolerance must be 90 m.");
  req(/kErisSnapMaxSecondaryM\s*=\s*65/, "secondary snap tolerance must be 65 m.");
  req(/kErisSnapMaxLocalM\s*=\s*45/, "local snap tolerance must be 45 m.");
  req(/kErisMaxCandidates/, "candidate set must be bounded (kErisMaxCandidates).");
  req(/priority.*NSOrderedAscending.*NSOrderedDescending/s, "ranking must order by class priority first.");
  req(/roadClassSelectable:/, "must never snap to a class the filter excludes.");

  // Part 6: confirmation card precedes inspection; candidate highlighted first.
  req(/presentCandidateConfirmation/, "a confirmation card must precede inspection.");
  req(/createCrossSectionAtLat[\s\S]{0,700}presentCandidateConfirmation/,
      "the tap path must present the confirmation card, not inspect immediately.");
  req(/@"Inspect"/, "the card must offer Inspect.");
  req(/Choose another road/, "the card must let the user choose another road.");
  req(/@"Cancel"/, "the card must offer Cancel.");
  req(/highlightCandidate:/, "the selected candidate must be highlighted before Inspect.");

  // PR #51 review — Defect 6: candidate carries display metadata (never classification).
  req(/@"basename"/, "candidate must carry basename.");
  req(/@"mtfcc"/, "candidate must carry mtfcc.");
  req(/@"rttyp"/, "candidate must carry rttyp.");
  req(/@"sourceLayerId"/, "candidate must carry sourceLayerId.");

  // PR #51 review — Defect 3: DEFAULT layout is a real GATE before any inspection is built.
  req(/layoutRequiresAcknowledgment/, "DEFAULT layout must gate inspection (layoutRequiresAcknowledgment).");
  // Part 13 added a SECOND gate (divided corridors get their own truthful one), so Inspect
  // now branches: divided -> presentDividedCorridorGateForCandidate, else DEFAULT gate.
  // Both must still be consulted BEFORE inspectCandidate: builds anything.
  req(/onCardInspect[\s\S]{0,700}layoutRequiresAcknowledgment/, "Inspect must consult the gate before building inspection.");
  req(/onCardInspect[\s\S]{0,400}presentDividedCorridorGateForCandidate/,
      "a divided corridor must be gated by its own truthful gate before inspection.");
  req(/presentDividedCorridorGateForCandidate[\s\S]{0,1800}inspectCandidate:/,
      "the divided gate must lead to the inspection only on acknowledgment.");
  req(/presentDefaultLayoutGateForCandidate/, "the gate must present a blocking assumptions confirmation.");
  req(/Acknowledge and inspect/, "the gate action must be 'Acknowledge and inspect'.");
  req(/NOT observed highway geometry/, "a primary highway on DEFAULT must state it is not observed geometry.");

  // PR #51 review — Defect 1/2: station-fixed corridor + real multi-part road clipping.
  req(/roadPartsXsZs/, "corridor road must be emitted as separate clipped parts.");
  req(/clipRoadCoords:/, "corridor road must be clipped per-segment to the corridor rect.");
  req(/stationEastM/, "corridor must record the snapped station offset (station-fixed).");
  forbid(/@"roadXsZs"/, "the old single-list corridor road (roadXsZs) must be gone.");

  // PR #51 FINAL review — Defect 2: never inspect a station outside the elevation grid.
  req(/ontoParts:/, "candidate selection must project onto TERRAIN-CLIPPED road parts (in-grid snaps).");
  req(/gatherCandidatesAtLat:\(double\)lat[\s\S]{0,600}ontoParts:/, "gatherCandidates must project onto clipped parts.");
  req(/inspectCandidate:\(NSDictionary \*\)cand[\s\S]{0,400}inPackageBoundsLat/, "inspectCandidate must verify the station is in-grid first.");
  req(/outside the downloaded terrain area/, "an out-of-grid station must be refused with truthful wording.");

  // PR #51 FINAL review — Defect 3: the immersive slice plane is bounded to the corridor.
  req(/sliceTruncated/, "the corridor must flag a slice truncated by the package boundary.");

  // ---- divided-highway selection schema (additive) --------------------------
  req(/divided_highway_corridor/, "must parse the divided_highway_corridor selection kind.");
  req(/individual_carriageway/, "must parse the individual_carriageway selection kind.");
  req(/ordinary_road/, "must parse the ordinary_road selection kind.");
  req(/kErisSelRamp/, "must parse the ramp selection kind.");
  req(/carriageway_member/, "must recognise the diagnostics carriageway_member role.");
  req(/ErisIsSelectableKind/, "selectable eligibility must gate on the four-value enum.");
  req(/hasSelectionSchema/, "must detect whether the package declares the selection schema.");
  req(/roadsUseSelectionSchema/, "a legacy package must keep the previous class-aware behaviour.");
  // selectable:true eligibility + diagnostics/context exclusion in candidate gathering.
  req(/gatherCandidatesAtLat:\(double\)lat[\s\S]{0,900}roadsUseSelectionSchema[\s\S]{0,120}selectable/,
      "candidate gathering must admit ONLY selectable:true schema features.");
  // ONE corridor line: raw members go to the diagnostics node, never a normal yellow road.
  req(/roadsDiagnosticsNode/, "raw carriageway members must render into a separate diagnostics layer.");
  req(/ErisDiagnosticMemberStyle/, "diagnostics members must not use the normal road style.");
  req(/-\s*\(void\)buildRoadsLayer\s*\{[\s\S]{0,2600}roadsDiagnosticsNode addChildNode/,
      "buildRoadsLayer must route diagnostics members to the diagnostics layer.");
  // Ramp ranking strictly below corridor/mainline even though both are road_class primary.
  req(/ErisSelectionRank/, "candidate ranking must rank corridor > individual roadway > ramp.");
  req(/selectionRank/, "the candidate must carry its selection rank.");
  // Truthful labels: never a fabricated compass direction.
  req(/Divided highway corridor/, "the card must label a divided corridor.");
  req(/Individual highway roadway/, "the card must label an individual roadway without a direction claim.");
  forbid(/@"(East|West|North|South)bound/, "must NEVER claim a compass direction from the classification.");
  req(/Measured carriageway separation/, "a corridor candidate must report its MEASURED separation.");
  req(/Geometry-derived corridor centerline/, "a corridor must state its centreline is geometry-derived.");
  req(/Direction is not authoritative/, "a geometry-derived corridor must say the direction is not authoritative.");

  // ---- tile-native + GSD-derived imagery ------------------------------------
  forbid(/CGSizeMake\(\s*512\s*,\s*512\s*\)/, "the fixed 512x512 immersive compositor must be gone.");
  req(/imageryEffectiveMetersPerPixel/, "corridor texture sizing must use the packaged effective m/px.");
  req(/corridorTextureSizeForWidthM:/, "corridor texture size must be derived from ground size / GSD.");
  req(/kErisCorridorMaxTexturePx\s*=\s*3072/, "the corridor texture cap must be 3072.");
  req(/kErisCorridorTextureMemoryBudgetBytes/, "an explicit decoded/GPU memory budget must be enforced.");
  req(/corridorTextureSourceLimited/, "must report when the result is source-resolution limited.");
  req(/corridorTextureMemoryCapped/, "must report when the result is device-memory capped.");
  req(/imageryTileCount/, "must report how many tiles this LOCAL inspection used.");
  // Tile-native quality on the main terrain.
  req(/mat\.diffuse\.mipFilter\s*=\s*SCNFilterModeLinear/, "imagery tiles must use mip filtering.");
  req(/mat\.diffuse\.magnificationFilter\s*=\s*SCNFilterModeLinear/, "imagery tiles must magnify linearly.");
  req(/mat\.diffuse\.minificationFilter\s*=\s*SCNFilterModeLinear/, "imagery tiles must minify linearly.");
  req(/mat\.diffuse\.maxAnisotropy\s*=\s*kErisImageryMaxAnisotropy/, "imagery tiles must use anisotropic filtering.");

  // Part 7: saved/animated/restored camera transition; no immediate modal in the tap path.
  req(/saveMapCameraState/, "must save the map camera before the flight.");
  req(/animateMapToInspectionAtLat:/, "must animate the camera toward the snapped station.");
  req(/restoreMapCameraAfterInspection/, "must restore the prior map camera when inspection closes.");
  req(/SCNTransaction/, "the camera flight must be an explicit animation (SCNTransaction).");
  req(/ErisInspectionViewController/, "inspection must open the Immersive/Technical container.");
  forbid(/\[\s*ErisRoadSliceSceneViewController\s+alloc\s*\]/,
      "the tap path must NOT present the orthographic slice directly (no uncoordinated modal).");

  // PR #51 review — Defect 5: selection + camera transitions are cancellable.
  req(/transitionInProgress/, "the camera flight must track transitionInProgress.");
  req(/transitionToken/, "a monotonic transitionToken must invalidate superseded flights.");
  req(/cancelInspectionTransition/, "there must be an explicit transition cancellation path.");
  req(/isBeingDismissed/, "the flight completion must not present while being dismissed.");
  req(/presentedViewController/, "the flight completion must not double-present.");
  req(/onClose[\s\S]{0,120}cancelInspectionTransition/, "Close must invalidate an in-flight transition.");
  req(/candidateCardView == nil/, "card actions must be inert after cancellation.");

  // Part 10: truthful orientation + default-layout warnings in the card.
  req(/upstation is NOT verified/, "must warn when orientation is only geometry-derived.");
  req(/not real highway dimensions/, "a primary highway on DEFAULT layout must not be shown as real geometry.");

  // Fully offline; read-only grid.
  forbid(NET, "terrain VC must not perform networking.");
  forbid(WRITES, "terrain VC must not write package files.");
}

// ---- Immersive corridor VC (perspective, offline, honest) -------------------
{
  const code = load("ErisImmersiveCorridorViewController.m");
  const { req, forbid } = checker("immersive-vc", code);
  req(/initWithSlice:[\s\S]{0,80}corridor:/, "immersive VC must consume the shared slice + corridor.");
  req(/SCNCamera/, "immersive VC must set up a camera.");
  req(/fieldOfView/, "immersive camera must be PERSPECTIVE (fieldOfView set).");
  forbid(/usesOrthographicProjection/, "the immersive camera must NOT be orthographic.");
  req(/resetCameraFraming/, "immersive VC must support Reset framing.");
  req(/roadPartsXsZs/, "immersive VC must render the clipped road PARTS independently.");
  req(/worldForEast:self\.stationEastM/, "immersive camera/focus must sit on the snapped station, not the patch centre.");
  req(/Section truncated by the package boundary/, "immersive VC must state when the section is truncated by the boundary.");
  req(/Not street-level photography/, "must state it is an offline aerial-terrain inspection, not street view.");
  req(/upstation is not verified|packaged upstation bearing/, "must state the orientation provenance.");
  // Part 12E moved the DEFAULT-layout limitation into the container's single provenance
  // control (asserted in the inspection-vc block above), so the immersive scene must NOT
  // restate it — one statement, not two competing ones.
  forbid(/Default roadway assumptions/, "the immersive scene must not duplicate the container's DEFAULT-layout provenance (Part 12E).");
  forbid(NET, "immersive VC must not perform networking (packaged data only).");
  forbid(WRITES, "immersive VC must not write files.");
}

// ---- Inspection container (Immersive | Technical, shared slice) -------------
{
  const code = load("ErisInspectionViewController.m");
  const { req, forbid } = checker("inspection-vc", code);
  req(/UISegmentedControl/, "must expose an Immersive|Technical segmented control.");
  req(/@"Immersive"/, "must offer the Immersive mode.");
  req(/@"Technical"/, "must offer the Technical mode.");
  req(/ErisImmersiveCorridorViewController/, "must host the immersive corridor child.");
  req(/ErisRoadSliceSceneViewController/, "must host the technical orthographic child.");
  req(/initWithSlice:self\.slice/, "both children must share the same slice model.");
  // Part 12E superseded the acknowledgment PANEL with ONE compact expandable provenance
  // control: the DEFAULT-layout limitation is still stated (never dropped), but it is no
  // longer a second acknowledgment on top of the map's. See
  // check-eris-divided-corridor-native-contract.mjs for the provenance-UX contract.
  req(/Default roadway template — not observed geometry/, "must still state the DEFAULT-layout limitation.");
  req(/DEFAULT one-lane-each-way \(32 ft\) template — NOT real highway geometry/,
      "a DEFAULT primary highway must still carry the not-real-geometry wording.");
  forbid(/@"Acknowledge"/, "the inspection container must not add a second Acknowledge control (Part 12E).");
  forbid(NET, "inspection container must not perform networking.");
  forbid(WRITES, "inspection container must not write files.");
}

// ---- Technical slice VC still orthographic + honest -------------------------
{
  const code = load("ErisRoadSliceSceneViewController.m");
  const { req } = checker("slice-vc", code);
  req(/usesOrthographicProjection/, "the Technical cutaway must stay orthographic.");
  req(/resetCameraFraming/, "must expose resetCameraFraming for the container Reset.");
  req(/upstation is not verified/, "must warn when orientation is only geometry-derived.");
}

if (errors.length > 0) {
  console.error("Highway-cross-section source-contract FAILED:\n  - " + errors.join("\n  - "));
  process.exit(1);
}
console.log(
  "Highway immersive cross-section source-contract OK — metre-derived draping, restrained incident marker, " +
    "class-aware roads + Road Display, highway-first bounded selection, confirmation card, animated camera transition, " +
    "Immersive|Technical shared-slice inspection, truthful orientation/default-layout warnings, fully offline.",
);

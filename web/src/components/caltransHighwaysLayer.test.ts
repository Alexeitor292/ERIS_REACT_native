// The optional online Caltrans layer must be genuinely OPT-IN: with no configured URL the
// map constructs no layer at all (and therefore makes no request to the public service).
//
// Run: node --experimental-strip-types --test src/components/caltransHighwaysLayer.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CALTRANS_ATTRIBUTION,
  CALTRANS_DEFINITION_EXPRESSION,
  CALTRANS_LAYER_TITLE,
  caltransHighwaysLayerConfig,
} from "./caltransHighwaysLayer.ts";

const PUBLIC_URL =
  "https://caltrans-gis.dot.ca.gov/arcgis/rest/services/CHhighway/CRS_Functional_Classification/FeatureServer/0";

test("missing env -> no Caltrans layer is constructed", () => {
  assert.equal(caltransHighwaysLayerConfig(undefined), null);
  assert.equal(caltransHighwaysLayerConfig(null), null);
});

test("empty / whitespace env -> no Caltrans layer is constructed", () => {
  assert.equal(caltransHighwaysLayerConfig(""), null);
  assert.equal(caltransHighwaysLayerConfig("   "), null);
});

test("configured public URL -> exactly one initially invisible layer", () => {
  const cfg = caltransHighwaysLayerConfig(PUBLIC_URL);
  assert.ok(cfg, "expected a layer config");
  assert.equal(cfg.url, PUBLIC_URL);
  assert.equal(cfg.visible, false); // off until the operator toggles it on
  assert.equal(cfg.title, CALTRANS_LAYER_TITLE);
});

test("definitionExpression stays the freeway/expressway scope", () => {
  const cfg = caltransHighwaysLayerConfig(PUBLIC_URL)!;
  assert.equal(cfg.definitionExpression, "F_System IN (1, 2)");
  assert.equal(cfg.definitionExpression, CALTRANS_DEFINITION_EXPRESSION);
});

test("attribution is the trusted built-in Caltrans credit", () => {
  const cfg = caltransHighwaysLayerConfig(PUBLIC_URL)!;
  assert.equal(cfg.copyright, CALTRANS_ATTRIBUTION);
  assert.match(cfg.copyright, /California Department of Transportation \(Caltrans\)/);
});

test("wording claims functional classification, never ownership", () => {
  const cfg = caltransHighwaysLayerConfig(PUBLIC_URL)!;
  const blob = JSON.stringify(cfg).toLowerCase();
  assert.ok(!blob.includes("state highway system"));
  assert.ok(!blob.includes("caltrans-owned"));
  assert.ok(blob.includes("functional classification"));
});

test("a surrounding URL is trimmed rather than treated as configured", () => {
  const cfg = caltransHighwaysLayerConfig(`  ${PUBLIC_URL}  `);
  assert.equal(cfg?.url, PUBLIC_URL);
});

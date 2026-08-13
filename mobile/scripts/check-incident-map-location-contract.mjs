#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const controllerPath = join(
  HERE,
  "..",
  "plugins",
  "arcgis-ios",
  "ArcGisSketchViewController.m",
);
const source = readFileSync(controllerPath, "utf8");

const required = [
  [
    /AGSGraphicsOverlay\s*\*incidentLocationOverlay/,
    "the sketch map must own a dedicated incident-location graphics overlay",
  ],
  [
    /\[self\.mapView\.graphicsOverlays addObject:self\.incidentLocationOverlay\]/,
    "the incident overlay must be attached to the ArcGIS map view",
  ],
  [
    /renderIncidentLocationMarkerAtPoint:/,
    "the incident coordinates must be rendered as a graphic, not only used as a viewpoint",
  ],
  [
    /AGSSimpleMarkerSymbolStyleDiamond/,
    "the incident marker must remain visually distinct from the ArcGIS blue GPS dot",
  ],
  [
    /@"title":\s*@"Incident Location"/,
    "the marker graphic must retain incident-location identity",
  ],
  [
    /\[self renderIncidentLocationMarkerAtPoint:point\]/,
    "centering on the saved incident location must also render its marker",
  ],
  [
    /self\.mapView\.locationDisplay\.autoPanMode\s*=\s*AGSLocationDisplayAutoPanModeOff/,
    "phone GPS display must remain a separate ArcGIS location-display layer",
  ],
  [
    /AGSPoint\s*\*current\s*=\s*self\.mapView\.locationDisplay\.mapLocation/,
    "Locate must continue to target the phone GPS position rather than the incident",
  ],
];

const failures = required
  .filter(([pattern]) => !pattern.test(source))
  .map(([, message]) => message);

if (failures.length) {
  console.error("Incident map location contract FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  "Incident map location contract OK — saved incident marker and phone GPS remain distinct.",
);

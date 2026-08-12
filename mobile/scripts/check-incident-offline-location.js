const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function requireText(source, text, label) {
  if (!source.includes(text)) {
    throw new Error(`Missing ${label}: ${text}`);
  }
}

const createScreen = read("src/components/CreateIncidentScreen.tsx");
const roadOffline = read("src/services/roadInventoryOffline.ts");
const incidentQueue = read("src/offline/incidentQueue.ts");
const syncLoop = read("src/offline/syncLoop.ts");
const createRoute = read("app/(tabs)/incidents/create.tsx");

requireText(createScreen, '["GPS", "GPS Autofill"]', "GPS entry mode");
requireText(createScreen, '["COORDINATES", "Coordinates"]', "coordinate entry mode");
requireText(createScreen, '["ROAD", "Road / Post Mile"]', "road/postmile entry mode");
requireText(createScreen, 'Platform.OS === "ios" ? "numbers-and-punctuation" : "numeric"', "iOS signed coordinate keyboard");
requireText(createScreen, 'placeholder="-121.494400"', "negative longitude affordance");
requireText(createScreen, "lookupLocalLocationByCoordinates", "offline coordinates-to-road resolver");
requireText(createScreen, "lookupLocalCoordinatesByRoad", "offline road-to-coordinates resolver");
requireText(createScreen, "enqueueIncidentForSync(payload, pendingFiles)", "durable-first incident save");
requireText(createScreen, "Incident Saved Offline", "offline-save user confirmation");

requireText(roadOffline, "postmile_points", "schema-v2 postmile reference persistence");
requireText(roadOffline, "lookupLocalLocationByCoordinates", "coordinates-to-road implementation");
requireText(roadOffline, "lookupLocalCoordinatesByRoad", "road-to-coordinates implementation");
requireText(roadOffline, "CALTRANS_SHN_POSTMILES_TENTH_OFFLINE", "offline provenance");

requireText(incidentQueue, "serverIncidentId", "persisted server incident checkpoint");
requireText(incidentQueue, "lastCreateAttemptAt", "persisted create-attempt checkpoint");
requireText(incidentQueue, "UNCERTAIN_CREATE_WINDOW_MS", "bounded uncertain-create reconciliation window");
requireText(incidentQueue, "reconcileUncertainCreate", "fail-closed uncertain-create reconciliation");
requireText(incidentQueue, "await persist(next);", "pre/post mutation durable checkpoint");
requireText(incidentQueue, "uploaded: true", "per-file upload checkpoint");
requireText(syncLoop, "flushQueuedIncidents", "automatic incident retry loop");
requireText(createRoute, "CreateIncidentScreen", "dedicated Create Incident route");

console.log("Incident offline location contract: OK");

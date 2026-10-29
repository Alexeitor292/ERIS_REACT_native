// Writes ERISKit's parity fixtures from the Expo app's own TypeScript, so the
// Swift ports are tested against the reference implementation's output rather
// than hand-worked values. Needs Node 22.18+ (TypeScript type stripping).
//
//   node ios/scripts/make-parity-fixtures.mjs
//
// The mobile/ sources import each other without file extensions, which Node's
// loader refuses, so they are copied to a temporary folder with the
// extensions added. Nothing in mobile/ is changed.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtures = join(repo, "ios", "ERISKit", "Tests", "ERISKitTests", "Fixtures");
const work = mkdtempSync(join(tmpdir(), "eris-parity-"));

function stage(names, folder = "utils") {
  for (const name of names) {
    const source = readFileSync(join(repo, "mobile", "src", folder, `${name}.ts`), "utf8");
    writeFileSync(join(work, `${name}.ts`), source
      .replace(/from "\.\/([A-Za-z]+)"/g, 'from "./$1.ts"')
      // expo-location is imported for its types only; Node cannot load it.
      .replace(/^import \* as Location from "expo-location";$/m, ""));
  }
}

try {
  stage(["precision", "caltransLookups", "californiaCoordinateSystem"]);
  const P = await import(pathToFileURL(join(work, "precision.ts")).href);
  const C = await import(pathToFileURL(join(work, "caltransLookups.ts")).href);
  const S = await import(pathToFileURL(join(work, "californiaCoordinateSystem.ts")).href);

  const points = [
    [37.7312, -122.1975, "ALA"], [40.8021, -124.1637, "HUM"], [34.0522, -118.2437, "LA"],
    [32.7157, -117.1611, "SD"], [38.5816, -121.4944, "SAC"], [36.7378, -119.7871, "FRE"],
  ];
  const out = {
    postMile: ["12.3", "12.345", "1.005", "0.995", "-2.5", "abc", "  7 ", "1e2", "", "12.3abc", "Infinity", "0x10"]
      .map((value) => ({ input: value, output: P.normalizePostMileValue(value) })),
    route: ["80", "I-5", "SR 1", "1234", "abc", "", " 99 ", "US-101X"]
      .map((value) => ({ input: value, output: P.normalizeRouteValue(value) })),
    coordinate: ["37.7312345678", "-122.19750049", "-0.0000001", "abc", "", "1e-7", "37.0000005", "  -121.5  "]
      .map((value) => ({ input: value, output: P.formatCoordinate(value) })),
    county: ["ALA", "ala", "Alameda", "alameda county", "San Luis Obispo County", "Nowhere", ""]
      .map((value) => ({ input: value, code: C.countyCodeFromNameOrCode(value), district: C.districtForCounty(value),
                         label: C.countyDisplayLabel(value) })),
    routesForSF: C.routesForCounty("SF"),
    districts: C.CALTRANS_DISTRICTS,
    countyCount: C.CALTRANS_COUNTIES.length,
    statePlane: points.map(([latitude, longitude, county]) => {
      const point = S.convertLatLonToCaliforniaStatePlaneFeet({ latitude, longitude, county });
      const back = S.convertCaliforniaStatePlaneFeetToLatLon({ northing: point.northing, easting: point.easting, county });
      return { latitude, longitude, county, zone: point.zone, northing: point.northing, easting: point.easting,
               formattedNorthing: S.formatCaliforniaStatePlaneFeet(point.northing),
               backLatitude: back.latitude, backLongitude: back.longitude };
    }),
  };
  writeFileSync(join(fixtures, "gisa-helpers.json"), JSON.stringify(out, null, 2) + "\n");
  console.log("wrote", join(fixtures, "gisa-helpers.json"));

  stage(["captureMetadata"], "photos");
  const M = await import(pathToFileURL(join(work, "captureMetadata.ts")).href);
  const position = (latitude, longitude, accuracy, altitude) =>
    ({ coords: { latitude, longitude, accuracy, altitude }, timestamp: 0 });
  const direction = (heading, accuracyCode) => ({ heading, accuracyCode, reference: "TRUE_NORTH" });
  const devices = [
    { position: position(37.7312, -122.1975, 4.2, 12.5), direction: direction(123.4, 3) },
    { position: position(37.7312, -122.1975, 35, null), direction: direction(10, 1) },
    { position: null, direction: direction(359.9, 2) },
    { position: position(37.7312, -122.1975, -1, null), direction: null },
    { position: position(95, 10, 5, null), direction: null },
    { position: null, direction: null },
  ].map((input) => ({
    input,
    output: M.photoCaptureMetadataFromDeviceSnapshot({
      capturedAt: "2026-10-28T19:01:10.123Z", position: input.position, cameraDirection: input.direction,
    }),
  }));
  const exifs = [
    { GPSLatitude: 37.7312, GPSLongitude: -122.1975, GPSHPositioningError: 6, GPSAltitude: 14,
      GPSImgDirection: 370, GPSImgDirectionRef: "T", DateTimeOriginal: "2026:10:28 09:15:00" },
    { GPSLatitude: 37.7312, GPSLatitudeRef: "N", GPSLongitude: 122.1975, GPSLongitudeRef: "W",
      GPSImgDirection: -20, GPSImgDirectionRef: "M" },
    { GPSLatitude: [33, 51, 54.5], GPSLatitudeRef: "S", GPSLongitude: [151, 12, 36], GPSLongitudeRef: "E",
      GPSHPositioningError: -3, GPSImgDirectionRef: "Q", DateTime: "2026:01:02 03:04:05" },
    { GPSLatitude: 120, GPSLongitude: 10, GPSImgDirection: 45, GPSImgDirectionRef: "" },
    { DateTimeOriginal: "28/10/2026" },
    {},
  ].map((exif) => ({ exif, output: M.photoCaptureMetadataFromAsset({ assetId: "asset-1", exif }) }));
  const merges = [
    [devices[2].output, exifs[0].output],
    [devices[0].output, exifs[1].output],
    [null, exifs[0].output],
    [devices[0].output, null],
  ].map(([primary, fallback]) => ({ primary, fallback, output: M.mergePhotoCaptureMetadata(primary, fallback) }));
  const headings = [0, 359.999, 360, 725, -10, -370, "abc", null].map((input) => ({ input, output: M.normalizePhotoHeading(input) }));
  writeFileSync(join(fixtures, "photo-capture.json"), JSON.stringify({ devices, exifs, merges, headings }, null, 2) + "\n");
  console.log("wrote", join(fixtures, "photo-capture.json"));

  stage(["buildRoadSectionFromInventory", "buildTerrainAppearance", "buildMeasurementDiagramData"], "measurements");
  const D = await import(pathToFileURL(join(work, "buildMeasurementDiagramData.ts")).href);
  const T = await import(pathToFileURL(join(work, "buildTerrainAppearance.ts")).href);
  // The road cross-section cases are shared with the backend; copied as they are.
  const roadSections = JSON.parse(readFileSync(
    join(repo, "mobile", "src", "measurements", "__fixtures__", "roadCrossSectionParity.json"), "utf8"));
  const forms = [
    {},
    { material_soil: "YES" },
    { material_rock: "YES", material_joints: "YES", material_fractures: "yes", est_gravel_pct: "30", est_boulder_pct: "12" },
    { material_soil: "YES", material_rock: "YES", est_soil_pct: "60", est_rock_pct: "40", est_clay_pct: "35",
      est_sand_pct: "20", water_wet: "YES", water_seep: "YES", vegetation_trees: "40", vegetation_groundcover: "80",
      material_pavement_type: "asphalt" },
    { water_flowing: "YES", water_moist: "YES", vegetation_bushes_shrubs: "150", est_rock_pct: "-5",
      material_bedding: "YES", material_pavement_type: "CONCRETE" },
    { water_moist: " yes ", est_soil_pct: "abc", est_sand_pct: " 45 ", material_pavement_type: "GRAVEL" },
  ];
  const terrain = forms.map((form) => {
    const appearance = T.buildTerrainAppearance(form);
    return { form, appearance, palette: T.buildTerrainPalette(appearance) };
  });
  const diagrams = [
    { form: { measure_slope_height_ft: "40", measure_original_slope_deg: "35.5", measure_roadway_width_ft: "24 ft",
              measure_landslide_width_ft: "abc", measure_main_scarp_height_ft: " 6 ", measure_landslide_slope_deg: "1e1",
              measure_roadway_length_ft: ".5", measure_landslide_length_ft: "" },
      snapshot: null, template: "AUTO", failureSide: "LT", terrain: "AUTO", profile: { classification: "BOWL" } },
    { form: {}, snapshot: { left_lanes: 2, right_lanes: 2 }, template: "LANDSLIDE_ABOVE_ROAD", failureSide: "BOTH",
      terrain: "CROWN", profile: { classification: "LEFT_HIGH" } },
    { form: { measure_roadway_width_ft: "Infinity" }, snapshot: null, template: "LANDSLIDE_BELOW_ROAD_SLIPOUT",
      failureSide: "RT", terrain: "AUTO", profile: { classification: "UNKNOWN" } },
    { form: {}, snapshot: {}, template: "AUTO", failureSide: "LT", terrain: "AUTO", profile: null },
  ].map((input) => ({ input, output: D.buildMeasurementDiagramData(
    input.form, input.snapshot, input.template, input.failureSide, input.terrain, input.profile) }));
  writeFileSync(join(fixtures, "measurement-diagram.json"),
    JSON.stringify({ roadSections, terrain, diagrams }, null, 2) + "\n");
  console.log("wrote", join(fixtures, "measurement-diagram.json"));
} finally {
  rmSync(work, { recursive: true, force: true });
}

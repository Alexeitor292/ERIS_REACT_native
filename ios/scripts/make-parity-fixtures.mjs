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

function stage(names) {
  for (const name of names) {
    const source = readFileSync(join(repo, "mobile", "src", "utils", `${name}.ts`), "utf8");
    writeFileSync(join(work, `${name}.ts`), source.replace(/from "\.\/([A-Za-z]+)"/g, 'from "./$1.ts"'));
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
} finally {
  rmSync(work, { recursive: true, force: true });
}

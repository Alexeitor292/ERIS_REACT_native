import assert from "node:assert/strict";
import test from "node:test";

import { flownAfter, isoDate, monthYearRange, pickEsriSource, pickUsgsSource, terrainSourceText } from "./terrainSourceModel.ts";

// What the USGS 3DEP index returns at Mud Creek (Route 1, Big Sur).
const oneMeter = [{ project: "CA_AZ_FEMA_R9_Lidar_2017_D18", metadata_link: "http://prd-tnm.s3.amazonaws.com/metadata/CA_AZ_FEMA_R9_Lidar_2017_D18" }];
const units = [
  { workunit: "CA_WestCoastElNinoUTM10_2016", project: "CA_West_Coast_LiDAR_2016_B16", collect_start: 1461801600000, collect_end: 1464393600000, onemeter_category: "Does not meet" },
  { workunit: "CA_FEMA_Z4_B2_2018", project: "CA_AZ_FEMA_R9_Lidar_2017_D18", collect_start: 1516579200000, collect_end: 1524355200000, onemeter_category: "Meets", metadata_link: "https://prd-tnm.s3.amazonaws.com/metadata/CA_FEMA_Z4_B2_2018" },
];

test("the 1 m DEM names the lidar it was made from, and when that was flown", () => {
  const source = pickUsgsSource(oneMeter, units, [])!;
  assert.equal(source.project, "CA_FEMA_Z4_B2_2018");
  assert.equal(source.flownFrom, "2018-01-22");
  assert.equal(source.flownTo, "2018-04-22");
  assert.equal(terrainSourceText(source), "USGS 3DEP 1 m lidar · flown Jan–Apr 2018");
  // Flown after the Mud Creek surveys of May 2017: it may already show the slide.
  assert.equal(flownAfter(source, "2017-05-27"), true);
  assert.equal(flownAfter(source, "2019-01-01"), false);
});

test("without a 1 m DEM, the 1/3 arc-second project; outside 3DEP, Esri's finest dataset", () => {
  const third = pickUsgsSource([], [], [{ project: "CA_Statewide_2009", collect_start: "11/3/2009", collect_end: "2/14/2010" }])!;
  assert.equal(terrainSourceText(third), "USGS 3DEP 1/3 arc-second · flown Nov 2009 – Feb 2010");
  const esri = pickEsriSource([
    { layerId: 5, attributes: { ProductName: "SRTM_1_arcsec", Date_Start: "2/1/2000", Date_End: "3/1/2000" } },
    { layerId: 7, attributes: { ProductName: "SRTM", Date_Start: "2/1/2000", Date_End: "3/1/2000" } },
  ])!;
  assert.equal(terrainSourceText(esri), "Esri World Elevation SRTM 1 arcsec · 2000");
  assert.equal(flownAfter(esri, "1999-01-01"), false); // a whole dataset's span says nothing about one place
  assert.equal(pickUsgsSource([], [], []), null);
});

test("dates read from either form the services use", () => {
  assert.equal(isoDate(1516579200000), "2018-01-22");
  assert.equal(isoDate("1/6/2018"), "2018-01-06");
  assert.equal(isoDate(""), null);
  assert.equal(monthYearRange("2018-01-22", "2018-01-30"), "Jan 2018");
  assert.equal(monthYearRange("2003-07-23", "2025-01-22", true), "2003–2025");
});

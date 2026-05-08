import { countyCodeFromNameOrCode } from "./caltransLookups";

type CaliforniaZone = 1 | 2 | 3 | 4 | 5 | 6;

type ZoneConstants = {
  zone: CaliforniaZone;
  Bo: number;
  Lo: number;
  SinBo: number;
  Rb: number;
  Ro: number;
  Nb: number;
  No: number;
  Eo: number;
  L1: number;
  L2: number;
  L3: number;
  L4: number;
};

export type CaliforniaStatePlanePoint = {
  countyCode: string;
  zone: CaliforniaZone;
  northing: number;
  easting: number;
  units: "US survey ft";
};

export type CaliforniaLatLonPoint = {
  countyCode: string;
  zone: CaliforniaZone;
  latitude: number;
  longitude: number;
};

const DEG_TO_RAD = Math.PI / 180;

const COUNTY_ZONE_BY_CODE: Record<string, CaliforniaZone> = {
  DN: 1,
  SIS: 1,
  MOD: 1,
  HUM: 1,
  TRI: 1,
  SHA: 1,
  LAS: 1,
  TEH: 1,
  PLU: 1,
  MEN: 2,
  GLE: 2,
  BUT: 2,
  SIE: 2,
  LAK: 2,
  COL: 2,
  YUB: 2,
  NEV: 2,
  SUT: 2,
  PLA: 2,
  SON: 2,
  NAP: 2,
  YOL: 2,
  SOL: 2,
  SAC: 2,
  ED: 2,
  AMA: 2,
  ALP: 2,
  MRN: 3,
  CC: 3,
  SJ: 3,
  CAL: 3,
  TUO: 3,
  ALA: 3,
  SF: 3,
  SM: 3,
  SCR: 3,
  SCL: 3,
  STA: 3,
  MER: 3,
  MPA: 3,
  MAD: 3,
  MNO: 3,
  FRE: 4,
  SBT: 4,
  MON: 4,
  KIN: 4,
  TUL: 4,
  INY: 4,
  SLO: 5,
  KER: 5,
  SB: 5,
  VEN: 5,
  LA: 5,
  SBD: 5,
  ORA: 6,
  RIV: 6,
  SD: 6,
  IMP: 6,
};

// CCS83 / US survey foot constants from the Caltrans LS-LSIT Unit 11 reference.
const ZONE_CONSTANTS: Record<CaliforniaZone, ZoneConstants> = {
  1: { zone: 1, Bo: 40.8351061249, Lo: 122.0, SinBo: 0.6538843054, Rb: 24791796.351, Ro: 24244708.924, Nb: 1640416.667, No: 2187504.093, Eo: 6561666.667, L1: 364300.5191, L2: 31.6772, L3: 18.4872, L4: 0.0698 },
  2: { zone: 2, Bo: 39.0846839219, Lo: 122.0, SinBo: 0.630468335285, Rb: 26311590.85, Ro: 25795162.985, Nb: 1640416.667, No: 2156844.531, Eo: 6561666.667, L1: 364197.5131, L2: 31.3198, L3: 18.4998, L4: 0.065577 },
  3: { zone: 3, Bo: 37.7510694363, Lo: 120.5, SinBo: 0.612232038295, Rb: 27512330.711, Ro: 27056804.05, Nb: 1640416.667, No: 2095943.327, Eo: 6561666.667, L1: 364119.7127, L2: 30.9692, L3: 18.5086, L4: 0.062493 },
  4: { zone: 4, Bo: 36.6258593071, Lo: 119.0, SinBo: 0.59658714988, Rb: 28652263.494, Ro: 28181724.783, Nb: 1640416.667, No: 2110955.377, Eo: 6561666.667, L1: 364054.6183, L2: 30.6211, L3: 18.5174, L4: 0.060308 },
  5: { zone: 5, Bo: 34.7510553142, Lo: 118.0, SinBo: 0.570011896174, Rb: 30648744.932, Ro: 30193453.753, Nb: 1640416.667, No: 2095707.846, Eo: 6561666.667, L1: 363934.259, L2: 29.9356, L3: 18.5303, L4: 0.057234 },
  6: { zone: 6, Bo: 33.3339229447, Lo: 116.25, SinBo: 0.549517575763, Rb: 32270577.813, Ro: 31845868.317, Nb: 1640416.667, No: 2065126.163, Eo: 6561666.667, L1: 363861.895, L2: 29.3368, L3: 18.5396, L4: 0.053054 },
};

function normalizeWestLongitude(longitude: number): number {
  return longitude < 0 ? -longitude : longitude;
}

function solveDeltaLatitude(zone: ZoneConstants, u: number): number {
  let deltaLatitude = u / zone.L1;

  for (let idx = 0; idx < 8; idx += 1) {
    const deltaSquared = deltaLatitude * deltaLatitude;
    const deltaCubed = deltaSquared * deltaLatitude;
    const deltaFourth = deltaCubed * deltaLatitude;
    const value =
      zone.L1 * deltaLatitude +
      zone.L2 * deltaSquared +
      zone.L3 * deltaCubed +
      zone.L4 * deltaFourth -
      u;
    if (Math.abs(value) < 1e-12) break;

    const derivative =
      zone.L1 +
      2 * zone.L2 * deltaLatitude +
      3 * zone.L3 * deltaSquared +
      4 * zone.L4 * deltaCubed;
    if (!Number.isFinite(derivative) || Math.abs(derivative) < 1e-12) break;

    deltaLatitude -= value / derivative;
  }

  return deltaLatitude;
}

export function getCaliforniaStatePlaneZone(county?: string | null): CaliforniaZone | null {
  const countyCode = countyCodeFromNameOrCode(county);
  if (!countyCode) return null;
  return COUNTY_ZONE_BY_CODE[countyCode] ?? null;
}

export function convertLatLonToCaliforniaStatePlaneFeet({
  latitude,
  longitude,
  county,
}: {
  latitude: number;
  longitude: number;
  county?: string | null;
}): CaliforniaStatePlanePoint | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const countyCode = countyCodeFromNameOrCode(county);
  if (!countyCode) return null;

  const zoneNumber = COUNTY_ZONE_BY_CODE[countyCode];
  if (!zoneNumber) return null;

  const zone = ZONE_CONSTANTS[zoneNumber];
  const westLongitude = normalizeWestLongitude(longitude);
  const deltaLatitude = latitude - zone.Bo;
  const u = deltaLatitude * (zone.L1 + deltaLatitude * (zone.L2 + deltaLatitude * (zone.L3 + zone.L4 * deltaLatitude)));
  const mappingRadius = zone.Ro - u;
  const convergenceDegrees = (zone.Lo - westLongitude) * zone.SinBo;
  const convergenceRadians = convergenceDegrees * DEG_TO_RAD;
  const northing = zone.Rb + zone.Nb - mappingRadius * Math.cos(convergenceRadians);
  const easting = zone.Eo + mappingRadius * Math.sin(convergenceRadians);

  return {
    countyCode,
    zone: zoneNumber,
    northing,
    easting,
    units: "US survey ft",
  };
}

export function convertCaliforniaStatePlaneFeetToLatLon({
  northing,
  easting,
  county,
}: {
  northing: number;
  easting: number;
  county?: string | null;
}): CaliforniaLatLonPoint | null {
  if (!Number.isFinite(northing) || !Number.isFinite(easting)) return null;

  const countyCode = countyCodeFromNameOrCode(county);
  if (!countyCode) return null;

  const zoneNumber = COUNTY_ZONE_BY_CODE[countyCode];
  if (!zoneNumber) return null;

  const zone = ZONE_CONSTANTS[zoneNumber];
  const northingOffset = zone.Rb + zone.Nb - northing;
  const eastingOffset = easting - zone.Eo;
  const mappingRadius = Math.hypot(northingOffset, eastingOffset);
  const convergenceRadians = Math.atan2(eastingOffset, northingOffset);
  const convergenceDegrees = convergenceRadians / DEG_TO_RAD;
  const westLongitude = zone.Lo - convergenceDegrees / zone.SinBo;
  const u = zone.Ro - mappingRadius;
  const latitude = zone.Bo + solveDeltaLatitude(zone, u);
  const longitude = -westLongitude;

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  return {
    countyCode,
    zone: zoneNumber,
    latitude,
    longitude,
  };
}

export function formatCaliforniaStatePlaneFeet(value: number): string {
  if (!Number.isFinite(value)) return "";
  return value.toFixed(3);
}

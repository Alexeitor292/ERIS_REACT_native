export type CaltransCounty = {
  code: string;
  name: string;
  district: string;
  routes: string[];
};

export const CALTRANS_COUNTIES: CaltransCounty[] = [
  { code: "ALA", name: "Alameda", district: "04", routes: ["13", "24", "61", "77", "80", "84", "92", "112", "123", "185", "205", "238", "260", "262", "580", "680", "880", "980"] },
  { code: "ALP", name: "Alpine", district: "10", routes: ["4", "88", "89", "207"] },
  { code: "AMA", name: "Amador", district: "10", routes: ["16", "26", "49", "88", "104", "124"] },
  { code: "BUT", name: "Butte", district: "02", routes: ["32", "70", "99", "149", "162", "191"] },
  { code: "CAL", name: "Calaveras", district: "10", routes: ["4", "12", "26", "49"] },
  { code: "COL", name: "Colusa", district: "03", routes: ["5", "16", "20", "45"] },
  { code: "CC", name: "Contra Costa", district: "04", routes: ["4", "24", "80", "123", "160", "242", "580", "680"] },
  { code: "DN", name: "Del Norte", district: "01", routes: ["101", "169", "197", "199"] },
  { code: "ED", name: "El Dorado", district: "03", routes: ["49", "50", "89", "153", "193"] },
  { code: "FRE", name: "Fresno", district: "06", routes: ["5", "33", "41", "43", "63", "99", "145", "168", "180", "198", "201", "245", "269"] },
  { code: "GLE", name: "Glenn", district: "03", routes: ["5", "32", "45", "162"] },
  { code: "HUM", name: "Humboldt", district: "01", routes: ["36", "96", "101", "169", "200", "211", "254", "255", "271", "283", "299"] },
  { code: "IMP", name: "Imperial", district: "11", routes: ["7", "8", "78", "86", "98", "111", "115", "186"] },
  { code: "INY", name: "Inyo", district: "09", routes: ["6", "127", "136", "168", "178", "190", "395"] },
  { code: "KER", name: "Kern", district: "06", routes: ["5", "14", "33", "41", "43", "46", "58", "65", "99", "119", "155", "166", "178", "184", "202", "204", "223", "395"] },
  { code: "KIN", name: "Kings", district: "06", routes: ["5", "33", "41", "43", "137", "198", "269"] },
  { code: "LAK", name: "Lake", district: "01", routes: ["20", "29", "53", "175", "281"] },
  { code: "LAS", name: "Lassen", district: "02", routes: ["36", "44", "70", "139", "147", "299", "395"] },
  { code: "LA", name: "Los Angeles", district: "07", routes: ["1", "2", "5", "10", "14", "18", "22", "23", "27", "39", "47", "57", "60", "66", "71", "72", "90", "91", "101", "103", "105", "107", "110", "118", "126", "134", "138", "164", "170", "187", "210", "213", "405", "605", "710"] },
  { code: "MAD", name: "Madera", district: "06", routes: ["41", "49", "59", "99", "145", "152", "233"] },
  { code: "MRN", name: "Marin", district: "04", routes: ["1", "37", "101", "131", "580"] },
  { code: "MPA", name: "Mariposa", district: "06", routes: ["41", "49", "120", "132", "140"] },
  { code: "MEN", name: "Mendocino", district: "01", routes: ["1", "20", "101", "128", "162", "175", "222", "253", "271"] },
  { code: "MER", name: "Merced", district: "10", routes: ["5", "33", "59", "99", "140", "152", "165"] },
  { code: "MOD", name: "Modoc", district: "02", routes: ["139", "299", "395"] },
  { code: "MNO", name: "Mono", district: "09", routes: ["6", "89", "108", "120", "158", "167", "168", "182", "203", "266", "270", "395"] },
  { code: "MON", name: "Monterey", district: "05", routes: ["1", "25", "68", "101", "146", "156", "183", "198", "218"] },
  { code: "NAP", name: "Napa", district: "04", routes: ["12", "29", "80", "121", "128", "221"] },
  { code: "NEV", name: "Nevada", district: "03", routes: ["20", "49", "80", "89", "174", "267"] },
  { code: "ORA", name: "Orange", district: "12", routes: ["1", "5", "22", "39", "55", "57", "72", "73", "74", "90", "91", "133", "142", "241", "261", "405", "605"] },
  { code: "PLA", name: "Placer", district: "03", routes: ["20", "28", "49", "65", "80", "89", "174", "193", "267"] },
  { code: "PLU", name: "Plumas", district: "02", routes: ["36", "49", "70", "89", "147", "284"] },
  { code: "RIV", name: "Riverside", district: "08", routes: ["10", "15", "60", "62", "71", "74", "78", "79", "86", "91", "95", "111", "177", "215", "243", "371"] },
  { code: "SAC", name: "Sacramento", district: "03", routes: ["5", "12", "16", "50", "51", "80", "99", "104", "160", "220", "244", "275"] },
  { code: "SBT", name: "San Benito", district: "05", routes: ["25", "101", "129", "146", "156"] },
  { code: "SBD", name: "San Bernardino", district: "08", routes: ["2", "10", "15", "18", "38", "40", "58", "60", "62", "66", "71", "83", "95", "127", "138", "142", "173", "178", "189", "210", "215", "247", "259", "330", "395"] },
  { code: "SD", name: "San Diego", district: "11", routes: ["5", "8", "11", "15", "52", "54", "56", "67", "75", "76", "78", "79", "94", "125", "163", "188", "282", "805", "905"] },
  { code: "SF", name: "San Francisco", district: "04", routes: ["1", "35", "80", "82", "101", "280"] },
  { code: "SJ", name: "San Joaquin", district: "10", routes: ["4", "5", "12", "26", "33", "88", "99", "120", "132", "205", "580"] },
  { code: "SLO", name: "San Luis Obispo", district: "05", routes: ["1", "33", "41", "46", "58", "101", "166", "227", "229"] },
  { code: "SM", name: "San Mateo", district: "04", routes: ["1", "9", "35", "82", "84", "92", "101", "109", "114", "280", "380"] },
  { code: "SB", name: "Santa Barbara", district: "05", routes: ["1", "33", "101", "135", "144", "150", "154", "166", "192", "217", "246"] },
  { code: "SCL", name: "Santa Clara", district: "04", routes: ["9", "17", "25", "35", "82", "85", "87", "101", "130", "152", "156", "237", "280", "680", "880"] },
  { code: "SCR", name: "Santa Cruz", district: "05", routes: ["1", "9", "17", "35", "129", "152", "236"] },
  { code: "SHA", name: "Shasta", district: "02", routes: ["5", "36", "44", "89", "151", "273", "299"] },
  { code: "SIE", name: "Sierra", district: "03", routes: ["49", "80", "89", "395"] },
  { code: "SIS", name: "Siskiyou", district: "02", routes: ["3", "5", "89", "96", "97", "139", "161", "263", "265"] },
  { code: "SOL", name: "Solano", district: "04", routes: ["12", "29", "37", "80", "84", "113", "128", "220", "505", "680", "780"] },
  { code: "SON", name: "Sonoma", district: "04", routes: ["1", "12", "37", "101", "116", "121", "128"] },
  { code: "STA", name: "Stanislaus", district: "10", routes: ["4", "5", "33", "99", "108", "120", "132", "165", "219"] },
  { code: "SUT", name: "Sutter", district: "03", routes: ["20", "70", "99", "113"] },
  { code: "TEH", name: "Tehama", district: "02", routes: ["5", "32", "36", "89", "99", "172"] },
  { code: "TRI", name: "Trinity", district: "02", routes: ["3", "36", "299"] },
  { code: "TUL", name: "Tulare", district: "06", routes: ["43", "63", "65", "99", "137", "180", "190", "198", "201", "216", "245"] },
  { code: "TUO", name: "Tuolumne", district: "10", routes: ["49", "108", "120", "132"] },
  { code: "VEN", name: "Ventura", district: "05", routes: ["1", "23", "33", "34", "101", "118", "126", "150", "232"] },
  { code: "YOL", name: "Yolo", district: "03", routes: ["5", "16", "45", "50", "80", "84", "113", "128", "275", "505"] },
  { code: "YUB", name: "Yuba", district: "03", routes: ["20", "49", "65", "70"] },
];

const COUNTY_BY_CODE = new Map(CALTRANS_COUNTIES.map((c) => [c.code, c]));
const COUNTY_BY_NAME = new Map(CALTRANS_COUNTIES.map((c) => [c.name.toLowerCase(), c]));

export const CALTRANS_DISTRICTS = Array.from(
  new Set(CALTRANS_COUNTIES.map((c) => String(Number(c.district))))
).sort((a, b) => Number(a) - Number(b));

export const CALIFORNIA_COUNTIES = CALTRANS_COUNTIES.map((c) => c.name).sort();

function normalizeDistrict(district?: string | null): string | null {
  const raw = String(district ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isNaN(n) || !Number.isInteger(n) || n < 1 || n > 12) return null;
  return String(n).padStart(2, "0");
}

export function countyNameFromNameOrCode(value?: string | null): string | null {
  const raw = String(value ?? "").replace(/\s+County$/i, "").trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  const byCode = COUNTY_BY_CODE.get(upper);
  if (byCode) return byCode.name;
  const byName = COUNTY_BY_NAME.get(raw.toLowerCase());
  return byName?.name ?? null;
}

export function districtForCounty(value?: string | null): string | null {
  const countyName = countyNameFromNameOrCode(value);
  if (!countyName) return null;
  const county = COUNTY_BY_NAME.get(countyName.toLowerCase());
  if (!county) return null;
  return String(Number(county.district));
}

export function countiesForDistrict(district?: string | null): string[] {
  const d = normalizeDistrict(district);
  if (!d) return [...CALIFORNIA_COUNTIES];
  return CALTRANS_COUNTIES.filter((c) => c.district === d).map((c) => c.name).sort();
}

export function routesForCounty(value?: string | null): string[] {
  const countyName = countyNameFromNameOrCode(value);
  if (!countyName) return [];
  const county = COUNTY_BY_NAME.get(countyName.toLowerCase());
  return county ? county.routes.map((route) => normalizeRouteInput(route)) : [];
}

export function routesForDistrictCounty(district?: string | null, county?: string | null): string[] {
  const d = normalizeDistrict(district);
  const countyName = countyNameFromNameOrCode(county);
  if (!d || !countyName) return [];
  const c = COUNTY_BY_NAME.get(countyName.toLowerCase());
  if (!c || c.district !== d) return [];
  return c.routes.map((route) => normalizeRouteInput(route));
}
import { normalizeRouteInput } from "./precision";

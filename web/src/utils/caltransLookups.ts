export const CALTRANS_DISTRICTS = [
  "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12",
] as const;

export const CALIFORNIA_COUNTIES = [
  "Alameda", "Alpine", "Amador", "Butte", "Calaveras", "Colusa", "Contra Costa",
  "Del Norte", "El Dorado", "Fresno", "Glenn", "Humboldt", "Imperial", "Inyo",
  "Kern", "Kings", "Lake", "Lassen", "Los Angeles", "Madera", "Marin", "Mariposa",
  "Mendocino", "Merced", "Modoc", "Mono", "Monterey", "Napa", "Nevada", "Orange",
  "Placer", "Plumas", "Riverside", "Sacramento", "San Benito", "San Bernardino",
  "San Diego", "San Francisco", "San Joaquin", "San Luis Obispo", "San Mateo",
  "Santa Barbara", "Santa Clara", "Santa Cruz", "Shasta", "Sierra", "Siskiyou",
  "Solano", "Sonoma", "Stanislaus", "Sutter", "Tehama", "Trinity", "Tulare",
  "Tuolumne", "Ventura", "Yolo", "Yuba",
] as const;

const COUNTY_TO_DISTRICT: Record<string, string> = {
  "Del Norte": "1",
  Humboldt: "1",
  Lake: "1",
  Mendocino: "1",

  Lassen: "2",
  Modoc: "2",
  Plumas: "2",
  Shasta: "2",
  Siskiyou: "2",
  Tehama: "2",
  Trinity: "2",

  Butte: "3",
  Colusa: "3",
  "El Dorado": "3",
  Glenn: "3",
  Nevada: "3",
  Placer: "3",
  Sacramento: "3",
  Sierra: "3",
  Sutter: "3",
  Yolo: "3",
  Yuba: "3",

  Alameda: "4",
  "Contra Costa": "4",
  Marin: "4",
  Napa: "4",
  "San Francisco": "4",
  "San Mateo": "4",
  "Santa Clara": "4",
  Solano: "4",
  Sonoma: "4",

  Monterey: "5",
  "San Benito": "5",
  "San Luis Obispo": "5",
  "Santa Barbara": "5",
  "Santa Cruz": "5",

  Fresno: "6",
  Kern: "6",
  Kings: "6",
  Madera: "6",
  Mariposa: "6",
  Merced: "6",
  Tulare: "6",

  "Los Angeles": "7",
  Ventura: "7",

  Riverside: "8",
  "San Bernardino": "8",

  Inyo: "9",
  Mono: "9",

  Alpine: "10",
  Amador: "10",
  Calaveras: "10",
  "San Joaquin": "10",
  Stanislaus: "10",
  Tuolumne: "10",

  Imperial: "11",
  "San Diego": "11",

  Orange: "12",
};

export function districtForCounty(county?: string | null): string | null {
  if (!county) return null;
  const normalized = county.replace(/\s+County$/i, "").trim();
  return COUNTY_TO_DISTRICT[normalized] ?? null;
}


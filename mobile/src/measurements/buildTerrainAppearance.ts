import type { TerrainAppearance, TerrainMoisture } from "./measurementDiagramModel";

type FormValues = Record<string, string | undefined | null>;

export type TerrainPalette = {
  skyTop: string;
  skyBottom: string;
  top: string;
  mid: string;
  deep: string;
  texture: string;
  crack: string;
  moisture: string;
  vegetation: string;
  vegetationDark: string;
  stone: string;
  stoneShade: string;
  road: string;
  roadEdge: string;
  shoulder: string;
  shoulderEdge: string;
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function clamp01(n: number): number {
  return clamp(n, 0, 1);
}

function parsePct(v: string | undefined | null): number | null {
  if (!v || !String(v).trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, 0, 100) : null;
}

function yes(form: FormValues, key: string): boolean {
  return String(form[key] ?? "").trim().toUpperCase() === "YES";
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const parts =
    clean.length === 3
      ? clean.split("").map((ch) => ch + ch)
      : [clean.slice(0, 2), clean.slice(2, 4), clean.slice(4, 6)];
  return parts.map((part) => parseInt(part, 16)) as [number, number, number];
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function mixHex(a: string, b: string, amount: number): string {
  const t = clamp01(amount);
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(
    ar + (br - ar) * t,
    ag + (bg - ag) * t,
    ab + (bb - ab) * t,
  );
}

function shadeHex(hex: string, amount: number): string {
  return amount >= 0
    ? mixHex(hex, "#ffffff", amount)
    : mixHex(hex, "#000000", Math.abs(amount));
}

function resolveMoisture(form: FormValues): TerrainMoisture {
  if (yes(form, "water_flowing")) return "FLOWING";
  if (yes(form, "water_wet")) return "WET";
  if (yes(form, "water_moist")) return "MOIST";
  return "DRY";
}

export function buildTerrainAppearance(form: FormValues): TerrainAppearance {
  const rockSelected = yes(form, "material_rock");
  const soilSelected = yes(form, "material_soil");

  const soilPct = parsePct(form.est_soil_pct) ?? (soilSelected && !rockSelected ? 72 : soilSelected ? 58 : 38);
  const rockPct = parsePct(form.est_rock_pct) ?? (rockSelected && !soilSelected ? 72 : rockSelected ? 54 : 24);
  const clayPct = parsePct(form.est_clay_pct) ?? 0;
  const siltPct = parsePct(form.est_silt_pct) ?? 0;
  const sandPct = parsePct(form.est_sand_pct) ?? 0;
  const gravelPct = parsePct(form.est_gravel_pct) ?? 0;
  const boulderPct = parsePct(form.est_boulder_pct) ?? 0;
  const treesPct = parsePct(form.vegetation_trees) ?? 0;
  const shrubsPct = parsePct(form.vegetation_bushes_shrubs) ?? 0;
  const groundcoverPct = parsePct(form.vegetation_groundcover) ?? 0;

  const moisture = resolveMoisture(form);
  const moistureLevel =
    moisture === "FLOWING" ? 0.95 :
    moisture === "WET" ? 0.72 :
    moisture === "MOIST" ? 0.4 :
    0.1;

  const vegetationDensity = clamp01(
    (treesPct * 0.9 + shrubsPct * 0.65 + groundcoverPct * 0.45) / 100,
  );

  let rockiness = clamp01(
    (
      rockPct * 0.7 +
      gravelPct * 0.18 +
      boulderPct * 0.55 +
      (rockSelected ? 18 : 0) +
      (yes(form, "material_bedding") ? 4 : 0) +
      (yes(form, "material_joints") ? 7 : 0) +
      (yes(form, "material_fractures") ? 10 : 0)
    ) / 100,
  );

  if (soilSelected && !rockSelected) rockiness *= 0.7;
  if (rockSelected && !soilSelected) rockiness = Math.max(rockiness, 0.58);
  if (!rockSelected && !soilSelected && rockiness < 0.32) rockiness = 0.34;

  const dominantMaterial =
    rockiness >= 0.62 ? "ROCK" :
    rockiness <= 0.34 ? "SOIL" :
    "MIXED";

  const rawPavement = String(form.material_pavement_type ?? "").trim().toUpperCase();
  const pavementType =
    rawPavement === "CONCRETE" || rawPavement === "ASPHALT"
      ? rawPavement
      : null;

  return {
    dominantMaterial,
    moisture,
    moistureLevel,
    vegetationDensity,
    rockiness,
    soilPct,
    rockPct,
    clayPct,
    siltPct,
    sandPct,
    gravelPct,
    boulderPct,
    treesPct,
    shrubsPct,
    groundcoverPct,
    seep: yes(form, "water_seep"),
    spring: yes(form, "water_spring"),
    bedding: yes(form, "material_bedding"),
    joints: yes(form, "material_joints"),
    fractures: yes(form, "material_fractures"),
    pavementType,
  };
}

export function buildTerrainPalette(appearance: TerrainAppearance): TerrainPalette {
  const clayBias = clamp01(appearance.clayPct / 100);
  const sandBias = clamp01(appearance.sandPct / 100);
  const gravelBias = clamp01((appearance.gravelPct + appearance.boulderPct * 0.45) / 100);

  const soilWarm = mixHex("#6f4f34", "#b08a58", sandBias);
  const soilTone = mixHex(soilWarm, "#8a4f43", clayBias * 0.45);
  const rockTone = mixHex("#59616a", "#8c8478", gravelBias * 0.55);
  const materialTone = mixHex(soilTone, rockTone, appearance.rockiness);

  const top = shadeHex(materialTone, 0.12 - appearance.rockiness * 0.03);
  const mid = shadeHex(materialTone, -0.03 - appearance.moistureLevel * 0.04);
  const deep = shadeHex(materialTone, -0.18 - appearance.moistureLevel * 0.1);
  const texture = mixHex(top, shadeHex(materialTone, -0.28), 0.52);
  const crack = mixHex("#30251d", "#1f2937", appearance.rockiness * 0.75);
  const moisture = mixHex("#25667d", deep, 0.46);
  const vegetation = mixHex(
    mixHex("#456c36", "#76a25b", clamp01(appearance.groundcoverPct / 100)),
    "#7dc46a",
    clamp01(appearance.moistureLevel * 0.45 + appearance.vegetationDensity * 0.25),
  );
  const vegetationDark = shadeHex(vegetation, -0.18);
  const stone = mixHex("#7f7a70", "#9ea4a8", clamp01(appearance.boulderPct / 100));
  const stoneShade = shadeHex(stone, -0.28);

  const road =
    appearance.pavementType === "CONCRETE"
      ? "#7c8795"
      : appearance.pavementType === "ASPHALT"
        ? "#384353"
        : "#435064";
  const roadEdge = shadeHex(road, 0.25);
  const shoulder = mixHex(road, top, 0.25);
  const shoulderEdge = shadeHex(shoulder, 0.2);

  return {
    skyTop: mixHex("#07111f", "#0d1628", appearance.moistureLevel * 0.3),
    skyBottom: mixHex("#132338", "#0f172a", appearance.rockiness * 0.2),
    top,
    mid,
    deep,
    texture,
    crack,
    moisture,
    vegetation,
    vegetationDark,
    stone,
    stoneShade,
    road,
    roadEdge,
    shoulder,
    shoulderEdge,
  };
}

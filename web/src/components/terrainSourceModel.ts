// Where the terrain under a point comes from, and when it was flown: the
// USGS 3DEP project behind the DEM there (US), else the dataset Esri World
// Elevation uses. Pure: terrainSource.ts does the looking up.

export type TerrainSource = {
  /** Who publishes the DEM: "USGS 3DEP", or "Esri World Elevation" outside 3DEP. */
  provider: string;
  /** The DEM product: "1 m lidar", "1/3 arc-second", or Esri's dataset name. */
  product: string;
  /** The USGS project (or work unit) the DEM was built from. */
  project: string | null;
  /** When the data was flown (or, for a dataset Esri only dates as a whole, its span), ISO dates. */
  flownFrom: string | null;
  flownTo: string | null;
  /** True when the dates describe the whole dataset, not this place. */
  datasetDates: boolean;
  link: string | null;
};

type Attributes = Record<string, unknown>;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** An ISO date from what the services return: epoch milliseconds, or "M/D/YYYY". */
export function isoDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString().slice(0, 10);
  if (typeof value !== "string" || !value.trim()) return null;
  const us = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  const iso = value.trim().match(/^\d{4}-\d{2}-\d{2}/);
  return iso ? iso[0] : null;
}

/** "Jan–Apr 2018", "Nov 2017 – Feb 2018", "2018", or "2003–2025" for spans of years. */
export function monthYearRange(from: string | null, to: string | null, yearsOnly = false): string {
  const a = from ? { y: Number(from.slice(0, 4)), m: Number(from.slice(5, 7)) - 1 } : null;
  const b = to ? { y: Number(to.slice(0, 4)), m: Number(to.slice(5, 7)) - 1 } : null;
  const one = a ?? b;
  if (!one) return "";
  if (!a || !b) return yearsOnly ? String(one.y) : `${MONTHS[one.m]} ${one.y}`;
  if (yearsOnly || b.y - a.y > 1) return a.y === b.y ? String(a.y) : `${a.y}–${b.y}`;
  if (a.y === b.y) return a.m === b.m ? `${MONTHS[a.m]} ${a.y}` : `${MONTHS[a.m]}–${MONTHS[b.m]} ${a.y}`;
  return `${MONTHS[a.m]} ${a.y} – ${MONTHS[b.m]} ${b.y}`;
}

/** "USGS 3DEP 1 m lidar · flown Jan–Apr 2018", or "Esri World Elevation · SRTM · 2000". */
export function terrainSourceText(source: TerrainSource): string {
  const when = monthYearRange(source.flownFrom, source.flownTo, source.datasetDates);
  const head = `${source.provider} ${source.product}`.trim();
  if (!when) return head;
  return source.datasetDates ? `${head} · ${when}` : `${head} · flown ${when}`;
}

/** Just when: "flown Jan–Apr 2018" (or the dataset's years). */
export function terrainWhen(source: TerrainSource): string {
  const when = monthYearRange(source.flownFrom, source.flownTo, source.datasetDates);
  return when ? (source.datasetDates ? when : `flown ${when}`) : "";
}

/** True when the terrain here was flown (started) after `date` (ISO): it may already show what happened then. */
export function flownAfter(source: TerrainSource | null, date: string | null | undefined): boolean {
  if (!source || !date || source.datasetDates || !source.flownFrom) return false;
  return source.flownFrom > date.slice(0, 10);
}

/**
 * The USGS source at a point, from the 3DEP index:
 * - `oneMeter`: the 1 m DEM product layer (the project it was made from);
 * - `sourceUnits`: the lidar work units (with their flight dates) covering the point;
 * - `thirdArc`: the 1/3 arc-second DEM layer (project and dates), where there is no 1 m DEM.
 */
export function pickUsgsSource(oneMeter: Attributes[], sourceUnits: Attributes[], thirdArc: Attributes[]): TerrainSource | null {
  const project = oneMeter.map((a) => String(a.project ?? "")).find(Boolean);
  if (project) {
    // The work unit of that project that went into the 1 m DEM; any of its units otherwise.
    const units = sourceUnits.filter((u) => String(u.project ?? "") === project);
    const unit = units.find((u) => String(u.onemeter_category ?? "") === "Meets") ?? units[0];
    return {
      provider: "USGS 3DEP",
      product: "1 m lidar",
      project: unit ? String(unit.workunit ?? project) : project,
      flownFrom: isoDate(unit?.collect_start),
      flownTo: isoDate(unit?.collect_end),
      datasetDates: false,
      link: String(unit?.metadata_link ?? oneMeter[0]?.metadata_link ?? "") || null,
    };
  }
  const third = thirdArc.find((a) => a.project);
  if (third) {
    return {
      provider: "USGS 3DEP",
      product: "1/3 arc-second",
      project: String(third.project),
      flownFrom: isoDate(third.collect_start),
      flownTo: isoDate(third.collect_end),
      datasetDates: false,
      link: String(third.metadata_link ?? "") || null,
    };
  }
  return null;
}

/**
 * Outside 3DEP: the finest dataset Esri World Elevation has at the point (its
 * Data Extents layers run finest first). Its dates span the whole dataset.
 */
export function pickEsriSource(results: Array<{ layerId: number; attributes: Attributes }>): TerrainSource | null {
  const finest = results.filter((r) => r.layerId > 0).sort((a, b) => a.layerId - b.layerId)[0];
  if (!finest) return null;
  const a = finest.attributes;
  return {
    provider: "Esri World Elevation",
    product: String(a.ProductName ?? a.Product ?? "").replace(/_/g, " ").trim() || "terrain",
    project: String(a.Dataset_ID ?? "") || null,
    flownFrom: isoDate(a.Date_Start),
    flownTo: isoDate(a.Date_End),
    datasetDates: true,
    link: String(a.Source_URL ?? "") || null,
  };
}

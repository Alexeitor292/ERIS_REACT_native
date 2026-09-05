// This module is dependency-free on purpose: it is unit tested with `node --test`
// (which needs explicit extensions for runtime imports) and shared by the page and hook.

export const DASHBOARD_DEFAULT_ORDER = [
  "report_header",
  "location",
  "distribution",
  "highway_status",
  "incident_type",
  "material",
  "pavement_ground_status",
  "vegetation_on_slope",
  "water_drainage",
  "water_content",
  "measurements",
] as const;

export type DashboardCardId = (typeof DASHBOARD_DEFAULT_ORDER)[number];
export type DashboardCardLayout = { width: number; height: number };
export type DashboardCardPosition = { x: number; y: number };

export const DASHBOARD_MIN_CARD_WIDTH = 320;
export const DASHBOARD_MAX_CARD_WIDTH = 1600;
export const DASHBOARD_MIN_CARD_HEIGHT = 150;
export const DASHBOARD_MAX_CARD_HEIGHT = 980;
export const DASHBOARD_LAYOUT_GAP = 12;

export const DASHBOARD_DEFAULT_SIZES: Record<DashboardCardId, DashboardCardLayout> = {
  report_header: { width: 1052, height: 300 },
  location: { width: 520, height: 300 },
  distribution: { width: 520, height: 250 },
  highway_status: { width: 520, height: 250 },
  incident_type: { width: 520, height: 300 },
  material: { width: 520, height: 250 },
  pavement_ground_status: { width: 520, height: 360 },
  vegetation_on_slope: { width: 520, height: 260 },
  water_drainage: { width: 520, height: 470 },
  water_content: { width: 520, height: 250 },
  measurements: { width: 520, height: 980 },
};

export const DASHBOARD_CARD_TITLES: Record<DashboardCardId, string> = {
  report_header: "Report Header",
  location: "Location",
  distribution: "Distribution",
  highway_status: "Highway Status",
  incident_type: "Incident Type",
  material: "Material",
  pavement_ground_status: "Pavement / Ground Status",
  vegetation_on_slope: "Vegetation on Slope",
  water_drainage: "Water / Drainage",
  water_content: "Water Content",
  measurements: "Measurements",
};

/**
 * GISA form canvas layout model (v2).
 *
 * Auto-fit mode flows the cards into `max(1, floor((width - gap) / stride))` columns of
 * fixed card width; wide cards (the report header) span two columns. The first drag or
 * resize switches the canvas to `custom` mode, where the stored absolute positions are
 * authoritative and the canvas may scroll horizontally. "Tidy layout" returns to
 * auto-fit while keeping the reading order implied by the current positions.
 *
 * Persisted under a new storage key so layouts saved by the previous version (which
 * still contained the removed Location card) are ignored.
 */
export const DASHBOARD_LAYOUT_V2_KEY = "eris_submission_layout_v2";
export const DASHBOARD_CARD_WIDTH = 520;
export const DASHBOARD_COLUMN_STRIDE = DASHBOARD_CARD_WIDTH + DASHBOARD_LAYOUT_GAP;
export const DASHBOARD_WIDE_CARD_IDS: readonly DashboardCardId[] = ["report_header"];

/** Card ids rendered on the canvas. `location` moved into the Location hero. */
export const CANVAS_CARD_IDS: readonly DashboardCardId[] = DASHBOARD_DEFAULT_ORDER.filter((id) => id !== "location");

export type DashboardCanvasLayout = {
  custom: boolean;
  order: DashboardCardId[];
  sizes: Record<DashboardCardId, DashboardCardLayout>;
  positions: Partial<Record<DashboardCardId, DashboardCardPosition>>;
};

export type FlowedLayout = {
  positions: Record<DashboardCardId, DashboardCardPosition>;
  sizes: Record<DashboardCardId, DashboardCardLayout>;
  width: number;
  height: number;
  columns: number;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function autoFitColumnCount(containerWidth: number) {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return 1;
  return Math.max(1, Math.floor((containerWidth - DASHBOARD_LAYOUT_GAP) / DASHBOARD_COLUMN_STRIDE));
}

export function isWideCard(id: DashboardCardId) {
  return DASHBOARD_WIDE_CARD_IDS.includes(id);
}

export function defaultCardWidth(id: DashboardCardId, columns: number) {
  return isWideCard(id) && columns >= 2 ? DASHBOARD_CARD_WIDTH * 2 + DASHBOARD_LAYOUT_GAP : DASHBOARD_CARD_WIDTH;
}

export function buildDefaultCanvasLayout(): DashboardCanvasLayout {
  const sizes = {} as Record<DashboardCardId, DashboardCardLayout>;
  for (const id of DASHBOARD_DEFAULT_ORDER) sizes[id] = { ...DASHBOARD_DEFAULT_SIZES[id] };
  return { custom: false, order: [...CANVAS_CARD_IDS], sizes, positions: {} };
}

/**
 * Skyline flow: each card goes into the shortest column (a wide card into the shortest
 * adjacent pair). Heights come from the stored sizes so a user's height adjustments are
 * preserved when tidying; widths are always the column width in auto mode.
 */
export function flowDashboardCards(
  order: readonly DashboardCardId[],
  sizes: Record<DashboardCardId, DashboardCardLayout>,
  containerWidth: number,
): FlowedLayout {
  const columns = autoFitColumnCount(containerWidth);
  const columnBottoms = Array.from({ length: columns }, () => DASHBOARD_LAYOUT_GAP);
  const positions = {} as Record<DashboardCardId, DashboardCardPosition>;
  const flowedSizes = {} as Record<DashboardCardId, DashboardCardLayout>;

  for (const id of order) {
    const span = isWideCard(id) && columns >= 2 ? 2 : 1;
    const width = defaultCardWidth(id, columns);
    const height = clamp(sizes[id]?.height ?? DASHBOARD_DEFAULT_SIZES[id].height, DASHBOARD_MIN_CARD_HEIGHT, DASHBOARD_MAX_CARD_HEIGHT);

    let bestColumn = 0;
    let bestTop = Number.POSITIVE_INFINITY;
    for (let column = 0; column + span <= columns; column += 1) {
      let top = 0;
      for (let offset = 0; offset < span; offset += 1) top = Math.max(top, columnBottoms[column + offset]);
      if (top < bestTop) {
        bestTop = top;
        bestColumn = column;
      }
    }

    const x = DASHBOARD_LAYOUT_GAP + bestColumn * DASHBOARD_COLUMN_STRIDE;
    positions[id] = { x, y: bestTop };
    flowedSizes[id] = { width, height };
    for (let offset = 0; offset < span; offset += 1) columnBottoms[bestColumn + offset] = bestTop + height + DASHBOARD_LAYOUT_GAP;
  }

  const height = order.length ? Math.max(...columnBottoms) : DASHBOARD_LAYOUT_GAP * 2;
  const width = DASHBOARD_LAYOUT_GAP + columns * DASHBOARD_COLUMN_STRIDE;
  return { positions, sizes: flowedSizes, width, height, columns };
}

/** Reading order implied by absolute positions (top to bottom, then left to right). */
export function orderFromPositions(
  ids: readonly DashboardCardId[],
  positions: Partial<Record<DashboardCardId, DashboardCardPosition>>,
): DashboardCardId[] {
  return [...ids].sort((a, b) => {
    const pa = positions[a] ?? { x: Number.MAX_SAFE_INTEGER, y: Number.MAX_SAFE_INTEGER };
    const pb = positions[b] ?? { x: Number.MAX_SAFE_INTEGER, y: Number.MAX_SAFE_INTEGER };
    return pa.y - pb.y || pa.x - pb.x || ids.indexOf(a) - ids.indexOf(b);
  });
}

export function canvasContentBounds(
  ids: readonly DashboardCardId[],
  positions: Partial<Record<DashboardCardId, DashboardCardPosition>>,
  sizes: Record<DashboardCardId, DashboardCardLayout>,
) {
  let width = DASHBOARD_LAYOUT_GAP * 2;
  let height = DASHBOARD_LAYOUT_GAP * 2;
  for (const id of ids) {
    const position = positions[id] ?? { x: DASHBOARD_LAYOUT_GAP, y: DASHBOARD_LAYOUT_GAP };
    const size = sizes[id] ?? DASHBOARD_DEFAULT_SIZES[id];
    width = Math.max(width, position.x + size.width + DASHBOARD_LAYOUT_GAP);
    height = Math.max(height, position.y + size.height + DASHBOARD_LAYOUT_GAP);
  }
  return { width, height };
}

export function cardsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function normalizeCanvasLayout(raw: unknown): DashboardCanvasLayout {
  const base = buildDefaultCanvasLayout();
  if (!raw || typeof raw !== "object") return base;
  const source = raw as Partial<DashboardCanvasLayout> & { positions?: unknown; sizes?: unknown };

  const knownIds = new Set<DashboardCardId>(CANVAS_CARD_IDS);
  const order = Array.isArray(source.order)
    ? source.order.filter((value): value is DashboardCardId => knownIds.has(value as DashboardCardId))
    : [];
  const mergedOrder = [...order, ...CANVAS_CARD_IDS.filter((id) => !order.includes(id))];

  const sizes = { ...base.sizes };
  const rawSizes = (source.sizes ?? {}) as Record<string, { width?: unknown; height?: unknown }>;
  for (const id of CANVAS_CARD_IDS) {
    const next = rawSizes[id];
    if (!next) continue;
    const width = Number(next.width);
    const height = Number(next.height);
    sizes[id] = {
      width: Number.isFinite(width) ? clamp(Math.round(width), DASHBOARD_MIN_CARD_WIDTH, DASHBOARD_MAX_CARD_WIDTH) : base.sizes[id].width,
      height: Number.isFinite(height) ? clamp(Math.round(height), DASHBOARD_MIN_CARD_HEIGHT, DASHBOARD_MAX_CARD_HEIGHT) : base.sizes[id].height,
    };
  }

  const positions: Partial<Record<DashboardCardId, DashboardCardPosition>> = {};
  const rawPositions = (source.positions ?? {}) as Record<string, { x?: unknown; y?: unknown }>;
  for (const id of CANVAS_CARD_IDS) {
    const next = rawPositions[id];
    if (!next) continue;
    const x = Number(next.x);
    const y = Number(next.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    positions[id] = { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) };
  }

  const custom = source.custom === true && CANVAS_CARD_IDS.every((id) => positions[id] != null);
  return { custom, order: mergedOrder, sizes, positions: custom ? positions : {} };
}

export function readStoredCanvasLayout(storage: Pick<Storage, "getItem"> | null | undefined): DashboardCanvasLayout {
  try {
    const raw = storage?.getItem(DASHBOARD_LAYOUT_V2_KEY);
    if (!raw) return buildDefaultCanvasLayout();
    return normalizeCanvasLayout(JSON.parse(raw));
  } catch {
    return buildDefaultCanvasLayout();
  }
}

export function serializeCanvasLayout(layout: DashboardCanvasLayout) {
  return JSON.stringify({ version: 2, custom: layout.custom, order: layout.order, sizes: layout.sizes, positions: layout.positions });
}

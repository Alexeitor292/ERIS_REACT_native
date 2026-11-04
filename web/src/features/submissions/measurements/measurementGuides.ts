// Dependency-free (runs under `node --test`): what each measurement looks like
// on the map, so someone can see what a number stands for rather than trust it.
import type { GuidePoint, ScarpSuggestion, SiteMeasurement, SlopeGuide } from "../siteTerrainModel";

/** H, α, Wd, Ld, β, and Hs when a drone survey suggests one. */
export type GuideKey = "H" | "A" | "W" | "L" | "B" | "S";
export const GUIDE_KEYS: GuideKey[] = ["H", "A", "W", "L", "B", "S"];

export type GroundView = "before" | "now";

/**
 * The ground each value was measured on, with a drone survey. Slope height and
 * the original slope describe the ground as it was; the rest, the ground now.
 */
export const GUIDE_GROUND: Record<GuideKey, GroundView> = { H: "before", A: "before", W: "now", L: "now", B: "now", S: "now" };

/** A line in the scene: draped follows the ground; otherwise its points carry their own heights. */
export type GuideLine = { path: Array<[number, number] | GuidePoint>; draped?: boolean; dashed?: boolean };
export type Guide = {
  key: GuideKey;
  lines: GuideLine[];
  label: { at: [number, number] | GuidePoint; text: string; draped?: boolean };
};

/** A spot part of the way from a to b. */
function along<T extends readonly number[]>(a: T, b: T, t: number): number[] {
  return a.map((value, i) => value + (b[i] - value) * t);
}

/**
 * A fitted slope as an angle: down the plane, level out from its top, and straight
 * down to its bottom. `labelAt`: how far down the slope its label goes, so labels
 * on lines that run together do not land on each other.
 */
function angleTriangle(slope: SlopeGuide, key: GuideKey, text: string, labelAt: number): Guide {
  const { top, bottom } = slope;
  const corner: GuidePoint = [bottom[0], bottom[1], top[2]];
  return {
    key,
    lines: [
      { path: [top, bottom] },
      { path: [top, corner, bottom], dashed: true },
    ],
    label: { at: along(top, bottom, labelAt) as GuidePoint, text },
  };
}

/**
 * Every guide for a measurement. `before` and `now` are the same measurement
 * without a drone survey. Without one, the original slope is the plane fitted to
 * the band around the outline; with one, it is the slope of the ground before.
 */
export function buildGuides(input: {
  before: SiteMeasurement;
  now: SiteMeasurement;
  hasDrone: boolean;
  scarp: ScarpSuggestion | null;
  text: Partial<Record<GuideKey, string>>;
}): Guide[] {
  const { before, now, hasDrone, scarp, text } = input;
  const guides: Guide[] = [];
  const { low, high } = before.guides;
  const riseTop: GuidePoint = [low[0], low[1], high[2]];
  if (text.H) {
    guides.push({
      key: "H",
      lines: [{ path: [low, riseTop] }, { path: [riseTop, high], dashed: true }],
      label: { at: [low[0], low[1], (low[2] + high[2]) / 2], text: text.H },
    });
  }
  const original = hasDrone ? before.guides.slope : before.guides.band;
  if (text.A && original) guides.push(angleTriangle(original, "A", text.A, 0.5));
  const [w0, w1] = now.guides.width;
  if (text.W) guides.push({ key: "W", lines: [{ path: [w0, w1], draped: true }], label: { at: along(w0, w1, 1) as [number, number], text: text.W, draped: true } });
  const { top, bottom } = now.guides.slope;
  if (text.L) {
    guides.push({
      key: "L",
      lines: [{ path: [[top[0], top[1]], [bottom[0], bottom[1]]], draped: true }],
      // Raised with the slope: a label resting on the ground is hidden by the ground.
      label: { at: along(top, bottom, 0.55) as GuidePoint, text: text.L },
    });
  }
  if (text.B) guides.push(angleTriangle(now.guides.slope, "B", text.B, 0.75));
  if (text.S && scarp) {
    const [lon, lat] = scarp.point;
    guides.push({
      key: "S",
      lines: [{ path: [[lon, lat, scarp.nowM], [lon, lat, scarp.beforeM]] }],
      label: { at: [lon, lat, scarp.beforeM], text: text.S },
    });
  }
  return guides;
}

/** What to draw: what is switched on, and with a drone survey, what was measured on the ground in view. */
export function visibleGuides(guides: Guide[], shown: ReadonlySet<GuideKey>, view: GroundView, hasDrone: boolean): Guide[] {
  return guides.filter((g) => shown.has(g.key) && (!hasDrone || GUIDE_GROUND[g.key] === view));
}

/** Switching a value on while looking at the other ground goes to the ground it was measured on. */
export function viewAfterToggle(key: GuideKey, turningOn: boolean, view: GroundView, hasDrone: boolean): GroundView {
  return hasDrone && turningOn ? GUIDE_GROUND[key] : view;
}

// Pure reference logic for NoData-aware divided-corridor terrain. This is the TESTED mirror
// of the Objective-C in ErisRoadSliceSceneViewController.m (dividedGroundRunsFt /
// dividedRenderableGroundRunsFt / dividedGroundElevAtFt / dividedExactGroundElevAtFt) —
// keep the two in lockstep.
//
// THE CONTRACT: packaged terrain has holes. A sample whose status is not OK, or whose
// elevation is null/non-finite, is not ground — it is the absence of ground. Filtering such
// samples out and connecting the survivors would draw one continuous profile straight across
// terrain the package does not contain, inventing ground exactly where it is unknown.
//
// So the ordered sample stream is SPLIT into contiguous valid runs:
//   * every line, polygon and filled ground shape is built per run — never across a gap;
//   * interpolation is permitted only between two ADJACENT samples of the SAME run;
//   * a one-sample run may only be shown as an isolated diagnostic point, never joined;
//   * a critical anchor (member A, member B, the midpoint station) must have its OWN exact
//     sample — it is never "present" because neighbours could be interpolated.
//
// No react-native/expo imports (unit-tested under node --experimental-strip-types --test).

/** One packaged cross-section sample as produced by the divided section builder. */
export type TerrainSample = {
  offsetFt: number;
  /** "OK" is the only status that carries ground; anything else is a gap. */
  status?: string;
  /** null / undefined / non-finite all mean "no ground here". */
  elevationFt?: number | null;
};

/** A usable ground point inside a contiguous run. */
export type GroundPoint = { offsetFt: number; elevationFt: number };

/** Sub-millimetre in feet: the same station, not a nearby one. */
export const ANCHOR_EPSILON_FT = 1e-3;

const isRealNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** Whether a sample carries real packaged ground. Everything else ends the current run. */
export function isValidSample(s: TerrainSample | null | undefined, minOffsetFt?: number, maxOffsetFt?: number): boolean {
  if (!s || typeof s !== "object") return false;
  if (!isRealNumber(s.offsetFt)) return false;
  if (s.status !== "OK") return false;
  if (!isRealNumber(s.elevationFt)) return false;
  if (isRealNumber(minOffsetFt) && s.offsetFt < minOffsetFt - 1e-6) return false;
  if (isRealNumber(maxOffsetFt) && s.offsetFt > maxOffsetFt + 1e-6) return false;
  return true;
}

/**
 * Split the ORDERED sample stream into contiguous valid runs. Sample order is preserved;
 * nothing is reordered across a gap and no invalid sample is silently dropped — each one
 * terminates the run in progress.
 */
export function contiguousValidRuns(
  samples: readonly (TerrainSample | null | undefined)[] | null | undefined,
  minOffsetFt?: number,
  maxOffsetFt?: number,
): GroundPoint[][] {
  const runs: GroundPoint[][] = [];
  let cur: GroundPoint[] = [];
  for (const s of samples ?? []) {
    if (isValidSample(s, minOffsetFt, maxOffsetFt)) {
      cur.push({ offsetFt: s!.offsetFt, elevationFt: s!.elevationFt as number });
    } else if (cur.length) {
      runs.push(cur);
      cur = [];
    }
  }
  if (cur.length) runs.push(cur);
  return runs;
}

/** Runs that may be drawn as a line/fill. A single-point run is diagnostic only. */
export function renderableRuns(runs: readonly GroundPoint[][]): GroundPoint[][] {
  return runs.filter((r) => r.length >= 2);
}

/** Runs holding exactly one point — displayable only as an isolated marker. */
export function isolatedPoints(runs: readonly GroundPoint[][]): GroundPoint[] {
  return runs.filter((r) => r.length === 1).map((r) => r[0]);
}

/**
 * Ground elevation at an offset, interpolated STRICTLY between two adjacent samples of ONE
 * run. An offset lying in a gap between runs (or outside every run) is not found, so the
 * caller shows nothing rather than a value interpolated across unavailable terrain.
 */
export function interpolateWithinRuns(
  runs: readonly GroundPoint[][],
  offsetFt: number,
): { found: boolean; elevationFt: number | null } {
  if (!isRealNumber(offsetFt)) return { found: false, elevationFt: null };
  const eps = 1e-6;
  for (const run of runs) {
    if (!run.length) continue;
    const first = run[0];
    const last = run[run.length - 1];
    if (offsetFt < first.offsetFt - eps || offsetFt > last.offsetFt + eps) continue;
    let prev = first;
    for (const p of run) {
      if (p.offsetFt >= offsetFt) {
        const span = p.offsetFt - prev.offsetFt;
        const t = span > 1e-9 ? (offsetFt - prev.offsetFt) / span : 0;
        return { found: true, elevationFt: prev.elevationFt + (p.elevationFt - prev.elevationFt) * t };
      }
      prev = p;
    }
    return { found: true, elevationFt: last.elevationFt };
  }
  return { found: false, elevationFt: null };
}

/**
 * The EXACT ground elevation at a critical anchor: there must be a real sample AT that
 * offset. Used for member A, member B and the midpoint station, so a marker can never be
 * placed at an interpolated elevation and an anchor is never considered present merely
 * because it could be interpolated from nearby samples.
 */
export function exactAnchorElevation(
  runs: readonly GroundPoint[][],
  offsetFt: number,
  epsilonFt: number = ANCHOR_EPSILON_FT,
): { found: boolean; elevationFt: number | null } {
  if (!isRealNumber(offsetFt)) return { found: false, elevationFt: null };
  for (const run of runs) {
    for (const p of run) {
      if (Math.abs(p.offsetFt - offsetFt) <= epsilonFt) return { found: true, elevationFt: p.elevationFt };
    }
  }
  return { found: false, elevationFt: null };
}

/** Whether every required critical anchor has its own exact packaged ground sample. */
export function criticalAnchorsSatisfied(
  runs: readonly GroundPoint[][],
  anchorsFt: readonly number[],
  epsilonFt: number = ANCHOR_EPSILON_FT,
): boolean {
  return anchorsFt.every((a) => exactAnchorElevation(runs, a, epsilonFt).found);
}

/**
 * The drawable segments implied by the runs: [from, to] pairs of ADJACENT samples within one
 * run. Used by tests to prove no rendered segment straddles an invalid sample.
 */
export function renderableSegments(runs: readonly GroundPoint[][]): [GroundPoint, GroundPoint][] {
  const out: [GroundPoint, GroundPoint][] = [];
  for (const run of renderableRuns(runs)) {
    for (let i = 0; i + 1 < run.length; i++) out.push([run[i], run[i + 1]]);
  }
  return out;
}

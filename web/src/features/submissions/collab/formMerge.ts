// Dependency-free so it runs under `node --test`. Several people can have one
// technical form open: this decides what each person's save sends and how
// someone else's saved changes fold into a form being edited.
//
// A form is compared as a flat snapshot (field -> value). Three snapshots
// matter: `base` (the form as this person opened it, or last caught up with),
// `mine` (what their screen shows now) and `fresh` (what is saved now).

export type FormSnapshot = Record<string, unknown>;

const blank = (value: unknown) => value === undefined || value === null || value === "";

/** Equal as the form shows them: blanks are one value, lists and objects by content. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (blank(a) && blank(b)) return true;
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The fields this person has changed since `base`. */
export function changedKeys(base: FormSnapshot, mine: FormSnapshot): string[] {
  const keys = new Set([...Object.keys(base), ...Object.keys(mine)]);
  return [...keys].filter((key) => !sameValue(base[key], mine[key]));
}

export type MergeResult = {
  /** The form after folding in what others saved; conflicts keep this person's value. */
  merged: FormSnapshot;
  /** Fields taken from what others saved (this person had not changed them). */
  theirs: string[];
  /** Fields both changed, to different values: this person decides. */
  conflicts: string[];
};

/** Three-way merge: others' saved changes land where this person has not typed. */
export function mergeFresh(base: FormSnapshot, mine: FormSnapshot, fresh: FormSnapshot): MergeResult {
  const merged: FormSnapshot = { ...mine };
  const theirs: string[] = [];
  const conflicts: string[] = [];
  const keys = new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(fresh)]);
  for (const key of keys) {
    const theyChanged = !sameValue(base[key], fresh[key]);
    if (!theyChanged) continue;
    const iChanged = !sameValue(base[key], mine[key]);
    if (!iChanged) {
      merged[key] = fresh[key];
      theirs.push(key);
    } else if (!sameValue(mine[key], fresh[key])) {
      conflicts.push(key);
    }
  }
  return { merged, theirs, conflicts };
}

/**
 * The new starting point after catching up with `fresh`: what is saved now,
 * except the fields still in conflict, which keep the old start so a save of
 * them is refused until this person has chosen.
 */
export function rebase(base: FormSnapshot, fresh: FormSnapshot, keep: readonly string[]): FormSnapshot {
  const next: FormSnapshot = { ...fresh };
  for (const key of keep) next[key] = base[key];
  return next;
}

/** Why this can't be delivered yet, or null. The server checks it all again. */
export function deliveryProblem(actions: readonly string[], description: string): string | null {
  if (!actions.length) return "Select the immediate actions first.";
  if (!description.trim()) return "Say what happened.";
  return null;
}

/** Who heard, in a sentence. */
export function deliveryOutcome(result: { supervisor_told?: boolean; contact_told?: boolean }): string {
  const told = [result.supervisor_told ? "the supervisor" : null, result.contact_told ? "the District Contact" : null].filter(Boolean);
  return told.length ? `Delivered to ${told.join(" and ")}.` : "Saved, but this assessment has no supervisor or District Contact to tell yet.";
}

/** A hand-off has to name someone, unless the district has nobody to name. */
export function contactMissing(candidates: readonly unknown[] | undefined, chosen: number | null): boolean {
  return !!candidates?.length && chosen == null;
}

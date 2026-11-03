import type { WorkGroup, WorkKind } from "../../api/assessments";

const ROLE: Record<WorkKind, string> = { BRANCH_CHIEF: "Branch chief", STAFF: "Staff", SENIOR_SPECIALIST: "Senior Specialist" };

export const pickerLabel = (kind: WorkKind) => (kind === "BRANCH_CHIEF" ? "New branch chief" : kind === "STAFF" ? "New Staff member" : "New Senior Specialist");

/** "Maria Garcia · Branch chief · no longer in this place". */
export function holderLine(group: WorkGroup): string {
  const name = group.holder.full_name ?? "Nobody";
  return group.left ? `${name} · ${ROLE[group.kind]} · has moved on` : `${name} · ${ROLE[group.kind]}`;
}

export const groupKey = (group: Pick<WorkGroup, "kind" | "holder">) => `${group.kind}:${group.holder.id ?? "none"}`;

/** Everyone they could move to, minus the person it is moving from. */
export function withoutHolder<T extends { id: number }>(options: T[], holderId: number | null): T[] {
  return options.filter((option) => option.id !== holderId);
}

/** What happened, in a sentence. */
export function moveOutcome(result: { moved: number[]; failed: Array<{ id: number; detail: string }> }, to: string): string {
  const moved = result.moved.length;
  const said = moved ? `Moved ${moved} assessment${moved === 1 ? "" : "s"} to ${to}. Their work stayed with them.` : "Nothing moved.";
  if (!result.failed.length) return said;
  return `${said} Not moved: ${result.failed.map((item) => `#${item.id} (${item.detail})`).join("; ")}`;
}

import type { SubmissionPermissionGrant, SubmissionPermissionUser } from "../../api/types";

export function shareUserLabel(user: { full_name: string; email: string }) {
  const name = String(user.full_name || "").trim();
  const email = String(user.email || "").trim();
  return name || email || "Unnamed user";
}

export function filterShareCandidates<T extends SubmissionPermissionUser>(
  availableUsers: T[],
  query: string,
  sharedWith: Pick<SubmissionPermissionGrant, "user_id">[],
  limit = 25,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const sharedIds = new Set(sharedWith.map((user) => Number(user.user_id)));
  return availableUsers
    .filter((user) => !sharedIds.has(Number(user.id)))
    .filter((user) => {
      const haystack = `${user.full_name ?? ""} ${user.email ?? ""}`.toLowerCase();
      return haystack.includes(q);
    })
    .sort((a, b) => {
      const aName = shareUserLabel(a).toLowerCase();
      const bName = shareUserLabel(b).toLowerCase();
      return aName.localeCompare(bName) || a.email.localeCompare(b.email) || a.id - b.id;
    })
    .slice(0, Math.max(1, limit));
}

type ShareRouteLike = { immediate: boolean; approvals: readonly string[]; notices: readonly string[] };

function joined(items: readonly string[]) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const chiefsOf = (units: readonly string[]) => `the ${units.length === 1 ? "chief" : "chiefs"} of ${joined(units)}`;

/** What sharing with someone would take, in one line: "Shared at once · the chief of West is told". */
export function shareRouteSummary(route: ShareRouteLike): string {
  const first = route.immediate ? "Shared at once" : `Needs approval from ${chiefsOf(route.approvals)}`;
  return route.notices.length ? `${first} · ${chiefsOf(route.notices)} ${route.notices.length === 1 ? "is" : "are"} told` : first;
}

export const SHARE_STATUS_LABELS: Record<string, string> = {
  PENDING: "Waiting for approval",
  ACTIVE: "Can view and edit",
  REJECTED: "Rejected",
  REVOKED: "Stopped",
  CANCELLED: "Withdrawn",
};

type ShareReviewLike = { unit_label: string; kind: string; decision: string; decided_by: string | null };

/** Where one branch or office stands on a share: "West › Branch A — approved by Maria". */
export function shareReviewLine(review: ShareReviewLike): string {
  const by = review.decided_by ? ` by ${review.decided_by}` : "";
  if (review.decision === "REJECTED") return `${review.unit_label} — ${review.kind === "APPROVAL" ? "rejected" : "stopped"}${by}`;
  if (review.kind === "APPROVAL") return `${review.unit_label} — ${review.decision === "APPROVED" ? `approved${by}` : "waiting for approval"}`;
  return `${review.unit_label} — ${review.decision === "ACKNOWLEDGED" ? `told, seen${by}` : "told"}`;
}

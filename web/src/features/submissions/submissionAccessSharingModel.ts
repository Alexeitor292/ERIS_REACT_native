import type { SubmissionPermissionGrant, SubmissionPermissionUser } from "../../api/types";

export function shareUserLabel(user: { full_name: string; email: string }) {
  const name = String(user.full_name || "").trim();
  const email = String(user.email || "").trim();
  return name || email || "Unnamed user";
}

export function filterShareCandidates(
  availableUsers: SubmissionPermissionUser[],
  query: string,
  sharedWith: SubmissionPermissionGrant[],
  limit = 25,
) {
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

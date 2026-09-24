/**
 * Where a notification leads in the app. The feed stores web paths (the web
 * portal's bell follows them as they are); this maps each to the screen that
 * does the same job here, or to null when the step is done on the web (sharing
 * approvals, office routing) and the list simply marks it read.
 */
export type AppRoute = string | { pathname: string; params: Record<string, string> };

export function routeFor(link: string | null, kind: string): AppRoute | null {
  if (kind === "INCIDENT_COORDINATOR_REVIEW") return "/(tabs)/incidents/track";
  if (!link) return null;
  const path = link.split("?")[0];
  const incident = /^\/incidents\/(\d+)$/.exec(path);
  if (incident) return { pathname: "/(tabs)/incidents/[id]", params: { id: incident[1] } };
  const submission = /^\/submissions\/(\d+)$/.exec(path);
  if (submission) return `/(tabs)/submissions/${submission[1]}`;
  if (/^\/assessments(\/\d+)?$/.test(path) || (path === "/my-work" && link.includes("assessment="))) return "/(tabs)/assessments";
  return null;
}

/** What the badge says: nothing at zero, "9+" past nine. */
export function badgeText(unread: number): string | null {
  if (!Number.isFinite(unread) || unread <= 0) return null;
  return unread > 9 ? "9+" : String(Math.floor(unread));
}

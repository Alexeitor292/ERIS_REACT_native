// Small rules of the app frame (ui/AppShell.tsx, ui/pageTransition.ts), kept
// here so they can be tested without a browser.

const PRODUCT = "ERIS";

/** The browser tab's title: the page first, so tabs and history stay distinguishable. */
export function documentTitle(pageTitle: string | null | undefined): string {
  const page = (pageTitle ?? "").trim();
  return page && page !== PRODUCT ? `${page} · ${PRODUCT}` : PRODUCT;
}

type MotionQuery = Pick<Window, "matchMedia"> | null | undefined;

/** True when the person asked their system for less motion (or it cannot be told). */
export function prefersReducedMotion(win: MotionQuery = typeof window === "undefined" ? null : window): boolean {
  try {
    return !!win?.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** The label the phone-width menu button shows: where you are, or "Menu". */
export function currentPageLabel(pages: ReadonlyArray<{ to: string; label: string; alsoActive?: string[] }>, pathname: string): string {
  const matches = (prefix: string) => pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
  // The longest matching destination wins: /incident-groups/4 is not /incidents.
  const best = [...pages]
    .filter((page) => matches(page.to) || (page.alsoActive ?? []).some(matches))
    .sort((a, b) => b.to.length - a.to.length)[0];
  return best?.label ?? "Menu";
}

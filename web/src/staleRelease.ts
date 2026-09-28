// After an update, a page still running the previous release asks for files
// the server no longer has. Rather than fail (or go blank), load the current
// release — once, so a fault that a reload does not cure still shows.

const RELOADED_AT = "eris_release_reload_at";
const GRACE_MS = 30_000;

/** True when an error means a file of the running release could not be loaded (Chrome, Firefox, Safari, Vite). */
export function isStaleReleaseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(message);
}

/**
 * Reload the page to pick up the current release. Returns false, and does not
 * reload, when it already did within the last 30 seconds or cannot remember
 * that it did (no session storage), so it can never loop.
 */
export function reloadForNewRelease(now = Date.now(), storage: Pick<Storage, "getItem" | "setItem"> | null = safeSessionStorage()): boolean {
  if (!storage) return false;
  try {
    if (now - Number(storage.getItem(RELOADED_AT) || 0) < GRACE_MS) return false;
    storage.setItem(RELOADED_AT, String(now));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

function safeSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

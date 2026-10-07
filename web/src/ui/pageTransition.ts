// Page changes from the side navigation as a browser view transition.
//
// React Router's own `viewTransition` option needs a data router; ERIS uses
// BrowserRouter, so the transition is started here. The browser freezes the
// old page, the router changes page, and once the new page has rendered (its
// AppShell calls `pageRendered`) the snapshots animate (index.css, eris-page).

type Navigate = (to: string) => void;

let settle: (() => void) | null = null;

type DocumentWithTransitions = Document & { startViewTransition?: (update: () => Promise<void> | void) => unknown };

/** Change page with a view transition when the browser offers one; otherwise at once. */
export function navigateWithTransition(navigate: Navigate, to: string): void {
  const doc = document as DocumentWithTransitions;
  if (typeof doc.startViewTransition !== "function" || document.visibilityState !== "visible") {
    navigate(to);
    return;
  }
  doc.startViewTransition(
    () =>
      new Promise<void>((resolve) => {
        // A page that takes long to render never holds the screen frozen.
        const timer = window.setTimeout(() => {
          settle = null;
          resolve();
        }, 700);
        settle = () => {
          window.clearTimeout(timer);
          settle = null;
          resolve();
        };
        navigate(to);
      })
  );
}

/** The new page has rendered: let the transition run. */
export function pageRendered(): void {
  settle?.();
}

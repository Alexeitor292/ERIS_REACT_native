// Dependency-free so it runs under `node --test`. Figures in the memos: each
// memo numbers its own (Observations 1.1, 1.2…, Geotechnical assessment 2.1…),
// and a citation ("Figure 2.1") can point at a figure in any memo.
//
// Stored HTML (sanitized on the server, services/rich_text.py):
//   <figure data-figure="<attachment id>" data-caption="…" data-width="100" data-label="1.1">
//     <figcaption>Figure 1.1. …</figcaption></figure>
//   <span data-figure-ref="<attachment id>" data-label="1.1">Figure 1.1</span>

/** The memos in the order they are numbered. */
export const FIGURE_MEMO_ORDER = ["observations_notes", "geotechnical_assessment_notes", "recommendations_notes", "sketchpad_notes"] as const;

export type FigureEntry = { attachmentId: number; label: string; caption: string; memo: string };

/** Every figure in every memo, numbered, by attachment id (a figure used twice keeps its first number). */
export function figureRegistry(memos: Partial<Record<string, string>>): Map<number, FigureEntry> {
  const registry = new Map<number, FigureEntry>();
  FIGURE_MEMO_ORDER.forEach((memo, memoIndex) => {
    const html = memos[memo] ?? "";
    let n = 0;
    for (const match of html.matchAll(/<figure\b[^>]*>/gi)) {
      const tag = match[0];
      const id = Number(/data-figure="(\d+)"/i.exec(tag)?.[1]);
      if (!id) continue;
      n += 1;
      if (registry.has(id)) continue;
      registry.set(id, { attachmentId: id, label: `${memoIndex + 1}.${n}`, caption: decode(/data-caption="([^"]*)"/i.exec(tag)?.[1] ?? ""), memo });
    }
  });
  return registry;
}

/** The memo's place in the numbering (1 for Observations…), 0 when it numbers no figures. */
export function memoNumber(memo: string): number {
  return (FIGURE_MEMO_ORDER as readonly string[]).indexOf(memo) + 1;
}

/** "Figure 1.1", or "Figure ?" for a citation whose figure is gone. */
export function figureText(label: string | null | undefined): string {
  return `Figure ${label || "?"}`;
}

/** A caption with any "Figure 1.2." prefix Word kept on it taken off. */
export function stripFigurePrefix(caption: string): string {
  return caption.replace(/^\s*(figure|fig\.?)\s*\d+(?:\.\d+)*\s*[.:–—-]?\s*/i, "").trim();
}

function decode(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

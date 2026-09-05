import { useMemo, useState } from "react";
import { FolderOpen } from "lucide-react";

import type { Attachment } from "../../api/types";
import { AttachmentTileGrid, type AttachmentUrlResolver } from "./SubmissionAttachmentTiles";
import { buildLibraryItems, filterLibraryItems, libraryCountLabel, libraryCounts, type LibraryFilter } from "./submissionAttachmentModel";

const FILTERS: Array<{ id: LibraryFilter; label: string; count: (counts: ReturnType<typeof libraryCounts>) => number }> = [
  { id: "ALL", label: "All", count: (counts) => counts.all },
  { id: "PHOTOS", label: "Photos", count: (counts) => counts.photos },
  { id: "VIDEOS", label: "Videos", count: (counts) => counts.videos },
  { id: "DOCUMENTS", label: "Documents", count: (counts) => counts.documents },
];

/**
 * Submission library: every file linked to the submission (photos, videos, documents,
 * sketches) with the GISA section it was captured under. Replaces the attachments table.
 */
export default function SubmissionLibrary({ attachments, resolver }: { attachments: Attachment[]; resolver: AttachmentUrlResolver }) {
  const items = useMemo(() => buildLibraryItems(attachments), [attachments]);
  const counts = useMemo(() => libraryCounts(items), [items]);
  const [filter, setFilter] = useState<LibraryFilter>("ALL");
  const visible = useMemo(() => filterLibraryItems(items, filter), [items, filter]);

  return (
    <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)]" aria-labelledby="submission-library-title">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-t-xl border-b border-[var(--line)] bg-[linear-gradient(90deg,color-mix(in_oklab,var(--brand)_12%,var(--panel)),var(--panel))] px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--brand)] text-white">
            <FolderOpen size={18} strokeWidth={1.9} aria-hidden />
          </div>
          <div className="min-w-0">
            <h2 id="submission-library-title" className="text-sm font-semibold">Submission library</h2>
            <div className="text-xs text-muted">{libraryCountLabel(counts)}</div>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter library">
          {FILTERS.map((option) => {
            const active = filter === option.id;
            const count = option.count(counts);
            return (
              <button
                key={option.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setFilter(option.id)}
                className={`rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors ${
                  active
                    ? "border-[var(--brand)] bg-[var(--brand)] text-white"
                    : "border-[var(--line)] bg-[var(--panel)] text-[var(--ink)] hover:bg-[var(--panel-soft)]"
                }`}
              >
                {option.label} <span className={active ? "opacity-85" : "text-muted"}>{count}</span>
              </button>
            );
          })}
        </div>
      </header>
      <div className="p-4">
        <AttachmentTileGrid
          items={visible}
          resolver={resolver}
          showSection
          emptyMessage={items.length === 0 ? "No files are attached to this submission yet." : "No files match this filter."}
        />
      </div>
    </section>
  );
}

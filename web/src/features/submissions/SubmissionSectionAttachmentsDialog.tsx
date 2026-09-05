import { Paperclip, X } from "lucide-react";

import ModalDialog from "../../ui/ModalDialog";
import { AttachmentTileGrid, type AttachmentUrlResolver } from "./SubmissionAttachmentTiles";
import { libraryCountLabel, libraryCounts, type SubmissionLibraryItem } from "./submissionAttachmentModel";

/** "Open attachments (n)" affordance rendered in a GISA section header. */
export function SectionAttachmentsButton({ count, onClick, disabled }: { count: number; onClick: () => void; disabled?: boolean }) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1 rounded-md border border-[color:color-mix(in_oklab,var(--brand)_40%,var(--line))] bg-[color:color-mix(in_oklab,var(--brand)_8%,var(--panel))] px-2 py-1 text-[11px] font-semibold text-[var(--brand)] hover:bg-[color:color-mix(in_oklab,var(--brand)_14%,var(--panel))] disabled:opacity-60"
    >
      <Paperclip size={12} strokeWidth={2} aria-hidden />
      Open attachments ({count})
    </button>
  );
}

export default function SubmissionSectionAttachmentsDialog({
  sectionTitle,
  items,
  resolver,
  onClose,
}: {
  sectionTitle: string;
  items: SubmissionLibraryItem[];
  resolver: AttachmentUrlResolver;
  onClose: () => void;
}) {
  const counts = libraryCounts(items);
  return (
    <ModalDialog
      titleId="section-attachments-title"
      descriptionId="section-attachments-description"
      onClose={onClose}
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      panelClassName="flex max-h-[88vh] w-full max-w-5xl flex-col rounded-xl border border-[var(--line)] bg-[var(--panel)] shadow-2xl"
    >
      <div className="flex items-start justify-between gap-3 border-b border-[var(--line)] px-5 py-4">
        <div className="min-w-0">
          <h2 id="section-attachments-title" className="text-base font-semibold">{sectionTitle} attachments</h2>
          <p id="section-attachments-description" className="mt-0.5 text-sm text-muted">{libraryCountLabel(counts)} tagged to this section by the field form.</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-md border border-[var(--line)] bg-[var(--panel)] p-1.5 hover:bg-[var(--panel-soft)]">
          <X size={16} strokeWidth={2} aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <AttachmentTileGrid items={items} resolver={resolver} showSection={false} emptyMessage="No attachments are tagged to this section." />
      </div>
    </ModalDialog>
  );
}

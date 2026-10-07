import { useRef, useState } from "react";
import { CheckCircle2, CloudUpload, Paperclip, TriangleAlert, X } from "lucide-react";

import ModalDialog from "../../ui/ModalDialog";
import { AttachmentTileGrid, type AttachmentUrlResolver } from "./SubmissionAttachmentTiles";
import { libraryCountLabel, libraryCounts, type SubmissionLibraryItem } from "./submissionAttachmentModel";
import { MAX_UPLOAD_MB, uploadKind, uploadSection } from "./sectionUpload";

/**
 * A section's attachments affordance in a GISA section header: "Attach" when
 * the section has none yet and the person may add some, the count otherwise.
 */
export function SectionAttachmentsButton({ count, onClick, disabled, canAdd = false }: { count: number; onClick: () => void; disabled?: boolean; canAdd?: boolean }) {
  if (count <= 0 && !canAdd) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={canAdd ? "Add photos, videos or documents to this section" : undefined}
      className="inline-flex items-center gap-1 rounded-md border border-[color:color-mix(in_oklab,var(--brand)_40%,var(--line))] bg-[color:color-mix(in_oklab,var(--brand)_8%,var(--panel))] px-2 py-1 text-[11px] font-semibold text-[var(--brand)] hover:bg-[color:color-mix(in_oklab,var(--brand)_14%,var(--panel))] disabled:opacity-60"
    >
      <Paperclip size={12} strokeWidth={2} aria-hidden />
      {count > 0 ? `Attachments (${count})` : "Attach"}
    </button>
  );
}

type Upload = { name: string; kind: string; progress: number; error: string | null; done: boolean };

const ACCEPT = "image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.rtf,.ppt,.pptx,.kml,.kmz,.zip,.dwg,.dxf,.tif,.tiff";

export default function SubmissionSectionAttachmentsDialog({
  sectionTitle,
  items,
  resolver,
  onClose,
  upload,
}: {
  sectionTitle: string;
  items: SubmissionLibraryItem[];
  resolver: AttachmentUrlResolver;
  onClose: () => void;
  /** Present when this person may add files: where they go, and what to refresh after. */
  upload?: { submissionId: number; sectionKey: string; onUploaded: () => void | Promise<void> };
}) {
  const counts = libraryCounts(items);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = uploads.some((u) => !u.done && !u.error);

  async function addFiles(files: FileList | File[] | null) {
    if (!upload || !files) return;
    const list = Array.from(files);
    if (!list.length) return;
    const start = uploads.length;
    setUploads((current) => [...current, ...list.map((f) => ({ name: f.name, kind: uploadKind(f), progress: 0, error: null, done: false }))]);
    let any = false;
    // One at a time, so a video on a slow connection does not starve the rest.
    for (const [offset, file] of list.entries()) {
      const at = start + offset;
      const set = (patch: Partial<Upload>) => setUploads((current) => current.map((u, i) => (i === at ? { ...u, ...patch } : u)));
      try {
        await uploadSection(upload.submissionId, upload.sectionKey, file, (progress) => set({ progress }));
        set({ done: true, progress: 1 });
        any = true;
      } catch (error) {
        set({ error: error instanceof Error ? error.message : "Upload failed" });
      }
    }
    if (any) await upload.onUploaded();
  }

  return (
    <ModalDialog
      titleId="section-attachments-title"
      descriptionId="section-attachments-description"
      onClose={busy ? () => undefined : onClose}
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      panelClassName="flex max-h-[88vh] w-full max-w-5xl flex-col rounded-xl border border-[var(--line)] bg-[var(--panel)] shadow-2xl"
    >
      <div className="flex items-start justify-between gap-3 border-b border-[var(--line)] px-5 py-4">
        <div className="min-w-0">
          <h2 id="section-attachments-title" className="text-base font-semibold">{sectionTitle} attachments</h2>
          <p id="section-attachments-description" className="mt-0.5 text-sm text-muted">
            {items.length ? `${libraryCountLabel(counts)} filed under this section.` : "Nothing filed under this section yet."}
          </p>
        </div>
        <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="rounded-md border border-[var(--line)] bg-[var(--panel)] p-1.5 hover:bg-[var(--panel-soft)] disabled:opacity-50">
          <X size={16} strokeWidth={2} aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {upload ? (
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              void addFiles(event.dataTransfer.files);
            }}
            className={`rounded-xl border-2 border-dashed px-4 py-5 text-center transition-colors ${
              dragging ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_8%,var(--panel))]" : "border-[var(--line)] bg-[var(--panel-soft)]"
            }`}
          >
            <CloudUpload size={26} className="mx-auto text-[var(--brand)]" aria-hidden />
            <p className="mt-2 text-sm font-semibold">Drop photos, videos or documents here</p>
            <p className="mt-0.5 text-xs text-muted">Filed under {sectionTitle}. Up to {MAX_UPLOAD_MB} MB each; photos keep their location and direction.</p>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="mt-3 rounded-md bg-[var(--brand)] px-3 py-1.5 text-sm font-semibold text-white hover:brightness-95"
            >
              Choose files
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={ACCEPT}
              className="hidden"
              onChange={(event) => {
                void addFiles(event.target.files);
                event.target.value = "";
              }}
            />
          </div>
        ) : null}

        {uploads.length ? (
          <ul className="space-y-1.5" aria-live="polite">
            {uploads.map((u, i) => (
              <li key={`${u.name}-${i}`} className="rounded-lg border border-[var(--line)] px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  {u.error ? <TriangleAlert size={15} className="shrink-0 text-[var(--bad)]" aria-hidden /> : u.done ? <CheckCircle2 size={15} className="shrink-0 text-[var(--good)]" aria-hidden /> : <CloudUpload size={15} className="shrink-0 text-muted" aria-hidden />}
                  <span className="min-w-0 flex-1 truncate">{u.name}</span>
                  <span className="shrink-0 text-xs text-muted">{u.kind === "PHOTO" ? "Photo" : u.kind === "VIDEO" ? "Video" : "Document"}</span>
                  <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted">{u.error ? "" : `${Math.round(u.progress * 100)}%`}</span>
                </div>
                {u.error ? <p className="mt-1 text-xs text-[var(--bad)]">{u.error}</p> : (
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--panel-soft)]">
                    <div className="h-full rounded-full bg-[var(--brand)] transition-[width]" style={{ width: `${Math.round(u.progress * 100)}%` }} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : null}

        <AttachmentTileGrid items={items} resolver={resolver} showSection={false} emptyMessage="No attachments are filed under this section." />
      </div>
    </ModalDialog>
  );
}

import { useState, type ChangeEvent, type DragEvent, type ReactNode, type RefObject } from "react";
import { Paperclip, X } from "lucide-react";

import IncidentLocationInput from "./IncidentLocationInput";
import { incidentName } from "./incidentLocationModel";
import { formatFileSize, type IncidentCreateForm, type PendingIncidentUpload } from "./incidentUiModel";

type Props = {
  form: IncidentCreateForm;
  pendingFiles: PendingIncidentUpload[];
  busy: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFormChange: (next: IncidentCreateForm) => void;
  onFiles: (files: FileList | null) => void;
  onRemoveFile: (index: number) => void;
  onCancel: () => void;
  onCreate: () => void;
};

const inputClass = "w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]";

function Field({ label, required = false, hint, children }: { label: string; required?: boolean; hint?: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted">
        {label}{required ? <span className="text-[var(--bad)]" aria-hidden> *</span> : null}
        {hint ? <span className="ml-1.5 font-normal normal-case tracking-normal">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

/** What still stands between the form and a report, in words for the footer. */
export function createBlocker(form: IncidentCreateForm): string | null {
  if (!form.first_observed_at.trim()) return "Say when it was first seen.";
  if (!form.location) return "Place it — on the map, by route and post mile, or by coordinates.";
  return null;
}

/**
 * Report an incident from a desktop: what was seen on the left, where it is on
 * the right. The location is placed on a map (the desktop's stand-in for the
 * phone's GPS), or entered by route and post mile, or by coordinates, and is
 * resolved against Caltrans the phone's way before the report can be filed.
 */
export default function IncidentCreatePanel({
  form,
  pendingFiles,
  busy,
  fileInputRef,
  onFormChange,
  onFiles,
  onRemoveFile,
  onCancel,
  onCreate,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const setField = <K extends keyof IncidentCreateForm>(key: K, value: IncidentCreateForm[K]) => onFormChange({ ...form, [key]: value });
  const blocker = createBlocker(form);
  const name = incidentName(form.location, form.first_observed_at);

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    if (!busy) onFiles(event.dataTransfer.files);
  }

  return (
    <section aria-labelledby="create-incident-title" className="rounded-xl border border-[var(--line)] bg-[var(--panel)]">
      <div className="flex items-start justify-between gap-4 border-b border-[var(--line)] px-5 py-4">
        <div className="min-w-0">
          <h2 id="create-incident-title" className="text-base font-semibold">Report an incident</h2>
          <p className="mt-0.5 text-[13px] text-muted">
            What was seen and where. It goes to the district's Maintenance Coordinator, who decides what happens next. The incident type is left for the on-site assessment.
          </p>
        </div>
        <button type="button" onClick={onCancel} disabled={busy} aria-label="Close the report form" className="rounded-md border border-[var(--line)] p-1.5 hover:bg-[var(--panel-soft)] disabled:opacity-50">
          <X size={16} aria-hidden />
        </button>
      </div>

      <div className="grid gap-6 px-5 py-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="grid content-start gap-4">
          <div className="grid gap-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">Name</span>
            {name
              ? <span className="font-mono text-sm tabular-nums">{name}</span>
              : <span className="text-[13px] text-muted">District-County-Route-Post mile and the day it was first seen, filled in once the report is placed.</span>}
          </div>
          <Field label="What was seen">
            <textarea
              rows={5}
              className={`${inputClass} resize-y`}
              value={form.description}
              onChange={(event) => setField("description", event.target.value)}
              placeholder="What it looks like, how big, whether a lane is affected, and anything that has changed since it was first seen."
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="First seen" required>
              <input type="datetime-local" className={inputClass} value={form.first_observed_at} onChange={(event) => setField("first_observed_at", event.target.value)} />
            </Field>
            <Field label="Occurred" hint="if known">
              <input type="datetime-local" className={inputClass} value={form.first_occurred_at} onChange={(event) => setField("first_occurred_at", event.target.value)} />
            </Field>
          </div>

          <div className="grid gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">Photos and files</span>
            <label
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={`flex cursor-pointer items-center gap-3 rounded-lg border border-dashed px-3 py-3 text-sm ${dragging ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_7%,var(--panel))]" : "border-[var(--line)] hover:bg-[var(--panel-soft)]"}`}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                disabled={busy}
                onChange={(event: ChangeEvent<HTMLInputElement>) => onFiles(event.currentTarget.files)}
                className="sr-only"
              />
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--panel-soft)] text-muted"><Paperclip size={16} aria-hidden /></span>
              <span className="min-w-0">
                <span className="block font-semibold">Add photos, videos or documents</span>
                <span className="block text-xs text-muted">Drop them here, or click to choose.</span>
              </span>
            </label>
            {pendingFiles.length > 0 ? (
              <ul className="grid gap-1.5">
                {pendingFiles.map((pending, index) => {
                  const sizeLabel = formatFileSize(pending.file.size);
                  return (
                    <li key={`${pending.file.name}-${pending.file.lastModified}-${index}`} className="flex items-center justify-between gap-3 rounded-md border border-[var(--line)] px-3 py-1.5 text-sm">
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{pending.file.name}</span>
                        <span className="block text-xs text-muted">{sizeLabel ? `${pending.kind.toLowerCase()} · ${sizeLabel}` : pending.kind.toLowerCase()}</span>
                      </span>
                      <button type="button" onClick={() => onRemoveFile(index)} disabled={busy} aria-label={`Remove ${pending.file.name}`} className="rounded p-1 text-muted hover:bg-[var(--panel-soft)] hover:text-[var(--ink)] disabled:opacity-60">
                        <X size={14} aria-hidden />
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        </div>

        <IncidentLocationInput value={form.location} onChange={(location) => setField("location", location)} disabled={busy} />
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--line)] px-5 py-3">
        <span aria-live="polite" className="mr-auto text-[12px] text-muted">{blocker}</span>
        <button type="button" onClick={onCancel} disabled={busy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">
          Cancel
        </button>
        <button type="button" onClick={onCreate} disabled={busy || Boolean(blocker)} className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50">
          {busy ? "Sending…" : "Send report"}
        </button>
      </div>
    </section>
  );
}

import type { ChangeEvent } from "react";

import { formatCoordinate, normalizePostMileInput, normalizeRouteInput } from "../../utils/precision";
import { formatFileSize, type IncidentCreateForm, type PendingIncidentUpload } from "./incidentUiModel";

type Props = {
  form: IncidentCreateForm;
  pendingFiles: PendingIncidentUpload[];
  busy: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFormChange: (next: IncidentCreateForm) => void;
  onFiles: (files: FileList | null) => void;
  onRemoveFile: (index: number) => void;
  onCancel: () => void;
  onCreate: () => void;
};

const inputClass = "rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]";

function Field({ label, required = false, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted">
        {label}{required ? " *" : ""}
      </span>
      {children}
    </label>
  );
}

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
  const setField = (key: keyof IncidentCreateForm, value: string) => onFormChange({ ...form, [key]: value });

  return (
    <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Create incident</h2>
          <p className="mt-1 text-sm text-muted">
            Required fields are marked with an asterisk. Supporting files upload after ERIS creates the incident record.
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50"
        >
          Cancel
        </button>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Field label="Title" required>
          <input className={inputClass} value={form.title} onChange={(event) => setField("title", event.target.value)} />
        </Field>
        <Field label="Incident type">
          <input className={inputClass} value={form.incident_type} onChange={(event) => setField("incident_type", event.target.value)} />
        </Field>
        <Field label="Description">
          <textarea className={`${inputClass} min-h-20`} value={form.description} onChange={(event) => setField("description", event.target.value)} />
        </Field>
        <Field label="First observed" required>
          <input type="datetime-local" className={inputClass} value={form.first_observed_at} onChange={(event) => setField("first_observed_at", event.target.value)} />
        </Field>
        <Field label="First occurred">
          <input type="datetime-local" className={inputClass} value={form.first_occurred_at} onChange={(event) => setField("first_occurred_at", event.target.value)} />
        </Field>
        <div className="hidden xl:block" />
        <Field label="Latitude" required>
          <input
            type="number"
            step="0.000001"
            inputMode="decimal"
            className={inputClass}
            value={form.latitude}
            onChange={(event) => setField("latitude", event.target.value)}
            onBlur={() => setField("latitude", formatCoordinate(form.latitude))}
          />
        </Field>
        <Field label="Longitude" required>
          <input
            type="number"
            step="0.000001"
            inputMode="decimal"
            className={inputClass}
            value={form.longitude}
            onChange={(event) => setField("longitude", event.target.value)}
            onBlur={() => setField("longitude", formatCoordinate(form.longitude))}
          />
        </Field>
        <Field label="District">
          <input className={inputClass} value={form.district} onChange={(event) => setField("district", event.target.value)} />
        </Field>
        <Field label="County">
          <input className={inputClass} value={form.county} onChange={(event) => setField("county", event.target.value)} />
        </Field>
        <Field label="Route">
          <input
            className={inputClass}
            value={form.route}
            onChange={(event) => setField("route", event.target.value)}
            onBlur={() => setField("route", normalizeRouteInput(form.route))}
          />
        </Field>
        <Field label="Post mile">
          <input
            className={inputClass}
            value={form.post_mile}
            onChange={(event) => setField("post_mile", event.target.value)}
            onBlur={() => setField("post_mile", normalizePostMileInput(form.post_mile))}
          />
        </Field>
      </div>

      <div className="mt-5 grid gap-2 border-t border-[var(--line)] pt-4">
        <label className="text-xs font-semibold uppercase tracking-wide text-muted">Supporting files</label>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          disabled={busy}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onFiles(event.currentTarget.files)}
          className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-[var(--panel-soft)] file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-[var(--ink)]"
        />
        <div className="text-xs text-muted">Add photos, videos, PDFs, CAD, or other supporting evidence.</div>
        {pendingFiles.length > 0 ? (
          <div className="grid gap-1.5">
            {pendingFiles.map((pending, index) => {
              const sizeLabel = formatFileSize(pending.file.size);
              return (
                <div
                  key={`${pending.file.name}-${pending.file.lastModified}-${index}`}
                  className="flex items-center justify-between gap-3 rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{pending.file.name}</div>
                    <div className="text-xs text-muted">{sizeLabel ? `${pending.kind} · ${sizeLabel}` : pending.kind}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemoveFile(index)}
                    disabled={busy}
                    className="rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-xs hover:bg-[var(--panel-soft)] disabled:opacity-60"
                  >
                    Remove
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onCreate}
          disabled={busy}
          className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-60"
        >
          {busy ? "Creating…" : "Create incident"}
        </button>
      </div>
    </section>
  );
}

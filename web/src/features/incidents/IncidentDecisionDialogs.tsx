import { useState, type ReactNode } from "react";

import type { TriageDisposition } from "../../api/assessments";
import ModalDialog from "../../ui/ModalDialog";
import ProjectAssociationDialog from "../projects/ProjectAssociationDialog";

export type TriageDialogState = {
  incidentId: number;
  disposition: TriageDisposition;
  notes: string;
};

export type ResolveDialogState = {
  incidentId: number;
  comment: string;
};

const TRIAGE_OPTIONS: Array<{ value: TriageDisposition; label: string; description: string }> = [
  { value: "ASSESSMENT_REQUIRED", label: "Assessment required", description: "Route the incident for geotechnical assessment using the existing district workflow." },
  { value: "NO_ASSESSMENT_REQUIRED", label: "No assessment required", description: "Record that no geotechnical assessment is required for this incident." },
  { value: "NEEDS_REPORTER_INFORMATION", label: "Needs reporter information", description: "Return the incident for additional field or reporter information." },
  { value: "DUPLICATE_OR_LINKED", label: "Duplicate or linked", description: "Record that this incident duplicates or belongs with an existing incident or record." },
];

const inputClass = "rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]";

function DialogShell({
  titleId,
  title,
  description,
  busy,
  children,
  onClose,
}: {
  titleId: string;
  title: string;
  description: string;
  busy: boolean;
  children: ReactNode;
  onClose: () => void;
}) {
  const descriptionId = `${titleId}-description`;
  return (
    <ModalDialog titleId={titleId} descriptionId={descriptionId} busy={busy} onClose={onClose}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
          <p id={descriptionId} className="mt-1 text-sm text-muted">{description}</p>
        </div>
        <button type="button" onClick={onClose} disabled={busy} aria-label="Close dialog" className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 text-sm font-semibold hover:bg-[var(--panel-soft)] disabled:opacity-50">×</button>
      </div>
      <div className="mt-5">{children}</div>
    </ModalDialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid gap-1.5"><span className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</span>{children}</label>;
}

export function IncidentTriageDialog({ state, busy, onChange, onClose, onConfirm }: {
  state: TriageDialogState;
  busy: boolean;
  onChange: (next: TriageDialogState) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [projectReviewComplete, setProjectReviewComplete] = useState(false);
  const selected = TRIAGE_OPTIONS.find((option) => option.value === state.disposition);

  if (!projectReviewComplete) {
    return (
      <ProjectAssociationDialog
        incidentId={state.incidentId}
        onClose={onClose}
        onContinueToTriage={() => setProjectReviewComplete(true)}
      />
    );
  }

  return (
    <DialogShell
      titleId="incident-triage-dialog-title"
      title={`Triage incident #${state.incidentId}`}
      description="Project ownership is confirmed. Record the coordinator disposition; incident classification remains unassigned until the on-site assessment determines it."
      busy={busy}
      onClose={onClose}
    >
      <div className="grid gap-4">
        <div className="rounded-md border border-[color:color-mix(in_oklab,var(--good)_42%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_9%,transparent)] px-3 py-2 text-sm text-[var(--good)]">
          Project association confirmed for this coordinator review.
        </div>
        <Field label="Disposition">
          <select data-dialog-initial-focus="true" className={inputClass} value={state.disposition} onChange={(event) => onChange({ ...state, disposition: event.target.value as TriageDisposition })}>
            {TRIAGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </Field>
        <div className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm text-muted">{selected?.description}</div>
        <Field label="Decision notes">
          <textarea rows={4} className={inputClass} value={state.notes} onChange={(event) => onChange({ ...state, notes: event.target.value })} placeholder="Add context that should be preserved in the incident timeline." />
        </Field>
        <div className="flex justify-between gap-2">
          <button type="button" onClick={() => setProjectReviewComplete(false)} disabled={busy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">Review Project again</button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">Cancel</button>
            <button type="button" onClick={onConfirm} disabled={busy} className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50">{busy ? "Recording…" : "Record triage decision"}</button>
          </div>
        </div>
      </div>
    </DialogShell>
  );
}

export function IncidentResolveDialog({ state, busy, onChange, onClose, onConfirm }: {
  state: ResolveDialogState;
  busy: boolean;
  onChange: (next: ResolveDialogState) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <DialogShell
      titleId="incident-resolve-dialog-title"
      title={`Resolve incident #${state.incidentId}`}
      description="Mark this incident as resolved. An optional resolution note will be preserved with the workflow action."
      busy={busy}
      onClose={onClose}
    >
      <div className="grid gap-4">
        <Field label="Resolution note">
          <textarea data-dialog-initial-focus="true" rows={4} className={inputClass} value={state.comment} onChange={(event) => onChange({ ...state, comment: event.target.value })} placeholder="Optional resolution context" />
        </Field>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">Cancel</button>
          <button type="button" onClick={onConfirm} disabled={busy} className="rounded-md bg-[var(--good)] px-4 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50">{busy ? "Resolving…" : "Resolve incident"}</button>
        </div>
      </div>
    </DialogShell>
  );
}

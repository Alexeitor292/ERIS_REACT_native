import { useState, type ReactNode } from "react";

import ModalDialog from "../../ui/ModalDialog";
import ReportReviewDialog from "./ReportReviewDialog";
import TriageDecisionDialog from "./TriageDecisionDialog";
import { newTriageDraft } from "./triageDecisionModel";

export type ResolveDialogState = {
  incidentId: number;
  comment: string;
};

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

/**
 * Coordinator triage, in the order the decision is actually made:
 *
 *   1. REVIEW    — read the report and look at the evidence.
 *   2. DECISION  — choose what happens to it. Only "Assessment required" asks
 *                  which Incident Group it belongs to, in a panel that slides in
 *                  beside the decision.
 *
 * The draft lives here so stepping back to the report and forward again keeps
 * every choice. Nothing is saved until the decision is confirmed, and then the
 * decision and its Incident Group are saved together.
 */
export function IncidentTriageDialog({ incidentId, onClose, onDone }: {
  incidentId: number;
  onClose: () => void;
  /** Called once the decision is saved, with a sentence saying what happened. */
  onDone: (message: string) => void | Promise<void>;
}) {
  const [step, setStep] = useState<"REVIEW" | "DECISION">("REVIEW");
  const [draft, setDraft] = useState(() => newTriageDraft(incidentId));

  if (step === "REVIEW") {
    return <ReportReviewDialog incidentId={incidentId} onClose={onClose} onContinue={() => setStep("DECISION")} />;
  }
  return <TriageDecisionDialog draft={draft} onChange={setDraft} onBack={() => setStep("REVIEW")} onClose={onClose} onDone={onDone} />;
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

import type { Submission } from "../../api/types";
import ModalDialog from "../../ui/ModalDialog";
import { buildSubmissionDisplayTitle } from "../../utils/submissionLabel";

export default function SubmissionDeleteDialog({
  submission,
  busy,
  onClose,
  onConfirm,
}: {
  submission: Submission;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const title = buildSubmissionDisplayTitle({
    id: submission.id,
    created_at: submission.created_at,
    district: submission.district,
    county: submission.county,
    route: submission.route,
    post_mile: submission.post_mile,
  });
  const submittedRecord = submission.status !== "DRAFT";

  return (
    <ModalDialog
      titleId="submission-delete-title"
      descriptionId="submission-delete-description"
      busy={busy}
      onClose={onClose}
      panelClassName="w-full max-w-lg rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5 shadow-2xl"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--bad)]">Destructive action</div>
          <h2 id="submission-delete-title" className="mt-1 text-xl font-semibold">Delete submission #{submission.id}?</h2>
        </div>
        <button type="button" onClick={onClose} disabled={busy} aria-label="Close deletion confirmation" className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 text-sm font-semibold hover:bg-[var(--panel-soft)] disabled:opacity-50">×</button>
      </div>

      <div className="mt-5 rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-4">
        <div className="font-semibold">{title}</div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          <span>Status: <strong className="text-[var(--ink)]">{submission.status}</strong></span>
          <span>Creator: <strong className="text-[var(--ink)]">User #{submission.created_by_user_id}</strong></span>
        </div>
      </div>

      <div id="submission-delete-description" className={`mt-4 rounded-xl border p-4 text-sm leading-6 ${submittedRecord ? "border-[color:color-mix(in_oklab,var(--bad)_45%,var(--line))] bg-[color:color-mix(in_oklab,var(--bad)_8%,transparent)]" : "border-[var(--line)] bg-[var(--panel-soft)]"}`}>
        {submittedRecord ? (
          <>This record has already entered the submission/review workflow. Deleting it removes the ERIS record rather than returning it for correction. Use this only when permanent deletion is intended.</>
        ) : (
          <>This draft has not been submitted for review. Deleting it permanently removes the draft record.</>
        )}
      </div>

      <p className="mt-4 text-sm font-medium text-[var(--bad)]">This action cannot be undone from the Web UI.</p>

      <div className="mt-6 flex justify-end gap-2">
        <button data-dialog-initial-focus="true" type="button" onClick={onClose} disabled={busy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">Cancel</button>
        <button type="button" onClick={onConfirm} disabled={busy} className="rounded-md bg-[var(--bad)] px-4 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50">{busy ? "Deleting…" : "Delete submission"}</button>
      </div>
    </ModalDialog>
  );
}

import ModalDialog from "../../ui/ModalDialog";

/** The second step before a form goes for review: once sent, nobody can edit it until it is returned. */
export default function SubmitConfirmDialog({
  resubmit = false,
  busy = false,
  onClose,
  onConfirm,
}: {
  resubmit?: boolean;
  busy?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const action = resubmit ? "Resubmit for review" : "Submit for review";
  return (
    <ModalDialog
      titleId="submit-confirm-title"
      descriptionId="submit-confirm-description"
      busy={busy}
      onClose={onClose}
      panelClassName="w-full max-w-md rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5 shadow-2xl"
    >
      <h2 id="submit-confirm-title" className="text-lg font-semibold">{action}?</h2>
      <p id="submit-confirm-description" className="mt-2 text-sm text-muted">
        Make sure the form is finished. It cannot be edited until it is returned.
      </p>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="min-h-11 rounded-md border border-[var(--line)] px-4 text-sm font-semibold hover:bg-[var(--panel-soft)] disabled:opacity-50"
        >
          Keep editing
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="min-h-11 rounded-md bg-[var(--brand)] px-4 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50"
        >
          {action}
        </button>
      </div>
    </ModalDialog>
  );
}

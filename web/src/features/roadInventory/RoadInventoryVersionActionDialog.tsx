import type { RoadInventoryDataset } from "../../api/roadInventory";
import ModalDialog from "../../ui/ModalDialog";

type ActionKind = "publish" | "rollback";

export type RoadInventoryVersionAction = {
  kind: ActionKind;
  dataset: RoadInventoryDataset;
};

export default function RoadInventoryVersionActionDialog({
  action,
  currentPublished,
  busy,
  onClose,
  onConfirm,
}: {
  action: RoadInventoryVersionAction;
  currentPublished: RoadInventoryDataset | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { dataset, kind } = action;
  const publishing = kind === "publish";
  const title = publishing ? "Publish road inventory version" : "Rollback road inventory version";

  return (
    <ModalDialog
      titleId="road-inventory-action-title"
      descriptionId="road-inventory-action-description"
      busy={busy}
      onClose={onClose}
      panelClassName="w-full max-w-xl rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5 shadow-2xl"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Authoritative dataset change</div>
          <h2 id="road-inventory-action-title" className="mt-1 text-xl font-semibold">{title}</h2>
        </div>
        <button type="button" aria-label="Close confirmation" onClick={onClose} disabled={busy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 text-sm font-semibold hover:bg-[var(--panel-soft)] disabled:opacity-50">×</button>
      </div>

      <div className="mt-5 rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-xs font-semibold uppercase tracking-wide text-muted">Target version</dt><dd className="mt-1 font-semibold">{dataset.version_tag}</dd></div>
          <div><dt className="text-xs font-semibold uppercase tracking-wide text-muted">Dataset ID</dt><dd className="mt-1 font-semibold tabular-nums">#{dataset.id}</dd></div>
          <div><dt className="text-xs font-semibold uppercase tracking-wide text-muted">Rows</dt><dd className="mt-1 font-semibold tabular-nums">{dataset.row_count.toLocaleString()}</dd></div>
          <div><dt className="text-xs font-semibold uppercase tracking-wide text-muted">Current status</dt><dd className="mt-1 font-semibold capitalize">{dataset.status}</dd></div>
        </dl>
      </div>

      <div id="road-inventory-action-description" className="mt-4 rounded-xl border border-[color:color-mix(in_oklab,var(--brand)_35%,var(--line))] bg-[color:color-mix(in_oklab,var(--brand)_7%,transparent)] p-4 text-sm leading-6">
        {publishing ? (
          <>
            This will make <strong>{dataset.version_tag}</strong> the authoritative road inventory used for matching and future mobile-package generation.
            {currentPublished && currentPublished.id !== dataset.id ? <> The currently published version <strong>{currentPublished.version_tag}</strong> will no longer be authoritative.</> : null}
          </>
        ) : (
          <>
            This will restore superseded version <strong>{dataset.version_tag}</strong> as the authoritative road inventory. The currently published version
            {currentPublished ? <> <strong>{currentPublished.version_tag}</strong></> : null} will be superseded by the rollback.
          </>
        )}
      </div>

      <p className="mt-4 text-sm text-muted">After this change, regenerate the mobile road-inventory package if field devices need the new authoritative dataset.</p>

      <div className="mt-6 flex justify-end gap-2">
        <button data-dialog-initial-focus="true" type="button" onClick={onClose} disabled={busy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">Cancel</button>
        <button type="button" onClick={onConfirm} disabled={busy} className={`rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 ${publishing ? "bg-[var(--brand)]" : "bg-[var(--bad)]"}`}>{busy ? "Applying…" : publishing ? "Publish version" : "Confirm rollback"}</button>
      </div>
    </ModalDialog>
  );
}

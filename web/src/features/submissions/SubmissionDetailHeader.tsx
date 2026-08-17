import { Link } from "react-router-dom";
import { useState } from "react";
import { SubmissionStatusBadge } from "./SubmissionDetailPrimitives";

type Props = {
  status?: string;
  invalid: boolean;
  busy: boolean;
  canAct: boolean;
  canDelete: boolean;
  onRefresh: () => void;
  onApprove: () => void;
  onReject: () => void;
  onDelete: () => void;
};

export default function SubmissionDetailHeader({
  status,
  invalid,
  busy,
  canAct,
  canDelete,
  onRefresh,
  onApprove,
  onReject,
  onDelete,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link
            className="inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-[var(--ink)]"
            to="/submissions"
          >
            <span aria-hidden>←</span>
            <span>Submissions</span>
          </Link>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {status ? <SubmissionStatusBadge status={status} /> : null}
            {status === "SUBMITTED" ? (
              <span className="text-xs text-muted">Ready for reviewer decision</span>
            ) : status === "DRAFT" ? (
              <span className="text-xs text-muted">Editable field record</span>
            ) : status === "REJECTED" ? (
              <span className="text-xs text-muted">Returned for correction and resubmission</span>
            ) : status === "APPROVED" ? (
              <span className="text-xs text-muted">Review complete</span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy || invalid}
            className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Working…" : "Refresh"}
          </button>

          {canAct ? (
            <>
              <button
                type="button"
                onClick={onReject}
                disabled={busy || invalid}
                className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_50%,var(--line))] bg-[var(--panel)] px-3 py-2 text-sm font-semibold text-[var(--bad)] hover:bg-[color:color-mix(in_oklab,var(--bad)_8%,var(--panel))] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Return for correction
              </button>
              <button
                type="button"
                onClick={onApprove}
                disabled={busy || invalid}
                className="rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Approve submission
              </button>
            </>
          ) : null}

          {canDelete ? (
            <div className="relative">
              <button
                type="button"
                aria-label="More submission actions"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
                disabled={invalid}
                className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-semibold hover:bg-[var(--panel-soft)] disabled:opacity-50"
              >
                •••
              </button>
              {menuOpen ? (
                <div className="absolute right-0 top-11 z-30 min-w-52 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-1.5 shadow-xl">
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onDelete();
                    }}
                    className="block w-full rounded-md px-3 py-2 text-left text-sm font-medium text-[var(--bad)] hover:bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)]"
                  >
                    Delete submission
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

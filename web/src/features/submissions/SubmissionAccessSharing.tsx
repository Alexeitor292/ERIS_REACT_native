import { useMemo } from "react";
import { CheckCircle2, Clock3 } from "lucide-react";

import type { FormShare, FormShares } from "../../api/sharing";
import { SubmissionDetailCard } from "./SubmissionDetailPrimitives";
import { filterShareCandidates, SHARE_STATUS_LABELS, shareReviewLine, shareRouteSummary, shareUserLabel } from "./submissionAccessSharingModel";

const button =
  "rounded border border-[var(--line)] bg-[var(--panel-soft)] px-2.5 py-1.5 text-xs font-medium hover:brightness-95 disabled:opacity-60";

const STATUS_TONES: Record<string, string> = {
  ACTIVE: "border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] text-[var(--good)]",
  PENDING: "border-[color:color-mix(in_oklab,#d97706_45%,var(--line))] bg-[color:color-mix(in_oklab,#f59e0b_12%,var(--panel))] text-[color:color-mix(in_oklab,#b45309_75%,var(--ink))]",
};

/**
 * Sharing a technical form: viewing and editing, through the branch and office
 * chiefs. Branch chiefs approve anything going into or out of their branch; a
 * share inside one branch goes through at once and its chief is told. Office
 * chiefs are told when it leaves their office or involves one of their Senior
 * Specialists, and may stop it.
 */
export default function SubmissionAccessSharing({
  query,
  data,
  busy,
  onQueryChange,
  onShare,
  onWithdraw,
}: {
  query: string;
  data: FormShares | null;
  busy: boolean;
  onQueryChange: (value: string) => void;
  onShare: (userId: number) => void;
  onWithdraw: (userId: number) => void;
}) {
  const open = useMemo(() => (data?.shares ?? []).filter((share) => share.status === "PENDING" || share.status === "ACTIVE"), [data]);
  const past = useMemo(() => (data?.shares ?? []).filter((share) => share.status !== "PENDING" && share.status !== "ACTIVE"), [data]);
  const grants = data?.grants ?? [];
  const candidates = useMemo(
    () =>
      filterShareCandidates(data?.candidates ?? [], query, [
        ...open.map((share) => ({ user_id: share.recipient.id })),
        ...grants.map((grant) => ({ user_id: grant.user_id })),
      ]),
    [data, query, open, grants],
  );
  const searching = query.trim().length > 0;

  return (
    <SubmissionDetailCard
      title="Sharing"
      subtitle="Sharing gives viewing and editing. Branch chiefs approve anything going into or out of their branch; inside one branch it goes through and the chief is told. Office chiefs are told when it leaves their office or involves a Senior Specialist, and may stop it."
    >
      <label className="block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Share with</span>
        <input
          type="search"
          autoComplete="off"
          className="w-full rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]"
          placeholder="Search by name or email"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          disabled={busy}
        />
      </label>

      {searching ? (
        <div className="mt-2 space-y-1">
          {candidates.length === 0 ? (
            <div className="rounded border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm text-muted">Nobody else matches.</div>
          ) : (
            candidates.map((user) => (
              <div key={user.id} className="flex flex-wrap items-center justify-between gap-3 rounded border border-[var(--line)] p-2 text-sm">
                <div className="min-w-0">
                  <div className="font-medium">{shareUserLabel(user)}</div>
                  <div className="truncate text-xs text-muted">{user.placement ?? user.email}</div>
                  <div className="mt-1 flex items-start gap-1 text-xs">
                    {user.route.immediate ? <CheckCircle2 size={13} className="mt-px shrink-0 text-[var(--good)]" aria-hidden /> : <Clock3 size={13} className="mt-px shrink-0 text-muted" aria-hidden />}
                    <span>{shareRouteSummary(user.route)}</span>
                  </div>
                </div>
                <button type="button" onClick={() => onShare(user.id)} disabled={busy} className={button}>
                  {user.route.immediate ? "Share" : "Ask to share"}
                </button>
              </div>
            ))
          )}
        </div>
      ) : null}

      <div className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">Shared with ({open.length + grants.length})</div>
      {open.length + grants.length === 0 ? <div className="mt-1 text-sm text-muted">Nobody yet.</div> : null}
      <div className="mt-2 space-y-1">
        {open.map((share) => (
          <ShareRow key={share.id} share={share} busy={busy} onWithdraw={onWithdraw} />
        ))}
        {grants.map((grant) => (
          <div key={`g${grant.user_id}`} className="flex flex-wrap items-center justify-between gap-3 rounded border border-[var(--line)] p-2 text-sm">
            <div className="min-w-0">
              <div className="font-medium">{shareUserLabel(grant)}</div>
              <div className="text-xs text-muted">{grant.can_edit ? "Can view and edit" : "Can view"} · given before shares needed approval</div>
            </div>
            <button type="button" onClick={() => onWithdraw(grant.user_id)} disabled={busy} className={button}>Remove</button>
          </div>
        ))}
      </div>

      {past.length ? (
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted">Earlier requests ({past.length})</summary>
          <ul className="mt-2 space-y-1">
            {past.map((share) => (
              <li key={share.id} className="rounded border border-[var(--line)] px-2 py-1.5">
                <span className="font-medium">{shareUserLabel({ full_name: share.recipient.full_name ?? "", email: share.recipient.email ?? "" })}</span>
                <span className="text-muted"> · {SHARE_STATUS_LABELS[share.status] ?? share.status}{share.ended_by ? ` by ${share.ended_by}` : ""}</span>
                {share.end_note ? <div className="text-xs text-muted">“{share.end_note}”</div> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </SubmissionDetailCard>
  );
}

function ShareRow({ share, busy, onWithdraw }: { share: FormShare; busy: boolean; onWithdraw: (userId: number) => void }) {
  return (
    <div className="rounded border border-[var(--line)] p-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{shareUserLabel({ full_name: share.recipient.full_name ?? "", email: share.recipient.email ?? "" })}</span>
            <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_TONES[share.status] ?? ""}`}>{SHARE_STATUS_LABELS[share.status]}</span>
          </div>
          <div className="truncate text-xs text-muted">{share.recipient.email}</div>
        </div>
        <button type="button" onClick={() => onWithdraw(share.recipient.id)} disabled={busy} className={button}>
          {share.status === "PENDING" ? "Withdraw" : "Stop sharing"}
        </button>
      </div>
      {share.reviews.length ? (
        <ul className="mt-1.5 grid gap-0.5 text-xs text-muted">
          {share.reviews.map((review) => <li key={review.id}>{shareReviewLine(review)}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

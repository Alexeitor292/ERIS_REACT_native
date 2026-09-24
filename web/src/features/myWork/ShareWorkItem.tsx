import { useState } from "react";
import { Link } from "react-router-dom";
import { Share2 } from "lucide-react";

import { decideShare, type ShareReviewItem } from "../../api/sharing";
import { shareReviewLine, shareUserLabel } from "../submissions/submissionAccessSharingModel";

const person = (value: { full_name: string | null; email: string | null }) => shareUserLabel({ full_name: value.full_name ?? "", email: value.email ?? "" });

/**
 * A share waiting on a branch or office chief. APPROVAL: the share takes effect
 * only once every branch chief with a say approves. NOTICE: the chief is told,
 * and may stop it; if they do nothing it stands.
 */
export default function ShareWorkItem({ item, onDecided }: { item: ShareReviewItem; onDecided: (message: string) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const approval = item.kind === "APPROVAL";
  const form = item.submission.title ? `“${item.submission.title}”` : `technical form #${item.submission.id}`;

  async function act(decision: "APPROVE" | "REJECT" | "ACKNOWLEDGE", message: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await decideShare(item, decision, note);
      onDecided(decision === "APPROVE" && result.status === "PENDING" ? "Approved. It takes effect once the other branch chief approves too." : message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record your decision.");
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-5">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
        <Share2 size={14} aria-hidden /> {approval ? `Sharing to approve · ${item.unit_label}` : `Sharing you were told about · ${item.unit_label}`}
      </div>
      <h2 className="mt-1 text-lg font-semibold">
        {person(item.owner)} is sharing {form} with {person(item.recipient)}
      </h2>
      <dl className="mt-3 grid gap-1.5 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
        <dt className="text-muted">Form</dt>
        <dd><Link to={`/submissions/${item.submission.id}`} className="text-[var(--brand)] hover:underline">Technical form #{item.submission.id}</Link></dd>
        <dt className="text-muted">Owner</dt>
        <dd>{person(item.owner)}{item.owner.placement ? <span className="text-muted"> · {item.owner.placement}</span> : null}</dd>
        {item.sharer.id !== item.owner.id ? (<><dt className="text-muted">Shared by</dt><dd>{person(item.sharer)}</dd></>) : null}
        <dt className="text-muted">With</dt>
        <dd>{person(item.recipient)}{item.recipient.placement ? <span className="text-muted"> · {item.recipient.placement}</span> : null}</dd>
        <dt className="text-muted">Gives</dt>
        <dd>Viewing and editing</dd>
      </dl>

      <p className="mt-3 text-sm">
        {approval
          ? "It takes effect only once every branch chief below approves. Rejecting it stops it."
          : item.status === "ACTIVE"
            ? "It is in effect. You need not do anything; you may stop it."
            : "It is waiting on the branch chiefs. You need not do anything; you may stop it."}
      </p>
      <ul className="mt-2 grid gap-0.5 text-xs text-muted">
        {item.reviews.map((review) => <li key={review.id}>{shareReviewLine(review)}</li>)}
      </ul>

      <label className="mt-4 block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Note (optional)</span>
        <textarea
          rows={2}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          className="w-full rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm"
          placeholder={approval ? "Why, if you reject it" : "Why, if you stop it"}
        />
      </label>
      {error ? <div className="mt-2 text-sm text-[var(--bad)]">{error}</div> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {approval ? (
          <>
            <button type="button" disabled={busy} onClick={() => act("APPROVE", "Approved. The form is now shared.")} className="rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">Approve</button>
            <button type="button" disabled={busy} onClick={() => act("REJECT", "Rejected. The form was not shared.")} className="rounded-md border border-[var(--line)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-60">Reject</button>
          </>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={() => act("ACKNOWLEDGE", "Noted. The share stands.")} className="rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">Keep it</button>
            <button type="button" disabled={busy} onClick={() => act("REJECT", "Stopped. The form is no longer shared.")} className="rounded-md border border-[var(--line)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-60">Stop sharing</button>
          </>
        )}
      </div>
    </div>
  );
}

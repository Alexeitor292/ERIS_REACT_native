import { useState } from "react";

import { deliverImmediateActions } from "../../api/fieldNotices";
import { deliveryOutcome, deliveryProblem } from "./fieldNoticeModel";

/** Sends the immediate actions now, even from a draft. The people told can't open the form. */
export default function ImmediateActionsDelivery({ submissionId, actions }: { submissionId: number; actions: readonly string[] }) {
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const problem = deliveryProblem(actions, description);

  async function deliver() {
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const result = await deliverImmediateActions(submissionId, { actions: [...actions], description: description.trim(), client_uuid: crypto.randomUUID() });
      setNotice(deliveryOutcome(result));
      setDescription("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 grid gap-2 rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-4">
      <h3 className="text-sm font-bold">Deliver immediate actions</h3>
      <p className="text-[13px] text-muted">Tells the supervisor and the District Contact right away. They can't open this draft.</p>
      <label className="grid gap-1 text-sm font-semibold">
        Description
        <textarea
          rows={2}
          maxLength={800}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className="w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-normal"
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={busy || !!problem} onClick={() => void deliver()} className="rounded-md bg-[var(--brand)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? "Delivering…" : "Deliver now"}
        </button>
        {problem && !notice ? <span className="text-[13px] text-muted">{problem}</span> : null}
        {notice ? <span className="text-[13px] font-semibold text-[var(--good)]">{notice}</span> : null}
        {error ? <span className="text-[13px] text-[var(--bad)]">{error}</span> : null}
      </div>
    </div>
  );
}

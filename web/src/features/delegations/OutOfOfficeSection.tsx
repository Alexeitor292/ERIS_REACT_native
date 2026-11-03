import { useCallback, useEffect, useMemo, useState } from "react";

import {
  cancelDelegation,
  createDelegation,
  delegationActions,
  delegationCandidates,
  delegationPeople,
  myDelegations,
  type DelegatedAction,
  type Delegation,
  type DelegationCandidate,
  type DelegationOverview,
} from "../../api/delegations";
import { useAuth } from "../../auth/AuthContext";
import { actionLabel, dayLabel, formProblem, isOpen, periodLabel, statusLabel } from "./delegationModel";

const inputClass = "w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm";
const buttonClass = "rounded-md border border-[var(--line)] px-3 py-1.5 text-sm font-semibold hover:bg-[var(--panel-soft)] disabled:opacity-50";

function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Settings › Out of office: name someone to act for you between two dates, and act for others. */
export default function OutOfOfficeSection() {
  const { me, actFor } = useAuth();
  const [overview, setOverview] = useState<DelegationOverview | null>(null);
  const [people, setPeople] = useState<Array<{ id: number; full_name: string }>>([]);
  const [candidates, setCandidates] = useState<DelegationCandidate[]>([]);
  const [person, setPerson] = useState<number | null>(null);
  const [delegateId, setDelegateId] = useState<number | null>(null);
  const today = useMemo(localToday, []);
  const [startsOn, setStartsOn] = useState(today);
  const [endsOn, setEndsOn] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ id: number; items: DelegatedAction[] } | null>(null);

  const acting = !!me?.acting;

  const load = useCallback(async () => {
    setOverview(await myDelegations());
  }, []);

  useEffect(() => {
    if (acting) return;
    load().catch((e: Error) => setError(e.message));
    delegationPeople().then((r) => setPeople(r.items)).catch(() => setPeople([]));
  }, [acting, load]);

  useEffect(() => {
    if (acting) return;
    setDelegateId(null);
    delegationCandidates(person).then((r) => setCandidates(r.items)).catch(() => setCandidates([]));
  }, [acting, person]);

  if (acting) {
    return (
      <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 md:p-5">
        <h2 className="text-base font-semibold">Out of office</h2>
        <p className="mt-1 text-sm text-muted">This is set as yourself. Go back to your own work to change it.</p>
      </section>
    );
  }

  const problem = formProblem({ delegateId, startsOn, endsOn }, today);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function set() {
    if (problem || delegateId == null) return;
    await run(async () => {
      await createDelegation({
        delegate_user_id: delegateId,
        starts_on: startsOn,
        ends_on: endsOn,
        note: note.trim() || undefined,
        for_user_id: person ?? undefined,
      });
      setDelegateId(null);
      setEndsOn("");
      setNote("");
    });
  }

  async function toggleActions(id: number) {
    if (opened?.id === id) return setOpened(null);
    const { items } = await delegationActions(id);
    setOpened({ id, items });
  }

  const row = (item: Delegation, other: string) => (
    <li key={item.id} className="py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{other}</span>
        <span className="rounded-full bg-[var(--panel-soft)] px-2 py-0.5 text-xs font-semibold">{statusLabel(item.status)}</span>
        <span className="text-sm text-muted">{periodLabel(item)}</span>
        <span className="ml-auto flex flex-wrap gap-2">
          {item.action_count > 0 ? (
            <button type="button" className={buttonClass} onClick={() => toggleActions(item.id).catch((e: Error) => setError(e.message))}>
              {item.action_count} action{item.action_count === 1 ? "" : "s"}
            </button>
          ) : null}
          {isOpen(item) ? (
            <button type="button" disabled={busy} className={buttonClass} onClick={() => run(() => cancelDelegation(item.id))}>
              {item.status === "ACTIVE" ? "End now" : "Cancel"}
            </button>
          ) : null}
        </span>
      </div>
      {item.note ? <p className="mt-1 text-sm text-muted">{item.note}</p> : null}
      {opened?.id === item.id ? (
        <ul className="mt-2 space-y-1 text-sm">
          {opened.items.map((action, index) => (
            <li key={index} className="text-muted">
              {new Date(action.created_at).toLocaleString()} · {action.actor_name} · {actionLabel(action.method, action.path)}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );

  return (
    <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 md:p-5">
      <div className="max-w-2xl">
        <h2 className="text-base font-semibold">Out of office</h2>
        <p className="mt-1 text-sm text-muted">
          Name someone to act for you between two dates. They can switch to acting for you and see and do your work.
          Everything they do is recorded under both names, and it ends by itself after the last day.
        </p>
      </div>
      {error ? <p className="mt-3 text-sm text-[var(--bad)]">{error}</p> : null}

      {overview?.acting_options.length ? (
        <div className="mt-4 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3">
          <h3 className="text-sm font-semibold">You can act for</h3>
          <ul className="mt-2 space-y-2">
            {overview.acting_options.map((option) => (
              <li key={option.user_id} className="flex flex-wrap items-center gap-2 text-sm">
                <span>{option.full_name}, until {dayLabel(option.ends_on)}</span>
                <button type="button" className={buttonClass} onClick={() => actFor(option.user_id)}>Act for {option.full_name}</button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-4 grid max-w-3xl gap-3 md:grid-cols-2">
        {people.length ? (
          <label className="text-sm font-semibold md:col-span-2">
            For
            <select className={`mt-1 ${inputClass}`} value={person ?? ""} onChange={(e) => setPerson(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Myself</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
            </select>
          </label>
        ) : null}
        <label className="text-sm font-semibold md:col-span-2">
          Who will act {person ? "for them" : "for you"}
          <select className={`mt-1 ${inputClass}`} value={delegateId ?? ""} onChange={(e) => setDelegateId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Select a person…</option>
            {candidates.map((c) => <option key={c.id} value={c.id}>{c.full_name} · {c.placement}</option>)}
          </select>
          {!candidates.length ? <span className="mt-1 block text-[13px] font-normal text-muted">Someone in the same office, or on the same district's lists.</span> : null}
        </label>
        <label className="text-sm font-semibold">
          First day
          <input type="date" className={`mt-1 ${inputClass}`} value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
        </label>
        <label className="text-sm font-semibold">
          Last day
          <input type="date" min={startsOn || today} className={`mt-1 ${inputClass}`} value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
        </label>
        <label className="text-sm font-semibold md:col-span-2">
          Note (optional)
          <input maxLength={500} className={`mt-1 ${inputClass}`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Where things stand, who to ask" />
        </label>
        <div className="flex flex-wrap items-center gap-3 md:col-span-2">
          <button
            type="button"
            disabled={busy || !!problem}
            onClick={() => void set()}
            className="rounded-md bg-[var(--brand)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            Set out of office
          </button>
          {problem && delegateId != null ? <span className="text-[13px] text-muted">{problem}</span> : null}
        </div>
      </div>

      {overview?.given.length ? (
        <div className="mt-5">
          <h3 className="text-sm font-semibold">Acting for you</h3>
          <ul className="divide-y divide-[var(--line)]">{overview.given.map((item) => row(item, item.delegate.full_name))}</ul>
        </div>
      ) : null}
      {overview?.received.length ? (
        <div className="mt-5">
          <h3 className="text-sm font-semibold">You act for</h3>
          <ul className="divide-y divide-[var(--line)]">{overview.received.map((item) => row(item, item.delegator.full_name))}</ul>
        </div>
      ) : null}
    </section>
  );
}

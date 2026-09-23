import { useEffect, useId, useState } from "react";
import { ArrowRight, Loader2, Search, ShieldCheck } from "lucide-react";

import ModalDialog from "../../../ui/ModalDialog";
import { findPeople, type PersonHit, type Placement } from "../../../api/orgTree";
import { roleLabel } from "../../../utils/roleModel";

export type PickRule = {
  /** The office the person will sit in, or null for a maintenance list. */
  officeId: number | null;
  isAdmin: boolean;
  /** A branch chief may only bring in people who sit nowhere yet. */
  branchChiefOnly: boolean;
};

/** Why this person cannot be picked here by this user, or null when they can. */
function blockedReason(hit: PersonHit, rule: PickRule): string | null {
  const place = hit.placement;
  if (rule.isAdmin || rule.officeId == null || !place.position) return null;
  if (place.office_id !== rule.officeId) return "In another office: an administrator can move them.";
  if (place.position === "OFFICE_CHIEF") return "An office chief: an administrator can move them.";
  if (rule.branchChiefOnly) return "Already in this office: your office chief can move them.";
  return null;
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function whereNow(hit: PersonHit): string {
  const parts: string[] = [];
  if (hit.placement.label) parts.push(hit.placement.label);
  const districts = (list: string[]) => list.map((d) => `D${Number(d)}`).join(", ");
  if (hit.maintenance.coordinator.length) parts.push(`Coordinator · ${districts(hit.maintenance.coordinator)}`);
  if (hit.maintenance.crew.length) parts.push(`Crew · ${districts(hit.maintenance.crew)}`);
  if (parts.length) return parts.join(" · ");
  // Placed nowhere: a guest, an administrator, or somebody still holding a role from before the trees.
  const held = hit.roles.filter((role) => role !== "GUEST" && role !== "ADMIN");
  if (held.length) return `${held.map(roleLabel).join(", ")} · not placed yet`;
  return hit.is_admin ? "Administrator · in no tree" : "Guest · in no tree";
}

/**
 * Pick an already registered person for a place in a tree or list. Somebody who
 * sits elsewhere is shown where, and moving them is confirmed first.
 */
export default function PersonPickerDialog({
  title,
  target,
  rule,
  onPick,
  onClose,
}: {
  title: string;
  /** What they become, for the confirmation: "Staff in Branch A". */
  target: string;
  rule: PickRule;
  onPick: (person: PersonHit) => Promise<void>;
  onClose: () => void;
}) {
  const titleId = useId();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PersonHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState<PersonHit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      findPeople(query)
        .then((res) => !cancelled && setHits(res.items))
        .catch((e) => !cancelled && setError(e?.message ?? "Could not search people."))
        .finally(() => !cancelled && setLoading(false));
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  async function pick(hit: PersonHit) {
    setError(null);
    // Taking somebody out of another place in a tree is confirmed first.
    if (rule.officeId != null && hit.placement.position && confirming?.id !== hit.id) {
      setConfirming(hit);
      return;
    }
    setBusy(true);
    try {
      await onPick(hit);
      onClose();
    } catch (e: any) {
      setError(e?.message ?? "Could not add this person.");
      setConfirming(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalDialog titleId={titleId} onClose={onClose} busy={busy} panelClassName="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-[var(--line)] bg-[var(--panel)] shadow-2xl">
      <div className="border-b border-[var(--line)] p-4">
        <h2 id={titleId} className="text-base font-semibold">{title}</h2>
        <p className="mt-0.5 text-xs text-muted">Choose someone already registered in ERIS. Their role follows from where they sit.</p>
        <label className="relative mt-3 block">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setConfirming(null);
            }}
            placeholder="Search by name or email"
            aria-label="Search by name or email"
            className="w-full rounded-md border border-[var(--line)] bg-[var(--panel-soft)] py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]"
          />
        </label>
      </div>

      {error ? <div role="alert" className="mx-4 mt-3 rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}

      <ul className="min-h-40 flex-1 overflow-auto p-2" aria-busy={loading}>
        {loading && !hits.length ? (
          <li className="flex items-center gap-2 px-3 py-6 text-sm text-muted"><Loader2 size={15} className="animate-spin" /> Searching…</li>
        ) : !hits.length ? (
          <li className="px-3 py-6 text-sm text-muted">Nobody registered matches “{query}”.</li>
        ) : (
          hits.map((hit) => {
            const blocked = blockedReason(hit, rule);
            const isConfirming = confirming?.id === hit.id;
            return (
              <li key={hit.id}>
                <button
                  type="button"
                  disabled={!!blocked || busy}
                  onClick={() => pick(hit)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left ${
                    isConfirming ? "bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--panel))] ring-1 ring-[var(--brand)]" : "hover:bg-[var(--panel-soft)]"
                  } disabled:cursor-not-allowed disabled:opacity-55`}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--panel-soft)] text-xs font-semibold ring-1 ring-[var(--line)]" aria-hidden>
                    {initials(hit.full_name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-sm font-semibold">
                      <span className="truncate">{hit.full_name}</span>
                      {hit.is_admin ? <ShieldCheck size={13} className="shrink-0 text-[var(--brand)]" aria-label="Administrator" /> : null}
                    </span>
                    <span className="block truncate text-xs text-muted">{hit.email}</span>
                    <span className={`block truncate text-[11px] ${blocked ? "text-[var(--warn-text)]" : "text-muted"}`}>{blocked ?? whereNow(hit)}</span>
                  </span>
                </button>
                {isConfirming ? <MoveConfirm place={hit.placement} target={target} name={hit.full_name} busy={busy} onConfirm={() => pick(hit)} onCancel={() => setConfirming(null)} /> : null}
              </li>
            );
          })
        )}
      </ul>

      <div className="flex justify-end border-t border-[var(--line)] p-3">
        <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-[var(--line)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">
          Cancel
        </button>
      </div>
    </ModalDialog>
  );
}

function MoveConfirm({ place, target, name, busy, onConfirm, onCancel }: { place: Placement; target: string; name: string; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="mx-3 mb-2 mt-1 rounded-lg border border-[color:color-mix(in_oklab,var(--warn)_45%,var(--line))] bg-[color:color-mix(in_oklab,var(--warn)_8%,var(--panel))] p-3 text-xs">
      <p className="flex flex-wrap items-center gap-1.5">
        <span className="font-semibold">Move {name}?</span>
        <span className="text-muted">{place.label}</span>
        <ArrowRight size={12} aria-hidden />
        <span className="font-semibold">{target}</span>
      </p>
      <p className="mt-1 text-muted">Their role changes with the move.</p>
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={onConfirm} disabled={busy} className="rounded-md bg-[var(--brand)] px-2.5 py-1 font-semibold text-white disabled:opacity-60">Move them</button>
        <button type="button" onClick={onCancel} disabled={busy} className="rounded-md border border-[var(--line)] px-2.5 py-1 font-medium">Keep them where they are</button>
      </div>
    </div>
  );
}

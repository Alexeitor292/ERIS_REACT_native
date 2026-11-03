import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  assessmentAssignmentOptions,
  assessmentWorkload,
  branchOptions,
  moveAssessments,
  seniorEngineerOptions,
  type PickerGroup,
  type WorkGroup,
  type WorkKind,
} from "../../api/assessments";
import PersonPicker from "../assessments/PersonPicker";
import type { PickerPerson } from "../assessments/personPickerModel";
import { groupKey, holderLine, moveOutcome, pickerLabel, withoutHolder } from "./moveWorkModel";

type Options = { groups: PickerGroup[]; items: PickerPerson[] };

function optionsFor(kind: WorkKind, assessmentId: number): Promise<Options> {
  const request: Promise<{ groups?: PickerGroup[]; items?: unknown[] }> =
    kind === "BRANCH_CHIEF" ? branchOptions(assessmentId)
      : kind === "SENIOR_SPECIALIST" ? seniorEngineerOptions(assessmentId)
        : assessmentAssignmentOptions(assessmentId, "ENGINEER");
  return request.then((response) => ({ groups: response.groups ?? [], items: (response.items ?? []) as PickerPerson[] }));
}

/**
 * For a chief: open work by who holds it. Someone who has moved on comes first, and
 * their work waits here to be spread around, or all given to whoever took over.
 */
export default function MoveWorkPanel({ onMoved }: { onMoved: () => void }) {
  const [groups, setGroups] = useState<WorkGroup[]>([]);
  const [left, setLeft] = useState(0);
  const [open, setOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [options, setOptions] = useState<Options>({ groups: [], items: [] });
  const [toUser, setToUser] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    assessmentWorkload()
      .then((workload) => {
        setGroups(workload.groups);
        setLeft(workload.left);
      })
      .catch(() => setGroups([]));
  }, []);

  useEffect(load, [load]);

  if (!groups.length) return null;

  function openOne(group: WorkGroup) {
    const key = groupKey(group);
    if (openGroup === key) return setOpenGroup(null);
    setOpenGroup(key);
    setChosen(new Set(group.items.map((item) => item.id)));
    setToUser(null);
    setNotes("");
    setMessage(null);
    setOptions({ groups: [], items: [] });
    optionsFor(group.kind, group.items[0].id).then(setOptions).catch(() => undefined);
  }

  function toggle(id: number) {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function move(group: WorkGroup) {
    if (toUser == null || !chosen.size) return;
    setBusy(true);
    try {
      const to = options.items.find((person) => person.id === toUser)?.full_name ?? "them";
      const result = await moveAssessments({
        assessment_ids: group.items.filter((item) => chosen.has(item.id)).map((item) => item.id),
        to_user_id: toUser,
        kind: group.kind,
        notes: notes.trim() || undefined,
      });
      setMessage(moveOutcome(result, to));
      setOpenGroup(null);
      load();
      onMoved();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-3">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full flex-wrap items-center gap-2 text-left">
        <span className="text-sm font-semibold">Move work</span>
        {left ? (
          <span className="rounded-full bg-[color:color-mix(in_oklab,var(--bad)_14%,var(--panel))] px-2 py-0.5 text-xs font-semibold text-[var(--bad)]">
            {left} left by someone who moved on
          </span>
        ) : <span className="text-[13px] text-muted">See who holds what, and move it</span>}
        <span className="ml-auto text-xs text-muted">{open ? "Hide" : "Show"}</span>
      </button>
      {message ? <p className="mt-2 text-sm">{message}</p> : null}
      {open ? (
        <ul className="mt-3 divide-y divide-[var(--line)]">
          {groups.map((group) => {
            const key = groupKey(group);
            return (
              <li key={key} className="py-2">
                <button type="button" onClick={() => openOne(group)} aria-expanded={openGroup === key} className="flex w-full items-center gap-2 text-left text-sm">
                  <span className={group.left ? "font-semibold text-[var(--bad)]" : "font-semibold"}>{holderLine(group)}</span>
                  <span className="ml-auto text-muted">{group.items.length} open</span>
                </button>
                {openGroup === key ? (
                  <div className="mt-2 space-y-2">
                    <ul className="space-y-1">
                      {group.items.map((item) => (
                        <li key={item.id} className="flex items-center gap-2 text-sm">
                          <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" aria-label={`Move assessment ${item.id}`} checked={chosen.has(item.id)} onChange={() => toggle(item.id)} />
                          <Link className="font-semibold underline" to={`/my-work?assessment=${item.id}`}>#{item.id}</Link>
                          <span className="min-w-0 truncate">{item.title ?? "Assessment"}</span>
                          <span className="ml-auto shrink-0 text-xs text-muted">{item.state.replace(/_/g, " ").toLowerCase()}</span>
                        </li>
                      ))}
                    </ul>
                    <PersonPicker
                      label={pickerLabel(group.kind)}
                      placeholder="Select a person…"
                      groups={options.groups}
                      items={withoutHolder(options.items, group.holder.id)}
                      value={toUser}
                      onChange={setToUser}
                    />
                    <input
                      value={notes}
                      maxLength={1000}
                      onChange={(event) => setNotes(event.target.value)}
                      placeholder="Note (optional)"
                      className="w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm"
                    />
                    <button
                      type="button"
                      disabled={busy || toUser == null || !chosen.size}
                      onClick={() => void move(group)}
                      className="rounded-md bg-[var(--brand)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      Move {chosen.size} assessment{chosen.size === 1 ? "" : "s"}
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

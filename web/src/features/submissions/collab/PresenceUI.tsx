import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { Lock, Users } from "lucide-react";

import { fieldElement } from "./presenceDom";
import { colorFor, fieldLabel, initialsOf, othersIn, people, presenceSentence, type PresenceOther } from "./presenceModel";

function where(other: PresenceOther): string {
  if (other.memos.length) return `writing ${other.memos.map((memo) => fieldLabel(memo)).join(", ")}`;
  if (other.field) return `in ${other.field}`;
  return "here";
}

/** A circle with someone's initials, in their colour. */
export function PresenceDot({ other, size = 22 }: { other: PresenceOther; size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white ring-2 ring-[var(--panel)]"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: colorFor(other.user_id) }}
      title={`${other.name} is ${where(other)}`}
      aria-label={`${other.name} is ${where(other)}`}
    >
      {initialsOf(other.name)}
    </span>
  );
}

/** Overlapping circles for everyone in one place. */
export function PresenceDots({ others, size }: { others: readonly PresenceOther[]; size?: number }) {
  if (!others.length) return null;
  return (
    <span className="inline-flex items-center -space-x-1.5">
      {people(others).map((other) => <PresenceDot key={other.user_id} other={other} size={size} />)}
    </span>
  );
}

/** The line at the top of the form: who else is in it. */
export function PresenceBar({ others }: { others: readonly PresenceOther[] }) {
  const sentence = presenceSentence(others);
  if (!sentence) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-xs" aria-live="polite">
      <Users size={14} className="shrink-0 text-muted" aria-hidden />
      <PresenceDots others={others} size={24} />
      <span className="font-medium">{sentence}.</span>
      <span className="text-muted">Their changes appear here as they save; the part of the form each of them is in is outlined in their colour.</span>
    </div>
  );
}

/** The outline a card or memo gets while someone is in it. */
export function presenceRing(others: readonly PresenceOther[]): { boxShadow?: string } {
  const first = others[0];
  return first ? { boxShadow: `0 0 0 2px ${colorFor(first.user_id)}` } : {};
}

/** The same, drawn a few pixels outside an area that has no padding of its own. */
export function presenceOutline(others: readonly PresenceOther[]): { outline?: string; outlineOffset?: string } {
  const first = others[0];
  return first ? { outline: `2px solid ${colorFor(first.user_id)}`, outlineOffset: "6px" } : {};
}

/** Outlines, inside `area`, the fields the others are in. */
export function useFieldOutlines(area: RefObject<HTMLElement | null>, others: readonly PresenceOther[]) {
  const key = others.map((other) => `${other.user_id}:${other.field ?? ""}`).join("|");
  useEffect(() => {
    const root = area.current;
    if (!root) return;
    const marked: HTMLElement[] = [];
    for (const other of others) {
      if (!other.field) continue;
      const element = fieldElement(root, other.field);
      if (!element || marked.includes(element)) continue;
      element.dataset.presenceBy = initialsOf(other.name);
      element.style.setProperty("--presence-color", colorFor(other.user_id));
      marked.push(element);
    }
    return () => {
      for (const element of marked) {
        delete element.dataset.presenceBy;
        element.style.removeProperty("--presence-color");
      }
    };
    // `key` stands for `others`: re-run when someone moves, not on every heartbeat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [area, key]);
}

/** Over a memo someone else is writing. */
export function MemoLockNotice({ writer }: { writer: PresenceOther }) {
  return (
    <div className="mb-2 flex items-center gap-2 rounded-md border px-3 py-2 text-xs" style={{ borderColor: colorFor(writer.user_id) }} role="status">
      <PresenceDot other={writer} size={22} />
      <Lock size={13} className="shrink-0 text-muted" aria-hidden />
      <span>
        <span className="font-semibold">{writer.name}</span> is writing here. It opens for you once they save, leave the form, or stop typing for 10 minutes.
      </span>
    </div>
  );
}

export type Conflict = { key: string; label: string; mine: string; theirs: string };

/** Fields both people changed: each keeps one version. */
export function ConflictDialog({
  conflicts,
  savedBy,
  choice,
  onChoose,
  onApply,
  onClose,
}: {
  conflicts: readonly Conflict[];
  savedBy: string | null;
  choice: Record<string, "mine" | "theirs">;
  onChoose: (key: string, pick: "mine" | "theirs") => void;
  onApply: () => void;
  onClose: () => void;
}) {
  const who = savedBy ?? "Someone else";
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
      <div className="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 shadow-2xl">
        <h2 id="conflict-title" className="text-base font-semibold">{who} changed the same fields</h2>
        <p className="mt-1 text-sm text-muted">
          {who} saved these after you started editing them. Choose which version each field keeps; everything else you changed is saved as it is.
        </p>
        <div className="mt-3 grid gap-3">
          {conflicts.map((conflict) => (
            <fieldset key={conflict.key} className="rounded-lg border border-[var(--line)] p-3">
              <legend className="px-1 text-sm font-semibold">{conflict.label}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {(["mine", "theirs"] as const).map((pick) => (
                  <label
                    key={pick}
                    className={`flex cursor-pointer gap-2 rounded-md border p-2 text-sm ${choice[conflict.key] === pick ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_8%,var(--panel))]" : "border-[var(--line)]"}`}
                  >
                    <input type="radio" name={`conflict-${conflict.key}`} checked={choice[conflict.key] === pick} onChange={() => onChoose(conflict.key, pick)} className="mt-1" />
                    <span className="min-w-0">
                      <span className="block text-xs font-semibold uppercase tracking-wide text-muted">{pick === "mine" ? "Yours" : `${who}'s`}</span>
                      <span className="block whitespace-pre-wrap break-words">{(pick === "mine" ? conflict.mine : conflict.theirs) || "(empty)"}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-[var(--line)] px-3 py-1.5 text-sm hover:bg-[var(--panel-soft)]">Decide later</button>
          <button type="button" onClick={onApply} className="rounded-md bg-[var(--brand)] px-3 py-1.5 text-sm font-semibold text-white hover:brightness-95">Keep these and save</button>
        </div>
      </div>
    </div>
  );
}

/**
 * A section of the form (Location, Measurements, Actions, Memos) that shows who
 * is in it: outlined in their colour, their initials on its top-right corner,
 * and the field each of them is in outlined.
 */
export function PresenceArea({
  area,
  others,
  id,
  className,
  children,
}: {
  area: string;
  others: readonly PresenceOther[];
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const here = othersIn(others, area);
  useFieldOutlines(ref, here);
  return (
    <section ref={ref} id={id} data-presence-area={area} className={`relative ${className ?? ""}`} style={presenceRing(here)}>
      {here.length ? (
        <span className="pointer-events-auto absolute -right-2 -top-2.5 z-10">
          <PresenceDots others={here} size={24} />
        </span>
      ) : null}
      {children}
    </section>
  );
}

import type { ReactNode } from "react";
import { Check } from "lucide-react";

type Option = { code: string; label: string };

type Props = {
  title: string;
  description: string;
  icon: ReactNode;
  accent: string;
  options: Option[];
  selected: string[];
  onToggle: (code: string) => void;
  onClear: () => void;
  editable: boolean;
};

/**
 * One group of GISA actions as a checklist: a row per action with a real
 * checkbox, the count chosen, and a way to clear them. Replaces the wall of
 * toggle bubbles.
 */
export default function ActionChecklist({ title, description, icon, accent, options, selected, onToggle, onClear, editable }: Props) {
  const chosen = options.filter((option) => selected.includes(option.code));
  return (
    <div className="@container flex min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
      <div className="flex items-start gap-3 border-b border-[var(--line)] px-4 py-3" style={{ background: `color-mix(in oklab, ${accent} 7%, var(--panel))` }}>
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white" style={{ background: accent }} aria-hidden>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold">{title}</h3>
            <span className="text-[11px] font-medium text-muted" aria-live="polite">
              {chosen.length} of {options.length} selected
            </span>
          </div>
          <p className="text-xs text-muted">{description}</p>
        </div>
      </div>

      {options.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted">No actions are defined.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-px bg-[var(--line)] @xl:grid-cols-2" role="group" aria-label={title}>
          {options.map((option) => {
            const on = selected.includes(option.code);
            return (
              <li key={option.code} className="bg-[var(--panel)]">
                <label
                  className={`flex h-full items-center gap-2.5 px-4 py-2 text-sm transition-colors ${editable ? "cursor-pointer hover:bg-[var(--panel-soft)]" : "cursor-default"}`}
                  style={on ? { background: `color-mix(in oklab, ${accent} 9%, var(--panel))` } : undefined}
                >
                  <input type="checkbox" className="peer sr-only" checked={on} disabled={!editable} onChange={() => onToggle(option.code)} />
                  <span
                    className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded border-2 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-offset-1"
                    style={on ? { background: accent, borderColor: accent } : { borderColor: "var(--line)" }}
                    aria-hidden
                  >
                    {on ? <Check size={12} strokeWidth={3} className="text-white" /> : null}
                  </span>
                  <span className={on ? "font-medium" : ""}>{option.label}</span>
                </label>
              </li>
            );
          })}
          {options.length % 2 === 1 ? <li className="hidden bg-[var(--panel)] @xl:block" aria-hidden /> : null}
        </ul>
      )}

      {editable && chosen.length ? (
        <div className="flex justify-end border-t border-[var(--line)] px-4 py-1.5">
          <button type="button" onClick={onClear} className="text-xs text-muted hover:text-[var(--ink)]">
            Clear selection
          </button>
        </div>
      ) : null}
    </div>
  );
}

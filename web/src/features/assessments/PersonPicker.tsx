import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";

import type { PickerGroup } from "../../api/assessments";
import {
  availabilityNote,
  buildPickerSections,
  flattenPickerOptions,
  moveHighlight,
  personPlaceNote,
  selectablePickerOptions,
  selectedPerson,
  typeaheadIndex,
  workloadNote,
  type PickerPerson,
} from "./personPickerModel";

/**
 * The routing picker: a listbox over people, grouped by branch or by home city.
 *
 * It replaces a native `<select>` whose whole content was "Name · email", which
 * is not enough to hand work to a person: the chief needs to see which branch
 * they lead, where they sit, how much they are already carrying and whether
 * they are around. All four are annotations — **the picker informs and never
 * chooses** (owner decision 7):
 *
 *  - it opens with NO value, whatever the data shape, including a list of one;
 *  - the primary action beside it stays disabled until a person is chosen;
 *  - groups are in the office's order and people are alphabetical inside a
 *    group — never ordered by workload, which would read as a ranking;
 *  - somebody rotated out is shown with their return date, never filtered out;
 *  - a branch that is not staffed yet is shown disabled with the reason, never
 *    silently omitted.
 *
 * Keyboard: Enter / Space / Down opens, Up and Down move, Home and End jump,
 * Enter or Space chooses, Escape closes without choosing, and printable
 * characters type ahead. `aria-activedescendant` carries the focus for screen
 * readers while real focus stays on the button.
 */
export default function PersonPicker({
  groups,
  items,
  value,
  onChange,
  placeholder,
  label,
  disabled = false,
  emptyMessage = "No one is available to choose here.",
}: {
  groups: PickerGroup[];
  items: PickerPerson[];
  /** null until a human has chosen. Never seeded from the options. */
  value: number | null;
  onChange: (id: number | null) => void;
  placeholder: string;
  label: string;
  disabled?: boolean;
  emptyMessage?: string;
}) {
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const typeahead = useRef<{ buffer: string; at: number }>({ buffer: "", at: 0 });

  const sections = useMemo(() => buildPickerSections(groups ?? [], items ?? []), [groups, items]);
  const allOptions = useMemo(() => flattenPickerOptions(sections), [sections]);
  const selectable = useMemo(() => selectablePickerOptions(sections), [sections]);
  const chosen = selectedPerson(sections, value);

  // The options changed under the picker (a different assessment, a different
  // route): close it and drop the highlight. The VALUE is owned by the caller,
  // which resets it on the same events — a picker must never keep a selection
  // that no longer exists in its list.
  useEffect(() => {
    setOpen(false);
    setHighlight(-1);
  }, [sections]);

  useEffect(() => {
    if (!open) return;
    const onDocumentDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDocumentDown);
    return () => document.removeEventListener("mousedown", onDocumentDown);
  }, [open]);

  // Keep the active option in view as the arrow keys move it.
  useEffect(() => {
    if (!open || highlight < 0) return;
    const option = selectable[highlight];
    if (!option) return;
    listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(`${baseId}-option-${option.id}`)}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [baseId, highlight, open, selectable]);

  const choose = (person: PickerPerson | undefined) => {
    if (!person) return;
    onChange(person.id);
    setOpen(false);
    setHighlight(-1);
    buttonRef.current?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (disabled) return;
    if (!open && (event.key === "ArrowDown" || event.key === "Enter" || event.key === " " || event.key === "ArrowUp")) {
      event.preventDefault();
      setOpen(true);
      setHighlight(selectable.length ? 0 : -1);
      return;
    }
    if (!open) return;
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        setOpen(false);
        setHighlight(-1);
        buttonRef.current?.focus();
        return;
      case "ArrowDown":
        event.preventDefault();
        setHighlight((current) => moveHighlight(selectable, current, 1));
        return;
      case "ArrowUp":
        event.preventDefault();
        setHighlight((current) => moveHighlight(selectable, current, -1));
        return;
      case "Home":
        event.preventDefault();
        setHighlight(selectable.length ? 0 : -1);
        return;
      case "End":
        event.preventDefault();
        setHighlight(selectable.length ? selectable.length - 1 : -1);
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        choose(selectable[highlight]);
        return;
      case "Tab":
        setOpen(false);
        setHighlight(-1);
        return;
      default:
        break;
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now();
      const state = typeahead.current;
      state.buffer = now - state.at > 700 ? event.key : state.buffer + event.key;
      state.at = now;
      const index = typeaheadIndex(selectable, state.buffer, state.buffer.length > 1 ? highlight - 1 : highlight);
      if (index >= 0) setHighlight(index);
    }
  };

  const activeOption = highlight >= 0 ? selectable[highlight] : undefined;
  const buttonLabel = chosen ? chosen.full_name : placeholder;

  return (
    <div className="relative min-w-0 flex-1">
      <button
        ref={buttonRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-label={label}
        // On the combobox itself, not on the listbox: `aria-activedescendant`
        // belongs on the element that holds DOM focus, and focus stays here
        // while the arrow keys move the highlight inside the popup.
        aria-activedescendant={open && activeOption ? `${baseId}-option-${activeOption.id}` : undefined}
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setOpen((current) => !current);
          setHighlight(-1);
        }}
        onKeyDown={onKeyDown}
        className="flex w-full items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className={`min-w-0 flex-1 truncate ${chosen ? "font-medium" : "text-muted"}`}>{buttonLabel}</span>
        {chosen ? <span className="shrink-0 text-xs text-muted">{workloadNote(chosen)}</span> : null}
        <ChevronDown size={16} strokeWidth={1.9} aria-hidden className="shrink-0 text-muted" />
      </button>

      {open ? (
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          onKeyDown={onKeyDown}
          className="absolute left-0 right-0 z-30 mt-1 max-h-80 overflow-auto rounded-lg border border-[var(--line)] bg-[var(--panel)] py-1 shadow-[0_18px_40px_rgba(15,23,42,0.18)]"
        >
          {allOptions.length === 0 ? (
            <div className="px-3 py-3 text-sm text-muted">{emptyMessage}</div>
          ) : (
            sections.map((section) => (
              <div key={section.group.group_key} role="group" aria-label={section.label}>
                <div className="flex flex-wrap items-baseline gap-x-2 border-b border-[var(--line)]/60 bg-[var(--panel-soft)] px-3 py-1.5">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{section.label}</span>
                  {section.group.is_own_branch ? (
                    <span className="rounded-full border border-[var(--brand)] px-1.5 py-px text-[10px] font-semibold text-[var(--brand)]">Your branch</span>
                  ) : null}
                  {section.place ? <span className="text-[11px] text-muted">{section.place}</span> : null}
                  {section.group.districts_covered?.length ? (
                    <span className="text-[11px] text-muted">Covers {section.group.districts_covered.join(", ")}</span>
                  ) : null}
                  {section.disabledReason ? <span className="text-[11px] font-medium text-[var(--bad)]">{section.disabledReason}</span> : null}
                </div>
                {section.items.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-muted">No one recorded in this group yet.</div>
                ) : (
                  section.items.map((person) => {
                    const optionDisabled = section.disabledReason != null;
                    const index = optionDisabled ? -1 : selectable.findIndex((candidate) => candidate.id === person.id);
                    const active = index >= 0 && index === highlight;
                    const isChosen = chosen?.id === person.id;
                    const place = personPlaceNote(person);
                    const away = availabilityNote(person);
                    return (
                      <div
                        key={person.id}
                        id={`${baseId}-option-${person.id}`}
                        role="option"
                        aria-selected={isChosen}
                        aria-disabled={optionDisabled || undefined}
                        onMouseEnter={() => { if (!optionDisabled) setHighlight(index); }}
                        onClick={() => { if (!optionDisabled) choose(person); }}
                        className={`flex cursor-pointer items-start gap-2 px-3 py-2 ${optionDisabled ? "cursor-not-allowed opacity-55" : ""} ${active ? "bg-[color:color-mix(in_oklab,var(--brand)_10%,transparent)]" : ""}`}
                      >
                        <span className="mt-0.5 w-4 shrink-0 text-[var(--brand)]">{isChosen ? <Check size={14} strokeWidth={2.2} aria-hidden /> : null}</span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-baseline gap-x-2">
                            <span className="text-sm font-medium">{person.full_name}</span>
                            <span className="text-xs text-muted">{person.email}</span>
                          </span>
                          <span className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
                            {place ? <span>{place}</span> : null}
                            <span>{workloadNote(person)}</span>
                          </span>
                          {away ? <span className="mt-0.5 block text-xs font-medium text-[var(--bad)]">{away}</span> : null}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

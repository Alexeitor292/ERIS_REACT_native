import { useId, type CSSProperties, type ReactNode } from "react";
import { Check, Minus, Plus, X } from "lucide-react";

// Controls for the GISA sheet's cards. Values stay strings, as the form's draft
// holds them: "" means not recorded, which is not the same as 0.

export const fieldLabel = "mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted";
export const fieldInput = "w-full rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2.5 py-1.5 text-sm";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** A number with its unit written inside the box. */
export function UnitInput({
  id,
  value,
  onChange,
  unit,
  label,
  className = "",
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  unit: string;
  label?: string;
  className?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      <input
        id={id}
        aria-label={label}
        type="number"
        step="any"
        inputMode="decimal"
        className={`${fieldInput} pr-9 tabular-nums`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted">{unit}</span>
    </div>
  );
}

export function NumberField({ label, unit, value, onChange }: { label: string; unit: string; value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 block text-xs font-medium">{label}</label>
      <UnitInput id={id} value={value} onChange={onChange} unit={unit} />
    </div>
  );
}

/** A date picker while the value is an ISO date (or empty); older free-text dates stay editable as text. */
export function DateField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = useId();
  const iso = value === "" || /^\d{4}-\d{2}-\d{2}$/.test(value);
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={fieldLabel}>{label}</label>
      <input id={id} type={iso ? "date" : "text"} className={fieldInput} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/**
 * A bounded value set by dragging or typing. The box takes values beyond the
 * slider's range (the thumb then rests at the end); the × clears it back to
 * "not recorded".
 */
export function SliderField({
  label,
  name,
  icon,
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  unit = "%",
  color,
}: {
  label: ReactNode;
  /** The label as plain words, for assistive tech, when `label` is not a string. */
  name?: string;
  icon?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  color?: string;
}) {
  const id = useId();
  const number = value.trim() === "" ? null : Number(value);
  const set = number != null && Number.isFinite(number);
  const fill = set ? ((clamp(number, min, max) - min) / (max - min)) * 100 : 0;
  const style = { "--fill": `${fill}%`, ...(color ? { "--range-color": color } : {}) } as CSSProperties;
  return (
    <div className="min-w-0">
      <div className="mb-0.5 flex items-center gap-2">
        <label htmlFor={id} className="flex min-w-0 flex-1 items-center gap-1.5 text-xs font-medium">
          {icon ? <span className="shrink-0" style={color ? { color } : undefined} aria-hidden>{icon}</span> : null}
          <span className="truncate">{label}</span>
        </label>
        <UnitInput value={value} onChange={onChange} unit={unit} label={name ?? (typeof label === "string" ? label : undefined)} className="w-[5.5rem] shrink-0 [&_input]:py-1 [&_input]:text-right" />
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear"
          title="Clear"
          className={`shrink-0 rounded p-0.5 text-muted hover:text-[var(--ink)] ${set ? "" : "invisible"}`}
        >
          <X size={13} />
        </button>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={set ? clamp(number, min, max) : min}
        onChange={(e) => onChange(e.target.value)}
        aria-valuetext={set ? `${number} ${unit}` : "Not recorded"}
        className={`eris-range ${set ? "" : "is-empty"}`}
        style={style}
      />
    </div>
  );
}

/** One choice from a few, as a segmented control; choosing the active one again clears it. */
export function Segmented({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ value: string; label: ReactNode }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex max-w-full flex-wrap rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-0.5">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(active ? "" : option.value)}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              active ? "bg-[var(--brand)] text-white shadow-sm" : "text-muted hover:text-[var(--ink)]"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A choice drawn as a tile with a check box (several allowed) or a radio dot (one of a set). */
export function OptionTile({
  active,
  onClick,
  children,
  kind = "check",
  className = "",
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  kind?: "check" | "radio";
  className?: string;
}) {
  return (
    <button
      type="button"
      role={kind === "radio" ? "radio" : "checkbox"}
      aria-checked={active}
      onClick={onClick}
      className={`flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs font-medium transition-colors ${
        active
          ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_12%,var(--panel))]"
          : "border-[var(--line)] bg-[var(--panel)] hover:border-[color:color-mix(in_oklab,var(--brand)_60%,var(--line))]"
      } ${className}`}
    >
      <span
        aria-hidden
        className={`flex h-4 w-4 shrink-0 items-center justify-center ${kind === "radio" ? "rounded-full" : "rounded"} ${
          active ? "bg-[var(--brand)] text-white" : "border border-[var(--line)] bg-[var(--panel-soft)]"
        }`}
      >
        {active ? kind === "radio" ? <span className="h-1.5 w-1.5 rounded-full bg-white" /> : <Check size={11} strokeWidth={3} /> : null}
      </span>
      <span className="min-w-0">{children}</span>
    </button>
  );
}

/** A small whole number, stepped with − and +. */
export function Stepper({ label, value, onChange, min = 0, max = 12 }: { label: string; value: string; onChange: (value: string) => void; min?: number; max?: number }) {
  const number = value.trim() === "" ? null : Number(value);
  const button = "flex h-8 w-8 items-center justify-center text-muted hover:text-[var(--ink)] disabled:opacity-30";
  return (
    <div className="inline-flex items-center rounded-md border border-[var(--line)] bg-[var(--panel-soft)]" role="group" aria-label={label}>
      <button type="button" className={button} aria-label={`Fewer ${label.toLowerCase()}`} disabled={number == null || number <= min} onClick={() => onChange(String(Math.max(min, (number ?? min) - 1)))}>
        <Minus size={14} />
      </button>
      <span className="w-8 text-center text-sm font-semibold tabular-nums" aria-live="polite">{number ?? "–"}</span>
      <button type="button" className={button} aria-label={`More ${label.toLowerCase()}`} disabled={number != null && number >= max} onClick={() => onChange(String(Math.min(max, number == null ? min : number + 1)))}>
        <Plus size={14} />
      </button>
    </div>
  );
}

/** A labelled row: the label on the left, its control on the right; stacks in a narrow card. */
export function InlineField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <span className="text-xs font-medium">{label}</span>
      {children}
    </div>
  );
}

/** A group inside a card, headed like a form section. */
export function FieldGroup({ title, aside, children, className = "" }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 ${className}`}>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</h4>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** One of a set of alternatives drawn as a panel: its header picks it, its body holds its details. */
export function PanelChoice({ active, onSelect, title, children }: { active: boolean; onSelect: () => void; title: string; children: ReactNode }) {
  return (
    <div
      className={`min-w-0 rounded-lg border p-2.5 transition-colors ${
        active ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_5%,var(--panel))]" : "border-[var(--line)]"
      }`}
    >
      <button type="button" role="radio" aria-checked={active} onClick={onSelect} className="mb-2 flex w-full items-center gap-2 text-left">
        <span
          aria-hidden
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${active ? "bg-[var(--brand)]" : "border border-[var(--line)] bg-[var(--panel-soft)]"}`}
        >
          {active ? <span className="h-1.5 w-1.5 rounded-full bg-white" /> : null}
        </span>
        <span className="text-sm font-semibold">{title}</span>
      </button>
      <div className={`transition-opacity ${active ? "" : "opacity-60 hover:opacity-100 focus-within:opacity-100"}`}>{children}</div>
    </div>
  );
}

/** Soil fractions as one stacked bar, with how far their total is from 100%. */
export function CompositionBar({ parts }: { parts: ReadonlyArray<{ label: string; value: string; color: string }> }) {
  const values = parts.map((part) => ({ ...part, n: Number(part.value) })).filter((part) => part.value.trim() !== "" && Number.isFinite(part.n) && part.n > 0);
  if (!values.length) return null;
  const total = values.reduce((sum, part) => sum + part.n, 0);
  const scale = Math.max(100, total);
  const rounded = Math.round(total * 10) / 10;
  const status =
    Math.abs(total - 100) < 0.05
      ? { text: "Total 100%", tone: "text-[var(--good)]" }
      : total < 100
        ? { text: `Total ${rounded}% · ${Math.round((100 - total) * 10) / 10}% not assigned`, tone: "text-muted" }
        : { text: `Total ${rounded}% · over by ${Math.round((total - 100) * 10) / 10}%`, tone: "text-[var(--bad)]" };
  return (
    <div className="mt-2.5">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-[color:color-mix(in_oklab,var(--line)_70%,var(--panel))]" role="img" aria-label={values.map((part) => `${part.label} ${part.n}%`).join(", ")}>
        {values.map((part) => (
          <span key={part.label} title={`${part.label} ${part.n}%`} style={{ width: `${(part.n / scale) * 100}%`, background: part.color }} />
        ))}
      </div>
      <div className={`mt-1 text-[11px] font-medium ${status.tone}`}>{status.text}</div>
    </div>
  );
}

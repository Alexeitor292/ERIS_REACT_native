import type { ReactNode } from "react";

export function SubmissionStatusBadge({ status }: { status: string }) {
  const classes =
    status === "APPROVED"
      ? "bg-[color:color-mix(in_oklab,var(--good)_16%,transparent)] text-[var(--good)] border-[color:color-mix(in_oklab,var(--good)_48%,transparent)]"
      : status === "REJECTED"
        ? "bg-[color:color-mix(in_oklab,var(--bad)_16%,transparent)] text-[var(--bad)] border-[color:color-mix(in_oklab,var(--bad)_48%,transparent)]"
        : status === "SUBMITTED"
          ? "bg-[color:color-mix(in_oklab,var(--brand)_16%,transparent)] text-[var(--brand)] border-[color:color-mix(in_oklab,var(--brand)_48%,transparent)]"
          : "bg-[var(--panel-soft)] text-[var(--ink)] border-[var(--line)]";

  return (
    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold tracking-wide ${classes}`}>
      {status}
    </span>
  );
}

export function SubmissionDetailRow({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="grid grid-cols-3 gap-3 border-b border-[var(--line)]/70 py-2 text-sm last:border-b-0">
      <div className="text-muted">{label}</div>
      <div className="col-span-2 font-medium">{value == null || value === "" ? "-" : String(value)}</div>
    </div>
  );
}

/**
 * Always-open detail card. Replaces the collapsed `<details>` sections so review
 * context (summary, reviewer note, workflow history, access sharing) is visible at
 * a glance in the responsive card grid.
 */
export function SubmissionDetailCard({
  title,
  subtitle,
  actions,
  children,
  className = "",
  bodyClassName = "",
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`flex min-w-0 flex-col rounded-xl border border-[var(--line)] bg-[var(--panel)] ${className}`}>
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--line)]/70 px-4 py-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--brand)]">{title}</div>
          {subtitle ? <div className="mt-0.5 text-xs text-muted">{subtitle}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      <div className={`min-w-0 flex-1 px-4 py-3 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

/** Responsive grid used for the review context cards under the GISA form. */
export function SubmissionDetailCardGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr))]">{children}</div>;
}

// Compatibility aliases keep older call sites working while the page is decomposed.
export function S({ s }: { s: string }) {
  return <SubmissionStatusBadge status={s} />;
}

export function R({ l, v }: { l: string; v: unknown }) {
  return <SubmissionDetailRow label={l} value={v} />;
}

export function Section({ title, children }: { title: string; children: ReactNode; open?: boolean }) {
  return <SubmissionDetailCard title={title}>{children}</SubmissionDetailCard>;
}

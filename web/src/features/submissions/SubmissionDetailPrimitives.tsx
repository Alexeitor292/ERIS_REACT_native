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

export function SubmissionDisclosureSection({
  title,
  children,
  open = false,
}: {
  title: string;
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details className="border-t border-[var(--line)]/60 py-3" open={open}>
      <summary className="cursor-pointer select-none text-xs font-semibold uppercase tracking-wide text-muted">
        {title}
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

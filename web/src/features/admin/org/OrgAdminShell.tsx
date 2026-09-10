import { NavLink } from "react-router-dom";
import type { ReactNode } from "react";

import AppShell from "../../../ui/AppShell";

/**
 * The three Organization tabs, and the chrome they share.
 *
 * Offices · Branches · Coverage is one admin job split by object, not three
 * unrelated pages: moving a district (Offices) changes what Coverage flags, and
 * deactivating a branch (Branches) changes what a picker offers. The tabs keep
 * that adjacency visible (org model design §11, new §7.22).
 */
const TABS = [
  { to: "/admin/org/offices", label: "Offices" },
  { to: "/admin/org/branches", label: "Branches" },
  { to: "/admin/org/coverage", label: "Coverage" },
] as const;

export const orgInput = "w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]";
export const orgLabel = "text-xs font-semibold uppercase tracking-wide text-muted";
export const orgButton = "rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:cursor-not-allowed disabled:opacity-50";
export const orgPrimary = "rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50";
export const orgSmallButton = "rounded border border-[var(--line)] px-2.5 py-1.5 text-xs font-semibold hover:bg-[var(--panel-soft)] disabled:cursor-not-allowed disabled:opacity-40";

export function OrgTabs() {
  return (
    <nav className="inline-flex shrink-0 overflow-hidden rounded-lg border border-[var(--line)]" aria-label="Organization">
      {TABS.map((tab, index) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          className={({ isActive }) =>
            `whitespace-nowrap px-4 py-2 text-sm font-semibold ${index > 0 ? "border-l border-[var(--line)]" : ""} ${
              isActive ? "bg-[var(--brand)] text-white" : "bg-[var(--panel)] text-[var(--ink)] hover:bg-[var(--panel-soft)]"
            }`
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}

export function OrgBanner({ error, notice }: { error?: string | null; notice?: string | null }) {
  return (
    <>
      {error ? (
        <div role="alert" className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div>
      ) : null}
      {notice ? (
        <div className="rounded-md border border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] px-3 py-2 text-sm text-[var(--good)]">{notice}</div>
      ) : null}
    </>
  );
}

export function OrgAdminShell({
  title,
  intro,
  toolbar,
  error,
  notice,
  children,
}: {
  title: string;
  intro: ReactNode;
  toolbar?: ReactNode;
  error?: string | null;
  notice?: string | null;
  children: ReactNode;
}) {
  return (
    <AppShell title={title}>
      <div className="flex h-full flex-col gap-4 p-4 md:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <OrgTabs />
          {toolbar ? <div className="ml-auto flex flex-wrap items-center gap-2">{toolbar}</div> : null}
        </div>
        <div className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm text-muted">{intro}</div>
        <OrgBanner error={error} notice={notice} />
        {children}
      </div>
    </AppShell>
  );
}

/** A small chip for a district, a letter, or a flag. */
export function OrgChip({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "warn" | "good" }) {
  const toneClass =
    tone === "warn"
      ? "border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] text-[var(--bad)]"
      : tone === "good"
        ? "border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] text-[var(--good)]"
        : "border-[var(--line)] bg-[var(--panel-soft)] text-[var(--ink)]";
  return <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${toneClass}`}>{children}</span>;
}

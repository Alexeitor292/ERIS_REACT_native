import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../api/client";
import type { EventGroupStatus, EventGroupSummary } from "../features/eventGroups/eventGroupTypes";
import { eventGroupLocationLabel, eventGroupStatusLabel } from "../features/eventGroups/eventGroupTypes";
import AppShell from "../ui/AppShell";

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateTimeFormatter.format(date);
}

export function EventGroupStatusBadge({ status }: { status: EventGroupStatus }) {
  const className = status === "OPEN"
    ? "border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] text-[var(--good)]"
    : status === "CLOSED"
      ? "border-[color:color-mix(in_oklab,var(--brand)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_10%,transparent)] text-[var(--brand)]"
      : "border-[var(--line)] bg-[var(--panel-soft)] text-muted";
  return <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${className}`}>{eventGroupStatusLabel(status)}</span>;
}

/** Event Groups: read-only record view (shared grouping context across independent incidents). */
export default function EventGroupsPage() {
  const [items, setItems] = useState<EventGroupSummary[]>([]);
  const [status, setStatus] = useState<"ALL" | EventGroupStatus>("OPEN");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams({ status, limit: "500" });
      if (search.trim()) query.set("q", search.trim());
      const response = await api<{ items: EventGroupSummary[] }>(`/event-groups?${query.toString()}`);
      setItems(response.items ?? []);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load Event Groups.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const handle = window.setTimeout(load, search.trim() ? 250 : 0);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, search]);

  const summary = useMemo(() => ({
    groups: items.length,
    incidents: items.reduce((total, group) => total + group.incident_count, 0),
    active: items.reduce((total, group) => total + group.open_incident_count, 0),
  }), [items]);

  return (
    <AppShell title="Event Groups">
      <div className="grid gap-4 p-4 md:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search title, county, route, or description" className="min-w-[280px] flex-1 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]" />
          <select value={status} onChange={(event) => setStatus(event.target.value as "ALL" | EventGroupStatus)} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm">
            <option value="OPEN">Open Event Groups</option>
            <option value="CLOSED">Closed Event Groups</option>
            <option value="ARCHIVED">Archived Event Groups</option>
            <option value="ALL">All Event Groups</option>
          </select>
          <span className="text-xs text-muted">{summary.groups} groups · {summary.incidents} incidents · {summary.active} active</span>
          <button type="button" onClick={load} disabled={busy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">{busy ? "Refreshing…" : "Refresh"}</button>
        </div>

        {error ? <div className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}

        <div className="overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--panel)]">
          <table className="w-full border-collapse">
            <thead><tr className="border-b border-[var(--line)] bg-[var(--panel-soft)] text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-muted"><th className="px-3 py-3">Event Group</th><th className="px-3 py-3">Location</th><th className="px-3 py-3">Incidents</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Last activity</th><th className="px-3 py-3 text-right">Action</th></tr></thead>
            <tbody>
              {items.length === 0 ? (
                <tr><td colSpan={6} className="px-3 py-10 text-center text-sm text-muted">{busy ? "Loading Event Groups…" : "No Event Groups match the current filters."}</td></tr>
              ) : items.map((group) => (
                <tr key={group.id} className="border-b border-[var(--line)]/60 align-top last:border-b-0 hover:bg-[var(--panel-soft)]">
                  <td className="px-3 py-3"><Link to={`/event-groups/${group.id}`} className="block text-[var(--ink)]"><div className="text-sm font-semibold hover:text-[var(--brand)]">{group.title}</div><div className="mt-0.5 text-xs text-muted">Event Group #{group.id}</div></Link></td>
                  <td className="px-3 py-3 text-sm text-muted">{eventGroupLocationLabel(group)}</td>
                  <td className="px-3 py-3 text-sm"><span className="font-semibold tabular-nums">{group.incident_count}</span><span className="text-muted"> total · {group.open_incident_count} active</span></td>
                  <td className="px-3 py-3"><EventGroupStatusBadge status={group.status} /></td>
                  <td className="px-3 py-3 text-sm text-muted">{formatDate(group.latest_incident_activity_at ?? group.updated_at)}</td>
                  <td className="px-3 py-3 text-right"><Link to={`/event-groups/${group.id}`} className="rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-[11px] font-semibold hover:bg-[var(--panel-soft)]">Open Event Group</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}

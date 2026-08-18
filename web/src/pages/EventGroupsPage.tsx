import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../api/client";
import type { EventGroupStatus, EventGroupSummary } from "../features/eventGroups/eventGroupTypes";
import { eventGroupLocationLabel, eventGroupStatusLabel } from "../features/eventGroups/eventGroupTypes";
import AppShell from "../ui/AppShell";

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function StatusBadge({ status }: { status: EventGroupStatus }) {
  const className = status === "OPEN"
    ? "border-[color:color-mix(in_oklab,var(--good)_42%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_9%,transparent)] text-[var(--good)]"
    : status === "CLOSED"
      ? "border-[color:color-mix(in_oklab,var(--brand)_35%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)] text-[var(--brand)]"
      : "border-[var(--line)] bg-[var(--panel-soft)] text-muted";
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${className}`}>{eventGroupStatusLabel(status)}</span>;
}

export default function EventGroupsPage() {
  const navigate = useNavigate();
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
    activeIncidents: items.reduce((total, group) => total + group.open_incident_count, 0),
  }), [items]);

  return (
    <AppShell title="Event Groups">
      <div className="flex h-full flex-col gap-4 p-4 md:p-5">
        <div className="flex flex-col gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-sm font-semibold">Event Group operations</div>
            <div className="mt-1 max-w-3xl text-sm text-muted">Event Groups connect Incidents that belong to the same operational event. Incidents remain independent historical records with their own identity, evidence, assessment, and workflow.</div>
          </div>
          <button type="button" onClick={load} disabled={busy} className="self-start rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50 md:self-auto">{busy ? "Refreshing…" : "Refresh"}</button>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4"><div className="text-xs font-semibold uppercase tracking-wide text-muted">Event Groups shown</div><div className="mt-1 text-2xl font-semibold tabular-nums">{summary.groups}</div></div>
          <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4"><div className="text-xs font-semibold uppercase tracking-wide text-muted">Associated Incidents</div><div className="mt-1 text-2xl font-semibold tabular-nums">{summary.incidents}</div></div>
          <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4"><div className="text-xs font-semibold uppercase tracking-wide text-muted">Active incidents</div><div className="mt-1 text-2xl font-semibold tabular-nums">{summary.activeIncidents}</div></div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search title, county, route, or description" className="min-w-[280px] flex-1 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]" />
          <select value={status} onChange={(event) => setStatus(event.target.value as "ALL" | EventGroupStatus)} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm">
            <option value="OPEN">Open Event Groups</option>
            <option value="CLOSED">Closed Event Groups</option>
            <option value="ARCHIVED">Archived Event Groups</option>
            <option value="ALL">All Event Groups</option>
          </select>
        </div>

        {error ? <div className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}

        <div className="flex-1 overflow-auto rounded-xl border border-[var(--line)] bg-[var(--panel)]">
          <table className="w-full border-collapse">
            <thead><tr className="border-b border-[var(--line)] bg-[var(--panel-soft)] text-left text-xs font-semibold uppercase tracking-wide text-muted"><th className="px-3 py-3">Event Group</th><th className="px-3 py-3">Location</th><th className="px-3 py-3">Incidents</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Last activity</th><th className="px-3 py-3 text-right">Action</th></tr></thead>
            <tbody>
              {items.length === 0 ? (
                <tr><td colSpan={6} className="px-3 py-10 text-center text-sm text-muted">{busy ? "Loading Event Groups…" : "No Event Groups match the current filters."}</td></tr>
              ) : items.map((group) => (
                <tr key={group.id} className="border-b border-[var(--line)]/60 align-top last:border-b-0 hover:bg-[var(--panel-soft)]">
                  <td className="px-3 py-3"><button type="button" onClick={() => navigate(`/event-groups/${group.id}`)} className="text-left"><div className="text-sm font-semibold text-[var(--ink)] hover:text-[var(--brand)]">{group.title}</div><div className="mt-0.5 text-xs text-muted">Event Group #{group.id}</div></button></td>
                  <td className="px-3 py-3 text-sm text-muted">{eventGroupLocationLabel(group)}</td>
                  <td className="px-3 py-3 text-sm"><span className="font-semibold tabular-nums">{group.incident_count}</span><span className="text-muted"> total · {group.open_incident_count} active</span></td>
                  <td className="px-3 py-3"><StatusBadge status={group.status} /></td>
                  <td className="px-3 py-3 text-sm text-muted">{formatDate(group.latest_incident_activity_at ?? group.updated_at)}</td>
                  <td className="px-3 py-3 text-right"><button type="button" onClick={() => navigate(`/event-groups/${group.id}`)} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--panel-soft)]">Open Event Group</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { api } from "../api/client";
import type { EventGroupDetailResponse } from "../features/eventGroups/eventGroupTypes";
import { eventGroupLocationLabel, eventGroupStatusLabel } from "../features/eventGroups/eventGroupTypes";
import AppShell from "../ui/AppShell";

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function eventLabel(value: string): string {
  return value.toLowerCase().replace(/_/g, " ").replace(/(^|\s)\S/g, (match) => match.toUpperCase());
}

export default function EventGroupDetailPage() {
  const params = useParams();
  const navigate = useNavigate();
  const eventGroupId = Number(params.id);
  const [detail, setDetail] = useState<EventGroupDetailResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!Number.isFinite(eventGroupId) || eventGroupId <= 0) {
      setError("Invalid Event Group ID.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setDetail(await api<EventGroupDetailResponse>(`/event-groups/${eventGroupId}`));
    } catch (e: any) {
      setError(e?.message ?? "Failed to load Event Group.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventGroupId]);

  return (
    <AppShell title={detail?.event_group.title || `Event Group #${Number.isFinite(eventGroupId) ? eventGroupId : ""}`}>
      <div className="flex h-full flex-col gap-4 p-4 md:p-5">
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => navigate("/event-groups")} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)]">← Event Groups</button>
          <button type="button" onClick={load} disabled={busy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">{busy ? "Refreshing…" : "Refresh"}</button>
        </div>

        {error ? <div className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}

        {!detail ? <div className="py-16 text-center text-sm text-muted">{busy ? "Loading Event Group…" : "Event Group unavailable."}</div> : (
          <>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 xl:col-span-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Event Group</div>
                <div className="mt-1 flex flex-wrap items-center gap-2"><div className="text-lg font-semibold">{detail.event_group.title}</div><span className="rounded-full border border-[var(--line)] bg-[var(--panel-soft)] px-2.5 py-1 text-xs font-semibold">{eventGroupStatusLabel(detail.event_group.status)}</span></div>
                <div className="mt-1 text-sm text-muted">{eventGroupLocationLabel(detail.event_group)}</div>
                {detail.event_group.description ? <p className="mt-3 text-sm text-muted">{detail.event_group.description}</p> : null}
              </div>
              <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4"><div className="text-xs font-semibold uppercase tracking-wide text-muted">Associated Incidents</div><div className="mt-1 text-2xl font-semibold tabular-nums">{detail.event_group.incident_count}</div><div className="mt-1 text-xs text-muted">{detail.event_group.open_incident_count} active</div></div>
              <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4"><div className="text-xs font-semibold uppercase tracking-wide text-muted">Created</div><div className="mt-1 text-sm font-semibold">{formatDate(detail.event_group.created_at)}</div><div className="mt-1 text-xs text-muted">Event Group #{detail.event_group.id}</div></div>
              <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4"><div className="text-xs font-semibold uppercase tracking-wide text-muted">Latest activity</div><div className="mt-1 text-sm font-semibold">{formatDate(detail.event_group.latest_incident_activity_at)}</div></div>
            </div>

            <div className="rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] px-4 py-3 text-sm text-muted">
              Event Group is shared context only. Every Incident below remains an independent root record; changing this association never changes its permanent Incident key or historical evidence.
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,0.8fr)]">
              <section className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
                <div className="border-b border-[var(--line)] bg-[var(--panel-soft)] px-4 py-3"><h2 className="text-sm font-semibold">Associated Incidents</h2><p className="mt-0.5 text-xs text-muted">Permanent identity is assigned at Maintenance Coordinator approval.</p></div>
                <div className="overflow-auto">
                  <table className="w-full border-collapse">
                    <thead><tr className="border-b border-[var(--line)] text-left text-xs font-semibold uppercase tracking-wide text-muted"><th className="px-3 py-2.5">Incident</th><th className="px-3 py-2.5">Identity</th><th className="px-3 py-2.5">Location</th><th className="px-3 py-2.5">Status</th></tr></thead>
                    <tbody>
                      {detail.incidents.length === 0 ? <tr><td colSpan={4} className="px-3 py-8 text-center text-sm text-muted">No Incidents are associated with this Event Group.</td></tr> : detail.incidents.map((incident) => (
                        <tr key={incident.id} className="border-b border-[var(--line)]/60 last:border-b-0">
                          <td className="px-3 py-3"><div className="text-sm font-semibold">#{incident.id} {incident.title || "Incident"}</div><div className="mt-0.5 text-xs text-muted">Observed {formatDate(incident.first_observed_at)}</div></td>
                          <td className="px-3 py-3">{incident.is_permanent && incident.incident_key ? <><div className="text-xs font-semibold text-[var(--good)]">Permanent</div><div className="mt-1 max-w-52 truncate font-mono text-[11px] text-muted" title={incident.incident_key}>{incident.incident_key}</div></> : <><div className="text-xs font-semibold text-[var(--brand)]">Provisional</div><div className="mt-1 text-[11px] text-muted">No historical key yet</div></>}</td>
                          <td className="px-3 py-3 text-sm text-muted">{eventGroupLocationLabel({ district: incident.district, county: incident.county, route: incident.route, post_mile: incident.post_mile })}</td>
                          <td className="px-3 py-3 text-sm text-muted">{incident.status} · {incident.current_stage}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
                <div className="border-b border-[var(--line)] bg-[var(--panel-soft)] px-4 py-3"><h2 className="text-sm font-semibold">Event Group history</h2><p className="mt-0.5 text-xs text-muted">Audited grouping activity.</p></div>
                <div className="max-h-[520px] overflow-auto p-4">
                  {detail.events.length === 0 ? <div className="text-sm text-muted">No Event Group history recorded.</div> : <ol className="space-y-3">{detail.events.slice().reverse().map((event) => <li key={event.id} className="border-l-2 border-[var(--line)] pl-3"><div className="text-sm font-semibold">{eventLabel(event.event_type)}</div><div className="mt-0.5 text-xs text-muted">{formatDate(event.created_at)}{event.actor_name || event.actor_email ? ` · ${event.actor_name || event.actor_email}` : ""}</div>{event.incident_id ? <div className="mt-1 text-xs text-muted">Incident #{event.incident_id}</div> : null}{event.notes ? <p className="mt-1 text-sm text-muted">{event.notes}</p> : null}</li>)}</ol>}
                </div>
              </section>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}

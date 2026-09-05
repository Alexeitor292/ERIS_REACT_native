import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { listAssessments, type Assessment } from "../api/assessments";
import { api } from "../api/client";
import type { EventGroupDetailResponse } from "../features/eventGroups/eventGroupTypes";
import { eventGroupLocationLabel } from "../features/eventGroups/eventGroupTypes";
import { submissionIdsOf } from "../features/assessments/assessmentModel";
import AppShell from "../ui/AppShell";
import { EventGroupStatusBadge } from "./EventGroupsPage";

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateTimeFormatter.format(date);
}

function eventLabel(value: string): string {
  return value.toLowerCase().replace(/_/g, " ").replace(/(^|\s)\S/g, (match) => match.toUpperCase());
}

function incidentStatusText(status: string, stage: string) {
  const label = status === "RESOLVED" ? "Resolved" : status === "IN_PROGRESS" ? "In progress" : "New";
  return `${label} · ${eventLabel(stage)}`;
}

const btn = "rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50";

/**
 * Event Group record: compact single header card + incidents table + history.
 * Every incident inside a group has been accepted (its permanent key was minted at
 * coordinator approval); a grouped incident without a key is a data-integrity error.
 */
export default function EventGroupDetailPage() {
  const params = useParams();
  const eventGroupId = Number(params.id);
  const [detail, setDetail] = useState<EventGroupDetailResponse | null>(null);
  const [assessments, setAssessments] = useState<Record<number, Assessment>>({});
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
      const [next, assessmentList] = await Promise.all([
        api<EventGroupDetailResponse>(`/event-groups/${eventGroupId}`),
        listAssessments({ limit: 1000 }).catch(() => ({ items: [] as Assessment[] })),
      ]);
      setDetail(next);
      setAssessments(Object.fromEntries((assessmentList.items ?? []).map((assessment) => [assessment.incident_id, assessment])));
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

  const integrityProblems = useMemo(() => (detail?.incidents ?? []).filter((incident) => !incident.incident_key), [detail]);
  const group = detail?.event_group ?? null;

  return (
    <AppShell title={group?.title || `Event Group #${Number.isFinite(eventGroupId) ? eventGroupId : ""}`}>
      <div className="grid gap-4 p-4 md:p-5">
        <div className="flex flex-wrap gap-2">
          <Link to="/event-groups" className={btn}>← Event Groups</Link>
          {group ? <Link to={`/mission-center/${group.id}`} className={btn}>View on Mission Center map</Link> : null}
          <button type="button" onClick={load} disabled={busy} className={`${btn} ml-auto`}>{busy ? "Refreshing…" : "Refresh"}</button>
        </div>

        {error ? <div className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}

        {!detail || !group ? <div className="py-16 text-center text-sm text-muted">{busy ? "Loading Event Group…" : "Event Group unavailable."}</div> : (
          <>
            <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><div className="text-lg font-semibold">{group.title}</div><EventGroupStatusBadge status={group.status} /></div>
                  <div className="mt-1 text-sm text-muted">Event Group #{group.id} · {eventGroupLocationLabel(group)}</div>
                </div>
                <dl className="grid shrink-0 grid-cols-[auto_auto] items-baseline gap-x-6 gap-y-1 text-[13px]">
                  <dt className="text-muted">Incidents</dt><dd className="font-semibold tabular-nums">{group.incident_count} <span className="font-normal text-muted">· {group.open_incident_count} active</span></dd>
                  <dt className="text-muted">Created</dt><dd className="font-semibold">{formatDate(group.created_at)}</dd>
                  <dt className="text-muted">Last activity</dt><dd className="font-semibold">{formatDate(group.latest_incident_activity_at)}</dd>
                </dl>
              </div>
              {group.description ? <p className="mt-2.5 text-sm text-muted">{group.description}</p> : null}
            </div>

            {integrityProblems.length ? (
              <div role="alert" className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">
                <b>Data integrity error:</b> {integrityProblems.length === 1 ? `incident #${integrityProblems[0].id} is` : `${integrityProblems.length} incidents are`} associated with this Event Group without a permanent incident key. Grouping happens at coordinator approval, so this state should not occur — report it to an administrator.
              </div>
            ) : null}

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,0.8fr)]">
              <section className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
                <div className="border-b border-[var(--line)] bg-[var(--panel-soft)] px-4 py-3"><h2 className="text-[13px] font-semibold">Associated Incidents</h2></div>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead><tr className="border-b border-[var(--line)] text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-muted"><th className="px-3 py-2.5">Incident</th><th className="px-3 py-2.5">Location</th><th className="px-3 py-2.5">Status</th><th className="px-3 py-2.5 text-right">Links</th></tr></thead>
                    <tbody>
                      {detail.incidents.length === 0 ? <tr><td colSpan={4} className="px-3 py-8 text-center text-sm text-muted">No Incidents are associated with this Event Group.</td></tr> : detail.incidents.map((incident) => {
                        const assessment = assessments[incident.id];
                        const submissionIds = assessment ? submissionIdsOf(assessment) : [];
                        const broken = !incident.incident_key;
                        return (
                          <tr key={incident.id} className="border-b border-[var(--line)]/60 last:border-b-0" style={broken ? { background: "color-mix(in oklab, var(--bad) 6%, var(--panel))" } : undefined}>
                            <td className="px-3 py-3">
                              <Link to={`/incidents/${incident.id}`} className="text-sm font-semibold text-[var(--ink)] hover:text-[var(--brand)]">#{incident.id} {incident.title || "Incident"}</Link>
                              <div className="mt-0.5 text-xs text-muted">Observed {formatDate(incident.first_observed_at)}</div>
                              {broken ? <div className="mt-1 text-[11px] font-semibold text-[var(--bad)]">Missing permanent incident key</div> : null}
                            </td>
                            <td className="px-3 py-3 text-sm text-muted">{eventGroupLocationLabel(incident)}</td>
                            <td className="whitespace-nowrap px-3 py-3 text-sm text-muted">{incidentStatusText(incident.status, incident.current_stage)}</td>
                            <td className="whitespace-nowrap px-3 py-3 text-right">
                              <div className="inline-flex flex-wrap justify-end gap-1.5">
                                <Link to={`/mission-center/${group.id}/${incident.id}`} className="rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-[11px] font-semibold hover:bg-[var(--panel-soft)]">Map</Link>
                                {assessment ? <Link to={`/assessments/${assessment.id}`} className="rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-[11px] font-semibold hover:bg-[var(--panel-soft)]">Assessment #{assessment.id}</Link> : null}
                                {submissionIds.map((submissionId) => <Link key={submissionId} to={`/submissions/${submissionId}`} className="rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-[11px] font-semibold hover:bg-[var(--panel-soft)]">Submission #{submissionId}</Link>)}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
                <div className="border-b border-[var(--line)] bg-[var(--panel-soft)] px-4 py-3"><h2 className="text-[13px] font-semibold">Event Group history</h2></div>
                <div className="max-h-[520px] overflow-auto p-4">
                  {detail.events.length === 0 ? <div className="text-sm text-muted">No Event Group history recorded.</div> : <ol className="grid gap-3">{detail.events.slice().reverse().map((event) => <li key={event.id} className="border-l-2 border-[var(--line)] pl-3"><div className="text-sm font-semibold">{eventLabel(event.event_type)}</div><div className="mt-0.5 text-xs text-muted">{formatDate(event.created_at)}{event.actor_name || event.actor_email ? ` · ${event.actor_name || event.actor_email}` : ""}</div>{event.incident_id ? <div className="mt-1 text-xs text-muted">Incident <Link to={`/mission-center/${group.id}/${event.incident_id}`} className="text-[var(--brand)] hover:underline">#{event.incident_id}</Link></div> : null}{event.notes ? <p className="mt-1 text-sm text-muted">{event.notes}</p> : null}</li>)}</ol>}
                </div>
              </section>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}

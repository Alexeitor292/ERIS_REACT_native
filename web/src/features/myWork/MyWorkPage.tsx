import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { getAssessment, listAssessments, type Assessment, type AssessmentDetail } from "../../api/assessments";
import { api } from "../../api/client";
import type { Incident } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import AppShell from "../../ui/AppShell";
import { canAssignEngineer, canDelegateBranch, canFinalize, canTriage, hasWorkQueue, isAdmin, isEngineer } from "../../utils/roleModel";
import AssessmentDetailPanel, { AssessmentRailCard, formatTimestamp } from "../assessments/AssessmentDetailPanel";
import { useSubmissionIndex } from "../assessments/AssessmentWorkspacePage";
import { eventGroupLocationLabel } from "../eventGroups/eventGroupTypes";
import TriageWorkItem from "./TriageWorkItem";

type WorkItem =
  | { kind: "triage"; id: string; incident: Incident; sortKey: number }
  | { kind: "assessment"; id: string; assessment: Assessment; sortKey: number };

function timestamp(value: string | null | undefined) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * My Work: the single queue of items waiting on the signed-in user's role.
 *
 *  - Maintenance Coordinator: field reports awaiting intake triage.
 *  - Office Chief: assessments pending delegation (+ approved ones to finalize).
 *  - Branch Chief: assessments pending engineer assignment.
 *  - Engineer: assigned assessments in Draft / Revision requested.
 *  - Assigned reviewers: submitted assessments they were assigned to.
 */
export default function MyWorkPage() {
  const { me } = useAuth();
  const roles = me?.roles;
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<WorkItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AssessmentDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { submissionsById, reloadSubmissions } = useSubmissionIndex();

  const load = useCallback(async () => {
    if (!hasWorkQueue(roles)) { setItems([]); return; }
    setLoading(true);
    setError(null);
    try {
      const admin = isAdmin(roles);
      const requests: Array<Promise<Assessment[]>> = [];
      if (canDelegateBranch(roles)) requests.push(listAssessments({ queue: "office_chief", limit: 1000 }).then((r) => r.items ?? []));
      if (canAssignEngineer(roles)) requests.push(listAssessments({ queue: "branch_chief", limit: 1000 }).then((r) => r.items ?? []));
      if (isEngineer(roles)) requests.push(listAssessments({ queue: "engineer", limit: 1000 }).then((r) => (r.items ?? []).filter((a) => a.state === "DRAFT" || a.state === "REVISION_REQUESTED")));
      requests.push(listAssessments({ queue: "reviewer", limit: 1000 }).then((r) => (r.items ?? []).filter((a) => a.state === "SUBMITTED")));
      if (canFinalize(roles)) requests.push(listAssessments({ state: "APPROVED", limit: 1000 }).then((r) => r.items ?? []));
      if (admin) requests.push(listAssessments({ state: "SUBMITTED", limit: 1000 }).then((r) => r.items ?? []));

      const triagePromise: Promise<Incident[]> = canTriage(roles)
        ? api<{ items: Incident[] }>("/incidents?limit=1000").then((r) => (r.items ?? []).filter((i) => i.current_stage === "COORDINATOR_REVIEW" && i.status !== "RESOLVED"))
        : Promise.resolve([]);

      const [triage, ...assessmentLists] = await Promise.all([triagePromise, ...requests]);
      const byId = new Map<number, Assessment>();
      for (const list of assessmentLists) for (const assessment of list) byId.set(assessment.id, assessment);

      const next: WorkItem[] = [
        ...triage.map((incident) => ({ kind: "triage" as const, id: `t${incident.id}`, incident, sortKey: timestamp(incident.first_observed_at) })),
        ...[...byId.values()].map((assessment) => ({ kind: "assessment" as const, id: `a${assessment.id}`, assessment, sortKey: timestamp(assessment.updated_at) })),
      ];
      next.sort((a, b) => (a.kind === b.kind ? b.sortKey - a.sortKey : a.kind === "triage" ? -1 : 1));
      setItems(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load your work queue.");
    } finally {
      setLoading(false);
    }
  }, [roles]);

  useEffect(() => { void load(); }, [load]);

  // Deep link from the Assessments record view: ?assessment=<id>
  useEffect(() => {
    const requested = searchParams.get("assessment");
    if (requested && items.some((item) => item.id === `a${requested}`)) setSelectedId(`a${requested}`);
  }, [items, searchParams]);

  const selected = useMemo(() => items.find((item) => item.id === selectedId) ?? items[0] ?? null, [items, selectedId]);

  useEffect(() => {
    if (!selected || selected.kind !== "assessment") { setDetail(null); return; }
    let cancelled = false;
    getAssessment(selected.assessment.id)
      .then((next) => { if (!cancelled) setDetail(next); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load assessment."); });
    return () => { cancelled = true; };
  }, [selected]);

  const refresh = useCallback(async () => {
    await Promise.all([load(), reloadSubmissions()]);
    if (selected?.kind === "assessment") {
      try { setDetail(await getAssessment(selected.assessment.id)); } catch { /* item may have left the queue */ }
    }
  }, [load, reloadSubmissions, selected]);

  if (!hasWorkQueue(roles)) {
    return (
      <AppShell title="My Work">
        <div className="p-6">
          <div className="rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-6 text-center">
            <div className="text-base font-semibold">No workflow steps are assigned to your role</div>
            <p className="mt-1.5 text-sm text-muted">Field reports you file are tracked under <Link to="/incidents" className="font-medium text-[var(--brand)] hover:underline">Incidents</Link>.</p>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title="My Work">
      <div className="grid gap-3.5 p-4 md:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm"><b>{items.length}</b><span className="text-muted"> item{items.length === 1 ? "" : "s"} waiting on your role</span></span>
          <button type="button" onClick={refresh} disabled={loading} className="ml-auto rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">{loading ? "Refreshing…" : "Refresh"}</button>
        </div>

        {error ? <div className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}
        {notice ? <div className="rounded-md border border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] px-3 py-2 text-sm text-[var(--good)]">{notice}</div> : null}

        {items.length === 0 ? (
          <div className="rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] px-6 py-10 text-center">
            <div className="text-base font-semibold">{loading ? "Loading your queue…" : "Nothing needs your attention"}</div>
            <p className="mt-1.5 text-sm text-muted">No steps are waiting on you. Browse the records under <Link to="/assessments" className="font-medium text-[var(--brand)] hover:underline">Operations › Assessments</Link>.</p>
          </div>
        ) : (
          <div className="grid items-start gap-4 xl:grid-cols-[minmax(320px,0.7fr)_minmax(0,1.8fr)]">
            <section className="flex max-h-[860px] flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
              <div className="border-b border-[var(--line)] bg-[var(--panel-soft)] px-4 py-2.5 text-[13px] text-muted">{items.length} item{items.length === 1 ? "" : "s"} waiting on you</div>
              <div className="grid flex-1 content-start gap-2 overflow-auto p-2">
                {items.map((item) => {
                  const active = selected?.id === item.id;
                  if (item.kind === "triage") {
                    const incident = item.incident;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => { setSelectedId(item.id); setSearchParams({}, { replace: true }); }}
                        className={`block w-full rounded-lg border p-3 text-left ${active ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_7%,var(--panel))]" : "border-[var(--line)] bg-[var(--panel)] hover:border-[color:color-mix(in_oklab,var(--brand)_45%,var(--line))] hover:bg-[var(--panel-soft)]"}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div><div className="font-semibold">Triage · Incident #{incident.id}</div><div className="mt-0.5 text-xs text-muted">{incident.title || "Field report"}</div></div>
                          <span className="inline-flex whitespace-nowrap rounded-full border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-2 py-0.5 text-[11px] font-semibold text-[var(--bad)]">New report</span>
                        </div>
                        <div className="mt-2 text-xs text-muted">{eventGroupLocationLabel(incident)} · Reported {formatTimestamp(incident.first_observed_at)}</div>
                      </button>
                    );
                  }
                  return (
                    <AssessmentRailCard
                      key={item.id}
                      assessment={item.assessment}
                      assignments={detail?.assessment.id === item.assessment.id ? detail.assignments : undefined}
                      submissionsById={submissionsById}
                      active={active}
                      onClick={() => { setSelectedId(item.id); setSearchParams({}, { replace: true }); }}
                    />
                  );
                })}
              </div>
            </section>

            <section className="min-w-0">
              {!selected ? null : selected.kind === "triage" ? (
                <TriageWorkItem
                  incident={selected.incident}
                  onTriaged={async (message) => { setNotice(message); setSelectedId(null); await refresh(); }}
                  onError={setError}
                />
              ) : detail && detail.assessment.id === selected.assessment.id ? (
                <AssessmentDetailPanel detail={detail} submissionsById={submissionsById} mode="work" onChanged={refresh} onError={setError} />
              ) : (
                <div className="rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-6 text-sm text-muted">Loading assessment…</div>
              )}
            </section>
          </div>
        )}
      </div>
    </AppShell>
  );
}

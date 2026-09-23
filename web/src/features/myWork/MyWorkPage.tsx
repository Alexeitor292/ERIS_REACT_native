import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { getAssessment, listAssessments, type Assessment, type AssessmentDetail } from "../../api/assessments";
import { api } from "../../api/client";
import type { Incident } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import AppShell from "../../ui/AppShell";
import { canAssignEngineer, canDelegateBranch, canTriage, hasWorkQueue, isAdmin, isAssessmentAuthor } from "../../utils/roleModel";
import AssessmentDetailPanel, { AssessmentRailCard, formatTimestamp } from "../assessments/AssessmentDetailPanel";
import { useSubmissionIndex } from "../assessments/AssessmentWorkspacePage";
import { eventGroupLocationLabel } from "../eventGroups/eventGroupTypes";
import TriageWorkItem from "./TriageWorkItem";

type WorkItem =
  | { kind: "triage"; id: string; incident: Incident; sortKey: number }
  /** `outsideQueue`: opened by a link although no queue of the caller's holds it. */
  | { kind: "assessment"; id: string; assessment: Assessment; sortKey: number; outsideQueue?: boolean };

function timestamp(value: string | null | undefined) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * My Work: the single queue of items waiting on the signed-in user's role.
 *
 * Every assessment takes exactly one of two routes, and the route names its
 * reviewer, so the queues follow the route rather than an assignment:
 *
 *  - Maintenance Coordinator: field reports awaiting intake triage.
 *  - Office Chief: assessments to route (`office_chief`), and senior-engineer-route
 *    assessments of their own office to review (`office_chief_review`).
 *  - Branch Chief: assessments handed to them that still need an assignee (`branch_chief`), and the
 *    same ones to approve or return once submitted (`branch_chief_review`).
 *  - Staff or Senior Specialist: their own assessments in Draft / Revision
 *    requested (`assignee` — both routes store the assignee in the same column).
 *  - Admin: every submitted assessment, matching the server's review bypass.
 *
 * Every request carries its own `.catch(() => [])`: one failing queue — or a
 * failing /incidents call — must never blank the whole page.
 *
 * Who gets here is decided by the ROUTE (`WORK_QUEUE_ROLE_NAMES` in App.tsx),
 * not by this component: a read-only viewer is refused the route and sent to
 * Records. The `hasWorkQueue` branch below stays as a second line of defence for
 * an account whose roles change while the page is open — it is no longer the
 * only thing standing between a viewer and a work queue, and the server refuses
 * a viewer's `?queue=` request with a 400 regardless (org model design §8).
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
  const [linked, setLinked] = useState<Assessment | null>(null);
  const [loaded, setLoaded] = useState(false);
  const scrolledFor = useRef<string | null>(null);
  const { submissionsById, reloadSubmissions } = useSubmissionIndex();

  const load = useCallback(async () => {
    if (!hasWorkQueue(roles)) { setItems([]); return; }
    setLoading(true);
    setError(null);
    try {
      // One queue per group, each isolated: a 4xx/5xx on any one of them yields
      // an empty list for that group instead of failing the whole Promise.all.
      const queue = (
        params: Parameters<typeof listAssessments>[0],
        keep?: (assessment: Assessment) => boolean,
      ): Promise<Assessment[]> =>
        listAssessments({ limit: 1000, ...params })
          .then((r) => { const items = r.items ?? []; return keep ? items.filter(keep) : items; })
          .catch(() => []);

      const requests: Array<Promise<Assessment[]>> = [];
      if (canDelegateBranch(roles)) {
        requests.push(queue({ queue: "office_chief" }));
        requests.push(queue({ queue: "office_chief_review" }));
      }
      if (canAssignEngineer(roles)) {
        requests.push(queue({ queue: "branch_chief" }));
        requests.push(queue({ queue: "branch_chief_review" }));
      }
      // isAssessmentAuthor, not isEngineer: a senior-engineer-only account owns
      // assessments too, and would otherwise never see its own drafts.
      if (isAssessmentAuthor(roles)) {
        requests.push(queue({ queue: "assignee" }, (a) => a.state === "DRAFT" || a.state === "REVISION_REQUESTED"));
      }
      if (isAdmin(roles)) requests.push(queue({ state: "SUBMITTED" }));

      const triagePromise: Promise<Incident[]> = canTriage(roles)
        // The server's triage queue: only reports in the districts this person covers.
        ? api<{ items: Incident[] }>("/incidents?queue=triage&limit=1000")
          .then((r) => (r.items ?? []).filter((i) => i.current_stage === "COORDINATOR_REVIEW" && i.status !== "RESOLVED"))
          .catch(() => [])
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
      setLoaded(true);
    }
  }, [roles]);

  useEffect(() => { void load(); }, [load]);

  // Deep link from an assessment record or its technical form: ?assessment=<id>.
  // The assessment opens even when none of the caller's queues holds it — an
  // administrator stepping in, an office chief reassigning a Senior Specialist —
  // instead of falling back to whatever sits first in the list.
  const requested = searchParams.get("assessment");
  useEffect(() => {
    if (!requested || !loaded) return;
    if (items.some((item) => item.id === `a${requested}`)) {
      setLinked(null);
      setSelectedId(`a${requested}`);
      return;
    }
    let cancelled = false;
    getAssessment(Number(requested))
      .then((found) => {
        if (cancelled) return;
        setLinked(found.assessment);
        setSelectedId(`a${found.assessment.id}`);
      })
      .catch(() => { if (!cancelled) setError(`Assessment #${requested} could not be opened.`); });
    return () => { cancelled = true; };
  }, [items, loaded, requested]);

  const allItems = useMemo<WorkItem[]>(
    () => (linked && !items.some((item) => item.id === `a${linked.id}`)
      ? [{ kind: "assessment", id: `a${linked.id}`, assessment: linked, sortKey: Number.POSITIVE_INFINITY, outsideQueue: true }, ...items]
      : items),
    [items, linked],
  );

  const selected = useMemo(() => allItems.find((item) => item.id === selectedId) ?? allItems[0] ?? null, [allItems, selectedId]);

  useEffect(() => {
    if (!selected || selected.kind !== "assessment") { setDetail(null); return; }
    let cancelled = false;
    getAssessment(selected.assessment.id)
      .then((next) => { if (!cancelled) setDetail(next); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load assessment."); });
    return () => { cancelled = true; };
  }, [selected]);

  // Arriving by link, bring the step to act on into view once it has loaded.
  useEffect(() => {
    if (!requested || !detail || detail.assessment.id !== Number(requested) || scrolledFor.current === requested) return;
    scrolledFor.current = requested;
    window.requestAnimationFrame(() => {
      const step = document.getElementById("assessment-next-step");
      step?.scrollIntoView({ block: "center", behavior: "smooth" });
      step?.focus({ preventScroll: true });
    });
  }, [detail, requested]);

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

        {allItems.length === 0 ? (
          <div className="rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] px-6 py-10 text-center">
            <div className="text-base font-semibold">{loading ? "Loading your queue…" : "Nothing needs your attention"}</div>
            <p className="mt-1.5 text-sm text-muted">No steps are waiting on you. Browse the records under <Link to="/assessments" className="font-medium text-[var(--brand)] hover:underline">Operations › Assessments</Link>.</p>
          </div>
        ) : (
          <div className="grid items-start gap-4 xl:grid-cols-[minmax(320px,0.7fr)_minmax(0,1.8fr)]">
            <section className="flex max-h-[860px] flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
              <div className="border-b border-[var(--line)] bg-[var(--panel-soft)] px-4 py-2.5 text-[13px] text-muted">{items.length} item{items.length === 1 ? "" : "s"} waiting on you</div>
              <div className="grid flex-1 content-start gap-2 overflow-auto p-2">
                {allItems.map((item) => {
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
                  const card = (
                    <AssessmentRailCard
                      key={item.id}
                      assessment={item.assessment}
                      assignments={detail?.assessment.id === item.assessment.id ? detail.assignments : undefined}
                      submissionsById={submissionsById}
                      active={active}
                      onClick={() => { setSelectedId(item.id); setSearchParams({}, { replace: true }); }}
                    />
                  );
                  return item.outsideQueue ? (
                    <div key={item.id} className="grid gap-1 border-b border-[var(--line)] pb-2">
                      <span className="px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Opened from its record · not in your queue</span>
                      {card}
                    </div>
                  ) : card;
                })}
              </div>
            </section>

            <section className="min-w-0">
              {!selected ? null : selected.kind === "triage" ? (
                <TriageWorkItem
                  incident={selected.incident}
                  onTriaged={async (message) => { setNotice(message); setSelectedId(null); await refresh(); }}
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

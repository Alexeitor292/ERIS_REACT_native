import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { getAssessment, listAssessments, type Assessment, type AssessmentDetail, type AssessmentState } from "../../api/assessments";
import { api } from "../../api/client";
import type { Submission } from "../../api/types";
import AppShell from "../../ui/AppShell";
import { buildSubmissionDisplayTitle } from "../../utils/submissionLabel";
import AssessmentDetailPanel, { AssessmentRailCard } from "./AssessmentDetailPanel";
import { ASSESSMENT_STATES, assessmentSearchMatch, assessmentStateLabel, submissionIdsOf } from "./assessmentModel";

type SubmissionPage = { items: Submission[]; has_more: boolean; next_cursor: number | null };

/** Loads a worklist index of submissions so rails/tables can show descriptors without N+1 calls. */
export function useSubmissionIndex() {
  const [index, setIndex] = useState<Map<number, Submission>>(() => new Map());
  const reload = useCallback(async () => {
    try {
      const page = await api<SubmissionPage>("/submissions/page?limit=200");
      setIndex(new Map((page.items ?? []).map((submission) => [submission.id, submission])));
    } catch {
      // Submission summaries are a convenience; the assessment view still works without them.
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { submissionsById: index, reloadSubmissions: reload };
}

/**
 * Read-only record view of every assessment and its attached technical submissions.
 * Workflow actions live in My Work; this view only points there when the step is yours.
 */
export default function AssessmentWorkspacePage() {
  const params = useParams();
  const routeId = params.id ? Number(params.id) : null;
  const [items, setItems] = useState<Assessment[]>([]);
  const [detail, setDetail] = useState<AssessmentDetail | null>(null);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<"ALL" | AssessmentState>("ALL");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { submissionsById, reloadSubmissions } = useSubmissionIndex();
  const railRefs = useRef<Record<number, HTMLElement | null>>({});

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listAssessments({ limit: 1000 });
      setItems(response.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load assessments.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadList(); }, [loadList]);

  const filtered = useMemo(() => {
    const descriptor = (submission: Pick<Submission, "id" | "district" | "county" | "route" | "post_mile">) =>
      buildSubmissionDisplayTitle({ id: submission.id, district: submission.district, county: submission.county, route: submission.route, post_mile: submission.post_mile });
    return items
      .filter((assessment) => stateFilter === "ALL" || assessment.state === stateFilter)
      .filter((assessment) => {
        const linked = submissionIdsOf(assessment).map((id) => submissionsById.get(id)).filter((value): value is Submission => !!value);
        return assessmentSearchMatch(assessment, linked, query, descriptor);
      });
  }, [items, query, stateFilter, submissionsById]);

  const selectedId = routeId != null && filtered.some((assessment) => assessment.id === routeId) ? routeId : (filtered[0]?.id ?? null);

  const loadDetail = useCallback(async (id: number) => {
    try {
      setDetail(await getAssessment(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load assessment.");
      setDetail(null);
    }
  }, []);

  useEffect(() => {
    if (selectedId == null) { setDetail(null); return; }
    void loadDetail(selectedId);
  }, [loadDetail, selectedId]);

  // Deep link: scroll the selected rail card into view.
  useEffect(() => {
    if (routeId == null) return;
    const element = railRefs.current[routeId];
    if (!element) return;
    const timer = window.setTimeout(() => element.scrollIntoView({ block: "nearest", behavior: "smooth" }), 120);
    return () => window.clearTimeout(timer);
  }, [routeId, filtered.length]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadList(), reloadSubmissions()]);
    if (selectedId != null) await loadDetail(selectedId);
  }, [loadDetail, loadList, reloadSubmissions, selectedId]);

  return (
    <AppShell title="Assessments">
      <div className="grid gap-3.5 p-4 md:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <select value={stateFilter} onChange={(event) => setStateFilter(event.target.value as "ALL" | AssessmentState)} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm">
            <option value="ALL">All states</option>
            {ASSESSMENT_STATES.map((state) => <option key={state} value={state}>{assessmentStateLabel(state)}</option>)}
          </select>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search assessments, incidents, or submissions" className="min-w-40 flex-1 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]" />
          <span className="text-xs text-muted">{filtered.length} of {items.length} assessments</span>
          <button type="button" onClick={refreshAll} disabled={loading} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">{loading ? "Refreshing…" : "Refresh"}</button>
        </div>

        <div className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm text-muted">
          Read-only record view of every assessment and its attached technical submissions. Steps assigned to your role are performed from <Link to="/my-work" className="font-medium text-[var(--brand)] hover:underline">My Work</Link>.
        </div>

        {error ? <div className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}

        <div className="grid items-start gap-4 xl:grid-cols-[minmax(320px,0.7fr)_minmax(0,1.8fr)]">
          <section className="flex max-h-[860px] flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
            <div className="border-b border-[var(--line)] bg-[var(--panel-soft)] px-4 py-2.5 text-[13px] text-muted">{filtered.length} of {items.length} assessments</div>
            <div className="grid flex-1 content-start gap-2 overflow-auto p-2">
              {filtered.length === 0 ? <div className="p-4 text-sm text-muted">{loading ? "Loading assessments…" : "No assessments match the current filters."}</div> : filtered.map((assessment) => (
                <AssessmentRailCard
                  key={assessment.id}
                  assessment={assessment}
                  assignments={detail?.assessment.id === assessment.id ? detail.assignments : undefined}
                  submissionsById={submissionsById}
                  active={selectedId === assessment.id}
                  to={`/assessments/${assessment.id}`}
                  refCallback={(element) => { railRefs.current[assessment.id] = element; }}
                />
              ))}
            </div>
          </section>

          <section className="min-w-0">
            {detail ? (
              <AssessmentDetailPanel detail={detail} submissionsById={submissionsById} mode="record" onChanged={refreshAll} onError={setError} />
            ) : (
              <div className="rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-6 text-sm text-muted">{selectedId == null ? "No assessment selected." : "Loading assessment…"}</div>
            )}
          </section>
        </div>
      </div>
    </AppShell>
  );
}

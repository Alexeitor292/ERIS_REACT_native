import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { getAssessment, listAssessments, type Assessment, type AssessmentDetail, type AssessmentState } from "../../api/assessments";
import { api } from "../../api/client";
import type { Submission } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import AppShell from "../../ui/AppShell";
import { isPublicOnly } from "../../utils/roleModel";
import { buildSubmissionDisplayTitle } from "../../utils/submissionLabel";
import AssessmentDetailPanel, { AssessmentRailCard, useOrgLabels } from "./AssessmentDetailPanel";
import {
  ASSESSMENT_STATES,
  assessmentBranchName,
  assessmentOfficeName,
  assessmentSearchMatch,
  assessmentStateLabel,
  submissionIdsOf,
} from "./assessmentModel";

type SubmissionPage = { items: Submission[]; has_more: boolean; next_cursor: number | null };

/**
 * Loads a worklist index of submissions so rails/tables can show descriptors
 * without N+1 calls.
 *
 * A read-only viewer takes a different endpoint: `/submissions/page` is the
 * photo-centric operational list and is closed to them, while `GET /submissions`
 * is narrowed server-side to the forms attached to approved assessments. Both
 * are a convenience — a failure leaves the rows reading "Submission #213", which
 * is honest — but sending a viewer at the closed one would guarantee that.
 */
export function useSubmissionIndex() {
  const { me } = useAuth();
  const publicOnly = isPublicOnly(me?.roles);
  const [index, setIndex] = useState<Map<number, Submission>>(() => new Map());
  const reload = useCallback(async () => {
    try {
      const response = publicOnly
        ? await api<{ items: Submission[] }>("/submissions?limit=200")
        : await api<SubmissionPage>("/submissions/page?limit=200");
      setIndex(new Map((response.items ?? []).map((submission) => [submission.id, submission])));
    } catch {
      // Submission summaries are a convenience; the assessment view still works without them.
    }
  }, [publicOnly]);
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
  const { me } = useAuth();
  const viewer = isPublicOnly(me?.roles);
  const [items, setItems] = useState<Assessment[]>([]);
  const [detail, setDetail] = useState<AssessmentDetail | null>(null);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<"ALL" | AssessmentState>("ALL");
  const [officeFilter, setOfficeFilter] = useState<"ALL" | string>("ALL");
  const [branchFilter, setBranchFilter] = useState<"ALL" | string>("ALL");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { submissionsById, reloadSubmissions } = useSubmissionIndex();
  const { officeNames } = useOrgLabels();
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

  /**
   * The office and branch NAMES present in the loaded rows, from each row's own
   * routing snapshot. Built from the data rather than from a fixed list of
   * offices: a filter must never offer an office that no record here belongs to,
   * and must never miss one whose office has since been renamed.
   */
  const officeChoices = useMemo(() => {
    const names = new Set<string>();
    for (const assessment of items) names.add(assessmentOfficeName(assessment, officeNames));
    return [...names].sort();
  }, [items, officeNames]);

  const branchChoices = useMemo(() => {
    const names = new Set<string>();
    for (const assessment of items) {
      if (officeFilter !== "ALL" && assessmentOfficeName(assessment, officeNames) !== officeFilter) continue;
      const branch = assessmentBranchName(assessment);
      if (branch) names.add(branch);
    }
    return [...names].sort();
  }, [items, officeFilter, officeNames]);

  const filtered = useMemo(() => {
    const descriptor = (submission: Pick<Submission, "id" | "district" | "county" | "route" | "post_mile">) =>
      buildSubmissionDisplayTitle({ id: submission.id, district: submission.district, county: submission.county, route: submission.route, post_mile: submission.post_mile });
    return items
      .filter((assessment) => stateFilter === "ALL" || assessment.state === stateFilter)
      .filter((assessment) => officeFilter === "ALL" || assessmentOfficeName(assessment, officeNames) === officeFilter)
      .filter((assessment) => branchFilter === "ALL" || assessmentBranchName(assessment) === branchFilter)
      .filter((assessment) => {
        const linked = submissionIdsOf(assessment).map((id) => submissionsById.get(id)).filter((value): value is Submission => !!value);
        return assessmentSearchMatch(assessment, linked, query, descriptor);
      });
  }, [branchFilter, items, officeFilter, officeNames, query, stateFilter, submissionsById]);

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
          {/* A viewer has one state — approved — so the filter would be a
              one-entry list that implies the others are hidden from them. */}
          {viewer ? null : (
            <select value={stateFilter} onChange={(event) => setStateFilter(event.target.value as "ALL" | AssessmentState)} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm">
              <option value="ALL">All states</option>
              {ASSESSMENT_STATES.map((state) => <option key={state} value={state}>{assessmentStateLabel(state)}</option>)}
            </select>
          )}
          {officeChoices.length > 1 ? (
            <select
              value={officeFilter}
              onChange={(event) => { setOfficeFilter(event.target.value); setBranchFilter("ALL"); }}
              aria-label="Office"
              className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm"
            >
              <option value="ALL">All offices</option>
              {officeChoices.map((office) => <option key={office} value={office}>{office}</option>)}
            </select>
          ) : null}
          {branchChoices.length > 1 ? (
            <select value={branchFilter} onChange={(event) => setBranchFilter(event.target.value)} aria-label="Branch" className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm">
              <option value="ALL">All branches</option>
              {branchChoices.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
            </select>
          ) : null}
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search assessments, incidents, or submissions" className="min-w-40 flex-1 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]" />
          <span className="text-xs text-muted">{filtered.length} of {items.length} {viewer ? "approved records" : "assessments"}</span>
          <button type="button" onClick={refreshAll} disabled={loading} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">{loading ? "Refreshing…" : "Refresh"}</button>
        </div>

        {viewer ? (
          <div className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm text-muted">
            Approved assessments and the technical submissions attached to them. Work still in progress is not part of the record.
          </div>
        ) : (
          <div className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm text-muted">
            Read-only record view of every assessment and its attached technical submissions. Steps assigned to your role are performed from <Link to="/my-work" className="font-medium text-[var(--brand)] hover:underline">My Work</Link>.
          </div>
        )}

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

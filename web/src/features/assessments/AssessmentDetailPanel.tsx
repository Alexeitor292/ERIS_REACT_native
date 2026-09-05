import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";

import {
  addAssignment,
  assessmentAssignmentOptions,
  assignEngineer,
  branchOptions,
  createAssessmentSubmission,
  delegateBranch,
  finalizeAssessment,
  removeAssignment,
  reviewAssessment,
  submitAssessment,
  type AssessmentDetail,
  type AssignmentUserOption,
  type RoutingUserOption,
} from "../../api/assessments";
import { api } from "../../api/client";
import type { Incident, Submission } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { SubmissionStatusBadge } from "../submissions/SubmissionDetailPrimitives";
import { buildSubmissionDisplayTitle } from "../../utils/submissionLabel";
import { canAssignEngineer, canDelegateBranch, isAdmin, isEngineer } from "../../utils/roleModel";
import {
  ASSESSMENT_PIPELINE,
  assessmentPermissions,
  assessmentStateLabel,
  assessmentTone,
  humanizeCode,
  isActionable,
  latestSubmissionId,
  pipelineIndex,
  submissionIdsOf,
  waitingOn,
  type Tone,
} from "./assessmentModel";

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function formatTimestamp(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : dateTimeFormatter.format(parsed);
}

const OFFICE_NAMES: Record<string, string> = {
  NORTH: "North GeoTech Office",
  WEST: "West GeoTech Office",
  SOUTH: "South GeoTech Office",
};

export function officeLabel(code: string | null | undefined) {
  if (!code) return "Office —";
  return OFFICE_NAMES[code] ?? `Office ${code}`;
}

const toneClass: Record<Tone, string> = {
  good: "border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] text-[var(--good)]",
  bad: "border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] text-[var(--bad)]",
  brand: "border-[color:color-mix(in_oklab,var(--brand)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_10%,transparent)] text-[var(--brand)]",
  neutral: "border-[var(--line)] bg-[var(--panel-soft)] text-[var(--ink)]",
};

export function AssessmentStateBadge({ state, mini = false }: { state: string; mini?: boolean }) {
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full border font-semibold ${mini ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs"} ${toneClass[assessmentTone(state)]}`}>
      {assessmentStateLabel(state)}
    </span>
  );
}

export function Pipeline({ state }: { state: string }) {
  const current = pipelineIndex(state);
  const revision = state === "REVISION_REQUESTED";
  const finalized = state === "FINALIZED";
  return (
    <ol className="mt-4 flex items-start overflow-x-auto" aria-label="Assessment pipeline">
      {ASSESSMENT_PIPELINE.map((step, index) => {
        const done = index < current;
        const active = index === current;
        const dotColor = done ? "var(--good)" : active ? (revision ? "var(--bad)" : finalized ? "var(--good)" : "var(--brand)") : "var(--panel-soft)";
        return (
          <li key={step.key} className={`flex min-w-0 items-start ${index < ASSESSMENT_PIPELINE.length - 1 ? "flex-1" : "flex-none"}`}>
            <div className="min-w-[74px] text-center">
              <div
                aria-hidden
                className="mx-auto h-3.5 w-3.5 rounded-full"
                style={{
                  background: dotColor,
                  border: index > current ? "2px solid var(--line)" : "2px solid transparent",
                  boxShadow: active && !finalized ? `0 0 0 3px color-mix(in oklab, ${revision ? "var(--bad)" : "var(--brand)"} 25%, transparent)` : "none",
                }}
              />
              <div className={`mt-1.5 whitespace-nowrap text-[11px] ${active ? "font-bold" : "font-medium"} ${index > current ? "text-muted" : "text-[var(--ink)]"}`}>
                {active && revision ? "Revision requested" : step.label}
              </div>
            </div>
            {index < ASSESSMENT_PIPELINE.length - 1 ? <div aria-hidden className="mt-1.5 h-0.5 min-w-3 flex-1" style={{ background: done ? "var(--good)" : "var(--line)" }} /> : null}
          </li>
        );
      })}
    </ol>
  );
}

function Card({ title, hint, actions, children, bodyClassName = "p-4" }: { title: ReactNode; hint?: ReactNode; actions?: ReactNode; children: ReactNode; bodyClassName?: string }) {
  return (
    <section className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-[var(--line)] bg-[var(--panel-soft)] px-4 py-3">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {hint ? <span className="text-xs text-muted">{hint}</span> : null}
        {actions ? <div className="ml-auto flex flex-wrap items-center gap-1.5">{actions}</div> : null}
      </div>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

const btn = "rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--panel-soft)] disabled:cursor-not-allowed disabled:opacity-50";
const btnPrimary = "rounded-md bg-[var(--brand)] px-3 py-1.5 text-xs font-semibold text-white hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50";
const btnGood = "rounded-md bg-[var(--good)] px-3 py-1.5 text-xs font-semibold text-white hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50";
const select = "min-w-0 flex-1 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm";

export type IncidentContext = {
  incident: Incident | null;
  eventGroupId: number | null;
};

type Props = {
  detail: AssessmentDetail;
  /** Known submission summaries (worklist index); missing ids render by number only. */
  submissionsById: ReadonlyMap<number, Submission>;
  /** `work` renders inline actions for the signed-in role; `record` is the read-only browse view. */
  mode: "work" | "record";
  onChanged: () => Promise<void> | void;
  onError: (message: string) => void;
};

export default function AssessmentDetailPanel({ detail, submissionsById, mode, onChanged, onError }: Props) {
  const { me } = useAuth();
  const navigate = useNavigate();
  const { assessment, assignments, events } = detail;
  const roles = me?.roles;
  const flags = useMemo(
    () => ({ admin: isAdmin(roles), officeChief: canDelegateBranch(roles), branchChief: canAssignEngineer(roles), engineer: isEngineer(roles) }),
    [roles],
  );
  const permissions = useMemo(() => assessmentPermissions(flags, me?.id, assessment, assignments), [assessment, assignments, flags, me?.id]);
  const actionable = isActionable(permissions);
  const next = waitingOn(assessment, assignments);
  const submissionIds = submissionIdsOf(assessment);
  const latestId = latestSubmissionId(assessment);

  const [context, setContext] = useState<IncidentContext>({ incident: null, eventGroupId: null });
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState("");
  const [branchList, setBranchList] = useState<RoutingUserOption[]>([]);
  const [engineerOptions, setEngineerOptions] = useState<AssignmentUserOption[]>([]);
  const [reviewerOptions, setReviewerOptions] = useState<AssignmentUserOption[]>([]);
  const [branchChiefId, setBranchChiefId] = useState("");
  const [engineerId, setEngineerId] = useState("");
  const [reviewerId, setReviewerId] = useState("");

  useEffect(() => {
    setNotes(""); setBranchChiefId(""); setEngineerId(""); setReviewerId("");
  }, [assessment.id, assessment.state]);

  // Incident title / Event Group for cross-links (incident payload carries event_group_id).
  useEffect(() => {
    let cancelled = false;
    api<{ incident: Incident & { event_group_id?: number | null } }>(`/incidents/${assessment.incident_id}`)
      .then((response) => {
        if (cancelled) return;
        setContext({ incident: response.incident, eventGroupId: response.incident.event_group_id ?? null });
      })
      .catch(() => {
        if (!cancelled) setContext({ incident: null, eventGroupId: null });
      });
    return () => { cancelled = true; };
  }, [assessment.incident_id]);

  const showDelegate = mode === "work" && permissions.delegate;
  const showAssignEngineer = mode === "work" && permissions.assignEngineer;
  const showReviewerManagement = mode === "work" && permissions.addReviewer;

  useEffect(() => {
    let cancelled = false;
    const requests: Array<Promise<void>> = [];
    if (showDelegate) {
      requests.push(branchOptions(assessment.id).then((response) => { if (!cancelled) setBranchList(response.items ?? []); }));
      requests.push(assessmentAssignmentOptions(assessment.id, "ENGINEER").then((response) => { if (!cancelled) setEngineerOptions(response.items ?? []); }).catch(() => { if (!cancelled) setEngineerOptions([]); }));
    } else setBranchList([]);
    if (showAssignEngineer) requests.push(assessmentAssignmentOptions(assessment.id, "ENGINEER").then((response) => { if (!cancelled) setEngineerOptions(response.items ?? []); }));
    else if (!showDelegate) setEngineerOptions([]);
    if (showReviewerManagement) requests.push(assessmentAssignmentOptions(assessment.id, "REVIEWER").then((response) => { if (!cancelled) setReviewerOptions(response.items ?? []); }));
    else setReviewerOptions([]);
    Promise.all(requests).catch((error) => { if (!cancelled) onError(error instanceof Error ? error.message : "Failed to load assignment options."); });
    return () => { cancelled = true; };
  }, [assessment.id, onError, showAssignEngineer, showDelegate, showReviewerManagement]);

  const run = async (action: () => Promise<unknown>, after?: (result: unknown) => void) => {
    setBusy(true);
    try {
      const result = await action();
      setNotes(""); setBranchChiefId(""); setEngineerId(""); setReviewerId("");
      await onChanged();
      after?.(result);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  };

  const assignedReviewerIds = new Set(assignments.filter((assignment) => assignment.assignment_role === "REVIEWER" || assignment.assignment_role === "APPROVER").map((assignment) => assignment.user_id));
  const availableReviewers = reviewerOptions.filter((option) => !assignedReviewerIds.has(option.id));
  const revision = assessment.state === "REVISION_REQUESTED";
  const incidentTitle = context.incident?.title ? `Incident #${assessment.incident_id} · ${context.incident.title}` : `Incident #${assessment.incident_id} technical assessment`;

  return (
    <div className="grid gap-3.5">
      <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Assessment #{assessment.id}</div>
            <h2 className="mt-0.5 text-lg font-semibold leading-snug">{incidentTitle}</h2>
            <div className="mt-1 text-[13px] text-muted">{officeLabel(assessment.office_code)} · District {assessment.district ?? "—"} · Updated {formatTimestamp(assessment.updated_at)}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <AssessmentStateBadge state={assessment.state} />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link to={`/incidents/${assessment.incident_id}`} className={btn}>Open incident</Link>
          {context.eventGroupId != null ? <Link to={`/mission-center/${context.eventGroupId}/${assessment.incident_id}`} className={btn}>View on map</Link> : null}
          {context.eventGroupId != null ? <Link to={`/event-groups/${context.eventGroupId}`} className={btn}>Event Group #{context.eventGroupId}</Link> : null}
        </div>
        <Pipeline state={assessment.state} />
        {assessment.office_override_reason ? <div className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3 text-[13px]"><b>Routing override:</b> {assessment.office_override_reason}</div> : null}
      </section>

      {!next ? (
        <div className="rounded-xl border border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] px-4 py-3 text-sm text-[var(--good)]">
          <b>Workflow complete.</b> Finalized {formatTimestamp(assessment.finalized_at)}.
        </div>
      ) : (
        <section
          className="rounded-xl border p-4"
          style={{
            borderColor: `color-mix(in oklab, ${revision ? "var(--bad)" : "var(--brand)"} 40%, transparent)`,
            background: `color-mix(in oklab, ${revision ? "var(--bad)" : "var(--brand)"} 6%, var(--panel))`,
          }}
        >
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-[11px] font-bold uppercase tracking-[0.08em]" style={{ color: revision ? "var(--bad)" : "var(--brand)" }}>Next step</span>
            <span className="text-[15px] font-semibold">Waiting on {next.who}</span>
          </div>
          <p className="mt-1.5 text-sm">{next.text}</p>

          {mode === "record" ? (
            actionable
              ? <Link to={`/my-work?assessment=${assessment.id}`} className={`${btnPrimary} mt-3 inline-block`}>This step is yours — act on it in My Work</Link>
              : <p className="mt-2.5 text-[13px] text-muted">Actions for this step are performed from My Work by the responsible role.</p>
          ) : !actionable ? (
            <p className="mt-2.5 text-[13px] text-muted">No actions for your role on this step.</p>
          ) : (
            <div className="mt-3 grid gap-2.5">
              {permissions.submit || permissions.addSubmission ? (
                <div className="flex flex-wrap items-center gap-2">
                  {latestId != null ? <Link to={`/submissions/${latestId}`} className={btnPrimary}>Fill out submission #{latestId}</Link> : null}
                  {permissions.addSubmission ? (
                    <button
                      type="button"
                      disabled={busy}
                      className={btn}
                      onClick={() => run(() => createAssessmentSubmission(assessment.id, notes.trim() || undefined), (result) => {
                        const created = (result as { submission_id?: number } | undefined)?.submission_id;
                        if (created) navigate(`/submissions/${created}`);
                      })}
                    >
                      {submissionIds.length ? "Add another draft submission" : "Create draft technical submission"}
                    </button>
                  ) : null}
                  <span className="text-xs text-muted">{submissionIds.length === 0 ? "At least one submission is required before submitting for review." : `${submissionIds.length} submission${submissionIds.length === 1 ? "" : "s"} attached.`}</span>
                </div>
              ) : null}
              <textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional workflow notes" className="w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" />
              <div className="flex flex-wrap items-center gap-2">
                {showDelegate ? (
                  <>
                    <select className={select} value={branchChiefId} onChange={(event) => setBranchChiefId(event.target.value)}>
                      <option value="">Select branch chief…</option>
                      {branchList.map((option) => <option key={option.id} value={option.id}>{option.full_name} · {option.email}</option>)}
                    </select>
                    <select className={select} value={engineerId} onChange={(event) => setEngineerId(event.target.value)}>
                      <option value="">Assign engineer now (optional)…</option>
                      {engineerOptions.map((option) => <option key={option.id} value={option.id}>{option.full_name} · {option.email}</option>)}
                    </select>
                    <button type="button" disabled={busy || !branchChiefId} className={btnPrimary} onClick={() => run(() => delegateBranch(assessment.id, Number(branchChiefId), notes.trim() || undefined, engineerId ? Number(engineerId) : null))}>Delegate</button>
                  </>
                ) : null}
                {showAssignEngineer ? (
                  <>
                    <select className={select} value={engineerId} onChange={(event) => setEngineerId(event.target.value)}>
                      <option value="">Select engineer…</option>
                      {engineerOptions.map((option) => <option key={option.id} value={option.id}>{option.full_name} · {option.email}</option>)}
                    </select>
                    <button type="button" disabled={busy || !engineerId} className={btnPrimary} onClick={() => run(() => assignEngineer(assessment.id, Number(engineerId), notes.trim() || undefined))}>Assign engineer</button>
                  </>
                ) : null}
                {permissions.submit ? (
                  <button type="button" disabled={busy || submissionIds.length === 0} className={btnPrimary} onClick={() => run(() => submitAssessment(assessment.id, notes.trim() || undefined))}>Submit for review</button>
                ) : null}
                {permissions.review ? (
                  <>
                    <button type="button" disabled={busy} className={`${btn} text-[var(--bad)]`} onClick={() => run(() => reviewAssessment(assessment.id, "REQUEST_REVISION", notes.trim() || "Revision requested."))}>Request revision</button>
                    <button type="button" disabled={busy} className={btnGood} onClick={() => run(() => reviewAssessment(assessment.id, "APPROVE", notes.trim() || undefined))}>Approve assessment</button>
                  </>
                ) : null}
                {permissions.finalize ? (
                  <button type="button" disabled={busy} className={btnGood} onClick={() => run(() => finalizeAssessment(assessment.id, notes.trim() || undefined))}>Finalize assessment</button>
                ) : null}
              </div>
            </div>
          )}
        </section>
      )}

      <Card title={`Technical submissions (${submissionIds.length})`} hint="All GISA forms attached to this assessment's incident" bodyClassName={submissionIds.length === 0 ? "p-4" : "overflow-x-auto"}>
        {submissionIds.length === 0 ? (
          <div className="text-sm text-muted">
            No technical submission is attached{assessment.state === "FINALIZED" ? " — this assessment was finalized without a GISA form." : " yet — the assigned engineer creates it during the Engineering step."}
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead><tr className="border-b border-[var(--line)] bg-[var(--panel-soft)] text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-muted"><th className="px-3 py-2.5">ID</th><th className="px-3 py-2.5">Submission</th><th className="px-3 py-2.5">Status</th><th className="px-3 py-2.5">Reporter</th><th className="px-3 py-2.5">Created</th><th className="px-3 py-2.5">Submitted</th><th className="px-3 py-2.5 text-right">Action</th></tr></thead>
            <tbody>
              {submissionIds.map((submissionId) => {
                const submission = submissionsById.get(submissionId);
                const descriptor = submission ? buildSubmissionDisplayTitle({ id: submission.id, created_at: submission.created_at, district: submission.district, county: submission.county, route: submission.route, post_mile: submission.post_mile }) : `Submission #${submissionId}`;
                const status = submission?.status;
                return (
                  <tr key={submissionId} className="border-b border-[var(--line)]/60 last:border-b-0">
                    <td className="px-3 py-2.5 text-sm font-semibold tabular-nums">#{submissionId}</td>
                    <td className="px-3 py-2.5 text-sm"><Link to={`/submissions/${submissionId}`} className="font-medium text-[var(--ink)] hover:text-[var(--brand)]">{descriptor}</Link></td>
                    <td className="px-3 py-2.5 text-sm">{status ? <SubmissionStatusBadge status={status} /> : <span className="text-muted">—</span>}</td>
                    <td className="px-3 py-2.5 text-sm text-muted">{submission ? (me?.id === submission.created_by_user_id ? "You" : `User #${submission.created_by_user_id}`) : "—"}</td>
                    <td className="px-3 py-2.5 text-sm text-muted">{formatTimestamp(submission?.created_at)}</td>
                    <td className="px-3 py-2.5 text-sm text-muted">{formatTimestamp(submission?.submitted_at)}</td>
                    <td className="px-3 py-2.5 text-right"><Link to={`/submissions/${submissionId}`} className={status === "SUBMITTED" ? btnPrimary : btn}>{status === "SUBMITTED" ? "Review" : "Open"}</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Card
        title="Assignments"
        actions={showReviewerManagement ? (
          <>
            <select className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-xs" value={reviewerId} onChange={(event) => setReviewerId(event.target.value)}>
              <option value="">Add reviewer…</option>
              {availableReviewers.map((option) => <option key={option.id} value={option.id}>{option.full_name}</option>)}
            </select>
            <button type="button" disabled={busy || !reviewerId} className={btn} onClick={() => run(() => addAssignment(assessment.id, { user_id: Number(reviewerId), assignment_role: "REVIEWER", notes: notes.trim() || undefined }))}>Add</button>
          </>
        ) : null}
      >
        {assignments.length === 0 ? <div className="text-sm text-muted">No active assignments yet.</div> : (
          <div className="grid gap-2">
            {assignments.map((assignment) => (
              <div key={assignment.id} className="flex flex-wrap items-center justify-between gap-2.5 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3">
                <div><div className="text-sm font-semibold">{assignment.full_name}</div><div className="mt-0.5 text-xs text-muted">{humanizeCode(assignment.assignment_role)} · {assignment.email}</div></div>
                {assignment.assignment_role !== "ENGINEER" && showReviewerManagement ? <button type="button" disabled={busy} className={`${btn} text-[var(--bad)]`} onClick={() => run(() => removeAssignment(assessment.id, assignment.id))}>Remove</button> : null}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title={`Assessment history (${events.length})`} bodyClassName="max-h-[420px] overflow-auto p-4">
        {events.length === 0 ? <div className="text-sm text-muted">No assessment events recorded yet.</div> : (
          <div className="grid gap-2">
            {[...events].reverse().map((event) => (
              <div key={event.id} className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3 text-[13px]">
                <div className="flex flex-wrap justify-between gap-2">
                  <div><div className="font-semibold">{humanizeCode(event.event_type)}{event.disposition ? ` · ${humanizeCode(event.disposition)}` : ""}</div><div className="mt-0.5 text-xs text-muted">by {event.actor_name || event.actor_email || `User #${event.actor_user_id}`}</div></div>
                  <span className="text-xs text-muted">{formatTimestamp(event.created_at)}</span>
                </div>
                {event.from_state || event.to_state ? <div className="mt-1.5 text-xs text-muted">{event.from_state ? assessmentStateLabel(event.from_state) : "—"} → {event.to_state ? assessmentStateLabel(event.to_state) : "—"}</div> : null}
                {event.notes ? <div className="mt-2 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2">{event.notes}</div> : null}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/** Rail entry shared by My Work and the Assessments record view. */
export function AssessmentRailCard({
  assessment,
  assignments,
  submissionsById,
  active,
  to,
  onClick,
  refCallback,
}: {
  assessment: AssessmentDetail["assessment"];
  assignments?: AssessmentDetail["assignments"];
  submissionsById: ReadonlyMap<number, Submission>;
  active: boolean;
  to?: string;
  onClick?: () => void;
  refCallback?: (element: HTMLElement | null) => void;
}) {
  const next = waitingOn(assessment, assignments ?? []);
  const ids = submissionIdsOf(assessment);
  const first = ids.length === 1 ? submissionsById.get(ids[0]) : undefined;
  const inner = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div><div className="font-semibold">Assessment #{assessment.id}</div><div className="mt-0.5 text-xs text-muted">Incident #{assessment.incident_id} · {assessment.office_code ? `Office ${assessment.office_code}` : "Office —"} · D{assessment.district ?? "—"}</div></div>
        <AssessmentStateBadge state={assessment.state} mini />
      </div>
      <div className="mt-2 text-xs">{next ? <><span className="text-muted">Waiting on </span><b className="font-semibold">{next.who}</b></> : <span className="font-semibold text-[var(--good)]">Complete</span>}</div>
      <div className="mt-0.5 text-xs text-muted">
        {ids.length === 0
          ? "No technical submissions attached"
          : ids.length === 1
            ? `Submission #${ids[0]}${first ? ` · ${buildSubmissionDisplayTitle({ id: first.id, created_at: first.created_at, district: first.district, county: first.county, route: first.route, post_mile: first.post_mile })}` : ""}`
            : `${ids.length} submissions · ${ids.map((id) => `#${id}`).join(", ")}`}
      </div>
    </>
  );
  const className = `block w-full rounded-lg border p-3 text-left text-[var(--ink)] ${active ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_7%,var(--panel))]" : "border-[var(--line)] bg-[var(--panel)] hover:border-[color:color-mix(in_oklab,var(--brand)_45%,var(--line))] hover:bg-[var(--panel-soft)]"}`;
  if (to) return <Link ref={refCallback as any} to={to} className={className}>{inner}</Link>;
  return <button ref={refCallback as any} type="button" onClick={onClick} className={className}>{inner}</button>;
}

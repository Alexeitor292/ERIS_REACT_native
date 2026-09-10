import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";

import {
  addAssignment,
  assessmentAssignmentOptions,
  assignEngineer,
  assignSpecialist,
  branchOptions,
  createAssessmentSubmission,
  delegateBranch,
  removeAssignment,
  reviewAssessment,
  specialistOptions,
  submitAssessment,
  type AssessmentDetail,
  type AssignmentUserOption,
  type RoutingPath,
  type RoutingUserOption,
} from "../../api/assessments";
import { api } from "../../api/client";
import type { Incident, Submission } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { SubmissionStatusBadge } from "../submissions/SubmissionDetailPrimitives";
import { buildSubmissionDisplayTitle } from "../../utils/submissionLabel";
import { canAssignEngineer, canDelegateBranch, isAdmin, isEngineer, isSeniorSpecialist } from "../../utils/roleModel";
import {
  assessmentPermissions,
  assessmentStateLabel,
  assessmentStateLabelFor,
  assessmentTone,
  humanizeCode,
  isActionable,
  latestSubmissionId,
  officeLabel,
  pipelineFor,
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

export { officeLabel };

const toneClass: Record<Tone, string> = {
  good: "border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] text-[var(--good)]",
  bad: "border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] text-[var(--bad)]",
  brand: "border-[color:color-mix(in_oklab,var(--brand)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_10%,transparent)] text-[var(--brand)]",
  neutral: "border-[var(--line)] bg-[var(--panel-soft)] text-[var(--ink)]",
};

export function AssessmentStateBadge({ state, routingPath = null, mini = false }: { state: string; routingPath?: RoutingPath | null; mini?: boolean }) {
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full border font-semibold ${mini ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs"} ${toneClass[assessmentTone(state)]}`}>
      {assessmentStateLabelFor(state, routingPath)}
    </span>
  );
}

/** The ladder this assessment actually walks — branch, specialist, or not yet routed. */
export function Pipeline({ assessment }: { assessment: Pick<AssessmentDetail["assessment"], "state" | "routing_path"> }) {
  const steps = pipelineFor(assessment);
  const current = pipelineIndex(assessment);
  const state = assessment.state;
  const revision = state === "REVISION_REQUESTED";
  const finalized = state === "FINALIZED";
  const complete = finalized || state === "APPROVED";
  return (
    <ol className="mt-4 flex items-start overflow-x-auto" aria-label="Assessment pipeline">
      {steps.map((step, index) => {
        const done = index < current;
        const active = index === current;
        const dotColor = done ? "var(--good)" : active ? (revision ? "var(--bad)" : complete ? "var(--good)" : "var(--brand)") : "var(--panel-soft)";
        return (
          <li key={step.key} className={`flex min-w-0 items-start ${index < steps.length - 1 ? "flex-1" : "flex-none"}`}>
            <div className="min-w-[74px] text-center">
              <div
                aria-hidden
                className="mx-auto h-3.5 w-3.5 rounded-full"
                style={{
                  background: dotColor,
                  border: index > current ? "2px solid var(--line)" : "2px solid transparent",
                  boxShadow: active && !complete ? `0 0 0 3px color-mix(in oklab, ${revision ? "var(--bad)" : "var(--brand)"} 25%, transparent)` : "none",
                }}
              />
              <div className={`mt-1.5 whitespace-nowrap text-[11px] ${active ? "font-bold" : "font-medium"} ${index > current ? "text-muted" : "text-[var(--ink)]"}`}>
                {active && revision ? "Revision requested" : active && finalized ? "Signed off (legacy)" : step.label}
              </div>
            </div>
            {index < steps.length - 1 ? <div aria-hidden className="mt-1.5 h-0.5 min-w-3 flex-1" style={{ background: done ? "var(--good)" : "var(--line)" }} /> : null}
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

/** The office chief's two mutually exclusive choices, with what each one costs them. */
const ROUTE_CHOICES: Array<{ value: RoutingPath; label: string; consequence: string }> = [
  {
    value: "BRANCH",
    label: "Hand off to a branch chief",
    consequence: "The branch chief assigns the engineer and approves the finished assessment. You are done with this case.",
  },
  {
    value: "SENIOR_SPECIALIST",
    label: "Assign a senior specialist",
    consequence: "The specialist fills the assessment and returns it to you for approval.",
  },
];

/** Retired assignment roles: kept as history, never as authority. */
function isHistoricalAssignment(role: string): boolean {
  return role === "REVIEWER" || role === "APPROVER";
}

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
    () => ({
      admin: isAdmin(roles),
      officeChief: canDelegateBranch(roles),
      branchChief: canAssignEngineer(roles),
      engineer: isEngineer(roles),
      seniorSpecialist: isSeniorSpecialist(roles),
    }),
    [roles],
  );
  const permissions = useMemo(
    () => assessmentPermissions(flags, me?.id, me?.metadata?.office_code, assessment),
    [assessment, flags, me?.id, me?.metadata?.office_code],
  );
  const actionable = isActionable(permissions);
  const next = waitingOn(assessment, assignments);
  const submissionIds = submissionIdsOf(assessment);
  const latestId = latestSubmissionId(assessment);

  const [context, setContext] = useState<IncidentContext>({ incident: null, eventGroupId: null });
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState("");
  const [branchList, setBranchList] = useState<RoutingUserOption[]>([]);
  const [specialistList, setSpecialistList] = useState<RoutingUserOption[]>([]);
  const [engineerOptions, setEngineerOptions] = useState<AssignmentUserOption[]>([]);
  const [consultedOptions, setConsultedOptions] = useState<AssignmentUserOption[]>([]);
  const [routeChoice, setRouteChoice] = useState<RoutingPath | null>(null);
  const [consultedOpen, setConsultedOpen] = useState(false);
  const [branchChiefId, setBranchChiefId] = useState("");
  const [specialistId, setSpecialistId] = useState("");
  const [engineerId, setEngineerId] = useState("");
  const [consultedId, setConsultedId] = useState("");

  const resetPickers = () => {
    setBranchChiefId(""); setSpecialistId(""); setEngineerId(""); setConsultedId("");
  };

  useEffect(() => {
    setNotes(""); setRouteChoice(null); setConsultedOpen(false);
    setBranchChiefId(""); setSpecialistId(""); setEngineerId(""); setConsultedId("");
  }, [assessment.id, assessment.state, assessment.routing_path]);

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

  const showRouting = mode === "work" && (permissions.delegate || permissions.assignSpecialist);
  const showAssignEngineer = mode === "work" && permissions.assignEngineer;
  const showConsultedManagement = mode === "work" && permissions.manageConsulted;

  // The route choice precedes the picker, so exactly one routing option list is
  // ever fetched — with the engineer list that is at most two per state.
  const routeOptions = useMemo(
    () => ROUTE_CHOICES.filter((choice) => (choice.value === "BRANCH" ? permissions.delegate : permissions.assignSpecialist)),
    [permissions.assignSpecialist, permissions.delegate],
  );
  const activeRoute: RoutingPath | null = showRouting
    ? (routeChoice && routeOptions.some((choice) => choice.value === routeChoice)
      ? routeChoice
      : routeOptions.length === 1 ? routeOptions[0].value : null)
    : null;

  useEffect(() => {
    let cancelled = false;
    const requests: Array<Promise<void>> = [];
    if (activeRoute === "BRANCH") requests.push(branchOptions(assessment.id).then((response) => { if (!cancelled) setBranchList(response.items ?? []); }));
    else setBranchList([]);
    if (activeRoute === "SENIOR_SPECIALIST") requests.push(specialistOptions(assessment.id).then((response) => { if (!cancelled) setSpecialistList(response.items ?? []); }));
    else setSpecialistList([]);
    if (showAssignEngineer) requests.push(assessmentAssignmentOptions(assessment.id, "ENGINEER").then((response) => { if (!cancelled) setEngineerOptions(response.items ?? []); }));
    else setEngineerOptions([]);
    Promise.all(requests).catch((error) => { if (!cancelled) onError(error instanceof Error ? error.message : "Failed to load assignment options."); });
    return () => { cancelled = true; };
  }, [activeRoute, assessment.id, onError, showAssignEngineer]);

  // Consulted is for information only, so its picker loads on request.
  useEffect(() => {
    if (!showConsultedManagement || !consultedOpen) { setConsultedOptions([]); return; }
    let cancelled = false;
    assessmentAssignmentOptions(assessment.id, "CONSULTED")
      .then((response) => { if (!cancelled) setConsultedOptions(response.items ?? []); })
      .catch((error) => { if (!cancelled) onError(error instanceof Error ? error.message : "Failed to load people to consult."); });
    return () => { cancelled = true; };
  }, [assessment.id, consultedOpen, onError, showConsultedManagement]);

  const run = async (action: () => Promise<unknown>, after?: (result: unknown) => void) => {
    setBusy(true);
    try {
      const result = await action();
      setNotes(""); resetPickers();
      await onChanged();
      after?.(result);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  };

  const assignedIds = new Set(assignments.map((assignment) => assignment.user_id));
  const availableConsulted = consultedOptions.filter((option) => !assignedIds.has(option.id));
  const revision = assessment.state === "REVISION_REQUESTED";
  const incidentTitle = context.incident?.title ? `Incident #${assessment.incident_id} · ${context.incident.title}` : `Incident #${assessment.incident_id} technical assessment`;
  const approver = [...events].reverse().find((event) => event.event_type === "APPROVED");
  const approverName = approver?.actor_name || approver?.actor_email || null;

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
            <AssessmentStateBadge state={assessment.state} routingPath={assessment.routing_path} />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link to={`/incidents/${assessment.incident_id}`} className={btn}>Open incident</Link>
          {context.eventGroupId != null ? <Link to={`/mission-center/${context.eventGroupId}/${assessment.incident_id}`} className={btn}>View on map</Link> : null}
          {context.eventGroupId != null ? <Link to={`/event-groups/${context.eventGroupId}`} className={btn}>Event Group #{context.eventGroupId}</Link> : null}
        </div>
        <Pipeline assessment={assessment} />
        {assessment.office_override_reason ? <div className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3 text-[13px]"><b>Routing override:</b> {assessment.office_override_reason}</div> : null}
      </section>

      {!next ? (
        <div className="rounded-xl border border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] px-4 py-3 text-sm text-[var(--good)]">
          {assessment.state === "APPROVED" ? (
            <><b>Assessment complete.</b> Approved {formatTimestamp(assessment.approved_at)}{approverName ? ` by ${approverName}` : ""}.</>
          ) : (
            <><b>Signed off</b> {formatTimestamp(assessment.finalized_at)} (legacy). Approval completes an assessment now.</>
          )}
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

              {showRouting ? (
                <div className="grid gap-2.5 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                    {assessment.routing_path == null ? "Route this assessment" : "Change who has this assessment"}
                  </div>
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Routing choice">
                    {routeOptions.map((choice) => {
                      const selected = activeRoute === choice.value;
                      return (
                        <button
                          key={choice.value}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => { setRouteChoice(choice.value); resetPickers(); }}
                          className={`rounded-md border px-3 py-1.5 text-xs font-semibold ${selected ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_12%,transparent)] text-[var(--brand)]" : "border-[var(--line)] bg-[var(--panel)] hover:bg-[var(--panel-soft)]"}`}
                        >
                          {choice.label}
                        </button>
                      );
                    })}
                  </div>
                  {activeRoute == null ? (
                    <p className="text-[13px] text-muted">Choose how this assessment is handled. The two routes are exclusive — the other one closes once you pick.</p>
                  ) : (
                    <>
                      <p className="text-[13px]">{ROUTE_CHOICES.find((choice) => choice.value === activeRoute)?.consequence}</p>
                      {activeRoute === "BRANCH" ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <select className={select} value={branchChiefId} onChange={(event) => setBranchChiefId(event.target.value)}>
                            <option value="">Select branch chief…</option>
                            {branchList.map((option) => <option key={option.id} value={option.id}>{option.full_name} · {option.email}</option>)}
                          </select>
                          <button type="button" disabled={busy || !branchChiefId} className={btnPrimary} onClick={() => run(() => delegateBranch(assessment.id, Number(branchChiefId), notes.trim() || undefined))}>
                            {assessment.routing_path === "BRANCH" ? "Hand to this branch chief" : "Hand off"}
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center gap-2">
                          <select className={select} value={specialistId} onChange={(event) => setSpecialistId(event.target.value)}>
                            <option value="">Select senior specialist…</option>
                            {specialistList.map((option) => <option key={option.id} value={option.id}>{option.full_name} · {option.email}</option>)}
                          </select>
                          <button type="button" disabled={busy || !specialistId} className={btnPrimary} onClick={() => run(() => assignSpecialist(assessment.id, Number(specialistId), notes.trim() || undefined))}>Assign specialist</button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ) : null}

              <textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional workflow notes" className="w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm" />
              <div className="flex flex-wrap items-center gap-2">
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
              </div>
              {permissions.review ? (
                <p className="text-[13px] text-muted">This completes the assessment and notifies the district coordinator.</p>
              ) : null}
            </div>
          )}
        </section>
      )}

      <Card title={`Technical submissions (${submissionIds.length})`} hint="All GISA forms attached to this assessment's incident" bodyClassName={submissionIds.length === 0 ? "p-4" : "overflow-x-auto"}>
        {submissionIds.length === 0 ? (
          <div className="text-sm text-muted">
            No technical submission is attached{assessment.state === "FINALIZED" ? " — this assessment was signed off without a GISA form." : " yet — the assignee creates it once the assessment is routed."}
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
                    {/* "Open", never "Review": the decision lives on the assessment now. */}
                    <td className="px-3 py-2.5 text-right"><Link to={`/submissions/${submissionId}`} className={status === "SUBMITTED" ? btnPrimary : btn}>Open</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Card
        title="Assignments"
        hint="Review authority follows the assessment's route, never an assignment."
        actions={showConsultedManagement ? (
          consultedOpen ? (
            <>
              <select className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-xs" value={consultedId} onChange={(event) => setConsultedId(event.target.value)}>
                <option value="">Add for information…</option>
                {availableConsulted.map((option) => <option key={option.id} value={option.id}>{option.full_name}</option>)}
              </select>
              <button type="button" disabled={busy || !consultedId} className={btn} onClick={() => run(() => addAssignment(assessment.id, { user_id: Number(consultedId), assignment_role: "CONSULTED", notes: notes.trim() || undefined }))}>Add</button>
              <button type="button" disabled={busy} className={btn} onClick={() => { setConsultedOpen(false); setConsultedId(""); }}>Cancel</button>
            </>
          ) : (
            <button type="button" disabled={busy} className={btn} onClick={() => setConsultedOpen(true)}>Add for information</button>
          )
        ) : null}
      >
        {assignments.length === 0 ? <div className="text-sm text-muted">No active assignments yet.</div> : (
          <div className="grid gap-2">
            {assignments.map((assignment) => {
              const historical = isHistoricalAssignment(assignment.assignment_role);
              return (
                <div key={assignment.id} className={`flex flex-wrap items-center justify-between gap-2.5 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3 ${historical ? "opacity-60" : ""}`}>
                  <div>
                    <div className={`text-sm font-semibold ${historical ? "text-muted" : ""}`}>{assignment.full_name}</div>
                    <div className="mt-0.5 text-xs text-muted">
                      {historical ? "Former reviewer — no approval authority" : humanizeCode(assignment.assignment_role)} · {assignment.email}
                    </div>
                  </div>
                  {assignment.assignment_role === "CONSULTED" && showConsultedManagement ? (
                    <button type="button" disabled={busy} className={`${btn} text-[var(--bad)]`} onClick={() => run(() => removeAssignment(assessment.id, assignment.id))}>Remove</button>
                  ) : null}
                </div>
              );
            })}
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
        <AssessmentStateBadge state={assessment.state} routingPath={assessment.routing_path} mini />
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

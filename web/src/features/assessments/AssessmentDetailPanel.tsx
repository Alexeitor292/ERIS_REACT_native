import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";

import {
  addAssignment,
  assessmentAssignmentOptions,
  assignEngineer,
  assignSeniorEngineer,
  branchOptions,
  createAssessmentSubmission,
  delegateBranch,
  removeAssignment,
  reviewAssessment,
  seniorEngineerOptions,
  submitAssessment,
  type AssessmentDetail,
  type AssignmentUserOption,
  type PickerGroup,
  type RoutingPath,
  type RoutingUserOption,
} from "../../api/assessments";
import { api } from "../../api/client";
import { loadOfficeDirectory } from "../../api/org";
import type { Incident, Submission } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { SubmissionStatusBadge } from "../submissions/SubmissionDetailPrimitives";
import { buildSubmissionDisplayTitle } from "../../utils/submissionLabel";
import { canAssignEngineer, canDelegateBranch, isAdmin, isSeniorSpecialist, isStaff } from "../../utils/roleModel";
import PersonPicker from "./PersonPicker";
import { branchLabelOf, isOutOfBranchChoice, placeLabel, selectedPerson, buildPickerSections } from "./personPickerModel";
import {
  assessmentBranchName,
  assessmentEventLabel,
  assessmentOfficeName,
  assessmentPermissions,
  assessmentStateLabel,
  assessmentStateLabelFor,
  assessmentTone,
  assignmentRoleLabel,
  humanizeCode,
  isActionable,
  stepOwnership,
  workActionLabel,
  latestSubmissionId,
  officeLabel,
  pipelineFor,
  pipelineIndex,
  submissionIdsOf,
  waitingOn,
  type OfficeNameLookup,
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

/**
 * The org label directory: office names for records routed before the snapshot
 * columns existed, and which branches have since been retired.
 *
 * A record WITH a snapshot never takes its name from here — the name frozen
 * onto the assessment is the historical truth, and a later rename must not
 * rewrite it. The directory answers the other question: whether the branch that
 * name refers to still exists, so the record can say "Branch C · Retired"
 * rather than pretending (org model design §3.5, §8).
 */
export function useOrgLabels(): { officeNames: OfficeNameLookup; isRetiredBranch: (branchId: number | null | undefined) => boolean } {
  const [names, setNames] = useState<Map<string, string>>(() => new Map());
  const [retiredBranches, setRetiredBranches] = useState<Set<number>>(() => new Set());
  useEffect(() => {
    let cancelled = false;
    loadOfficeDirectory()
      .then((directory) => {
        if (cancelled) return;
        const offices = [...directory.values()];
        setNames(new Map(offices.map((office) => [office.code, office.name || office.code])));
        setRetiredBranches(new Set(
          offices.flatMap((office) => (office.branches ?? []).filter((branch) => !branch.is_active).map((branch) => branch.id)),
        ));
      })
      .catch(() => {
        // Labels only: without them a legacy record shows its office CODE,
        // which is honest, so this failure is not worth an error banner.
      });
    return () => { cancelled = true; };
  }, []);
  const officeNames = useCallback<OfficeNameLookup>((code) => (code ? names.get(code) ?? null : null), [names]);
  const isRetiredBranch = useCallback(
    (branchId: number | null | undefined) => branchId != null && retiredBranches.has(branchId),
    [retiredBranches],
  );
  return { officeNames, isRetiredBranch };
}

/** "Retired" beside a name that is still correct history. */
function RetiredBadge() {
  return (
    <span className="ml-1 rounded-full border border-[var(--line)] bg-[var(--panel-soft)] px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-muted">
      Retired
    </span>
  );
}

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

/** The ladder this assessment actually walks — branch, Senior Specialist, or not yet routed. */
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

/** The office chief's two mutually exclusive choices, with what each one costs them. */
const ROUTE_CHOICES: Array<{ value: RoutingPath; label: string; consequence: string }> = [
  {
    value: "BRANCH",
    label: "Hand off to a branch chief",
    consequence: "The branch chief assigns a Staff member and approves the finished assessment. You are done with this case.",
  },
  {
    value: "SENIOR_ENGINEER",
    label: "Assign a Senior Specialist",
    consequence: "The Senior Specialist fills the assessment and returns it to you for approval.",
  },
];

/** Retired assignment roles: kept as history, never as authority. */
function isHistoricalAssignment(role: string): boolean {
  return role === "REVIEWER" || role === "APPROVER";
}

/** A shared empty payload, so an unfetched picker and a fetched-empty one are the same shape. */
const EMPTY_OPTIONS = { groups: [] as PickerGroup[], items: [] as never[] };

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
      engineer: isStaff(roles),
      seniorEngineer: isSeniorSpecialist(roles),
    }),
    [roles],
  );
  // The caller's office resolves the way the server resolves it: the org record
  // first, the legacy `metadata` mirror second. A chief whose profile moved but
  // whose mirror did not — or the reverse, during the cutover release — must not
  // lose their review affordance (org model design §3.2, §13.3).
  const callerOffice = me?.org?.office_code ?? me?.metadata?.office_code;
  const permissions = useMemo(
    () => assessmentPermissions(flags, me?.id, callerOffice, assessment),
    [assessment, callerOffice, flags, me?.id],
  );
  const actionable = isActionable(permissions);
  const ownership = stepOwnership(flags, me?.id, callerOffice, assessment);
  const stepInRole = flags.admin ? "an administrator" : flags.officeChief ? "office chief" : flags.branchChief ? "branch chief" : "your role";
  const submissionIds = submissionIdsOf(assessment);
  const latestId = latestSubmissionId(assessment);

  const [context, setContext] = useState<IncidentContext>({ incident: null, eventGroupId: null });
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState("");
  const [branchList, setBranchList] = useState<{ groups: PickerGroup[]; items: RoutingUserOption[] }>(EMPTY_OPTIONS);
  const [seniorEngineerList, setSeniorEngineerList] = useState<{ groups: PickerGroup[]; items: RoutingUserOption[] }>(EMPTY_OPTIONS);
  const [engineerOptions, setEngineerOptions] = useState<{ groups: PickerGroup[]; items: AssignmentUserOption[] }>(EMPTY_OPTIONS);
  const [consultedOptions, setConsultedOptions] = useState<AssignmentUserOption[]>([]);
  const [routeChoice, setRouteChoice] = useState<RoutingPath | null>(null);
  const [consultedOpen, setConsultedOpen] = useState(false);
  // `null` until a human chooses — for all three pickers, under every data
  // shape, including a list with exactly one candidate (owner decision 7).
  const [branchChiefId, setBranchChiefId] = useState<number | null>(null);
  const [seniorEngineerId, setSeniorEngineerId] = useState<number | null>(null);
  const [engineerId, setEngineerId] = useState<number | null>(null);
  const [consultedId, setConsultedId] = useState("");
  const [routingOptionsLoading, setRoutingOptionsLoading] = useState(false);

  const resetPickers = () => {
    setBranchChiefId(null); setSeniorEngineerId(null); setEngineerId(null); setConsultedId("");
  };

  // The three details that keep the no-preselect contract true: an empty initial
  // value, a primary disabled until a choice, and a reset on every change of
  // assessment, state or route.
  useEffect(() => {
    setNotes(""); setRouteChoice(null); setConsultedOpen(false);
    setBranchChiefId(null); setSeniorEngineerId(null); setEngineerId(null); setConsultedId("");
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

  const showRouting = mode === "work" && (permissions.delegate || permissions.assignSeniorEngineer);
  const showAssignEngineer = mode === "work" && permissions.assignEngineer;
  const showConsultedManagement = mode === "work" && permissions.manageConsulted;

  // The route choice precedes the picker, so exactly one routing option list is
  // ever fetched — with the Staff list that is at most two per state.
  const routeOptions = useMemo(
    () => ROUTE_CHOICES.filter((choice) => (choice.value === "BRANCH" ? permissions.delegate : permissions.assignSeniorEngineer)),
    [permissions.assignSeniorEngineer, permissions.delegate],
  );
  const activeRoute: RoutingPath | null = showRouting
    ? (routeChoice && routeOptions.some((choice) => choice.value === routeChoice)
      ? routeChoice
      : routeOptions.length === 1 ? routeOptions[0].value : null)
    : null;

  useEffect(() => {
    let cancelled = false;
    const requests: Array<Promise<void>> = [];
    setRoutingOptionsLoading(activeRoute != null);
    if (activeRoute === "BRANCH") {
      requests.push(branchOptions(assessment.id).then((response) => {
        if (!cancelled) setBranchList({ groups: response.groups ?? [], items: response.items ?? [] });
      }));
    } else setBranchList(EMPTY_OPTIONS);
    if (activeRoute === "SENIOR_ENGINEER") {
      requests.push(seniorEngineerOptions(assessment.id).then((response) => {
        if (!cancelled) setSeniorEngineerList({ groups: response.groups ?? [], items: response.items ?? [] });
      }));
    } else setSeniorEngineerList(EMPTY_OPTIONS);
    if (showAssignEngineer) {
      requests.push(assessmentAssignmentOptions(assessment.id, "ENGINEER").then((response) => {
        if (!cancelled) setEngineerOptions({ groups: response.groups ?? [], items: response.items ?? [] });
      }));
    } else setEngineerOptions(EMPTY_OPTIONS);
    Promise.all(requests)
      .catch((error) => { if (!cancelled) onError(error instanceof Error ? error.message : "Failed to load assignment options."); })
      .finally(() => { if (!cancelled) setRoutingOptionsLoading(false); });
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
  const { officeNames, isRetiredBranch } = useOrgLabels();
  const officeName = assessmentOfficeName(assessment, officeNames);
  const branchName = assessmentBranchName(assessment);
  const branchRetired = isRetiredBranch(assessment.routed_branch_id);
  // The office in "an office chief of … reviews this" comes from the snapshot,
  // and from the live directory only for a record routed before it existed.
  const next = waitingOn(assessment, assignments, officeNames);
  // A Staff member from another branch is allowed WITH a recorded reason, and
  // refused without one — so the warning appears before the refusal, not after.
  const chosenStaff = selectedPerson(buildPickerSections(engineerOptions.groups, engineerOptions.items), engineerId);
  const staffOutOfBranch = isOutOfBranchChoice(chosenStaff, assessment.routed_branch_id);
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
            {/* Office and branch by NAME, from the routing snapshot: a rename or a
                retired branch must not rewrite what this record says (design §3.5). */}
            <div className="mt-1 text-[13px] text-muted">
              {officeName}
              {branchName ? <> · {branchName}{branchRetired ? <RetiredBadge /> : null}</> : null}
              {" · "}District {assessment.district ?? "—"} · Updated {formatTimestamp(assessment.updated_at)}
            </div>
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
          id="assessment-next-step"
          tabIndex={-1}
          className="rounded-xl border p-4 outline-none"
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
            ownership === "NONE" ? (
              <p className="mt-2.5 text-[13px] text-muted">Actions for this step are performed from My Work by the responsible role.</p>
            ) : (
              // The buttons go to the action itself: the form to fill out, or
              // this assessment opened in My Work with its step in view.
              <div className="mt-3 grid gap-2">
                <p className="text-[13px]">
                  {ownership === "MINE"
                    ? <b>This step is yours.</b>
                    : <>This step isn&rsquo;t yours. As {stepInRole} you can also act on it.</>}
                </p>
                <div className="flex flex-wrap gap-2">
                  {permissions.submit && latestId != null ? (
                    <Link to={`/submissions/${latestId}`} className={btnPrimary}>Fill out submission #{latestId}</Link>
                  ) : null}
                  <Link to={`/my-work?assessment=${assessment.id}`} className={permissions.submit && latestId != null ? btn : btnPrimary}>
                    {workActionLabel(assessment.state, permissions, submissionIds.length > 0)} in My Work
                  </Link>
                </div>
              </div>
            )
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
                          <PersonPicker
                            label="Branch chief"
                            placeholder="Select branch chief…"
                            groups={branchList.groups}
                            items={branchList.items}
                            value={branchChiefId}
                            onChange={setBranchChiefId}
                            emptyMessage={routingOptionsLoading ? "Loading branch chiefs…" : "No branch chief is recorded for this office yet. Place one in this office's tree under Organization."}
                          />
                          <button type="button" disabled={busy || branchChiefId == null} className={btnPrimary} onClick={() => run(() => delegateBranch(assessment.id, Number(branchChiefId), notes.trim() || undefined))}>
                            {assessment.routing_path === "BRANCH" ? "Hand to this branch chief" : "Hand off"}
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center gap-2">
                          <PersonPicker
                            label="Senior Specialist"
                            placeholder="Select Senior Specialist…"
                            groups={seniorEngineerList.groups}
                            items={seniorEngineerList.items}
                            value={seniorEngineerId}
                            onChange={setSeniorEngineerId}
                            emptyMessage={routingOptionsLoading ? "Loading Senior Specialists…" : "No Senior Specialist is recorded for this office yet. Place one in this office's tree under Organization."}
                          />
                          <button type="button" disabled={busy || seniorEngineerId == null} className={btnPrimary} onClick={() => run(() => assignSeniorEngineer(assessment.id, Number(seniorEngineerId), notes.trim() || undefined))}>Assign Senior Specialist</button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ) : null}

              <textarea
                rows={2}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder={staffOutOfBranch ? "Required: why this Staff member, from another branch" : "Optional workflow notes"}
                className="w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm"
              />
              {showAssignEngineer && staffOutOfBranch ? (
                <p className="text-[13px] text-[var(--bad)]">
                  {chosenStaff?.full_name} is in {branchLabelOf(chosenStaff) ?? "another branch"}
                  {placeLabel(chosenStaff?.home_city, chosenStaff?.home_district) ? ` (${placeLabel(chosenStaff?.home_city, chosenStaff?.home_district)})` : ""}
                  , not {branchName ?? "this branch"}. Record why in the notes above to assign them anyway.
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                {showAssignEngineer ? (
                  <>
                    {/* "Your branch" first, then the rest of the office — the ordering
                        is the server's, and no candidate is ever chosen for the chief. */}
                    <PersonPicker
                      label="Staff member"
                      placeholder="Select Staff member…"
                      groups={engineerOptions.groups}
                      items={engineerOptions.items}
                      value={engineerId}
                      onChange={setEngineerId}
                      emptyMessage="No Staff account is recorded in this office yet."
                    />
                    <button
                      type="button"
                      disabled={busy || engineerId == null || (staffOutOfBranch && !notes.trim())}
                      className={btnPrimary}
                      onClick={() => run(() => assignEngineer(assessment.id, Number(engineerId), notes.trim() || undefined))}
                    >
                      Assign Staff member
                    </button>
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
        hint={
          <>
            {officeName}{branchName ? <> · {branchName}{branchRetired ? <RetiredBadge /> : null}</> : null}
            {" · "}Review authority follows the assessment&apos;s route, never an assignment.
          </>
        }
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
                      {historical ? "Former reviewer — no approval authority" : assignmentRoleLabel(assignment.assignment_role)} · {assignment.email}
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
                  <div><div className="font-semibold">{assessmentEventLabel(event.event_type)}{event.disposition ? ` · ${humanizeCode(event.disposition)}` : ""}</div><div className="mt-0.5 text-xs text-muted">by {event.actor_name || event.actor_email || `User #${event.actor_user_id}`}</div></div>
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
        <div>
          <div className="font-semibold">Assessment #{assessment.id}</div>
          {/* The office and branch NAME from the routing snapshot, not the code:
              a rail full of "Office WEST" tells a reader nothing they can use. */}
          <div className="mt-0.5 text-xs text-muted">
            Incident #{assessment.incident_id} · {assessmentOfficeName(assessment)}
            {assessmentBranchName(assessment) ? ` · ${assessmentBranchName(assessment)}` : ""}
            {" · "}D{assessment.district ?? "—"}
          </div>
        </div>
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

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
import SubmitConfirmDialog from "../submissions/SubmitConfirmDialog";
import { buildSubmissionDisplayTitle } from "../../utils/submissionLabel";
import { canAssignEngineer, canDelegateBranch, isAdmin, isSeniorSpecialist, isStaff } from "../../utils/roleModel";
import PersonPicker from "./PersonPicker";
import { branchLabelOf, isOutOfBranchChoice, placeLabel, selectedPerson, buildPickerSections } from "./personPickerModel";
import {
  assessmentBranchName,
  assessmentPermissions,
  assessmentPlace,
  assessmentStateLabelFor,
  assessmentTone,
  assignmentRoleLabel,
  eventTitle,
  isActionable,
  nextStepLine,
  reviewerName,
  waitingWho,
  withoutTrailingDate,
  stepOwnership,
  workActionLabel,
  latestSubmissionId,
  officeLabel,
  pipelineFor,
  pipelineIndex,
  submissionIdsOf,
  type OfficeNameLookup,
  type Tone,
} from "./assessmentModel";

const shortDateFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function shortDate(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : shortDateFormatter.format(parsed);
}

/** Where a form is, as a headline: "07-LA-002-38.00". Null when it has no location yet. */
function formLocation(submission: Submission | undefined): string | null {
  if (!submission) return null;
  const title = buildSubmissionDisplayTitle({
    id: submission.id, district: submission.district, county: submission.county, route: submission.route, post_mile: submission.post_mile,
  });
  return title.includes("?") ? null : title;
}

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

function Card({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] px-5 py-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <h3 className="text-[15px] font-bold">{title}</h3>
        {actions ? <div className="ml-auto flex flex-wrap items-center gap-1.5">{actions}</div> : null}
      </div>
      <div className="mt-2.5">{children}</div>
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
  const [confirmingSubmit, setConfirmingSubmit] = useState(false);
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
  // Once someone has the assessment, changing who has it is a deliberate second
  // step, not the form that greets whoever opens it (a stale notice, say).
  const [changingHolder, setChangingHolder] = useState(false);
  const [changingStaff, setChangingStaff] = useState(false);

  const resetPickers = () => {
    setBranchChiefId(null); setSeniorEngineerId(null); setEngineerId(null); setConsultedId("");
  };

  // The three details that keep the no-preselect contract true: an empty initial
  // value, a primary disabled until a choice, and a reset on every change of
  // assessment, state or route.
  useEffect(() => {
    setNotes(""); setRouteChoice(null); setConsultedOpen(false);
    setBranchChiefId(null); setSeniorEngineerId(null); setEngineerId(null); setConsultedId("");
    setChangingHolder(false); setChangingStaff(false);
  }, [assessment.id, assessment.state, assessment.routing_path, assessment.branch_chief_user_id, assessment.assigned_engineer_user_id]);

  // Incident title / Incident Group for cross-links (incident payload carries event_group_id).
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
  // Who has it now, on the route it took; they are left out of the pickers.
  const routed = assessment.routing_path != null && assessment.state !== "PENDING_OFFICE_DELEGATION";
  const holder = assessment.routing_path === "BRANCH"
    ? { id: assessment.branch_chief_user_id, name: assessment.branch_chief_name, role: "branch chief" }
    : { id: assessment.assigned_engineer_user_id, name: assessment.assigned_user_name, role: "Senior Specialist" };
  const staffHolder = assessment.routing_path === "BRANCH" && assessment.assigned_engineer_user_id != null
    ? { id: assessment.assigned_engineer_user_id, name: assessment.assigned_user_name }
    : null;
  const notHolder = <T extends { id: number }>(items: T[], id: number | null | undefined) => (id == null ? items : items.filter((item) => item.id !== id));
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
  const branchName = assessmentBranchName(assessment);
  const branchRetired = isRetiredBranch(assessment.routed_branch_id);
  const nextLine = nextStepLine(assessment, latestId);
  // A Staff member from another branch is allowed WITH a recorded reason, and
  // refused without one — so the warning appears before the refusal, not after.
  const chosenStaff = selectedPerson(buildPickerSections(engineerOptions.groups, engineerOptions.items), engineerId);
  const staffOutOfBranch = isOutOfBranchChoice(chosenStaff, assessment.routed_branch_id);
  const latestForm = latestId != null ? submissionsById.get(latestId) : undefined;
  const headline = (context.incident?.title ? withoutTrailingDate(context.incident.title) : null)
    ?? formLocation(latestForm)
    ?? `Incident #${assessment.incident_id}`;
  const author = assignments.find((assignment) => assignment.assignment_role === "ENGINEER" || assignment.assignment_role === "SENIOR_ENGINEER");
  const assignedName = assessment.assigned_user_name || author?.full_name || null;
  const reviewer = reviewerName(assessment);
  const others = assignments.filter((assignment) => assignment !== author);
  const approver = [...events].reverse().find((event) => event.event_type === "APPROVED");
  const approverName = approver?.actor_name || approver?.actor_email || null;

  return (
    <div className="grid gap-3.5">
      <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-muted">Assessment #{assessment.id}</div>
            <h2 className="mt-0.5 text-2xl font-bold leading-tight">{headline}</h2>
            {/* Office and branch by NAME, from the routing snapshot: a rename or a
                retired branch must not rewrite what this record says (design §3.5). */}
            <div className="mt-1 text-[13px] text-muted">
              {assessmentPlace(assessment, officeNames)}
              {branchName && branchRetired ? <RetiredBadge /> : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3.5 pt-1 text-[13px] font-semibold">
            <Link to={`/incidents/${assessment.incident_id}`} className="text-[var(--brand-ink)] hover:underline">Incident #{assessment.incident_id}</Link>
            {context.eventGroupId != null ? <Link to={`/mission-center/${context.eventGroupId}/${assessment.incident_id}`} className="text-[var(--brand-ink)] hover:underline">Map</Link> : null}
            {context.eventGroupId != null ? <Link to={`/incident-groups/${context.eventGroupId}`} className="text-[var(--brand-ink)] hover:underline">Group #{context.eventGroupId}</Link> : null}
          </div>
        </div>
        <Pipeline assessment={assessment} />
        {assessment.office_override_reason ? <div className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3 text-[13px]"><b>Routing override:</b> {assessment.office_override_reason}</div> : null}
      </section>

      {!nextLine ? (
        <div className="rounded-xl border border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] px-4 py-3 text-sm text-[var(--good)]">
          {assessment.state === "APPROVED" ? (
            <><b>Complete.</b> Approved {formatTimestamp(assessment.approved_at)}{approverName ? ` by ${approverName}` : ""}.</>
          ) : (
            <><b>Signed off</b> {formatTimestamp(assessment.finalized_at)}.</>
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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-xs font-bold" style={{ color: revision ? "var(--bad)" : "var(--brand-ink)" }}>{revision ? "Changes requested" : "Next step"}</h3>
              <div className="mt-0.5 text-base font-semibold">{nextLine}</div>
            </div>
            {/* The buttons go to the action itself: the form to fill out, or this
                assessment opened in My Work with its step in view. Nothing for
                someone with no part in this step. */}
            {mode === "record" && ownership !== "NONE" ? (
              <div className="flex flex-wrap gap-2">
                {permissions.submit && latestId != null ? <Link to={`/submissions/${latestId}`} className={btnPrimary}>Open form</Link> : null}
                <Link to={`/my-work?assessment=${assessment.id}`} className={permissions.submit && latestId != null ? btn : btnPrimary}>
                  {workActionLabel(assessment.state, permissions, submissionIds.length > 0)}
                </Link>
              </div>
            ) : null}
          </div>

          {mode === "record" || !actionable ? null : (
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

              {showRouting && routed && !changingHolder ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Who has this assessment</div>
                    <p className="mt-0.5 text-[13px]">
                      {assessment.routing_path === "BRANCH" ? "Handed to " : "Assigned to "}
                      <b>{holder.name ?? `the ${holder.role}`}</b>
                      {assessment.routing_path === "BRANCH" && assessment.office_delegated_at ? ` · ${new Date(assessment.office_delegated_at).toLocaleString()}` : ""}
                      . Nothing more is needed from you unless that has to change.
                    </p>
                  </div>
                  <button type="button" className={btn} onClick={() => setChangingHolder(true)}>
                    {assessment.routing_path === "BRANCH" ? "Change branch chief" : "Change Senior Specialist"}
                  </button>
                </div>
              ) : null}

              {showRouting && (!routed || changingHolder) ? (
                <div className="grid gap-2.5 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                      {!routed ? "Route this assessment" : `Hand it to another ${holder.role}`}
                    </div>
                    {routed ? <button type="button" className="text-xs font-medium text-[var(--brand)] hover:underline" onClick={() => setChangingHolder(false)}>Cancel</button> : null}
                  </div>
                  <div className={`flex flex-wrap gap-1.5 ${routed ? "hidden" : ""}`} role="group" aria-label="Routing choice">
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
                            items={routed ? notHolder(branchList.items, holder.id) : branchList.items}
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
                            items={routed ? notHolder(seniorEngineerList.items, holder.id) : seniorEngineerList.items}
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
                {showAssignEngineer && staffHolder && !changingStaff ? (
                  <span className="inline-flex flex-wrap items-center gap-2 text-[13px]">
                    Assigned to <b>{staffHolder.name ?? "a Staff member"}</b>.
                    <button type="button" className={btn} onClick={() => setChangingStaff(true)}>Change Staff member</button>
                  </span>
                ) : null}
                {showAssignEngineer && (!staffHolder || changingStaff) ? (
                  <>
                    {/* "Your branch" first, then the rest of the office — the ordering
                        is the server's, and no candidate is ever chosen for the chief. */}
                    <PersonPicker
                      label="Staff member"
                      placeholder="Select Staff member…"
                      groups={engineerOptions.groups}
                      items={notHolder(engineerOptions.items, staffHolder?.id)}
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
                      {staffHolder ? "Assign instead" : "Assign Staff member"}
                    </button>
                    {staffHolder ? <button type="button" className="text-xs font-medium text-[var(--brand)] hover:underline" onClick={() => setChangingStaff(false)}>Cancel</button> : null}
                  </>
                ) : null}
                {permissions.submit ? (
                  <button type="button" disabled={busy || submissionIds.length === 0} className={btnPrimary} onClick={() => setConfirmingSubmit(true)}>Submit for review</button>
                ) : null}
                {confirmingSubmit ? (
                  <SubmitConfirmDialog
                    busy={busy}
                    onClose={() => setConfirmingSubmit(false)}
                    onConfirm={() => {
                      setConfirmingSubmit(false);
                      run(() => submitAssessment(assessment.id, notes.trim() || undefined));
                    }}
                  />
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

      <div className="grid items-start gap-3.5 sm:grid-cols-2">
        <Card title="Forms">
          {submissionIds.length === 0 ? (
            <div className="text-sm text-muted">None yet</div>
          ) : (
            <ul className="grid gap-2.5">
              {submissionIds.map((submissionId) => {
                const submission = submissionsById.get(submissionId);
                const started = shortDate(submission?.created_at);
                const sent = shortDate(submission?.submitted_at);
                return (
                  <li key={submissionId} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0">
                      <Link to={`/submissions/${submissionId}`} className="text-sm font-semibold text-[var(--brand-ink)] hover:underline">Form #{submissionId}</Link>
                      <span className="block text-xs text-muted">
                        {[started ? `Started ${started}` : null, sent ? `Sent ${sent}` : null].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    {submission?.status ? <SubmissionStatusBadge status={submission.status} /> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card
          title="People"
          actions={showConsultedManagement ? (
            consultedOpen ? (
              <>
                <select aria-label="Person to add" className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-xs" value={consultedId} onChange={(event) => setConsultedId(event.target.value)}>
                  <option value="">Add for information…</option>
                  {availableConsulted.map((option) => <option key={option.id} value={option.id}>{option.full_name}</option>)}
                </select>
                <button type="button" disabled={busy || !consultedId} className={btn} onClick={() => run(() => addAssignment(assessment.id, { user_id: Number(consultedId), assignment_role: "CONSULTED", notes: notes.trim() || undefined }))}>Add</button>
                <button type="button" disabled={busy} className={btn} onClick={() => { setConsultedOpen(false); setConsultedId(""); }}>Cancel</button>
              </>
            ) : (
              <button type="button" disabled={busy} className={btn} onClick={() => setConsultedOpen(true)}>Add</button>
            )
          ) : null}
        >
          <dl className="grid grid-cols-[84px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-2 text-[13px]">
            {assignedName ? <><dt className="text-muted">Assigned</dt><dd className="font-semibold">{assignedName}</dd></> : null}
            {reviewer ? <><dt className="text-muted">Reviewer</dt><dd className="font-semibold">{reviewer}</dd></> : null}
            {others.map((assignment) => (
              <div key={assignment.id} className="contents">
                <dt className="text-muted">{isHistoricalAssignment(assignment.assignment_role) ? "Former" : assignmentRoleLabel(assignment.assignment_role)}</dt>
                <dd className={`flex items-center justify-between gap-2 ${isHistoricalAssignment(assignment.assignment_role) ? "text-muted" : "font-semibold"}`}>
                  {assignment.full_name}
                  {assignment.assignment_role === "CONSULTED" && showConsultedManagement ? (
                    <button type="button" disabled={busy} className={`${btn} text-[var(--bad)]`} onClick={() => run(() => removeAssignment(assessment.id, assignment.id))}>Remove</button>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
          {!assignedName && !reviewer && others.length === 0 ? <div className="text-sm text-muted">Nobody yet</div> : null}
        </Card>
      </div>

      <Card title="History">
        {events.length === 0 ? <div className="text-sm text-muted">Nothing yet</div> : (
          <ul className="divide-y divide-[var(--line)]">
            {[...events].reverse().map((event) => (
              <li key={event.id} className="py-2.5 text-[13px] first:pt-0 last:pb-0">
                <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5">
                  <span>
                    <b className="font-semibold">{eventTitle(event)}</b>
                    {event.actor_name || event.actor_email ? <span className="text-muted"> by {event.actor_name || event.actor_email}</span> : null}
                  </span>
                  <span className="text-xs text-muted">{formatTimestamp(event.created_at)}</span>
                </div>
                {event.notes ? <div className="mt-0.5 text-muted">“{event.notes}”</div> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** Rail entry shared by My Work and the Assessments record view. */
export function AssessmentRailCard({
  assessment,
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
  const { officeNames } = useOrgLabels();
  const who = waitingWho(assessment);
  const form = submissionsById.get(latestSubmissionId(assessment) ?? -1);
  const inner = (
    <>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 truncate text-sm font-semibold">{formLocation(form) ?? `Incident #${assessment.incident_id}`}</div>
        <AssessmentStateBadge state={assessment.state} routingPath={assessment.routing_path} mini />
      </div>
      <div className="mt-1 text-[13px] text-muted">{assessmentPlace(assessment, officeNames)}</div>
      {who ? <div className="mt-0.5 text-[13px]"><span className="text-muted">Waiting on </span><b className="font-semibold">{who}</b></div> : null}
    </>
  );
  const className = `block w-full rounded-lg border p-3 text-left text-[var(--ink)] ${active ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_7%,var(--panel))]" : "border-[var(--line)] bg-[var(--panel)] hover:border-[color:color-mix(in_oklab,var(--brand)_45%,var(--line))] hover:bg-[var(--panel-soft)]"}`;
  if (to) return <Link ref={refCallback as any} to={to} className={className}>{inner}</Link>;
  return <button ref={refCallback as any} type="button" onClick={onClick} className={className}>{inner}</button>;
}

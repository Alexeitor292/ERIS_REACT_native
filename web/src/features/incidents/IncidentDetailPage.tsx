import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { getAssessmentForIncident, type AssessmentDetail } from "../../api/assessments";
import { api } from "../../api/client";
import type { Incident } from "../../api/types";
import { getWorkflowTree, type WorkflowTree } from "../../api/workflowTree";
import { useAuth } from "../../auth/AuthContext";
import { WorkflowTreeView } from "../../components/WorkflowTree";
import AppShell from "../../ui/AppShell";
import { formatCoordinate } from "../../utils/precision";
import { canTriage, isMaintenanceOnly, isOperationalUser, isPublicOnly } from "../../utils/roleModel";
import { AssessmentStateBadge } from "../assessments/AssessmentDetailPanel";
import {
  assessmentEventLabel,
  assessmentOrgLine,
  assessmentStateLabel,
  assignmentRoleLabel,
  isTerminalState,
  submissionIdsOf,
  waitingOn,
} from "../assessments/assessmentModel";
import type { EventGroupDetailResponse } from "../eventGroups/eventGroupTypes";
import { eventGroupLocationLabel } from "../eventGroups/eventGroupTypes";
import { IncidentTriageDialog } from "./IncidentDecisionDialogs";
import {
  EvidenceGallery,
  Fact,
  LocationFacts,
  Panel,
  ReportFacts,
  RoadInventoryFacts,
  evidenceHint,
  formatWhen,
  useIncidentEvidence,
} from "./IncidentReportParts";
import {
  dispositionLabel,
  dispositionMeaning,
  incidentNumberLabel,
  isAwaitingTriage,
  isClosedAtTriage,
  isWaitingOnReporter,
  revisionRequest,
  workflowPositionLabel,
  workflowPositionTone,
  type Tone,
} from "./incidentDetailModel";

const btn = "rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50";
const link = "font-medium text-[var(--brand)] hover:underline";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "border-[var(--line)] bg-[var(--panel-soft)] text-muted",
  active: "border-[color:color-mix(in_oklab,var(--brand)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_10%,transparent)] text-[var(--brand)]",
  attention: "border-[color:color-mix(in_oklab,var(--warn)_55%,transparent)] bg-[color:color-mix(in_oklab,var(--warn)_12%,transparent)] text-[var(--warn-text)]",
  done: "border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] text-[var(--good)]",
};

/** The assessment behind the incident: loaded, none opened, or not readable. */
type AssessmentLoad =
  | { kind: "hidden" }
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "failed" }
  | { kind: "loaded"; detail: AssessmentDetail };

/**
 * The incident record: one page with everything ERIS holds about a report —
 * what the field worker filed and the evidence they attached, where it is and
 * what road it is on, what the coordinator decided, the Incident Group it joined,
 * the GeoTech assessment behind it, and where it stands now.
 *
 * Before this page, `/incidents/:id` only highlighted a row in the Incidents
 * table, so no screen in ERIS showed an incident's full data. The report and
 * evidence sections are the same components the coordinator's triage review
 * renders, so a report reads the same in both places.
 *
 * What each reader sees follows the server: the reporter reads their own report
 * without the assessment, a viewer reads approved records only (anything else
 * is a 404), and triage is offered only to a coordinator while the report is
 * waiting for one.
 */
export default function IncidentDetailPage() {
  const params = useParams();
  const incidentId = Number(params.id);
  const validId = Number.isInteger(incidentId) && incidentId > 0;
  const { me } = useAuth();
  const roles = me?.roles;
  const operational = isOperationalUser(roles);
  const viewer = isPublicOnly(roles);
  const maintenanceOnly = isMaintenanceOnly(roles);

  const [incident, setIncident] = useState<Incident | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [assessment, setAssessment] = useState<AssessmentLoad>({ kind: "loading" });
  const [tree, setTree] = useState<WorkflowTree | null>(null);
  const [eventGroupTitle, setEventGroupTitle] = useState<string | null>(null);
  const [triageOpen, setTriageOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const evidence = useIncidentEvidence(validId ? incidentId : null);

  useEffect(() => {
    if (!validId) {
      setError("This is not a valid incident number.");
      return;
    }
    let cancelled = false;
    setBusy(true);
    setError(null);
    api<{ incident: Incident }>(`/incidents/${incidentId}`)
      .then((detail) => { if (!cancelled) setIncident(detail.incident); })
      .catch((e: unknown) => {
        if (cancelled) return;
        setIncident(null);
        const message = e instanceof Error ? e.message : "";
        setError(/not found/i.test(message)
          ? viewer
            ? "This incident could not be found. It may not exist, or it may not be part of the approved record yet."
            : "This incident could not be found. Check the number, or open it from the Incidents list."
          : message || "The incident could not be loaded.");
      })
      .finally(() => { if (!cancelled) setBusy(false); });

    // Each of these is supplementary: a failure hides its own section and never
    // the report itself.
    getWorkflowTree(incidentId)
      .then((next) => { if (!cancelled) setTree(next); })
      .catch(() => { if (!cancelled) setTree(null); });

    if (maintenanceOnly) {
      setAssessment({ kind: "hidden" });
    } else {
      setAssessment({ kind: "loading" });
      getAssessmentForIncident(incidentId)
        .then((detail) => { if (!cancelled) setAssessment({ kind: "loaded", detail }); })
        .catch((e: unknown) => {
          if (cancelled) return;
          const message = e instanceof Error ? e.message : "";
          setAssessment(/no assessment/i.test(message) ? { kind: "none" } : { kind: "failed" });
        });
    }
    return () => { cancelled = true; };
  }, [incidentId, validId, viewer, maintenanceOnly, reloadKey]);

  // The Incident Group record is operational-only on the server; nobody else asks.
  const eventGroupId = incident?.event_group_id ?? null;
  useEffect(() => {
    setEventGroupTitle(null);
    if (!operational || eventGroupId == null) return;
    let cancelled = false;
    api<EventGroupDetailResponse>(`/event-groups/${eventGroupId}`)
      .then((detail) => { if (!cancelled) setEventGroupTitle(detail.event_group?.title ?? null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [operational, eventGroupId]);

  const title = incident?.title?.trim() || (validId ? `Incident #${incidentId}` : "Incident");
  const offerTriage = Boolean(incident && canTriage(roles) && isAwaitingTriage(incident));
  const revision = incident ? revisionRequest(incident) : null;
  const resolved = incident ? String(incident.status).toUpperCase() === "RESOLVED" : false;

  return (
    <AppShell title={title}>
      <div className="grid gap-4 p-4 md:p-5">
        <div className="flex flex-wrap gap-2">
          <Link to="/incidents" className={btn}>← Incidents</Link>
          {incident && operational && incident.event_group_id != null ? (
            <Link to={`/mission-center/${incident.event_group_id}/${incident.id}`} className={btn}>View on map</Link>
          ) : null}
          <button type="button" onClick={() => setReloadKey((key) => key + 1)} disabled={busy || !validId} className={`${btn} ml-auto`}>{busy ? "Refreshing…" : "Refresh"}</button>
        </div>

        {error ? <div role="alert" className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}
        {notice ? <div role="status" className="rounded-md border border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] px-3 py-2 text-sm text-[var(--good)]">{notice}</div> : null}

        {!incident ? (
          error ? null : <div className="py-16 text-center text-sm text-muted">Loading the incident…</div>
        ) : (
          <>
            <header className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                {/* AppShell already prints the title as the page heading. */}
                <div className="min-w-0">
                  <div className="text-sm font-semibold tabular-nums">{incidentNumberLabel(incident, incident.id)}</div>
                  <div className="mt-1 text-[13px] text-muted tabular-nums">
                    {eventGroupLocationLabel(incident)} · {formatCoordinate(incident.latitude)}, {formatCoordinate(incident.longitude)} · Filed {formatWhen(incident.created_at)}{incident.reporter_name ? ` by ${incident.reporter_name}` : ""}
                  </div>
                </div>
                <span className={`inline-flex shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold ${TONE_CLASS[workflowPositionTone(incident)]}`}>
                  {workflowPositionLabel(incident)}
                </span>
              </div>

              {offerTriage ? (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[color:color-mix(in_oklab,var(--brand)_40%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_6%,var(--panel))] px-3 py-2.5">
                  <p className="min-w-0 text-sm">
                    <b>This report is waiting for your review.</b> Read it and its evidence, then decide what happens to it.
                  </p>
                  <button
                    type="button"
                    onClick={() => { setNotice(null); setTriageOpen(true); }}
                    className="rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-semibold text-white hover:brightness-95"
                  >
                    Review this report
                  </button>
                </div>
              ) : null}

              {revision ? (
                <div className="mt-4 rounded-lg border border-[color:color-mix(in_oklab,var(--warn)_55%,transparent)] bg-[color:color-mix(in_oklab,var(--warn)_10%,var(--panel))] px-3 py-2.5 text-sm">
                  <b className="text-[var(--warn-text)]">Sent back to the reporter for changes.</b>{" "}
                  {revision.fields.length ? <>Asked to correct: {revision.fields.join(", ")}.</> : "No specific fields were named."}
                  {revision.comment ? <p className="mt-1 whitespace-pre-wrap text-muted">“{revision.comment}”</p> : null}
                </div>
              ) : null}
            </header>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(340px,0.9fr)]">
              <div className="grid content-start gap-4">
                <Panel title="What was reported">
                  <ReportFacts incident={incident} />
                </Panel>

                <Panel title="Evidence from the field" hint={evidenceHint(evidence.items)}>
                  <EvidenceGallery
                    pin={incident}
                    items={evidence.items}
                    loading={evidence.loading}
                    failed={evidence.failed}
                    emptyText="No photos or files were attached to this report."
                  />
                </Panel>

                <Panel title="Coordinator decision">
                  <CoordinatorDecision incident={incident} />
                </Panel>

                {resolved ? (
                  <Panel title="Resolution">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Fact label="Resolved" value={<span className="tabular-nums">{formatWhen(incident.resolved_at)}</span>} />
                      <Fact label="Resolved by" value={incident.resolved_by_name || (incident.resolved_by_user_id ? `User #${incident.resolved_by_user_id}` : "Not recorded")} />
                      <div className="sm:col-span-2">
                        <Fact label="Resolution note" value={incident.resolution_comment?.trim() ? <span className="whitespace-pre-wrap">{incident.resolution_comment}</span> : <span className="text-muted">No note was left.</span>} />
                      </div>
                    </div>
                  </Panel>
                ) : null}
              </div>

              <div className="grid content-start gap-4">
                <Panel title="Where it is" hint={`${formatCoordinate(incident.latitude)}, ${formatCoordinate(incident.longitude)}`}>
                  <LocationFacts incident={incident} mapHeight={280} />
                </Panel>

                {operational ? (
                  <Panel title="Incident Group">
                    {incident.event_group_id != null ? (
                      <div className="grid gap-1.5 text-sm">
                        <Link to={`/incident-groups/${incident.event_group_id}`} className={link}>{eventGroupTitle || `Incident Group #${incident.event_group_id}`}</Link>
                        <span className="text-[13px] text-muted">The real-world event this report was grouped under, with every other report about it.</span>
                      </div>
                    ) : (
                      <p className="text-sm text-muted">
                        {isAwaitingTriage(incident)
                          ? "Not grouped yet. If the coordinator sends it for assessment, they choose its Incident Group then."
                          : isClosedAtTriage(incident)
                            ? "Not part of an Incident Group. It was closed at triage, so it never entered ERIS."
                            : "Not part of an Incident Group. Only reports sent for assessment are grouped."}
                      </p>
                    )}
                  </Panel>
                ) : null}

                {assessment.kind === "hidden" ? null : (
                  <Panel title="GeoTech assessment">
                    <AssessmentSummary load={assessment} incident={incident} viewer={viewer} />
                  </Panel>
                )}

                <Panel title="Road at this location" hint={incident.road_inventory_context?.match_method ? `Matched by ${incident.road_inventory_context.match_method}` : undefined}>
                  <RoadInventoryFacts incident={incident} showAllFields />
                </Panel>
              </div>
            </div>

            {tree ? (
              <Panel title="Progress" hint="Every step this report has been through, and who holds it now">
                <WorkflowTreeView tree={tree} />
              </Panel>
            ) : null}

            {assessment.kind === "loaded" && assessment.detail.events.length ? (
              <Panel title="History" hint={`${assessment.detail.events.length} recorded action${assessment.detail.events.length === 1 ? "" : "s"}`}>
                <ol className="grid gap-2">
                  {assessment.detail.events.map((event) => (
                    <li key={event.id} className="grid gap-0.5 border-b border-[var(--line)]/60 pb-2 last:border-b-0 last:pb-0 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-3">
                      <span className="text-[12px] text-muted tabular-nums">{formatWhen(event.created_at)}</span>
                      <span className="min-w-0 text-sm">
                        <span className="font-semibold">{assessmentEventLabel(event.event_type)}</span>
                        {event.actor_name ? <span className="text-muted"> · {event.actor_name}</span> : null}
                        {event.from_state && event.to_state && event.from_state !== event.to_state ? (
                          <span className="text-muted"> · {assessmentStateLabel(event.from_state)} → {assessmentStateLabel(event.to_state)}</span>
                        ) : null}
                        {event.notes?.trim() ? <span className="mt-0.5 block whitespace-pre-wrap text-[13px] text-muted">{event.notes}</span> : null}
                      </span>
                    </li>
                  ))}
                </ol>
              </Panel>
            ) : null}
          </>
        )}
      </div>

      {triageOpen && incident ? (
        <IncidentTriageDialog
          incidentId={incident.id}
          onClose={() => setTriageOpen(false)}
          onDone={(message) => { setTriageOpen(false); setNotice(message); setReloadKey((key) => key + 1); }}
        />
      ) : null}
    </AppShell>
  );
}

function CoordinatorDecision({ incident }: { incident: Incident }) {
  const decided = Boolean(incident.triage_disposition);
  if (!decided) {
    return (
      <p className="text-sm text-muted">
        {isWaitingOnReporter(incident)
          ? "The coordinator sent this report back to the reporter before recording a decision. It returns to the coordinator once the reporter updates it."
          : "Not decided yet. A Maintenance Coordinator reviews the report and decides whether it needs a GeoTech assessment."}
      </p>
    );
  }
  const meaning = dispositionMeaning(incident.triage_disposition);
  return (
    <div className="grid gap-3">
      <div>
        <div className="text-sm font-semibold">{dispositionLabel(incident.triage_disposition)}</div>
        {meaning ? <p className="mt-0.5 text-[13px] text-muted">{meaning}</p> : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Fact label="Decided by" value={incident.triage_decided_by_name || (incident.triage_decided_by_user_id ? `User #${incident.triage_decided_by_user_id}` : "Not recorded")} />
        <Fact label="Decided" value={<span className="tabular-nums">{formatWhen(incident.triage_decided_at)}</span>} />
        <Fact
          label="ERIS number"
          value={isClosedAtTriage(incident)
            ? <span className="text-muted">None — closed at triage, it did not enter ERIS</span>
            : incident.incident_key
              ? <span className="tabular-nums">{incident.incident_key}</span>
              : <span className="text-muted">None — only a report sent for assessment gets one</span>}
        />
        {incident.duplicate_of_incident_id != null ? (
          <Fact label="Linked to" value={<Link to={`/incidents/${incident.duplicate_of_incident_id}`} className={link}>Incident #{incident.duplicate_of_incident_id}</Link>} />
        ) : incident.duplicate_of_location_id != null ? (
          <Fact label="Linked to" value={`Location #${incident.duplicate_of_location_id}`} />
        ) : null}
      </div>
      <Fact label="Coordinator's notes" value={incident.triage_notes?.trim() ? <span className="whitespace-pre-wrap">{incident.triage_notes}</span> : <span className="text-muted">No notes were left.</span>} />
    </div>
  );
}

function AssessmentSummary({ load, incident, viewer }: { load: AssessmentLoad; incident: Incident; viewer: boolean }) {
  if (load.kind === "hidden") return null;
  if (load.kind === "loading") return <p className="text-sm text-muted">Loading the assessment…</p>;
  if (load.kind === "failed") return <p className="text-sm text-[var(--bad)]">The assessment could not be loaded. Refresh to try again.</p>;
  if (load.kind === "none") {
    return (
      <p className="text-sm text-muted">
        {incident.triage_disposition === "NO_ASSESSMENT_REQUIRED"
          ? "None. The coordinator decided this report does not need a geotechnical assessment."
          : incident.triage_disposition === "DUPLICATE_OR_LINKED"
            ? "None. The report was linked to another one instead."
            : "None yet. One opens if the coordinator decides an assessment is required."}
      </p>
    );
  }

  const { assessment, assignments } = load.detail;
  const author = assignments.find((row) => row.assignment_role === "ENGINEER" || row.assignment_role === "SENIOR_ENGINEER");
  const consulted = assignments.filter((row) => row.assignment_role === "CONSULTED");
  const next = isTerminalState(assessment.state) || viewer ? null : waitingOn(assessment, assignments);
  const submissionIds = submissionIdsOf(assessment);
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link to={`/assessments/${assessment.id}`} className={`${link} text-sm`}>Assessment #{assessment.id}</Link>
        <AssessmentStateBadge state={assessment.state} routingPath={assessment.routing_path} mini />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Fact label="Routed to" value={assessmentOrgLine(assessment)} />
        <Fact label={author ? assignmentRoleLabel(author.assignment_role) : "Assessed by"} value={author ? author.full_name : <span className="text-muted">Not assigned yet</span>} />
        {next ? <Fact label="Waiting on" value={next.who} /> : null}
        {consulted.length ? <Fact label="Consulted" value={consulted.map((row) => row.full_name).join(", ")} /> : null}
        <Fact label="Opened" value={<span className="tabular-nums">{formatWhen(assessment.created_at)}</span>} />
        {assessment.submitted_at ? <Fact label="Submitted" value={<span className="tabular-nums">{formatWhen(assessment.submitted_at)}</span>} /> : null}
        {assessment.approved_at ? <Fact label="Approved" value={<span className="tabular-nums">{formatWhen(assessment.approved_at)}</span>} /> : null}
      </div>
      <Fact
        label="Technical forms"
        value={submissionIds.length
          ? <span className="flex flex-wrap gap-x-3 gap-y-1">{submissionIds.map((id) => <Link key={id} to={`/submissions/${id}`} className={link}>Form #{id}</Link>)}</span>
          : <span className="text-muted">None filed yet</span>}
      />
    </div>
  );
}

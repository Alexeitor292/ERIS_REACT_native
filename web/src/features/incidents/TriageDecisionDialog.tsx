import { useEffect, useMemo, useState } from "react";

import { routingPreview, triageIncident, type RoutingPreview } from "../../api/assessments";
import { api } from "../../api/client";
import type { Incident } from "../../api/types";
import ModalDialog from "../../ui/ModalDialog";
import EventGroupPicker from "../eventGroups/EventGroupPicker";
import { REVISION_FIELD_OPTIONS, workflowPositionLabel } from "./incidentDetailModel";
import { formatWhen } from "./IncidentReportParts";
import {
  TRIAGE_OPTIONS,
  candidateDistanceLabel,
  confirmLabel,
  duplicateCandidates,
  needsEventGroup,
  triageBlocker,
  triageOutcomeMessage,
  triageRequestBody,
  type TriageDraft,
} from "./triageDecisionModel";

const inputClass = "rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]";
const buttonClass = "rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50";

const optionClass = (active: boolean) =>
  `flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 ${active
    ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_7%,var(--panel))]"
    : "border-[var(--line)] bg-[var(--panel)] hover:bg-[var(--panel-soft)]"}`;

/**
 * Step 2 of coordinator triage: decide what happens to the report.
 *
 * The four outcomes are shown at once and none is preselected. Only
 * "Assessment required" asks where the report belongs: choosing it widens the
 * window to the side and slides the Event Group picker in beside the decision;
 * choosing anything else never shows it, and switching away closes it again.
 * The group is saved by the triage request itself, so nothing is written until
 * the coordinator confirms.
 *
 * On a phone-width screen the picker opens below the decision instead.
 */
export default function TriageDecisionDialog({
  draft,
  onChange,
  onBack,
  onClose,
  onDone,
}: {
  draft: TriageDraft;
  onChange: (next: TriageDraft) => void;
  onBack: () => void;
  onClose: () => void;
  onDone: (message: string) => void | Promise<void>;
}) {
  const incidentId = draft.incidentId;
  const expanded = needsEventGroup(draft.disposition);
  const [incident, setIncident] = useState<Incident | null>(null);
  const [routing, setRouting] = useState<RoutingPreview | null>(null);
  const [reports, setReports] = useState<Incident[] | null>(null);
  const [manualDuplicate, setManualDuplicate] = useState("");
  // The picker mounts the first time it is needed and then stays mounted, so
  // closing the side panel animates out instead of vanishing mid-transition.
  const [pickerMounted, setPickerMounted] = useState(expanded);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ incident: Incident }>(`/incidents/${incidentId}`)
      .then((detail) => { if (!cancelled) setIncident(detail.incident); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [incidentId]);

  useEffect(() => { if (expanded) setPickerMounted(true); }, [expanded]);

  // Where an assessment would go: the district's GeoTech office.
  const district = incident?.district ?? null;
  useEffect(() => {
    if (!expanded || !district || routing) return;
    let cancelled = false;
    routingPreview(district).then((preview) => { if (!cancelled) setRouting(preview); }).catch(() => {});
    return () => { cancelled = true; };
  }, [expanded, district, routing]);

  // The reports this one might repeat, loaded the first time "duplicate" is chosen.
  const wantsDuplicates = draft.disposition === "DUPLICATE_OR_LINKED";
  useEffect(() => {
    if (!wantsDuplicates || reports) return;
    let cancelled = false;
    api<{ items: Incident[] }>("/incidents?limit=1000")
      .then((response) => { if (!cancelled) setReports(response.items ?? []); })
      .catch(() => { if (!cancelled) setReports([]); });
    return () => { cancelled = true; };
  }, [wantsDuplicates, reports]);

  const candidates = useMemo(
    () => (incident && reports ? duplicateCandidates(incident, reports) : []),
    [incident, reports],
  );

  const blocker = triageBlocker(draft);

  async function confirm() {
    const body = triageRequestBody(draft);
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const result = await triageIncident(incidentId, body) as { assessment?: { id: number } } | undefined;
      await onDone(triageOutcomeMessage(draft, result));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The decision could not be recorded.");
      setBusy(false);
    }
  }

  function setManual(raw: string) {
    setManualDuplicate(raw);
    const id = Number(raw);
    onChange({ ...draft, duplicateOfIncidentId: Number.isInteger(id) && id > 0 && id !== incidentId ? id : null });
  }

  // The expanded width is the width the window actually ends at (the overlay
  // pads 1rem a side), so the whole transition is visible: easing towards a
  // 90rem cap the screen cannot reach spends most of it past the screen edge.
  const panelClassName = [
    "flex max-h-[92vh] w-full flex-col overflow-hidden rounded-xl bg-[var(--panel)] shadow-2xl ring-1 ring-[var(--line)] md:h-[min(88vh,46rem)]",
    "transition-[max-width] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
    expanded ? "max-w-[min(90rem,calc(100vw_-_2rem))]" : "max-w-[40rem]",
  ].join(" ");

  return (
    <ModalDialog
      titleId="triage-decision-title"
      descriptionId="triage-decision-description"
      busy={busy}
      onClose={onClose}
      panelClassName={panelClassName}
    >
      <div className="flex items-start justify-between gap-4 border-b border-[var(--line)] px-5 py-4">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Step 2 of 2 · Decide what happens</div>
          <h2 id="triage-decision-title" className="mt-0.5 truncate text-base font-semibold">{incident?.title || `Field report #${incidentId}`}</h2>
          <p id="triage-decision-description" className="mt-1 text-[13px] text-muted">
            Field report #{incidentId}. Choose what happens to it — ERIS asks for an Event Group only when it needs an assessment.
          </p>
        </div>
        <button type="button" onClick={onClose} disabled={busy} aria-label="Close dialog" className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 text-sm font-semibold hover:bg-[var(--panel-soft)] disabled:opacity-50">×</button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
        <div className="grid w-full shrink-0 content-start gap-4 px-5 py-4 md:min-h-0 md:w-[40rem] md:overflow-y-auto">
          {error ? <div role="alert" className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}

          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-semibold">What happens to this report?</legend>
            {TRIAGE_OPTIONS.map((option, index) => {
              const active = draft.disposition === option.value;
              return (
                <label key={option.value} className={optionClass(active)}>
                  <input
                    type="radio"
                    name={`triage-disposition-${incidentId}`}
                    checked={active}
                    onChange={() => onChange({ ...draft, disposition: option.value })}
                    data-dialog-initial-focus={index === 0 ? "true" : undefined}
                    className="mt-0.5"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">{option.label}</span>
                    <span className="mt-0.5 block text-xs text-muted">{option.description}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>

          {draft.disposition === "ASSESSMENT_REQUIRED" ? (
            <div className="rounded-md border border-[color:color-mix(in_oklab,var(--brand)_40%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_6%,var(--panel))] px-3 py-2 text-[13px]">
              {routing?.office_name ? <>The office chief of <b>{routing.office_name}</b> routes the assessment next. </> : null}
              Choose the Event Group it belongs to <span className="hidden md:inline">on the right</span><span className="md:hidden">below</span>.
            </div>
          ) : null}

          {draft.disposition === "NEEDS_REPORTER_INFORMATION" ? (
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-semibold">What should the reporter correct?</legend>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                {REVISION_FIELD_OPTIONS.map((field) => (
                  <label key={field.code} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.revisionFields.includes(field.code)}
                      onChange={(event) => onChange({
                        ...draft,
                        revisionFields: event.target.checked
                          ? [...draft.revisionFields, field.code]
                          : draft.revisionFields.filter((code) => code !== field.code),
                      })}
                    />
                    {field.label}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          {draft.disposition === "DUPLICATE_OR_LINKED" ? (
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-semibold">Which report does it repeat?</legend>
              {reports === null ? (
                <p className="text-sm text-muted">Looking for reports nearby…</p>
              ) : candidates.length === 0 ? (
                <p className="text-sm text-muted">No other reports within 5 miles. Enter the report number instead.</p>
              ) : candidates.map((candidate) => {
                const active = draft.duplicateOfIncidentId === candidate.id;
                return (
                  <label key={candidate.id} className={optionClass(active)}>
                    <input
                      type="radio"
                      name={`triage-duplicate-${incidentId}`}
                      checked={active}
                      onChange={() => { setManualDuplicate(""); onChange({ ...draft, duplicateOfIncidentId: candidate.id }); }}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold">#{candidate.id} {candidate.title || "Untitled report"}</span>
                      <span className="mt-0.5 block text-xs text-muted tabular-nums">{candidateDistanceLabel(candidate.distanceM)} · {workflowPositionLabel(candidate)} · filed {formatWhen(candidate.created_at)}</span>
                    </span>
                  </label>
                );
              })}
              <label className="flex flex-wrap items-center gap-2 text-sm text-muted">
                Or another report number
                <input
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={manualDuplicate}
                  onChange={(event) => setManual(event.target.value)}
                  className={`${inputClass} w-28 tabular-nums text-[var(--ink)]`}
                  aria-label="Report number it repeats"
                />
              </label>
            </fieldset>
          ) : null}

          {draft.disposition ? (
            <label className="grid gap-1.5">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">
                {draft.disposition === "NEEDS_REPORTER_INFORMATION" ? "Message to the reporter" : "Note for the record (optional)"}
              </span>
              <textarea
                rows={3}
                className={inputClass}
                value={draft.notes}
                onChange={(event) => onChange({ ...draft, notes: event.target.value })}
                placeholder={draft.disposition === "NEEDS_REPORTER_INFORMATION" ? "What is missing or wrong, in words the reporter will see" : "Why you decided this — kept in the report's history"}
              />
            </label>
          ) : null}
        </div>

        <section
          aria-label="Event Group"
          aria-hidden={!expanded}
          inert={!expanded}
          className={[
            "min-w-0 border-[var(--line)] max-md:border-t md:min-h-0 md:flex-1 md:border-l",
            "transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none",
            expanded ? "translate-x-0 opacity-100 delay-150" : "pointer-events-none translate-x-6 opacity-0 max-md:hidden",
          ].join(" ")}
        >
          {pickerMounted ? (
            <EventGroupPicker
              incidentId={incidentId}
              value={draft.eventGroup}
              onChange={(eventGroup) => onChange({ ...draft, eventGroup })}
            />
          ) : null}
        </section>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] px-5 py-3">
        <button type="button" onClick={onBack} disabled={busy} className={buttonClass}>Back to the report</button>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span aria-live="polite" className="text-[12px] text-muted">{blocker}</span>
          <button type="button" onClick={onClose} disabled={busy} className={buttonClass}>Cancel</button>
          <button type="button" onClick={confirm} disabled={busy || Boolean(blocker)} className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50">
            {busy ? "Recording…" : confirmLabel(draft.disposition)}
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}

import { useState } from "react";
import { Link } from "react-router-dom";

import { triageIncident } from "../../api/assessments";
import type { Incident } from "../../api/types";
import { formatCoordinate } from "../../utils/precision";
import { formatTimestamp } from "../assessments/AssessmentDetailPanel";
import { eventGroupLocationLabel } from "../eventGroups/eventGroupTypes";
import { IncidentTriageDialog, type TriageDialogState } from "../incidents/IncidentDecisionDialogs";

/**
 * Coordinator intake: a field report that is not yet part of the incident record.
 * "Start triage" opens the two-step dialog (Event Group review with map → disposition).
 * Accepting with "Assessment required" mints the permanent incident key server-side
 * and routes a new assessment to the Office Chief.
 */
export default function TriageWorkItem({
  incident,
  onTriaged,
  onError,
}: {
  incident: Incident;
  onTriaged: (message: string) => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const [dialog, setDialog] = useState<TriageDialogState | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (!dialog) return;
    setBusy(true);
    try {
      const result = await triageIncident(dialog.incidentId, {
        disposition: dialog.disposition,
        notes: dialog.notes.trim() || undefined,
      }) as { assessment?: { id: number } } | undefined;
      setDialog(null);
      await onTriaged(
        result?.assessment
          ? `Incident #${incident.id} accepted — assessment #${result.assessment.id} routed for office delegation.`
          : `Triage recorded for incident #${incident.id}.`,
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : "Triage failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3.5">
      <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Field report #{incident.id} — not yet in the incident record</div>
            <div className="mt-0.5 text-lg font-semibold">{incident.title || `Incident #${incident.id}`}</div>
            <div className="mt-1 text-[13px] text-muted tabular-nums">{eventGroupLocationLabel(incident)} · {formatCoordinate(incident.latitude)}, {formatCoordinate(incident.longitude)} · Reported {formatTimestamp(incident.first_observed_at)}</div>
          </div>
          <span className="inline-flex whitespace-nowrap rounded-full border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-2 py-0.5 text-[11px] font-semibold text-[var(--bad)]">Awaiting triage</span>
        </div>
        {incident.description ? <p className="mt-3 text-sm">{incident.description}</p> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <Link to={`/incidents/${incident.id}`} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--panel-soft)]">Open incident record</Link>
        </div>
      </section>

      <section className="rounded-xl border border-[color:color-mix(in_oklab,var(--brand)_40%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_6%,var(--panel))] p-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--brand)]">Next step</span>
          <span className="text-[15px] font-semibold">Waiting on Maintenance Coordinator</span>
        </div>
        <p className="mt-1.5 text-sm">This report has not been accepted into ERIS yet. Review the Event Group context and record the triage disposition — "Assessment required" accepts it and routes a new assessment to the Office Chief.</p>
        <button
          type="button"
          onClick={() => setDialog({ incidentId: incident.id, disposition: "ASSESSMENT_REQUIRED", notes: "" })}
          className="mt-3 rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-semibold text-white hover:brightness-95"
        >
          Start triage
        </button>
      </section>

      {dialog ? (
        <IncidentTriageDialog state={dialog} busy={busy} onChange={setDialog} onClose={() => setDialog(null)} onConfirm={confirm} />
      ) : null}
    </div>
  );
}

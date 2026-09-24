import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../../api/client";
import type { Incident } from "../../api/types";
import ModalDialog from "../../ui/ModalDialog";
import { formatCoordinate } from "../../utils/precision";
import {
  EvidenceGallery,
  LocationFacts,
  Panel,
  ReportFacts,
  RoadInventoryFacts,
  evidenceHint,
  useIncidentEvidence,
} from "./IncidentReportParts";
import { readinessChecks } from "./reportReviewModel";

/**
 * Step 1 of coordinator triage: everything needed to judge whether a field
 * report is a real incident, before any Incident Group question is put.
 *
 * The coordinator used to reach the Incident Group map having seen only a title,
 * a location line and a description — never the photos, never who filed it.
 * This step puts the evidence first and asks nothing; "Continue" is the only
 * decision it offers, and no disposition is preselected in the next step.
 * The same parts render the dedicated incident page, so a report looks the same
 * in both places.
 */
export default function ReportReviewDialog({
  incidentId,
  onClose,
  onContinue,
}: {
  incidentId: number;
  onClose: () => void;
  onContinue: () => void;
}) {
  const [incident, setIncident] = useState<Incident | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const evidence = useIncidentEvidence(incidentId);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<{ incident: Incident }>(`/incidents/${incidentId}`)
      .then((detail) => { if (!cancelled) setIncident(detail.incident); })
      .catch((e: any) => { if (!cancelled) setError(e?.message ?? "Failed to load the field report."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [incidentId]);

  const busy = loading || evidence.loading;
  const checks = useMemo(
    () => (incident ? readinessChecks({ ...incident, road_inventory_context: incident.road_inventory_context ?? null }, evidence.items) : []),
    [incident, evidence.items],
  );

  return (
    <ModalDialog
      titleId="report-review-title"
      descriptionId="report-review-description"
      busy={busy}
      onClose={onClose}
      panelClassName="flex max-h-[92vh] w-full max-w-6xl flex-col rounded-xl border border-[var(--line)] bg-[var(--panel)] shadow-2xl"
    >
      <div className="flex items-start justify-between gap-4 border-b border-[var(--line)] px-5 py-4">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Step 1 of 2 · Review the report</div>
          <h2 id="report-review-title" className="mt-0.5 truncate text-base font-semibold">{incident?.title || `Field report #${incidentId}`}</h2>
          <p id="report-review-description" className="mt-1 max-w-3xl text-[13px] text-muted">
            Read what was reported and look at the evidence. Decide whether this is a real incident before you record what happens to it.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link to={`/incidents/${incidentId}`} target="_blank" rel="noreferrer" className="hidden rounded-md border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 text-[12px] font-semibold hover:bg-[var(--panel-soft)] sm:inline-flex">Open full record</Link>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close dialog" className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 text-sm font-semibold hover:bg-[var(--panel-soft)] disabled:opacity-50">×</button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {error ? (
          <div role="alert" className="mb-4 rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div>
        ) : null}

        {!incident ? (
          <div className="py-12 text-center text-sm text-muted">{loading ? "Loading the field report…" : "The field report is unavailable."}</div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.9fr)]">
            <div className="grid content-start gap-4">
              <Panel title="Evidence from the field" hint={evidenceHint(evidence.items)}>
                <EvidenceGallery
                  pin={incident}
                  items={evidence.items}
                  loading={evidence.loading}
                  failed={evidence.failed}
                  emptyText="No photos or files were attached to this report. That is itself worth weighing — ask the reporter for more information if you cannot judge it from the description."
                />
              </Panel>

              <Panel title="What was reported">
                <ReportFacts incident={incident} />
              </Panel>

              <Panel title="Worth a look" hint="Facts only — the decision stays yours">
                <ul className="grid gap-2">
                  {checks.map((check) => (
                    <li key={check.key} className="flex items-start gap-2.5">
                      <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${check.status === "attention" ? "bg-[var(--warn)]" : "bg-[var(--good)]"}`} />
                      <span className="min-w-0 text-sm">
                        <span className="font-semibold">{check.label}</span>
                        <span className="sr-only">{check.status === "attention" ? " — needs attention" : " — nothing to flag"}</span>
                        <span className="text-muted"> · {check.detail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>

            <div className="grid content-start gap-4">
              <Panel title="Where it is" hint={`${formatCoordinate(incident.latitude)}, ${formatCoordinate(incident.longitude)}`}>
                <LocationFacts incident={incident} />
              </Panel>
              <Panel title="Road at this location" hint={incident.road_inventory_context?.match_method ? `Matched by ${incident.road_inventory_context.match_method}` : undefined}>
                <RoadInventoryFacts incident={incident} />
              </Panel>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] px-5 py-3">
        <span className="text-[12px] text-muted">Next: decide what happens to this report.</span>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">Cancel</button>
          <button type="button" onClick={onContinue} disabled={busy || !incident} className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50">Continue to the decision</button>
        </div>
      </div>
    </ModalDialog>
  );
}

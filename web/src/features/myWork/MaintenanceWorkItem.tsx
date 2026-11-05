import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../../api/client";
import type { Incident } from "../../api/types";
import { EvidenceGallery, ReportFacts, evidenceHint, useIncidentEvidence } from "../incidents/IncidentReportParts";
import MaintenanceWorkflowPanel from "../incidents/MaintenanceWorkflowPanel";

/**
 * A maintenance report in My Work: its place in the district's review path,
 * with the decision for whoever's turn it is, what was reported and the
 * evidence from the field.
 */
export default function MaintenanceWorkItem({ id, onChanged }: { id: number; onChanged: () => void }) {
  const [incident, setIncident] = useState<Incident | null>(null);
  const [error, setError] = useState("");
  const evidence = useIncidentEvidence(id);
  const load = useCallback(
    () => api<{ incident: Incident }>(`/incidents/${id}`).then((r) => setIncident(r.incident)).catch((e) => setError(e.message)),
    [id],
  );
  useEffect(() => { setIncident(null); setError(""); void load(); }, [load]);
  return (
    <div className="space-y-4 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
      {error ? <p role="alert" className="text-sm text-[var(--bad)]">{error}</p> : null}
      {incident ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold">{incident.title}</h2>
            <Link className="text-sm text-[var(--brand)] hover:underline" to={`/incidents/${id}`}>Open full record</Link>
          </div>
          <MaintenanceWorkflowPanel incidentId={id} description={incident.description} onChanged={() => { void load(); onChanged(); }} />
          <div className="rounded-lg border border-[var(--line)] p-4"><h3 className="mb-3 font-semibold">What was reported</h3><ReportFacts incident={incident} /></div>
          <div className="rounded-lg border border-[var(--line)] p-4">
            <h3 className="mb-3 font-semibold">Evidence from the field <span className="text-xs font-normal text-muted">{evidenceHint(evidence.items)}</span></h3>
            <EvidenceGallery pin={incident} items={evidence.items} loading={evidence.loading} failed={evidence.failed} emptyText="No evidence attached yet." />
          </div>
        </>
      ) : !error ? <p className="text-sm text-muted">Loading report…</p> : null}
    </div>
  );
}

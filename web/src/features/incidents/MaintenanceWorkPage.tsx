import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { maintenanceWork, type WorkItem } from "../../api/maintenanceWorkflows";
import type { Incident } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import AppShell from "../../ui/AppShell";
import MaintenanceWorkflowPanel from "./MaintenanceWorkflowPanel";
import MaintenanceReportForm from "./MaintenanceReportForm";
import { EvidenceGallery, ReportFacts, evidenceHint, useIncidentEvidence } from "./IncidentReportParts";

const button = "rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm hover:bg-[var(--panel-soft)] disabled:opacity-50";

function Report({ id, onChanged }: { id: number; onChanged: () => void }) {
  const [incident, setIncident] = useState<Incident | null>(null);
  const [error, setError] = useState("");
  const evidence = useIncidentEvidence(id);
  const load = useCallback(() => api<{ incident: Incident }>(`/incidents/${id}`).then(r => setIncident(r.incident)).catch(e => setError(e.message)), [id]);
  useEffect(() => { setIncident(null); setError(""); void load(); }, [load]);
  return <div className="space-y-4">{error && <p role="alert" className="text-sm text-[var(--bad)]">{error}</p>}{incident && <>
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold">{incident.title}</h2><Link className="text-sm text-[var(--brand)] hover:underline" to={`/incidents/${id}`}>Open full record</Link></div>
    <MaintenanceWorkflowPanel incidentId={id} description={incident.description} onChanged={() => { void load(); onChanged(); }} />
    <div className="rounded-lg border border-[var(--line)] p-4"><h3 className="mb-3 font-semibold">What was reported</h3><ReportFacts incident={incident} /></div>
    <div className="rounded-lg border border-[var(--line)] p-4"><h3 className="mb-3 font-semibold">Evidence from the field <span className="text-xs font-normal text-muted">{evidenceHint(evidence.items)}</span></h3><EvidenceGallery pin={incident} items={evidence.items} loading={evidence.loading} failed={evidence.failed} emptyText="No evidence attached yet." /></div>
  </>}</div>;
}

export default function MaintenanceWorkPage() {
  const { me } = useAuth();
  const [params, setParams] = useSearchParams();
  const id = Number(params.get("incident"));
  const [items, setItems] = useState<WorkItem[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false);
  const [onlyMine, setOnlyMine] = useState(true);
  const load = useCallback(async () => {
    setBusy(true); setError("");
    try { const r = await maintenanceWork(); setItems(r.items); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load maintenance work"); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const canReport = me?.roles.includes("ADMIN") || me?.maintenance_districts?.some(d => d.report);
  const visible = onlyMine ? items.filter(i => i.my_turn) : items;
  return <AppShell title="Maintenance work"><div className="space-y-4 p-4 md:p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="max-w-2xl text-sm text-muted">Reports follow the maintenance duties and review path chosen by each district.</p><div className="flex flex-wrap gap-2"><Link className={button} to="/organization?tab=maintenance">District workflow setup</Link><button type="button" className={button} disabled={busy} onClick={() => void load()}>Refresh</button>{canReport && <button type="button" className={button} onClick={() => setCreating(true)}>Report an incident</button>}</div></div>
    {error && <p role="alert" className="text-sm text-[var(--bad)]">{error}</p>}{notice && <p role="status" className="text-sm text-[var(--good)]">{notice}</p>}
    {creating ? <MaintenanceReportForm onCancel={() => setCreating(false)} onCreated={(incidentId, message) => { setNotice(message); setCreating(false); setOnlyMine(false); setParams({ incident: String(incidentId) }); void load(); }} /> : <div className="grid gap-5 xl:grid-cols-[minmax(17rem,0.8fr)_minmax(0,2fr)]">
      <div className="space-y-3"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyMine} onChange={e => setOnlyMine(e.target.checked)} />Waiting on me</label><p className="text-xs text-muted">{visible.length} report(s)</p><div className="grid gap-2">{visible.map(item => <button type="button" key={item.id} onClick={() => setParams({ incident: String(item.id) })} className={`rounded-lg border p-3 text-left ${id === item.id ? 'border-[var(--brand)] bg-[var(--panel-soft)]' : 'border-[var(--line)]'}`}><div className="text-sm font-semibold">{item.title}</div><div className="mt-1 text-xs text-muted">District {Number(item.district)} · {item.outcome ? item.outcome === 'GEOTECH' ? 'Sent to GeoTech' : 'Maintenance handles it' : item.waiting_reporter ? 'Waiting on reporter' : item.step_name}</div>{item.my_turn && <span className="mt-2 inline-block text-xs font-semibold text-[var(--brand)]">Your action needed</span>}</button>)}{!visible.length && <p className="text-sm text-muted">{busy ? 'Loading reports…' : onlyMine ? 'No reports are waiting on you. Clear the filter to see other reports you can read.' : 'No district workflow reports are available to you yet.'}</p>}</div></div>
      <div>{id > 0 ? <Report key={id} id={id} onChanged={() => void load()} /> : <p className="rounded-lg bg-[var(--panel-soft)] p-6 text-sm text-muted">Select a report to read its evidence, follow the review path or record your decision.</p>}</div>
    </div>}
  </div></AppShell>;
}

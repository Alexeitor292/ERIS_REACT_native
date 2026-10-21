import { useEffect, useState } from "react";
import { maintenanceAction, maintenanceDetail, type WorkflowDetail } from "../../api/maintenanceWorkflows";
import { api } from "../../api/client";
import { formatWhen } from "./IncidentReportParts";

const input = "rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm";
const button = `${input} hover:bg-[var(--panel-soft)] disabled:opacity-50`;
const actionLabel: Record<string, string> = { REPORTED: "Report filed", APPROVE: "Review completed", REQUEST_INFORMATION: "Reporter information requested", RESUBMIT: "Information supplied", EDIT: "Report edited", MAINTENANCE: "Maintenance handles it", GEOTECH: "GeoTech referral", RESTART: "Restarted on current district workflow" };

export default function MaintenanceWorkflowPanel({ incidentId, description, onChanged }: { incidentId: number; description: string | null; onChanged?: () => void }) {
  const [workflow, setWorkflow] = useState<WorkflowDetail | null>(null);
  const [notes, setNotes] = useState("");
  const [text, setText] = useState(description || "");
  const [choice, setChoice] = useState("");
  const [group, setGroup] = useState("");
  const [groupTitle, setGroupTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(false);
  const load = () => maintenanceDetail(incidentId).then(next => { setWorkflow(next); return next; });
  useEffect(() => {
    let cancelled = false;
    setWorkflow(null); setError(""); setNotes(""); setNotice(""); setChoice(""); setEditing(false);
    maintenanceDetail(incidentId).then(next => { if (!cancelled) setWorkflow(next); }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [incidentId]);
  useEffect(() => { setText(description || ""); }, [description, incidentId]);
  useEffect(() => {
    const decision = workflow?.state.decision;
    if (decision) { setGroup(decision.event_group_id ? String(decision.event_group_id) : ""); setGroupTitle(decision.new_group_title || ""); }
  }, [workflow]);
  async function confirm() {
    if (!workflow || !choice || !notes.trim()) return;
    if (choice === "RESTART" && !window.confirm("Restart this report on the latest district workflow? Previous reviews remain in history; review starts again from step one.")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const next = await maintenanceAction(incidentId, { version: workflow.version, action: choice, notes,
        ...(choice === "EDIT" || choice === "RESUBMIT" ? { description: text } : {}),
        ...(choice === "GEOTECH" ? { event_group_id: group ? Number(group) : null, new_group_title: group ? null : groupTitle.trim() || null } : {}),
      });
      setWorkflow(next); setChoice(""); setNotes(""); setEditing(false); setNotice(next.outcome ? (next.outcome === "GEOTECH" ? "Sent to GeoTech." : "Maintenance will handle this incident. The maintenance review is complete.") : "Your action was recorded.");
      onChanged?.();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not record action"); }
    finally { setBusy(false); }
  }
  const options: Array<[string, string]> = [];
  if (workflow?.can_act) {
    if (workflow.step.kind === "REVIEW" && !workflow.state.pending_outcome) options.push(["APPROVE", "Complete review and continue"]);
    if (workflow.step.allow_maintenance && (!workflow.state.pending_outcome || workflow.state.pending_outcome === "MAINTENANCE")) options.push(["MAINTENANCE", "Maintenance can handle it — end review"]);
    if (workflow.step.allow_geotech && (!workflow.state.pending_outcome || workflow.state.pending_outcome === "GEOTECH")) options.push(["GEOTECH", "Send to GeoTech"]);
    if (workflow.step.request_information) options.push(["REQUEST_INFORMATION", "Ask the reporter for more information"]);
  }
  if (workflow?.can_resubmit) options.push(["RESUBMIT", "Supply information and return for review"]);
  if (workflow?.can_edit) options.push(["EDIT", "Update the report description"]);
  if (workflow?.can_restart) options.push(["RESTART", "Restart using the latest district workflow"]);
  return <section className="space-y-4 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-4" aria-label="Maintenance workflow">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-semibold">District maintenance workflow</h2>{workflow && <p className="mt-1 text-xs text-muted">District {Number(workflow.district)} · Workflow revision {workflow.revision}</p>}</div><button type="button" className={button} disabled={busy} onClick={() => { setChoice(""); void load().catch(e => setError(e.message)); }}>Refresh workflow</button></div>
    {error && <p role="alert" className="text-sm text-[var(--bad)]">{error}</p>}{notice && <p role="status" className="text-sm text-[var(--good)]">{notice}</p>}
    {!workflow ? <p className="text-sm text-muted">Loading review path…</p> : <>
      <ol className="flex flex-wrap gap-2 text-sm">{workflow.steps.map((s, i) => <li key={i} className={`rounded-md border px-3 py-2 ${i === workflow.state.step_index && !workflow.outcome ? "border-[var(--brand)] bg-[var(--panel-soft)] font-semibold" : "border-[var(--line)] text-muted"}`}>{i + 1}. {s.name}{i < workflow.state.step_index ? " ✓" : ""}</li>)}</ol>
      <p className="text-sm">{workflow.outcome ? (workflow.outcome === "GEOTECH" ? "Maintenance review ended: sent to GeoTech." : "Maintenance review ended: maintenance handles the repair.") : workflow.state.waiting_reporter ? "Waiting for more information from the reporter." : <>Current step: <strong>{workflow.step.name}</strong> · {workflow.step.rule === "ALL" ? "Every assigned person must agree" : "Any assigned person may act"}</>}</p>
      {!workflow.outcome && <p className="text-sm text-muted">Assigned: {workflow.assigned.map(p => `${p.full_name}${p.is_active === false ? " (inactive — ask a manager to update the workflow)" : ""}`).join(", ")}. {workflow.state.approved_user_ids.length ? `${workflow.state.approved_user_ids.length} review(s) recorded${workflow.state.pending_outcome ? ` for ${workflow.state.pending_outcome === 'GEOTECH' ? 'GeoTech referral' : 'maintenance handling'}` : ''}.` : ""}</p>}
      {!!options.length && <fieldset className="space-y-3" disabled={busy}><legend className="mb-2 text-sm font-semibold">Your next action</legend>
        <div className="grid gap-2">{options.map(([value, label]) => <label key={value} className="flex items-center gap-2 text-sm"><input type="radio" name={`maintenance-action-${incidentId}`} value={value} checked={choice === value} onChange={() => { setChoice(value); setEditing(value === 'EDIT' || value === 'RESUBMIT'); }} />{label}</label>)}</div>
        {editing && <label className="grid gap-1 text-sm">Report description (updating restarts review at step one)<textarea rows={5} className={input} value={text} onChange={e => setText(e.target.value)} /></label>}
        {choice === "GEOTECH" && <div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm">Incident Group<select className={input} disabled={!!workflow.state.decision} value={group} onChange={e => setGroup(e.target.value)}><option value="">Create a new Incident Group</option>{workflow.groups.map(g => <option key={g.id} value={g.id}>{g.title}</option>)}</select></label>{!group && <label className="grid gap-1 text-sm">New group name (optional)<input className={input} disabled={!!workflow.state.decision} value={groupTitle} placeholder="Use this incident’s name" onChange={e => setGroupTitle(e.target.value)} /></label>}<p className="text-xs text-muted sm:col-span-2">The referral goes to the district’s configured GeoTech office. With unanimous approval, all decision makers agree on the same outcome and Incident Group.</p></div>}
        {choice && <><label className="grid gap-1 text-sm">Review notes / reason (required)<textarea className={input} rows={3} value={notes} onChange={e => setNotes(e.target.value)} /></label><button type="button" disabled={!notes.trim()} onClick={() => void confirm()} className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Recording…" : "Record action"}</button></>}
      </fieldset>}
      {workflow.can_edit && <label className="grid gap-1 text-sm">Attach evidence<input type="file" disabled={busy} onChange={async e => {
        const file = e.target.files?.[0]; if (!file) return;
        const body = new FormData(); body.append("file", file); setBusy(true); setError("");
        try { await api(`/incidents/${incidentId}/attachments?kind=${file.type.startsWith('image/') ? 'PHOTO' : file.type.startsWith('video/') ? 'VIDEO' : 'DOC'}`, { method: "POST", body }); setNotice("Evidence attached. Reopen the report to refresh the gallery."); onChanged?.(); }
        catch (error) { setError(error instanceof Error ? error.message : "Upload failed"); }
        finally { setBusy(false); }
      }} /></label>}
      <details><summary className="cursor-pointer text-sm font-semibold">Review history ({workflow.events.length})</summary><ol className="mt-3 grid gap-3">{workflow.events.map(e => <li key={e.id} className="border-l-2 border-[var(--line)] pl-3 text-sm"><div className="font-medium">{actionLabel[e.action] || e.action} · {e.actor_name}</div><div className="text-xs text-muted">{formatWhen(e.created_at)}</div>{e.notes && <p className="mt-1 whitespace-pre-wrap">{e.notes}</p>}</li>)}</ol></details>
    </>}
  </section>;
}

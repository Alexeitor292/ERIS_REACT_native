import { useRef, useState } from "react";
import { api } from "../../api/client";
import type { Incident } from "../../api/types";
import IncidentCreatePanel, { createBlocker } from "./IncidentCreatePanel";
import { EMPTY_INCIDENT_FORM, inferIncidentAttachmentKind, type PendingIncidentUpload } from "./incidentUiModel";

export default function MaintenanceReportForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: number, notice: string) => void }) {
  const [form, setForm] = useState(EMPTY_INCIDENT_FORM);
  const [files, setFiles] = useState<PendingIncidentUpload[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  async function create() {
    const blocker = createBlocker(form);
    if (blocker || !form.location) { setError(blocker || "Place the incident first"); return; }
    setBusy(true); setError("");
    try {
      const result = await api<{ incident: Incident }>("/incidents", { method: "POST", body: JSON.stringify({
        ...form.location, description: form.description, first_observed_at: form.first_observed_at,
        first_occurred_at: form.first_occurred_at || null,
      }) });
      const failed: string[] = [];
      for (const pending of files) {
        const body = new FormData(); body.append("file", pending.file, pending.file.name);
        try { await api(`/incidents/${result.incident.id}/attachments?kind=${pending.kind}`, { method: "POST", body }); }
        catch { failed.push(pending.file.name); }
      }
      onCreated(result.incident.id, failed.length ? `Report filed. These files still need uploading: ${failed.join(", ")}. Open the report to attach them.` : "Report filed and sent to the district’s first review step.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not file the report"); }
    finally { setBusy(false); }
  }
  return <div className="space-y-3">{error && <p role="alert" className="text-sm text-[var(--bad)]">{error}</p>}<IncidentCreatePanel
    form={form} pendingFiles={files} busy={busy} fileInputRef={input} onFormChange={setForm}
    onFiles={next => { setFiles(old => [...old, ...Array.from(next || []).map(file => ({ file, kind: inferIncidentAttachmentKind(file.name, file.type) }))]); if (input.current) input.current.value = ""; }}
    onRemoveFile={index => setFiles(old => old.filter((_, i) => i !== index))} onCancel={onCancel} onCreate={() => void create()} /></div>;
}

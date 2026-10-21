import { useEffect, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Bell, ChevronRight, ClipboardList, GitBranch, HardHat, Plus, Settings2, ShieldCheck, Trash2, Users, X } from "lucide-react";
import ModalDialog from "../../../ui/ModalDialog";
import type { Definition, Duty, Person, Step } from "../../../api/maintenanceWorkflows";

const input = "w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)] disabled:opacity-60";
const button = "inline-flex items-center justify-center gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-xs font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50";
const toggle = (values: string[], value: string) => values.includes(value) ? values.filter(v => v !== value) : [...values, value];
const userIds = (duties: Duty[]) => [...new Set(duties.flatMap(d => d.user_ids))];
type Panel = "node" | "duties" | "notifications" | "managers";
type SelectedNode = { kind: "report" } | { kind: "step"; index: number };

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <section className="space-y-3 border-b border-[var(--line)] pb-5 last:border-0 last:pb-0">
    <div><h4 className="text-sm font-semibold">{title}</h4>{hint && <p className="mt-1 text-xs leading-relaxed text-muted">{hint}</p>}</div>{children}
  </section>;
}

function Option({ title, hint, checked, disabled, onChange }: { title: string; hint?: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-[var(--line)] p-3 text-sm has-[:checked]:border-[var(--brand)] has-[:checked]:bg-[var(--panel-soft)]">
    <input className="mt-0.5 shrink-0 accent-[var(--brand)]" type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
    <span className="min-w-0"><span className="block font-medium">{title}</span>{hint && <span className="mt-0.5 block text-xs leading-relaxed text-muted">{hint}</span>}</span>
  </label>;
}

export default function DistrictWorkflowChart({ draft, people, readonly, onChange, peoplePicker }: {
  draft: Definition; people: Record<number, Person>; readonly: boolean; onChange: (next: Definition) => void;
  peoplePicker: (ids: number[], onChange: (ids: number[]) => void, key: string) => ReactNode;
}) {
  const [node, setNode] = useState<SelectedNode>({ kind: "report" });
  const [panel, setPanel] = useState<Panel>("node");
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1024px)").matches);
  const [panelOpen, setPanelOpen] = useState(() => window.matchMedia("(min-width: 1024px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const update = () => setWide(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const [dutyId, setDutyId] = useState(draft.duties[0]?.id || "");
  const step = node.kind === "step" ? draft.steps[node.index] : null;
  const selectedDuty = draft.duties.find(d => d.id === dutyId) || draft.duties[0];
  const reporters = draft.duties.filter(d => d.report);
  const reportingIds = userIds(reporters);

  function setStep(index: number, next: Step) { onChange({ ...draft, steps: draft.steps.map((s, i) => i === index ? next : s) }); }
  function setDuty(next: Duty) { onChange({ ...draft, duties: draft.duties.map(d => d.id === next.id ? next : d) }); }
  function selectNode(next: SelectedNode) { setNode(next); setPanel("node"); setPanelOpen(true); }
  function openPanel(next: Panel) { setPanel(next); setPanelOpen(true); }
  function editDuty(id: string) { setDutyId(id); openPanel("duties"); }
  function addDuty(report = false) {
    const id = crypto.randomUUID();
    onChange({ ...draft, duties: [...draft.duties, { id, name: report ? "New reporting duty" : "New duty", user_ids: [], report, view_district: false, edit_report: false }] });
    editDuty(id);
  }
  function addReview(index: number) {
    const next: Step = { name: "Review the report", kind: "REVIEW", duty_ids: [], notify_duty_ids: [], rule: "ANY", request_information: true, allow_maintenance: false, allow_geotech: false };
    onChange({ ...draft, steps: [...draft.steps.slice(0, index), next, ...draft.steps.slice(index)] });
    selectNode({ kind: "step", index });
  }
  function moveStep(index: number, direction: -1 | 1) {
    const steps = [...draft.steps];
    [steps[index], steps[index + direction]] = [steps[index + direction], steps[index]];
    onChange({ ...draft, steps }); setNode({ kind: "step", index: index + direction });
  }
  function removeDuty(duty: Duty) {
    onChange({ ...draft, duties: draft.duties.filter(d => d.id !== duty.id), notify_duty_ids: draft.notify_duty_ids.filter(id => id !== duty.id), steps: draft.steps.map(s => ({ ...s, duty_ids: s.duty_ids.filter(id => id !== duty.id), notify_duty_ids: s.notify_duty_ids.filter(id => id !== duty.id) })) });
  }
  const dutyChoices = (ids: string[], onSelect: (ids: string[]) => void) => <div className="space-y-2">{draft.duties.map(d => <Option key={d.id} title={d.name} hint={`${d.user_ids.length} ${d.user_ids.length === 1 ? "person" : "people"}`} disabled={readonly} checked={ids.includes(d.id)} onChange={() => onSelect(toggle(ids, d.id))} />)}{!draft.duties.length && <p className="text-xs text-muted">Create a duty under Duties & people first.</p>}</div>;
  const names = (ids: number[]) => ids.slice(0, 2).map(id => people[id]?.full_name || `User #${id}`).join(", ") + (ids.length > 2 ? ` +${ids.length - 2} more` : "");
  const nodeClass = (selected: boolean) => `group w-full rounded-xl border bg-[var(--panel)] p-3 text-left shadow-sm transition-[border-color,box-shadow] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--brand)] ${selected ? "border-[var(--brand)] ring-2 ring-[color:color-mix(in_oklab,var(--brand)_14%,transparent)]" : "border-[var(--line)] hover:border-[var(--brand)] hover:shadow-md"}`;
  const title = panel === "duties" ? "Duties & people" : panel === "notifications" ? "Notifications" : panel === "managers" ? "Workflow managers" : node.kind === "report" ? "Incident reporting" : step?.kind === "DECISION" ? "Final decision" : "Review step";

  const settings = <aside id="maintenance-workflow-settings" className="flex min-w-0 flex-col border-t border-[var(--line)] bg-[var(--panel)] lg:border-l lg:border-t-0" aria-label="Workflow configuration settings">
      <div className="flex items-center justify-between gap-2 px-4 py-3"><h3 id="maintenance-config-title" className="inline-flex items-center gap-2 text-sm font-semibold"><Settings2 size={15} />Configuration</h3><button type="button" className="rounded p-1.5 text-muted hover:bg-[var(--panel-soft)]" aria-label="Close configuration settings" onClick={() => setPanelOpen(false)}><X size={15} /></button></div>
      <nav className="grid grid-cols-4 gap-1 border-b border-[var(--line)] px-3 pb-3" aria-label="Configuration sections">
        {([
          ["node", node.kind === "report" ? "Reporting" : "Step", ClipboardList],
          ["duties", "Duties", Users], ["notifications", "Alerts", Bell], ["managers", "Managers", ShieldCheck],
        ] as const).map(([key, label, Icon]) => <button key={key} type="button" className={`flex flex-col items-center gap-1 rounded-lg px-1 py-2 text-[11px] font-medium ${panel === key ? "bg-[var(--panel-soft)] text-[var(--brand)]" : "text-muted hover:bg-[var(--panel-soft)]"}`} aria-current={panel === key ? "page" : undefined} aria-label={key === "duties" ? "Duties & people" : key === "notifications" ? "Notification settings" : label} onClick={() => setPanel(key)}><Icon size={16} />{label}</button>)}
      </nav>
      <div key={`${panel}-${node.kind === "step" ? node.index : "report"}-${panel === "duties" ? selectedDuty?.id : ""}`} className="space-y-5 p-4 lg:h-[min(72vh,42rem)] lg:overflow-y-auto">
        <div><h3 className="text-base font-semibold">{title}</h3><p className="mt-1 text-xs leading-relaxed text-muted">{panel === "node" ? node.kind === "report" ? "Choose the duties that can file incidents in this district." : "Define who acts at this point in the workflow." : panel === "duties" ? "Group people by their ERIS responsibilities, independent of job title." : panel === "notifications" ? "Keep the right people informed without giving them decision authority." : "Choose who can maintain this district’s workflow."}</p></div>

        {panel === "node" && node.kind === "report" && <>
          <Group title="Reporting duties" hint="Manage the people and reporting permission for each duty.">
            {reporters.map(d => <button type="button" key={d.id} className="flex w-full items-center gap-2 rounded-lg border border-[var(--line)] p-3 text-left hover:bg-[var(--panel-soft)]" onClick={() => editDuty(d.id)}><Users size={16} className="shrink-0 text-muted" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{d.name}</span><span className="mt-1 block text-xs text-muted">{d.user_ids.length ? names(d.user_ids) : "No people assigned"}</span></span><ChevronRight size={14} className="text-muted" /></button>)}
            {!readonly && <button type="button" className={button} onClick={() => addDuty(true)}><Plus size={13} />Add reporting duty</button>}
          </Group>
          <p className="rounded-lg bg-[var(--panel-soft)] p-3 text-xs leading-relaxed text-muted">Reporters can read their own reports. Additional reading or editing access is set under Duties & people.</p>
          <button type="button" className={button} onClick={() => openPanel("duties")}><Users size={14} />Manage duties & people</button>
        </>}

        {panel === "node" && node.kind === "step" && step && <>
          <label className="grid gap-1.5 text-xs font-medium text-muted">Step name<input className={input} disabled={readonly} value={step.name} onChange={e => setStep(node.index, { ...step, name: e.target.value })} /></label>
          <Group title="Who acts here" hint="Everyone in the selected duties is eligible for this step.">{dutyChoices(step.duty_ids, ids => setStep(node.index, { ...step, duty_ids: ids }))}<button type="button" className={button} onClick={() => openPanel("duties")}><Users size={13} />Edit people in these duties</button></Group>
          <Group title="How approval works"><label className="grid gap-1.5 text-xs font-medium text-muted">Approval rule<select className={input} disabled={readonly} value={step.rule} onChange={e => setStep(node.index, { ...step, rule: e.target.value as Step["rule"] })}><option value="ANY">Any one assigned person</option><option value="ALL">Every assigned person must agree</option></select></label><Option title="Request reporter information" hint="Let reviewers return the report for clarification." checked={step.request_information} disabled={readonly} onChange={checked => setStep(node.index, { ...step, request_information: checked })} /></Group>
          <Group title={step.kind === "DECISION" ? "Allowed outcomes" : "Can the workflow end here?"} hint={step.kind === "REVIEW" ? "Otherwise this review continues to the next step." : "Enable at least one outcome for the final decision."}>
            <Option title="Maintenance handles it" hint="End maintenance review without a GeoTech assessment." checked={step.allow_maintenance} disabled={readonly} onChange={checked => setStep(node.index, { ...step, allow_maintenance: checked })} />
            {step.kind === "DECISION" && <Option title="Send to GeoTech" hint="Refer to the district’s GeoTech office for assessment." checked={step.allow_geotech} disabled={readonly} onChange={checked => setStep(node.index, { ...step, allow_geotech: checked })} />}
          </Group>
          <Group title="Notify at this step" hint="These duties are informed when this step is reached.">{dutyChoices(step.notify_duty_ids, ids => setStep(node.index, { ...step, notify_duty_ids: ids }))}</Group>
          {!readonly && step.kind === "REVIEW" && <Group title="Position in workflow"><div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={node.index === 0} onClick={() => moveStep(node.index, -1)}><ArrowUp size={13} />Move up</button><button type="button" className={button} disabled={node.index === draft.steps.length - 2} onClick={() => moveStep(node.index, 1)}><ArrowDown size={13} />Move down</button><button type="button" className={`${button} text-[var(--bad)]`} onClick={() => { onChange({ ...draft, steps: draft.steps.filter((_, i) => i !== node.index) }); selectNode({ kind: "step", index: Math.min(node.index, draft.steps.length - 2) }); }}><Trash2 size={13} />Remove step</button></div></Group>}
        </>}

        {panel === "duties" && <>
          <div className="flex items-end gap-2"><label className="grid min-w-0 flex-1 gap-1.5 text-xs font-medium text-muted">Select a duty<select className={input} value={selectedDuty?.id || ""} onChange={e => setDutyId(e.target.value)}>{draft.duties.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>{!readonly && <button type="button" className={button} onClick={() => addDuty()}><Plus size={13} />New</button>}</div>
          {selectedDuty && <>
            <label className="grid gap-1.5 text-xs font-medium text-muted">Duty name<input className={input} disabled={readonly} value={selectedDuty.name} onChange={e => setDuty({ ...selectedDuty, name: e.target.value })} /></label>
            <Group title="People assigned">{peoplePicker(selectedDuty.user_ids, ids => setDuty({ ...selectedDuty, user_ids: ids }), selectedDuty.id)}</Group>
            <Group title="Access & permissions">
              <Option title="Report incidents" hint="File incidents and read their own reports." checked={selectedDuty.report} disabled={readonly} onChange={checked => setDuty({ ...selectedDuty, report: checked })} />
              <Option title="Read all district reports" hint="Read reports beyond those assigned to this duty." checked={selectedDuty.view_district} disabled={readonly} onChange={checked => setDuty({ ...selectedDuty, view_district: checked })} />
              <Option title="Edit reports" hint="Update descriptions and attach evidence during maintenance review." checked={selectedDuty.edit_report} disabled={readonly} onChange={checked => setDuty({ ...selectedDuty, edit_report: checked })} />
            </Group>
            {!readonly && <button type="button" className={`${button} text-[var(--bad)]`} onClick={() => removeDuty(selectedDuty)}><Trash2 size={13} />Remove duty</button>}
          </>}
        </>}

        {panel === "notifications" && <Group title="Notify throughout the workflow" hint="These duties receive notifications when reports are filed, reviewed, returned or decided. Step-specific recipients are set on each chart card.">{dutyChoices(draft.notify_duty_ids, ids => onChange({ ...draft, notify_duty_ids: ids }))}</Group>}
        {panel === "managers" && <>
          <Group title="District workflow managers">{peoplePicker(draft.manager_user_ids, ids => onChange({ ...draft, manager_user_ids: ids }), "managers")}</Group>
          <p className="rounded-lg bg-[var(--panel-soft)] p-3 text-xs leading-relaxed text-muted">Managers can change duties, people and review steps for this district. Keep at least one manager assigned. Administrators can always manage or recover access.</p>
        </>}
      </div>
    </aside>;

  return <div className={`grid min-w-0 overflow-hidden rounded-xl border border-[var(--line)] ${panelOpen ? "lg:grid-cols-[minmax(0,1fr)_minmax(20rem,23rem)] xl:grid-cols-[minmax(0,1fr)_25rem]" : ""}`}>
    <div className="flex min-w-0 flex-col bg-[var(--panel-soft)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] bg-[var(--panel)] px-4 py-3">
        <div className="flex items-center gap-2"><GitBranch size={16} className="text-muted" /><h3 className="text-sm font-semibold">Workflow chart</h3><span className="hidden text-xs text-muted xl:inline">{draft.steps.filter(s => s.kind === "REVIEW").length} review {draft.steps.filter(s => s.kind === "REVIEW").length === 1 ? "step" : "steps"}</span></div>
        <button type="button" className={button} aria-expanded={panelOpen} aria-controls="maintenance-workflow-settings" onClick={() => setPanelOpen(!panelOpen)}><Settings2 size={14} />{panelOpen ? "Hide settings" : "Show settings"}</button>
      </div>
      <div className="min-h-[28rem] overflow-y-auto px-5 py-5 sm:px-8 lg:h-[min(72vh,42rem)] lg:min-h-0" style={{ backgroundImage: "radial-gradient(var(--line) 1px, transparent 1px)", backgroundSize: "20px 20px" }}>
        <div className="mx-auto flex w-full max-w-[23rem] flex-col items-center" aria-label="Maintenance review path">
          <button type="button" className={nodeClass(node.kind === "report" && panel === "node")} aria-pressed={node.kind === "report" && panel === "node"} onClick={() => selectNode({ kind: "report" })}>
            <div className="mb-1.5 flex items-center justify-between gap-2"><span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted"><ClipboardList size={13} />Start</span><span className="inline-flex items-center gap-2 text-[10px] text-muted">{reportingIds.length} reporters<ChevronRight size={14} /></span></div>
            <span className="block text-sm font-semibold">Report an incident</span><span className="mt-1 block truncate text-xs text-muted" title={names(reportingIds)}>{reportingIds.length ? names(reportingIds) : "Choose who can report"}</span>

          </button>
          {draft.steps.map((s, index) => {
            const assigned = userIds(draft.duties.filter(d => s.duty_ids.includes(d.id)));
            const notified = userIds(draft.duties.filter(d => s.notify_duty_ids.includes(d.id)));
            return <div key={index} className="flex w-full flex-col items-center">
              <div className="relative flex h-9 w-full shrink-0 items-center justify-center"><span aria-hidden className="absolute inset-y-0 left-1/2 w-px bg-[var(--line)]" />{!readonly ? <button type="button" className="relative flex h-7 w-7 items-center justify-center rounded-full border border-dashed border-[var(--line)] bg-[var(--panel)] text-muted hover:border-[var(--brand)] hover:text-[var(--brand)]" aria-label={`Add review step ${index + 1}`} title="Add a review step here" onClick={() => addReview(index)}><Plus size={14} /></button> : <ArrowDown size={14} className="relative bg-[var(--panel-soft)] text-muted" aria-hidden />}</div>
              <button type="button" className={nodeClass(node.kind === "step" && node.index === index && panel === "node")} aria-label={`Configure ${s.name}`} aria-pressed={node.kind === "step" && node.index === index && panel === "node"} onClick={() => selectNode({ kind: "step", index })}>
                <div className="mb-1.5 flex items-center justify-between gap-2"><span className={`inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider ${s.kind === "DECISION" ? "text-[var(--brand)]" : "text-muted"}`}>{s.kind === "DECISION" ? <GitBranch size={13} /> : <ShieldCheck size={13} />}{s.kind === "DECISION" ? "Final decision" : `Review ${index + 1}`}</span><span className={`inline-flex items-center gap-2 text-[10px] ${assigned.length ? "text-muted" : "text-[var(--bad)]"}`}>{assigned.length ? s.rule === "ALL" ? "Everyone agrees" : "Any one person" : "Needs people"}<ChevronRight size={14} /></span></div>
                <span className="block text-sm font-semibold">{s.name || "Name this step"}</span><span className="mt-1 block truncate text-xs text-muted" title={names(assigned)}>{assigned.length ? names(assigned) : "Choose who reviews"}</span>
                {(!!notified.length || (s.kind === "REVIEW" && s.allow_maintenance)) && <span className="mt-2 flex flex-wrap items-center gap-2">{!!notified.length && <span className="inline-flex items-center gap-1 text-[11px] text-muted"><Bell size={12} />{notified.length} notified</span>}{s.kind === "REVIEW" && s.allow_maintenance && <span className="text-[11px] text-[var(--good)]">May end with maintenance</span>}</span>}
              </button>
            </div>;
          })}
          <div aria-hidden className="h-5 w-px bg-[var(--line)]" />
          <div className="relative grid w-full grid-cols-2 gap-3 pt-5" aria-label="Final outcomes">
            <span aria-hidden className="absolute left-1/4 right-1/4 top-0 h-px bg-[var(--line)]" />
            {([
              { label: "Maintenance", hint: "Handle the repair", allowed: draft.steps[draft.steps.length - 1].allow_maintenance, icon: HardHat, color: "var(--good)" },
              { label: "GeoTech", hint: "Send for assessment", allowed: draft.steps[draft.steps.length - 1].allow_geotech, icon: GitBranch, color: "var(--brand)" },
            ]).map(({ label, hint, allowed, icon: Icon, color }) => <div key={label} className="relative min-w-0 before:absolute before:-top-5 before:left-1/2 before:h-5 before:w-px before:bg-[var(--line)]"><button type="button" className={`w-full rounded-xl border border-[var(--line)] bg-[var(--panel)] p-3 text-center hover:border-[var(--brand)] ${allowed ? "" : "opacity-50"}`} onClick={() => selectNode({ kind: "step", index: draft.steps.length - 1 })} aria-label={`Configure ${label} outcome`}><span className="flex items-center justify-center gap-1.5 text-xs font-semibold"><Icon size={15} style={{ color }} />{label}</span><span className="mt-1 block text-[10px] text-muted">{allowed ? hint : "Not enabled"}</span></button></div>)}
          </div>
        </div>
      </div>
      <div className="border-t border-[var(--line)] bg-[var(--panel)] px-4 py-3 text-xs text-muted">{readonly ? "View only · District workflow managers and administrators can edit." : "Select a card to edit it. Use + between cards to add a review."}</div>
    </div>

    {panelOpen && (wide ? settings : <ModalDialog titleId="maintenance-config-title" onClose={() => setPanelOpen(false)}
      overlayClassName="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:p-4"
      panelClassName="max-h-[85dvh] w-full overflow-y-auto rounded-t-2xl border border-[var(--line)] bg-[var(--panel)] shadow-2xl sm:max-w-xl sm:rounded-2xl">
      {settings}
    </ModalDialog>)}
  </div>;
}

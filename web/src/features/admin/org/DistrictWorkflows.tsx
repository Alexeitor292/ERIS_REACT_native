import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import DistrictWorkflowChart from "./DistrictWorkflowChart";
import SimpleMaintenanceWorkflowEditor from "./SimpleMaintenanceWorkflowEditor";
import WorkflowPeoplePicker from "./WorkflowPeoplePicker";
import { createInitialDefinition, fromSimpleWorkflow, isSimpleDefinition, toSimpleWorkflow, validateSimpleWorkflow } from "./simpleMaintenanceWorkflow";
import { getWorkflows, publishWorkflow, type Definition, type DistrictWorkflow, type Person } from "../../../api/maintenanceWorkflows";
import { DISTRICT_HQ } from "../../../api/orgTree";
import type { MaintenanceDistrict, MaintenancePayload } from "../../../api/orgTree";
import { useAuth } from "../../../auth/AuthContext";

const input = "rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm";

function initial(manager: number, roster?: MaintenanceDistrict): Definition {
  const crew = roster?.crew.map(person => person.id) ?? [];
  const coordinators = roster?.coordinators.map(person => person.id) ?? [];
  const definition = createInitialDefinition(manager, crew, coordinators.length ? coordinators : [manager]);
  const simple = toSimpleWorkflow(definition);
  return fromSimpleWorkflow({ ...simple, managerIds: [...new Set([manager, ...coordinators])] });
}

export default function DistrictWorkflows({ maintenance, onPublished }: { maintenance?: MaintenancePayload | null; onPublished?: () => void }) {
  const { me, refreshMe } = useAuth();
  const [districts, setDistricts] = useState<DistrictWorkflow[]>([]);
  const [district, setDistrict] = useState("01");
  const [draft, setDraft] = useState<Definition>(() => initial(me!.id));
  const [people, setPeople] = useState<Record<number, Person>>({ [me!.id]: { id: me!.id, full_name: me!.full_name || me!.email } });
  const [dirty, setDirty] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const current = districts.find(d => d.district === district);
  const readonly = !current?.can_manage || busy;
  const roster = maintenance?.districts.find(item => item.district === district);
  const simple = isSimpleDefinition(draft);
  const guided = simple && !showAdvanced;
  const missing = simple ? validateSimpleWorkflow(toSimpleWorkflow(draft), people) : [];
  const cannotPublish = busy || (!!current?.definition && !dirty) || (simple && missing.length > 0);
  const remember = (items: Person[]) => setPeople(p => ({ ...p, ...Object.fromEntries(items.map(x => [x.id, x])) }));
  useEffect(() => { getWorkflows().then(r => {
    setDistricts(r.districts);
    const first = r.districts.find(d => d.can_manage && d.definition) || r.districts.find(d => d.can_manage) || r.districts[0];
    if (!first) { setError("No maintenance districts are available."); return; }
    setDistrict(first.district); setDraft(first.definition || initial(me!.id, maintenance?.districts.find(item => item.district === first.district)));
    remember(r.districts.flatMap(d => d.people));
  }).catch(e => setError(e.message)); }, []);
  useEffect(() => {
    if (!maintenance) return;
    remember(maintenance.districts.flatMap(item => [...item.coordinators, ...item.crew]));
    if (current && !current.definition && !dirty) setDraft(initial(me!.id, roster));
  }, [maintenance, district, districts, dirty]);
  const change = (next: Definition) => { setDraft(next); setDirty(true); setError(""); setNotice(""); };
  async function save() {
    setBusy(true); setError("");
    try {
      const result = await publishWorkflow(district, current!.revision, draft);
      setDistricts(ds => ds.map(d => d.district === district ? { ...result, people: Object.values(people) } : d));
      setDraft(result.definition!); setDirty(false); setNotice(`District ${Number(district)} workflow published. New reports will follow revision ${result.revision}.`);
      await refreshMe(); onPublished?.();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not publish workflow"); }
    finally { setBusy(false); }
  }
  return <section className="space-y-4" aria-label="District maintenance workflows">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-lg font-semibold">District maintenance workflows</h2><p className="mt-1 text-sm text-muted">Choose who reports, who reviews, and who makes the final decision.</p></div>
      {current?.can_manage && !guided && <button type="button" className="inline-flex items-center gap-2 rounded-lg bg-[var(--brand)] px-4 py-2.5 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50" disabled={cannotPublish} onClick={() => void save()}><Check size={15} />{busy ? "Publishing…" : "Publish workflow"}</button>}
    </div>
    <div className="flex flex-wrap items-end justify-between gap-3">
      <label className="grid w-full max-w-sm gap-1.5 text-xs font-medium text-muted">District<select aria-label="Maintenance district" className={input} value={district} disabled={busy || !districts.length} onChange={e => {
        if (dirty && !window.confirm("Discard your unsaved workflow changes?")) return;
        const next = districts.find(d => d.district === e.target.value)!;
        setDistrict(next.district); setDraft(next.definition || initial(me!.id, maintenance?.districts.find(item => item.district === next.district))); setDirty(false); setShowAdvanced(false); setError(""); setNotice("");
      }}>{districts.map(d => <option key={d.district} value={d.district}>District {Number(d.district)} · {DISTRICT_HQ[d.district]}</option>)}</select></label>
      {current && <span className={`rounded-full border px-2.5 py-1 text-xs ${dirty ? "border-[var(--brand)] text-[var(--brand)]" : "border-[var(--line)] text-muted"}`}>{dirty ? "Unpublished changes" : current.definition ? `Published · Revision ${current.revision}` : "Not configured yet"}</span>}
    </div>
    {error && <p role="alert" className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3 text-sm text-[var(--bad)]">{error}</p>}
    {notice && <p role="status" className="rounded-lg border border-[var(--line)] p-3 text-sm text-[var(--good)]">{notice}</p>}
    {!current ? <p className="text-sm text-muted">Loading workflows…</p> : !current.definition && !current.can_manage ? <p className="text-sm text-muted">This district uses the current coordinator process. An administrator can set up its first configurable workflow and name district managers.</p> : <>
      {!current.definition && roster && <p className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3 text-sm text-muted">We started with this district’s current crew and coordinators. Check the suggested people before publishing.</p>}
      {guided ? <SimpleMaintenanceWorkflowEditor district={district} draft={draft} people={people} roster={roster} readonly={readonly} onChange={change} onPeople={remember} /> : <>
        <p className="rounded-lg bg-[var(--panel-soft)] p-3 text-sm text-muted">{simple ? "Use the advanced editor for shared duties, report permissions, and step-specific notifications." : "This district has shared duties or extra permissions. The advanced editor preserves those settings."}</p>
        <DistrictWorkflowChart key={district} draft={draft} people={people} readonly={readonly} onChange={change}
          peoplePicker={(ids, onChange, key) => <WorkflowPeoplePicker key={`${district}-${key}`} district={district} label={key === "managers" ? "Workflow managers" : draft.duties.find(duty => duty.id === key)?.name || "People assigned"} ids={ids} people={people} onPeople={remember} disabled={readonly} onChange={onChange}
            suggestions={roster ? [{ label: "District coordinators", people: roster.coordinators }, { label: "District crew", people: roster.crew }] : []} />} />
      </>}
      {guided && current.can_manage && <div className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 sm:p-5">
        <div><h3 className="text-sm font-semibold">Ready to use this workflow?</h3>{missing.length ? <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-[var(--bad)]">{missing.map(message => <li key={message}>{message}</li>)}</ul> : <p className="mt-1 text-sm text-muted">New reports will use this review path. Existing reports keep their current path.</p>}</div>
        <button type="button" className="inline-flex items-center gap-2 rounded-lg bg-[var(--brand)] px-4 py-2.5 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50" disabled={cannotPublish} onClick={() => void save()}><Check size={15} />{busy ? "Publishing…" : current.definition ? "Publish changes" : "Publish workflow"}</button>
      </div>}
      {current.can_manage && simple && <button type="button" className="text-sm font-medium text-[var(--brand)] underline-offset-4 hover:underline" onClick={() => setShowAdvanced(value => !value)}>{showAdvanced ? "Back to simple editor" : "Need more options? Open advanced editor"}</button>}
      {!guided && <p className="text-xs leading-relaxed text-muted">Publishing applies to new reports. Existing reports keep their review path until a manager explicitly restarts them on the latest workflow.</p>}
    </>}
  </section>;
}

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import DistrictWorkflowChart from "./DistrictWorkflowChart";
import { getWorkflows, publishWorkflow, workflowPeople, type Definition, type DistrictWorkflow, type Person, type Step } from "../../../api/maintenanceWorkflows";
import { DISTRICT_HQ } from "../../../api/orgTree";
import { useAuth } from "../../../auth/AuthContext";

const input = "rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm";
const finalStep: Step = { name: "Maintenance or GeoTech decision", kind: "DECISION", duty_ids: ["decision"], notify_duty_ids: [], rule: "ANY", request_information: true, allow_maintenance: true, allow_geotech: true };

function initial(manager: number): Definition {
  return { manager_user_ids: [manager], notify_duty_ids: [], duties: [
    { id: "reporters", name: "Incident reporters", user_ids: [], report: true, view_district: false, edit_report: false },
    { id: "decision", name: "Final decision makers", user_ids: [], report: false, view_district: true, edit_report: false },
    { id: "informed", name: "Keep informed", user_ids: [], report: false, view_district: false, edit_report: false },
  ], steps: [finalStep] };
}

function People({ district, ids, people, onPeople, onChange, disabled }: { district: string; ids: number[]; people: Record<number, Person>; onPeople: (items: Person[]) => void; onChange: (ids: number[]) => void; disabled: boolean }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Person[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!query.trim() || disabled) { setHits([]); return; }
    let cancelled = false;
    const timer = setTimeout(() => workflowPeople(district, query).then(r => { if (!cancelled) { setHits(r.items); setError(""); } }).catch(e => { if (!cancelled) setError(e.message); }), 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, district, disabled]);
  return <div className="space-y-2">
    <div className="flex flex-wrap gap-2">{ids.map(id => <span key={id} className="inline-flex items-center gap-2 rounded-md bg-[var(--panel-soft)] px-2 py-1 text-sm">{people[id]?.full_name || `User #${id}`}{people[id]?.is_active === false ? " (inactive)" : ""}{!disabled && <button type="button" aria-label={`Remove ${people[id]?.full_name || id}`} onClick={() => onChange(ids.filter(x => x !== id))}>×</button>}</span>)}</div>
    {!disabled && <><label className="grid gap-1 text-xs text-muted">Add people by name or email<input className={input} value={query} onChange={e => setQuery(e.target.value)} autoComplete="off" /></label>
    {error && <p role="alert" className="text-sm text-[var(--bad)]">{error}</p>}
    {!!hits.length && <div className="max-h-48 overflow-y-auto rounded-md border border-[var(--line)]">{hits.filter(p => !ids.includes(p.id)).map(p => <button type="button" key={p.id} className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--panel-soft)]" onClick={() => { onPeople([p]); onChange([...ids, p.id]); setQuery(""); }}>{p.full_name}<span className="ml-2 text-xs text-muted">{p.email}</span></button>)}</div>}</>}
    {!ids.length && disabled && <p className="text-sm text-muted">No people assigned.</p>}
  </div>;
}

export default function DistrictWorkflows({ onPublished }: { onPublished?: () => void }) {
  const { me, refreshMe } = useAuth();
  const [districts, setDistricts] = useState<DistrictWorkflow[]>([]);
  const [district, setDistrict] = useState("01");
  const [draft, setDraft] = useState<Definition>(() => initial(me!.id));
  const [people, setPeople] = useState<Record<number, Person>>({ [me!.id]: { id: me!.id, full_name: me!.full_name || me!.email } });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const current = districts.find(d => d.district === district);
  const readonly = !current?.can_manage || busy;
  const remember = (items: Person[]) => setPeople(p => ({ ...p, ...Object.fromEntries(items.map(x => [x.id, x])) }));
  useEffect(() => { getWorkflows().then(r => {
    setDistricts(r.districts);
    const first = r.districts.find(d => d.can_manage && d.definition) || r.districts.find(d => d.can_manage) || r.districts[0];
    setDistrict(first.district); setDraft(first.definition || initial(me!.id));
    remember(r.districts.flatMap(d => d.people));
  }).catch(e => setError(e.message)); }, []);
  const change = (next: Definition) => { setDraft(next); setDirty(true); setNotice(""); };
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
      <div><h2 className="text-lg font-semibold">District maintenance workflows</h2><p className="mt-1 text-sm text-muted">Build the review path. Select a card to configure who acts and what happens next.</p></div>
      {current?.can_manage && <button type="button" className="inline-flex items-center gap-2 rounded-lg bg-[var(--brand)] px-4 py-2.5 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50" disabled={busy || (!dirty && !!current.definition)} onClick={() => void save()}><Check size={15} />{busy ? "Publishing…" : "Publish workflow"}</button>}
    </div>
    <div className="flex flex-wrap items-end justify-between gap-3">
      <label className="grid w-full max-w-sm gap-1.5 text-xs font-medium text-muted">District<select aria-label="Maintenance district" className={input} value={district} disabled={busy || !districts.length} onChange={e => {
        if (dirty && !window.confirm("Discard your unsaved workflow changes?")) return;
        const next = districts.find(d => d.district === e.target.value)!;
        setDistrict(next.district); setDraft(next.definition || initial(me!.id)); setDirty(false); setError(""); setNotice("");
      }}>{districts.map(d => <option key={d.district} value={d.district}>District {Number(d.district)} · {DISTRICT_HQ[d.district]}</option>)}</select></label>
      {current && <span className={`rounded-full border px-2.5 py-1 text-xs ${dirty ? "border-[var(--brand)] text-[var(--brand)]" : "border-[var(--line)] text-muted"}`}>{dirty ? "Unpublished changes" : current.definition ? `Published · Revision ${current.revision}` : "Not configured yet"}</span>}
    </div>
    {error && <p role="alert" className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3 text-sm text-[var(--bad)]">{error}</p>}
    {notice && <p role="status" className="rounded-lg border border-[var(--line)] p-3 text-sm text-[var(--good)]">{notice}</p>}
    {!current ? <p className="text-sm text-muted">Loading workflows…</p> : !current.definition && !current.can_manage ? <p className="text-sm text-muted">This district uses the current coordinator process. An administrator can set up its first configurable workflow and name district managers.</p> : <>
      <DistrictWorkflowChart key={district} draft={draft} people={people} readonly={readonly} onChange={change}
        peoplePicker={(ids, onChange, key) => <People key={`${district}-${key}`} district={district} ids={ids} people={people} onPeople={remember} disabled={readonly} onChange={onChange} />} />
      <p className="text-xs leading-relaxed text-muted">Publishing applies to new reports. Existing reports keep their review path until a manager explicitly restarts them on the latest workflow.</p>
    </>}
  </section>;
}

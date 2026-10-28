import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { Definition, Person } from "../../../api/maintenanceWorkflows";
import type { MaintenanceDistrict } from "../../../api/orgTree";
import WorkflowPeoplePicker from "./WorkflowPeoplePicker";
import { fromSimpleWorkflow, toSimpleWorkflow, type SimpleReview, type SimpleWorkflow } from "./simpleMaintenanceWorkflow";

const input = "w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)] disabled:opacity-60";
const button = "inline-flex items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50";

function StepHeading({ number, title, hint }: { number: number; title: string; hint: string }) {
  return <div className="flex items-start gap-3">
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--brand)] text-sm font-bold text-white">{number}</span>
    <div><h3 className="text-base font-semibold">{title}</h3><p className="mt-1 text-sm text-muted">{hint}</p></div>
  </div>;
}

export default function SimpleMaintenanceWorkflowEditor({ district, draft, people, roster, readonly, onChange, onPeople }: {
  district: string;
  draft: Definition;
  people: Record<number, Person>;
  roster?: MaintenanceDistrict;
  readonly: boolean;
  onChange: (definition: Definition) => void;
  onPeople: (items: Person[]) => void;
}) {
  const workflow = toSimpleWorkflow(draft);
  const update = (next: SimpleWorkflow) => onChange(fromSimpleWorkflow(next));
  const updateReview = (id: string, patch: Partial<SimpleReview>) => update({ ...workflow, reviews: workflow.reviews.map(step => step.id === id ? { ...step, ...patch } : step) });
  const moveReview = (index: number, direction: -1 | 1) => {
    const reviews = [...workflow.reviews];
    [reviews[index], reviews[index + direction]] = [reviews[index + direction], reviews[index]];
    update({ ...workflow, reviews });
  };
  const crew = roster?.crew ?? [];
  const coordinators = roster?.coordinators ?? [];
  const crewSuggestion = crew.length ? [{ label: `Add district crew (${crew.length})`, people: crew }] : [];
  const coordinatorSuggestion = coordinators.length ? [{ label: `Add district coordinators (${coordinators.length})`, people: coordinators }] : [];

  return <div className="space-y-4" aria-label="Set up district maintenance workflow">
    {!draft.steps.length && <p role="alert" className="text-sm text-[var(--bad)]">This workflow has no decision step. Reload the page before editing.</p>}
    <section className="space-y-4 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 sm:p-5">
      <StepHeading number={1} title="Choose who can report" hint="These people can file maintenance incidents for this district and read their own reports." />
      <WorkflowPeoplePicker district={district} label="People who can report" ids={workflow.reporterIds} people={people} suggestions={crewSuggestion} onPeople={onPeople} onChange={reporterIds => update({ ...workflow, reporterIds })} disabled={readonly} />
      {!workflow.reporterIds.length && <p className="text-sm text-[var(--bad)]">Add at least one reporter before publishing.</p>}
      {!readonly && <p className="text-xs leading-relaxed text-muted">Publishing this workflow replaces the district’s current role-based reporting permission. Check this list so field staff do not lose access.</p>}
    </section>

    <section className="space-y-4 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 sm:p-5">
      <StepHeading number={2} title="Add review steps if needed" hint="Reports go through these steps in order. A district can also send reports straight to the final decision." />
      {workflow.reviews.map((step, index) => <div key={step.id} className="space-y-3 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-4">
        <div className="flex items-center justify-between gap-2"><h4 className="text-sm font-semibold">Review {index + 1}</h4>{!readonly && <div className="flex items-center gap-1">
          <button type="button" className={button} disabled={index === 0} onClick={() => moveReview(index, -1)} aria-label={`Move review ${index + 1} up`}><ArrowUp size={14} /></button>
          <button type="button" className={button} disabled={index === workflow.reviews.length - 1} onClick={() => moveReview(index, 1)} aria-label={`Move review ${index + 1} down`}><ArrowDown size={14} /></button>
          <button type="button" className={`${button} text-[var(--bad)]`} onClick={() => update({ ...workflow, reviews: workflow.reviews.filter(item => item.id !== step.id) })} aria-label={`Remove review ${index + 1}`}><Trash2 size={14} /></button>
        </div>}</div>
        <label className="grid gap-1.5 text-sm font-medium">What should this review be called?<input className={input} maxLength={100} value={step.name} disabled={readonly} onChange={e => updateReview(step.id, { name: e.target.value })} placeholder="For example: Supervisor review" /></label>
        <WorkflowPeoplePicker district={district} label={`Who reviews at step ${index + 1}?`} ids={step.userIds} people={people} suggestions={coordinatorSuggestion} onPeople={onPeople} onChange={userIds => updateReview(step.id, { userIds })} disabled={readonly} />
        <label className="grid gap-1.5 text-sm font-medium">When does this step finish?<select className={input} value={step.rule} disabled={readonly} onChange={e => updateReview(step.id, { rule: e.target.value as SimpleReview["rule"] })}><option value="ANY">When any one reviewer approves</option><option value="ALL">When every reviewer approves</option></select></label>
        {!step.userIds.length && <p className="text-sm text-[var(--bad)]">Choose at least one reviewer or remove this step.</p>}
      </div>)}
      {!workflow.reviews.length && <p className="rounded-lg bg-[var(--panel-soft)] p-3 text-sm text-muted">No extra review step. The report goes directly to the final decision.</p>}
      {!readonly && <button type="button" className={button} onClick={() => update({ ...workflow, reviews: [...workflow.reviews, { id: `review_${crypto.randomUUID()}`, name: "Review the report", userIds: [], rule: "ANY" }] })}><Plus size={16} />Add a review step</button>}
    </section>

    <section className="space-y-4 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 sm:p-5">
      <StepHeading number={3} title="Choose the final decision makers" hint="Any one of them can decide whether Maintenance handles the work or the report goes to GeoTech." />
      <WorkflowPeoplePicker district={district} label="People who make the final decision" ids={workflow.decisionIds} people={people} suggestions={coordinatorSuggestion} onPeople={onPeople} onChange={decisionIds => update({ ...workflow, decisionIds })} disabled={readonly} />
      {!workflow.decisionIds.length && <p className="text-sm text-[var(--bad)]">Add at least one final decision maker.</p>}
      <fieldset className="space-y-2"><legend className="text-sm font-medium">Which outcomes can they choose?</legend>
        <label className="flex items-center gap-2 rounded-lg border border-[var(--line)] p-3 text-sm"><input type="checkbox" className="accent-[var(--brand)]" checked={workflow.allowMaintenance} disabled={readonly} onChange={e => update({ ...workflow, allowMaintenance: e.target.checked })} />Maintenance handles it</label>
        <label className="flex items-center gap-2 rounded-lg border border-[var(--line)] p-3 text-sm"><input type="checkbox" className="accent-[var(--brand)]" checked={workflow.allowGeotech} disabled={readonly} onChange={e => update({ ...workflow, allowGeotech: e.target.checked })} />Send to GeoTech for assessment</label>
      </fieldset>
      {!workflow.allowMaintenance && !workflow.allowGeotech && <p className="text-sm text-[var(--bad)]">Allow at least one outcome.</p>}
    </section>

    <details className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 sm:p-5">
      <summary className="cursor-pointer text-sm font-semibold">Managers and notifications</summary>
      <div className="mt-4 space-y-5">
        <div><p className="mb-2 text-sm text-muted">Managers can change this district’s workflow later. Administrators can always recover access.</p><WorkflowPeoplePicker district={district} label="Workflow managers" ids={workflow.managerIds} people={people} suggestions={coordinatorSuggestion} onPeople={onPeople} onChange={managerIds => update({ ...workflow, managerIds })} disabled={readonly} />{!workflow.managerIds.length && <p className="mt-2 text-sm text-[var(--bad)]">Keep at least one manager.</p>}</div>
        <div><p className="mb-2 text-sm text-muted">These people get updates without having to approve a step.</p><WorkflowPeoplePicker district={district} label="Keep informed" ids={workflow.notifyIds} people={people} suggestions={coordinatorSuggestion} onPeople={onPeople} onChange={notifyIds => update({ ...workflow, notifyIds })} disabled={readonly} /></div>
      </div>
    </details>

    <div className="rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-4 text-sm">
      <h3 className="font-semibold">What new reports will do</h3>
      <ol className="mt-2 list-inside list-decimal space-y-1 text-muted"><li>One of {workflow.reporterIds.length} assigned {workflow.reporterIds.length === 1 ? "person" : "people"} files a report.</li>{workflow.reviews.map((step, index) => <li key={step.id}>{step.name.trim() || `Review ${index + 1}`} — {step.userIds.length} {step.userIds.length === 1 ? "reviewer" : "reviewers"}.</li>)}<li>{workflow.decisionIds.length} final {workflow.decisionIds.length === 1 ? "decision maker" : "decision makers"} chooses the outcome.</li></ol>
      <p className="mt-3 text-xs text-muted">Publishing applies to new reports. Reports already in progress keep their current path.</p>
    </div>
  </div>;
}

import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { Definition, Person } from "../../../api/maintenanceWorkflows";
import ModalDialog from "../../../ui/ModalDialog";
import PanCanvas from "../../../ui/PanCanvas";
import { DistrictContactDefault } from "../../fieldNotices/DistrictContactPicker";
import { fromSimpleWorkflow, toSimpleWorkflow, type SimpleReview, type SimpleWorkflow } from "./simpleMaintenanceWorkflow";
import WorkflowPeoplePicker from "./WorkflowPeoplePicker";

const REPORT_TONE = "var(--brand)";
const REVIEW_TONE = "var(--accent)";
const DECISION_TONE = "#c96f12";
/** A long list opens short; the rest is a click away. Hiding one or two would save nothing. */
const SHOWN_AT_FIRST = 6;
const SHORTENED_ABOVE = 8;

type Picking = { label: string; ids: number[]; apply: (ids: number[]) => void };

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
}

/**
 * A district's maintenance workflow as a tree, on the same canvas and in the same cards
 * as a GeoTech office: who reports, each review, the final decision, and where it goes.
 * People are added and removed where they appear.
 */
export default function WorkflowTreeEditor({
  district,
  draft,
  people,
  readonly,
  onChange,
  onPeople,
  contactKey,
  dirty,
}: {
  district: string;
  draft: Definition;
  people: Record<number, Person>;
  readonly: boolean;
  onChange: (definition: Definition) => void;
  onPeople: (items: Person[]) => void;
  /** Changes when the people who can be named District Contact may have changed. */
  contactKey: string;
  dirty: boolean;
}) {
  const [picking, setPicking] = useState<Picking | null>(null);
  const workflow = toSimpleWorkflow(draft);
  const update = (patch: Partial<SimpleWorkflow>) => onChange(fromSimpleWorkflow({ ...workflow, ...patch }));
  const updateReview = (id: string, patch: Partial<SimpleReview>) =>
    update({ reviews: workflow.reviews.map((step) => (step.id === id ? { ...step, ...patch } : step)) });
  const moveReview = (index: number, direction: -1 | 1) => {
    const reviews = [...workflow.reviews];
    [reviews[index], reviews[index + direction]] = [reviews[index + direction], reviews[index]];
    update({ reviews });
  };
  const addReview = () =>
    update({ reviews: [...workflow.reviews, { id: `review_${crypto.randomUUID()}`, name: "Review the report", userIds: [], rule: "ANY" }] });
  const pick = (label: string, ids: number[], apply: (next: number[]) => void) => setPicking({ label, ids, apply });
  const shared = { people, readonly };
  const inThisWorkflow = [...new Set(draft.duties.flatMap((duty) => duty.user_ids))].flatMap((id) => (people[id] ? [people[id]] : []));

  return (
    <div className="space-y-3">
      <PanCanvas label={`District ${Number(district)} maintenance workflow`} className="h-[min(74vh,50rem)] min-h-[28rem] rounded-xl border border-[var(--line)] bg-[var(--panel)]">
        <div className="org-tree flex w-max flex-col items-center px-8 pb-10 pt-6">
          <StepCard
            number={1}
            tone={REPORT_TONE}
            title="Who can report"
            aside={<span className="text-xs text-muted">{countLabel(workflow.reporterIds.length)}</span>}
            missing={workflow.reporterIds.length ? null : "Choose who can report"}
            {...shared}
            ids={workflow.reporterIds}
            addLabel="Reporter"
            onRemove={(ids) => update({ reporterIds: ids })}
            onAdd={() => pick("People who can report", workflow.reporterIds, (reporterIds) => update({ reporterIds }))}
          />
          <div className="org-stem" />

          {workflow.reviews.map((step, index) => (
            <div key={step.id} className="flex flex-col items-center">
              <StepCard
                number={index + 2}
                tone={REVIEW_TONE}
                title={
                  readonly ? step.name : (
                    <input
                      aria-label={`Name of review step ${index + 1}`}
                      className="h-8 w-full min-w-0 select-text rounded-md border border-transparent bg-transparent px-1.5 text-sm font-semibold hover:border-[var(--line)] focus:border-[var(--brand)] focus:bg-[var(--panel)] focus:outline-none"
                      maxLength={100}
                      value={step.name}
                      onChange={(event) => updateReview(step.id, { name: event.target.value })}
                    />
                  )
                }
                aside={
                  <div className="flex items-center gap-1">
                    <RuleToggle disabled={readonly} rule={step.rule} onChange={(rule) => updateReview(step.id, { rule })} />
                    {readonly ? null : (
                      <>
                        <IconButton label={`Move review ${index + 1} up`} disabled={index === 0} onClick={() => moveReview(index, -1)}><ArrowUp size={14} aria-hidden /></IconButton>
                        <IconButton label={`Move review ${index + 1} down`} disabled={index === workflow.reviews.length - 1} onClick={() => moveReview(index, 1)}><ArrowDown size={14} aria-hidden /></IconButton>
                        <IconButton label={`Remove review ${index + 1}`} onClick={() => update({ reviews: workflow.reviews.filter((item) => item.id !== step.id) })}><Trash2 size={14} aria-hidden /></IconButton>
                      </>
                    )}
                  </div>
                }
                missing={step.userIds.length ? null : "Choose a reviewer, or remove this step"}
                {...shared}
                ids={step.userIds}
                addLabel="Reviewer"
                onRemove={(userIds) => updateReview(step.id, { userIds })}
                onAdd={() => pick(`Who reviews at "${step.name}"`, step.userIds, (userIds) => updateReview(step.id, { userIds }))}
              />
              <div className="org-stem" />
            </div>
          ))}

          {readonly ? null : (
            <>
              <button
                type="button"
                onClick={addReview}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-full border-2 border-dashed border-[color:color-mix(in_oklab,var(--brand)_45%,var(--line))] bg-[var(--panel)] px-4 text-sm font-medium text-[var(--brand)] hover:border-[var(--brand)]"
              >
                <Plus size={15} aria-hidden /> Review step
              </button>
              <div className="org-stem" />
            </>
          )}

          <StepCard
            number={workflow.reviews.length + 2}
            tone={DECISION_TONE}
            title="Final decision"
            aside={<span className="text-xs text-muted">Any one of them decides</span>}
            missing={workflow.decisionIds.length ? null : "Choose who decides"}
            {...shared}
            ids={workflow.decisionIds}
            addLabel="Decision maker"
            onRemove={(decisionIds) => update({ decisionIds })}
            onAdd={() => pick("People who make the final decision", workflow.decisionIds, (decisionIds) => update({ decisionIds }))}
          />
          <div className="org-stem" />

          <div className="org-children">
            <div className="org-node">
              <Outcome
                title="Maintenance handles it"
                hint="The district does the work."
                on={workflow.allowMaintenance}
                disabled={readonly}
                onChange={(allowMaintenance) => update({ allowMaintenance })}
              />
            </div>
            <div className="org-node">
              <Outcome
                title="Goes to GeoTech"
                hint="Starts an assessment. The District Contact stays in the loop."
                on={workflow.allowGeotech}
                disabled={readonly}
                onChange={(allowGeotech) => update({ allowGeotech })}
              >
                <DistrictContactDefault key={contactKey} district={district} />
                {dirty ? <p className="mt-1 text-[12px] text-muted">People you add can be chosen here once you publish.</p> : null}
              </Outcome>
            </div>
          </div>
          {!workflow.allowMaintenance && !workflow.allowGeotech ? (
            <p className="mt-3 text-sm font-medium text-[var(--bad)]">Allow at least one outcome.</p>
          ) : null}
        </div>
      </PanCanvas>

      <div className="grid gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-3 sm:grid-cols-2">
        <PeopleRow
          title="Keep informed"
          {...shared}
          ids={workflow.notifyIds}
          onRemove={(notifyIds) => update({ notifyIds })}
          onAdd={() => pick("Keep informed", workflow.notifyIds, (notifyIds) => update({ notifyIds }))}
        />
        <PeopleRow
          title="Can change this workflow"
          {...shared}
          ids={workflow.managerIds}
          onRemove={(managerIds) => update({ managerIds })}
          onAdd={() => pick("Can change this workflow", workflow.managerIds, (managerIds) => update({ managerIds }))}
        />
      </div>

      {picking ? (
        <ModalDialog titleId="workflow-people-title" onClose={() => setPicking(null)}>
          <h2 id="workflow-people-title" className="mb-3 text-lg font-semibold">{picking.label}</h2>
          <WorkflowPeoplePicker
            district={district}
            label="People"
            ids={picking.ids}
            people={people}
            suggestions={[{ label: "Already in this workflow", people: inThisWorkflow }]}
            disabled={false}
            onPeople={onPeople}
            onChange={(ids) => {
              picking.apply(ids);
              setPicking({ ...picking, ids });
            }}
          />
          <div className="mt-4 flex justify-end">
            <button type="button" onClick={() => setPicking(null)} className="min-h-11 rounded-md bg-[var(--brand)] px-5 text-sm font-semibold text-white hover:brightness-110">Done</button>
          </div>
        </ModalDialog>
      ) : null}
    </div>
  );
}

function countLabel(count: number) {
  return `${count} ${count === 1 ? "person" : "people"}`;
}

function IconButton({ label, disabled = false, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-[var(--panel)] hover:text-[var(--ink)] disabled:opacity-30">
      {children}
    </button>
  );
}

function RuleToggle({ rule, disabled, onChange }: { rule: "ANY" | "ALL"; disabled: boolean; onChange: (rule: "ANY" | "ALL") => void }) {
  return (
    <div role="radiogroup" aria-label="Who has to review" className="inline-flex overflow-hidden rounded-md border border-[var(--line)] bg-[var(--panel)] text-xs font-semibold">
      {([["ANY", "Any one"], ["ALL", "Everyone"]] as const).map(([value, label]) => (
        <button key={value} type="button" role="radio" aria-checked={rule === value} disabled={disabled} onClick={() => onChange(value)}
          className={`h-8 px-2.5 ${rule === value ? "bg-[var(--accent)] text-white" : "hover:bg-[var(--panel-soft)]"}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

function StepCard({
  number,
  tone,
  title,
  aside,
  missing,
  people,
  readonly,
  ids,
  addLabel,
  onRemove,
  onAdd,
}: {
  number: number;
  tone: string;
  title: ReactNode;
  aside: ReactNode;
  missing: string | null;
  people: Record<number, Person>;
  readonly: boolean;
  ids: number[];
  addLabel: string;
  onRemove: (ids: number[]) => void;
  onAdd: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const long = ids.length > SHORTENED_ABOVE;
  const shown = showAll || !long ? ids : ids.slice(0, SHOWN_AT_FIRST);
  return (
    <section
      className="w-[36rem] rounded-xl border bg-[var(--panel)] shadow-sm"
      style={{ borderColor: missing ? "var(--bad)" : `color-mix(in oklab, ${tone} 45%, var(--line))` }}
    >
      <header className="flex flex-wrap items-center gap-2 rounded-t-xl px-3 py-2" style={{ background: `color-mix(in oklab, ${tone} 10%, var(--panel))` }}>
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-bold text-white" style={{ background: tone }} aria-hidden>{number}</span>
        <div className="min-w-0 flex-1 basis-40 text-sm font-semibold">{title}</div>
        {aside}
      </header>
      <div className="grid grid-cols-2 gap-2 p-3">
        {shown.map((id) => (
          <PersonTile key={id} id={id} person={people[id]} tone={tone} removable={!readonly} onRemove={() => onRemove(ids.filter((other) => other !== id))} />
        ))}
        {readonly ? null : (
          <button
            type="button"
            onClick={onAdd}
            className={`flex min-h-11 items-center gap-2 rounded-lg border-2 border-dashed px-2 py-1.5 text-left text-sm font-medium ${
              missing ? "border-[var(--bad)] text-[var(--bad)]" : "border-[color:color-mix(in_oklab,var(--brand)_45%,var(--line))] text-[var(--brand)] hover:border-[var(--brand)]"
            }`}
          >
            <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white ${missing ? "bg-[var(--bad)]" : "bg-[var(--brand)]"}`} aria-hidden><Plus size={13} /></span>
            {missing ?? addLabel}
          </button>
        )}
        {readonly && missing ? <p className="col-span-2 text-sm text-[var(--bad)]">{missing}</p> : null}
        {long ? (
          <button type="button" onClick={() => setShowAll((value) => !value)} className="min-h-11 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] text-sm font-medium hover:bg-[var(--panel)]">
            {showAll ? "Show fewer" : `Show all ${ids.length}`}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function PersonTile({ id, person, tone, removable, onRemove }: { id: number; person?: Person; tone: string; removable: boolean; onRemove: () => void }) {
  const name = person?.full_name || `User #${id}`;
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--panel)] py-1.5 pl-2 pr-1 shadow-sm">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white" style={{ background: tone }} aria-hidden>{initials(name)}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold" title={person?.email}>{name}</span>
        <span className={`block truncate text-[11px] ${person?.is_active === false ? "text-[var(--bad)]" : "text-muted"}`}>
          {person?.is_active === false ? "Inactive" : person?.placement?.label || person?.email || "Maintenance"}
        </span>
      </span>
      {removable ? (
        <button type="button" aria-label={`Remove ${name}`} title={`Remove ${name}`} onClick={onRemove} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-[var(--panel-soft)] hover:text-[var(--bad)]">
          <X size={14} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

function Outcome({ title, hint, on, disabled, onChange, children }: { title: string; hint: string; on: boolean; disabled: boolean; onChange: (on: boolean) => void; children?: ReactNode }) {
  return (
    <div className={`w-[20rem] rounded-xl border border-[var(--line)] bg-[var(--panel)] p-3 shadow-sm ${on ? "" : "opacity-60"}`}>
      <label className="flex min-h-7 cursor-pointer items-center gap-2 text-sm font-semibold">
        <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={on} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
        {title}
      </label>
      <p className="mb-2 ml-6 mt-1 text-xs text-muted">{hint}</p>
      {children}
    </div>
  );
}

function PeopleRow({ title, people, readonly, ids, onRemove, onAdd }: { title: string; people: Record<number, Person>; readonly: boolean; ids: number[]; onRemove: (ids: number[]) => void; onAdd: () => void }) {
  return (
    <div>
      <h3 className="mb-1.5 text-sm font-semibold">{title}</h3>
      <div className="flex flex-wrap items-center gap-1.5">
        {ids.map((id) => {
          const name = people[id]?.full_name || `User #${id}`;
          return (
            <span key={id} className="inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--line)] py-1 pl-3 pr-1 text-sm">
              <span className="truncate">{name}</span>
              {readonly ? <span className="w-2" /> : (
                <button type="button" aria-label={`Remove ${name} from ${title}`} onClick={() => onRemove(ids.filter((other) => other !== id))} className="flex h-6 w-6 items-center justify-center rounded-full text-muted hover:bg-[var(--panel-soft)] hover:text-[var(--bad)]">
                  <X size={13} aria-hidden />
                </button>
              )}
            </span>
          );
        })}
        {readonly ? null : (
          <button type="button" onClick={onAdd} className="inline-flex min-h-8 items-center gap-1 rounded-full border-2 border-dashed border-[color:color-mix(in_oklab,var(--brand)_45%,var(--line))] px-3 text-sm font-medium text-[var(--brand)] hover:border-[var(--brand)]">
            <Plus size={13} aria-hidden /> Add
          </button>
        )}
      </div>
    </div>
  );
}

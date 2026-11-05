import { useEffect, useState } from "react";
import { Check } from "lucide-react";

import { getWorkflows, publishWorkflow, type Definition, type DistrictWorkflow, type Person } from "../../../api/maintenanceWorkflows";
import { DISTRICT_HQ } from "../../../api/orgTree";
import { useAuth } from "../../../auth/AuthContext";
import DistrictWorkflowChart from "./DistrictWorkflowChart";
import { createInitialDefinition, isSimpleDefinition, toSimpleWorkflow, validateSimpleWorkflow } from "./simpleMaintenanceWorkflow";
import WorkflowPeoplePicker from "./WorkflowPeoplePicker";
import WorkflowTreeEditor from "./WorkflowTreeEditor";

/** A district with no workflow yet starts with whoever is setting it up as its manager, and nothing else. */
const starting = (manager: number): Definition => createInitialDefinition(manager, [], []);

/**
 * Each district's maintenance workflow. Who does what in Maintenance comes from here:
 * being named in a workflow is what makes someone Maintenance, and the part they are
 * given is what they may do.
 */
export default function DistrictWorkflows() {
  const { me, refreshMe } = useAuth();
  const [districts, setDistricts] = useState<DistrictWorkflow[]>([]);
  const [district, setDistrict] = useState("01");
  const [draft, setDraft] = useState<Definition>(() => starting(me!.id));
  const [people, setPeople] = useState<Record<number, Person>>({ [me!.id]: { id: me!.id, full_name: me!.full_name || me!.email } });
  const [dirty, setDirty] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const current = districts.find((d) => d.district === district);
  const readonly = !current?.can_manage || busy;
  const simple = isSimpleDefinition(draft);
  const guided = simple && !showAdvanced;
  const missing = simple ? validateSimpleWorkflow(toSimpleWorkflow(draft), people) : [];
  const cannotPublish = busy || (!!current?.definition && !dirty) || (simple && missing.length > 0);
  const remember = (items: Person[]) => setPeople((known) => ({ ...known, ...Object.fromEntries(items.map((person) => [person.id, person])) }));

  useEffect(() => {
    getWorkflows().then((result) => {
      setDistricts(result.districts);
      const first = result.districts.find((d) => d.can_manage && d.definition) || result.districts.find((d) => d.definition) || result.districts.find((d) => d.can_manage) || result.districts[0];
      if (!first) {
        setError("No maintenance districts are available.");
        return;
      }
      setDistrict(first.district);
      setDraft(first.definition || starting(me!.id));
      remember(result.districts.flatMap((d) => d.people));
    }).catch((e) => setError(e.message));
    // Once: choosing a district after that is the person's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const change = (next: Definition) => {
    setDraft(next);
    setDirty(true);
    setError("");
    setNotice("");
  };

  function choose(code: string) {
    if (code === district) return;
    if (dirty && !window.confirm("Discard your unsaved workflow changes?")) return;
    const next = districts.find((d) => d.district === code)!;
    setDistrict(next.district);
    setDraft(next.definition || starting(me!.id));
    setDirty(false);
    setShowAdvanced(false);
    setError("");
    setNotice("");
  }

  async function publish() {
    setBusy(true);
    setError("");
    try {
      const result = await publishWorkflow(district, current!.revision, draft);
      setDistricts((all) => all.map((d) => (d.district === district ? { ...result, people: Object.values(people) } : d)));
      setDraft(result.definition!);
      setDirty(false);
      setNotice(`District ${Number(district)} published. New reports follow revision ${result.revision}. Reports in progress keep their path.`);
      await refreshMe();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not publish the workflow.");
    } finally {
      setBusy(false);
    }
  }

  const status = !current ? "" : dirty ? `Changes not published.${current.definition ? ` New reports follow revision ${current.revision} until you publish.` : ""}`
    : current.definition ? `Published, revision ${current.revision}. Reports in progress keep their path.`
    : "Not set up yet. Maintenance can't report here until it is.";

  return (
    <section className="space-y-3" aria-label="District maintenance workflows">
      <div role="tablist" aria-label="Districts" className="flex flex-wrap gap-2">
        {districts.map((d) => {
          const active = d.district === district;
          return (
            <button
              key={d.district}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => choose(d.district)}
              title={`District ${Number(d.district)} · ${DISTRICT_HQ[d.district] ?? ""}${d.definition ? "" : " · not set up"}`}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium tabular-nums ${
                active ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_12%,var(--panel))] text-[var(--brand)]" : "border-[var(--line)] bg-[var(--panel)] hover:bg-[var(--panel-soft)]"
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${d.definition ? "bg-[var(--good)]" : "bg-[var(--line)]"}`} aria-hidden />
              D{Number(d.district)}
              <span className="sr-only">{d.definition ? "set up" : "not set up"}</span>
            </button>
          );
        })}
      </div>

      <header className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel)] px-4 py-3">
        <div className="mr-auto min-w-0">
          <h2 className="text-base font-semibold">District {Number(district)}{DISTRICT_HQ[district] ? ` · ${DISTRICT_HQ[district]}` : ""}</h2>
          <p className="mt-0.5 text-[13px] text-muted">{status}</p>
        </div>
        {current?.can_manage ? (
          <>
            {missing.length ? <span className="text-[13px] font-semibold text-[var(--bad)]">{missing[0]}</span> : null}
            <button
              type="button"
              disabled={cannotPublish}
              onClick={() => void publish()}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[var(--brand)] px-5 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50"
            >
              <Check size={15} aria-hidden /> Publish
            </button>
          </>
        ) : null}
      </header>

      {error ? <p role="alert" className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3 text-sm text-[var(--bad)]">{error}</p> : null}
      {notice ? <p role="status" className="rounded-lg border border-[var(--line)] p-3 text-sm text-[var(--good)]">{notice}</p> : null}

      {!current ? (
        <p className="text-sm text-muted">Loading workflows…</p>
      ) : !current.definition && !current.can_manage ? (
        <p className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-4 text-sm text-muted">This district has no workflow yet. An administrator sets it up.</p>
      ) : guided ? (
        <WorkflowTreeEditor
          key={district}
          district={district}
          draft={draft}
          people={people}
          readonly={readonly}
          onChange={change}
          onPeople={remember}
          contactKey={`${district}:${current.revision}`}
          dirty={dirty}
        />
      ) : (
        <>
          <p className="rounded-lg bg-[var(--panel-soft)] p-3 text-sm text-muted">
            {simple ? "The advanced editor sets shared duties, report permissions and step-specific notifications." : "This workflow uses advanced settings, so it stays in the advanced editor."}
          </p>
          <DistrictWorkflowChart
            key={district}
            draft={draft}
            people={people}
            readonly={readonly}
            onChange={change}
            peoplePicker={(ids, onChange, key) => (
              <WorkflowPeoplePicker
                key={`${district}-${key}`}
                district={district}
                label={key === "managers" ? "Workflow managers" : draft.duties.find((duty) => duty.id === key)?.name || "People"}
                ids={ids}
                people={people}
                disabled={readonly}
                onPeople={remember}
                onChange={onChange}
              />
            )}
          />
        </>
      )}

      {current?.can_manage && simple ? (
        <button type="button" className="text-sm font-medium text-[var(--brand)] underline-offset-4 hover:underline" onClick={() => setShowAdvanced((value) => !value)}>
          {showAdvanced ? "Back to the tree" : "Advanced editor"}
        </button>
      ) : null}
    </section>
  );
}

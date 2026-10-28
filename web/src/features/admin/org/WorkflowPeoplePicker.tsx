import { useEffect, useState } from "react";
import { workflowPeople, type Person } from "../../../api/maintenanceWorkflows";

const searchInput = "w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]";

type Suggestion = { label: string; people: Person[] };

function affiliation(person: Person, district: string): string {
  const roles: string[] = [];
  for (const code of person.maintenance?.coordinator || []) {
    roles.push(`District ${Number(code)} coordinator${Number(code) === Number(district) ? " · this district" : ""}`);
  }
  for (const code of person.maintenance?.crew || []) {
    roles.push(`District ${Number(code)} crew${Number(code) === Number(district) ? " · this district" : ""}`);
  }
  if (person.placement?.label) roles.push(person.placement.label);
  return roles.join(" · ");
}

export default function WorkflowPeoplePicker({ district, label, ids, people, suggestions = [], onPeople, onChange, disabled }: {
  district: string;
  label: string;
  ids: number[];
  people: Record<number, Person>;
  suggestions?: Suggestion[];
  onPeople: (items: Person[]) => void;
  onChange: (ids: number[]) => void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Person[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [resolvedKey, setResolvedKey] = useState("");
  const searchKey = `${district}:${query.trim()}`;

  useEffect(() => {
    const term = query.trim();
    if (!term || disabled) {
      setHits([]);
      setLoading(false);
      setError("");
      setResolvedKey("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setHits([]);
    setError("");
    setResolvedKey("");
    const timer = window.setTimeout(() => {
      workflowPeople(district, term)
        .then(result => {
          if (!cancelled) {
            setHits(result.items);
            setError("");
            setResolvedKey(`${district}:${term}`);
          }
        })
        .catch(cause => {
          if (!cancelled) {
            setError(cause instanceof Error ? cause.message : "Could not search for people.");
            setResolvedKey(`${district}:${term}`);
          }
        })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [district, query, disabled]);

  function add(items: Person[]) {
    const chosen = items.filter(person => person.is_active !== false && people[person.id]?.is_active !== false && !ids.includes(person.id));
    if (!chosen.length) return;
    const distinct = [...new Map(chosen.map(person => [person.id, person])).values()];
    onPeople(distinct);
    onChange([...ids, ...distinct.map(person => person.id)]);
    setQuery("");
    setHits([]);
  }

  const availableHits = resolvedKey === searchKey ? hits.filter(person => person.is_active !== false && people[person.id]?.is_active !== false && !ids.includes(person.id)) : [];

  return <div role="group" aria-label={label} className="space-y-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h4 className="text-sm font-semibold">{label}</h4>
      <span className="text-xs text-muted">{ids.length} selected</span>
    </div>
    {ids.length ? <ul className="flex flex-wrap gap-2" aria-label={`${label} selected people`}>
      {ids.map(id => {
        const person = people[id];
        const name = person?.full_name || `User #${id}`;
        return <li key={id} className="inline-flex max-w-full items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-1.5 text-sm">
          <span className="min-w-0 truncate" title={person?.email}>{name}{person?.is_active === false && <span className="ml-1 text-[var(--bad)]">(inactive)</span>}</span>
          {!disabled && <button type="button" className="shrink-0 rounded-full px-1 text-muted hover:bg-[var(--panel)] hover:text-[var(--fg)]" aria-label={`Remove ${name} from ${label}`} onClick={() => onChange(ids.filter(value => value !== id))}>×</button>}
        </li>;
      })}
    </ul> : <p className="rounded-lg border border-dashed border-[var(--line)] px-3 py-2 text-sm text-muted">No one selected yet.</p>}

    {!disabled && <>
      {suggestions.map((group, index) => {
        const available = group.people.filter(person => person.is_active !== false && people[person.id]?.is_active !== false && !ids.includes(person.id));
        if (!available.length) return null;
        return <div key={`${group.label}-${index}`} className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium text-muted">{group.label}</p>
            {available.length > 1 && <button type="button" className="text-xs font-semibold text-[var(--brand)] hover:underline" aria-label={`Add all ${group.label} to ${label}`} onClick={() => add(available)}>Add all {available.length}</button>}
          </div>
          <div className="flex flex-wrap gap-2">{available.map(person => <button type="button" key={person.id} className="rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-1.5 text-left text-sm hover:border-[var(--brand)] hover:bg-[var(--panel-soft)]" onClick={() => add([person])} aria-label={`Add ${person.full_name} to ${label}`}>+ {person.full_name}</button>)}</div>
        </div>;
      })}

      <label className="grid gap-1 text-xs font-medium text-muted">Find another person by name or email
        <input type="search" className={searchInput} value={query} onChange={event => setQuery(event.target.value)} autoComplete="off" placeholder="Search people" />
      </label>
      {loading && <p role="status" className="text-xs text-muted">Searching…</p>}
      {error && resolvedKey === searchKey && <p role="alert" className="text-sm text-[var(--bad)]">{error}</p>}
      {!!availableHits.length && <ul className="max-h-56 overflow-y-auto rounded-lg border border-[var(--line)]" aria-label={`${label} search results`}>
        {availableHits.map(person => {
          const where = affiliation(person, district);
          return <li key={person.id} className="border-b border-[var(--line)] last:border-0"><button type="button" className="block w-full px-3 py-2 text-left hover:bg-[var(--panel-soft)]" onClick={() => add([person])}>
            <span className="block text-sm font-medium">{person.full_name}</span>
            <span className="block text-xs text-muted">{person.email || "No email listed"}{where && ` · ${where}`}</span>
          </button></li>;
        })}
      </ul>}
      {!!query.trim() && resolvedKey === searchKey && !loading && !error && !availableHits.length && <p className="text-xs text-muted">No available people found. Try a different name or email.</p>}
    </>}
  </div>;
}

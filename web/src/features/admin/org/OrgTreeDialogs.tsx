import { useEffect, useId, useState, type ReactNode } from "react";

import ModalDialog from "../../../ui/ModalDialog";
import { adminCreateOffice, adminListClassifications, adminPatchOffice, adminReplaceOfficeDistricts, type OrgClassificationRule } from "../../../api/org";
import { findPeople, getDetails, putDetails, type OfficeTree, type PersonDetails, type PersonHit, type TreeBranch, type TreePerson } from "../../../api/orgTree";

const input = "w-full rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]";
const DISTRICTS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));

function Shell({ title, description, busy, error, onClose, onSubmit, submitLabel, children }: {
  title: string;
  description?: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: () => void;
  submitLabel: string;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <ModalDialog titleId={titleId} onClose={onClose} busy={busy}>
      <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
        <h2 id={titleId} className="text-base font-semibold">{title}</h2>
        {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">{children}</div>
        {error ? <p role="alert" className="mt-3 text-sm text-[var(--bad)]">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-[var(--line)] px-3 py-1.5 text-sm font-medium disabled:opacity-50">Cancel</button>
          <button type="submit" disabled={busy} className="rounded-md bg-[var(--brand)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60">{busy ? "Saving…" : submitLabel}</button>
        </div>
      </form>
    </ModalDialog>
  );
}

function Field({ label, hint, wide = false, children }: { label: string; hint?: string; wide?: boolean; children: ReactNode }) {
  return (
    <label className={`grid gap-1 ${wide ? "sm:col-span-2" : ""}`}>
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</span>
      {children}
      {hint ? <span className="text-[11px] text-muted">{hint}</span> : null}
    </label>
  );
}

async function run(setBusy: (b: boolean) => void, setError: (e: string | null) => void, action: () => Promise<void>, onDone: () => void) {
  setBusy(true);
  setError(null);
  try {
    await action();
    onDone();
  } catch (e: any) {
    setError(e?.message ?? "Could not save.");
  } finally {
    setBusy(false);
  }
}

/** Choose a registered person: who will lead a new branch or office. */
function ChiefPicker({ value, onChange }: { value: PersonHit | null; onChange: (person: PersonHit | null) => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PersonHit[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setHits([]); return; }
    let live = true;
    const timer = window.setTimeout(() => {
      findPeople(q).then((r) => { if (live) setHits(r.items); }).catch(() => { if (live) setHits([]); });
    }, 200);
    return () => { live = false; window.clearTimeout(timer); };
  }, [query]);
  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm">
        <span className="min-w-0">
          <span className="font-medium">{value.full_name}</span>
          <span className="block truncate text-[11px] text-muted">{value.placement.label ?? "Not placed anywhere yet"}</span>
        </span>
        <button type="button" onClick={() => onChange(null)} className="rounded border border-[var(--line)] px-2 py-1 text-xs font-medium">Change</button>
      </div>
    );
  }
  return (
    <div className="grid gap-1">
      <input className={input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search registered people by name or email" aria-label="Find the chief" />
      {hits.length ? (
        <ul className="max-h-44 overflow-auto rounded-md border border-[var(--line)]">
          {hits.slice(0, 8).map((hit) => (
            <li key={hit.id}>
              <button type="button" onClick={() => onChange(hit)} className="block w-full px-3 py-1.5 text-left text-sm hover:bg-[var(--panel-soft)]">
                {hit.full_name}
                <span className="block truncate text-[11px] text-muted">{hit.placement.label ?? "Not placed anywhere yet"}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Add a branch (with its chief: a branch never exists without one), or rename one and move its home. */
export function BranchDialog({ officeName, branch, onSave, onClose }: {
  officeName: string;
  branch: TreeBranch | null;
  onSave: (body: { name: string; letter: string | null; home_city: string | null; home_district: string | null; chief_user_id?: number }) => Promise<void>;
  onClose: () => void;
}) {
  const [chief, setChief] = useState<PersonHit | null>(null);
  const [letter, setLetter] = useState(branch?.letter ?? "");
  const [name, setName] = useState(branch?.name ?? "");
  const [city, setCity] = useState(branch?.home_city ?? "");
  const [district, setDistrict] = useState(branch?.home_district ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Shell
      title={branch ? `Edit ${branch.name}` : `New branch in ${officeName}`}
      description={branch ? undefined : "A branch always has a chief: choose who leads it. Add staff afterwards with the + under it."}
      busy={busy}
      error={error}
      onClose={onClose}
      submitLabel={branch ? "Save branch" : "Add branch"}
      onSubmit={() => run(setBusy, setError, async () => {
        if (!branch && !chief) throw new Error("Choose the branch chief.");
        await onSave({ name: name.trim(), letter: letter.trim() || null, home_city: city.trim() || null, home_district: district || null, ...(branch ? {} : { chief_user_id: chief!.id }) });
      }, onClose)}
    >
      {!branch ? (
        <div className="grid gap-1 sm:col-span-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Branch chief</span>
          <ChiefPicker value={chief} onChange={setChief} />
        </div>
      ) : null}
      <Field label="Letter" hint="Optional. Two active branches cannot share one.">
        <input className={input} value={letter} maxLength={4} onChange={(e) => setLetter(e.target.value.toUpperCase())} placeholder="C" />
      </Field>
      <Field label="Name" hint="Blank with a letter reads “Branch C”.">
        <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Branch C" />
      </Field>
      <Field label="Home city">
        <input className={input} value={city} onChange={(e) => setCity(e.target.value)} placeholder="Oakland" />
      </Field>
      <Field label="Home district">
        <select className={input} value={district} onChange={(e) => setDistrict(e.target.value)}>
          <option value="">Not recorded</option>
          {DISTRICTS.map((d) => <option key={d} value={d}>District {Number(d)}</option>)}
        </select>
      </Field>
    </Shell>
  );
}

/** Create an office, or edit one's names, home and the districts it serves (administrators). */
export function OfficeDialog({ office, onDone, onClose }: { office: OfficeTree["office"] | null; onDone: () => Promise<void>; onClose: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState(office?.name ?? "");
  const [shortName, setShortName] = useState(office?.short_name ?? "");
  const [unit, setUnit] = useState(office?.unit_number ?? "");
  const [city, setCity] = useState(office?.home_city ?? "");
  const [homeDistrict, setHomeDistrict] = useState(office?.home_district ?? "");
  const [routing, setRouting] = useState(office?.is_routing_target ?? true);
  const [districts, setDistricts] = useState<string[]>(office?.districts ?? []);
  const [chief, setChief] = useState<PersonHit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const body = {
      name: name.trim(),
      short_name: shortName.trim() || null,
      unit_number: unit.trim() || null,
      home_city: city.trim() || null,
      home_district: homeDistrict || null,
      is_routing_target: routing,
    };
    let id = office?.id;
    if (!id) {
      if (!code.trim()) throw new Error("An office needs a code.");
      if (!chief) throw new Error("Choose the office chief: an office always has one.");
      id = (await adminCreateOffice({ code: code.trim().toUpperCase(), ...body, chief_user_id: chief.id })).office.id;
    } else {
      await adminPatchOffice(id, body);
    }
    const before = [...(office?.districts ?? [])].sort().join();
    if ([...districts].sort().join() !== before) await adminReplaceOfficeDistricts(id, districts);
    await onDone();
  }

  return (
    <Shell
      title={office ? `Edit ${office.name}` : "New GeoTech office"}
      description={office ? "Reports already routed keep the office they were sent to." : "An office always has an office chief: choose who leads it."}
      busy={busy}
      error={error}
      onClose={onClose}
      submitLabel={office ? "Save office" : "Create office"}
      onSubmit={() => run(setBusy, setError, save, onClose)}
    >
      {!office ? (
        <Field label="Code" hint="Set once. Records are joined on it, so it cannot change later." wide>
          <input className={input} value={code} maxLength={16} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="WEST" />
        </Field>
      ) : null}
      {!office ? (
        <div className="grid gap-1 sm:col-span-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Office chief</span>
          <ChiefPicker value={chief} onChange={setChief} />
        </div>
      ) : null}
      <Field label="Full name" wide>
        <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Office of Geotechnical Design West" required />
      </Field>
      <Field label="Short name"><input className={input} value={shortName} onChange={(e) => setShortName(e.target.value)} placeholder="OGDW" /></Field>
      <Field label="Unit number"><input className={input} value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="59-315" /></Field>
      <Field label="Home city"><input className={input} value={city} onChange={(e) => setCity(e.target.value)} placeholder="Oakland" /></Field>
      <Field label="Home district">
        <select className={input} value={homeDistrict} onChange={(e) => setHomeDistrict(e.target.value)}>
          <option value="">Not recorded</option>
          {DISTRICTS.map((d) => <option key={d} value={d}>District {Number(d)}</option>)}
        </select>
      </Field>
      <fieldset className="sm:col-span-2">
        <legend className="text-[11px] font-semibold uppercase tracking-wide text-muted">Districts served</legend>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {DISTRICTS.map((d) => {
            const on = districts.includes(d);
            return (
              <button key={d} type="button" aria-pressed={on} onClick={() => setDistricts((cur) => (on ? cur.filter((x) => x !== d) : [...cur, d]))}
                className={`rounded-full border px-2.5 py-1 text-xs font-semibold tabular-nums ${on ? "border-[var(--brand)] bg-[var(--brand)] text-white" : "border-[var(--line)] hover:border-[var(--brand)]"}`}>
                D{d}
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-[11px] text-muted">A district has one GeoTech office. Remove it from its current office first.</p>
      </fieldset>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" checked={routing} onChange={(e) => setRouting(e.target.checked)} /> Receives incident reports (routing target)
      </label>
    </Shell>
  );
}

/** Classification, position number, home and availability: shown in pickers, never a role. */
export function DetailsDialog({ person, canClassify, onSaved, onClose }: { person: TreePerson; canClassify: boolean; onSaved: () => Promise<void>; onClose: () => void }) {
  const [details, setDetails] = useState<PersonDetails | null>(null);
  const [rules, setRules] = useState<OrgClassificationRule[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDetails(person.id).then(setDetails).catch((e) => setError(e?.message ?? "Could not load details."));
    if (canClassify) adminListClassifications(false).then((res) => setRules((res.items ?? []).filter((rule) => rule.class_code))).catch(() => setRules([]));
  }, [person.id, canClassify]);

  const set = (patch: Partial<PersonDetails>) => setDetails((d) => (d ? { ...d, ...patch } : d));

  return (
    <Shell
      title={person.full_name}
      description={`${person.email} · Shown beside their name in pickers. Nobody is hidden or reordered by it.`}
      busy={busy || !details}
      error={error}
      onClose={onClose}
      submitLabel="Save details"
      onSubmit={() =>
        details &&
        run(setBusy, setError, async () => {
          await putDetails(person.id, {
            availability: details.availability,
            available_until: details.available_until?.slice(0, 10) || null,
            position_number: details.position_number,
            home_city: details.home_city,
            home_district: details.home_district,
            classification_code: details.classification_code,
            classification_marker: details.classification_marker,
            job_title: details.job_title,
            level_code: details.level_code,
          });
          await onSaved();
        }, onClose)
      }
    >
      {details ? (
        <>
          <Field label="Availability">
            <select className={input} value={details.availability} onChange={(e) => set({ availability: e.target.value })}>
              <option value="AVAILABLE">Available</option>
              <option value="ROTATION_OUT">Rotation out</option>
              <option value="ACTING_ELSEWHERE">Acting elsewhere</option>
              <option value="UNAVAILABLE">Unavailable</option>
            </select>
          </Field>
          <Field label="Back on">
            <input type="date" className={input} value={(details.available_until ?? "").slice(0, 10)} onChange={(e) => set({ available_until: e.target.value || null })} />
          </Field>
          <Field label="Classification" wide>
            {rules.length ? (
              <select
                className={input}
                value={`${details.classification_code ?? ""}|${details.classification_marker ?? ""}`}
                onChange={(e) => {
                  const [codeValue, marker] = e.target.value.split("|");
                  const rule = rules.find((r) => (r.class_code ?? "") === codeValue && (r.marker ?? "") === (marker ?? ""));
                  set({ classification_code: codeValue || null, classification_marker: marker || null, job_title: rule?.title ?? details.job_title, level_code: rule?.level_code ?? details.level_code });
                }}
              >
                <option value="|">Not recorded</option>
                {rules.map((rule) => (
                  <option key={rule.id} value={`${rule.class_code ?? ""}|${rule.marker ?? ""}`}>
                    {rule.class_code}{rule.marker ? ` (${rule.marker})` : ""} — {rule.title}
                  </option>
                ))}
              </select>
            ) : (
              <input className={input} value={[details.classification_code, details.classification_marker ? `(${details.classification_marker})` : ""].filter(Boolean).join(" ") || "Not recorded"} readOnly />
            )}
          </Field>
          <Field label="Position number"><input className={input} value={details.position_number ?? ""} onChange={(e) => set({ position_number: e.target.value })} placeholder="559-315-3161-050" /></Field>
          <Field label="Home city"><input className={input} value={details.home_city ?? ""} onChange={(e) => set({ home_city: e.target.value })} /></Field>
          <Field label="Home district">
            <select className={input} value={details.home_district ?? ""} onChange={(e) => set({ home_district: e.target.value || null })}>
              <option value="">Not recorded</option>
              {DISTRICTS.map((d) => <option key={d} value={d}>District {Number(d)}</option>)}
            </select>
          </Field>
        </>
      ) : (
        <p className="text-sm text-muted sm:col-span-2">Loading…</p>
      )}
    </Shell>
  );
}

import { useEffect, useState } from "react";

import { districtContacts, setDistrictContact, type DistrictContacts } from "../../api/fieldNotices";

const selectClass = "w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm";

/** On a hand-off to GeoTech: who is kept informed. Starts on the district's default. */
export function HandoffContactPicker({
  district,
  value,
  onChange,
  onLoaded,
}: {
  district: string | null | undefined;
  value: number | null;
  onChange: (userId: number | null) => void;
  onLoaded: (contacts: DistrictContacts) => void;
}) {
  const [contacts, setContacts] = useState<DistrictContacts | null>(null);
  useEffect(() => {
    if (!district) return;
    let cancelled = false;
    districtContacts(district)
      .then((loaded) => {
        if (cancelled) return;
        setContacts(loaded);
        onLoaded(loaded);
        onChange(loaded.default_user_id);
      })
      .catch(() => { if (!cancelled) setContacts(null); });
    return () => { cancelled = true; };
    // Once per district: the choice after that is the person's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [district]);
  if (!contacts) return null;
  if (!contacts.candidates.length) return <p className="text-[13px] text-muted">No one is listed in this district to name as District Contact.</p>;
  return (
    <label className="grid gap-1 text-sm font-semibold">
      District Contact
      <select className={`${selectClass} font-normal`} value={value ?? ""} onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)}>
        <option value="">Select a person…</option>
        {contacts.candidates.map((person) => <option key={person.id} value={person.id}>{person.full_name}</option>)}
      </select>
    </label>
  );
}

/** A district's default contact, for the people who keep its lists. */
export function DistrictContactDefault({ district }: { district: string }) {
  const [contacts, setContacts] = useState<DistrictContacts | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    districtContacts(district).then((loaded) => { if (!cancelled) setContacts(loaded); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [district]);
  if (!contacts) return null;
  const current = contacts.candidates.find((person) => person.id === contacts.default_user_id);
  if (!contacts.can_edit) {
    return <p className="text-sm"><span className="text-muted">Default District Contact: </span><b className="font-semibold">{current?.full_name ?? "None"}</b></p>;
  }
  return (
    <label className="grid max-w-md gap-1 text-sm font-semibold">
      Default District Contact
      <select
        className={`${selectClass} font-normal`}
        value={contacts.default_user_id ?? ""}
        onChange={(event) => {
          setError(null);
          setDistrictContact(district, event.target.value ? Number(event.target.value) : null)
            .then(setContacts)
            .catch((e: Error) => setError(e.message));
        }}
      >
        <option value="">None</option>
        {contacts.candidates.map((person) => <option key={person.id} value={person.id}>{person.full_name}</option>)}
      </select>
      <span className="text-[13px] font-normal text-muted">Filled in when someone sends an incident to GeoTech. They can change it each time.</span>
      {error ? <span className="text-[13px] font-normal text-[var(--bad)]">{error}</span> : null}
    </label>
  );
}

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import {
  adminCreateOffice,
  adminDeactivateOffice,
  adminListOffices,
  adminPatchOffice,
  adminReplaceOfficeDistricts,
  districtLabel,
  parseDistrictList,
  placeLabel,
  refreshOfficeDirectory,
  type OrgOfficeRecord,
} from "../../../api/org";
import {
  OrgAdminShell,
  OrgChip,
  orgButton,
  orgInput,
  orgLabel,
  orgPrimary,
  orgSmallButton,
} from "./OrgAdminShell";

/**
 * Organization › Offices.
 *
 * The office rows behind every routing decision ERIS makes. Two rules are
 * visible in this page rather than buried in the API:
 *
 *  - **The code is set once.** `assessments.office_code` and
 *    `incidents.office_code` join on it as a string, so renaming a code would
 *    silently re-point — or orphan — every historical record. After creation the
 *    field is text, not an input, and says why (org model design §3.8).
 *  - **Deactivate, never delete.** An assessment routed to an office names it
 *    forever, and deactivating one must not revoke the authority of a chief who
 *    is already reviewing its work.
 *
 * Moving a district takes effect on the next request with no deploy — that is
 * the whole point of the district map having become data (owner decision 8).
 */

type EditDraft = {
  name: string;
  short_name: string;
  unit_number: string;
  home_city: string;
  home_district: string;
  home_location_label: string;
  is_routing_target: boolean;
  sort_order: string;
};

const EMPTY_CREATE = {
  code: "",
  name: "",
  short_name: "",
  unit_number: "",
  home_city: "",
  home_district: "",
  home_location_label: "",
  org_type: "GEOTECH" as "GEOTECH" | "MAINTENANCE",
  is_routing_target: true,
};

function draftOf(office: OrgOfficeRecord): EditDraft {
  return {
    name: office.name ?? "",
    short_name: office.short_name ?? "",
    unit_number: office.unit_number ?? "",
    home_city: office.home_city ?? "",
    home_district: office.home_district ?? "",
    home_location_label: office.home_location_label ?? "",
    is_routing_target: office.is_routing_target,
    sort_order: String(office.sort_order ?? 0),
  };
}

export default function AdminOfficesPage() {
  const [items, setItems] = useState<OrgOfficeRecord[]>([]);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [create, setCreate] = useState(EMPTY_CREATE);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [districtsDraft, setDistrictsDraft] = useState<string>("");

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await adminListOffices({ includeInactive: true });
      setItems(response.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load offices.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(
    () => items.filter((office) => includeInactive || office.is_active),
    [includeInactive, items],
  );

  const afterWrite = useCallback(async (message: string) => {
    setNotice(message);
    // The label directory this page edits is cached for the rest of the app.
    await refreshOfficeDirectory().catch(() => undefined);
    await load();
  }, [load]);

  async function submitCreate() {
    setError(null);
    setNotice(null);
    if (!create.code.trim() || !create.name.trim()) {
      setError("An office needs a code and a name.");
      return;
    }
    setBusy(true);
    try {
      await adminCreateOffice({
        code: create.code.trim().toUpperCase(),
        org_type: create.org_type,
        name: create.name.trim(),
        short_name: create.short_name.trim() || null,
        unit_number: create.unit_number.trim() || null,
        home_city: create.home_city.trim() || null,
        home_district: create.home_district.trim() || null,
        home_location_label: create.home_location_label.trim() || null,
        is_routing_target: create.is_routing_target,
      });
      setCreate(EMPTY_CREATE);
      setCreateOpen(false);
      await afterWrite(`Created ${create.name.trim()}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create the office.");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(office: OrgOfficeRecord) {
    setEditing(office.id);
    setDraft(draftOf(office));
    setDistrictsDraft(office.districts.filter((row) => row.is_active).map((row) => row.district).join(", "));
    setError(null);
    setNotice(null);
  }

  async function saveEdit(office: OrgOfficeRecord) {
    if (!draft) return;
    setRowBusy(office.id);
    setError(null);
    setNotice(null);
    try {
      await adminPatchOffice(office.id, {
        name: draft.name.trim(),
        short_name: draft.short_name.trim() || null,
        unit_number: draft.unit_number.trim() || null,
        home_city: draft.home_city.trim() || null,
        home_district: draft.home_district.trim() || null,
        home_location_label: draft.home_location_label.trim() || null,
        is_routing_target: draft.is_routing_target,
        sort_order: Number(draft.sort_order) || 0,
      });
      setEditing(null);
      setDraft(null);
      await afterWrite(`Saved ${draft.name.trim() || office.code}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save the office.");
    } finally {
      setRowBusy(null);
    }
  }

  async function saveDistricts(office: OrgOfficeRecord) {
    const { districts, invalid } = parseDistrictList(districtsDraft);
    if (invalid.length) {
      setError(`Not a district number: ${invalid.join(", ")}. Use 1–12.`);
      return;
    }
    setRowBusy(office.id);
    setError(null);
    setNotice(null);
    try {
      await adminReplaceOfficeDistricts(office.id, districts);
      await afterWrite(
        districts.length
          ? `${office.name || office.code} now serves ${districts.map((d) => districtLabel(d)).join(", ")}. Reports already routed keep the office they were sent to.`
          : `${office.name || office.code} serves no districts. Reports already routed keep the office they were sent to.`,
      );
    } catch (e) {
      // The 409 from the server NAMES the other office ("District 05 is already
      // served by …"), which is the only form of this message an admin can act on.
      setError(e instanceof Error ? e.message : "Failed to change the districts served.");
    } finally {
      setRowBusy(null);
    }
  }

  async function toggleActive(office: OrgOfficeRecord) {
    setRowBusy(office.id);
    setError(null);
    setNotice(null);
    try {
      if (office.is_active) {
        await adminDeactivateOffice(office.id);
        await afterWrite(`${office.name || office.code} is no longer offered for new work. Assessments already in it keep their reviewer.`);
      } else {
        await adminPatchOffice(office.id, { is_active: true });
        await afterWrite(`${office.name || office.code} is active again.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to change the office status.");
    } finally {
      setRowBusy(null);
    }
  }

  return (
    <OrgAdminShell
      title="Organization · Offices"
      intro="Offices are the routing destinations for assessments. Changing which districts an office serves takes effect on the next report — no deploy. An office is deactivated, never deleted: historical records name it forever."
      error={error}
      notice={notice}
      toolbar={
        <>
          <label className="inline-flex items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm">
            <input type="checkbox" checked={includeInactive} onChange={(event) => setIncludeInactive(event.target.checked)} />
            Show inactive
          </label>
          <button type="button" className={orgPrimary} onClick={() => setCreateOpen((open) => !open)}>{createOpen ? "Close new office" : "New office"}</button>
          <button type="button" className={orgButton} onClick={() => void load()} disabled={busy}>{busy ? "Refreshing…" : "Refresh"}</button>
        </>
      }
    >
      {createOpen ? (
        <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
          <h2 className="text-sm font-semibold">New office</h2>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <label className="grid gap-1.5">
              <span className={orgLabel}>ERIS code *</span>
              <input className={orgInput} value={create.code} placeholder="WEST" onChange={(event) => setCreate((c) => ({ ...c, code: event.target.value }))} />
              <span className="text-[11px] text-muted">Set once. Historical records are joined on this code, so it cannot be changed afterwards.</span>
            </label>
            <label className="grid gap-1.5">
              <span className={orgLabel}>Full name *</span>
              <input className={orgInput} value={create.name} placeholder="Office of Geotechnical Design West" onChange={(event) => setCreate((c) => ({ ...c, name: event.target.value }))} />
            </label>
            <label className="grid gap-1.5">
              <span className={orgLabel}>Short name</span>
              <input className={orgInput} value={create.short_name} placeholder="West GeoTech Office" onChange={(event) => setCreate((c) => ({ ...c, short_name: event.target.value }))} />
              <span className="text-[11px] text-muted">Used in flow copy and banners; the full name is used on records.</span>
            </label>
            <label className="grid gap-1.5">
              <span className={orgLabel}>Unit number</span>
              <input className={orgInput} value={create.unit_number} placeholder="59-315" onChange={(event) => setCreate((c) => ({ ...c, unit_number: event.target.value }))} />
            </label>
            <label className="grid gap-1.5">
              <span className={orgLabel}>Home city</span>
              <input className={orgInput} value={create.home_city} onChange={(event) => setCreate((c) => ({ ...c, home_city: event.target.value }))} />
            </label>
            <label className="grid gap-1.5">
              <span className={orgLabel}>Home district</span>
              <input className={orgInput} value={create.home_district} placeholder="04" onChange={(event) => setCreate((c) => ({ ...c, home_district: event.target.value }))} />
            </label>
            <label className="grid gap-1.5">
              <span className={orgLabel}>Location label</span>
              <input className={orgInput} value={create.home_location_label} placeholder="Translab" onChange={(event) => setCreate((c) => ({ ...c, home_location_label: event.target.value }))} />
            </label>
            <label className="grid gap-1.5">
              <span className={orgLabel}>Hierarchy</span>
              <select className={orgInput} value={create.org_type} onChange={(event) => setCreate((c) => ({ ...c, org_type: event.target.value as "GEOTECH" | "MAINTENANCE" }))}>
                <option value="GEOTECH">GeoTech</option>
                <option value="MAINTENANCE">Maintenance</option>
              </select>
            </label>
            <label className="mt-6 inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={create.is_routing_target} onChange={(event) => setCreate((c) => ({ ...c, is_routing_target: event.target.checked }))} />
              Offer for district routing
            </label>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className={orgButton} onClick={() => { setCreateOpen(false); setCreate(EMPTY_CREATE); }}>Cancel</button>
            <button type="button" className={orgPrimary} onClick={submitCreate} disabled={busy}>Create office</button>
          </div>
        </section>
      ) : null}

      <div className="flex-1 overflow-auto rounded-xl border border-[var(--line)] bg-[var(--panel)]">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-[var(--line)] bg-[var(--panel-soft)] text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
              <th className="px-3 py-3">Office</th>
              <th className="px-3 py-3">Code</th>
              <th className="px-3 py-3">Home</th>
              <th className="px-3 py-3">Districts served</th>
              <th className="px-3 py-3">Branches</th>
              <th className="px-3 py-3">Status</th>
              <th className="px-3 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-sm text-muted">{busy ? "Loading offices…" : "No offices yet. Add the first office."}</td></tr>
            ) : visible.map((office) => {
              const active = office.districts.filter((row) => row.is_active);
              const isEditing = editing === office.id;
              return (
                <Fragment key={office.id}>
                <tr className="border-b border-[var(--line)]/60 align-top last:border-b-0">
                  <td className="px-3 py-3 text-sm">
                    <div className="font-semibold">{office.name || office.code}</div>
                    <div className="text-xs text-muted">{[office.short_name, office.unit_number].filter(Boolean).join(" · ") || "—"}</div>
                    {!office.is_routing_target ? <div className="mt-1"><OrgChip>Not a routing target</OrgChip></div> : null}
                  </td>
                  <td className="px-3 py-3 text-sm font-semibold tabular-nums">
                    {office.code}
                    <div className="mt-0.5 max-w-40 text-[11px] font-normal text-muted">Read-only — historical records are joined on this code.</div>
                  </td>
                  <td className="px-3 py-3 text-sm text-muted">
                    {placeLabel(office.home_city, office.home_district) ?? "—"}
                    {office.home_location_label ? <div className="text-xs">{office.home_location_label}</div> : null}
                  </td>
                  <td className="px-3 py-3 text-sm">
                    {isEditing ? (
                      <div className="grid gap-1.5">
                        <input className={orgInput} value={districtsDraft} placeholder="01, 04, 05" onChange={(event) => setDistrictsDraft(event.target.value)} />
                        <button type="button" className={orgSmallButton} disabled={rowBusy === office.id} onClick={() => void saveDistricts(office)}>Save districts served</button>
                      </div>
                    ) : active.length ? (
                      <div className="flex flex-wrap gap-1">{active.map((row) => <OrgChip key={row.id}>{districtLabel(row.district)}</OrgChip>)}</div>
                    ) : (
                      <span className="text-muted">None</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-sm text-muted tabular-nums">
                    {office.branch_count ?? 0}
                    <div className="text-xs">{office.member_count ?? 0} people</div>
                  </td>
                  <td className="px-3 py-3 text-sm">{office.is_active ? <OrgChip tone="good">Active</OrgChip> : <OrgChip>Inactive</OrgChip>}</td>
                  <td className="px-3 py-3 text-right">
                    <div className="inline-flex flex-wrap justify-end gap-1.5">
                      <button type="button" className={orgSmallButton} onClick={() => (isEditing ? (setEditing(null), setDraft(null)) : startEdit(office))}>{isEditing ? "Close" : "Edit"}</button>
                      <button type="button" className={orgSmallButton} disabled={rowBusy === office.id} onClick={() => void toggleActive(office)}>{office.is_active ? "Deactivate" : "Reactivate"}</button>
                    </div>
                  </td>
                </tr>
                {isEditing && draft ? (
              <tr className="border-b border-[var(--line)]/60 bg-[var(--panel-soft)]">
                <td colSpan={7} className="px-3 py-4">
                  <div className="grid gap-3 md:grid-cols-3">
                    <label className="grid gap-1.5"><span className={orgLabel}>Full name</span><input className={orgInput} value={draft.name} onChange={(event) => setDraft((d) => (d ? { ...d, name: event.target.value } : d))} /></label>
                    <label className="grid gap-1.5"><span className={orgLabel}>Short name</span><input className={orgInput} value={draft.short_name} onChange={(event) => setDraft((d) => (d ? { ...d, short_name: event.target.value } : d))} /></label>
                    <label className="grid gap-1.5"><span className={orgLabel}>Unit number</span><input className={orgInput} value={draft.unit_number} onChange={(event) => setDraft((d) => (d ? { ...d, unit_number: event.target.value } : d))} /></label>
                    <label className="grid gap-1.5"><span className={orgLabel}>Home city</span><input className={orgInput} value={draft.home_city} onChange={(event) => setDraft((d) => (d ? { ...d, home_city: event.target.value } : d))} /></label>
                    <label className="grid gap-1.5"><span className={orgLabel}>Home district</span><input className={orgInput} value={draft.home_district} onChange={(event) => setDraft((d) => (d ? { ...d, home_district: event.target.value } : d))} /></label>
                    <label className="grid gap-1.5"><span className={orgLabel}>Location label</span><input className={orgInput} value={draft.home_location_label} onChange={(event) => setDraft((d) => (d ? { ...d, home_location_label: event.target.value } : d))} /></label>
                    <label className="grid gap-1.5"><span className={orgLabel}>Sort order</span><input className={orgInput} value={draft.sort_order} onChange={(event) => setDraft((d) => (d ? { ...d, sort_order: event.target.value } : d))} /></label>
                    <label className="mt-6 inline-flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={draft.is_routing_target} onChange={(event) => setDraft((d) => (d ? { ...d, is_routing_target: event.target.checked } : d))} />
                      Offer for district routing
                    </label>
                  </div>
                  <div className="mt-3 flex justify-end gap-2">
                    <button type="button" className={orgButton} onClick={() => { setEditing(null); setDraft(null); }}>Cancel</button>
                    <button
                      type="button"
                      className={orgPrimary}
                      disabled={rowBusy != null}
                      onClick={() => void saveEdit(office)}
                    >
                      Save office
                    </button>
                  </div>
                </td>
              </tr>
                ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </OrgAdminShell>
  );
}

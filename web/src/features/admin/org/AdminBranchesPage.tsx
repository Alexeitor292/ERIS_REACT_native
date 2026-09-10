import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "../../../api/client";
import {
  adminCreateBranch,
  adminListBranches,
  adminListOffices,
  adminPatchBranch,
  adminReplaceBranchDistricts,
  branchDistrictSourceLabel,
  branchLabel,
  districtLabel,
  parseDistrictList,
  placeLabel,
  refreshOfficeDirectory,
  type OrgBranchDistrictSource,
  type OrgBranchRecord,
  type OrgOfficeRecord,
} from "../../../api/org";
import type { AdminUser } from "../../../api/types";
import { roleLabel } from "../../../utils/roleModel";
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
 * Organization › Branches.
 *
 * A branch is a supervised group inside an office, and it is the thing ERIS
 * could not express at all before the org model — which is why a hand-off
 * picker used to be a flat list of names with no indication of who leads what.
 *
 * Two things this page is careful about:
 *
 *  - **District coverage carries its provenance.** No org chart states which
 *    districts a branch covers, so every row here was entered by a person and is
 *    labelled *From the chart* / *Inferred* / *Entered*. An inference that loses
 *    its label becomes a fact nobody can question (design §10, open question 1).
 *  - **"Offered in pickers" is not the same as "exists".** SOUTH Branch E is on
 *    the chart with a vacant chief and dashed staff boxes; it is shown, disabled,
 *    with the reason — never hidden.
 */

type BranchDraft = {
  letter: string;
  name: string;
  home_city: string;
  home_district: string;
  home_location_label: string;
  chief_user_id: string;
  accepts_assignments: boolean;
  sort_order: string;
};

const EMPTY_CREATE: BranchDraft = {
  letter: "",
  name: "",
  home_city: "",
  home_district: "",
  home_location_label: "",
  chief_user_id: "",
  accepts_assignments: true,
  sort_order: "0",
};

function draftOf(branch: OrgBranchRecord): BranchDraft {
  return {
    letter: branch.letter ?? "",
    name: branch.name ?? "",
    home_city: branch.home_city ?? "",
    home_district: branch.home_district ?? "",
    home_location_label: branch.home_location_label ?? "",
    chief_user_id: branch.chief_user_id != null ? String(branch.chief_user_id) : "",
    accepts_assignments: branch.accepts_assignments,
    sort_order: String(branch.sort_order ?? 0),
  };
}

export default function AdminBranchesPage() {
  const [offices, setOffices] = useState<OrgOfficeRecord[]>([]);
  const [officeId, setOfficeId] = useState<number | null>(null);
  const [branches, setBranches] = useState<OrgBranchRecord[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [create, setCreate] = useState<BranchDraft>(EMPTY_CREATE);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<BranchDraft | null>(null);
  const [districtsDraft, setDistrictsDraft] = useState("");
  const [districtsSource, setDistrictsSource] = useState<OrgBranchDistrictSource>("ADMIN");

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      adminListOffices({ includeInactive: true }),
      api<{ items: AdminUser[] }>("/admin/users?limit=500").catch(() => ({ items: [] as AdminUser[] })),
    ])
      .then(([officeResponse, userResponse]) => {
        if (cancelled) return;
        const list = officeResponse.items ?? [];
        setOffices(list);
        setUsers(userResponse.items ?? []);
        setOfficeId((current) => current ?? (list.find((office) => office.is_active)?.id ?? list[0]?.id ?? null));
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load offices."); });
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async () => {
    if (officeId == null) return;
    setBusy(true);
    setError(null);
    try {
      const response = await adminListBranches({ officeId, includeInactive: true });
      setBranches(response.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load branches.");
    } finally {
      setBusy(false);
    }
  }, [officeId]);

  useEffect(() => { void load(); }, [load]);

  const office = useMemo(() => offices.find((row) => row.id === officeId) ?? null, [officeId, offices]);
  const visible = useMemo(
    () => branches.filter((branch) => includeInactive || branch.is_active),
    [branches, includeInactive],
  );
  const chiefChoices = useMemo(
    () => users.filter((user) => user.is_active).sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [users],
  );

  const afterWrite = useCallback(async (message: string) => {
    setNotice(message);
    await refreshOfficeDirectory().catch(() => undefined);
    await load();
  }, [load]);

  async function submitCreate() {
    if (officeId == null) return;
    setError(null);
    setNotice(null);
    if (!create.name.trim()) { setError("A branch needs a name — \"Branch C\" is a name."); return; }
    setBusy(true);
    try {
      await adminCreateBranch({
        office_id: officeId,
        letter: create.letter.trim() || null,
        name: create.name.trim(),
        home_city: create.home_city.trim() || null,
        home_district: create.home_district.trim() || null,
        home_location_label: create.home_location_label.trim() || null,
        chief_user_id: create.chief_user_id ? Number(create.chief_user_id) : null,
        accepts_assignments: create.accepts_assignments,
        sort_order: Number(create.sort_order) || 0,
      });
      setCreate(EMPTY_CREATE);
      setCreateOpen(false);
      await afterWrite(`Added ${create.name.trim()}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create the branch.");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(branch: OrgBranchRecord) {
    setEditing(branch.id);
    setDraft(draftOf(branch));
    setDistrictsDraft((branch.districts ?? []).filter((row) => row.is_active).map((row) => row.district).join(", "));
    setDistrictsSource("ADMIN");
    setError(null);
    setNotice(null);
  }

  async function saveEdit(branch: OrgBranchRecord) {
    if (!draft) return;
    setRowBusy(branch.id);
    setError(null);
    setNotice(null);
    try {
      await adminPatchBranch(branch.id, {
        letter: draft.letter.trim() || null,
        name: draft.name.trim(),
        home_city: draft.home_city.trim() || null,
        home_district: draft.home_district.trim() || null,
        home_location_label: draft.home_location_label.trim() || null,
        chief_user_id: draft.chief_user_id ? Number(draft.chief_user_id) : null,
        accepts_assignments: draft.accepts_assignments,
        sort_order: Number(draft.sort_order) || 0,
      });
      setEditing(null);
      setDraft(null);
      await afterWrite(`Saved ${draft.name.trim() || branchLabel(branch) || "the branch"}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save the branch.");
    } finally {
      setRowBusy(null);
    }
  }

  async function saveDistricts(branch: OrgBranchRecord) {
    const { districts, invalid } = parseDistrictList(districtsDraft);
    if (invalid.length) { setError(`Not a district number: ${invalid.join(", ")}. Use 1–12.`); return; }
    setRowBusy(branch.id);
    setError(null);
    setNotice(null);
    try {
      await adminReplaceBranchDistricts(branch.id, districts, districtsSource);
      await afterWrite(
        districts.length
          ? `${branchLabel(branch)} covers ${districts.map((d) => districtLabel(d)).join(", ")} (${branchDistrictSourceLabel(districtsSource).toLowerCase()}).`
          : `${branchLabel(branch)} has no recorded district coverage.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save district coverage.");
    } finally {
      setRowBusy(null);
    }
  }

  async function toggleActive(branch: OrgBranchRecord) {
    setRowBusy(branch.id);
    setError(null);
    setNotice(null);
    try {
      await adminPatchBranch(branch.id, { is_active: !branch.is_active });
      await afterWrite(
        branch.is_active
          ? `${branchLabel(branch)} is retired. It no longer appears in pickers; assessments already handed to it are unchanged.`
          : `${branchLabel(branch)} is active again.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to change the branch status.");
    } finally {
      setRowBusy(null);
    }
  }

  return (
    <OrgAdminShell
      title="Organization · Branches"
      intro="Branches are the supervised groups inside an office; a branch chief assigns Staff and approves their work. Retiring a branch removes it from every picker and changes no historical record."
      error={error}
      notice={notice}
      toolbar={
        <>
          <label className="inline-flex items-center gap-2 text-sm">
            <span className="text-muted">Office</span>
            <select className={orgInput} value={officeId ?? ""} onChange={(event) => { setOfficeId(Number(event.target.value) || null); setEditing(null); setDraft(null); }}>
              {offices.map((row) => <option key={row.id} value={row.id}>{row.name || row.code}{row.is_active ? "" : " (inactive)"}</option>)}
            </select>
          </label>
          <label className="inline-flex items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm">
            <input type="checkbox" checked={includeInactive} onChange={(event) => setIncludeInactive(event.target.checked)} />
            Show retired
          </label>
          <button type="button" className={orgPrimary} disabled={officeId == null} onClick={() => setCreateOpen((open) => !open)}>{createOpen ? "Close new branch" : "New branch"}</button>
          <button type="button" className={orgButton} onClick={() => void load()} disabled={busy}>{busy ? "Refreshing…" : "Refresh"}</button>
        </>
      }
    >
      {office ? (
        <div className="text-sm text-muted">
          {office.name || office.code}
          {placeLabel(office.home_city, office.home_district) ? ` · ${placeLabel(office.home_city, office.home_district)}` : ""}
          {office.districts.filter((row) => row.is_active).length
            ? ` · serves ${office.districts.filter((row) => row.is_active).map((row) => districtLabel(row.district)).join(", ")}`
            : " · serves no districts"}
        </div>
      ) : null}

      {createOpen && officeId != null ? (
        <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
          <h2 className="text-sm font-semibold">New branch in {office?.name || office?.code}</h2>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <label className="grid gap-1.5"><span className={orgLabel}>Letter</span><input className={orgInput} value={create.letter} placeholder="C" onChange={(event) => setCreate((c) => ({ ...c, letter: event.target.value }))} /></label>
            <label className="grid gap-1.5"><span className={orgLabel}>Name *</span><input className={orgInput} value={create.name} placeholder="Branch C" onChange={(event) => setCreate((c) => ({ ...c, name: event.target.value }))} /></label>
            <label className="grid gap-1.5"><span className={orgLabel}>Branch chief</span>
              <select className={orgInput} value={create.chief_user_id} onChange={(event) => setCreate((c) => ({ ...c, chief_user_id: event.target.value }))}>
                <option value="">Not recorded</option>
                {chiefChoices.map((user) => <option key={user.id} value={user.id}>{user.full_name} — {user.roles.map(roleLabel).join(", ")}</option>)}
              </select>
            </label>
            <label className="grid gap-1.5"><span className={orgLabel}>Home city</span><input className={orgInput} value={create.home_city} onChange={(event) => setCreate((c) => ({ ...c, home_city: event.target.value }))} /></label>
            <label className="grid gap-1.5"><span className={orgLabel}>Home district</span><input className={orgInput} value={create.home_district} placeholder="04" onChange={(event) => setCreate((c) => ({ ...c, home_district: event.target.value }))} /></label>
            <label className="grid gap-1.5"><span className={orgLabel}>Location label</span><input className={orgInput} value={create.home_location_label} onChange={(event) => setCreate((c) => ({ ...c, home_location_label: event.target.value }))} /></label>
            <label className="mt-6 inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={create.accepts_assignments} onChange={(event) => setCreate((c) => ({ ...c, accepts_assignments: event.target.checked }))} />
              Offered in pickers
            </label>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className={orgButton} onClick={() => { setCreateOpen(false); setCreate(EMPTY_CREATE); }}>Cancel</button>
            <button type="button" className={orgPrimary} onClick={submitCreate} disabled={busy}>Create branch</button>
          </div>
        </section>
      ) : null}

      <div className="grid gap-3">
        {visible.length === 0 ? (
          <div className="rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-6 text-center text-sm text-muted">
            {busy ? "Loading branches…" : "No branches in this office yet. Add the first branch."}
          </div>
        ) : visible.map((branch) => {
          const isEditing = editing === branch.id;
          const coverage = (branch.districts ?? []).filter((row) => row.is_active);
          return (
            <section key={branch.id} className="rounded-xl border border-[var(--line)] bg-[var(--panel)]">
              <div className="flex flex-wrap items-center gap-2.5 border-b border-[var(--line)] bg-[var(--panel-soft)] px-4 py-3">
                <h3 className="text-[13px] font-semibold">{branchLabel(branch) ?? `Branch #${branch.id}`}</h3>
                {branch.letter ? <OrgChip>{branch.letter}</OrgChip> : null}
                {branch.is_active ? null : <OrgChip>Retired</OrgChip>}
                {branch.accepts_assignments ? null : <OrgChip tone="warn">Not offered in pickers</OrgChip>}
                <span className="text-xs text-muted">{placeLabel(branch.home_city, branch.home_district) ?? "Home not recorded"}</span>
                <span className="text-xs text-muted">{branch.member_count ?? 0} member{(branch.member_count ?? 0) === 1 ? "" : "s"}</span>
                <div className="ml-auto flex flex-wrap items-center gap-1.5">
                  <button type="button" className={orgSmallButton} onClick={() => (isEditing ? (setEditing(null), setDraft(null)) : startEdit(branch))}>{isEditing ? "Close" : "Edit"}</button>
                  <button type="button" className={orgSmallButton} disabled={rowBusy === branch.id} onClick={() => void toggleActive(branch)}>{branch.is_active ? "Retire" : "Reactivate"}</button>
                </div>
              </div>
              <div className="grid gap-3 p-4">
                <div className="text-sm">
                  <span className="text-muted">Branch chief: </span>
                  {branch.chief ? <b className="font-semibold">{branch.chief.full_name}</b> : <span className="text-[var(--bad)]">not recorded — this branch cannot be handed an assessment</span>}
                  {branch.chief ? <span className="text-xs text-muted"> · {branch.chief.email}</span> : null}
                </div>
                <div className="text-sm">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted">Districts covered</div>
                  {coverage.length === 0 ? (
                    <p className="mt-1 text-sm text-muted">No district coverage recorded for this branch. The org charts do not state it — enter it if you know it.</p>
                  ) : (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {coverage.map((row) => (
                        <span key={row.id} className="inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-0.5 text-[11px]">
                          <b className="font-semibold">{districtLabel(row.district)}</b>
                          <span className="text-muted">{branchDistrictSourceLabel(row.source)}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {isEditing && draft ? (
                  <div className="grid gap-3 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3">
                    <div className="grid gap-3 md:grid-cols-3">
                      <label className="grid gap-1.5"><span className={orgLabel}>Letter</span><input className={orgInput} value={draft.letter} onChange={(event) => setDraft((d) => (d ? { ...d, letter: event.target.value } : d))} /></label>
                      <label className="grid gap-1.5"><span className={orgLabel}>Name</span><input className={orgInput} value={draft.name} onChange={(event) => setDraft((d) => (d ? { ...d, name: event.target.value } : d))} /></label>
                      <label className="grid gap-1.5"><span className={orgLabel}>Branch chief</span>
                        <select className={orgInput} value={draft.chief_user_id} onChange={(event) => setDraft((d) => (d ? { ...d, chief_user_id: event.target.value } : d))}>
                          <option value="">Not recorded</option>
                          {chiefChoices.map((user) => <option key={user.id} value={user.id}>{user.full_name} — {user.roles.map(roleLabel).join(", ")}</option>)}
                        </select>
                      </label>
                      <label className="grid gap-1.5"><span className={orgLabel}>Home city</span><input className={orgInput} value={draft.home_city} onChange={(event) => setDraft((d) => (d ? { ...d, home_city: event.target.value } : d))} /></label>
                      <label className="grid gap-1.5"><span className={orgLabel}>Home district</span><input className={orgInput} value={draft.home_district} onChange={(event) => setDraft((d) => (d ? { ...d, home_district: event.target.value } : d))} /></label>
                      <label className="grid gap-1.5"><span className={orgLabel}>Sort order</span><input className={orgInput} value={draft.sort_order} onChange={(event) => setDraft((d) => (d ? { ...d, sort_order: event.target.value } : d))} /></label>
                      <label className="mt-6 inline-flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={draft.accepts_assignments} onChange={(event) => setDraft((d) => (d ? { ...d, accepts_assignments: event.target.checked } : d))} />
                        Offered in pickers
                      </label>
                    </div>
                    <div className="grid gap-2 md:grid-cols-[1fr_auto_auto] md:items-end">
                      <label className="grid gap-1.5"><span className={orgLabel}>Districts covered</span><input className={orgInput} value={districtsDraft} placeholder="04, 05" onChange={(event) => setDistrictsDraft(event.target.value)} /></label>
                      <label className="grid gap-1.5">
                        <span className={orgLabel}>Where this came from</span>
                        <select className={orgInput} value={districtsSource} onChange={(event) => setDistrictsSource(event.target.value as OrgBranchDistrictSource)}>
                          <option value="CHART">From the chart</option>
                          <option value="INFERRED">Inferred</option>
                          <option value="ADMIN">Entered</option>
                        </select>
                      </label>
                      <button type="button" className={orgButton} disabled={rowBusy === branch.id} onClick={() => void saveDistricts(branch)}>Save coverage</button>
                    </div>
                    <div className="flex justify-end gap-2">
                      <button type="button" className={orgButton} onClick={() => { setEditing(null); setDraft(null); }}>Cancel</button>
                      <button type="button" className={orgPrimary} disabled={rowBusy === branch.id} onClick={() => void saveEdit(branch)}>Save branch</button>
                    </div>
                  </div>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
    </OrgAdminShell>
  );
}

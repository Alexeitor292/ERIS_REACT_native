import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import { api } from "../../../api/client";
import {
  adminListBranches,
  adminListClassifications,
  adminListOffices,
  branchLabel,
  getUserOrg,
  placeLabel,
  putUserOrg,
  type OrgBranchRecord,
  type OrgClassificationRule,
  type OrgOfficeRecord,
  type RoleSuggestion,
} from "../../../api/org";
import type { AdminUser, UserOrg } from "../../../api/types";
import AppShell from "../../../ui/AppShell";
import { CANONICAL, roleLabel } from "../../../utils/roleModel";
import PasswordResetDialog from "./PasswordResetDialog";

/**
 * Administration › Users.
 *
 * What changed with the org model, and why:
 *
 *  - **Office is a row, not free text.** The page used to offer a datalist of
 *    three hard-coded office codes over a free-text input, so "WEST ", "West"
 *    and a typo all saved silently and none of them matched anything. Offices
 *    are now fetched, and a person's office is a choice from them.
 *  - **Branch exists at all.** It is dependent on the office, and it is what
 *    makes a Staff member assignable to the right chief. A Staff or branch-chief
 *    account saved with no branch is FLAGGED rather than quietly accepted.
 *  - **Org facts go to `PUT /admin/users/{id}/org`.** The old workaround — re-send
 *    the entire `metadata` object on every save so a PATCH would not clear the
 *    two keys it was not editing — is gone with the reason for it. No client
 *    writes an org fact into `metadata` any more; the server keeps that mirror.
 *  - **Classification suggests a role; it never grants one.** The charts show a
 *    vacant office chief filled out of class and a senior specialist covered out
 *    of class for eight months, so the admin reads the suggestion and decides.
 *  - **Busy is per row.** One global flag disabled every button on the page
 *    while any one of them was working.
 */

const ORG_ROLE_NAMES = new Set<string>([...CANONICAL.GEOTECH_ENGINEER, ...CANONICAL.GEOTECH_BRANCH_CHIEF]);

/** Accounts whose work depends on a branch: Staff are assigned inside one, chiefs lead one. */
function needsBranch(user: AdminUser): boolean {
  return user.roles.some((role) => ORG_ROLE_NAMES.has(role));
}

type OrgDraft = {
  office_id: string;
  branch_id: string;
  classification_code: string;
  classification_marker: string;
  position_number: string;
  job_title: string;
  level_code: string;
  home_city: string;
  home_district: string;
  availability: "AVAILABLE" | "ROTATION_OUT" | "ACTING_ELSEWHERE" | "UNAVAILABLE";
  available_until: string;
};

function draftOf(org: UserOrg | undefined): OrgDraft {
  return {
    office_id: org?.office_id != null ? String(org.office_id) : "",
    branch_id: org?.branch_id != null ? String(org.branch_id) : "",
    classification_code: org?.classification_code ?? "",
    classification_marker: org?.classification_marker ?? "",
    position_number: org?.position_number ?? "",
    job_title: org?.job_title ?? "",
    level_code: org?.level_code ?? "",
    home_city: org?.home_city ?? "",
    home_district: org?.home_district ?? "",
    availability: (org?.availability as OrgDraft["availability"]) ?? "AVAILABLE",
    available_until: (org?.available_until ?? "").slice(0, 10),
  };
}

function AccountStatusBadge({ active }: { active: boolean }) {
  return (
    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${active ? "border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] text-[var(--good)]" : "border-[var(--line)] bg-[var(--panel-soft)] text-muted"}`}>
      {active ? "Active" : "Inactive"}
    </span>
  );
}

/** "Classification 3161 (Sup) suggests Branch Chief — this account holds Staff." */
function SuggestionLine({ suggestion }: { suggestion: RoleSuggestion | null | undefined }) {
  if (!suggestion) return null;
  if (!suggestion.suggested_role) {
    return (
      <p className="text-[13px] text-muted">
        This classification is recognised but has no ERIS role decided yet{suggestion.notes ? ` — ${suggestion.notes}` : "."}
      </p>
    );
  }
  return (
    <p className={`text-[13px] ${suggestion.matches_granted ? "text-muted" : "text-[var(--brand)]"}`}>
      {suggestion.title ? `${suggestion.title}: ` : ""}
      this classification suggests <b className="font-semibold">{roleLabel(suggestion.suggested_role)}</b>.{" "}
      {suggestion.matches_granted
        ? "The account already holds it."
        : `The account holds ${(suggestion.granted_roles ?? []).map(roleLabel).join(", ") || "no matching role"} — change the roles below if that is wrong. Saving here never changes them.`}
    </p>
  );
}

export default function AdminUsersOperationsPage() {
  const [items, setItems] = useState<AdminUser[]>([]);
  const [roleOptions, setRoleOptions] = useState<string[]>([]);
  const [offices, setOffices] = useState<OrgOfficeRecord[]>([]);
  const [branches, setBranches] = useState<OrgBranchRecord[]>([]);
  const [classifications, setClassifications] = useState<OrgClassificationRule[]>([]);
  const [orgById, setOrgById] = useState<Record<number, UserOrg>>({});
  const [suggestionById, setSuggestionById] = useState<Record<number, RoleSuggestion | null>>({});
  const [draftRoles, setDraftRoles] = useState<Record<number, string[]>>({});
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "ACTIVE" | "INACTIVE">("ALL");
  const [createOpen, setCreateOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [newRoles, setNewRoles] = useState<string[]>([]);
  const [newOfficeId, setNewOfficeId] = useState("");
  const [newBranchId, setNewBranchId] = useState("");
  const [resetUser, setResetUser] = useState<AdminUser | null>(null);
  const [openUserId, setOpenUserId] = useState<number | null>(null);
  const [orgDraft, setOrgDraft] = useState<OrgDraft | null>(null);
  const [confirmNoBranch, setConfirmNoBranch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const inputClass = "w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]";
  const smallButton = "rounded border border-[var(--line)] px-2.5 py-1.5 text-xs font-semibold hover:bg-[var(--panel-soft)] disabled:cursor-not-allowed disabled:opacity-40";

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [usersResponse, rolesResponse, officesResponse, branchesResponse, classificationsResponse] = await Promise.all([
        api<{ items: AdminUser[] }>("/admin/users?limit=500"),
        api<{ items: string[] }>("/admin/roles"),
        adminListOffices({ includeInactive: false }),
        adminListBranches({ includeInactive: false }),
        adminListClassifications(false).catch(() => ({ items: [] as OrgClassificationRule[] })),
      ]);
      const nextUsers = usersResponse.items ?? [];
      setItems(nextUsers);
      setRoleOptions(rolesResponse.items ?? []);
      setOffices(officesResponse.items ?? []);
      setBranches(branchesResponse.items ?? []);
      setClassifications(classificationsResponse.items ?? []);
      setDraftRoles(Object.fromEntries(nextUsers.map((user) => [user.id, [...user.roles]])));
      setOrgById(Object.fromEntries(nextUsers.filter((user) => user.org).map((user) => [user.id, user.org as UserOrg])));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load user administration data.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * Fetch the org record for the accounts where a MISSING branch is a real
   * problem — Staff and branch chiefs. `/admin/users` carries only the legacy
   * office/district mirror, so without this the row could not flag anything;
   * fetching one record per account in the whole directory would be a request
   * storm for a page that lists hundreds, hence the bound.
   */
  useEffect(() => {
    const wanted = items.filter((user) => user.is_active && needsBranch(user) && !orgById[user.id]).slice(0, 40);
    if (wanted.length === 0) return;
    let cancelled = false;
    (async () => {
      for (let index = 0; index < wanted.length; index += 6) {
        const chunk = wanted.slice(index, index + 6);
        const records = await Promise.all(
          chunk.map((user) => getUserOrg(user.id).then((response) => [user.id, response] as const).catch(() => null)),
        );
        if (cancelled) return;
        const resolved = records.filter((entry): entry is readonly [number, Awaited<ReturnType<typeof getUserOrg>>] => entry != null);
        if (resolved.length === 0) continue;
        setOrgById((current) => ({ ...current, ...Object.fromEntries(resolved.map(([id, response]) => [id, response.org])) }));
        setSuggestionById((current) => ({ ...current, ...Object.fromEntries(resolved.map(([id, response]) => [id, response.role_suggestion])) }));
      }
    })();
    return () => { cancelled = true; };
    // Deliberately keyed on the row set: a re-render must not re-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const officeById = useMemo(() => new Map(offices.map((office) => [office.id, office])), [offices]);
  const officeByCode = useMemo(() => new Map(offices.map((office) => [office.code, office])), [offices]);
  const branchById = useMemo(() => new Map(branches.map((branch) => [branch.id, branch])), [branches]);
  const classChoices = useMemo(
    () => classifications.filter((rule) => (rule.rule_kind ?? "CLASS").toUpperCase() === "CLASS" && rule.class_code),
    [classifications],
  );

  const counts = useMemo(() => ({
    all: items.length,
    active: items.filter((user) => user.is_active).length,
    inactive: items.filter((user) => !user.is_active).length,
    admins: items.filter((user) => user.roles.includes("ADMIN")).length,
  }), [items]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return items.filter((user) => {
      if (statusFilter === "ACTIVE" && !user.is_active) return false;
      if (statusFilter === "INACTIVE" && user.is_active) return false;
      if (!normalized) return true;
      const org = orgById[user.id];
      return user.email.toLowerCase().includes(normalized)
        || user.full_name.toLowerCase().includes(normalized)
        || user.roles.some((role) => role.toLowerCase().includes(normalized))
        || (org?.office_name ?? "").toLowerCase().includes(normalized)
        || (org?.branch_name ?? "").toLowerCase().includes(normalized)
        || String(user.id).includes(normalized);
    });
  }, [items, orgById, query, statusFilter]);

  /** Office and branch as the row shows them: the org record first, the legacy mirror second. */
  function officeOf(user: AdminUser): { name: string | null; place: string | null; branch: string | null; known: boolean } {
    const org = orgById[user.id];
    if (org) {
      return {
        name: org.office_name ?? org.office_code ?? null,
        place: placeLabel(org.home_city, org.home_district),
        branch: branchLabel({ letter: org.branch_letter, name: org.branch_name }),
        known: true,
      };
    }
    const code = user.metadata?.office_code ?? null;
    const office = code ? officeByCode.get(code) : undefined;
    return {
      name: office?.name ?? code,
      place: placeLabel(null, user.metadata?.district),
      branch: null,
      known: false,
    };
  }

  function toggleRole(current: string[], role: string) {
    return current.includes(role) ? current.filter((value) => value !== role) : [...current, role];
  }

  function closeCreate() {
    setCreateOpen(false);
    setEmail("");
    setFullName("");
    setPassword("");
    setNewRoles([]);
    setNewOfficeId("");
    setNewBranchId("");
  }

  async function createUser() {
    setError(null);
    setNotice(null);
    if (!email.trim() || !fullName.trim() || !password) {
      setError("Email, full name, and initial password are required.");
      return;
    }
    if (newRoles.length === 0) {
      setError("Select at least one role for the new account.");
      return;
    }
    setBusy(true);
    try {
      // The account first, then WHERE it sits — org facts have their own
      // endpoint now, so nothing here writes into `metadata`.
      const created = await api<AdminUser>("/admin/users", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), full_name: fullName.trim(), password, roles: newRoles }),
      });
      if (newOfficeId) {
        await putUserOrg(created.id, {
          office_id: Number(newOfficeId),
          branch_id: newBranchId ? Number(newBranchId) : null,
        });
      }
      setNotice(`Created account for ${fullName.trim()}.`);
      closeCreate();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create user.");
    } finally {
      setBusy(false);
    }
  }

  async function saveRoles(user: AdminUser) {
    const roles = draftRoles[user.id] ?? [];
    if (roles.length === 0) {
      setError("Each active ERIS account must retain at least one application role.");
      return;
    }
    setRowBusy(user.id);
    setError(null);
    setNotice(null);
    try {
      await api(`/admin/users/${user.id}/roles`, { method: "PUT", body: JSON.stringify({ roles }) });
      setNotice(`Updated the roles for ${user.full_name}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update the account.");
    } finally {
      setRowBusy(null);
    }
  }

  function openOrgEditor(user: AdminUser) {
    if (openUserId === user.id) {
      setOpenUserId(null);
      setOrgDraft(null);
      return;
    }
    setOpenUserId(user.id);
    setConfirmNoBranch(false);
    setError(null);
    setNotice(null);
    setOrgDraft(draftOf(orgById[user.id]));
    getUserOrg(user.id)
      .then((response) => {
        setOrgById((current) => ({ ...current, [user.id]: response.org }));
        setSuggestionById((current) => ({ ...current, [user.id]: response.role_suggestion }));
        setOrgDraft(draftOf(response.org));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load this account's organization record."));
  }

  async function saveOrg(user: AdminUser) {
    if (!orgDraft) return;
    if (needsBranch(user) && !orgDraft.branch_id && !confirmNoBranch) {
      setConfirmNoBranch(true);
      setError(`${user.full_name} holds a role that works inside a branch, and no branch is chosen. Choose one, or press Save again to record the account without one.`);
      return;
    }
    setRowBusy(user.id);
    setError(null);
    setNotice(null);
    try {
      const response = await putUserOrg(user.id, {
        office_id: orgDraft.office_id ? Number(orgDraft.office_id) : null,
        branch_id: orgDraft.branch_id ? Number(orgDraft.branch_id) : null,
        classification_code: orgDraft.classification_code.trim() || null,
        classification_marker: orgDraft.classification_marker.trim() || null,
        position_number: orgDraft.position_number.trim() || null,
        job_title: orgDraft.job_title.trim() || null,
        level_code: orgDraft.level_code.trim() || null,
        home_city: orgDraft.home_city.trim() || null,
        home_district: orgDraft.home_district.trim() || null,
        availability: orgDraft.availability,
        available_until: orgDraft.available_until.trim() || null,
      });
      setOrgById((current) => ({ ...current, [user.id]: response.org }));
      setSuggestionById((current) => ({ ...current, [user.id]: response.role_suggestion }));
      setOrgDraft(draftOf(response.org));
      setConfirmNoBranch(false);
      setNotice(`Saved where ${user.full_name} sits. Roles are unchanged.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save the organization record.");
    } finally {
      setRowBusy(null);
    }
  }

  async function setActive(user: AdminUser, active: boolean) {
    setRowBusy(user.id);
    setError(null);
    setNotice(null);
    try {
      await api(`/admin/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ is_active: active }) });
      setNotice(`${user.full_name} is now ${active ? "active" : "inactive"}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update account status.");
    } finally {
      setRowBusy(null);
    }
  }

  async function resetPassword(passwordValue: string) {
    if (!resetUser) return;
    setRowBusy(resetUser.id);
    setNotice(null);
    try {
      await api(`/admin/users/${resetUser.id}/reset-password`, { method: "POST", body: JSON.stringify({ password: passwordValue }) });
      setNotice(`Password reset for ${resetUser.full_name}.`);
      setResetUser(null);
    } finally {
      setRowBusy(null);
    }
  }

  const branchesForOffice = (officeId: string) =>
    branches.filter((branch) => String(branch.office_id) === officeId && branch.unit_type === "BRANCH");

  return (
    <AppShell title="User Administration">
      <div className="flex h-full flex-col gap-4 p-4 md:p-5">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[["Accounts", counts.all, "All ERIS users"], ["Active", counts.active, "Can sign in"], ["Inactive", counts.inactive, "Access disabled"], ["Administrators", counts.admins, "ADMIN role"]].map(([label, value, hint]) => (
            <div key={String(label)} className="rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</div>
              <div className="mt-2 text-2xl font-semibold">{value}</div>
              <div className="mt-1 text-xs text-muted">{hint}</div>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 md:flex-row md:items-center md:justify-between">
          <div><div className="text-sm font-semibold">ERIS access management</div><div className="mt-1 text-sm text-muted">Create accounts, manage operational roles, record where a person sits, reset passwords, and disable access.</div></div>
          <button type="button" onClick={() => setCreateOpen((open) => !open)} className="self-start rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-semibold text-white hover:brightness-95 md:self-auto">{createOpen ? "Close new account" : "New account"}</button>
        </div>

        {createOpen ? (
          <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 md:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Create ERIS account</h2><p className="mt-1 text-sm text-muted">Assign only the roles required for this user’s operational responsibilities.</p></div><button type="button" onClick={closeCreate} disabled={busy} className="rounded-md border border-[var(--line)] px-3 py-2 text-sm font-medium disabled:opacity-50">Cancel</button></div>
            <div className="mt-5 grid gap-4 md:grid-cols-3">
              <label className="grid gap-1.5"><span className="text-xs font-semibold uppercase tracking-wide text-muted">Email *</span><input type="email" autoComplete="off" className={inputClass} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
              <label className="grid gap-1.5"><span className="text-xs font-semibold uppercase tracking-wide text-muted">Full name *</span><input className={inputClass} value={fullName} onChange={(event) => setFullName(event.target.value)} /></label>
              <label className="grid gap-1.5"><span className="text-xs font-semibold uppercase tracking-wide text-muted">Initial password *</span><input type="password" autoComplete="new-password" className={inputClass} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
              <label className="grid gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted">Office</span>
                <select className={inputClass} value={newOfficeId} onChange={(event) => { setNewOfficeId(event.target.value); setNewBranchId(""); }}>
                  <option value="">Not recorded</option>
                  {offices.map((office) => <option key={office.id} value={office.id}>{office.name || office.code}</option>)}
                </select>
                <span className="text-[11px] text-muted">Chiefs and senior engineers are scoped to an office; without one they can neither be assigned nor review.</span>
              </label>
              <label className="grid gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted">Branch</span>
                <select className={inputClass} value={newBranchId} disabled={!newOfficeId} onChange={(event) => setNewBranchId(event.target.value)}>
                  <option value="">{newOfficeId ? "Not recorded" : "Choose an office first"}</option>
                  {branchesForOffice(newOfficeId).map((branch) => <option key={branch.id} value={branch.id}>{branchLabel(branch)}</option>)}
                </select>
                <span className="text-[11px] text-muted">Meaningful for Staff and branch chiefs.</span>
              </label>
            </div>
            <div className="mt-4"><div className="text-xs font-semibold uppercase tracking-wide text-muted">Initial roles</div><RoleChoices options={roleOptions} selected={newRoles} onToggle={(role) => setNewRoles((current) => toggleRole(current, role))} /></div>
            <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={closeCreate} disabled={busy} className="rounded-md border border-[var(--line)] px-3 py-2 text-sm font-medium disabled:opacity-50">Cancel</button><button type="button" onClick={createUser} disabled={busy} className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Creating…" : "Create account"}</button></div>
          </section>
        ) : null}

        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, email, role, office, branch, or user ID" className={`${inputClass} md:max-w-xl`} />
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "ALL" | "ACTIVE" | "INACTIVE")} className={`${inputClass} md:w-52`}><option value="ALL">All accounts</option><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select>
          <button type="button" onClick={() => void load()} disabled={busy} className="rounded-md border border-[var(--line)] px-3 py-2 text-sm font-medium disabled:opacity-50">{busy ? "Refreshing…" : "Refresh"}</button>
        </div>

        {error ? <div role="alert" className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}
        {notice ? <div className="rounded-md border border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] px-3 py-2 text-sm text-[var(--good)]">{notice}</div> : null}

        <div className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-xs text-muted">
          Office, branch and classification are organization records — they are saved on their own and never change an account&apos;s roles. Manage the offices and branches themselves under Administration › Offices and Branches.
        </div>

        <div className="flex-1 overflow-auto rounded-xl border border-[var(--line)] bg-[var(--panel)]">
          <table className="w-full border-collapse">
            <thead><tr className="border-b border-[var(--line)] bg-[var(--panel-soft)] text-left text-xs font-semibold uppercase tracking-wide text-muted"><th className="px-3 py-3">User</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Organization</th><th className="px-3 py-3">Roles</th><th className="px-3 py-3 text-right">Actions</th></tr></thead>
            <tbody>
              {filtered.length === 0 ? <tr><td colSpan={5} className="px-3 py-8 text-sm text-muted">{busy ? "Loading users…" : "No users match the current filters."}</td></tr> : filtered.map((user) => {
                const roles = draftRoles[user.id] ?? [];
                const rolesChanged = JSON.stringify([...roles].sort()) !== JSON.stringify([...user.roles].sort());
                const org = officeOf(user);
                const branchMissing = needsBranch(user) && org.known && !orgById[user.id]?.branch_id;
                const isOpen = openUserId === user.id;
                const rowWorking = rowBusy === user.id;
                return (
                  <Fragment key={user.id}>
                    <tr className="border-b border-[var(--line)]/60 align-top last:border-b-0">
                      <td className="px-3 py-3 text-sm"><div className="font-semibold">{user.full_name}</div><div className="text-xs text-muted">{user.email}</div><div className="mt-1 text-[11px] text-muted">User #{user.id}</div></td>
                      <td className="px-3 py-3"><AccountStatusBadge active={user.is_active} /></td>
                      <td className="px-3 py-3 text-sm">
                        <div className="font-medium">{org.name ?? <span className="text-muted">No office recorded</span>}</div>
                        <div className="text-xs text-muted">
                          {[org.branch, org.place].filter(Boolean).join(" · ") || (org.known ? "No branch recorded" : "—")}
                        </div>
                        {branchMissing ? (
                          <div className="mt-1 inline-flex rounded-full border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-2 py-0.5 text-[11px] font-semibold text-[var(--bad)]">
                            No branch — cannot be assigned correctly
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-3"><RoleChoices options={roleOptions} selected={roles} compact onToggle={(role) => setDraftRoles((previous) => ({ ...previous, [user.id]: toggleRole(previous[user.id] ?? [], role) }))} /></td>
                      <td className="px-3 py-3 text-right">
                        <div className="inline-flex flex-wrap justify-end gap-1.5">
                          <button type="button" onClick={() => void saveRoles(user)} disabled={rowWorking || !rolesChanged} className={smallButton}>Save roles</button>
                          <button type="button" onClick={() => openOrgEditor(user)} disabled={rowWorking} className={smallButton}>{isOpen ? "Close" : "Organization"}</button>
                          <button type="button" onClick={() => setResetUser(user)} disabled={rowWorking} className={smallButton}>Reset password</button>
                          <button type="button" onClick={() => void setActive(user, !user.is_active)} disabled={rowWorking} className={`rounded border px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50 ${user.is_active ? "border-[color:color-mix(in_oklab,var(--bad)_45%,var(--line))] text-[var(--bad)]" : "border-[color:color-mix(in_oklab,var(--good)_45%,var(--line))] text-[var(--good)]"}`}>{user.is_active ? "Disable" : "Enable"}</button>
                        </div>
                      </td>
                    </tr>
                    {isOpen && orgDraft ? (
                      <tr className="border-b border-[var(--line)]/60 bg-[var(--panel-soft)]">
                        <td colSpan={5} className="px-3 py-4">
                          <div className="grid gap-3">
                            <div className="text-sm font-semibold">Where {user.full_name} sits</div>
                            <div className="grid gap-3 md:grid-cols-3">
                              <label className="grid gap-1.5">
                                <span className="text-xs font-semibold uppercase tracking-wide text-muted">Office</span>
                                <select className={inputClass} value={orgDraft.office_id} onChange={(event) => setOrgDraft((d) => (d ? { ...d, office_id: event.target.value, branch_id: "" } : d))}>
                                  <option value="">Not recorded</option>
                                  {offices.map((office) => <option key={office.id} value={office.id}>{office.name || office.code}</option>)}
                                </select>
                              </label>
                              <label className="grid gap-1.5">
                                <span className="text-xs font-semibold uppercase tracking-wide text-muted">Branch</span>
                                <select className={inputClass} value={orgDraft.branch_id} disabled={!orgDraft.office_id} onChange={(event) => setOrgDraft((d) => (d ? { ...d, branch_id: event.target.value } : d))}>
                                  <option value="">{orgDraft.office_id ? "Not recorded" : "Choose an office first"}</option>
                                  {branchesForOffice(orgDraft.office_id).map((branch) => <option key={branch.id} value={branch.id}>{branchLabel(branch)}{branch.accepts_assignments ? "" : " — not offered in pickers"}</option>)}
                                </select>
                                {needsBranch(user) ? <span className="text-[11px] text-muted">This account holds a role that works inside a branch.</span> : null}
                              </label>
                              <label className="grid gap-1.5">
                                <span className="text-xs font-semibold uppercase tracking-wide text-muted">Classification</span>
                                <select
                                  className={inputClass}
                                  value={`${orgDraft.classification_code}|${orgDraft.classification_marker}`}
                                  onChange={(event) => {
                                    const [code, marker] = event.target.value.split("|");
                                    const rule = classChoices.find((row) => (row.class_code ?? "") === code && (row.marker ?? "") === (marker ?? ""));
                                    setOrgDraft((d) => (d ? {
                                      ...d,
                                      classification_code: code ?? "",
                                      classification_marker: marker ?? "",
                                      job_title: rule?.title ?? d.job_title,
                                      level_code: rule?.level_code ?? d.level_code,
                                    } : d));
                                  }}
                                >
                                  <option value="|">Not recorded</option>
                                  {classChoices.map((rule) => (
                                    <option key={rule.id} value={`${rule.class_code ?? ""}|${rule.marker ?? ""}`}>
                                      {rule.class_code}{rule.marker ? ` (${rule.marker})` : ""} — {rule.title}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label className="grid gap-1.5"><span className="text-xs font-semibold uppercase tracking-wide text-muted">Position number</span><input className={inputClass} value={orgDraft.position_number} placeholder="559-315-3161-050" onChange={(event) => setOrgDraft((d) => (d ? { ...d, position_number: event.target.value } : d))} /></label>
                              <label className="grid gap-1.5"><span className="text-xs font-semibold uppercase tracking-wide text-muted">Home city</span><input className={inputClass} value={orgDraft.home_city} onChange={(event) => setOrgDraft((d) => (d ? { ...d, home_city: event.target.value } : d))} /></label>
                              <label className="grid gap-1.5"><span className="text-xs font-semibold uppercase tracking-wide text-muted">Home district</span><input className={inputClass} value={orgDraft.home_district} placeholder="04" onChange={(event) => setOrgDraft((d) => (d ? { ...d, home_district: event.target.value } : d))} /></label>
                              <label className="grid gap-1.5">
                                <span className="text-xs font-semibold uppercase tracking-wide text-muted">Availability</span>
                                <select className={inputClass} value={orgDraft.availability} onChange={(event) => setOrgDraft((d) => (d ? { ...d, availability: event.target.value as OrgDraft["availability"] } : d))}>
                                  <option value="AVAILABLE">Available</option>
                                  <option value="ROTATION_OUT">Rotation out</option>
                                  <option value="ACTING_ELSEWHERE">Acting elsewhere</option>
                                  <option value="UNAVAILABLE">Unavailable</option>
                                </select>
                                <span className="text-[11px] text-muted">Shown beside their name in a picker. Nobody is ever hidden or reordered by it.</span>
                              </label>
                              <label className="grid gap-1.5"><span className="text-xs font-semibold uppercase tracking-wide text-muted">Back on</span><input type="date" className={inputClass} value={orgDraft.available_until} onChange={(event) => setOrgDraft((d) => (d ? { ...d, available_until: event.target.value } : d))} /></label>
                            </div>
                            <SuggestionLine suggestion={suggestionById[user.id]} />
                            {orgDraft.office_id && officeById.get(Number(orgDraft.office_id))?.is_routing_target === false ? (
                              <p className="text-[13px] text-muted">This office is not a routing target, so no district report will be sent to it.</p>
                            ) : null}
                            {orgDraft.branch_id && branchById.get(Number(orgDraft.branch_id))?.accepts_assignments === false ? (
                              <p className="text-[13px] text-muted">That branch is not offered in pickers yet, so this account will not appear as a hand-off target.</p>
                            ) : null}
                            <div className="flex justify-end gap-2">
                              <button type="button" className={smallButton} onClick={() => { setOpenUserId(null); setOrgDraft(null); setConfirmNoBranch(false); }}>Cancel</button>
                              <button type="button" className="rounded-md bg-[var(--brand)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50" disabled={rowWorking} onClick={() => void saveOrg(user)}>
                                {confirmNoBranch ? "Save without a branch" : "Save organization"}
                              </button>
                            </div>
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
      </div>

      {resetUser ? <PasswordResetDialog userName={resetUser.full_name} busy={rowBusy === resetUser.id} onClose={() => setResetUser(null)} onConfirm={resetPassword} /> : null}
    </AppShell>
  );
}

function RoleChoices({ options, selected, onToggle, compact = false }: { options: string[]; selected: string[]; onToggle: (role: string) => void; compact?: boolean }) {
  return (
    <div className={`flex flex-wrap gap-1.5 ${compact ? "max-w-3xl" : "mt-2"}`}>
      {options.map((role) => {
        const active = selected.includes(role);
        return (
          <label key={role} title={role} className={`inline-flex cursor-pointer items-center rounded-full border px-2.5 py-1 text-[11px] font-medium ${active ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_10%,transparent)] text-[var(--brand)]" : "border-[var(--line)] bg-[var(--panel-soft)] text-muted"}`}>
            <input className="sr-only" type="checkbox" checked={active} onChange={() => onToggle(role)} />
            {roleLabel(role)}
          </label>
        );
      })}
    </div>
  );
}

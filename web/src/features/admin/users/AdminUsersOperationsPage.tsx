import { useEffect, useMemo, useState } from "react";

import { api } from "../../../api/client";
import type { AdminUser } from "../../../api/types";
import AppShell from "../../../ui/AppShell";
import PasswordResetDialog from "./PasswordResetDialog";

const ROLE_OPTIONS = [
  "ADMIN",
  "CENTRAL_COORDINATOR",
  "OFFICE_CHIEF",
  "BRANCH_CHIEF",
  "GEOTECH_ENGINEER",
  "SPECIALIST",
  "PEER_REVIEWER",
  "REVIEWER",
  "FIELD_WORKER",
] as const;

const roleLabel = (role: string) => role.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (letter: string) => letter.toUpperCase());

function AccountStatusBadge({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${
        active
          ? "border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] text-[var(--good)]"
          : "border-[var(--line)] bg-[var(--panel-soft)] text-muted"
      }`}
    >
      {active ? "Active" : "Inactive"}
    </span>
  );
}

export default function AdminUsersOperationsPage() {
  const [items, setItems] = useState<AdminUser[]>([]);
  const [draftRoles, setDraftRoles] = useState<Record<number, string[]>>({});
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "ACTIVE" | "INACTIVE">("ALL");
  const [createOpen, setCreateOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [newRoles, setNewRoles] = useState<string[]>(["FIELD_WORKER"]);
  const [resetUser, setResetUser] = useState<AdminUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const inputClass = "w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]";

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const response = await api<{ items: AdminUser[] }>("/admin/users");
      const next = response.items ?? [];
      setItems(next);
      setDraftRoles(Object.fromEntries(next.map((user) => [user.id, [...user.roles]])));
    } catch (e: any) {
      setError(e?.message ?? "Failed to load users.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const counts = useMemo(() => ({
    all: items.length,
    active: items.filter((user) => user.is_active).length,
    inactive: items.filter((user) => !user.is_active).length,
    admins: items.filter((user) => user.roles.includes("ADMIN")).length,
  }), [items]);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return items.filter((user) => {
      if (statusFilter === "ACTIVE" && !user.is_active) return false;
      if (statusFilter === "INACTIVE" && user.is_active) return false;
      if (!normalizedQuery) return true;
      return (
        user.email.toLowerCase().includes(normalizedQuery) ||
        user.full_name.toLowerCase().includes(normalizedQuery) ||
        user.roles.some((role) => role.toLowerCase().includes(normalizedQuery)) ||
        String(user.id).includes(normalizedQuery)
      );
    });
  }, [items, query, statusFilter]);

  function toggleNewRole(role: string) {
    setNewRoles((previous) => previous.includes(role) ? previous.filter((value) => value !== role) : [...previous, role]);
  }

  function toggleDraftRole(userId: number, role: string) {
    setDraftRoles((previous) => {
      const current = previous[userId] ?? [];
      return {
        ...previous,
        [userId]: current.includes(role) ? current.filter((value) => value !== role) : [...current, role],
      };
    });
  }

  function closeCreate() {
    setCreateOpen(false);
    setEmail("");
    setFullName("");
    setPassword("");
    setNewRoles(["FIELD_WORKER"]);
  }

  async function createUser() {
    setError(null);
    setNotice(null);
    if (!email.trim() || !fullName.trim() || !password) {
      setError("Email, full name, and initial password are required.");
      return;
    }
    setBusy(true);
    try {
      await api("/admin/users", {
        method: "POST",
        body: JSON.stringify({
          email: email.trim(),
          full_name: fullName.trim(),
          password,
          roles: newRoles.length ? newRoles : ["FIELD_WORKER"],
        }),
      });
      setNotice(`Created account for ${fullName.trim()}.`);
      closeCreate();
      await load();
    } catch (e: any) {
      setError(e?.message ?? "Failed to create user.");
    } finally {
      setBusy(false);
    }
  }

  async function saveRoles(user: AdminUser) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const roles = draftRoles[user.id] ?? [];
      await api(`/admin/users/${user.id}/roles`, {
        method: "PATCH",
        body: JSON.stringify({ roles }),
      });
      setNotice(`Updated roles for ${user.full_name}.`);
      await load();
    } catch (e: any) {
      setError(e?.message ?? "Failed to update roles.");
    } finally {
      setBusy(false);
    }
  }

  async function setActive(user: AdminUser, active: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/admin/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_active: active }),
      });
      setNotice(`${user.full_name} is now ${active ? "active" : "inactive"}.`);
      await load();
    } catch (e: any) {
      setError(e?.message ?? "Failed to update account status.");
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(passwordValue: string) {
    if (!resetUser) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/admin/users/${resetUser.id}/reset-password`, {
        method: "POST",
        body: JSON.stringify({ password: passwordValue }),
      });
      setNotice(`Password reset for ${resetUser.full_name}.`);
      setResetUser(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell title="User Administration">
      <div className="flex h-full flex-col gap-4 p-4 md:p-5">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            ["Accounts", counts.all, "All ERIS users"],
            ["Active", counts.active, "Can sign in"],
            ["Inactive", counts.inactive, "Access disabled"],
            ["Administrators", counts.admins, "ADMIN role"],
          ].map(([label, value, hint]) => (
            <div key={String(label)} className="rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</div>
              <div className="mt-2 text-2xl font-semibold">{value}</div>
              <div className="mt-1 text-xs text-muted">{hint}</div>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-sm font-semibold">ERIS access management</div>
            <div className="mt-1 text-sm text-muted">Create accounts, manage operational roles, reset passwords, and disable access.</div>
          </div>
          <button
            type="button"
            onClick={() => setCreateOpen((open) => !open)}
            className="self-start rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-semibold text-white hover:brightness-95 md:self-auto"
          >
            {createOpen ? "Close new account" : "New account"}
          </button>
        </div>

        {createOpen ? (
          <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 md:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Create ERIS account</h2>
                <p className="mt-1 text-sm text-muted">Assign only the roles required for this user’s operational responsibilities.</p>
              </div>
              <button type="button" onClick={closeCreate} disabled={busy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">Cancel</button>
            </div>
            <div className="mt-5 grid gap-4 md:grid-cols-3">
              <label className="grid gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted">Email *</span>
                <input type="email" autoComplete="off" className={inputClass} value={email} onChange={(event) => setEmail(event.target.value)} />
              </label>
              <label className="grid gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted">Full name *</span>
                <input className={inputClass} value={fullName} onChange={(event) => setFullName(event.target.value)} />
              </label>
              <label className="grid gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted">Initial password *</span>
                <input type="password" autoComplete="new-password" className={inputClass} value={password} onChange={(event) => setPassword(event.target.value)} />
              </label>
            </div>
            <div className="mt-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">Initial roles</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {ROLE_OPTIONS.map((role) => {
                  const selected = newRoles.includes(role);
                  return (
                    <label key={role} className={`inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium ${selected ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_10%,transparent)] text-[var(--brand)]" : "border-[var(--line)] bg-[var(--panel-soft)] text-[var(--ink)]"}`}>
                      <input className="sr-only" type="checkbox" checked={selected} onChange={() => toggleNewRole(role)} />
                      {roleLabel(role)}
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={closeCreate} disabled={busy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">Cancel</button>
              <button type="button" onClick={createUser} disabled={busy} className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50">{busy ? "Creating…" : "Create account"}</button>
            </div>
          </section>
        ) : null}

        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, email, role, or user ID"
            className={`${inputClass} md:max-w-xl`}
          />
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "ALL" | "ACTIVE" | "INACTIVE")} className={`${inputClass} md:w-52`}>
            <option value="ALL">All accounts</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </select>
          <button type="button" onClick={load} disabled={busy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">{busy ? "Refreshing…" : "Refresh"}</button>
        </div>

        {error ? <div className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}
        {notice ? <div className="rounded-md border border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] px-3 py-2 text-sm text-[var(--good)]">{notice}</div> : null}

        <div className="flex-1 overflow-auto rounded-xl border border-[var(--line)] bg-[var(--panel)]">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-[var(--line)] bg-[var(--panel-soft)] text-left text-xs font-semibold uppercase tracking-wide text-muted">
                <th className="px-3 py-3">User</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Roles</th>
                <th className="px-3 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={4} className="px-3 py-8 text-sm text-muted">{busy ? "Loading users…" : "No users match the current filters."}</td></tr>
              ) : filtered.map((user) => {
                const roles = draftRoles[user.id] ?? [];
                const rolesChanged = JSON.stringify([...roles].sort()) !== JSON.stringify([...user.roles].sort());
                return (
                  <tr key={user.id} className="border-b border-[var(--line)]/60 align-top last:border-b-0">
                    <td className="px-3 py-3 text-sm">
                      <div className="font-semibold">{user.full_name}</div>
                      <div className="text-xs text-muted">{user.email}</div>
                      <div className="mt-1 text-[11px] text-muted">User #{user.id}</div>
                    </td>
                    <td className="px-3 py-3"><AccountStatusBadge active={user.is_active} /></td>
                    <td className="px-3 py-3">
                      <div className="flex max-w-3xl flex-wrap gap-1.5">
                        {ROLE_OPTIONS.map((role) => {
                          const selected = roles.includes(role);
                          return (
                            <label key={role} className={`inline-flex cursor-pointer items-center rounded-full border px-2.5 py-1 text-[11px] font-medium ${selected ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_10%,transparent)] text-[var(--brand)]" : "border-[var(--line)] bg-[var(--panel-soft)] text-muted"}`}>
                              <input className="sr-only" type="checkbox" checked={selected} onChange={() => toggleDraftRole(user.id, role)} />
                              {roleLabel(role)}
                            </label>
                          );
                        })}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="inline-flex flex-wrap justify-end gap-1.5">
                        <button type="button" onClick={() => saveRoles(user)} disabled={busy || !rolesChanged} className="rounded border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 text-xs font-semibold hover:bg-[var(--panel-soft)] disabled:cursor-not-allowed disabled:opacity-40">Save roles</button>
                        <button type="button" onClick={() => setResetUser(user)} disabled={busy} className="rounded border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 text-xs font-semibold hover:bg-[var(--panel-soft)] disabled:opacity-50">Reset password</button>
                        <button
                          type="button"
                          onClick={() => setActive(user, !user.is_active)}
                          disabled={busy}
                          className={`rounded border px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50 ${user.is_active ? "border-[color:color-mix(in_oklab,var(--bad)_45%,var(--line))] text-[var(--bad)]" : "border-[color:color-mix(in_oklab,var(--good)_45%,var(--line))] text-[var(--good)]"}`}
                        >
                          {user.is_active ? "Disable" : "Enable"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {resetUser ? (
        <PasswordResetDialog
          userName={resetUser.full_name}
          busy={busy}
          onClose={() => setResetUser(null)}
          onConfirm={resetPassword}
        />
      ) : null}
    </AppShell>
  );
}

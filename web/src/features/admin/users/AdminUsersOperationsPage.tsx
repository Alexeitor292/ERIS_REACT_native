import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Network, ShieldCheck } from "lucide-react";

import { api } from "../../../api/client";
import { setAdmin } from "../../../api/orgTree";
import type { AdminUser } from "../../../api/types";
import AppShell from "../../../ui/AppShell";
import { roleLabel } from "../../../utils/roleModel";
import PasswordResetDialog from "./PasswordResetDialog";

type UserRow = AdminUser & { places?: string[] };

/**
 * Administration › Users: accounts, and who is an administrator.
 *
 * Every other role follows from where a person sits on the Organization page (an
 * office tree or a district's maintenance list); nobody in either is a Guest. So
 * this page creates, enables and disables accounts, resets passwords, and grants
 * or removes Administrator, and nothing else.
 */
export default function AdminUsersOperationsPage() {
  const [items, setItems] = useState<UserRow[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "ACTIVE" | "INACTIVE" | "ADMIN">("ALL");
  const [createOpen, setCreateOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [resetUser, setResetUser] = useState<AdminUser | null>(null);
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
      setItems((await api<{ items: UserRow[] }>("/admin/users?limit=500")).items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the accounts.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
      if (statusFilter === "ADMIN" && !user.roles.includes("ADMIN")) return false;
      if (!normalized) return true;
      return user.email.toLowerCase().includes(normalized)
        || user.full_name.toLowerCase().includes(normalized)
        || user.roles.some((role) => roleLabel(role).toLowerCase().includes(normalized))
        || (user.places ?? []).some((place) => place.toLowerCase().includes(normalized))
        || String(user.id).includes(normalized);
    });
  }, [items, query, statusFilter]);

  function closeCreate() {
    setCreateOpen(false);
    setEmail("");
    setFullName("");
    setPassword("");
  }

  async function createUser() {
    setError(null);
    setNotice(null);
    if (!email.trim() || !fullName.trim() || !password) {
      setError("Email, full name and an initial password are required.");
      return;
    }
    setBusy(true);
    try {
      await api<AdminUser>("/admin/users", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), full_name: fullName.trim(), password }),
      });
      setNotice(`Created ${fullName.trim()} as a Guest. Place them on the Organization page to give them a role.`);
      closeCreate();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create the account.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleAdmin(user: UserRow) {
    const making = !user.roles.includes("ADMIN");
    if (!making && !window.confirm(`Remove administrator access from ${user.full_name}?`)) return;
    setRowBusy(user.id);
    setError(null);
    setNotice(null);
    try {
      await setAdmin(user.id, making);
      setNotice(making ? `${user.full_name} is now an administrator.` : `${user.full_name} is no longer an administrator.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to change administrator access.");
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
      setError(e instanceof Error ? e.message : "Failed to update the account.");
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

  return (
    <AppShell title="User Administration">
      <div className="flex h-full flex-col gap-4 p-4 md:p-5">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[["Accounts", counts.all, "All ERIS users"], ["Active", counts.active, "Can sign in"], ["Inactive", counts.inactive, "Access disabled"], ["Administrators", counts.admins, "Full access"]].map(([label, value, hint]) => (
            <div key={String(label)} className="rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</div>
              <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
              <div className="mt-1 text-xs text-muted">{hint}</div>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-sm font-semibold">Accounts and administrators</div>
            <div className="mt-1 text-sm text-muted">
              Roles come from where a person sits:{" "}
              <Link to="/organization" className="inline-flex items-center gap-1 font-medium text-[var(--brand)] hover:underline">
                <Network size={13} /> Organization
              </Link>
              . Here you create accounts, reset passwords, disable access and choose administrators.
            </div>
          </div>
          <button type="button" onClick={() => setCreateOpen((open) => !open)} className="self-start rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-semibold text-white hover:brightness-95 md:self-auto">
            {createOpen ? "Close new account" : "New account"}
          </button>
        </div>

        {createOpen ? (
          <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 md:p-5">
            <h2 className="text-lg font-semibold">Create an ERIS account</h2>
            <p className="mt-1 text-sm text-muted">New accounts are Guests (read-only) until they are placed in an office tree or a district list, or made administrators.</p>
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <label className="grid gap-1.5"><span className="text-xs font-semibold uppercase tracking-wide text-muted">Email *</span><input type="email" autoComplete="off" className={inputClass} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
              <label className="grid gap-1.5"><span className="text-xs font-semibold uppercase tracking-wide text-muted">Full name *</span><input className={inputClass} value={fullName} onChange={(event) => setFullName(event.target.value)} /></label>
              <label className="grid gap-1.5"><span className="text-xs font-semibold uppercase tracking-wide text-muted">Initial password *</span><input type="password" autoComplete="new-password" className={inputClass} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={closeCreate} disabled={busy} className="rounded-md border border-[var(--line)] px-3 py-2 text-sm font-medium disabled:opacity-50">Cancel</button>
              <button type="button" onClick={createUser} disabled={busy} className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Creating…" : "Create account"}</button>
            </div>
          </section>
        ) : null}

        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, email, role, office, district or user ID" className={`${inputClass} md:max-w-xl`} />
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)} className={`${inputClass} md:w-52`}>
            <option value="ALL">All accounts</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
            <option value="ADMIN">Administrators</option>
          </select>
          <button type="button" onClick={() => void load()} disabled={busy} className="rounded-md border border-[var(--line)] px-3 py-2 text-sm font-medium disabled:opacity-50">{busy ? "Refreshing…" : "Refresh"}</button>
        </div>

        {error ? <div role="alert" className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}
        {notice ? <div role="status" className="rounded-md border border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] px-3 py-2 text-sm text-[var(--good)]">{notice}</div> : null}

        <div className="flex-1 overflow-auto rounded-xl border border-[var(--line)] bg-[var(--panel)]">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-[var(--line)] bg-[var(--panel-soft)] text-left text-xs font-semibold uppercase tracking-wide text-muted">
                <th className="px-3 py-3">User</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Role, from where they sit</th>
                <th className="px-3 py-3">Administrator</th>
                <th className="px-3 py-3 text-right">Account</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={5} className="px-3 py-8 text-sm text-muted">{busy ? "Loading accounts…" : "No accounts match the current filters."}</td></tr>
              ) : filtered.map((user) => {
                const isAdmin = user.roles.includes("ADMIN");
                const workRoles = user.roles.filter((role) => role !== "ADMIN");
                const rowWorking = rowBusy === user.id;
                return (
                  <tr key={user.id} className="border-b border-[var(--line)]/60 align-top last:border-b-0">
                    <td className="px-3 py-3 text-sm">
                      <div className="font-semibold">{user.full_name}</div>
                      <div className="text-xs text-muted">{user.email}</div>
                      <div className="mt-1 text-[11px] text-muted">User #{user.id}</div>
                    </td>
                    <td className="px-3 py-3">
                      <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${user.is_active ? "border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] text-[var(--good)]" : "border-[var(--line)] text-muted"}`}>
                        {user.is_active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-sm">
                      <div className="flex flex-wrap gap-1">
                        {workRoles.length ? workRoles.map((role) => (
                          <span key={role} className="rounded-full border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-0.5 text-[11px] font-medium">{roleLabel(role)}</span>
                        )) : isAdmin ? <span className="text-xs text-muted">Administrator only</span> : null}
                      </div>
                      <div className="mt-1 text-xs text-muted">{(user.places ?? []).join(" · ") || (isAdmin ? "" : "In no tree or list")}</div>
                    </td>
                    <td className="px-3 py-3">
                      <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium">
                        <input type="checkbox" role="switch" className="peer sr-only" checked={isAdmin} disabled={rowWorking} onChange={() => void toggleAdmin(user)} />
                        <span aria-hidden className="relative h-5 w-9 rounded-full bg-[var(--line)] transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:bg-[var(--brand)] peer-checked:after:translate-x-4 peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--brand)] peer-disabled:opacity-50" />
                        {isAdmin ? <span className="inline-flex items-center gap-1 text-[var(--brand)]"><ShieldCheck size={13} /> Admin</span> : <span className="text-muted">No</span>}
                      </label>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="inline-flex flex-wrap justify-end gap-1.5">
                        <button type="button" onClick={() => setResetUser(user)} disabled={rowWorking} className={smallButton}>Reset password</button>
                        <button type="button" onClick={() => void setActive(user, !user.is_active)} disabled={rowWorking} className={`rounded border px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50 ${user.is_active ? "border-[color:color-mix(in_oklab,var(--bad)_45%,var(--line))] text-[var(--bad)]" : "border-[color:color-mix(in_oklab,var(--good)_45%,var(--line))] text-[var(--good)]"}`}>
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

      {resetUser ? <PasswordResetDialog userName={resetUser.full_name} busy={rowBusy === resetUser.id} onClose={() => setResetUser(null)} onConfirm={resetPassword} /> : null}
    </AppShell>
  );
}

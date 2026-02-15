import { useEffect, useMemo, useState } from "react";
import AppShell from "../ui/AppShell";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";

type AdminUser = {
  id: number;
  email: string;
  full_name: string;
  is_active: boolean;
  roles: string[];
};

export default function AdminUsersPage() {
  const { me } = useAuth();

  const isAdmin = !!me?.roles?.includes("ADMIN");

  const [items, setItems] = useState<AdminUser[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Create user form
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [newRoles, setNewRoles] = useState<string[]>([]);

  async function load() {
    setErr(null);
    setBusy(true);
    try {
      const r = await api<{ items: string[] }>("/admin/roles");
      setRoles(r.items);

      const u = await api<{ items: AdminUser[] }>(`/admin/users${q ? `?q=${encodeURIComponent(q)}` : ""}`);
      setItems(u.items);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canShow = useMemo(() => isAdmin, [isAdmin]);

  async function createUser() {
    setErr(null);
    setBusy(true);
    try {
      await api("/admin/users", {
        method: "POST",
        body: JSON.stringify({
          email,
          full_name: fullName,
          password,
          roles: newRoles,
        }),
      });
      setEmail("");
      setFullName("");
      setPassword("");
      setNewRoles([]);
      await load();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to create user");
    } finally {
      setBusy(false);
    }
  }

  async function setUserActive(userId: number, isActive: boolean) {
    setErr(null);
    setBusy(true);
    try {
      await api(`/admin/users/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ is_active: isActive }),
      });
      await load();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to update user");
    } finally {
      setBusy(false);
    }
  }

  async function replaceUserRoles(userId: number, nextRoles: string[]) {
    setErr(null);
    setBusy(true);
    try {
      await api(`/admin/users/${userId}/roles`, {
        method: "PUT",
        body: JSON.stringify({ roles: nextRoles }),
      });
      await load();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to update roles");
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(userId: number) {
    const next = prompt("Enter a new temporary password (min 8 chars):");
    if (!next || next.length < 8) return;

    setErr(null);
    setBusy(true);
    try {
      await api(`/admin/users/${userId}/reset-password`, {
        method: "POST",
        body: JSON.stringify({ password: next }),
      });
      await load();
      alert("Password updated.");
    } catch (e: any) {
      setErr(e?.message ?? "Failed to reset password");
    } finally {
      setBusy(false);
    }
  }

  function toggleRole(current: string[], role: string) {
    return current.includes(role) ? current.filter((r) => r !== role) : [...current, role];
  }

  return (
    <AppShell title="User Administration">
      <div className="p-4">
        {!canShow ? (
          <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
            This section is restricted to ADMIN users.
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <div className="text-lg font-semibold text-slate-900">Users & roles</div>
                <div className="mt-1 text-sm text-slate-600">
                  Provision local accounts for development and internal operations. (SSO can be added later.)
                </div>
              </div>

              <div className="flex gap-2 items-center">
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search email or name…"
                  className="w-64 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-400"
                />
                <button
                  onClick={load}
                  className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-60"
                  disabled={busy}
                >
                  Search / Refresh
                </button>
              </div>
            </div>

            {err && (
              <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                {err}
              </div>
            )}

            {/* Create user */}
            <div className="mt-6 rounded-md border border-slate-200 p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                Create user
              </div>

              <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <div className="text-xs text-slate-600">Email</div>
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-400"
                    placeholder="reviewer@local"
                  />
                </div>
                <div>
                  <div className="text-xs text-slate-600">Full name</div>
                  <input
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-400"
                    placeholder="Local Reviewer"
                  />
                </div>
                <div>
                  <div className="text-xs text-slate-600">Temporary password</div>
                  <input
                    value={password}
                    type="password"
                    onChange={(e) => setPassword(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-400"
                    placeholder="min 8 chars"
                  />
                </div>
              </div>

              <div className="mt-3">
                <div className="text-xs text-slate-600 mb-2">Roles</div>
                <div className="flex flex-wrap gap-2">
                  {roles.map((r) => (
                    <label key={r} className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2 py-1 text-sm">
                      <input
                        type="checkbox"
                        checked={newRoles.includes(r)}
                        onChange={() => setNewRoles(toggleRole(newRoles, r))}
                      />
                      <span>{r}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="mt-4">
                <button
                  onClick={createUser}
                  disabled={busy || !email || !fullName || password.length < 8}
                  className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800 disabled:opacity-60"
                >
                  Create user
                </button>
              </div>
            </div>

            {/* Users table */}
            <div className="mt-6 rounded-md border border-slate-200 overflow-hidden">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs font-semibold uppercase tracking-wide text-slate-600">
                    <th className="py-3 px-3">ID</th>
                    <th className="py-3 px-3">User</th>
                    <th className="py-3 px-3">Status</th>
                    <th className="py-3 px-3">Roles</th>
                    <th className="py-3 px-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((u) => (
                    <tr key={u.id} className="border-b border-slate-100 hover:bg-slate-50 align-top">
                      <td className="py-3 px-3 text-sm font-medium">{u.id}</td>
                      <td className="py-3 px-3">
                        <div className="text-sm font-medium">{u.full_name}</div>
                        <div className="text-xs text-slate-600">{u.email}</div>
                      </td>
                      <td className="py-3 px-3 text-sm">
                        {u.is_active ? (
                          <span className="inline-flex rounded border border-green-200 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-800">
                            Active
                          </span>
                        ) : (
                          <span className="inline-flex rounded border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-800">
                            Disabled
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-3">
                        <div className="flex flex-wrap gap-2">
                          {roles.map((r) => (
                            <label key={r} className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs">
                              <input
                                type="checkbox"
                                checked={u.roles.includes(r)}
                                onChange={() => replaceUserRoles(u.id, toggleRole(u.roles, r))}
                                disabled={busy}
                              />
                              <span>{r}</span>
                            </label>
                          ))}
                        </div>
                      </td>
                      <td className="py-3 px-3 text-sm">
                        <div className="flex flex-col gap-2 items-end">
                          <button
                            onClick={() => setUserActive(u.id, !u.is_active)}
                            disabled={busy}
                            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-60"
                          >
                            {u.is_active ? "Disable" : "Enable"}
                          </button>
                          <button
                            onClick={() => resetPassword(u.id)}
                            disabled={busy}
                            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-60"
                          >
                            Reset password
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}

                  {items.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-6 px-3 text-sm text-slate-600">
                        No users found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}

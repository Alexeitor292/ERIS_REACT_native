import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Submission } from "../api/types";
import AppShell from "../ui/AppShell";
import { buildSubmissionDisplayTitle } from "../utils/submissionLabel";
import { useAuth } from "../auth/AuthContext";

type Status = Submission["status"];

function StatusChip({ status }: { status: Status }) {
  const cls =
    status === "APPROVED"
      ? "bg-[color:color-mix(in_oklab,var(--good)_16%,transparent)] text-[var(--good)] border-[color:color-mix(in_oklab,var(--good)_48%,transparent)]"
      : status === "REJECTED"
      ? "bg-[color:color-mix(in_oklab,var(--bad)_16%,transparent)] text-[var(--bad)] border-[color:color-mix(in_oklab,var(--bad)_48%,transparent)]"
      : status === "UNDER_REVIEW"
      ? "bg-[color:color-mix(in_oklab,var(--brand)_14%,transparent)] text-[var(--brand)] border-[color:color-mix(in_oklab,var(--brand)_45%,transparent)]"
      : status === "SUBMITTED"
      ? "bg-[color:color-mix(in_oklab,var(--brand)_16%,transparent)] text-[var(--brand)] border-[color:color-mix(in_oklab,var(--brand)_48%,transparent)]"
      : "bg-[var(--panel-soft)] text-[var(--ink)] border-[var(--line)]";

  return (
    <span className={`inline-flex min-w-20 items-center justify-center rounded border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {status}
    </span>
  );
}

export default function SubmissionsPage() {
  const { me } = useAuth();
  const [items, setItems] = useState<Submission[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("ALL");
  const [loading, setLoading] = useState(false);
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null);

  async function load() {
    setErr(null);
    setLoading(true);
    try {
      const data = await api<{ items: Submission[] }>("/submissions?limit=50");
      setItems(data.items);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function canDeleteSubmission(s: Submission): boolean {
    const roles = new Set(me?.roles ?? []);
    const isAdmin = roles.has("ADMIN");
    const isOwner = me?.id === s.created_by_user_id;
    if (s.status === "DRAFT") return isAdmin || !!isOwner;
    return isAdmin;
  }

  async function onDeleteSubmission(s: Submission) {
    const ok = window.confirm(
      s.status === "DRAFT"
        ? "Delete this draft?"
        : "Delete this submitted/reviewed record? This cannot be undone."
    );
    if (!ok) return;
    setErr(null);
    try {
      await api(`/submissions/${s.id}`, { method: "DELETE" });
      setMenuOpenId(null);
      await load();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to delete");
    }
  }

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return items.filter((s) => {
      const matchesQuery =
        !query ||
        String(s.id).includes(query) ||
        String(s.created_by_user_id).includes(query) ||
        (s.status ?? "").toLowerCase().includes(query) ||
        (s.district ?? "").toLowerCase().includes(query) ||
        (s.county ?? "").toLowerCase().includes(query) ||
        (s.route ?? "").toLowerCase().includes(query) ||
        (s.post_mile ?? "").toLowerCase().includes(query);

      const matchesStatus = status === "ALL" || s.status === status;
      return matchesQuery && matchesStatus;
    });
  }, [items, q, status]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of items) map.set(s.status, (map.get(s.status) ?? 0) + 1);
    return map;
  }, [items]);

  const summaryCards = useMemo(() => {
    const total = items.length;
    const submitted = counts.get("SUBMITTED") ?? 0;
    const approved = counts.get("APPROVED") ?? 0;
    const rejected = counts.get("REJECTED") ?? 0;
    const draft = counts.get("DRAFT") ?? 0;
    return [
      { label: "Total", value: total, hint: "All visible cases" },
      { label: "Submitted", value: submitted, hint: "Awaiting review" },
      { label: "Approved", value: approved, hint: "Closed approved cases" },
      { label: "Rejected", value: rejected, hint: "Returned/rejected" },
      { label: "Draft", value: draft, hint: "Not yet submitted" },
    ];
  }, [counts, items.length]);

  return (
    <AppShell title="Submissions">
      <div className="p-4 md:p-5">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {summaryCards.map((c) => (
            <div key={c.label} className="rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">{c.label}</div>
              <div className="mt-2 text-2xl font-semibold">{c.value}</div>
              <div className="mt-1 text-xs text-muted">{c.hint}</div>
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <div className="w-full md:w-80">
              <label className="block text-xs font-semibold uppercase tracking-wide text-muted">Search</label>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="ID, status, created-by..."
                className="mt-1 w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]"
              />
            </div>

            <div className="w-full md:w-64">
              <label className="block text-xs font-semibold uppercase tracking-wide text-muted">Status</label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="mt-1 w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]"
              >
                <option value="ALL">All ({items.length})</option>
                {Array.from(counts.entries()).map(([k, v]) => (
                  <option key={k} value={k}>
                    {k} ({v})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={load}
              className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm hover:brightness-95"
            >
              Refresh
            </button>
          </div>
        </div>

        {err && (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {err}
          </div>
        )}

        <div className="mt-4 overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--panel)]">
          <table className="w-full table-fixed border-collapse">
            <colgroup>
              <col className="w-16" />
              <col className="w-56" />
              <col className="w-36" />
              <col className="w-28" />
              <col className="w-56" />
              <col className="w-56" />
              <col className="w-28" />
            </colgroup>
            <thead>
              <tr className="border-b border-[var(--line)] text-left text-xs font-semibold uppercase tracking-wide text-muted">
                <th className="px-4 py-3">ID</th>
                <th className="px-4 py-3">Descriptor</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Created By</th>
                <th className="px-4 py-3">Created At</th>
                <th className="px-4 py-3">Submitted At</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td className="px-4 py-4 text-sm text-muted" colSpan={7}>
                    Loading submissions...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-sm text-muted" colSpan={7}>
                    <div className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] p-4">
                      <div className="font-medium">No submissions available</div>
                      <div className="mt-1">
                        Field submissions will appear here once submitted from the mobile app.
                      </div>
                      <div className="mt-3 text-xs text-muted">
                        Dev tip: use the seed endpoint to create test submissions for UI verification.
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                filtered.map((s) => (
                  <tr key={s.id} className="border-b border-[var(--line)]/60 hover:bg-[var(--panel-soft)]">
                    <td className="px-4 py-3 text-sm font-medium">{s.id}</td>
                    <td className="px-4 py-3 text-sm">
                      {buildSubmissionDisplayTitle({
                        id: s.id,
                        created_at: s.created_at,
                        district: s.district,
                        county: s.county,
                        route: s.route,
                        post_mile: s.post_mile,
                      })}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <StatusChip status={s.status} />
                    </td>
                    <td className="px-4 py-3 text-sm text-muted">{s.created_by_user_id}</td>
                    <td className="px-4 py-3 text-sm text-muted tabular-nums">{s.created_at}</td>
                    <td className="px-4 py-3 text-sm text-muted tabular-nums">{s.submitted_at ?? "-"}</td>
                    <td className="px-4 py-3 text-right text-sm">
                      <div className="relative inline-flex items-center gap-2">
                        <Link
                          className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1 text-xs hover:brightness-95"
                          to={`/submissions/${s.id}`}
                        >
                          Open
                        </Link>
                        <button
                          onClick={() => setMenuOpenId((prev) => (prev === s.id ? null : s.id))}
                          className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1 text-xs hover:brightness-95"
                          aria-label="Submission options"
                          title="Submission options"
                        >
                          ⋮
                        </button>
                        {menuOpenId === s.id ? (
                          <div className="absolute right-0 top-8 z-10 min-w-32 rounded-md border border-[var(--line)] bg-[var(--panel)] p-1 shadow-lg">
                            <Link
                              to={`/submissions/${s.id}`}
                              className="block rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--panel-soft)]"
                              onClick={() => setMenuOpenId(null)}
                            >
                              Open details
                            </Link>
                            {canDeleteSubmission(s) ? (
                              <button
                                onClick={() => onDeleteSubmission(s)}
                                className="block w-full rounded px-2 py-1.5 text-left text-xs text-red-600 hover:bg-[color:color-mix(in_oklab,var(--bad)_12%,transparent)]"
                              >
                                Delete
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-3 text-xs text-muted">
          Showing {filtered.length} of {items.length} submissions.
        </div>
      </div>
    </AppShell>
  );
}

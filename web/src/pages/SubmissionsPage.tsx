import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Submission } from "../api/types";
import { SubmissionStatusBadge } from "../features/submissions/SubmissionDetailPrimitives";
import AppShell from "../ui/AppShell";
import { buildSubmissionDisplayTitle } from "../utils/submissionLabel";
import { useAuth } from "../auth/AuthContext";

const PAGE_SIZE = 50;
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function formatTimestamp(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : dateTimeFormatter.format(parsed);
}

export default function SubmissionsPage() {
  const { me } = useAuth();
  const [items, setItems] = useState<Submission[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("ALL");
  const [loading, setLoading] = useState(false);
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null);
  const [resultLimit, setResultLimit] = useState(PAGE_SIZE);
  const [mayHaveMore, setMayHaveMore] = useState(false);

  async function load(limit = resultLimit) {
    setErr(null);
    setLoading(true);
    try {
      const data = await api<{ items: Submission[] }>(`/submissions?limit=${limit}`);
      setItems(data.items);
      setResultLimit(limit);
      setMayHaveMore(data.items.length >= limit);
      setMenuOpenId(null);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load submissions");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(PAGE_SIZE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function canDeleteSubmission(submission: Submission): boolean {
    const roles = new Set(me?.roles ?? []);
    const isAdmin = roles.has("ADMIN");
    const isOwner = me?.id === submission.created_by_user_id;
    if (submission.status === "DRAFT") return isAdmin || !!isOwner;
    return isAdmin;
  }

  async function onDeleteSubmission(submission: Submission) {
    const ok = window.confirm(
      submission.status === "DRAFT"
        ? "Delete this draft?"
        : "Delete this submitted or reviewed record? This cannot be undone."
    );
    if (!ok) return;

    setErr(null);
    try {
      await api(`/submissions/${submission.id}`, { method: "DELETE" });
      setMenuOpenId(null);
      await load(resultLimit);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to delete submission");
    }
  }

  async function loadOlder() {
    await load(resultLimit + PAGE_SIZE);
  }

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return items.filter((submission) => {
      const matchesQuery =
        !query ||
        String(submission.id).includes(query) ||
        String(submission.created_by_user_id).includes(query) ||
        (submission.status ?? "").toLowerCase().includes(query) ||
        (submission.district ?? "").toLowerCase().includes(query) ||
        (submission.county ?? "").toLowerCase().includes(query) ||
        (submission.route ?? "").toLowerCase().includes(query) ||
        (submission.post_mile ?? "").toLowerCase().includes(query);

      const matchesStatus = status === "ALL" || submission.status === status;
      return matchesQuery && matchesStatus;
    });
  }, [items, q, status]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const submission of items) {
      map.set(submission.status, (map.get(submission.status) ?? 0) + 1);
    }
    return map;
  }, [items]);

  const summaryCards = useMemo(() => [
    { key: "ALL", label: "Loaded", value: items.length, hint: "Current worklist" },
    { key: "SUBMITTED", label: "Submitted", value: counts.get("SUBMITTED") ?? 0, hint: "Awaiting review" },
    { key: "APPROVED", label: "Approved", value: counts.get("APPROVED") ?? 0, hint: "Review complete" },
    { key: "REJECTED", label: "Returned", value: counts.get("REJECTED") ?? 0, hint: "Needs correction" },
    { key: "DRAFT", label: "Draft", value: counts.get("DRAFT") ?? 0, hint: "Not submitted" },
  ], [counts, items.length]);

  const hasFilters = q.trim().length > 0 || status !== "ALL";

  return (
    <AppShell title="Submissions">
      <div className="flex h-full flex-col p-4 md:p-5">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {summaryCards.map((card) => {
            const active = status === card.key;
            return (
              <button
                key={card.key}
                type="button"
                onClick={() => setStatus(card.key)}
                aria-pressed={active}
                className={`rounded-xl border p-3 text-left transition-[border-color,background-color,box-shadow] ${
                  active
                    ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_8%,var(--panel))] shadow-[0_0_0_1px_color-mix(in_oklab,var(--brand)_25%,transparent)]"
                    : "border-[var(--line)] bg-[var(--panel-soft)] hover:border-[color:color-mix(in_oklab,var(--brand)_42%,var(--line))]"
                }`}
              >
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">{card.label}</div>
                <div className="mt-2 text-2xl font-semibold">{card.value}</div>
                <div className="mt-1 text-xs text-muted">{card.hint}</div>
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex flex-1 flex-col gap-2 md:flex-row md:items-center">
            <div className="w-full md:max-w-xl">
              <label className="block text-xs font-semibold uppercase tracking-wide text-muted">Search worklist</label>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="ID, district, county, route, post mile, status, or creator ID"
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
                <option value="ALL">All loaded ({items.length})</option>
                {Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => (
                  <option key={key} value={key}>
                    {key} ({value})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex gap-2">
            {hasFilters ? (
              <button
                type="button"
                onClick={() => {
                  setQ("");
                  setStatus("ALL");
                }}
                className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)]"
              >
                Clear filters
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => load(resultLimit)}
              disabled={loading}
              className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading && items.length > 0 ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        {err ? (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {err}
          </div>
        ) : null}

        <div className="mt-4 flex-1 overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--panel)]">
          <table className="w-full table-fixed border-collapse">
            <colgroup>
              <col className="w-20" />
              <col className="w-80" />
              <col className="w-36" />
              <col className="w-36" />
              <col className="w-48" />
              <col className="w-48" />
              <col className="w-32" />
            </colgroup>
            <thead>
              <tr className="border-b border-[var(--line)] bg-[var(--panel-soft)] text-left text-xs font-semibold uppercase tracking-wide text-muted">
                <th className="px-4 py-3">ID</th>
                <th className="px-4 py-3">Submission</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Reporter</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3">Submitted</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && items.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-sm text-muted" colSpan={7}>
                    Loading submissions…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-sm" colSpan={7}>
                    <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-5">
                      <div className="font-semibold">
                        {items.length === 0 ? "No submissions available" : "No submissions match these filters"}
                      </div>
                      <div className="mt-1 max-w-2xl text-muted">
                        {items.length === 0
                          ? "Field records will appear here when they are created and become visible to your ERIS account."
                          : "Adjust the search or status filter to return to the active worklist."}
                      </div>
                      {items.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => {
                            setQ("");
                            setStatus("ALL");
                          }}
                          className="mt-3 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-1.5 text-sm font-medium"
                        >
                          Clear filters
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ) : (
                filtered.map((submission) => {
                  const deletable = canDeleteSubmission(submission);
                  const descriptor = buildSubmissionDisplayTitle({
                    id: submission.id,
                    created_at: submission.created_at,
                    district: submission.district,
                    county: submission.county,
                    route: submission.route,
                    post_mile: submission.post_mile,
                  });

                  return (
                    <tr key={submission.id} className="border-b border-[var(--line)]/60 last:border-b-0 hover:bg-[var(--panel-soft)]">
                      <td className="px-4 py-3 text-sm font-semibold tabular-nums">#{submission.id}</td>
                      <td className="px-4 py-3 text-sm">
                        <Link
                          to={`/submissions/${submission.id}`}
                          className="font-medium text-[var(--ink)] hover:text-[var(--brand)] hover:underline"
                        >
                          {descriptor}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <SubmissionStatusBadge status={submission.status} />
                      </td>
                      <td className="px-4 py-3 text-sm text-muted" title={`Creator user ID ${submission.created_by_user_id}`}>
                        {me?.id === submission.created_by_user_id ? "You" : `User #${submission.created_by_user_id}`}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted" title={submission.created_at}>
                        {formatTimestamp(submission.created_at)}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted" title={submission.submitted_at ?? undefined}>
                        {formatTimestamp(submission.submitted_at)}
                      </td>
                      <td className="px-4 py-3 text-right text-sm">
                        <div className="relative inline-flex items-center gap-2">
                          <Link
                            className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-1.5 text-sm font-semibold hover:bg-[var(--panel-soft)]"
                            to={`/submissions/${submission.id}`}
                          >
                            Open
                          </Link>
                          {deletable ? (
                            <>
                              <button
                                type="button"
                                onClick={() => setMenuOpenId((previous) => previous === submission.id ? null : submission.id)}
                                className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 text-sm font-semibold leading-none hover:bg-[var(--panel-soft)]"
                                aria-label={`More actions for submission ${submission.id}`}
                                aria-expanded={menuOpenId === submission.id}
                                title="More actions"
                              >
                                •••
                              </button>
                              {menuOpenId === submission.id ? (
                                <div className="absolute right-0 top-full z-50 mt-2 min-w-40 rounded-md border border-[var(--line)] bg-[var(--panel)] p-1 shadow-lg">
                                  <button
                                    type="button"
                                    onClick={() => onDeleteSubmission(submission)}
                                    className="block w-full rounded px-2.5 py-2 text-left text-sm font-medium text-[var(--bad)] hover:bg-[color:color-mix(in_oklab,var(--bad)_12%,transparent)]"
                                  >
                                    Delete submission
                                  </button>
                                </div>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex flex-col gap-2 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
          <div>
            Showing {filtered.length} matching {filtered.length === 1 ? "submission" : "submissions"} from {items.length} loaded.
          </div>
          {mayHaveMore ? (
            <button
              type="button"
              onClick={loadOlder}
              disabled={loading}
              className="self-start rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-1.5 text-sm font-medium text-[var(--ink)] hover:bg-[var(--panel-soft)] disabled:cursor-not-allowed disabled:opacity-50 sm:self-auto"
            >
              {loading ? "Loading…" : "Load older submissions"}
            </button>
          ) : (
            <span>All currently accessible submissions are loaded.</span>
          )}
        </div>
      </div>
    </AppShell>
  );
}

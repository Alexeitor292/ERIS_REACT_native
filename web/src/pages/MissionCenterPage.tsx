import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../api/client";
import type { Incident, IncidentStatus } from "../api/types";
import AppShell from "../ui/AppShell";
import MissionCenterMap from "../components/MissionCenterMap";
import { formatCoordinate } from "../utils/precision";

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

function statusLabel(status: IncidentStatus) {
  if (status === "IN_PROGRESS") return "In progress";
  if (status === "RESOLVED") return "Resolved";
  return "New";
}

function statusBadgeClass(status: IncidentStatus) {
  if (status === "NEW") {
    return "border-[color:color-mix(in_oklab,var(--bad)_48%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_14%,transparent)] text-[var(--bad)]";
  }
  if (status === "IN_PROGRESS") {
    return "border-[color:color-mix(in_oklab,var(--brand)_48%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_12%,transparent)] text-[var(--brand)]";
  }
  return "border-[color:color-mix(in_oklab,var(--good)_48%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_12%,transparent)] text-[var(--good)]";
}

function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  return (
    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${statusBadgeClass(status)}`}>
      {statusLabel(status)}
    </span>
  );
}

export default function MissionCenterPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<Incident[]>([]);
  const [selectedIncidentId, setSelectedIncidentId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<"ALL" | IncidentStatus>("ALL");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ items: Incident[] }>("/mission-center/incidents");
      const nextItems = res.items ?? [];
      setItems(nextItems);
      setLastUpdatedAt(new Date());
      setSelectedIncidentId((current) => {
        if (current != null && nextItems.some((item) => item.id === current)) return current;
        return nextItems[0]?.id ?? null;
      });
    } catch (e: any) {
      setError(e?.message ?? "Failed to load mission center feed.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const timer = setInterval(() => {
      load().catch(() => {});
    }, 30000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const counts = useMemo(() => {
    const result = { ALL: items.length, NEW: 0, IN_PROGRESS: 0, RESOLVED: 0 };
    for (const incident of items) {
      result[incident.status] += 1;
    }
    return result;
  }, [items]);

  const filteredItems = useMemo(
    () => statusFilter === "ALL" ? items : items.filter((incident) => incident.status === statusFilter),
    [items, statusFilter]
  );

  const selected = useMemo(
    () => items.find((incident) => incident.id === selectedIncidentId) ?? null,
    [items, selectedIncidentId]
  );

  useEffect(() => {
    if (filteredItems.length === 0) {
      setSelectedIncidentId(null);
      return;
    }
    if (!filteredItems.some((incident) => incident.id === selectedIncidentId)) {
      setSelectedIncidentId(filteredItems[0].id);
    }
  }, [filteredItems, selectedIncidentId]);

  const summaryCards: Array<{
    key: "ALL" | IncidentStatus;
    label: string;
    value: number;
    hint: string;
  }> = [
    { key: "ALL", label: "Visible", value: counts.ALL, hint: "All incidents" },
    { key: "NEW", label: "New", value: counts.NEW, hint: "Needs triage" },
    { key: "IN_PROGRESS", label: "In Progress", value: counts.IN_PROGRESS, hint: "Active response" },
    { key: "RESOLVED", label: "Resolved", value: counts.RESOLVED, hint: "Response complete" },
  ];

  return (
    <AppShell title="Mission Center">
      <div className="flex h-full flex-col gap-4 p-4 md:p-5">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {summaryCards.map((card) => {
            const active = statusFilter === card.key;
            return (
              <button
                key={card.key}
                type="button"
                onClick={() => setStatusFilter(card.key)}
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

        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <div className="rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-3">
            <MissionCenterMap
              incidents={filteredItems}
              selectedIncidentId={selectedIncidentId}
              onSelectIncident={setSelectedIncidentId}
              height={540}
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
              <div className="flex flex-wrap items-center gap-2">
                <IncidentStatusBadge status="NEW" />
                <IncidentStatusBadge status="IN_PROGRESS" />
                <IncidentStatusBadge status="RESOLVED" />
              </div>
              <div className="flex items-center gap-2">
                <span>{lastUpdatedAt ? `Updated ${dateTimeFormatter.format(lastUpdatedAt)}` : "Not refreshed yet"}</span>
                <button
                  type="button"
                  onClick={load}
                  disabled={loading}
                  className="rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-xs font-medium hover:bg-[var(--panel-soft)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loading ? "Refreshing…" : "Refresh"}
                </button>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">Selected Incident</div>
            {selected ? (
              <div className="mt-3 space-y-4 text-sm">
                <div>
                  <div className="text-xs text-muted">Incident #{selected.id}</div>
                  <div className="mt-1 text-lg font-semibold leading-snug">{selected.title}</div>
                  <div className="mt-2"><IncidentStatusBadge status={selected.status} /></div>
                </div>

                <dl className="space-y-2 border-t border-[var(--line)] pt-3">
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Location</dt>
                    <dd className="mt-0.5 font-medium tabular-nums">
                      {formatCoordinate(selected.latitude)}, {formatCoordinate(selected.longitude)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Assignee</dt>
                    <dd className="mt-0.5 font-medium">
                      {selected.assignment?.assignee_name || selected.assignment?.assignee_email || "Unassigned"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Last Updated</dt>
                    <dd className="mt-0.5 font-medium" title={selected.updated_at}>{formatTimestamp(selected.updated_at)}</dd>
                  </div>
                </dl>

                {selected.linked_submission_id ? (
                  <button
                    type="button"
                    onClick={() => navigate(`/submissions/${selected.linked_submission_id}`)}
                    className="w-full rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-semibold text-white hover:brightness-95"
                  >
                    Open linked submission #{selected.linked_submission_id}
                  </button>
                ) : (
                  <div className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-xs text-muted">
                    No submission is linked to this incident yet.
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-3 rounded-md border border-[var(--line)] bg-[var(--panel-soft)] p-4 text-sm text-muted">
                {loading ? "Loading incidents…" : filteredItems.length === 0 ? "No incidents match this status." : "Select an incident on the map or in the worklist."}
              </div>
            )}
          </div>
        </div>

        {error ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>
        ) : null}

        <div className="flex-1 overflow-auto rounded-xl border border-[var(--line)] bg-[var(--panel)]">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-[var(--line)] bg-[var(--panel-soft)] text-left text-xs font-semibold uppercase tracking-wide text-muted">
                <th className="px-3 py-3">ID</th>
                <th className="px-3 py-3">Incident</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Assignee</th>
                <th className="px-3 py-3">Coordinates</th>
                <th className="px-3 py-3">Submission</th>
                <th className="px-3 py-3">Updated</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.length === 0 ? (
                <tr>
                  <td className="px-3 py-8 text-sm text-muted" colSpan={7}>
                    {loading ? "Loading incidents…" : "No incidents match the selected status."}
                  </td>
                </tr>
              ) : (
                filteredItems.map((incident) => (
                  <tr
                    key={incident.id}
                    onClick={() => setSelectedIncidentId(incident.id)}
                    className={`cursor-pointer border-b border-[var(--line)]/60 last:border-b-0 hover:bg-[var(--panel-soft)] ${
                      selectedIncidentId === incident.id ? "bg-[var(--panel-soft)]" : ""
                    }`}
                  >
                    <td className="px-3 py-3 text-sm font-semibold tabular-nums">#{incident.id}</td>
                    <td className="px-3 py-3 text-sm font-medium">{incident.title}</td>
                    <td className="px-3 py-3 text-sm"><IncidentStatusBadge status={incident.status} /></td>
                    <td className="px-3 py-3 text-sm text-muted">
                      {incident.assignment?.assignee_name || incident.assignment?.assignee_email || "Unassigned"}
                    </td>
                    <td className="px-3 py-3 text-sm text-muted tabular-nums">
                      {formatCoordinate(incident.latitude)}, {formatCoordinate(incident.longitude)}
                    </td>
                    <td className="px-3 py-3 text-sm">
                      {incident.linked_submission_id ? (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            navigate(`/submissions/${incident.linked_submission_id}`);
                          }}
                          className="font-semibold text-[var(--brand)] hover:underline"
                        >
                          #{incident.linked_submission_id}
                        </button>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-sm text-muted" title={incident.updated_at}>
                      {formatTimestamp(incident.updated_at)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}

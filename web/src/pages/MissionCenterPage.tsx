import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../api/client";
import type { Incident, IncidentStatus } from "../api/types";
import AppShell from "../ui/AppShell";
import MissionCenterMap from "../components/MissionCenterMap";
import { formatCoordinate } from "../utils/precision";

function statusBadgeClass(status: IncidentStatus) {
  if (status === "NEW") return "border-red-500/40 bg-red-500/15 text-red-300";
  if (status === "IN_PROGRESS") return "border-amber-500/50 bg-amber-500/15 text-amber-300";
  return "border-emerald-500/40 bg-emerald-500/15 text-emerald-300";
}

export default function MissionCenterPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<Incident[]>([]);
  const [selectedIncidentId, setSelectedIncidentId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ items: Incident[] }>("/mission-center/incidents");
      setItems(res.items ?? []);
      if ((res.items ?? []).length > 0 && selectedIncidentId == null) {
        setSelectedIncidentId(res.items[0].id);
      }
    } catch (e: any) {
      setError(e?.message ?? "Failed to load mission center feed.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(() => {
      load().catch(() => {});
    }, 30000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = useMemo(
    () => items.find((it) => it.id === selectedIncidentId) ?? null,
    [items, selectedIncidentId]
  );

  return (
    <AppShell title="Mission Center">
      <div className="flex h-full flex-col gap-4 p-4 md:p-5">
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <div className="rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-3">
            <MissionCenterMap
              incidents={items}
              selectedIncidentId={selectedIncidentId}
              onSelectIncident={setSelectedIncidentId}
              height={540}
            />
            <div className="mt-2 flex items-center justify-between text-xs text-muted">
              <div>Red = NEW, Yellow = IN_PROGRESS, Green = RESOLVED</div>
              <button
                onClick={load}
                className="rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-xs hover:brightness-95"
              >
                Refresh
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">Selected Incident</div>
            {selected ? (
              <div className="mt-2 space-y-2 text-sm">
                <div className="text-base font-semibold">{selected.title}</div>
                <div>
                  <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${statusBadgeClass(selected.status)}`}>
                    {selected.status}
                  </span>
                </div>
                <div className="text-muted">
                  {formatCoordinate(selected.latitude)}, {formatCoordinate(selected.longitude)}
                </div>
                <div className="text-muted">
                  Assignee: {selected.assignment?.assignee_name || selected.assignment?.assignee_email || "Unassigned"}
                </div>
                <div className="text-muted">Updated: {selected.updated_at}</div>
                {selected.linked_submission_id ? (
                  <button
                    onClick={() => navigate(`/submissions/${selected.linked_submission_id}`)}
                    className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm hover:brightness-95"
                  >
                    Open Linked Draft #{selected.linked_submission_id}
                  </button>
                ) : (
                  <div className="text-xs text-muted">No linked draft yet.</div>
                )}
              </div>
            ) : (
              <div className="mt-2 text-sm text-muted">{loading ? "Loading..." : "Select a pin or row."}</div>
            )}
          </div>
        </div>

        {error ? (
          <div className="rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</div>
        ) : null}

        <div className="flex-1 overflow-auto rounded-xl border border-[var(--line)] bg-[var(--panel)]">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-[var(--line)] text-left text-xs font-semibold uppercase tracking-wide text-muted">
                <th className="px-3 py-2">ID</th>
                <th className="px-3 py-2">Incident</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Assignee</th>
                <th className="px-3 py-2">Coordinates</th>
                <th className="px-3 py-2">Linked Draft</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td className="px-3 py-6 text-sm text-muted" colSpan={6}>
                    {loading ? "Loading incidents..." : "No incidents available."}
                  </td>
                </tr>
              ) : (
                items.map((incident) => (
                  <tr
                    key={incident.id}
                    onClick={() => setSelectedIncidentId(incident.id)}
                    className={`cursor-pointer border-b border-[var(--line)]/60 ${
                      selectedIncidentId === incident.id ? "bg-[var(--panel-soft)]" : ""
                    }`}
                  >
                    <td className="px-3 py-2 text-sm font-semibold">{incident.id}</td>
                    <td className="px-3 py-2 text-sm">{incident.title}</td>
                    <td className="px-3 py-2 text-sm">
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${statusBadgeClass(incident.status)}`}>
                        {incident.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-sm text-muted">
                      {incident.assignment?.assignee_name || incident.assignment?.assignee_email || "-"}
                    </td>
                    <td className="px-3 py-2 text-sm text-muted">
                      {formatCoordinate(incident.latitude)}, {formatCoordinate(incident.longitude)}
                    </td>
                    <td className="px-3 py-2 text-sm">
                      {incident.linked_submission_id ? `#${incident.linked_submission_id}` : "-"}
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

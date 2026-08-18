import { useEffect, useMemo, useState } from "react";

import { api } from "../../api/client";
import ModalDialog from "../../ui/ModalDialog";
import type { EventGroupIncidentSummary, EventGroupSummary } from "./eventGroupTypes";
import { eventGroupLocationLabel } from "./eventGroupTypes";

const MILES_TO_METERS = 1609.344;

function distanceLabel(meters: number): string {
  const miles = meters / MILES_TO_METERS;
  if (miles < 0.1) return `${Math.round(meters * 3.28084)} ft away`;
  return `${miles.toFixed(miles < 10 ? 1 : 0)} mi away`;
}

type NearbyEventGroup = EventGroupSummary & { nearest_distance_m: number };

type ContextResponse = {
  incident: EventGroupIncidentSummary;
  event_group: EventGroupSummary | null;
  requires_event_group_decision: boolean;
  is_permanent: boolean;
  can_change_association: boolean;
};

type NearbyResponse = {
  incident: EventGroupIncidentSummary;
  radius_m: number;
  items: NearbyEventGroup[];
};

type AssociationResponse = {
  incident_id: number;
  event_group: EventGroupSummary;
  created: boolean;
  changed: boolean;
};

function generatedTitle(incident: EventGroupIncidentSummary | undefined): string {
  if (!incident) return "";
  const parts = [
    incident.route ? `Route ${incident.route}` : null,
    incident.post_mile ? `PM ${incident.post_mile}` : null,
    incident.county || null,
  ].filter(Boolean);
  return parts.length ? `${parts.join(" · ")} Event Group` : `Incident #${incident.id} Event Group`;
}

export default function EventGroupAssociationDialog({
  incidentId,
  onClose,
  onContinueToTriage,
}: {
  incidentId: number;
  onClose: () => void;
  onContinueToTriage: (incidentId: number) => void;
}) {
  const [context, setContext] = useState<ContextResponse | null>(null);
  const [groups, setGroups] = useState<NearbyEventGroup[]>([]);
  const [radiusMiles, setRadiusMiles] = useState(5);
  const [mode, setMode] = useState<"EXISTING" | "CREATE_NEW">("EXISTING");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(nextRadiusMiles = radiusMiles) {
    setBusy(true);
    setError(null);
    try {
      const [nextContext, nearby] = await Promise.all([
        api<ContextResponse>(`/incidents/${incidentId}/event-group-context`),
        api<NearbyResponse>(`/incidents/${incidentId}/nearby-event-groups?radius_m=${Math.round(nextRadiusMiles * MILES_TO_METERS)}&limit=50`),
      ]);
      setContext(nextContext);
      setGroups(nearby.items ?? []);
      if (nextContext.event_group) {
        setMode("EXISTING");
        setSelectedId(nextContext.event_group.id);
      } else if (nearby.items?.length) {
        setMode("EXISTING");
        setSelectedId((current) => current ?? nearby.items[0].id);
      } else {
        setMode("CREATE_NEW");
        setSelectedId(null);
      }
      setTitle((current) => current || generatedTitle(nextContext.incident));
    } catch (e: any) {
      setError(e?.message ?? "Failed to load Event Group context.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load(5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentId]);

  const selected = useMemo(
    () => groups.find((group) => group.id === selectedId) ?? (context?.event_group?.id === selectedId ? context.event_group : null),
    [context?.event_group, groups, selectedId],
  );

  async function associate() {
    if (!context?.can_change_association) return;
    if (mode === "EXISTING" && !selectedId) {
      setError("Select an existing Event Group first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api<AssociationResponse>(`/incidents/${incidentId}/event-group-association`, {
        method: "POST",
        body: JSON.stringify(mode === "EXISTING"
          ? { mode, event_group_id: selectedId, notes: notes.trim() || null }
          : {
              mode,
              title: title.trim() || null,
              description: description.trim() || null,
              notes: notes.trim() || null,
            }),
      });
      await load(radiusMiles);
    } catch (e: any) {
      setError(e?.message ?? "Failed to save Event Group association.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalDialog titleId="event-group-association-title" descriptionId="event-group-association-description" busy={busy} onClose={onClose} panelClassName="max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Coordinator review</div>
          <h2 id="event-group-association-title" className="mt-1 text-xl font-semibold">Event Group for Incident #{incidentId}</h2>
          <p id="event-group-association-description" className="mt-1 max-w-3xl text-sm text-muted">An Event Group is shared context, not a parent record. This Incident keeps its own identity and history regardless of which Event Group is selected.</p>
        </div>
        <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-[var(--line)] px-3 py-2 text-sm font-medium">Close</button>
      </div>

      {error ? <div className="mt-4 rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}

      {!context ? <div className="py-12 text-center text-sm text-muted">Loading Event Group context…</div> : (
        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(300px,0.8fr)]">
          <div>
            <div className="flex items-center justify-between gap-3">
              <div><div className="text-sm font-semibold">Nearby Event Groups</div><div className="text-xs text-muted">Open groups ranked by the closest associated Incident.</div></div>
              <select value={radiusMiles} onChange={(event) => { const next = Number(event.target.value); setRadiusMiles(next); void load(next); }} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2 py-1.5 text-xs">
                <option value={5}>5 miles</option><option value={10}>10 miles</option><option value={25}>25 miles</option><option value={50}>50 miles</option>
              </select>
            </div>
            <div className="mt-3 max-h-[420px] space-y-2 overflow-auto pr-1">
              {groups.length === 0 ? <div className="rounded-lg border border-dashed border-[var(--line)] p-5 text-sm text-muted">No open Event Groups found nearby. ERIS can create a new one for this Incident.</div> : groups.map((group) => (
                <button key={group.id} type="button" onClick={() => { setMode("EXISTING"); setSelectedId(group.id); }} className={`w-full rounded-lg border p-3 text-left ${mode === "EXISTING" && selectedId === group.id ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--panel))]" : "border-[var(--line)] bg-[var(--panel)] hover:bg-[var(--panel-soft)]"}`}>
                  <div className="flex items-start justify-between gap-3"><div><div className="text-sm font-semibold">{group.title}</div><div className="mt-1 text-xs text-muted">{eventGroupLocationLabel(group)}</div></div><div className="text-xs font-semibold text-[var(--brand)]">{distanceLabel(group.nearest_distance_m)}</div></div>
                  <div className="mt-2 text-xs text-muted">{group.incident_count} associated Incident{group.incident_count === 1 ? "" : "s"} · {group.open_incident_count} active</div>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-4">
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-[var(--panel)] p-1">
              <button type="button" onClick={() => setMode("EXISTING")} className={`rounded-md px-3 py-2 text-sm font-semibold ${mode === "EXISTING" ? "bg-[var(--panel-soft)]" : "text-muted"}`}>Existing group</button>
              <button type="button" onClick={() => setMode("CREATE_NEW")} className={`rounded-md px-3 py-2 text-sm font-semibold ${mode === "CREATE_NEW" ? "bg-[var(--panel-soft)]" : "text-muted"}`}>New group</button>
            </div>

            {mode === "EXISTING" ? (
              <div className="mt-4 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-3">
                {selected ? <><div className="text-sm font-semibold">{selected.title}</div><div className="mt-1 text-xs text-muted">{eventGroupLocationLabel(selected)}</div></> : <div className="text-sm text-muted">Select an Event Group from the list.</div>}
              </div>
            ) : (
              <div className="mt-4 grid gap-3">
                <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-muted">Event Group title<input value={title} onChange={(event) => setTitle(event.target.value)} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-normal normal-case text-[var(--ink)]" /></label>
                <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-muted">Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-normal normal-case text-[var(--ink)]" /></label>
              </div>
            )}

            <label className="mt-3 grid gap-1 text-xs font-semibold uppercase tracking-wide text-muted">Coordinator note<textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-normal normal-case text-[var(--ink)]" /></label>
            <button type="button" onClick={associate} disabled={busy || !context.can_change_association || (mode === "EXISTING" && !selectedId)} className="mt-4 w-full rounded-md bg-[var(--brand)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Saving…" : mode === "CREATE_NEW" ? "Create Event Group and associate" : "Use selected Event Group"}</button>
          </div>
        </div>
      )}

      <div className="mt-5 flex items-center justify-between gap-3 border-t border-[var(--line)] pt-4">
        <div className="text-sm text-muted">{context?.event_group ? `Selected: ${context.event_group.title}` : "If no existing group applies, create a new Event Group."}</div>
        <button type="button" onClick={() => onContinueToTriage(incidentId)} disabled={!context?.event_group || busy} className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Continue to triage</button>
      </div>
    </ModalDialog>
  );
}

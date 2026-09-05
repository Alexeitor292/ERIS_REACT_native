import { useEffect, useMemo, useState } from "react";

import { api } from "../../api/client";
import ModalDialog from "../../ui/ModalDialog";
import EventGroupTriageMap from "./EventGroupTriageMap";
import type { EventGroupDetailResponse, EventGroupIncidentSummary, EventGroupSummary } from "./eventGroupTypes";
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

const inputClass = "rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-normal normal-case text-[var(--ink)] outline-none focus:ring-2 focus:ring-[var(--brand)]";

/**
 * Step 1 of coordinator triage: confirm the Event Group context. Nearby open groups
 * are listed by distance beside a map that shows the new report, the groups, and
 * the selected group's existing incidents. "Starts its own event" creates a new
 * Event Group. The decision is saved before the disposition step.
 */
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
  const [radiusMiles, setRadiusMiles] = useState(25);
  const [mode, setMode] = useState<"EXISTING" | "CREATE_NEW">("EXISTING");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedIncidents, setSelectedIncidents] = useState<EventGroupIncidentSummary[]>([]);
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
    load(25);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentId]);

  // Preview the selected group's existing incidents on the map.
  useEffect(() => {
    if (selectedId == null || mode !== "EXISTING") { setSelectedIncidents([]); return; }
    let cancelled = false;
    api<EventGroupDetailResponse>(`/event-groups/${selectedId}`)
      .then((detail) => { if (!cancelled) setSelectedIncidents(detail.incidents ?? []); })
      .catch(() => { if (!cancelled) setSelectedIncidents([]); });
    return () => { cancelled = true; };
  }, [mode, selectedId]);

  const selected = useMemo(
    () => groups.find((group) => group.id === selectedId) ?? (context?.event_group?.id === selectedId ? context.event_group : null),
    [context?.event_group, groups, selectedId],
  );
  const mapGroups = useMemo<EventGroupSummary[]>(() => {
    if (context?.event_group && !groups.some((group) => group.id === context.event_group!.id)) return [context.event_group, ...groups];
    return groups;
  }, [context?.event_group, groups]);

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
          : { mode, title: title.trim() || null, description: description.trim() || null, notes: notes.trim() || null }),
      });
      await load(radiusMiles);
    } catch (e: any) {
      setError(e?.message ?? "Failed to save Event Group association.");
    } finally {
      setBusy(false);
    }
  }

  const incident = context?.incident ?? null;
  const decisionSaved = !!context?.event_group;

  return (
    <ModalDialog
      titleId="event-group-association-title"
      descriptionId="event-group-association-description"
      busy={busy}
      onClose={onClose}
      panelClassName="flex max-h-[92vh] w-full max-w-6xl flex-col rounded-xl border border-[var(--line)] bg-[var(--panel)] shadow-2xl"
    >
      <div className="flex items-start justify-between gap-4 border-b border-[var(--line)] px-5 py-4">
        <div>
          <h2 id="event-group-association-title" className="text-base font-semibold">Event Group review — incident #{incidentId}</h2>
          <p id="event-group-association-description" className="mt-1 max-w-3xl text-[13px] text-muted">Confirm shared-event context before triage. Accepting the report records the Event Group decision and enters the incident into ERIS.</p>
        </div>
        <button type="button" onClick={onClose} disabled={busy} aria-label="Close dialog" className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 text-sm font-semibold hover:bg-[var(--panel-soft)] disabled:opacity-50">×</button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {error ? <div className="mb-4 rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}

        {!context ? <div className="py-12 text-center text-sm text-muted">Loading Event Group context…</div> : (
          <div className="grid gap-4 lg:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.4fr)]">
            <div className="grid content-start gap-2">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold">Nearby open Event Groups</div>
                <select value={radiusMiles} onChange={(event) => { const next = Number(event.target.value); setRadiusMiles(next); void load(next); }} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2 py-1.5 text-xs">
                  <option value={5}>5 miles</option><option value={10}>10 miles</option><option value={25}>25 miles</option><option value={50}>50 miles</option>
                </select>
              </div>
              <div className="grid max-h-[52vh] content-start gap-2 overflow-auto pr-1">
                <label className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 ${mode === "CREATE_NEW" ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_7%,var(--panel))]" : "border-[var(--line)] bg-[var(--panel)] hover:bg-[var(--panel-soft)]"}`}>
                  <input type="radio" name="event-group-decision" checked={mode === "CREATE_NEW"} onChange={() => setMode("CREATE_NEW")} className="mt-0.5" />
                  <span><span className="block text-sm font-semibold">Starts its own event</span><span className="mt-0.5 block text-xs text-muted">No existing Event Group covers this occurrence — ERIS creates a new one.</span></span>
                </label>
                {groups.length === 0 ? <div className="rounded-lg border border-dashed border-[var(--line)] p-4 text-sm text-muted">No open Event Groups within {radiusMiles} miles.</div> : groups.map((group) => {
                  const active = mode === "EXISTING" && selectedId === group.id;
                  return (
                    <label key={group.id} className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 ${active ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_7%,var(--panel))]" : "border-[var(--line)] bg-[var(--panel)] hover:bg-[var(--panel-soft)]"}`}>
                      <input type="radio" name="event-group-decision" checked={active} onChange={() => { setMode("EXISTING"); setSelectedId(group.id); }} className="mt-0.5" />
                      <span className="min-w-0"><span className="block text-sm font-semibold">{group.title}</span><span className="mt-0.5 block text-xs text-muted">#{group.id} · {eventGroupLocationLabel(group)} · {group.incident_count} incident{group.incident_count === 1 ? "" : "s"} · {distanceLabel(group.nearest_distance_m)}</span></span>
                    </label>
                  );
                })}
              </div>

              {mode === "CREATE_NEW" ? (
                <div className="grid gap-2 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3">
                  <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-muted">Event Group title<input value={title} onChange={(event) => setTitle(event.target.value)} className={inputClass} /></label>
                  <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-muted">Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2} className={inputClass} /></label>
                </div>
              ) : null}
              <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-muted">Coordinator note<textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} className={inputClass} /></label>
              <button type="button" onClick={associate} disabled={busy || !context.can_change_association || (mode === "EXISTING" && !selectedId)} className="rounded-md border border-[var(--brand)] px-3 py-2 text-sm font-semibold text-[var(--brand)] hover:bg-[color:color-mix(in_oklab,var(--brand)_8%,var(--panel))] disabled:opacity-50">
                {busy ? "Saving…" : mode === "CREATE_NEW" ? "Create Event Group and record decision" : "Record decision · use selected Event Group"}
              </button>
              {decisionSaved ? <div className="text-xs text-[var(--good)]">Decision recorded: {context.event_group!.title}</div> : <div className="text-xs text-muted">Record the decision to continue to triage.</div>}
            </div>

            <div className="min-w-0">
              <EventGroupTriageMap
                incident={incident ? { id: incident.id, latitude: incident.latitude, longitude: incident.longitude, title: incident.title } : null}
                groups={mapGroups}
                selectedGroupId={mode === "EXISTING" ? selectedId : null}
                selectedIncidents={selectedIncidents}
                onSelectGroup={(groupId) => { setMode("EXISTING"); setSelectedId(groupId); }}
                height={380}
              />
              {selected && mode === "EXISTING" ? (
                <div className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3 text-sm">
                  <div className="font-semibold">{selected.title}</div>
                  <div className="mt-0.5 text-xs text-muted">{eventGroupLocationLabel(selected)} · {selected.incident_count} incident{selected.incident_count === 1 ? "" : "s"} · {selected.open_incident_count} active</div>
                  {selected.description ? <p className="mt-1.5 text-xs text-muted">{selected.description}</p> : null}
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-[var(--line)] px-5 py-3">
        <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">Cancel</button>
        <button type="button" onClick={() => onContinueToTriage(incidentId)} disabled={!decisionSaved || busy} className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50">Continue to triage</button>
      </div>
    </ModalDialog>
  );
}

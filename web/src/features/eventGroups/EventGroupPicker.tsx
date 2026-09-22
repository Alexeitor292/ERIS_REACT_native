import { useEffect, useMemo, useState } from "react";

import { api } from "../../api/client";
import type { EventGroupChoice } from "../incidents/triageDecisionModel";
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
};

type NearbyResponse = { items: NearbyEventGroup[] };

function generatedTitle(incident: EventGroupIncidentSummary | undefined): string {
  if (!incident) return "";
  const parts = [
    incident.route ? `Route ${incident.route}` : null,
    incident.post_mile ? `PM ${incident.post_mile}` : null,
    incident.county || null,
  ].filter(Boolean);
  return parts.length ? `${parts.join(" · ")} Event Group` : `Incident #${incident.id} Event Group`;
}

const inputClass = "rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-normal normal-case tracking-normal text-[var(--ink)] outline-none focus:ring-2 focus:ring-[var(--brand)]";

const optionClass = (active: boolean) =>
  `flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 ${active
    ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_7%,var(--panel))]"
    : "border-[var(--line)] bg-[var(--panel)] hover:bg-[var(--panel-soft)]"}`;

/**
 * Which Event Group a report joins, chosen beside the triage decision.
 *
 * Controlled and write-free: the choice lives in the triage draft and is saved
 * by the triage request itself, together with "Assessment required", so a
 * coordinator who changes their mind — or cancels — leaves nothing behind.
 * Nearby open groups are listed nearest first beside a map of the report, the
 * groups, and the selected group's reports. Nothing is preselected unless the
 * report was already placed in a group.
 */
export default function EventGroupPicker({
  incidentId,
  value,
  onChange,
}: {
  incidentId: number;
  value: EventGroupChoice | null;
  onChange: (next: EventGroupChoice) => void;
}) {
  const [context, setContext] = useState<ContextResponse | null>(null);
  const [groups, setGroups] = useState<NearbyEventGroup[]>([]);
  const [radiusMiles, setRadiusMiles] = useState(25);
  const [selectedIncidents, setSelectedIncidents] = useState<EventGroupIncidentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      api<ContextResponse>(`/incidents/${incidentId}/event-group-context`),
      api<NearbyResponse>(`/incidents/${incidentId}/nearby-event-groups?radius_m=${Math.round(radiusMiles * MILES_TO_METERS)}&limit=50`),
    ])
      .then(([nextContext, nearby]) => {
        if (cancelled) return;
        setContext(nextContext);
        setGroups(nearby.items ?? []);
      })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : "Nearby Event Groups could not be loaded."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [incidentId, radiusMiles]);

  // A report grouped earlier keeps that group as its starting answer.
  const existingGroupId = context?.event_group?.id ?? null;
  useEffect(() => {
    if (existingGroupId != null && value == null) onChange({ mode: "EXISTING", eventGroupId: existingGroupId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingGroupId]);

  const selectedId = value?.mode === "EXISTING" ? value.eventGroupId : null;
  const creating = value?.mode === "CREATE_NEW";

  useEffect(() => {
    if (selectedId == null) { setSelectedIncidents([]); return; }
    let cancelled = false;
    api<EventGroupDetailResponse>(`/event-groups/${selectedId}`)
      .then((detail) => { if (!cancelled) setSelectedIncidents(detail.incidents ?? []); })
      .catch(() => { if (!cancelled) setSelectedIncidents([]); });
    return () => { cancelled = true; };
  }, [selectedId]);

  const listed = useMemo<Array<EventGroupSummary & { nearest_distance_m?: number }>>(() => {
    const current = context?.event_group;
    if (current && !groups.some((group) => group.id === current.id)) return [current, ...groups];
    return groups;
  }, [context?.event_group, groups]);
  const selected = listed.find((group) => group.id === selectedId) ?? null;
  const incident = context?.incident;

  function chooseNew() {
    if (creating) return;
    onChange({ mode: "CREATE_NEW", title: generatedTitle(incident), description: "" });
  }

  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <div className="border-b border-[var(--line)] px-5 py-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Where it belongs</div>
        <h3 id="event-group-picker-title" className="mt-0.5 text-base font-semibold">Which Event Group does it belong to?</h3>
        <p className="mt-1 max-w-2xl text-[13px] text-muted">An Event Group is one real-world site. The assessment is tracked against it, together with every other report about the same place.</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {error ? <div role="alert" className="mb-3 rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}

        <div className="grid gap-4 @3xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          <div className="min-w-0 @3xl:order-2">
            <EventGroupTriageMap
              incident={incident ? { id: incident.id, latitude: incident.latitude, longitude: incident.longitude, title: incident.title } : null}
              groups={listed}
              selectedGroupId={selectedId}
              selectedIncidents={selectedIncidents}
              onSelectGroup={(groupId) => onChange({ mode: "EXISTING", eventGroupId: groupId })}
              height={300}
            />
            {selected ? (
              <div className="mt-3 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3 text-sm">
                <div className="font-semibold">{selected.title}</div>
                <div className="mt-0.5 text-xs text-muted">{eventGroupLocationLabel(selected)} · {selected.incident_count} report{selected.incident_count === 1 ? "" : "s"} · {selected.open_incident_count} active</div>
                {selected.description ? <p className="mt-1.5 text-xs text-muted">{selected.description}</p> : null}
              </div>
            ) : null}
          </div>

          <fieldset className="grid min-w-0 content-start gap-2 @3xl:order-1" aria-labelledby="event-group-picker-title">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">Open Event Groups nearby</span>
              <label className="flex items-center gap-1.5 text-xs text-muted">
                Within
                <select value={radiusMiles} onChange={(event) => setRadiusMiles(Number(event.target.value))} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2 py-1.5 text-xs text-[var(--ink)]">
                  <option value={5}>5 miles</option><option value={10}>10 miles</option><option value={25}>25 miles</option><option value={50}>50 miles</option>
                </select>
              </label>
            </div>

            <label className={optionClass(creating)}>
              <input type="radio" name={`event-group-${incidentId}`} checked={creating} onChange={chooseNew} className="mt-0.5" />
              <span><span className="block text-sm font-semibold">Starts its own event</span><span className="mt-0.5 block text-xs text-muted">No group here covers it — ERIS creates a new one.</span></span>
            </label>

            {creating ? (
              <div className="grid gap-2 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3">
                <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-muted">New Event Group title
                  <input value={value.title} onChange={(event) => onChange({ ...value, title: event.target.value })} className={inputClass} placeholder={generatedTitle(incident)} />
                </label>
                <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-muted">Description
                  <textarea value={value.description} onChange={(event) => onChange({ ...value, description: event.target.value })} rows={2} className={inputClass} placeholder="What is happening at this site (optional)" />
                </label>
              </div>
            ) : null}

            {loading && !listed.length ? (
              <div className="rounded-lg border border-dashed border-[var(--line)] p-4 text-sm text-muted">Looking for nearby Event Groups…</div>
            ) : listed.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--line)] p-4 text-sm text-muted">No open Event Groups within {radiusMiles} miles.</div>
            ) : listed.map((group) => (
              <label key={group.id} className={optionClass(selectedId === group.id)}>
                <input type="radio" name={`event-group-${incidentId}`} checked={selectedId === group.id} onChange={() => onChange({ mode: "EXISTING", eventGroupId: group.id })} className="mt-0.5" />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{group.title}</span>
                  <span className="mt-0.5 block text-xs text-muted tabular-nums">
                    {eventGroupLocationLabel(group)} · {group.incident_count} report{group.incident_count === 1 ? "" : "s"}
                    {group.nearest_distance_m != null ? ` · ${distanceLabel(group.nearest_distance_m)}` : " · already placed here"}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import type { IncidentClassification, IncidentClassificationQueryResponse } from "../incidents/incidentClassification";
import { classificationLabel, classificationStateLabel } from "../incidents/incidentClassification";
import type { EventGroupDetailResponse, EventGroupStatus, EventGroupSummary } from "../eventGroups/eventGroupTypes";
import { eventGroupLocationLabel, eventGroupStatusLabel } from "../eventGroups/eventGroupTypes";
import type { ProjectDetailResponse, ProjectSummary } from "../projects/projectTypes";
import AppShell from "../../ui/AppShell";
import { formatCoordinate } from "../../utils/precision";
import { isOperationalUser } from "../../utils/roleModel";
import MissionCenterProjectGisMap, { type MissionCenterMapHandle } from "./MissionCenterProjectGisMap";
import { projectSearchMatch, type MissionCenterIncidentGis, type MissionCenterMode } from "./missionCenterGisModel";

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

type MissionCenterEventGroupPage = {
  items: EventGroupSummary[];
  has_more: boolean;
  next_cursor: number | null;
};

function groupToMapProject(group: EventGroupSummary): ProjectSummary {
  return { ...group, project_uuid: group.event_group_key };
}

function detailToMapProject(detail: EventGroupDetailResponse): ProjectDetailResponse {
  return {
    project: groupToMapProject(detail.event_group),
    incidents: detail.incidents.map((incident) => ({
      id: incident.id,
      project_id: incident.event_group_id,
      title: incident.title,
      incident_type: incident.incident_type,
      status: incident.status,
      current_stage: incident.current_stage,
      latitude: incident.latitude,
      longitude: incident.longitude,
      district: incident.district,
      county: incident.county,
      route: incident.route,
      post_mile: incident.post_mile,
      first_observed_at: incident.first_observed_at,
      created_at: incident.created_at,
      updated_at: incident.updated_at,
    })),
    events: detail.events.map((event) => ({
      id: event.id,
      project_id: event.event_group_id,
      incident_id: event.incident_id,
      actor_user_id: event.actor_user_id,
      actor_name: event.actor_name,
      actor_email: event.actor_email,
      event_type: event.event_type,
      notes: event.notes,
      metadata: event.metadata,
      created_at: event.created_at,
    })),
  };
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : dateTimeFormatter.format(parsed);
}

function incidentStatusLabel(status: string) {
  return status === "RESOLVED" ? "Resolved" : status === "IN_PROGRESS" ? "In progress" : "New";
}

function StatusPill({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "good" | "bad" | "brand" }) {
  const cls = tone === "good"
    ? "border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_9%,transparent)] text-[var(--good)]"
    : tone === "bad"
      ? "border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_9%,transparent)] text-[var(--bad)]"
      : tone === "brand"
        ? "border-[color:color-mix(in_oklab,var(--brand)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_9%,transparent)] text-[var(--brand)]"
        : "border-[var(--line)] bg-[var(--panel-soft)] text-muted";
  return <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{label}</span>;
}

const btn = "rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-semibold hover:bg-[var(--panel-soft)]";
const btnPrimary = "rounded-md bg-[var(--brand)] px-3 py-2 text-sm font-semibold text-white hover:brightness-95";

/**
 * Mission Center: statewide Event Groups → a group's incidents → one incident's GIS
 * evidence. Deep-linkable as /mission-center/:gid/:iid; the evidence list and the map
 * stay in sync (clicking a photo row focuses it on the map).
 */
export default function MissionCenterProjectExplorer() {
  const navigate = useNavigate();
  const params = useParams();
  const routeGroupId = params.gid ? Number(params.gid) : null;
  const routeIncidentId = params.iid ? Number(params.iid) : null;
  const { me } = useAuth();
  const mapRef = useRef<MissionCenterMapHandle | null>(null);
  const [eventGroups, setEventGroups] = useState<EventGroupSummary[]>([]);
  const [eventGroupDetail, setEventGroupDetail] = useState<EventGroupDetailResponse | null>(null);
  const [classifications, setClassifications] = useState<Record<number, IncidentClassification>>({});
  const [incidentGis, setIncidentGis] = useState<MissionCenterIncidentGis | null>(null);
  const [eventGroupSearch, setEventGroupSearch] = useState("");
  const [eventGroupStatus, setEventGroupStatus] = useState<"ALL" | EventGroupStatus>("ALL");
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingEvidence, setLoadingEvidence] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  const selectedEventGroupId = routeGroupId != null && Number.isFinite(routeGroupId) && routeGroupId > 0 ? routeGroupId : null;
  const selectedIncidentId = selectedEventGroupId != null && routeIncidentId != null && Number.isFinite(routeIncidentId) && routeIncidentId > 0 ? routeIncidentId : null;

  const mode: MissionCenterMode = selectedIncidentId != null && incidentGis?.incident.id === selectedIncidentId
    ? "INCIDENT"
    : selectedEventGroupId != null && eventGroupDetail?.event_group.id === selectedEventGroupId
      ? "PROJECT"
      : "PROJECTS";

  const goTo = useCallback((groupId: number | null, incidentId: number | null = null) => {
    navigate(groupId == null ? "/mission-center" : incidentId == null ? `/mission-center/${groupId}` : `/mission-center/${groupId}/${incidentId}`);
  }, [navigate]);

  const loadEventGroups = useCallback(async () => {
    if (!isOperationalUser(me?.roles)) return;
    setLoadingGroups(true);
    setError(null);
    try {
      const all: EventGroupSummary[] = [];
      let cursor: number | null = null;
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        const query = new URLSearchParams({ limit: "1000" });
        if (cursor != null) query.set("after_id", String(cursor));
        const page = await api<MissionCenterEventGroupPage>(`/mission-center/event-groups?${query.toString()}`);
        all.push(...(page.items ?? []));
        if (!page.has_more || page.next_cursor == null) break;
        if (page.next_cursor === cursor) throw new Error("Event Group map pagination did not advance.");
        cursor = page.next_cursor;
      }
      setEventGroups(all);
      setLastUpdatedAt(new Date());
    } catch (e: any) {
      setError(e?.message ?? "Failed to load statewide Event Group GIS data.");
    } finally {
      setLoadingGroups(false);
    }
  }, [me?.roles]);

  useEffect(() => {
    loadEventGroups();
    const timer = window.setInterval(() => loadEventGroups().catch(() => {}), 60_000);
    return () => window.clearInterval(timer);
  }, [loadEventGroups]);

  // Group detail follows the route.
  useEffect(() => {
    if (selectedEventGroupId == null) { setEventGroupDetail(null); setClassifications({}); return; }
    let cancelled = false;
    setLoadingDetail(true);
    setError(null);
    (async () => {
      try {
        const detail = await api<EventGroupDetailResponse>(`/event-groups/${selectedEventGroupId}`);
        if (cancelled) return;
        setEventGroupDetail(detail);
        const ids = detail.incidents.map((incident) => incident.id);
        if (ids.length > 0) {
          const response = await api<IncidentClassificationQueryResponse>("/incident-classifications/query", { method: "POST", body: JSON.stringify({ incident_ids: ids }) });
          if (!cancelled) setClassifications(Object.fromEntries((response.items ?? []).map((classification) => [classification.incident_id, classification])));
        } else if (!cancelled) {
          setClassifications({});
        }
      } catch (e: any) {
        if (!cancelled) { setError(e?.message ?? "Failed to load Event Group details."); setEventGroupDetail(null); }
      } finally {
        if (!cancelled) setLoadingDetail(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedEventGroupId]);

  // Incident GIS evidence follows the route.
  useEffect(() => {
    if (selectedIncidentId == null) { setIncidentGis(null); return; }
    let cancelled = false;
    setLoadingEvidence(true);
    setError(null);
    api<MissionCenterIncidentGis>(`/mission-center/incidents/${selectedIncidentId}/gis`)
      .then((gis) => { if (!cancelled) setIncidentGis(gis); })
      .catch((e: any) => { if (!cancelled) { setError(e?.message ?? "Failed to load Incident GIS evidence."); setIncidentGis(null); } })
      .finally(() => { if (!cancelled) setLoadingEvidence(false); });
    return () => { cancelled = true; };
  }, [selectedIncidentId]);

  const mapProjects = useMemo(() => eventGroups.map(groupToMapProject), [eventGroups]);
  const visibleMapProjects = useMemo(
    () => mapProjects.filter((group) => (eventGroupStatus === "ALL" || group.status === eventGroupStatus) && projectSearchMatch(group, eventGroupSearch)),
    [eventGroupSearch, eventGroupStatus, mapProjects],
  );
  const visibleGroups = useMemo(() => {
    const visibleIds = new Set(visibleMapProjects.map((group) => group.id));
    return eventGroups.filter((group) => visibleIds.has(group.id));
  }, [eventGroups, visibleMapProjects]);

  const summary = useMemo(() => ({
    groups: eventGroups.length,
    openGroups: eventGroups.filter((group) => group.status === "OPEN").length,
    incidents: eventGroups.reduce((total, group) => total + group.incident_count, 0),
    activeIncidents: eventGroups.reduce((total, group) => total + group.open_incident_count, 0),
  }), [eventGroups]);

  const selectedEventGroup = eventGroupDetail?.event_group ?? eventGroups.find((group) => group.id === selectedEventGroupId) ?? null;
  const selectedIncident = eventGroupDetail?.incidents.find((incident) => incident.id === selectedIncidentId) ?? null;
  const selectedClassification = selectedIncidentId != null ? classifications[selectedIncidentId] : undefined;
  const mapDetail = useMemo(() => eventGroupDetail ? detailToMapProject(eventGroupDetail) : null, [eventGroupDetail]);

  if (!isOperationalUser(me?.roles)) {
    return (
      <AppShell title="Mission Center">
        <div className="p-6">
          <div className="rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-5 text-sm text-muted">
            Mission Center is available to ERIS operational engineering and coordination roles. Maintenance reporting accounts remain scoped to their own reports.
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title="Mission Center">
      <div className="grid gap-4 p-4 md:p-5">
        {mode === "PROJECTS" ? (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] px-4 py-2.5">
            <div className="grid max-w-[560px] flex-[1_1_340px] grid-cols-[minmax(220px,1fr)_auto] gap-2">
              <input value={eventGroupSearch} onChange={(event) => setEventGroupSearch(event.target.value)} placeholder="Search Event Groups — county, route, post mile…" className="min-w-0 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]" />
              <select value={eventGroupStatus} onChange={(event) => setEventGroupStatus(event.target.value as "ALL" | EventGroupStatus)} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm">
                <option value="ALL">All statuses</option>
                <option value="OPEN">Open</option>
                <option value="CLOSED">Closed</option>
                <option value="ARCHIVED">Archived</option>
              </select>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2.5 text-xs text-muted">
              <span>{summary.groups} Event Groups · {summary.openGroups} open · {summary.incidents} Incidents · {summary.activeIncidents} active</span>
              <span className="opacity-50">·</span>
              <span>{lastUpdatedAt ? `Updated ${dateTimeFormatter.format(lastUpdatedAt)}` : "Not refreshed yet"}</span>
              <button type="button" onClick={() => loadEventGroups()} disabled={loadingGroups} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 text-xs font-medium text-[var(--ink)] hover:bg-[var(--panel-soft)] disabled:opacity-50">{loadingGroups ? "Refreshing…" : "Refresh"}</button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] px-4 py-2.5 text-[13px]">
            <Link to="/mission-center" className="font-semibold text-[var(--brand)] hover:underline">California Event Groups</Link>
            <span className="text-muted">›</span>
            {mode === "INCIDENT" && selectedEventGroup ? <Link to={`/mission-center/${selectedEventGroup.id}`} className="font-semibold text-[var(--brand)] hover:underline">{selectedEventGroup.title}</Link> : <b className="font-semibold">{selectedEventGroup?.title ?? `Event Group #${selectedEventGroupId}`}</b>}
            {mode === "INCIDENT" ? <><span className="text-muted">›</span><b className="font-semibold">Incident #{selectedIncidentId}</b></> : null}
            {selectedEventGroup ? <span className="ml-auto text-xs text-muted">{eventGroupLocationLabel(selectedEventGroup)}</span> : null}
          </div>
        )}

        {error ? <div role="alert" className="rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}
        {notice ? <div className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-sm text-muted">{notice}</div> : null}

        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(340px,0.8fr)]">
          <MissionCenterProjectGisMap
            ref={mapRef}
            mode={mode}
            projects={visibleMapProjects}
            selectedProjectId={selectedEventGroupId}
            projectDetail={mapDetail}
            selectedIncidentId={selectedIncidentId}
            incidentGis={incidentGis}
            classifications={classifications}
            onSelectProject={(groupId) => goTo(groupId)}
            onSelectIncident={(incidentId) => goTo(selectedEventGroupId, incidentId)}
            height="clamp(540px, calc(100vh - 320px), 900px)"
          />

          <aside className="flex max-h-[760px] flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
            {mode === "PROJECTS" ? (
              <>
                <div className="border-b border-[var(--line)] bg-[var(--panel-soft)] p-4">
                  <div className="text-[17px] font-semibold">Event Groups</div>
                  <div className="mt-0.5 text-xs text-muted">{visibleGroups.length.toLocaleString()} shown on map</div>
                </div>
                <div className="flex-1 overflow-auto p-3">
                  <div className="grid gap-2">
                    {visibleGroups.length === 0 ? <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-4 text-sm text-muted">{loadingGroups ? "Loading Event Groups…" : "No Event Groups match the current filters."}</div> : visibleGroups.map((group) => (
                      <button key={group.id} type="button" onClick={() => goTo(group.id)} className="block w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] p-3 text-left hover:border-[color:color-mix(in_oklab,var(--brand)_45%,var(--line))] hover:bg-[var(--panel-soft)]">
                        <div className="flex items-start justify-between gap-2"><div className="font-semibold leading-snug">{group.title}</div><StatusPill label={eventGroupStatusLabel(group.status)} tone={group.status === "OPEN" ? "good" : "neutral"} /></div>
                        <div className="mt-1 text-xs text-muted">Event Group #{group.id} · {eventGroupLocationLabel(group)}</div>
                        <div className="mt-2 text-xs text-muted">{group.incident_count} associated Incident{group.incident_count === 1 ? "" : "s"} · {group.open_incident_count} active</div>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : null}

            {mode !== "PROJECTS" && mode !== "INCIDENT" && selectedEventGroup ? (
              <>
                <div className="border-b border-[var(--line)] bg-[var(--panel-soft)] p-4">
                  <button type="button" onClick={() => goTo(null)} className="mb-3 rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-[11px] font-semibold hover:bg-[var(--panel-soft)]">← All California Event Groups</button>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Selected Event Group</div>
                  <div className="mt-1 text-[17px] font-semibold leading-snug">{selectedEventGroup.title}</div>
                  <div className="mt-1 text-sm text-muted">Event Group #{selectedEventGroup.id} · {eventGroupLocationLabel(selectedEventGroup)}</div>
                  <div className="mt-3 flex flex-wrap gap-2"><StatusPill label={eventGroupStatusLabel(selectedEventGroup.status)} tone={selectedEventGroup.status === "OPEN" ? "good" : "neutral"} /><StatusPill label={`${selectedEventGroup.incident_count} incidents`} /><StatusPill label={`${selectedEventGroup.open_incident_count} active`} tone={selectedEventGroup.open_incident_count > 0 ? "bad" : "good"} /></div>
                  {selectedEventGroup.description ? <p className="mt-3 text-sm text-muted">{selectedEventGroup.description}</p> : null}
                  <Link to={`/event-groups/${selectedEventGroup.id}`} className={`${btn} mt-3.5 block text-center`}>Open full Event Group workspace</Link>
                </div>
                <div className="flex-1 overflow-auto p-3">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Associated Incidents</div>
                  {loadingDetail ? <div className="text-sm text-muted">Loading associated Incidents…</div> : eventGroupDetail?.incidents.length ? <div className="grid gap-2">{eventGroupDetail.incidents.map((incident) => (
                    <button key={incident.id} type="button" onClick={() => goTo(selectedEventGroup.id, incident.id)} className="block w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] p-3 text-left hover:border-[color:color-mix(in_oklab,var(--brand)_45%,var(--line))] hover:bg-[var(--panel-soft)]">
                      <div className="flex items-start justify-between gap-2"><div className="font-semibold">#{incident.id} {incident.title || "Incident"}</div><StatusPill label={incidentStatusLabel(incident.status)} tone={incident.status === "RESOLVED" ? "good" : "bad"} /></div>
                      <div className="mt-1 text-xs text-muted">{eventGroupLocationLabel(incident)}</div>
                      <div className="mt-2 text-xs font-medium">{classificationLabel(classifications[incident.id])}</div>
                    </button>
                  ))}</div> : <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-4 text-sm text-muted">No Incidents are associated with this Event Group.</div>}
                </div>
              </>
            ) : null}

            {mode === "INCIDENT" && selectedIncident && incidentGis && selectedEventGroup ? (
              <>
                <div className="border-b border-[var(--line)] bg-[var(--panel-soft)] p-4">
                  <button type="button" onClick={() => goTo(selectedEventGroup.id)} className="mb-3 rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-[11px] font-semibold hover:bg-[var(--panel-soft)]">← Event Group Incidents</button>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Incident GIS Evidence</div>
                  <div className="mt-1 text-[17px] font-semibold leading-snug">#{selectedIncident.id} {selectedIncident.title || "Incident"}</div>
                  <div className="mt-2 flex flex-wrap gap-2"><StatusPill label={incidentStatusLabel(selectedIncident.status)} tone={selectedIncident.status === "RESOLVED" ? "good" : "bad"} /><StatusPill label={classificationLabel(selectedClassification)} tone={selectedClassification?.confirmed ? "good" : "neutral"} /></div>
                  {classificationStateLabel(selectedClassification) ? <div className="mt-2 text-xs text-muted">{classificationStateLabel(selectedClassification)}</div> : null}
                </div>

                <div className="flex-1 overflow-auto p-4">
                  {loadingEvidence ? <div className="text-sm text-muted">Loading GIS evidence…</div> : null}
                  <dl className="grid grid-cols-2 gap-3 text-sm">
                    <div><dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Incident location</dt><dd className="mt-1 font-medium tabular-nums">{formatCoordinate(incidentGis.incident.latitude)}, {formatCoordinate(incidentGis.incident.longitude)}</dd></div>
                    <div><dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Observed</dt><dd className="mt-1 font-medium">{formatTimestamp(incidentGis.incident.first_observed_at)}</dd></div>
                    <div><dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Saved geometry</dt><dd className="mt-1 font-medium">{incidentGis.geometry ? String((incidentGis.geometry as any).type || "Available") : "None recorded"}</dd></div>
                    <div><dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Linked submission</dt><dd className="mt-1 font-medium">{incidentGis.incident.linked_submission_id ? `#${incidentGis.incident.linked_submission_id}` : "Not created yet"}</dd></div>
                  </dl>

                  <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] px-3.5 py-2.5">
                    {[["Photos", incidentGis.photo_summary.photos_total], ["Mapped", incidentGis.photo_summary.photos_geotagged], ["Heading", incidentGis.photo_summary.photos_with_heading], ["Unmapped", incidentGis.photo_summary.photos_unmapped]].map(([label, value]) => (
                      <div key={String(label)}><div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted">{label}</div><div className="mt-0.5 text-[17px] font-semibold tabular-nums">{value}</div></div>
                    ))}
                  </div>

                  {incidentGis.incident.description ? <div className="mt-4 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3"><div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Report description</div><p className="mt-1 text-sm">{incidentGis.incident.description}</p></div> : null}

                  <div className="mt-5 flex flex-wrap gap-2">
                    {incidentGis.incident.linked_submission_id ? <Link to={`/submissions/${incidentGis.incident.linked_submission_id}`} className={btnPrimary}>Open technical submission</Link> : null}
                    <Link to={`/incidents/${selectedIncident.id}`} className={btn}>Open in Incidents</Link>
                    <Link to={`/event-groups/${selectedEventGroup.id}`} className={btn}>Open Event Group</Link>
                  </div>

                  <div className="mt-5 border-t border-[var(--line)] pt-4">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Photo evidence</div>
                    {incidentGis.photos.length === 0 ? <div className="mt-2 text-sm text-muted">No field photo evidence is linked to this Incident.</div> : <div className="mt-3 grid gap-2.5">{incidentGis.photos.map((photo) => {
                      const mapped = photo.latitude != null && photo.longitude != null;
                      return (
                        <button
                          key={photo.attachment_id}
                          type="button"
                          onClick={() => {
                            if (mapped && mapRef.current?.focusPhoto(photo.attachment_id)) { setNotice(null); return; }
                            if (!mapped) { setNotice(`${photo.file_name} has no mapped location; opening the original file instead.`); }
                            window.open(photo.download_url, "_blank", "noopener,noreferrer");
                          }}
                          className="flex w-full items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-2.5 text-left hover:border-[color:color-mix(in_oklab,var(--brand)_45%,var(--line))] hover:bg-[var(--panel-soft)]"
                          title={mapped ? "Show this photo on the map" : "Open the original file"}
                        >
                          {photo.mime_type.toLowerCase().startsWith("image/") ? <img src={photo.download_url} alt="" className="h-14 w-20 shrink-0 rounded object-cover" loading="lazy" /> : <div className="flex h-14 w-20 shrink-0 items-center justify-center rounded bg-[var(--panel-soft)] text-[10px] font-bold tracking-wide text-muted">FILE</div>}
                          <div className="min-w-0"><div className="truncate text-sm font-semibold">{photo.file_name}</div><div className="mt-0.5 text-xs text-muted">{mapped ? "Mapped" : "Unmapped"}{photo.camera_heading_deg != null ? ` · ${photo.camera_heading_deg.toFixed(1)}° camera heading` : " · No camera heading"}</div><div className="mt-0.5 text-xs text-muted">{formatTimestamp(photo.captured_at)}</div></div>
                        </button>
                      );
                    })}</div>}
                  </div>
                </div>
              </>
            ) : null}

            {mode !== "PROJECTS" && !selectedEventGroup ? <div className="p-4 text-sm text-muted">{loadingDetail ? "Loading Event Group…" : `Event Group #${selectedEventGroupId} was not found.`}</div> : null}
            {mode === "PROJECT" && selectedIncidentId != null && !loadingEvidence && !incidentGis ? <div className="border-t border-[var(--line)] p-4 text-sm text-muted">Incident #{selectedIncidentId} is not part of this Event Group or has no GIS evidence.</div> : null}
          </aside>
        </div>
      </div>
    </AppShell>
  );
}

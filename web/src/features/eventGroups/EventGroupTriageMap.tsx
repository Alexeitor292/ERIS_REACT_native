import { useEffect, useRef } from "react";
import esriConfig from "@arcgis/core/config";
import Map from "@arcgis/core/Map";
import MapView from "@arcgis/core/views/MapView";
import Graphic from "@arcgis/core/Graphic";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import Point from "@arcgis/core/geometry/Point";

import { basemapForTheme, useThemeBasemap } from "../../components/mapTheme";
import type { EventGroupIncidentSummary, EventGroupSummary } from "./eventGroupTypes";
import { eventGroupLocationLabel } from "./eventGroupTypes";

type Props = {
  incident: { id: number; latitude: number; longitude: number; title?: string | null } | null;
  groups: EventGroupSummary[];
  selectedGroupId: number | null;
  selectedIncidents: EventGroupIncidentSummary[];
  onSelectGroup: (groupId: number) => void;
  height?: number;
};

const GROUP_COLOR: [number, number, number, number] = [30, 96, 255, 0.94];
const NEW_INCIDENT_COLOR: [number, number, number, number] = [209, 75, 84, 1];
const ACTIVE_INCIDENT_COLOR: [number, number, number, number] = [211, 47, 47, 0.96];
const RESOLVED_INCIDENT_COLOR: [number, number, number, number] = [100, 116, 139, 0.92];

/**
 * Map beside the Event Group review step of coordinator triage: the new report,
 * every nearby open Event Group (click to select), and the selected group's
 * existing incidents so the coordinator can judge whether it belongs there.
 */
export default function EventGroupTriageMap({ incident, groups, selectedGroupId, selectedIncidents, onSelectGroup, height = 360 }: Props) {
  const divRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<MapView | null>(null);
  const groupLayerRef = useRef<GraphicsLayer | null>(null);
  const incidentLayerRef = useRef<GraphicsLayer | null>(null);
  const reportLayerRef = useRef<GraphicsLayer | null>(null);
  const onSelectRef = useRef(onSelectGroup);
  const apiKey = String((import.meta as any)?.env?.VITE_ARCGIS_API_KEY ?? "");
  useEffect(() => { onSelectRef.current = onSelectGroup; }, [onSelectGroup]);
  useThemeBasemap(viewRef, !!apiKey);

  useEffect(() => {
    esriConfig.assetsPath = "/assets";
    if (apiKey) esriConfig.apiKey = apiKey;
    if (!divRef.current) return;
    const groupLayer = new GraphicsLayer({ title: "Open Event Groups" });
    const incidentLayer = new GraphicsLayer({ title: "Event Group incidents" });
    const reportLayer = new GraphicsLayer({ title: "New report" });
    groupLayerRef.current = groupLayer;
    incidentLayerRef.current = incidentLayer;
    reportLayerRef.current = reportLayer;
    const map = new Map({ basemap: basemapForTheme(!!apiKey), layers: [groupLayer, incidentLayer, reportLayer] });
    const view = new MapView({ container: divRef.current, map, center: [-119.5, 37.3], zoom: 6, popup: { dockEnabled: false } as any });
    const clickHandle = view.on("click", async (event) => {
      try {
        const hit = await view.hitTest(event);
        const picked = (hit.results as any[]).find((result) => result?.graphic?.attributes?.groupId != null);
        const groupId = Number(picked?.graphic?.attributes?.groupId);
        if (Number.isFinite(groupId) && groupId > 0) onSelectRef.current(groupId);
      } catch {
        // Clicking the list remains available.
      }
    });
    viewRef.current = view;
    return () => {
      clickHandle.remove();
      view.destroy();
      viewRef.current = null;
      groupLayerRef.current = null;
      incidentLayerRef.current = null;
      reportLayerRef.current = null;
    };
  }, [apiKey]);

  useEffect(() => {
    const view = viewRef.current;
    const groupLayer = groupLayerRef.current;
    const incidentLayer = incidentLayerRef.current;
    const reportLayer = reportLayerRef.current;
    if (!view || !groupLayer || !incidentLayer || !reportLayer) return;
    groupLayer.removeAll();
    incidentLayer.removeAll();
    reportLayer.removeAll();

    const graphics: Graphic[] = [];
    if (incident) {
      const report = new Graphic({
        geometry: new Point({ longitude: incident.longitude, latitude: incident.latitude, spatialReference: { wkid: 4326 } }),
        attributes: { incidentId: incident.id },
        symbol: { type: "simple-marker", style: "circle", size: 16, color: NEW_INCIDENT_COLOR, outline: { color: [255, 255, 255, 1], width: 3 } } as any,
        popupTemplate: { title: `New incident #${incident.id}`, content: incident.title ?? "Field report awaiting intake." } as any,
      });
      reportLayer.add(report);
      graphics.push(report);
    }
    for (const group of groups) {
      const selected = group.id === selectedGroupId;
      const graphic = new Graphic({
        geometry: new Point({ longitude: group.centroid_longitude, latitude: group.centroid_latitude, spatialReference: { wkid: 4326 } }),
        attributes: { groupId: group.id },
        symbol: { type: "simple-marker", style: "circle", size: selected ? 18 : 13, color: GROUP_COLOR, outline: { color: selected ? [255, 255, 255, 1] : [15, 23, 42, 0.9], width: selected ? 3 : 1.5 } } as any,
        popupTemplate: { title: `Event Group #${group.id} · ${group.title}`, content: `${eventGroupLocationLabel(group)}<br/>${group.incident_count} incidents · ${group.open_incident_count} active<br/><br/>Click the marker to select this Event Group.` } as any,
      });
      groupLayer.add(graphic);
      graphics.push(graphic);
    }
    if (selectedGroupId != null) {
      for (const existing of selectedIncidents) {
        const resolved = existing.status === "RESOLVED";
        const graphic = new Graphic({
          geometry: new Point({ longitude: existing.longitude, latitude: existing.latitude, spatialReference: { wkid: 4326 } }),
          attributes: { existingIncidentId: existing.id },
          symbol: { type: "simple-marker", style: resolved ? "circle" : "diamond", size: resolved ? 9 : 12, color: resolved ? RESOLVED_INCIDENT_COLOR : ACTIVE_INCIDENT_COLOR, outline: { color: [255, 255, 255, 1], width: 2 } } as any,
          popupTemplate: { title: `#${existing.id} · ${existing.title || "Incident"}`, content: `${eventGroupLocationLabel(existing)}<br/>${resolved ? "Resolved" : existing.status === "IN_PROGRESS" ? "In progress" : "New"}` } as any,
        });
        incidentLayer.add(graphic);
        graphics.push(graphic);
      }
    }
    if (graphics.length > 1) view.goTo(graphics, { duration: 0 }).then(() => { if (view.zoom > 15) view.zoom = 15; }).catch(() => {});
    else if (graphics.length === 1) view.goTo({ target: graphics[0].geometry, zoom: 11 }, { duration: 0 }).catch(() => {});
  }, [groups, incident, selectedGroupId, selectedIncidents]);

  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? null;

  return (
    <div className="map-stack-guard overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel-soft)]">
      <div ref={divRef} style={{ height }} aria-label="Nearby Event Groups map" />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block h-2.5 w-2.5 rounded-full border-2 border-white bg-[var(--bad)] shadow-[0_0_0_1px_var(--line)]" /> New incident</span>
        <span className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block h-2.5 w-2.5 rounded-full bg-[rgb(30,96,255)]" /> Open Event Group — click to select</span>
        {selectedGroup ? <span className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block h-2 w-2 rotate-45 bg-[rgb(211,47,47)]" /> {selectedGroup.title}'s incidents ({selectedIncidents.length})</span> : <span>Select an Event Group to preview its existing incidents.</span>}
      </div>
    </div>
  );
}

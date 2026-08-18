import { useEffect, useRef } from "react";
import esriConfig from "@arcgis/core/config";
import Map from "@arcgis/core/Map";
import MapView from "@arcgis/core/views/MapView";
import Graphic from "@arcgis/core/Graphic";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import Point from "@arcgis/core/geometry/Point";
import Home from "@arcgis/core/widgets/Home";
import ScaleBar from "@arcgis/core/widgets/ScaleBar";
import Compass from "@arcgis/core/widgets/Compass";

import type { NearbyProject, ProjectIncidentSummary } from "./projectTypes";
import { milesFromMeters, projectLocationLabel } from "./projectTypes";

type Props = {
  incident: ProjectIncidentSummary;
  projects: NearbyProject[];
  selectedProjectId: number | null;
  onSelectProject: (projectId: number) => void;
  height?: number;
};

export default function ProjectAssociationMap({
  incident,
  projects,
  selectedProjectId,
  onSelectProject,
  height = 520,
}: Props) {
  const divRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<MapView | null>(null);
  const layerRef = useRef<GraphicsLayer | null>(null);
  const onSelectRef = useRef(onSelectProject);

  useEffect(() => {
    onSelectRef.current = onSelectProject;
  }, [onSelectProject]);

  useEffect(() => {
    esriConfig.assetsPath = "/assets";
    if (!divRef.current) return;

    const layer = new GraphicsLayer({ title: "Project association" });
    const map = new Map({ basemap: "hybrid", layers: [layer] });
    const view = new MapView({
      container: divRef.current,
      map,
      center: [incident.longitude, incident.latitude],
      zoom: 13,
      constraints: { snapToZoom: false },
    });

    view.ui.add(new Home({ view }), "top-left");
    view.ui.add(new Compass({ view }), "top-left");
    view.ui.add(new ScaleBar({ view, unit: "dual" }), "bottom-left");

    const clickHandle = view.on("click", async (event) => {
      try {
        const hit = await view.hitTest(event);
        const result = hit.results.find((item: any) => item?.graphic?.attributes?.project_id != null) as any;
        const projectId = Number(result?.graphic?.attributes?.project_id);
        if (Number.isFinite(projectId) && projectId > 0) onSelectRef.current(projectId);
      } catch {
        // Map selection is supplemental; the list remains the accessible fallback.
      }
    });

    viewRef.current = view;
    layerRef.current = layer;

    return () => {
      clickHandle.remove();
      layerRef.current = null;
      viewRef.current = null;
      view.destroy();
    };
  }, [incident.id, incident.latitude, incident.longitude]);

  useEffect(() => {
    const layer = layerRef.current;
    const view = viewRef.current;
    if (!layer || !view) return;

    layer.removeAll();
    const graphics: Graphic[] = [];

    for (const project of projects) {
      const selected = project.id === selectedProjectId;
      const projectGraphic = new Graphic({
        geometry: new Point({
          longitude: project.centroid_longitude,
          latitude: project.centroid_latitude,
          spatialReference: { wkid: 4326 },
        }),
        symbol: {
          type: "simple-marker",
          style: "circle",
          size: selected ? 18 : 14,
          color: selected ? [30, 96, 255, 0.95] : [255, 172, 28, 0.92],
          outline: { color: [255, 255, 255, 1], width: selected ? 3 : 2 },
        } as any,
        attributes: {
          project_id: project.id,
          title: project.title,
          distance: milesFromMeters(project.nearest_distance_m),
          incidents: project.incident_count,
          location: projectLocationLabel(project),
        },
        popupTemplate: {
          title: "{title}",
          content: [
            {
              type: "fields",
              fieldInfos: [
                { fieldName: "distance", label: "Distance" },
                { fieldName: "incidents", label: "Incidents" },
                { fieldName: "location", label: "Project location" },
              ],
            },
          ],
        } as any,
      });
      graphics.push(projectGraphic);

      for (const projectIncident of project.incidents) {
        graphics.push(
          new Graphic({
            geometry: new Point({
              longitude: projectIncident.longitude,
              latitude: projectIncident.latitude,
              spatialReference: { wkid: 4326 },
            }),
            symbol: {
              type: "simple-marker",
              style: "circle",
              size: 7,
              color: [255, 255, 255, 0.92],
              outline: { color: selected ? [30, 96, 255, 1] : [60, 60, 60, 0.9], width: 1.5 },
            } as any,
            attributes: {
              project_id: project.id,
              incident_id: projectIncident.id,
              title: projectIncident.title || `Incident #${projectIncident.id}`,
              status: projectIncident.status,
            },
            popupTemplate: {
              title: "Incident #{incident_id}",
              content: "{title}<br/><strong>Status:</strong> {status}",
            } as any,
          })
        );
      }
    }

    graphics.push(
      new Graphic({
        geometry: new Point({
          longitude: incident.longitude,
          latitude: incident.latitude,
          spatialReference: { wkid: 4326 },
        }),
        symbol: {
          type: "simple-marker",
          style: "diamond",
          size: 19,
          color: [211, 47, 47, 1],
          outline: { color: [255, 255, 255, 1], width: 3 },
        } as any,
        attributes: {
          incident_id: incident.id,
          title: incident.title || `Incident #${incident.id}`,
          location: [incident.district ? `D${incident.district}` : null, incident.route ? `R${incident.route}` : null, incident.post_mile ? `PM ${incident.post_mile}` : null].filter(Boolean).join(" · "),
        },
        popupTemplate: {
          title: "Reported Incident #{incident_id}",
          content: "{title}<br/>{location}",
        } as any,
      })
    );

    layer.addMany(graphics);

    if (selectedProjectId != null) {
      const selected = projects.find((project) => project.id === selectedProjectId);
      if (selected) {
        view.goTo({ center: [selected.centroid_longitude, selected.centroid_latitude], zoom: 14 }, { duration: 250 }).catch(() => {});
        return;
      }
    }

    view.goTo({ center: [incident.longitude, incident.latitude], zoom: projects.length ? 12.5 : 14 }, { duration: 250 }).catch(() => {});
  }, [incident, projects, selectedProjectId]);

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel-soft)]">
      <div ref={divRef} style={{ height }} aria-label="Incident and nearby Projects map" />
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-xs text-muted">
        <span className="inline-flex items-center gap-2"><span className="inline-block h-3 w-3 rotate-45 rounded-[2px] bg-red-600" /> Reported incident</span>
        <span className="inline-flex items-center gap-2"><span className="inline-block h-3 w-3 rounded-full bg-amber-500" /> Nearby Project</span>
        <span className="inline-flex items-center gap-2"><span className="inline-block h-3 w-3 rounded-full bg-[var(--brand)]" /> Selected Project</span>
      </div>
    </div>
  );
}

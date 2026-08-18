import { useEffect, useRef } from "react";
import esriConfig from "@arcgis/core/config";
import Map from "@arcgis/core/Map";
import MapView from "@arcgis/core/views/MapView";
import Graphic from "@arcgis/core/Graphic";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import Point from "@arcgis/core/geometry/Point";
import Home from "@arcgis/core/widgets/Home";
import Compass from "@arcgis/core/widgets/Compass";
import ScaleBar from "@arcgis/core/widgets/ScaleBar";

import type { IncidentClassification, ProjectIncidentSummary, ProjectSummary } from "./projectTypes";
import { classificationLabel } from "./projectTypes";

type Props = {
  project: ProjectSummary;
  incidents: ProjectIncidentSummary[];
  classifications?: Record<number, IncidentClassification>;
  onOpenIncident?: (incidentId: number) => void;
  height?: number;
};

export default function ProjectDetailMap({ project, incidents, classifications = {}, onOpenIncident, height = 420 }: Props) {
  const divRef = useRef<HTMLDivElement | null>(null);
  const onOpenIncidentRef = useRef(onOpenIncident);

  useEffect(() => {
    onOpenIncidentRef.current = onOpenIncident;
  }, [onOpenIncident]);

  useEffect(() => {
    esriConfig.assetsPath = "/assets";
    if (!divRef.current) return;

    const layer = new GraphicsLayer({ title: "Project incidents" });
    const map = new Map({ basemap: "hybrid", layers: [layer] });
    const view = new MapView({
      container: divRef.current,
      map,
      center: [project.centroid_longitude, project.centroid_latitude],
      zoom: 13,
      constraints: { snapToZoom: false },
    });
    view.ui.add(new Home({ view }), "top-left");
    view.ui.add(new Compass({ view }), "top-left");
    view.ui.add(new ScaleBar({ view, unit: "dual" }), "bottom-left");

    const graphics: Graphic[] = [
      new Graphic({
        geometry: new Point({ longitude: project.centroid_longitude, latitude: project.centroid_latitude, spatialReference: { wkid: 4326 } }),
        symbol: { type: "simple-marker", style: "circle", size: 16, color: [30, 96, 255, 0.95], outline: { color: [255, 255, 255, 1], width: 3 } } as any,
        attributes: { project_id: project.id, title: project.title },
        popupTemplate: { title: "Project #{project_id}", content: "{title}" } as any,
      }),
    ];

    for (const incident of incidents) {
      const classification = classifications[incident.id];
      graphics.push(new Graphic({
        geometry: new Point({ longitude: incident.longitude, latitude: incident.latitude, spatialReference: { wkid: 4326 } }),
        symbol: {
          type: "simple-marker",
          style: incident.status === "RESOLVED" ? "circle" : "diamond",
          size: incident.status === "RESOLVED" ? 9 : 13,
          color: incident.status === "RESOLVED" ? [100, 116, 139, 0.9] : [211, 47, 47, 0.95],
          outline: { color: [255, 255, 255, 1], width: 2 },
        } as any,
        attributes: {
          incident_id: incident.id,
          title: incident.title || `Incident #${incident.id}`,
          status: incident.status,
          classification: classificationLabel(classification),
          classification_review: classification?.classification_status === "CLASSIFIED_PENDING_REVIEW" ? "Pending review" : classification?.confirmed ? "Confirmed" : "Not yet classified",
        },
        popupTemplate: {
          title: "Incident #{incident_id}",
          content: "{title}<br/><strong>Status:</strong> {status}<br/><strong>Classification:</strong> {classification}<br/><strong>Classification state:</strong> {classification_review}",
        } as any,
      }));
    }

    layer.addMany(graphics);
    if (incidents.length > 0) {
      view.goTo(graphics, { duration: 0 }).catch(() => {});
    }

    const clickHandle = view.on("double-click", async (event) => {
      try {
        const hit = await view.hitTest(event);
        const result = hit.results.find((item: any) => item?.graphic?.attributes?.incident_id != null) as any;
        const incidentId = Number(result?.graphic?.attributes?.incident_id);
        if (Number.isFinite(incidentId) && incidentId > 0) onOpenIncidentRef.current?.(incidentId);
      } catch {
        // The incident table remains the primary navigation fallback.
      }
    });

    return () => {
      clickHandle.remove();
      view.destroy();
    };
  }, [classifications, incidents, project]);

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel-soft)]">
      <div ref={divRef} style={{ height }} aria-label={`Project ${project.id} incident map`} />
      <div className="flex flex-wrap gap-x-5 gap-y-2 border-t border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-xs text-muted">
        <span className="inline-flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-[var(--brand)]" /> Project centroid</span>
        <span className="inline-flex items-center gap-2"><span className="h-3 w-3 rotate-45 rounded-[2px] bg-red-600" /> Active incident</span>
        <span className="inline-flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-slate-500" /> Resolved incident</span>
      </div>
    </div>
  );
}

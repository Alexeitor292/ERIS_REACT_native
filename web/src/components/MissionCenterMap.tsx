import { useEffect, useRef } from "react";
import esriConfig from "@arcgis/core/config";
import Map from "@arcgis/core/Map";
import MapView from "@arcgis/core/views/MapView";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import Graphic from "@arcgis/core/Graphic";
import Point from "@arcgis/core/geometry/Point";

import type { Incident } from "../api/types";

type Props = {
  incidents: Incident[];
  selectedIncidentId: number | null;
  onSelectIncident?: (incidentId: number) => void;
  height?: number;
};

const STATUS_COLOR: Record<string, [number, number, number, number]> = {
  NEW: [220, 38, 38, 0.95],
  IN_PROGRESS: [234, 179, 8, 0.95],
  RESOLVED: [34, 197, 94, 0.95],
};

export default function MissionCenterMap({
  incidents,
  selectedIncidentId,
  onSelectIncident,
  height = 480,
}: Props) {
  const mapElRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<MapView | null>(null);
  const layerRef = useRef<GraphicsLayer | null>(null);

  useEffect(() => {
    esriConfig.assetsPath = "/assets";
    if (!mapElRef.current) return;

    const layer = new GraphicsLayer({ title: "Incidents" });
    layerRef.current = layer;

    const map = new Map({
      basemap: "topo-vector",
      layers: [layer],
    });

    const view = new MapView({
      container: mapElRef.current,
      map,
      center: [-119.4179, 36.7783],
      zoom: 6,
    });

    view.on("click", async (event) => {
      const hit = await view.hitTest(event);
      const picked = (hit.results as any[]).find((r) => r?.graphic?.attributes?.incidentId != null);
      const incidentId = picked?.graphic?.attributes?.incidentId;
      if (incidentId && onSelectIncident) onSelectIncident(Number(incidentId));
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
      layerRef.current = null;
    };
  }, [onSelectIncident]);

  useEffect(() => {
    const layer = layerRef.current;
    const view = viewRef.current;
    if (!layer || !view) return;

    layer.removeAll();

    for (const incident of incidents) {
      const color = STATUS_COLOR[incident.status] ?? [20, 93, 203, 0.92];
      const isSelected = selectedIncidentId === incident.id;
      const point = new Point({
        longitude: incident.longitude,
        latitude: incident.latitude,
      });
      layer.add(
        new Graphic({
          geometry: point,
          attributes: { incidentId: incident.id },
          symbol: {
            type: "simple-marker",
            style: "path",
            // reverse water-drop look
            path:
              "M0,-14 C7,-14 12,-8 12,-1 C12,8 5,12 0,20 C-5,12 -12,8 -12,-1 C-12,-8 -7,-14 0,-14 Z",
            color,
            outline: {
              color: isSelected ? [255, 255, 255, 1] : [15, 23, 42, 0.9],
              width: isSelected ? 2.5 : 1.2,
            },
            size: isSelected ? 20 : 16,
          } as any,
          popupTemplate: {
            title: incident.title,
            content: `Status: ${incident.status}`,
          },
        })
      );
    }

    if (layer.graphics.length > 0) {
      view.goTo(layer.graphics).catch(() => {});
    }
  }, [incidents, selectedIncidentId]);

  return <div ref={mapElRef} style={{ width: "100%", height, borderRadius: 12, overflow: "hidden" }} />;
}

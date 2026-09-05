import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import esriConfig from "@arcgis/core/config";
import Map from "@arcgis/core/Map";
import MapView from "@arcgis/core/views/MapView";
import Graphic from "@arcgis/core/Graphic";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import Point from "@arcgis/core/geometry/Point";
import Multipoint from "@arcgis/core/geometry/Multipoint";
import Polygon from "@arcgis/core/geometry/Polygon";
import Polyline from "@arcgis/core/geometry/Polyline";
import Extent from "@arcgis/core/geometry/Extent";
import Home from "@arcgis/core/widgets/Home";
import Compass from "@arcgis/core/widgets/Compass";
import ScaleBar from "@arcgis/core/widgets/ScaleBar";
import Search from "@arcgis/core/widgets/Search";
import BasemapGallery from "@arcgis/core/widgets/BasemapGallery";
import LayerList from "@arcgis/core/widgets/LayerList";
import Expand from "@arcgis/core/widgets/Expand";

import { basemapForTheme, useThemeBasemap } from "../../components/mapTheme";
import { headingWedgeRing, PHOTO_HEADING_WEDGE_FILL_ALPHA, themeColor, withAlpha } from "../../components/photoEvidenceGraphics";
import type { IncidentClassification } from "../incidents/incidentClassification";
import { classificationLabel } from "../incidents/incidentClassification";
import type { ProjectDetailResponse, ProjectSummary } from "../projects/projectTypes";
import { projectLocationLabel } from "../projects/projectTypes";
import { cameraDirectionEndpoint, type MissionCenterIncidentGis, type MissionCenterMode } from "./missionCenterGisModel";

const CALIFORNIA_EXTENT = new Extent({
  xmin: -124.482003,
  ymin: 32.528832,
  xmax: -114.131211,
  ymax: 42.009518,
  spatialReference: { wkid: 4326 },
});

export type MissionCenterMapHandle = {
  /** Center on a mapped photo and open its popup. Returns false when the photo is not on the map. */
  focusPhoto: (attachmentId: number) => boolean;
};

type Props = {
  mode: MissionCenterMode;
  projects: ProjectSummary[];
  selectedProjectId: number | null;
  projectDetail: ProjectDetailResponse | null;
  selectedIncidentId: number | null;
  incidentGis: MissionCenterIncidentGis | null;
  classifications: Record<number, IncidentClassification>;
  onSelectProject: (projectId: number) => void;
  onSelectIncident: (incidentId: number) => void;
  height?: number | string;
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function statusProjectColor(status: string): [number, number, number, number] {
  if (status === "CLOSED") return [71, 85, 105, 0.92];
  if (status === "ARCHIVED") return [148, 163, 184, 0.78];
  return [30, 96, 255, 0.94];
}

function incidentColor(status: string): [number, number, number, number] {
  if (status === "RESOLVED") return [100, 116, 139, 0.92];
  if (status === "IN_PROGRESS") return [234, 88, 12, 0.96];
  return [211, 47, 47, 0.96];
}

function geoJsonToGraphics(geometry: Record<string, unknown> | null): Graphic[] {
  if (!geometry) return [];
  const type = String(geometry.type ?? "");
  const coordinates = geometry.coordinates as any;
  const symbol = {
    polygon: { type: "simple-fill", color: [30, 96, 255, 0.14], outline: { color: [30, 96, 255, 0.95], width: 2.5 } },
    line: { type: "simple-line", color: [30, 96, 255, 0.95], width: 3 },
    point: { type: "simple-marker", style: "circle", size: 10, color: [30, 96, 255, 0.95], outline: { color: [255, 255, 255, 1], width: 2 } },
  } as const;

  if (type === "Polygon" && Array.isArray(coordinates)) {
    return [new Graphic({ geometry: new Polygon({ rings: coordinates, spatialReference: { wkid: 4326 } }), symbol: symbol.polygon as any, attributes: { evidenceKind: "geometry" }, popupTemplate: { title: "Saved affected-area geometry", content: "Geometry captured with the linked technical submission." } as any })];
  }
  if (type === "MultiPolygon" && Array.isArray(coordinates)) {
    const rings = coordinates.flatMap((polygon: any) => Array.isArray(polygon) ? polygon : []);
    return [new Graphic({ geometry: new Polygon({ rings, spatialReference: { wkid: 4326 } }), symbol: symbol.polygon as any, attributes: { evidenceKind: "geometry" }, popupTemplate: { title: "Saved affected-area geometry", content: "Multi-part geometry captured with the linked technical submission." } as any })];
  }
  if (type === "LineString" && Array.isArray(coordinates)) {
    return [new Graphic({ geometry: new Polyline({ paths: [coordinates], spatialReference: { wkid: 4326 } }), symbol: symbol.line as any, attributes: { evidenceKind: "geometry" }, popupTemplate: { title: "Saved field geometry", content: "Line geometry captured with the linked technical submission." } as any })];
  }
  if (type === "MultiLineString" && Array.isArray(coordinates)) {
    return [new Graphic({ geometry: new Polyline({ paths: coordinates, spatialReference: { wkid: 4326 } }), symbol: symbol.line as any, attributes: { evidenceKind: "geometry" }, popupTemplate: { title: "Saved field geometry", content: "Multi-line geometry captured with the linked technical submission." } as any })];
  }
  if (type === "Point" && Array.isArray(coordinates) && coordinates.length >= 2) {
    return [new Graphic({ geometry: new Point({ longitude: Number(coordinates[0]), latitude: Number(coordinates[1]), spatialReference: { wkid: 4326 } }), symbol: symbol.point as any, attributes: { evidenceKind: "geometry" }, popupTemplate: { title: "Saved field point" } as any })];
  }
  if (type === "MultiPoint" && Array.isArray(coordinates)) {
    return [new Graphic({ geometry: new Multipoint({ points: coordinates, spatialReference: { wkid: 4326 } }), symbol: symbol.point as any, attributes: { evidenceKind: "geometry" }, popupTemplate: { title: "Saved field points" } as any })];
  }
  if (type === "GeometryCollection" && Array.isArray(geometry.geometries)) {
    return (geometry.geometries as Record<string, unknown>[]).flatMap((item) => geoJsonToGraphics(item));
  }
  return [];
}

/**
 * Three-level GIS drill: statewide Event Groups → a group's incidents → one incident's
 * saved geometry and field photos with camera-heading wedges. Theme-aware basemap and
 * an imperative `focusPhoto` so the evidence list can drive the map.
 */
const MissionCenterProjectGisMap = forwardRef<MissionCenterMapHandle, Props>(function MissionCenterProjectGisMap({
  mode,
  projects,
  selectedProjectId,
  projectDetail,
  selectedIncidentId,
  incidentGis,
  classifications,
  onSelectProject,
  onSelectIncident,
  height = 650,
}, ref) {
  const divRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<MapView | null>(null);
  const projectLayerRef = useRef<GraphicsLayer | null>(null);
  const incidentLayerRef = useRef<GraphicsLayer | null>(null);
  const geometryLayerRef = useRef<GraphicsLayer | null>(null);
  const photoLayerRef = useRef<GraphicsLayer | null>(null);
  const directionLayerRef = useRef<GraphicsLayer | null>(null);
  const onSelectProjectRef = useRef(onSelectProject);
  const onSelectIncidentRef = useRef(onSelectIncident);
  const modeRef = useRef(mode);
  const apiKey = String((import.meta as any)?.env?.VITE_ARCGIS_API_KEY ?? "");

  useEffect(() => { onSelectProjectRef.current = onSelectProject; }, [onSelectProject]);
  useEffect(() => { onSelectIncidentRef.current = onSelectIncident; }, [onSelectIncident]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useThemeBasemap(viewRef, !!apiKey);

  useImperativeHandle(ref, () => ({
    focusPhoto(attachmentId: number) {
      const view = viewRef.current;
      const layer = photoLayerRef.current;
      if (!view || !layer) return false;
      const graphic = layer.graphics.find((item) => Number(item.attributes?.photoId) === attachmentId);
      if (!graphic) return false;
      view.goTo({ target: graphic.geometry, zoom: Math.max(view.zoom, 17) }).catch(() => {});
      try {
        view.openPopup({ features: [graphic], location: graphic.geometry as any });
      } catch {
        // Popup is a convenience; centering already happened.
      }
      return true;
    },
  }), []);

  useEffect(() => {
    esriConfig.assetsPath = "/assets";
    if (apiKey) esriConfig.apiKey = apiKey;
    if (!divRef.current) return;

    const projectLayer = new GraphicsLayer({ title: "Event Groups" });
    const incidentLayer = new GraphicsLayer({ title: "Event Group incidents" });
    const geometryLayer = new GraphicsLayer({ title: "Saved incident geometry" });
    const directionLayer = new GraphicsLayer({ title: "Camera headings" });
    const photoLayer = new GraphicsLayer({ title: "Field photos" });
    projectLayerRef.current = projectLayer;
    incidentLayerRef.current = incidentLayer;
    geometryLayerRef.current = geometryLayer;
    directionLayerRef.current = directionLayer;
    photoLayerRef.current = photoLayer;

    const map = new Map({ basemap: basemapForTheme(!!apiKey), layers: [projectLayer, incidentLayer, geometryLayer, directionLayer, photoLayer] });
    const view = new MapView({
      container: divRef.current,
      map,
      extent: CALIFORNIA_EXTENT.clone(),
      constraints: { geometry: CALIFORNIA_EXTENT, minZoom: 5, snapToZoom: false },
      popup: { dockEnabled: false } as any,
    });

    view.ui.add(new Home({ view }), "top-left");
    view.ui.add(new Compass({ view }), "top-left");
    view.ui.add(new ScaleBar({ view, unit: "dual" }), "bottom-left");
    const search = new Search({ view });
    const basemaps = new BasemapGallery({ view });
    const layers = new LayerList({ view });
    view.ui.add(new Expand({ view, content: search, expandTooltip: "Search map" }), "top-right");
    view.ui.add(new Expand({ view, content: basemaps, expandTooltip: "Basemaps" }), "top-right");
    view.ui.add(new Expand({ view, content: layers, expandTooltip: "GIS layers" }), "top-right");

    const clickHandle = view.on("click", async (event) => {
      try {
        const hit = await view.hitTest(event);
        const results = hit.results as any[];
        if (modeRef.current === "PROJECTS") {
          const result = results.find((item) => item?.graphic?.attributes?.projectId != null);
          const projectId = Number(result?.graphic?.attributes?.projectId);
          if (Number.isFinite(projectId) && projectId > 0) onSelectProjectRef.current(projectId);
          return;
        }
        if (modeRef.current === "PROJECT") {
          const result = results.find((item) => item?.graphic?.attributes?.incidentId != null);
          const incidentId = Number(result?.graphic?.attributes?.incidentId);
          if (Number.isFinite(incidentId) && incidentId > 0) onSelectIncidentRef.current(incidentId);
        }
      } catch {
        // Tables/cards remain accessible navigation fallbacks.
      }
    });

    viewRef.current = view;
    return () => {
      clickHandle.remove();
      view.destroy();
      viewRef.current = null;
      projectLayerRef.current = null;
      incidentLayerRef.current = null;
      geometryLayerRef.current = null;
      directionLayerRef.current = null;
      photoLayerRef.current = null;
    };
  }, [apiKey]);

  useEffect(() => {
    const layer = projectLayerRef.current;
    const view = viewRef.current;
    if (!layer || !view) return;
    layer.removeAll();
    if (mode !== "PROJECTS") return;

    const graphics = projects.map((project) => {
      const selected = selectedProjectId === project.id;
      return new Graphic({
        geometry: new Point({ longitude: project.centroid_longitude, latitude: project.centroid_latitude, spatialReference: { wkid: 4326 } }),
        attributes: {
          projectId: project.id,
          title: project.title,
          status: project.status,
          location: projectLocationLabel(project),
          incidents: project.incident_count,
          active: project.open_incident_count,
        },
        symbol: {
          type: "simple-marker",
          style: "circle",
          size: selected ? 18 : project.open_incident_count > 0 ? 14 : 11,
          color: statusProjectColor(project.status),
          outline: { color: selected ? [255, 255, 255, 1] : [15, 23, 42, 0.9], width: selected ? 3 : 1.5 },
        } as any,
        popupTemplate: {
          title: "Event Group #{projectId} · {title}",
          content: "<strong>Status:</strong> {status}<br/><strong>Location:</strong> {location}<br/><strong>Incidents:</strong> {incidents}<br/><strong>Active:</strong> {active}<br/><br/>Click the marker to inspect this Event Group.",
        } as any,
      });
    });
    layer.addMany(graphics);
    view.goTo(CALIFORNIA_EXTENT, { duration: 0 }).catch(() => {});
  }, [mode, projects, selectedProjectId]);

  useEffect(() => {
    const layer = incidentLayerRef.current;
    const view = viewRef.current;
    if (!layer || !view) return;
    layer.removeAll();
    if (!projectDetail || mode === "PROJECTS") return;

    const visibleIncidents = mode === "INCIDENT"
      ? projectDetail.incidents.filter((incident) => incident.id === selectedIncidentId)
      : projectDetail.incidents;

    const graphics = visibleIncidents.map((incident) => {
      const classification = classifications[incident.id];
      const selected = selectedIncidentId === incident.id;
      return new Graphic({
        geometry: new Point({ longitude: incident.longitude, latitude: incident.latitude, spatialReference: { wkid: 4326 } }),
        attributes: {
          incidentId: incident.id,
          title: incident.title || `Incident #${incident.id}`,
          status: incident.status,
          classification: classificationLabel(classification),
          location: projectLocationLabel({ district: incident.district, county: incident.county, route: incident.route, post_mile: incident.post_mile }),
        },
        symbol: {
          type: "simple-marker",
          style: incident.status === "RESOLVED" ? "circle" : "diamond",
          size: selected ? 17 : incident.status === "RESOLVED" ? 10 : 13,
          color: incidentColor(incident.status),
          outline: { color: [255, 255, 255, 1], width: selected ? 3 : 2 },
        } as any,
        popupTemplate: {
          title: "Incident #{incidentId} · {title}",
          content: "<strong>Status:</strong> {status}<br/><strong>Classification:</strong> {classification}<br/><strong>Location:</strong> {location}<br/><br/>Click the marker to inspect GIS evidence.",
        } as any,
      });
    });
    layer.addMany(graphics);

    if (mode === "PROJECT") {
      if (graphics.length > 0) view.goTo(graphics, { duration: 0 }).catch(() => {});
      else view.goTo({ center: [projectDetail.project.centroid_longitude, projectDetail.project.centroid_latitude], zoom: 13 }, { duration: 0 }).catch(() => {});
    }
  }, [classifications, mode, projectDetail, selectedIncidentId]);

  useEffect(() => {
    const geometryLayer = geometryLayerRef.current;
    const photoLayer = photoLayerRef.current;
    const directionLayer = directionLayerRef.current;
    const incidentLayer = incidentLayerRef.current;
    const view = viewRef.current;
    if (!geometryLayer || !photoLayer || !directionLayer || !view) return;

    geometryLayer.removeAll();
    photoLayer.removeAll();
    directionLayer.removeAll();
    if (mode !== "INCIDENT" || !incidentGis) return;

    const geometryGraphics = geoJsonToGraphics(incidentGis.geometry);
    geometryLayer.addMany(geometryGraphics);
    const accent = themeColor("--accent", [23, 180, 173]);

    for (const photo of incidentGis.photos) {
      if (photo.latitude == null || photo.longitude == null) continue;
      const popupImage = photo.mime_type.toLowerCase().startsWith("image/")
        ? `<div style="margin-top:8px"><img src="${escapeHtml(photo.download_url)}" alt="${escapeHtml(photo.file_name)}" style="display:block;max-width:320px;max-height:220px;object-fit:contain;border-radius:6px" /></div>`
        : "";
      const popupTemplate = {
        title: escapeHtml(photo.file_name),
        content: `<strong>Field photo</strong><br/>${photo.captured_at ? `Captured: ${escapeHtml(photo.captured_at)}<br/>` : ""}${photo.camera_heading_deg != null ? `Camera heading: ${photo.camera_heading_deg.toFixed(1)}°<br/>` : ""}${popupImage}<div style="margin-top:8px"><a href="${escapeHtml(photo.download_url)}" target="_blank" rel="noreferrer">Open original</a></div>`,
      } as any;

      if (photo.camera_heading_deg != null) {
        // Camera-heading wedge (same geometry as the submission evidence map).
        directionLayer.add(new Graphic({
          geometry: new Polygon({ rings: [headingWedgeRing(photo.latitude, photo.longitude, photo.camera_heading_deg)], spatialReference: { wkid: 4326 } }),
          attributes: { photoId: photo.attachment_id, wedge: true },
          symbol: { type: "simple-fill", color: withAlpha(accent, PHOTO_HEADING_WEDGE_FILL_ALPHA), outline: { color: withAlpha(accent, 0.85), width: 1 } } as any,
          popupTemplate,
        }));
        const end = cameraDirectionEndpoint(photo.latitude, photo.longitude, photo.camera_heading_deg, 60);
        directionLayer.add(new Graphic({
          geometry: new Point({ longitude: end.longitude, latitude: end.latitude, spatialReference: { wkid: 4326 } }),
          attributes: { photoId: photo.attachment_id },
          symbol: { type: "simple-marker", style: "triangle", size: 9, angle: photo.camera_heading_deg, color: withAlpha(accent, 0.95), outline: { color: [255, 255, 255, 1], width: 1 } } as any,
        }));
      }

      photoLayer.add(new Graphic({
        geometry: new Point({ longitude: photo.longitude, latitude: photo.latitude, spatialReference: { wkid: 4326 } }),
        attributes: { photoId: photo.attachment_id, fileName: photo.file_name },
        symbol: { type: "simple-marker", style: "circle", size: 11, color: withAlpha(accent, 0.98), outline: { color: [255, 255, 255, 1], width: 2 } } as any,
        popupTemplate,
      }));
    }

    const allGraphics = [
      ...(incidentLayer?.graphics.toArray() ?? []),
      ...geometryGraphics,
      ...photoLayer.graphics.toArray(),
      ...directionLayer.graphics.toArray(),
    ];
    if (allGraphics.length > 1) {
      view.goTo(allGraphics, { duration: 0 }).catch(() => {});
    } else {
      view.goTo({ center: [incidentGis.incident.longitude, incidentGis.incident.latitude], zoom: 17 }, { duration: 0 }).catch(() => {});
    }
  }, [incidentGis, mode]);

  return (
    <div className="map-stack-guard overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel-soft)]">
      <div ref={divRef} style={{ height }} aria-label="Mission Center Event Group and Incident GIS explorer" />
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-xs text-muted">
        {mode === "PROJECTS" ? <><span className="inline-flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-[rgb(30,96,255)]" /> Event Group</span><span>Marker size reflects active Incident activity.</span></> : null}
        {mode === "PROJECT" ? <><span className="inline-flex items-center gap-2"><span className="h-3 w-3 rotate-45 rounded-[2px] bg-[rgb(211,47,47)]" /> Active Incident</span><span className="inline-flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-[rgb(100,116,139)]" /> Resolved Incident</span></> : null}
        {mode === "INCIDENT" ? <><span className="inline-flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-[var(--accent)]" /> Field photo</span><span className="inline-flex items-center gap-2"><span className="inline-block h-3 w-4 rounded-r-full bg-[var(--accent)] opacity-40" /> Camera heading</span><span className="inline-flex items-center gap-2"><span className="h-3 w-5 border-2 border-[rgb(30,96,255)] bg-[rgba(30,96,255,0.15)]" /> Saved geometry</span></> : null}
      </div>
    </div>
  );
});

export default MissionCenterProjectGisMap;

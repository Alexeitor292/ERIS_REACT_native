import { useEffect, useRef, useState } from "react";
import Map from "@arcgis/core/Map";
import MapView from "@arcgis/core/views/MapView";
import SceneView from "@arcgis/core/views/SceneView";
import Graphic from "@arcgis/core/Graphic";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import Mesh from "@arcgis/core/geometry/Mesh";
import MeshTexture from "@arcgis/core/geometry/support/MeshTexture";
import Multipoint from "@arcgis/core/geometry/Multipoint";
import Extent from "@arcgis/core/geometry/Extent";
import SpatialReference from "@arcgis/core/geometry/SpatialReference";
import * as reactiveUtils from "@arcgis/core/core/reactiveUtils";

import {
  formatElevation,
  formatHorizontalDistance,
  type CrossSectionProfile,
} from "./terrainCrossSectionModel";
import {
  buildTerrainSliceSamplingGrid,
  terrainSliceFromSampledPoints,
  type TerrainSliceData,
} from "./terrainSliceModel";

const WGS84 = SpatialReference.WGS84;
const DEFAULT_WIDTH_M = 100;
const WEB_MERCATOR_RADIUS_M = 6_378_137;

type SliceSurfaceMode = "satellite" | "topographic" | "bare";

type SliceTexture = {
  image: ImageData;
  extent: { xmin: number; ymin: number; xmax: number; ymax: number };
};

function vertexIndex(row: number, column: number, columns: number) {
  return row * columns + column;
}

function webMercatorXY(longitude: number, latitude: number) {
  const lonRad = longitude * Math.PI / 180;
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const latRad = clampedLat * Math.PI / 180;
  return {
    x: WEB_MERCATOR_RADIUS_M * lonRad,
    y: WEB_MERCATOR_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + latRad / 2)),
  };
}

function buildTextureUv(data: TerrainSliceData, texture: SliceTexture | null) {
  const uv: number[] = [];
  const extent = texture?.extent;

  for (let copy = 0; copy < 2; copy += 1) {
    for (const point of data.points) {
      if (!extent) {
        uv.push(0, 0);
        continue;
      }
      const projected = webMercatorXY(point.longitude, point.latitude);
      const width = Math.max(1, extent.xmax - extent.xmin);
      const height = Math.max(1, extent.ymax - extent.ymin);
      uv.push(
        Math.max(0, Math.min(1, (projected.x - extent.xmin) / width)),
        Math.max(0, Math.min(1, (projected.y - extent.ymin) / height)),
      );
    }
  }

  return uv;
}

function buildTerrainMesh(data: TerrainSliceData, texture: SliceTexture | null) {
  const topCount = data.rows * data.columns;
  const position: number[] = [];

  for (const point of data.points) {
    position.push(point.longitude, point.latitude, point.elevation_m);
  }
  for (const point of data.points) {
    position.push(point.longitude, point.latitude, data.base_elevation_m);
  }

  const topFaces: number[] = [];
  const bottomFaces: number[] = [];
  const sideFaces: number[] = [];

  for (let row = 0; row < data.rows - 1; row += 1) {
    for (let column = 0; column < data.columns - 1; column += 1) {
      const a = vertexIndex(row, column, data.columns);
      const b = vertexIndex(row, column + 1, data.columns);
      const c = vertexIndex(row + 1, column, data.columns);
      const d = vertexIndex(row + 1, column + 1, data.columns);
      topFaces.push(a, c, b, b, c, d);

      const A = a + topCount;
      const B = b + topCount;
      const C = c + topCount;
      const D = d + topCount;
      bottomFaces.push(A, B, C, B, D, C);
    }
  }

  function addWall(topA: number, topB: number) {
    const bottomA = topA + topCount;
    const bottomB = topB + topCount;
    sideFaces.push(topA, bottomA, topB, topB, bottomA, bottomB);
  }

  for (let row = 0; row < data.rows - 1; row += 1) {
    addWall(vertexIndex(row, 0, data.columns), vertexIndex(row + 1, 0, data.columns));
    addWall(
      vertexIndex(row + 1, data.columns - 1, data.columns),
      vertexIndex(row, data.columns - 1, data.columns),
    );
  }

  for (let column = 0; column < data.columns - 1; column += 1) {
    addWall(vertexIndex(0, column + 1, data.columns), vertexIndex(0, column, data.columns));
    addWall(
      vertexIndex(data.rows - 1, column, data.columns),
      vertexIndex(data.rows - 1, column + 1, data.columns),
    );
  }

  const topMaterial = texture
    ? {
        color: [255, 255, 255, 1],
        colorTexture: new MeshTexture({ data: texture.image }),
      }
    : { color: [146, 168, 125, 1] };

  return new Mesh({
    spatialReference: WGS84,
    vertexAttributes: {
      position,
      uv: buildTextureUv(data, texture),
    },
    components: [
      {
        faces: topFaces,
        material: topMaterial,
        shading: "smooth",
      },
      {
        faces: sideFaces,
        material: { color: [118, 88, 60, 1] },
        shading: "flat",
      },
      {
        faces: bottomFaces,
        material: { color: [76, 58, 43, 1] },
        shading: "flat",
      },
    ],
  });
}

async function renderBasemapTexture(data: TerrainSliceData, mode: Exclude<SliceSurfaceMode, "bare">): Promise<SliceTexture> {
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.position = "fixed";
  host.style.left = "-12000px";
  host.style.top = "0";
  host.style.width = "1024px";
  host.style.height = "768px";
  host.style.pointerEvents = "none";
  document.body.appendChild(host);

  const map = new Map({ basemap: mode === "satellite" ? "satellite" : "topo-vector" });
  const view = new MapView({ container: host, map });

  try {
    const longitudes = data.points.map((point) => point.longitude);
    const latitudes = data.points.map((point) => point.latitude);
    const xmin = Math.min(...longitudes);
    const xmax = Math.max(...longitudes);
    const ymin = Math.min(...latitudes);
    const ymax = Math.max(...latitudes);
    const lonPad = Math.max((xmax - xmin) * 0.04, 0.00005);
    const latPad = Math.max((ymax - ymin) * 0.04, 0.00005);

    await view.when();
    await view.goTo(new Extent({
      xmin: xmin - lonPad,
      ymin: ymin - latPad,
      xmax: xmax + lonPad,
      ymax: ymax + latPad,
      spatialReference: WGS84,
    }), { animate: false });
    await reactiveUtils.whenOnce(() => !view.updating);

    const screenshot = await view.takeScreenshot({ width: 1024, height: 768 });
    const extent = view.extent;
    if (!extent) throw new Error("ArcGIS basemap texture extent was unavailable.");

    return {
      image: screenshot.data,
      extent: {
        xmin: extent.xmin,
        ymin: extent.ymin,
        xmax: extent.xmax,
        ymax: extent.ymax,
      },
    };
  } finally {
    view.destroy();
    host.remove();
  }
}

function TerrainSliceScene({
  data,
  surfaceMode,
}: {
  data: TerrainSliceData;
  surfaceMode: SliceSurfaceMode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const requestIdRef = useRef(0);
  const [texture, setTexture] = useState<SliceTexture | null>(null);
  const [textureBusy, setTextureBusy] = useState(surfaceMode !== "bare");
  const [textureError, setTextureError] = useState<string | null>(null);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    setTextureError(null);

    if (surfaceMode === "bare") {
      setTexture(null);
      setTextureBusy(false);
      return;
    }

    setTexture(null);
    setTextureBusy(true);
    void renderBasemapTexture(data, surfaceMode)
      .then((nextTexture) => {
        if (requestId !== requestIdRef.current) return;
        setTexture(nextTexture);
      })
      .catch((reason: unknown) => {
        if (requestId !== requestIdRef.current) return;
        setTextureError(reason instanceof Error ? reason.message : "Failed to render the ArcGIS basemap texture.");
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setTextureBusy(false);
      });
  }, [data, surfaceMode]);

  useEffect(() => {
    if (!containerRef.current) return;
    if (surfaceMode !== "bare" && !texture && !textureError) return;

    const layer = new GraphicsLayer({ title: "Terrain slice" });
    const map = new Map({ layers: [layer] });
    const view = new SceneView({
      container: containerRef.current,
      map,
      qualityProfile: "high",
      environment: {
        atmosphereEnabled: false,
        starsEnabled: false,
        background: { type: "color", color: [15, 23, 42, 1] },
      } as never,
    });

    const mesh = buildTerrainMesh(data, texture);
    layer.add(new Graphic({
      geometry: mesh,
      symbol: {
        type: "mesh-3d",
        symbolLayers: [
          {
            type: "fill",
            edges: { type: "solid", color: [255, 255, 255, 0.16], size: 0.5 },
          },
        ],
      } as never,
    }));

    let disposed = false;
    view.when(() => {
      if (disposed) return;
      view.ui.components = ["zoom", "compass"];
      const extent = mesh.extent;
      if (extent) {
        view.goTo({ target: extent.expand(1.35), tilt: 67, heading: 315 }, { animate: false }).catch(() => {});
      }
    }).catch(() => {});

    return () => {
      disposed = true;
      view.destroy();
    };
  }, [data, surfaceMode, texture, textureError]);

  const surfaceLabel = surfaceMode === "satellite"
    ? "Satellite imagery"
    : surfaceMode === "topographic"
      ? "Topographic"
      : "Bare DEM";

  return (
    <div className="relative overflow-hidden rounded-lg border border-[var(--line)] bg-slate-950">
      <div ref={containerRef} className="h-[430px] w-full" aria-label="Interactive 3D terrain slice" />

      {textureBusy ? (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950/75 text-sm text-white/80 backdrop-blur-sm">
          Draping {surfaceLabel.toLowerCase()} onto the DEM…
        </div>
      ) : null}

      {textureError ? (
        <div className="absolute left-3 right-3 top-3 rounded-lg border border-amber-300/40 bg-amber-950/85 px-3 py-2 text-xs text-amber-50 shadow-lg backdrop-blur-sm">
          {textureError} Showing the bare DEM surface instead.
        </div>
      ) : null}

      <div className="border-t border-white/10 bg-slate-950 px-3 py-2 text-[11px] text-white/65">
        Drag to orbit · Scroll to zoom · 1× vertical scale · Surface: {surfaceLabel}
        {surfaceMode !== "bare" ? " · ArcGIS basemap content © Esri and contributors" : ""}
      </div>
    </div>
  );
}

export default function TerrainSlice3D({
  profile,
  metric,
}: {
  profile: CrossSectionProfile;
  metric: boolean;
}) {
  const queryMapRef = useRef<Map | null>(null);
  const requestIdRef = useRef(0);
  const [widthM, setWidthM] = useState(DEFAULT_WIDTH_M);
  const [surfaceMode, setSurfaceMode] = useState<SliceSurfaceMode>("satellite");
  const [data, setData] = useState<TerrainSliceData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    const grid = buildTerrainSliceSamplingGrid(profile, widthM);
    setBusy(true);
    setError(null);

    const timer = window.setTimeout(async () => {
      try {
        let queryMap = queryMapRef.current;
        if (!queryMap) {
          queryMap = new Map({ ground: "world-elevation" });
          queryMapRef.current = queryMap;
        }
        await queryMap.ground.loadAll();

        const multipoint = new Multipoint({
          points: grid.points.map((point) => [point.longitude, point.latitude]),
          spatialReference: WGS84,
        });
        const elevation = await queryMap.ground.queryElevation(multipoint, {
          demResolution: "auto",
          returnSampleInfo: true,
        });
        if (requestId !== requestIdRef.current) return;

        const sampled = elevation.geometry as Multipoint;
        const next = terrainSliceFromSampledPoints(grid, sampled.points ?? [], elevation.noDataValue);
        setData(next);
      } catch (reason: unknown) {
        if (requestId !== requestIdRef.current) return;
        setData(null);
        setError(reason instanceof Error ? reason.message : "Failed to sample the ArcGIS terrain slice.");
      } finally {
        if (requestId === requestIdRef.current) setBusy(false);
      }
    }, 350);

    return () => {
      window.clearTimeout(timer);
    };
  }, [profile, widthM]);

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Slice width</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">{formatHorizontalDistance(widthM, metric)}</div>
          </div>
          <div className="text-right text-xs text-muted">
            Total corridor width<br />centered on the selected path
          </div>
        </div>
        <input
          type="range"
          min={20}
          max={1000}
          step={10}
          value={widthM}
          onChange={(event) => setWidthM(Number(event.target.value))}
          className="mt-3 w-full"
          aria-label="Terrain slice width"
        />
        <div className="mt-2 flex flex-wrap gap-2">
          {[50, 100, 250, 500].map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setWidthM(preset)}
              className={`rounded-md border px-2.5 py-1.5 text-xs font-semibold ${widthM === preset
                ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_10%,transparent)] text-[var(--brand)]"
                : "border-[var(--line)] bg-[var(--panel)] hover:bg-[var(--panel-soft)]"}`}
            >
              {formatHorizontalDistance(preset, metric)}
            </button>
          ))}
        </div>

        <div className="mt-4 border-t border-[var(--line)] pt-3">
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Surface layer</div>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {([
              ["satellite", "Satellite"],
              ["topographic", "Topographic"],
              ["bare", "Bare DEM"],
            ] as Array<[SliceSurfaceMode, string]>).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setSurfaceMode(mode)}
                className={`rounded-md border px-2.5 py-2 text-xs font-semibold ${surfaceMode === mode
                  ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_10%,transparent)] text-[var(--brand)]"
                  : "border-[var(--line)] bg-[var(--panel)] hover:bg-[var(--panel-soft)]"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="mt-2 text-[11px] leading-5 text-muted">
            Imagery and topographic cartography are rendered from ArcGIS and draped directly onto the sampled 3D DEM surface. Cut faces and the base remain visually distinct.
          </div>
        </div>
      </div>

      {busy ? (
        <div className="flex h-[430px] items-center justify-center rounded-lg border border-[var(--line)] bg-slate-950 text-sm text-white/75">
          Sampling the DEM across the {formatHorizontalDistance(widthM, metric)} slice…
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="rounded-lg border border-red-300/50 bg-red-950/80 px-3 py-3 text-sm text-red-50">
          {error}
        </div>
      ) : null}

      {!busy && data ? (
        <>
          <TerrainSliceScene data={data} surfaceMode={surfaceMode} />
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--line)] sm:grid-cols-4">
            <SliceStat label="Highest terrain" value={formatElevation(data.max_elevation_m, metric)} />
            <SliceStat label="Lowest terrain" value={formatElevation(data.min_elevation_m, metric)} />
            <SliceStat label="Terrain range" value={formatElevation(data.elevation_range_m, metric)} />
            <SliceStat label="Cut base" value={formatElevation(data.base_elevation_m, metric)} />
          </div>
          <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2 text-xs leading-5 text-muted">
            ERIS samples a two-dimensional ArcGIS DEM grid across the full corridor width. The bottom plane is automatically placed below the lowest sampled terrain so the complete relief between the highest and lowest points remains visible.
          </div>
        </>
      ) : null}
    </div>
  );
}

function SliceStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[var(--panel)] p-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{label}</div>
      <div className="mt-1 text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

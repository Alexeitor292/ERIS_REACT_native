import { useEffect, useRef } from "react";
import Map from "@arcgis/core/Map";
import SceneView from "@arcgis/core/views/SceneView";
import Graphic from "@arcgis/core/Graphic";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import Mesh from "@arcgis/core/geometry/Mesh";
import SpatialReference from "@arcgis/core/geometry/SpatialReference";

import type { TerrainSliceData } from "./terrainSliceModel";

const WGS84 = SpatialReference.WGS84;

function vertexIndex(row: number, column: number, columns: number) {
  return row * columns + column;
}

function buildTerrainMesh(data: TerrainSliceData) {
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

  return new Mesh({
    spatialReference: WGS84,
    vertexAttributes: { position },
    components: [
      {
        faces: topFaces,
        material: { color: [146, 168, 125, 1] },
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

export default function TerrainSlice3D({ data }: { data: TerrainSliceData }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

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

    const mesh = buildTerrainMesh(data);
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
  }, [data]);

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--line)] bg-slate-950">
      <div ref={containerRef} className="h-[430px] w-full" aria-label="Interactive 3D terrain slice" />
      <div className="border-t border-white/10 bg-slate-950 px-3 py-2 text-[11px] text-white/65">
        Drag to orbit · Scroll to zoom · Terrain surface is shown at 1× vertical scale
      </div>
    </div>
  );
}

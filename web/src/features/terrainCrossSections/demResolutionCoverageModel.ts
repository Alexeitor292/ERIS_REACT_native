export type DemCoverageClassId =
  | "lte-1m"
  | "gt-1-lt-5m"
  | "gte-5-lt-10m"
  | "10m"
  | "25-30m"
  | "50-90m"
  | "gte-150m";

export type DemCoverageSource = {
  layerId: number;
  sourceLabel: string;
  definitionExpression?: string;
};

export type DemCoverageClass = {
  id: DemCoverageClassId;
  label: string;
  cssColor: string;
  rgb: readonly [number, number, number];
  sources: readonly DemCoverageSource[];
};

export const DEM_COVERAGE_CLASSES: readonly DemCoverageClass[] = [
  {
    id: "lte-1m",
    label: "≤ 1 m",
    cssColor: "#22c55e",
    rgb: [34, 197, 94],
    sources: [{ layerId: 1, sourceLabel: "1 m or better", definitionExpression: "PixelSize <= 1" }],
  },
  {
    id: "gt-1-lt-5m",
    label: "> 1 m to < 5 m",
    cssColor: "#14b8a6",
    rgb: [20, 184, 166],
    sources: [{ layerId: 2, sourceLabel: "2–6 m", definitionExpression: "PixelSize > 1 AND PixelSize < 5" }],
  },
  {
    id: "gte-5-lt-10m",
    label: "5 m to < 10 m",
    cssColor: "#0ea5e9",
    rgb: [14, 165, 233],
    sources: [{ layerId: 2, sourceLabel: "2–6 m", definitionExpression: "PixelSize >= 5 AND PixelSize < 10" }],
  },
  {
    id: "10m",
    label: "10 m",
    cssColor: "#6366f1",
    rgb: [99, 102, 241],
    sources: [{ layerId: 3, sourceLabel: "10 m" }],
  },
  {
    id: "25-30m",
    label: "25–30 m",
    cssColor: "#a855f7",
    rgb: [168, 85, 247],
    sources: [
      { layerId: 4, sourceLabel: "25 m" },
      { layerId: 5, sourceLabel: "30 m" },
    ],
  },
  {
    id: "50-90m",
    label: "50–90 m",
    cssColor: "#f59e0b",
    rgb: [245, 158, 11],
    sources: [
      { layerId: 6, sourceLabel: "50–60 m" },
      { layerId: 7, sourceLabel: "90 m" },
    ],
  },
  {
    id: "gte-150m",
    label: "≥ 150 m",
    cssColor: "#ef4444",
    rgb: [239, 68, 68],
    sources: [
      { layerId: 8, sourceLabel: "150 m" },
      { layerId: 9, sourceLabel: "250 m" },
      { layerId: 10, sourceLabel: "500 m" },
      { layerId: 11, sourceLabel: "1000 m" },
    ],
  },
];

export const DEM_COVERAGE_LEGEND = DEM_COVERAGE_CLASSES.map(({ id, label, cssColor }) => ({
  id,
  label,
  cssColor,
}));

export function demCoverageClassForPixelSize(pixelSizeM: number): DemCoverageClassId | null {
  if (!Number.isFinite(pixelSizeM) || pixelSizeM <= 0) return null;
  if (pixelSizeM <= 1) return "lte-1m";
  if (pixelSizeM < 5) return "gt-1-lt-5m";
  if (pixelSizeM < 10) return "gte-5-lt-10m";
  if (pixelSizeM === 10) return "10m";
  if (pixelSizeM >= 25 && pixelSizeM <= 30) return "25-30m";
  if (pixelSizeM >= 50 && pixelSizeM <= 90) return "50-90m";
  if (pixelSizeM >= 150) return "gte-150m";
  return null;
}

export type ScaleBarLine = {
  widthPx: number;
  label: string;
};

export type DualScaleBar = {
  metric: ScaleBarLine;
  imperial: ScaleBarLine;
};

const CSS_DPI = 96;
const METERS_PER_INCH = 0.0254;
const FEET_PER_METER = 3.280839895;

function niceFloor(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const exponent = Math.floor(Math.log10(value));
  const magnitude = 10 ** exponent;
  const normalized = value / magnitude;
  const factor = normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1;
  return factor * magnitude;
}

function formatNumber(value: number): string {
  if (value >= 100) return Math.round(value).toLocaleString();
  if (value >= 10) return value.toFixed(value % 1 === 0 ? 0 : 1);
  return value.toFixed(value % 1 === 0 ? 0 : 2).replace(/0+$/, "").replace(/\.$/, "");
}

export function dualScaleBarForSceneScale(scale: number | null | undefined, targetWidthPx = 150): DualScaleBar | null {
  if (!Number.isFinite(scale) || (scale as number) <= 0 || targetWidthPx <= 0) return null;

  // ArcGIS view.scale is the representative fraction at the center of the view.
  // Convert one CSS pixel to ground distance using the SDK/browser 96-DPI scale
  // convention. In SceneView this is intentionally a center-screen reference.
  const metersPerPixel = (scale as number) * METERS_PER_INCH / CSS_DPI;
  const maxMeters = metersPerPixel * targetWidthPx;

  const metricMeters = niceFloor(maxMeters);
  const metricWidthPx = metricMeters / metersPerPixel;
  const metricLabel = metricMeters >= 1000
    ? `${formatNumber(metricMeters / 1000)} km`
    : `${formatNumber(metricMeters)} m`;

  const feetPerPixel = metersPerPixel * FEET_PER_METER;
  const maxFeet = feetPerPixel * targetWidthPx;
  const imperialFeet = niceFloor(maxFeet);
  const imperialLabel = `${formatNumber(imperialFeet)} ft`;

  return {
    metric: { widthPx: metricWidthPx, label: metricLabel },
    imperial: { widthPx: imperialFeet / feetPerPixel, label: imperialLabel },
  };
}

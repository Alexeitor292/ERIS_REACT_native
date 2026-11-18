import { useEffect, useState } from "react";
import Map from "@arcgis/core/Map";
import MapView from "@arcgis/core/views/MapView";
import Graphic from "@arcgis/core/Graphic";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import MapImageLayer from "@arcgis/core/layers/MapImageLayer";
import Extent from "@arcgis/core/geometry/Extent";
import Point from "@arcgis/core/geometry/Point";
import Polyline from "@arcgis/core/geometry/Polyline";
import SpatialReference from "@arcgis/core/geometry/SpatialReference";
import * as reactiveUtils from "@arcgis/core/core/reactiveUtils";

import { distanceMeters, type CrossSectionControlPoint } from "./terrainCrossSectionModel";

const WGS84 = SpatialReference.WGS84;
const CAPTURE_MARGIN_PX = 40;
const FEET_PER_METER = 3.280839895;
const USGS_CONTOURS_URL = "https://carto.nationalmap.gov/arcgis/rest/services/contours/MapServer";

type CaptureRatio = "1:1" | "16:9" | "9:16";
type CaptureBasemap = "satellite" | "contours";

const CAPTURE_BASEMAPS = {
  satellite: {
    label: "Satellite",
    attribution: "Powered by Esri. Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community",
    filename: "aerial",
  },
  contours: {
    label: "Contours",
    attribution: "Source: USGS The National Map · 3D Elevation Program (3DEP)",
    filename: "contours",
  },
} satisfies Record<CaptureBasemap, { label: string; attribution: string; filename: string }>;

type CaptureSettings = {
  points: CrossSectionControlPoint[];
  ratio: CaptureRatio;
  basemap: CaptureBasemap;
};

type CaptureImage = { jpeg: Blob; png: Blob; previewUrl: string };
type CaptureResult = CaptureSettings & (
  | { image: CaptureImage; error?: never }
  | { image?: never; error: string }
);

type CapturePreset = {
  width: number;
  height: number;
  label: string;
};

const CAPTURE_PRESETS: Record<CaptureRatio, CapturePreset> = {
  "1:1": { width: 1400, height: 1400, label: "1:1 square" },
  "16:9": { width: 1920, height: 1080, label: "16:9 landscape" },
  "9:16": { width: 1080, height: 1920, label: "9:16 portrait" },
};

function niceFloor(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const normalized = value / power;
  const step = normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1;
  return step * power;
}

function captureExtent(points: CrossSectionControlPoint[]) {
  const longitudes = points.map((point) => point.longitude);
  const latitudes = points.map((point) => point.latitude);
  const xmin = Math.min(...longitudes);
  const xmax = Math.max(...longitudes);
  const ymin = Math.min(...latitudes);
  const ymax = Math.max(...latitudes);

  // Keep some surrounding terrain in view for very short cross sections.
  const lonSpan = Math.max(xmax - xmin, 0.00045);
  const latSpan = Math.max(ymax - ymin, 0.00045);
  const lonPad = lonSpan * 0.34;
  const latPad = latSpan * 0.34;

  return new Extent({
    xmin: xmin - lonPad,
    ymin: ymin - latPad,
    xmax: xmax + lonPad,
    ymax: ymax + latPad,
    spatialReference: WGS84,
  });
}

function addRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawNorthArrow(ctx: CanvasRenderingContext2D, width: number) {
  const panelWidth = 86;
  const panelHeight = 118;
  const x = width - CAPTURE_MARGIN_PX - panelWidth;
  const y = CAPTURE_MARGIN_PX;

  ctx.save();
  addRoundedRect(ctx, x, y, panelWidth, panelHeight, 14);
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fill();
  ctx.strokeStyle = "rgba(15,23,42,0.22)";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = "#0f172a";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "700 24px system-ui, sans-serif";
  ctx.fillText("N", x + panelWidth / 2, y + 27);

  const cx = x + panelWidth / 2;
  const tipY = y + 46;
  const baseY = y + 96;
  ctx.beginPath();
  ctx.moveTo(cx, tipY);
  ctx.lineTo(cx - 18, baseY);
  ctx.lineTo(cx, baseY - 10);
  ctx.lineTo(cx + 18, baseY);
  ctx.closePath();
  ctx.fillStyle = "#0f172a";
  ctx.fill();
  ctx.restore();
}

function formatScaleLabel(meters: number) {
  return `${Math.round(meters * FEET_PER_METER).toLocaleString()} ft`;
}

function drawScaleBar(
  ctx: CanvasRenderingContext2D,
  view: MapView,
  width: number,
  height: number,
) {
  const targetPx = Math.min(300, width * 0.27);
  const sampleY = Math.max(20, height - CAPTURE_MARGIN_PX - 68);
  const sampleX = CAPTURE_MARGIN_PX + 22;
  const a = view.toMap({ x: sampleX, y: sampleY });
  const b = view.toMap({ x: sampleX + targetPx, y: sampleY });

  if (!a || !b) return;
  const aLatitude = Number(a.latitude);
  const aLongitude = Number(a.longitude);
  const bLatitude = Number(b.latitude);
  const bLongitude = Number(b.longitude);
  if (!Number.isFinite(aLatitude) || !Number.isFinite(aLongitude)
    || !Number.isFinite(bLatitude) || !Number.isFinite(bLongitude)) return;

  const targetMeters = distanceMeters(
    { latitude: aLatitude, longitude: aLongitude },
    { latitude: bLatitude, longitude: bLongitude },
  );
  if (!Number.isFinite(targetMeters) || targetMeters <= 0) return;

  const targetFeet = targetMeters * FEET_PER_METER;
  const barFeet = niceFloor(targetFeet);
  const barMeters = barFeet / FEET_PER_METER;
  const label = formatScaleLabel(barMeters);

  const barPx = Math.max(48, targetPx * (barMeters / targetMeters));
  const panelWidth = barPx + 44;
  const panelHeight = 96;
  const x = CAPTURE_MARGIN_PX;
  const y = height - CAPTURE_MARGIN_PX - panelHeight;

  ctx.save();
  addRoundedRect(ctx, x, y, panelWidth, panelHeight, 12);
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fill();
  ctx.strokeStyle = "rgba(15,23,42,0.22)";
  ctx.lineWidth = 2;
  ctx.stroke();

  const lineX = x + 22;
  const lineY = y + 72;

  ctx.fillStyle = "#475569";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = "700 14px system-ui, sans-serif";
  ctx.fillText("Scale", lineX, y + 18);

  ctx.fillStyle = "#0f172a";
  ctx.font = "700 20px system-ui, sans-serif";
  ctx.fillText(label, lineX, y + 42);

  ctx.strokeStyle = "#0f172a";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(lineX, lineY);
  ctx.lineTo(lineX + barPx, lineY);
  ctx.moveTo(lineX, lineY - 9);
  ctx.lineTo(lineX, lineY + 9);
  ctx.moveTo(lineX + barPx, lineY - 9);
  ctx.lineTo(lineX + barPx, lineY + 9);
  ctx.stroke();
  ctx.restore();
}

function drawAttribution(ctx: CanvasRenderingContext2D, width: number, height: number, text: string) {
  // ArcGIS screenshots omit UI widgets, including the map's attribution.
  ctx.save();
  ctx.font = "500 14px system-ui, sans-serif";
  const textWidth = ctx.measureText(text).width;
  const panelWidth = textWidth + 24;
  const panelHeight = 32;
  const x = width - CAPTURE_MARGIN_PX - panelWidth;
  const y = height - CAPTURE_MARGIN_PX - panelHeight;
  addRoundedRect(ctx, x, y, panelWidth, panelHeight, 8);
  ctx.fillStyle = "rgba(255,255,255,0.88)";
  ctx.fill();
  ctx.fillStyle = "#334155";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 12, y + panelHeight / 2);
  ctx.restore();
}

function canvasBlob(canvas: HTMLCanvasElement, type: "image/jpeg" | "image/png") {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob?.type === type) resolve(blob);
      else reject(new Error("The browser could not encode the capture."));
    }, type, type === "image/jpeg" ? 0.95 : undefined);
  });
}

async function buildAerialCapture(
  { points, ratio, basemap }: CaptureSettings,
  signal: AbortSignal,
) {
  const preset = CAPTURE_PRESETS[ratio];
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.position = "fixed";
  host.style.left = "-20000px";
  host.style.top = "0";
  host.style.width = `${preset.width}px`;
  host.style.height = `${preset.height}px`;
  host.style.pointerEvents = "none";
  host.style.opacity = "0";
  const crossSectionLayer = new GraphicsLayer({ title: "Cross-section capture points" });
  // The dynamic contour service draws linework at scales beyond the USGS Topo tile cache.
  const contours = basemap === "contours"
    ? new MapImageLayer({ url: USGS_CONTOURS_URL, imageFormat: "png32" })
    : null;
  const map = new Map({
    basemap: contours ? null : "satellite",
    layers: [crossSectionLayer],
  });
  const view = new MapView({
    map,
    spatialReference: SpatialReference.WebMercator,
    background: { color: "#ffffff" },
    rotation: 0,
    constraints: { rotationEnabled: false, snapToZoom: false },
    ui: { components: [] },
  });
  const dispose = () => {
    contours?.destroy();
    view.destroy();
    host.remove();
  };
  signal.addEventListener("abort", dispose, { once: true });

  try {
    document.body.appendChild(host);
    view.container = host;
    await (contours?.load({ signal }) ?? map.basemap?.loadAll());
    signal.throwIfAborted();

    if (points.length >= 2) {
      crossSectionLayer.add(new Graphic({
        geometry: new Polyline({
          paths: [points.map((point) => [point.longitude, point.latitude])],
          spatialReference: WGS84,
        }),
        symbol: {
          type: "simple-line",
          color: [37, 99, 235, 0.95],
          width: 4,
        } as never,
      }));
    }

    points.forEach((point, index) => {
      crossSectionLayer.add(new Graphic({
        geometry: new Point({
          longitude: point.longitude,
          latitude: point.latitude,
          spatialReference: WGS84,
        }),
        symbol: {
          type: "simple-marker",
          style: "circle",
          color: [37, 99, 235, 1],
          size: 15,
          outline: { color: [255, 255, 255, 1], width: 2.5 },
        } as never,
      }));
      crossSectionLayer.add(new Graphic({
        geometry: new Point({
          longitude: point.longitude,
          latitude: point.latitude,
          spatialReference: WGS84,
        }),
        symbol: {
          type: "text",
          text: `P${index + 1}`,
          color: [255, 255, 255, 1],
          haloColor: [15, 23, 42, 0.98],
          haloSize: 2.5,
          yoffset: 19,
          font: { size: 13, weight: "bold" },
        } as never,
      }));
    });

    await view.when();
    await view.goTo(captureExtent(points), { animate: false });
    await reactiveUtils.whenOnce(() => !view.updating, signal);

    // Keep ArcGIS's intermediate screenshot lossless before composing overlays;
    // the final exported browser artifact is encoded as JPEG below.
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    signal.throwIfAborted();

    // Request the contour image for the exact screenshot extent and wait for it
    // before making the capture available.
    const [screenshot, contourImage] = await Promise.all([
      view.takeScreenshot({
        width: preset.width,
        height: preset.height,
        format: "png",
        ...(contours ? { layers: [crossSectionLayer], ignoreBackground: true } : {}),
      }),
      contours?.fetchImage(view.extent, preset.width, preset.height, { signal }),
    ]);

    const canvas = document.createElement("canvas");
    canvas.width = preset.width;
    canvas.height = preset.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("The browser could not create the capture canvas.");

    ctx.putImageData(screenshot.data, 0, 0);
    if (contourImage) {
      ctx.save();
      ctx.globalCompositeOperation = "destination-over";
      ctx.drawImage(contourImage, 0, 0, preset.width, preset.height);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, preset.width, preset.height);
      ctx.restore();
    }
    drawNorthArrow(ctx, preset.width);
    drawScaleBar(ctx, view, preset.width, preset.height);
    drawAttribution(ctx, preset.width, preset.height, CAPTURE_BASEMAPS[basemap].attribution);

    // Pre-encode PNG so the clipboard write can start within the button's click event.
    const [jpeg, png] = await Promise.all([
      canvasBlob(canvas, "image/jpeg"),
      canvasBlob(canvas, "image/png"),
    ]);
    return { jpeg, png };
  } finally {
    signal.removeEventListener("abort", dispose);
    if (!signal.aborted) dispose();
  }
}

export default function AerialCaptureDialog({
  points,
  onClose,
}: {
  points: CrossSectionControlPoint[];
  onClose: () => void;
}) {
  const [ratio, setRatio] = useState<CaptureRatio>("1:1");
  const [basemap, setBasemap] = useState<CaptureBasemap>("satellite");
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [feedback, setFeedback] = useState<{ image: CaptureImage; message: string; error?: boolean } | null>(null);
  const current = result?.points === points && result.ratio === ratio && result.basemap === basemap
    ? result
    : null;
  const capture = current?.image;
  const actionFeedback = feedback?.image === capture ? feedback : null;
  const error = current?.error ?? (actionFeedback?.error ? actionFeedback.message : null);

  useEffect(() => {
    const controller = new AbortController();
    const settings = { points, ratio, basemap };
    let previewUrl: string | undefined;
    setResult(null);
    setFeedback(null);
    const timeout = window.setTimeout(() => {
      controller.abort();
      setResult({ ...settings, error: "The map took too long to load. Reopen Capture to try again." });
    }, 30_000);

    void buildAerialCapture(settings, controller.signal)
      .then(({ jpeg, png }) => {
        if (controller.signal.aborted) return;
        previewUrl = URL.createObjectURL(jpeg);
        setResult({ ...settings, image: { jpeg, png, previewUrl } });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setResult({ ...settings, error: `Could not generate the ${CAPTURE_BASEMAPS[basemap].label.toLowerCase()} capture. Reopen Capture to try again.` });
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      controller.abort();
      window.clearTimeout(timeout);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [points, ratio, basemap]);

  function download() {
    if (!capture) return;
    const anchor = document.createElement("a");
    anchor.href = capture.previewUrl;
    anchor.download = `eris-cross-section-${CAPTURE_BASEMAPS[basemap].filename}-${ratio.replace(":", "x")}.jpg`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setFeedback({ image: capture, message: "JPEG download started." });
  }

  async function copyToClipboard() {
    if (!capture) return;
    setFeedback(null);
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      setFeedback({ image: capture, error: true, message: "Image copying is unavailable in this browser. Use Download JPEG." });
      return;
    }
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": capture.png }),
      ]);
      setFeedback({ image: capture, message: "Image copied to clipboard." });
    } catch {
      setFeedback({ image: capture, error: true, message: "The browser blocked image copying. Use Download JPEG." });
    }
  }

  const preset = CAPTURE_PRESETS[ratio];

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="aerial-capture-title"
        className="grid max-h-[94vh] w-full max-w-5xl overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--panel)] shadow-2xl lg:grid-cols-[340px_minmax(0,1fr)]"
      >
        <div className="overflow-y-auto border-b border-[var(--line)] p-5 lg:border-b-0 lg:border-r">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div id="aerial-capture-title" className="text-lg font-semibold">Cross-section capture</div>
              <div className="mt-1 text-sm leading-5 text-muted">
                Export the current cross-section points on a north-up map.
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--line)] bg-[var(--panel-soft)] text-lg"
              aria-label="Close capture"
            >
              ×
            </button>
          </div>

          <fieldset className="mt-5">
            <legend className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Map background</legend>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(["satellite", "contours"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={basemap === value}
                  onClick={() => setBasemap(value)}
                  className={`rounded-lg border px-3 py-3 text-sm font-semibold ${basemap === value
                    ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_10%,transparent)] text-[var(--brand)]"
                    : "border-[var(--line)] bg-[var(--panel-soft)] hover:bg-[var(--panel)]"}`}
                >
                  {CAPTURE_BASEMAPS[value].label}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="mt-5">
            <legend className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Aspect ratio</legend>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {(["1:1", "16:9", "9:16"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={ratio === value}
                  onClick={() => setRatio(value)}
                  className={`rounded-lg border px-3 py-3 text-sm font-semibold ${ratio === value
                    ? "border-[var(--brand)] bg-[color:color-mix(in_oklab,var(--brand)_10%,transparent)] text-[var(--brand)]"
                    : "border-[var(--line)] bg-[var(--panel-soft)] hover:bg-[var(--panel)]"}`}
                >
                  {value}
                </button>
              ))}
            </div>
            <div className="mt-2 text-xs text-muted">
              {preset.width.toLocaleString()} × {preset.height.toLocaleString()} · {preset.label}
            </div>
          </fieldset>

          {error ? (
            <div role="alert" className="mt-4 rounded-lg border border-red-300/50 bg-red-950/80 px-3 py-2 text-sm text-red-50">
              {error}
            </div>
          ) : null}

          {actionFeedback && !actionFeedback.error ? (
            <div role="status" className="mt-4 rounded-lg border border-emerald-300/40 bg-emerald-950/70 px-3 py-2 text-sm text-emerald-50">
              {actionFeedback.message}
            </div>
          ) : null}

          <div className="mt-5 grid gap-2">
            <button
              type="button"
              onClick={() => void copyToClipboard()}
              disabled={!capture}
              className="rounded-lg bg-[var(--brand)] px-4 py-2.5 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-40"
            >
              Copy image to clipboard
            </button>
            <button
              type="button"
              onClick={download}
              disabled={!capture}
              className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] px-4 py-2.5 text-sm font-semibold hover:bg-[var(--panel)] disabled:opacity-40"
            >
              Download JPEG
            </button>
          </div>

          <div className="mt-3 text-[11px] leading-5 text-muted">
            Capture files stay in the browser.
          </div>
        </div>

        <div className="flex min-h-[420px] items-center justify-center overflow-auto bg-slate-950 p-5">
          {!current ? (
            <div role="status" className="text-sm text-white/75">Preparing {CAPTURE_BASEMAPS[basemap].label.toLowerCase()} capture…</div>
          ) : capture ? (
            <img
              src={capture.previewUrl}
              alt={`North-up ${ratio} ${CAPTURE_BASEMAPS[basemap].label.toLowerCase()} map with the cross-section line and points`}
              className="max-h-[84vh] max-w-full rounded-lg border border-white/15 object-contain shadow-2xl"
            />
          ) : (
            <div className="max-w-md text-center text-sm text-white/70">
              Preview unavailable.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

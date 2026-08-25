import { useEffect, useMemo, useRef, useState } from "react";
import Map from "@arcgis/core/Map";
import MapView from "@arcgis/core/views/MapView";
import Graphic from "@arcgis/core/Graphic";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import Extent from "@arcgis/core/geometry/Extent";
import Point from "@arcgis/core/geometry/Point";
import Polyline from "@arcgis/core/geometry/Polyline";
import SpatialReference from "@arcgis/core/geometry/SpatialReference";
import * as reactiveUtils from "@arcgis/core/core/reactiveUtils";

import type { CrossSectionControlPoint } from "./terrainCrossSectionModel";

const WGS84 = SpatialReference.WGS84;
const CAPTURE_MARGIN_PX = 40;
const FEET_PER_METER = 3.280839895;

type CaptureRatio = "1:1" | "16:9" | "9:16";

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

function distanceMeters(
  a: Pick<CrossSectionControlPoint, "latitude" | "longitude">,
  b: Pick<CrossSectionControlPoint, "latitude" | "longitude">,
) {
  const radiusM = 6_371_008.8;
  const toRad = (value: number) => value * Math.PI / 180;
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radiusM * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

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

  // Ensure very short cross sections still have enough aerial context to be useful.
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

function drawAttribution(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const text = "Aerial imagery © Esri and contributors";
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

function canvasBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("The browser could not create the JPEG image."));
    }, "image/jpeg", 0.95);
  });
}

async function buildAerialCapture(
  points: CrossSectionControlPoint[],
  ratio: CaptureRatio,
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
  document.body.appendChild(host);

  const crossSectionLayer = new GraphicsLayer({ title: "Cross-section capture points" });
  const map = new Map({ basemap: "satellite", layers: [crossSectionLayer] });
  const view = new MapView({
    container: host,
    map,
    rotation: 0,
    constraints: { rotationEnabled: false },
  });

  try {
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
    view.ui.components = [];
    await view.goTo(captureExtent(points), { animate: false });
    view.rotation = 0;
    await reactiveUtils.whenOnce(() => !view.updating);

    // Keep ArcGIS's intermediate screenshot lossless before composing overlays;
    // the final exported browser artifact is encoded as JPEG below.
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

    const screenshot = await view.takeScreenshot({
      width: preset.width,
      height: preset.height,
      format: "png",
    });

    const canvas = document.createElement("canvas");
    canvas.width = preset.width;
    canvas.height = preset.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("The browser could not create the capture canvas.");

    ctx.putImageData(screenshot.data, 0, 0);
    drawNorthArrow(ctx, preset.width);
    drawScaleBar(ctx, view, preset.width, preset.height);
    drawAttribution(ctx, preset.width, preset.height);

    return canvasBlob(canvas);
  } finally {
    view.destroy();
    host.remove();
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
  const [blob, setBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const generationRef = useRef(0);
  const pointsSignature = useMemo(
    () => points.map((point) => `${point.longitude.toFixed(7)},${point.latitude.toFixed(7)}`).join("|"),
    [points],
  );

  useEffect(() => {
    const generation = ++generationRef.current;
    let objectUrl: string | null = null;
    let cancelled = false;
    setBusy(true);
    setError(null);
    setNotice(null);
    setBlob(null);
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });

    void buildAerialCapture(points, ratio)
      .then((nextBlob) => {
        if (cancelled || generation !== generationRef.current) return;
        objectUrl = URL.createObjectURL(nextBlob);
        setBlob(nextBlob);
        setPreviewUrl(objectUrl);
      })
      .catch((reason: unknown) => {
        if (cancelled || generation !== generationRef.current) return;
        setError(reason instanceof Error ? reason.message : "Failed to generate the aerial capture.");
      })
      .finally(() => {
        if (!cancelled && generation === generationRef.current) setBusy(false);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [pointsSignature, ratio]);

  function download() {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `eris-cross-section-aerial-${ratio.replace(":", "x")}.jpg`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setNotice("JPEG downloaded.");
  }

  async function copyToClipboard() {
    if (!blob) return;
    setError(null);
    setNotice(null);
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
        throw new Error("This browser does not support copying JPEG images to the clipboard.");
      }
      await navigator.clipboard.write([
        new ClipboardItem({ "image/jpeg": blob }),
      ]);
      setNotice("JPEG copied to clipboard.");
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "The browser blocked clipboard image access.");
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
              <div id="aerial-capture-title" className="text-lg font-semibold">Aerial capture</div>
              <div className="mt-1 text-sm leading-5 text-muted">
                Export the current cross-section points on north-up aerial imagery.
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--line)] bg-[var(--panel-soft)] text-lg"
              aria-label="Close aerial capture"
            >
              ×
            </button>
          </div>

          <div className="mt-5">
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Format</div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {(["1:1", "16:9", "9:16"] as CaptureRatio[]).map((value) => (
                <button
                  key={value}
                  type="button"
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
              {preset.width.toLocaleString()} × {preset.height.toLocaleString()} JPEG · {preset.label}
            </div>
          </div>

          <div className="mt-5 rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-4 text-sm">
            <div className="font-semibold">Capture standard</div>
            <div className="mt-2 space-y-1.5 text-xs leading-5 text-muted">
              <div>✓ Always north-up</div>
              <div>✓ Top-down aerial imagery</div>
              <div>✓ P1–P{points.length} labels and cross-section line</div>
              <div>✓ North indicator</div>
              <div>✓ Scale in feet</div>
              <div>✓ JPEG export</div>
            </div>
          </div>

          {error ? (
            <div role="alert" className="mt-4 rounded-lg border border-red-300/50 bg-red-950/80 px-3 py-2 text-sm text-red-50">
              {error}
            </div>
          ) : null}

          {notice ? (
            <div className="mt-4 rounded-lg border border-emerald-300/40 bg-emerald-950/70 px-3 py-2 text-sm text-emerald-50">
              {notice}
            </div>
          ) : null}

          <div className="mt-5 grid gap-2">
            <button
              type="button"
              onClick={() => void copyToClipboard()}
              disabled={!blob || busy}
              className="rounded-lg bg-[var(--brand)] px-4 py-2.5 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-40"
            >
              Copy JPEG to clipboard
            </button>
            <button
              type="button"
              onClick={download}
              disabled={!blob || busy}
              className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] px-4 py-2.5 text-sm font-semibold hover:bg-[var(--panel)] disabled:opacity-40"
            >
              Download JPEG
            </button>
          </div>

          <div className="mt-3 text-[11px] leading-5 text-muted">
            Capture files stay in the browser. ERIS does not upload them or save them to the database.
          </div>
        </div>

        <div className="flex min-h-[420px] items-center justify-center overflow-auto bg-slate-950 p-5">
          {busy ? (
            <div className="text-sm text-white/75">Preparing north-up aerial capture…</div>
          ) : previewUrl ? (
            <img
              src={previewUrl}
              alt={`North-up ${ratio} aerial capture preview of the current cross-section points`}
              className="max-h-[84vh] max-w-full rounded-lg border border-white/15 object-contain shadow-2xl"
            />
          ) : (
            <div className="max-w-md text-center text-sm text-white/70">
              The aerial preview could not be generated.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

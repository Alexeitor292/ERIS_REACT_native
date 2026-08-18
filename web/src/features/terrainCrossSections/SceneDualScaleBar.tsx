import { dualScaleBarForSceneScale } from "./sceneScaleBarModel";

export default function SceneDualScaleBar({ scale }: { scale: number | null }) {
  const model = dualScaleBarForSceneScale(scale);
  if (!model) return null;

  return (
    <div className="pointer-events-none absolute bottom-3 right-3 z-10 rounded-lg border border-white/20 bg-black/60 px-3 py-2 text-white shadow-lg backdrop-blur-sm" aria-label="Map scale reference">
      <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-white/65">Scale at scene center</div>
      <ScaleLine width={model.metric.widthPx} label={model.metric.label} />
      <div className="mt-1.5"><ScaleLine width={model.imperial.widthPx} label={model.imperial.label} /></div>
    </div>
  );
}

function ScaleLine({ width, label }: { width: number; label: string }) {
  return (
    <div className="flex items-end gap-2">
      <div className="relative h-2 border-b-2 border-l-2 border-r-2 border-white" style={{ width: Math.max(18, width) }} aria-hidden="true" />
      <div className="min-w-12 text-[10px] font-semibold tabular-nums leading-none">{label}</div>
    </div>
  );
}

import { Maximize2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";

import type { Gisa } from "../../api/types";
import { SliderField } from "./gisaFields";
import {
  FIELD_GROUPS,
  FieldNote,
  fieldSuggestion,
  MEASURE_KEYS,
  ReviewNotice,
  type MeasureKey,
  type MeasureValues,
} from "./measurements/measurementFields";
import MeasurementsWorkspace from "./measurements/MeasurementsWorkspace";
import { useSiteMeasurement } from "./measurements/useSiteMeasurement";

export { MEASURE_KEYS, type MeasureKey, type MeasureValues };

/**
 * The form's measurements: the sketch and the values on the form. Measuring from
 * the terrain and drone surveys happens in the full-screen workspace, which
 * is opened from here, so the form does not carry a 3D view.
 */
export default function SiteMeasurementsPanel({
  submissionId,
  gisa,
  onReload,
  values,
  onChange,
  geojson,
  canEdit,
}: {
  submissionId: number;
  gisa: Gisa | null;
  onReload: () => Promise<void>;
  values: MeasureValues;
  onChange: (patch: Partial<MeasureValues>) => void;
  geojson: unknown;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const measuring = useSiteMeasurement({ geojson, canEdit, auto: open });
  const { current, drone, scarpFt, terrain } = measuring;
  const hasSurvey = !!drone?.surveys.length;

  // A link straight to the 3D terrain opens the workspace.
  const [searchParams] = useSearchParams();
  const deepLink = searchParams.get("section") === "terrain";
  useEffect(() => {
    if (deepLink) setOpen(true);
  }, [deepLink]);

  return (
    <div className="min-w-0 space-y-4">
      <ReviewNotice />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-sm text-muted">
          {current?.drone
            ? `Before: ${current.drone.beforeTitle} · Now: ${current.drone.nowTitle}`
            : hasSurvey
              ? "A drone survey is on this form. Open the workspace to measure it."
              : "See each value on the 3D map, the ground before and now, and how far it moved."}
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex min-h-11 items-center gap-2 rounded-md bg-[var(--brand)] px-4 text-sm font-semibold text-white hover:brightness-110"
        >
          <Maximize2 size={15} aria-hidden /> Open workspace
        </button>
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <figure className="rounded-xl border border-[var(--line)] bg-white p-2">
          <img src="/measurement/landslide.png" alt="Landslide measurement reference with symbols H, alpha, Wd, Ld, Hs, beta, Lr, Wr" className="mx-auto w-full object-contain" />
        </figure>

        <div className="min-w-0 space-y-4">
          {FIELD_GROUPS.map((group) => (
            <fieldset key={group.title} disabled={!canEdit} className="min-w-0">
              <legend className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{group.title}</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {group.fields.map((field) => (
                  <div key={field.key} className="min-w-0">
                    {field.unit === "°" ? (
                      // Angles: a 0-90° slider, the box beside it for exact values.
                      <SliderField
                        label={<><SymbolBadge>{field.symbol}</SymbolBadge>{field.name}</>}
                        name={field.name}
                        unit="°"
                        max={90}
                        step={0.5}
                        value={values[field.key]}
                        onChange={(value) => onChange({ [field.key]: value })}
                      />
                    ) : (
                      <>
                        <label htmlFor={`measure-${field.key}`} className="mb-1 flex items-baseline gap-2 text-xs font-medium">
                          <SymbolBadge>{field.symbol}</SymbolBadge>
                          {field.name}
                        </label>
                        <div className="relative">
                          <input
                            id={`measure-${field.key}`}
                            type="number"
                            step="any"
                            inputMode="decimal"
                            className="w-full rounded-md border border-[var(--line)] bg-[var(--panel-soft)] py-2 pl-2.5 pr-9 text-sm tabular-nums"
                            value={values[field.key]}
                            onChange={(e) => onChange({ [field.key]: e.target.value })}
                          />
                          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted">{field.unit}</span>
                        </div>
                      </>
                    )}
                    <FieldNote
                      field={field}
                      value={values[field.key]}
                      suggestion={fieldSuggestion(field, current, scarpFt, terrain)}
                      canEdit={canEdit}
                      hasSurvey={hasSurvey}
                      onUse={(value) => onChange({ [field.key]: value })}
                    />
                  </div>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      </div>

      {open ? (
        <MeasurementsWorkspace
          submissionId={submissionId}
          gisa={gisa}
          onReload={onReload}
          geometryJson={geojson}
          values={values}
          onChange={onChange}
          canEdit={canEdit}
          measuring={measuring}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function SymbolBadge({ children }: { children: ReactNode }) {
  return (
    <span className="mr-0.5 inline-block min-w-8 rounded-md bg-[color:color-mix(in_oklab,var(--accent)_14%,var(--panel))] px-1.5 py-0.5 text-center font-serif text-sm italic">
      {children}
    </span>
  );
}


import { Link } from "react-router-dom";
import { Camera, Compass, LocateFixed, MapPin } from "lucide-react";

import type { Gisa } from "../../api/types";
import SubmissionArcGisMap from "../../components/SubmissionArcGisMap";
import type { PhotoMapResponse } from "./photoEvidenceApi";

export type StatePlaneHeroProps = {
  zone: string;
  units: string;
  northing: string;
  easting: string;
  error: string | null;
  onNorthingChange: (value: string) => void;
  onEastingChange: (value: string) => void;
  onApply: () => void;
};

type Props = {
  submissionId: number;
  gisa: Gisa | null;
  canEdit: boolean;
  busy: boolean;
  latitude: string;
  longitude: string;
  onLatitudeChange: (value: string) => void;
  onLongitudeChange: (value: string) => void;
  onCoordinateBlur: (field: "latitude" | "longitude") => void;
  geoBusy: boolean;
  onAutofillFromGps: () => void;
  statePlane: StatePlaneHeroProps | null;
  showStatePlane: boolean;
  onToggleStatePlane: () => void;
  geojson: any | null;
  onGeometryChange: (geometry: any | null) => void;
  geoSaveState: "idle" | "saving" | "saved" | "error";
  geoSaveMessage: string;
  photoMap: PhotoMapResponse | null;
  photoLoading: boolean;
  photoError: string | null;
};

const fieldLabel = "mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted";
const fieldInput = "w-full rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2.5 py-2 text-sm tabular-nums disabled:opacity-80";

function StoredValue({ label, value, title }: { label: string; value: string | null | undefined; title?: string }) {
  const text = value == null || String(value).trim() === "" ? "—" : String(value);
  return (
    <div className="min-w-0 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2" title={title}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-0.5 truncate text-base font-semibold tabular-nums" title={text}>{text}</div>
    </div>
  );
}

function LegendItem({ swatch, label, value }: { swatch: React.ReactNode; label: string; value?: number | string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      {swatch}
      {value != null ? <span className="font-semibold text-[var(--ink)] tabular-nums">{value}</span> : null}
      <span>{label}</span>
    </span>
  );
}

/**
 * Location hero: stored D/C/R/PM (rendered verbatim as normalized by the backend),
 * editable coordinates, and the ArcGIS map with the submission point and every mapped
 * field photo. Camera-heading wedges are drawn only when the backend quality gate kept
 * the heading (camera_heading_deg non-null).
 */
export default function SubmissionLocationHero({
  submissionId,
  gisa,
  canEdit,
  busy,
  latitude,
  longitude,
  onLatitudeChange,
  onLongitudeChange,
  onCoordinateBlur,
  geoBusy,
  onAutofillFromGps,
  statePlane,
  showStatePlane,
  onToggleStatePlane,
  geojson,
  onGeometryChange,
  geoSaveState,
  geoSaveMessage,
  photoMap,
  photoLoading,
  photoError,
}: Props) {
  const summary = photoMap?.summary ?? null;
  const location = {
    latitude: latitude.trim() ? Number(latitude) : null,
    longitude: longitude.trim() ? Number(longitude) : null,
  };

  return (
    <section className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-3 md:p-4" aria-labelledby="submission-location-title">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <MapPin size={16} strokeWidth={1.9} aria-hidden className="text-[var(--brand)]" />
          <h2 id="submission-location-title" className="text-xs font-semibold uppercase tracking-wide text-[var(--brand)]">Location and ERIS map</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canEdit ? (
            <button
              type="button"
              onClick={onAutofillFromGps}
              disabled={busy || geoBusy}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2.5 py-1.5 text-xs font-medium hover:brightness-95 disabled:opacity-60"
            >
              <LocateFixed size={13} strokeWidth={2} aria-hidden />
              {geoBusy ? "Detecting…" : "Use GPS autofill"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onToggleStatePlane}
            disabled={!statePlane}
            className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2.5 py-1.5 text-xs font-medium hover:brightness-95 disabled:opacity-60"
            title={statePlane ? "Toggle California State Plane northing/easting" : "Select a county to enable northing/easting"}
          >
            {showStatePlane ? "Hide N/E" : "Show N/E"}
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(280px,380px)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <StoredValue label="District" value={gisa?.district} title="Stored as a 2-digit district code" />
            <StoredValue label="County" value={gisa?.county} title="Stored as captured (Caltrans county code)" />
            <StoredValue label="Route" value={gisa?.route} title="Stored as a 3-digit route number" />
            <StoredValue label="Post mile" value={gisa?.post_mile} title="Stored as captured" />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={fieldLabel} htmlFor="hero-latitude">Latitude</label>
              <input
                id="hero-latitude"
                type="number"
                step="0.000001"
                inputMode="decimal"
                className={fieldInput}
                value={latitude}
                onChange={(event) => onLatitudeChange(event.target.value)}
                onBlur={() => onCoordinateBlur("latitude")}
                disabled={!canEdit}
              />
            </div>
            <div>
              <label className={fieldLabel} htmlFor="hero-longitude">Longitude</label>
              <input
                id="hero-longitude"
                type="number"
                step="0.000001"
                inputMode="decimal"
                className={fieldInput}
                value={longitude}
                onChange={(event) => onLongitudeChange(event.target.value)}
                onBlur={() => onCoordinateBlur("longitude")}
                disabled={!canEdit}
              />
            </div>
          </div>

          {showStatePlane && statePlane ? (
            <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-2.5">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
                CCS83 Zone {statePlane.zone} · {statePlane.units}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={fieldLabel} htmlFor="hero-northing">Northing</label>
                  <input
                    id="hero-northing"
                    type="number"
                    step="0.001"
                    inputMode="decimal"
                    className={`${fieldInput} bg-[var(--panel)]`}
                    value={statePlane.northing}
                    onChange={(event) => statePlane.onNorthingChange(event.target.value)}
                    onBlur={statePlane.onApply}
                    disabled={!canEdit}
                  />
                </div>
                <div>
                  <label className={fieldLabel} htmlFor="hero-easting">Easting</label>
                  <input
                    id="hero-easting"
                    type="number"
                    step="0.001"
                    inputMode="decimal"
                    className={`${fieldInput} bg-[var(--panel)]`}
                    value={statePlane.easting}
                    onChange={(event) => statePlane.onEastingChange(event.target.value)}
                    onBlur={statePlane.onApply}
                    disabled={!canEdit}
                  />
                </div>
              </div>
              {statePlane.error ? <div className="mt-2 text-xs text-[var(--bad)]">{statePlane.error}</div> : null}
            </div>
          ) : null}

          {geoSaveMessage ? (
            <div className={`text-xs ${geoSaveState === "error" ? "text-[var(--bad)]" : "text-muted"}`} role="status">
              {geoSaveMessage}
            </div>
          ) : null}

          <div className="rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Mapped evidence</div>
              <Link to={`/submissions/${submissionId}/photo-evidence`} className="text-xs font-medium text-[var(--brand)] hover:underline">
                Photo evidence details
              </Link>
            </div>
            {photoError ? (
              <div className="mt-2 text-xs text-[var(--bad)]">{photoError}</div>
            ) : photoLoading && !summary ? (
              <div className="mt-2 text-xs text-muted">Loading photo evidence…</div>
            ) : (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
                <LegendItem
                  swatch={<span aria-hidden className="inline-block h-3 w-3 rounded-full border-2 border-white bg-[#2563eb] shadow" />}
                  label="submission point"
                />
                <LegendItem
                  swatch={<span aria-hidden className="inline-flex h-3 w-3 items-center justify-center rounded-full border-2 border-white bg-[var(--accent)] shadow"><Camera size={7} strokeWidth={3} className="text-white" /></span>}
                  label="mapped"
                  value={summary?.photos_geotagged ?? 0}
                />
                <LegendItem
                  swatch={<span aria-hidden className="inline-flex items-center text-[var(--accent)]"><Compass size={13} strokeWidth={2} /></span>}
                  label="with heading"
                  value={summary?.photos_with_heading ?? 0}
                />
                <LegendItem
                  swatch={<span aria-hidden className="inline-block h-3 w-3 rounded-full border border-dashed border-[var(--muted)]" />}
                  label="unmapped"
                  value={summary?.photos_unmapped ?? 0}
                />
              </div>
            )}
          </div>
        </div>

        <div className="min-w-0">
          <SubmissionArcGisMap
            geojson={geojson}
            location={location}
            photoEvidence={photoMap?.photos ?? null}
            height={360}
            editable={canEdit}
            onGeometryChange={onGeometryChange}
          />
        </div>
      </div>
    </section>
  );
}

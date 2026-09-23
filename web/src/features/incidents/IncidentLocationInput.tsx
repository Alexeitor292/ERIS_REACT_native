import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ExternalLink, LoaderCircle, MapPin } from "lucide-react";

import { appConfig } from "../../config";
import { CALTRANS_COUNTIES, districtForCounty, routesForDistrictCounty } from "../../utils/caltransLookups";
import { formatCoordinate } from "../../utils/precision";
import { CaltransUnavailableError, resolveCoordinates, resolveRoad } from "./caltransPostmileClient";
import IncidentLocationMap from "./IncidentLocationMap";
import {
  locationMethodLabel,
  normalizeCoordinate,
  numericPostmile,
  roadLocationLabel,
  streetViewEmbedUrl,
  streetViewUrl,
  type ResolvedIncidentLocation,
} from "./incidentLocationModel";

type Mode = "MAP" | "ROAD" | "COORDINATES";

const MODES: Array<{ value: Mode; label: string }> = [
  { value: "MAP", label: "Map" },
  { value: "ROAD", label: "Route & post mile" },
  { value: "COORDINATES", label: "Coordinates" },
];

const DISTRICTS = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, "0"));

const inputClass = "w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)] disabled:opacity-60";
const labelClass = "text-xs font-semibold uppercase tracking-wide text-muted";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid gap-1.5"><span className={labelClass}>{label}</span>{children}</label>;
}

/**
 * Where the incident is, entered one of three ways — one shown at a time:
 *
 *   Map                — click the highway; the desktop's stand-in for the phone's GPS.
 *   Route & post mile  — District, County, Route and Post mile, as on the phone.
 *   Coordinates        — latitude and longitude.
 *
 * Whichever way it is entered, it is resolved the phone's way against the
 * Caltrans postmile layer into ONE location with every part known, and the
 * other two modes are filled in from it, so switching modes shows the same
 * place. Changing any value un-resolves it until it is looked up again: a
 * report is only ever filed with a location Caltrans recognised.
 */
export default function IncidentLocationInput({
  value,
  onChange,
  disabled = false,
}: {
  value: ResolvedIncidentLocation | null;
  onChange: (next: ResolvedIncidentLocation | null) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [mode, setMode] = useState<Mode>("MAP");
  const [pin, setPin] = useState<{ latitude: number; longitude: number } | null>(value);
  const [latitude, setLatitude] = useState(value ? formatCoordinate(value.latitude) : "");
  const [longitude, setLongitude] = useState(value ? formatCoordinate(value.longitude) : "");
  const [district, setDistrict] = useState(value?.district ?? "");
  const [county, setCounty] = useState(value?.county ?? "");
  const [route, setRoute] = useState(value?.route ?? "");
  const [postMile, setPostMile] = useState(value?.post_mile ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [streetView, setStreetView] = useState(false);
  // Only the latest lookup may answer: a slow reply to an earlier pin must not
  // overwrite the pin the reporter has since moved.
  const lookup = useRef(0);

  const counties = useMemo(
    () => CALTRANS_COUNTIES.filter((row) => !district || row.district === district).sort((a, b) => a.name.localeCompare(b.name)),
    [district],
  );
  const routes = useMemo(() => routesForDistrictCounty(district, county), [district, county]);

  function unresolve() {
    if (value) onChange(null);
    setProblem(null);
  }

  function apply(resolved: ResolvedIncidentLocation) {
    onChange(resolved);
    setPin({ latitude: resolved.latitude, longitude: resolved.longitude });
    setLatitude(formatCoordinate(resolved.latitude));
    setLongitude(formatCoordinate(resolved.longitude));
    setDistrict(resolved.district);
    setCounty(resolved.county);
    setRoute(resolved.route);
    setPostMile(resolved.post_mile);
    setProblem(null);
  }

  async function run(ask: () => Promise<ResolvedIncidentLocation | null>, notFound: string) {
    const ticket = ++lookup.current;
    setBusy(true);
    setProblem(null);
    try {
      const resolved = await ask();
      if (ticket !== lookup.current) return;
      if (resolved) apply(resolved);
      else setProblem(notFound);
    } catch (error) {
      if (ticket !== lookup.current) return;
      setProblem(error instanceof CaltransUnavailableError ? error.message : "The location could not be looked up. Try again.");
    } finally {
      if (ticket === lookup.current) setBusy(false);
    }
  }

  function lookUpPoint(point: { latitude: number; longitude: number }) {
    const lat = normalizeCoordinate(point.latitude);
    const lon = normalizeCoordinate(point.longitude);
    if (lat == null || lon == null) return;
    setPin({ latitude: lat, longitude: lon });
    setLatitude(formatCoordinate(lat));
    setLongitude(formatCoordinate(lon));
    unresolve();
    void run(
      () => resolveCoordinates(lat, lon),
      "No state highway post mile is within 3 km of this point. Place it on the highway, or enter the route and post mile.",
    );
  }

  function lookUpCoordinates() {
    const lat = normalizeCoordinate(latitude);
    const lon = normalizeCoordinate(longitude);
    if (lat == null || lon == null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      setProblem("Enter a latitude between -90 and 90 and a longitude between -180 and 180.");
      return;
    }
    lookUpPoint({ latitude: lat, longitude: lon });
  }

  function lookUpRoad() {
    const pm = numericPostmile(postMile);
    if (!district || !county || !route.trim() || pm == null) {
      setProblem("District, county, route and a post mile such as 12.3 or R12.3 are all needed.");
      return;
    }
    void run(
      () => resolveRoad({ district, county, route, postmile: pm }),
      "Caltrans has no post mile there. Check the route, the county and the post mile's prefix or suffix.",
    );
  }

  const canEmbedStreetView = Boolean(appConfig.googleMapsEmbedKey);
  const streetViewPoint = value ?? pin;

  return (
    <fieldset className="grid min-w-0 content-start gap-3" disabled={disabled} aria-labelledby={`${id}-title`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id={`${id}-title`} className="text-sm font-semibold">Where is it? <span className="text-[var(--bad)]" aria-hidden>*</span></span>
        <div role="radiogroup" aria-label="How to enter the location" className="inline-flex overflow-hidden rounded-lg border border-[var(--line)] text-[13px]">
          {MODES.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={mode === option.value}
              onClick={() => { setMode(option.value); setProblem(null); }}
              className={`px-3 py-1.5 font-semibold ${index ? "border-l border-[var(--line)]" : ""} ${mode === option.value ? "bg-[var(--brand)] text-white" : "bg-[var(--panel)] hover:bg-[var(--panel-soft)]"}`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {mode === "MAP" ? (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-muted">
            <span>Click the highway where the problem is. ERIS finds its post mile.</span>
            {canEmbedStreetView && streetViewPoint ? (
              <button type="button" onClick={() => setStreetView((open) => !open)} className="rounded-md border border-[var(--line)] px-2 py-1 text-xs font-semibold text-[var(--ink)] hover:bg-[var(--panel-soft)]">
                {streetView ? "Back to the map" : "Street View here"}
              </button>
            ) : null}
          </div>
          <div className={streetView && canEmbedStreetView && streetViewPoint ? "hidden" : undefined}>
            <IncidentLocationMap point={pin} onPick={lookUpPoint} />
          </div>
          {streetView && canEmbedStreetView && streetViewPoint ? (
            <iframe
              title="Street View at the incident location"
              src={streetViewEmbedUrl(appConfig.googleMapsEmbedKey, streetViewPoint.latitude, streetViewPoint.longitude)}
              className="h-[340px] w-full rounded-lg border border-[var(--line)]"
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              allowFullScreen
            />
          ) : null}
        </div>
      ) : null}

      {mode === "ROAD" ? (
        <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); lookUpRoad(); }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="District">
              <select className={inputClass} value={district} onChange={(event) => { setDistrict(event.target.value); setCounty(""); setRoute(""); unresolve(); }}>
                <option value="">Choose…</option>
                {DISTRICTS.map((code) => <option key={code} value={code}>District {Number(code)}</option>)}
              </select>
            </Field>
            <Field label="County">
              <select
                className={inputClass}
                value={county}
                onChange={(event) => {
                  const next = event.target.value;
                  setCounty(next);
                  if (!district && next) setDistrict(String(districtForCounty(next) ?? "").padStart(2, "0"));
                  setRoute("");
                  unresolve();
                }}
              >
                <option value="">Choose…</option>
                {counties.map((row) => <option key={row.code} value={row.code}>{row.name} ({row.code})</option>)}
              </select>
            </Field>
            <Field label="Route">
              <input className={inputClass} list={`${id}-routes`} value={route} onChange={(event) => { setRoute(event.target.value); unresolve(); }} placeholder={routes.length ? "Choose or type" : "e.g. 101"} inputMode="numeric" />
              <datalist id={`${id}-routes`}>{routes.map((code) => <option key={code} value={code} />)}</datalist>
            </Field>
            <Field label="Post mile">
              <input className={inputClass} value={postMile} onChange={(event) => { setPostMile(event.target.value); unresolve(); }} placeholder="e.g. 84.2 or R12.3" />
            </Field>
          </div>
          <div>
            <button type="submit" disabled={busy} className="inline-flex items-center gap-1.5 rounded-md border border-[var(--brand)] px-3 py-1.5 text-sm font-semibold text-[var(--brand)] hover:bg-[color:color-mix(in_oklab,var(--brand)_8%,var(--panel))] disabled:opacity-50">
              <MapPin size={15} aria-hidden /> Find this post mile
            </button>
          </div>
        </form>
      ) : null}

      {mode === "COORDINATES" ? (
        <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); lookUpCoordinates(); }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Latitude">
              <input className={`${inputClass} tabular-nums`} inputMode="decimal" value={latitude} onChange={(event) => { setLatitude(event.target.value); unresolve(); }} placeholder="e.g. 40.605000" />
            </Field>
            <Field label="Longitude">
              <input className={`${inputClass} tabular-nums`} inputMode="decimal" value={longitude} onChange={(event) => { setLongitude(event.target.value); unresolve(); }} placeholder="e.g. -124.134000" />
            </Field>
          </div>
          <div>
            <button type="submit" disabled={busy} className="inline-flex items-center gap-1.5 rounded-md border border-[var(--brand)] px-3 py-1.5 text-sm font-semibold text-[var(--brand)] hover:bg-[color:color-mix(in_oklab,var(--brand)_8%,var(--panel))] disabled:opacity-50">
              <MapPin size={15} aria-hidden /> Find its post mile
            </button>
          </div>
        </form>
      ) : null}

      <div aria-live="polite">
        {busy ? (
          <div className="flex items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-2.5 text-sm text-muted">
            <LoaderCircle size={15} className="animate-spin motion-reduce:animate-none" aria-hidden /> Looking it up with Caltrans…
          </div>
        ) : problem ? (
          <div role="alert" className="rounded-lg border border-[color:color-mix(in_oklab,var(--warn)_55%,transparent)] bg-[color:color-mix(in_oklab,var(--warn)_10%,var(--panel))] px-3 py-2.5 text-sm text-[var(--warn-text)]">{problem}</div>
        ) : value ? (
          <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_7%,var(--panel))] px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-sm font-semibold tabular-nums">{roadLocationLabel(value)}</div>
              <div className="mt-0.5 text-xs text-muted tabular-nums">{formatCoordinate(value.latitude)}, {formatCoordinate(value.longitude)} · {locationMethodLabel(value.method)}</div>
            </div>
            <a href={streetViewUrl(value.latitude, value.longitude)} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-[var(--brand)] hover:underline">
              Street View <ExternalLink size={12} aria-hidden />
            </a>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-[var(--line)] px-3 py-2.5 text-sm text-muted">
            Not placed yet. {mode === "MAP" ? "Click the map." : "Fill in the fields and look it up."}
          </div>
        )}
      </div>
    </fieldset>
  );
}

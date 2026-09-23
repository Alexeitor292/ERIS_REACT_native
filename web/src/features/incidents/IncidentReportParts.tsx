import { useEffect, useMemo, useState, type ReactNode } from "react";

import { api } from "../../api/client";
import type { Incident, IncidentAttachment } from "../../api/types";
import { formatCoordinate } from "../../utils/precision";
import { friendlyFieldLabel, friendlyFieldValue } from "../../utils/roadInventoryGlossary";
import { eventGroupLocationLabel } from "../eventGroups/eventGroupTypes";
import EventGroupTriageMap from "../eventGroups/EventGroupTriageMap";
import {
  distanceLabel,
  formatFileSize,
  isViewableImage,
  metresBetween,
  reportingDelayHours,
  reportingDelayLabel,
  roadSummaryEntries,
  summarizeEvidence,
  type ReviewAttachment,
} from "./reportReviewModel";

/**
 * The pieces of a field report that both the coordinator's triage review and the
 * dedicated incident page render, so the two can never show the same report two
 * different ways.
 */

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

export function formatWhen(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : dateTimeFormatter.format(date);
}

/**
 * ERIS clears a report's classification on insert — `trg_incident_identity_bi`
 * sets `incident_type` to NULL — because the type is decided by the on-site
 * assessment, not by the reporter. Saying "not stated by the reporter" would
 * blame them for a rule of the system.
 */
export function incidentTypeLabel(raw: string | null): string {
  if (!raw) return "Not classified yet — the on-site assessment decides it";
  return raw.replace(/_/g, " ").toLowerCase().replace(/(^|\s)\S/g, (match) => match.toUpperCase());
}

export function Panel({ title, hint, children, id }: { title: string; hint?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className="min-w-0 rounded-xl border border-[var(--line)] bg-[var(--panel)]">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--line)] bg-[var(--panel-soft)] px-4 py-2.5">
        <h2 id={id ? `${id}-title` : undefined} className="text-[13px] font-semibold">{title}</h2>
        {hint ? <span className="text-[11px] text-muted">{hint}</span> : null}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{label}</div>
      <div className="mt-0.5 break-words text-sm">{value}</div>
    </div>
  );
}

export function toReviewAttachments(items: IncidentAttachment[]): ReviewAttachment[] {
  return items.map((item) => ({
    attachment_id: item.attachment_id,
    kind: item.kind,
    file_name: item.file_name,
    mime_type: item.mime_type,
    file_size_bytes: item.file_size_bytes,
    captured_at: item.captured_at,
    latitude: item.latitude,
    longitude: item.longitude,
    horizontal_accuracy_m: item.horizontal_accuracy_m,
    camera_heading_deg: item.camera_heading_deg,
    download_url: item.download_url,
  }));
}

/**
 * A report's evidence list. Loaded on its own so a storage hiccup never hides the
 * report itself: the evidence panel says the files could not be listed instead.
 */
export function useIncidentEvidence(incidentId: number | null) {
  const [items, setItems] = useState<ReviewAttachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (incidentId === null || !Number.isFinite(incidentId)) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    api<{ items: IncidentAttachment[] }>(`/incidents/${incidentId}/attachments`)
      .then((response) => { if (!cancelled) setItems(toReviewAttachments(response.items ?? [])); })
      .catch(() => { if (!cancelled) { setItems([]); setFailed(true); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [incidentId]);

  return { items, loading, failed };
}

export function evidenceHint(items: ReviewAttachment[]): string | undefined {
  const summary = summarizeEvidence(items);
  if (!summary.total) return undefined;
  return `${summary.total} file${summary.total === 1 ? "" : "s"}${summary.located ? ` · ${summary.located} with a position` : ""}`;
}

/** Photos as thumbnails that open full size; every other file as a row with Open. */
export function EvidenceGallery({
  pin,
  items,
  loading,
  failed,
  emptyText,
}: {
  pin: { latitude: number; longitude: number };
  items: ReviewAttachment[];
  loading: boolean;
  failed: boolean;
  emptyText: string;
}) {
  const [lightboxId, setLightboxId] = useState<number | null>(null);
  const images = useMemo(() => items.filter(isViewableImage), [items]);
  const otherFiles = useMemo(() => items.filter((item) => !isViewableImage(item)), [items]);
  const lightbox = images.find((item) => item.attachment_id === lightboxId) ?? null;

  // A surrounding dialog listens for Escape on document and would close
  // whatever the gallery sits in. While a photo is open, Escape closes the photo.
  useEffect(() => {
    if (lightboxId === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setLightboxId(null);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [lightboxId]);

  if (failed) {
    return <p className="text-sm text-[var(--bad)]">The attached files could not be listed. Refresh the page, or check the report on the mobile app.</p>;
  }
  if (images.length === 0 && otherFiles.length === 0) {
    return <p className="text-sm text-muted">{loading ? "Loading evidence…" : emptyText}</p>;
  }

  return (
    <div className="grid gap-3">
      {images.length ? (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {images.map((photo) => {
            const distance = photo.latitude !== null && photo.longitude !== null
              ? metresBetween(pin, { latitude: photo.latitude, longitude: photo.longitude })
              : null;
            return (
              <li key={photo.attachment_id}>
                <button
                  type="button"
                  onClick={() => setLightboxId(photo.attachment_id)}
                  className="grid w-full gap-1 overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] text-left hover:border-[var(--brand)] focus-visible:outline-2 focus-visible:outline-[var(--brand)]"
                  aria-label={`Open photo ${photo.file_name}`}
                >
                  <img src={photo.download_url} alt={photo.file_name} loading="lazy" className="h-28 w-full object-cover" />
                  <span className="grid gap-0.5 px-2 pb-2">
                    {/* The file name is the fallback, never a bare dash: a photo
                        whose device recorded no capture time still has to be
                        identifiable. */}
                    <span className="truncate text-[11px] font-medium">{photo.captured_at ? formatWhen(photo.captured_at) : photo.file_name}</span>
                    <span className="truncate text-[11px] text-muted">{distance === null ? "No position recorded" : distanceLabel(distance)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {otherFiles.length ? (
        <ul className="grid gap-1.5">
          {otherFiles.map((file) => (
            <li key={file.attachment_id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--line)] px-3 py-2">
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{file.file_name}</span>
                <span className="block text-[11px] text-muted">{fileKindLabel(file.kind)} · {formatFileSize(file.file_size_bytes) || file.mime_type}</span>
              </span>
              <a href={file.download_url} target="_blank" rel="noreferrer" className="rounded border border-[var(--line)] px-2.5 py-1.5 text-[12px] font-semibold hover:bg-[var(--panel-soft)]">Open</a>
            </li>
          ))}
        </ul>
      ) : null}

      {lightbox ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={lightbox.file_name}
          className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-black/80 p-4"
          onClick={() => setLightboxId(null)}
        >
          <img src={lightbox.download_url} alt={lightbox.file_name} className="max-h-[80vh] max-w-full rounded-lg object-contain" />
          <div className="mt-3 max-w-2xl rounded-md bg-black/70 px-3 py-2 text-center text-xs text-white">
            <div className="font-semibold">{lightbox.file_name}</div>
            <div className="mt-0.5 opacity-90">
              {lightbox.captured_at ? formatWhen(lightbox.captured_at) : "No capture time recorded"}
              {lightbox.horizontal_accuracy_m !== null ? ` · ±${Math.round(lightbox.horizontal_accuracy_m)} m` : ""}
              {lightbox.camera_heading_deg !== null ? ` · facing ${Math.round(lightbox.camera_heading_deg)}°` : ""}
            </div>
            <div className="mt-2 flex justify-center gap-2">
              <a href={lightbox.download_url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} className="rounded border border-white/40 px-2 py-1 font-semibold">Open original</a>
              <button type="button" onClick={() => setLightboxId(null)} className="rounded border border-white/40 px-2 py-1 font-semibold">Close</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function fileKindLabel(kind: string): string {
  if (kind === "VIDEO") return "Video";
  if (kind === "DOC") return "Document";
  if (kind === "SKETCH") return "Sketch";
  if (kind === "PHOTO") return "Photo";
  return kind;
}

/** What the maintenance worker reported, in the order they filled it in. */
export function ReportFacts({ incident }: { incident: Incident }) {
  const delay = reportingDelayLabel(reportingDelayHours(incident));
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Fact label="Filed by" value={incident.reporter_name || `User #${incident.reporter_user_id}`} />
        <Fact label="Classification" value={incidentTypeLabel(incident.incident_type)} />
        <Fact label="First seen" value={<span className="tabular-nums">{formatWhen(incident.first_observed_at)}</span>} />
        <Fact label="Occurred" value={<span className="tabular-nums">{incident.first_occurred_at ? formatWhen(incident.first_occurred_at) : "Not recorded"}</span>} />
        <Fact label="Filed" value={<span className="tabular-nums">{formatWhen(incident.created_at)}</span>} />
        <Fact label="Last updated" value={<span className="tabular-nums">{formatWhen(incident.updated_at)}</span>} />
      </div>
      {delay ? <div className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-1.5 text-[13px] text-muted">{delay}</div> : null}
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Description</div>
        <p className="mt-1 whitespace-pre-wrap text-sm">{incident.description?.trim() || "The reporter left the description empty."}</p>
      </div>
    </div>
  );
}

/** The location as filed, with a map of the pin. */
export function LocationFacts({ incident, mapHeight = 260 }: { incident: Incident; mapHeight?: number }) {
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Fact label="District · County · Route · Post mile" value={<span className="tabular-nums">{eventGroupLocationLabel(incident)}</span>} />
        <Fact label="Coordinates" value={<span className="tabular-nums">{formatCoordinate(incident.latitude)}, {formatCoordinate(incident.longitude)}</span>} />
      </div>
      <EventGroupTriageMap
        incident={{ id: incident.id, latitude: incident.latitude, longitude: incident.longitude, title: incident.title }}
        groups={[]}
        selectedGroupId={null}
        selectedIncidents={[]}
        onSelectGroup={() => {}}
        height={mapHeight}
      />
    </div>
  );
}

/**
 * The matched Road Inventory segment: the fields worth a glance first, and on
 * the full page every other recorded field behind a disclosure, labelled.
 */
export function RoadInventoryFacts({ incident, showAllFields = false }: { incident: Incident; showAllFields?: boolean }) {
  const snapshot = incident.road_inventory_context?.snapshot ?? null;
  const entries = roadSummaryEntries(snapshot);
  if (!snapshot || entries.length === 0) {
    return <p className="text-sm text-muted">No Road Inventory segment was matched for this location.</p>;
  }
  const shown = new Set(entries.map((entry) => entry.key));
  const rest = Object.entries(snapshot).filter(([key, value]) => !shown.has(key) && value !== null && value !== undefined && value !== "" && typeof value !== "object");
  return (
    <div className="grid gap-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
        {entries.map((entry) => (
          <div key={entry.key} className="min-w-0">
            <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{friendlyFieldLabel(entry.key)}</dt>
            <dd className="mt-0.5 break-words text-sm">{friendlyFieldValue(entry.key, entry.value)}</dd>
          </div>
        ))}
      </dl>
      {showAllFields && rest.length ? (
        <details className="rounded-md border border-[var(--line)] px-3 py-2">
          <summary className="cursor-pointer text-[12px] font-semibold">All recorded fields ({rest.length})</summary>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
            {rest.map(([key, value]) => (
              <div key={key} className="min-w-0">
                <dt className="text-[11px] text-muted">{friendlyFieldLabel(key)} <span className="opacity-70">({key})</span></dt>
                <dd className="break-words text-[13px]">{friendlyFieldValue(key, value)}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </div>
  );
}

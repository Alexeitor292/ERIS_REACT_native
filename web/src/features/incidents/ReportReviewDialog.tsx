import { useEffect, useMemo, useState } from "react";

import { api } from "../../api/client";
import type { Incident, IncidentAttachment } from "../../api/types";
import ModalDialog from "../../ui/ModalDialog";
import { formatCoordinate } from "../../utils/precision";
import { friendlyFieldLabel, friendlyFieldValue } from "../../utils/roadInventoryGlossary";
import { eventGroupLocationLabel } from "../eventGroups/eventGroupTypes";
import EventGroupTriageMap from "../eventGroups/EventGroupTriageMap";
import {
  distanceLabel,
  formatFileSize,
  isViewableImage,
  metresBetween,
  readinessChecks,
  reportingDelayHours,
  reportingDelayLabel,
  roadSummaryEntries,
  summarizeEvidence,
  type ReviewAttachment,
} from "./reportReviewModel";

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

function formatWhen(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : dateTimeFormatter.format(date);
}

function incidentTypeLabel(raw: string | null): string {
  if (!raw) return "Not stated by the reporter";
  return raw.replace(/_/g, " ").toLowerCase().replace(/(^|\s)\S/g, (match) => match.toUpperCase());
}

function Panel({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)]">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--line)] bg-[var(--panel-soft)] px-4 py-2.5">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {hint ? <span className="text-[11px] text-muted">{hint}</span> : null}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{label}</div>
      <div className="mt-0.5 break-words text-sm">{value}</div>
    </div>
  );
}

/**
 * Step 1 of coordinator triage: everything needed to judge whether a field
 * report is a real incident, before any Event Group question is put.
 *
 * The coordinator used to reach the Event Group map having seen only a title,
 * a location line and a description — never the photos, never who filed it.
 * This step puts the evidence first and asks nothing; "Continue" is the only
 * decision it offers, and no disposition is preselected anywhere downstream.
 */
export default function ReportReviewDialog({
  incidentId,
  onClose,
  onContinue,
}: {
  incidentId: number;
  onClose: () => void;
  onContinue: () => void;
}) {
  const [incident, setIncident] = useState<Incident | null>(null);
  const [attachments, setAttachments] = useState<IncidentAttachment[]>([]);
  const [attachmentsFailed, setAttachmentsFailed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lightboxId, setLightboxId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    setAttachmentsFailed(false);
    (async () => {
      try {
        const detail = await api<{ incident: Incident }>(`/incidents/${incidentId}`);
        if (cancelled) return;
        setIncident(detail.incident);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "Failed to load the field report.");
      }
      try {
        // Evidence is loaded separately: a storage hiccup must not hide the
        // report itself, so the panel says the files could not be listed
        // instead of the dialog showing nothing.
        const evidence = await api<{ items: IncidentAttachment[] }>(`/incidents/${incidentId}/attachments`);
        if (!cancelled) setAttachments(evidence.items ?? []);
      } catch {
        if (!cancelled) setAttachmentsFailed(true);
      }
      if (!cancelled) setBusy(false);
    })();
    return () => { cancelled = true; };
  }, [incidentId]);

  const reviewAttachments = useMemo<ReviewAttachment[]>(
    () => attachments.map((item) => ({
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
    })),
    [attachments],
  );

  const summary = useMemo(() => summarizeEvidence(reviewAttachments), [reviewAttachments]);
  const checks = useMemo(
    () => (incident ? readinessChecks({ ...incident, road_inventory_context: incident.road_inventory_context ?? null }, reviewAttachments) : []),
    [incident, reviewAttachments],
  );
  const roadEntries = useMemo(
    () => roadSummaryEntries(incident?.road_inventory_context?.snapshot ?? null),
    [incident?.road_inventory_context],
  );
  // The dialog's own Escape handler listens on document and would close the
  // whole triage flow. While a photo is open, Escape must close the photo.
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

  const delay = incident ? reportingDelayLabel(reportingDelayHours(incident)) : null;
  const images = reviewAttachments.filter(isViewableImage);
  const otherFiles = reviewAttachments.filter((item) => !isViewableImage(item));
  const lightbox = images.find((item) => item.attachment_id === lightboxId) ?? null;

  return (
    <ModalDialog
      titleId="report-review-title"
      descriptionId="report-review-description"
      busy={busy}
      onClose={onClose}
      panelClassName="flex max-h-[92vh] w-full max-w-6xl flex-col rounded-xl border border-[var(--line)] bg-[var(--panel)] shadow-2xl"
    >
      <div className="flex items-start justify-between gap-4 border-b border-[var(--line)] px-5 py-4">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Step 1 of 3 · Review the report</div>
          <h2 id="report-review-title" className="mt-0.5 truncate text-base font-semibold">
            {incident?.title || `Field report #${incidentId}`}
          </h2>
          <p id="report-review-description" className="mt-1 max-w-3xl text-[13px] text-muted">
            Read what was reported and look at the evidence. Decide whether this is a real incident before ERIS asks where it belongs.
          </p>
        </div>
        <button type="button" onClick={onClose} disabled={busy} aria-label="Close dialog" className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 text-sm font-semibold hover:bg-[var(--panel-soft)] disabled:opacity-50">×</button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {error ? (
          <div role="alert" className="mb-4 rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div>
        ) : null}

        {!incident ? (
          <div className="py-12 text-center text-sm text-muted">{busy ? "Loading the field report…" : "The field report is unavailable."}</div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.9fr)]">
            <div className="grid content-start gap-4">
              <Panel
                title="Evidence from the field"
                hint={summary.total ? `${summary.total} file${summary.total === 1 ? "" : "s"}${summary.located ? ` · ${summary.located} with a position` : ""}` : undefined}
              >
                {attachmentsFailed ? (
                  <p className="text-sm text-[var(--bad)]">The attached files could not be listed. Open the incident record to check before deciding.</p>
                ) : images.length === 0 && otherFiles.length === 0 ? (
                  <p className="text-sm text-muted">
                    {busy ? "Loading evidence…" : "No photos or files were attached to this report. That is itself worth weighing — ask the reporter for more information if you cannot judge it from the description."}
                  </p>
                ) : (
                  <div className="grid gap-3">
                    {images.length ? (
                      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {images.map((photo) => {
                          const far = photo.latitude !== null && photo.longitude !== null
                            ? metresBetween(incident, { latitude: photo.latitude, longitude: photo.longitude })
                            : null;
                          return (
                            <li key={photo.attachment_id}>
                              <button
                                type="button"
                                onClick={() => setLightboxId(photo.attachment_id)}
                                className="group grid w-full gap-1 overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] text-left hover:border-[var(--brand)]"
                              >
                                <img src={photo.download_url} alt={photo.file_name} loading="lazy" className="h-28 w-full object-cover" />
                                <span className="grid gap-0.5 px-2 pb-2">
                                  <span className="truncate text-[11px] font-medium">{formatWhen(photo.captured_at)}</span>
                                  <span className="truncate text-[11px] text-muted">
                                    {far === null ? "No position recorded" : distanceLabel(far)}
                                  </span>
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
                              <span className="block text-[11px] text-muted">{file.kind} · {formatFileSize(file.file_size_bytes) || file.mime_type}</span>
                            </span>
                            <a href={file.download_url} target="_blank" rel="noreferrer" className="rounded border border-[var(--line)] px-2 py-1 text-[11px] font-semibold hover:bg-[var(--panel-soft)]">Open</a>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                )}
              </Panel>

              <Panel title="What was reported">
                <div className="grid gap-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Fact label="Reported as" value={incidentTypeLabel(incident.incident_type)} />
                    <Fact label="Filed by" value={incident.reporter_name || `User #${incident.reporter_user_id}`} />
                    <Fact label="First seen" value={<span className="tabular-nums">{formatWhen(incident.first_observed_at)}</span>} />
                    <Fact label="Filed" value={<span className="tabular-nums">{formatWhen(incident.created_at)}</span>} />
                    {incident.first_occurred_at ? <Fact label="Occurred" value={<span className="tabular-nums">{formatWhen(incident.first_occurred_at)}</span>} /> : null}
                  </div>
                  {delay ? <div className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-3 py-1.5 text-[13px] text-muted">{delay}</div> : null}
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Description</div>
                    <p className="mt-1 whitespace-pre-wrap text-sm">{incident.description?.trim() || "The reporter left the description empty."}</p>
                  </div>
                </div>
              </Panel>

              <Panel title="Worth a look" hint="Facts only — the decision stays yours">
                <ul className="grid gap-2">
                  {checks.map((check) => (
                    <li key={check.key} className="flex items-start gap-2.5">
                      <span
                        aria-hidden
                        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${check.status === "attention" ? "bg-[var(--warn)]" : "bg-[var(--good)]"}`}
                      />
                      <span className="min-w-0 text-sm">
                        <span className="font-semibold">{check.label}</span>
                        <span className="sr-only">{check.status === "attention" ? " — needs attention" : " — nothing to flag"}</span>
                        <span className="text-muted"> · {check.detail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>

            <div className="grid content-start gap-4">
              <Panel title="Where it is" hint={`${formatCoordinate(incident.latitude)}, ${formatCoordinate(incident.longitude)}`}>
                <div className="grid gap-3">
                  <div className="text-sm tabular-nums">{eventGroupLocationLabel(incident)}</div>
                  <EventGroupTriageMap
                    incident={{ id: incident.id, latitude: incident.latitude, longitude: incident.longitude, title: incident.title }}
                    groups={[]}
                    selectedGroupId={null}
                    selectedIncidents={[]}
                    onSelectGroup={() => {}}
                    height={260}
                  />
                </div>
              </Panel>

              <Panel title="Road at this location" hint={incident.road_inventory_context?.match_method ? `Matched by ${incident.road_inventory_context.match_method}` : undefined}>
                {roadEntries.length === 0 ? (
                  <p className="text-sm text-muted">No Road Inventory segment was matched for this location.</p>
                ) : (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                    {roadEntries.map((entry) => (
                      <div key={entry.key} className="min-w-0">
                        <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{friendlyFieldLabel(entry.key)}</dt>
                        <dd className="mt-0.5 truncate text-sm">{friendlyFieldValue(entry.key, entry.value)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </Panel>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] px-5 py-3">
        <span className="text-[12px] text-muted">Next: choose the Event Group, then record the decision.</span>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">Cancel</button>
          <button type="button" onClick={onContinue} disabled={busy || !incident} className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50">Continue to Event Group</button>
        </div>
      </div>

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
              {formatWhen(lightbox.captured_at)}
              {lightbox.horizontal_accuracy_m !== null ? ` · ±${Math.round(lightbox.horizontal_accuracy_m)} m` : ""}
              {lightbox.camera_heading_deg !== null ? ` · facing ${Math.round(lightbox.camera_heading_deg)}°` : ""}
            </div>
            <button type="button" onClick={() => setLightboxId(null)} className="mt-2 rounded border border-white/40 px-2 py-1 font-semibold">Close</button>
          </div>
        </div>
      ) : null}
    </ModalDialog>
  );
}

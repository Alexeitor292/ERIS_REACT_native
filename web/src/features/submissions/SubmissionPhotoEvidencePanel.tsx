import { useCallback, useEffect, useState } from "react";

import { formatCoordinate } from "../../utils/precision";
import { getSubmissionPhotoEvidence, type PhotoMapResponse } from "./photoEvidenceApi";

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

function formatTimestamp(value: string | null | undefined) {
  if (!value) return "Not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : dateTimeFormatter.format(parsed);
}

function formatMeters(value: number | null | undefined) {
  return value == null ? "Not recorded" : `${value.toFixed(value < 10 ? 1 : 0)} m`;
}

function sourceLabel(source: string | null | undefined) {
  if (!source) return "Not recorded";
  return source.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (letter: string) => letter.toUpperCase());
}

function EvidenceBadge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "good" | "brand" | "bad" }) {
  const classes =
    tone === "good"
      ? "border-[color:color-mix(in_oklab,var(--good)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--good)_10%,transparent)] text-[var(--good)]"
      : tone === "brand"
        ? "border-[color:color-mix(in_oklab,var(--brand)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_10%,transparent)] text-[var(--brand)]"
        : tone === "bad"
          ? "border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] text-[var(--bad)]"
          : "border-[var(--line)] bg-[var(--panel-soft)] text-muted";
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${classes}`}>{children}</span>;
}

export default function SubmissionPhotoEvidencePanel({ submissionId }: { submissionId: number }) {
  const [photoMap, setPhotoMap] = useState<PhotoMapResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageErrors, setImageErrors] = useState<Record<number, boolean>>({});

  const load = useCallback(async () => {
    if (!Number.isInteger(submissionId) || submissionId <= 0) return;
    setLoading(true);
    setError(null);
    try {
      setPhotoMap(await getSubmissionPhotoEvidence(submissionId));
      setImageErrors({});
    } catch (e: any) {
      setError(e?.message ?? "Failed to load photo evidence.");
    } finally {
      setLoading(false);
    }
  }, [submissionId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!Number.isInteger(submissionId) || submissionId <= 0) {
    return <div className="rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-5 text-sm text-muted">Invalid submission ID.</div>;
  }

  if (loading && !photoMap) {
    return <div className="rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-5 text-sm text-muted">Loading photo evidence…</div>;
  }

  return (
    <div>
      <div className="flex flex-col gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold">Photo evidence</div>
          <div className="mt-1 text-sm text-muted">Field photos with effective mapped telemetry and capture provenance.</div>
        </div>
        <button type="button" onClick={load} disabled={loading} className="self-start rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-semibold hover:bg-[var(--panel-soft)] disabled:cursor-not-allowed disabled:opacity-50 sm:self-auto">
          {loading ? "Refreshing…" : "Refresh evidence"}
        </button>
      </div>

      {error ? <div className="mt-4 rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">{error}</div> : null}

      {photoMap ? (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: "Photos", value: photoMap.summary.photos_total, hint: "Available evidence" },
              { label: "Mapped", value: photoMap.summary.photos_geotagged, hint: "Usable location" },
              { label: "With Heading", value: photoMap.summary.photos_with_heading, hint: "Usable camera direction" },
              { label: "Unmapped", value: photoMap.summary.photos_unmapped, hint: "No effective map location" },
            ].map((card) => (
              <div key={card.label} className="rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">{card.label}</div>
                <div className="mt-2 text-2xl font-semibold">{card.value}</div>
                <div className="mt-1 text-xs text-muted">{card.hint}</div>
              </div>
            ))}
          </div>

          <div className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Evidence context</div>
                <div className="mt-1 text-sm font-medium">{photoMap.incident_id ? `Linked incident #${photoMap.incident_id}` : "No linked incident"}</div>
              </div>
              <div className="text-right text-xs text-muted">
                {photoMap.incident.latitude != null && photoMap.incident.longitude != null ? (
                  <><div>Incident / submission reference location</div><div className="mt-0.5 font-medium text-[var(--ink)] tabular-nums">{formatCoordinate(photoMap.incident.latitude)}, {formatCoordinate(photoMap.incident.longitude)}</div></>
                ) : <div>No reference location recorded.</div>}
              </div>
            </div>
          </div>

          {photoMap.photos.length === 0 ? (
            <div className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-6 text-sm text-muted">No photo evidence is linked to this submission or its incident.</div>
          ) : (
            <div className="mt-4 grid gap-4 xl:grid-cols-2">
              {photoMap.photos.map((photo) => {
                const mapped = photo.latitude != null && photo.longitude != null;
                const hasHeading = photo.camera_heading_deg != null;
                const corrected = photo.correction?.has_history;
                const imageFailed = imageErrors[photo.attachment_id];
                const browserRenderable = photo.mime_type.toLowerCase().startsWith("image/");
                return (
                  <article key={photo.attachment_id} className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
                    <div className="relative flex min-h-72 items-center justify-center bg-[var(--panel-soft)]">
                      {browserRenderable && !imageFailed ? (
                        <img src={photo.download_url} alt={photo.file_name} className="max-h-[34rem] w-full object-contain" loading="lazy" onError={() => setImageErrors((previous) => ({ ...previous, [photo.attachment_id]: true }))} />
                      ) : (
                        <div className="p-6 text-center text-sm text-muted"><div className="font-semibold text-[var(--ink)]">Preview unavailable in this browser</div><div className="mt-1">The original evidence file remains available below.</div></div>
                      )}
                      <div className="absolute left-3 top-3 flex flex-wrap gap-1.5"><EvidenceBadge tone={mapped ? "good" : "bad"}>{mapped ? "Mapped" : "Unmapped"}</EvidenceBadge>{hasHeading ? <EvidenceBadge tone="brand">Heading recorded</EvidenceBadge> : null}{corrected ? <EvidenceBadge>Corrected telemetry</EvidenceBadge> : null}</div>
                    </div>

                    <div className="p-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0"><div className="truncate font-semibold" title={photo.file_name}>{photo.file_name}</div><div className="mt-1 flex flex-wrap gap-1.5 text-xs text-muted"><span>Attachment #{photo.attachment_id}</span><span>•</span><span>{photo.source_scope === "INCIDENT" ? "Incident photo" : "Submission photo"}</span>{photo.section_key ? <><span>•</span><span>Section: {photo.section_key}</span></> : null}</div></div>
                        <a href={photo.download_url} target="_blank" rel="noreferrer" className="shrink-0 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-1.5 text-sm font-semibold hover:bg-[var(--panel-soft)]">Open original</a>
                      </div>

                      <dl className="mt-4 grid gap-3 border-t border-[var(--line)] pt-4 sm:grid-cols-2">
                        <div><dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">Captured</dt><dd className="mt-1 text-sm font-medium" title={photo.captured_at ?? undefined}>{formatTimestamp(photo.captured_at)}</dd></div>
                        <div><dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">MIME Type</dt><dd className="mt-1 text-sm font-medium">{photo.mime_type || "Not recorded"}</dd></div>
                        <div><dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">Effective Location</dt><dd className="mt-1 text-sm font-medium tabular-nums">{mapped ? `${formatCoordinate(photo.latitude)}, ${formatCoordinate(photo.longitude)}` : "Not mapped"}</dd><div className="mt-0.5 text-xs text-muted">Accuracy: {formatMeters(photo.horizontal_accuracy_m)}</div></div>
                        <div><dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">Camera Heading</dt><dd className="mt-1 text-sm font-medium">{hasHeading ? `${photo.camera_heading_deg!.toFixed(1)}°` : "Not usable"}</dd><div className="mt-0.5 text-xs text-muted">{sourceLabel(photo.heading_source)}{photo.heading_reference ? ` · ${sourceLabel(photo.heading_reference)}` : ""}</div></div>
                        <div><dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">Location Source</dt><dd className="mt-1 text-sm font-medium">{sourceLabel(photo.location_source)}</dd></div>
                        <div><dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">Altitude</dt><dd className="mt-1 text-sm font-medium">{formatMeters(photo.altitude_m)}</dd></div>
                      </dl>

                      {corrected ? (
                        <details className="mt-4 rounded-lg border border-[var(--line)] bg-[var(--panel-soft)] p-3">
                          <summary className="cursor-pointer text-sm font-semibold">Telemetry correction history</summary>
                          <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                            <div><div className="text-xs text-muted">Location overridden</div><div className="font-medium">{photo.correction.location_overridden ? "Yes" : "No"}</div></div>
                            <div><div className="text-xs text-muted">Heading overridden</div><div className="font-medium">{photo.correction.heading_overridden ? "Yes" : "No"}</div></div>
                            <div><div className="text-xs text-muted">Corrected by user</div><div className="font-medium">{photo.correction.corrected_by_user_id ? `User #${photo.correction.corrected_by_user_id}` : "Not recorded"}</div></div>
                            <div><div className="text-xs text-muted">Corrected at</div><div className="font-medium" title={photo.correction.corrected_at ?? undefined}>{formatTimestamp(photo.correction.corrected_at)}</div></div>
                          </div>
                        </details>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

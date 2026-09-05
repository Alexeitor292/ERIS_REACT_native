import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppWindow, ArrowLeft, ChevronDown, Download, ExternalLink, Eye, FileText, Film, Image as ImageIcon, X } from "lucide-react";

import { api } from "../../api/client";
import type { Attachment } from "../../api/types";
import { isPdfAttachment, type AttachmentMediaKind, type SubmissionLibraryItem } from "./submissionAttachmentModel";
import { attachmentTypeLabel, formatFileSize } from "./submissionReviewerSupportModel";

/**
 * Attachment tiles shared by the per-section attachment dialog and the Submission
 * library. File bytes never pass through the API: every action resolves a short-lived
 * access URL from `GET /attachments/{id}/download-url` (cached until shortly before it
 * expires) and opens or downloads straight from object storage.
 */

const URL_TTL_MS = 10 * 60 * 1000; // presigned URLs live 900 s; refresh a bit early.

export type AttachmentUrlResolver = {
  resolve: (attachmentId: number) => Promise<string>;
  previewUrl: (attachmentId: number) => string | null;
  requestPreview: (attachmentId: number) => void;
};

export function useAttachmentUrlResolver(seedUrls?: ReadonlyMap<number, string> | null): AttachmentUrlResolver {
  const cacheRef = useRef(new Map<number, { url: string; expiresAt: number }>());
  const pendingRef = useRef(new Map<number, Promise<string>>());
  const [, bump] = useState(0);

  useEffect(() => {
    if (!seedUrls || seedUrls.size === 0) return;
    const expiresAt = Date.now() + URL_TTL_MS;
    seedUrls.forEach((url, id) => {
      if (url) cacheRef.current.set(id, { url, expiresAt });
    });
    bump((n) => n + 1);
  }, [seedUrls]);

  const previewUrl = useCallback((attachmentId: number) => {
    const cached = cacheRef.current.get(attachmentId);
    return cached && cached.expiresAt > Date.now() ? cached.url : null;
  }, []);

  const resolve = useCallback(
    async (attachmentId: number) => {
      const cached = previewUrl(attachmentId);
      if (cached) return cached;
      const pending = pendingRef.current.get(attachmentId);
      if (pending) return pending;
      const request = api<{ download_url: string }>(`/attachments/${attachmentId}/download-url`)
        .then((response) => {
          cacheRef.current.set(attachmentId, { url: response.download_url, expiresAt: Date.now() + URL_TTL_MS });
          pendingRef.current.delete(attachmentId);
          bump((n) => n + 1);
          return response.download_url;
        })
        .catch((error) => {
          pendingRef.current.delete(attachmentId);
          throw error;
        });
      pendingRef.current.set(attachmentId, request);
      return request;
    },
    [previewUrl],
  );

  const requestPreview = useCallback(
    (attachmentId: number) => {
      if (previewUrl(attachmentId) || pendingRef.current.has(attachmentId)) return;
      resolve(attachmentId).catch(() => {});
    },
    [previewUrl, resolve],
  );

  return useMemo(() => ({ resolve, previewUrl, requestPreview }), [resolve, previewUrl, requestPreview]);
}

export function openAttachmentInNewTab(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

export function openAttachmentInNewWindow(url: string) {
  window.open(url, "_blank", "popup=yes,width=1280,height=860,noopener,noreferrer");
}

export async function downloadAttachmentFile(url: string, fileName: string) {
  try {
    const response = await fetch(url, { credentials: "omit" });
    if (!response.ok) throw new Error(`Download failed (${response.status})`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = fileName || "attachment";
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 15_000);
  } catch {
    // Object storage may not allow cross-origin reads; fall back to a direct open.
    openAttachmentInNewTab(url);
  }
}

function MediaGlyph({ media, pdf }: { media: AttachmentMediaKind; pdf: boolean }) {
  const Icon = media === "photo" ? ImageIcon : media === "video" ? Film : FileText;
  return (
    <div className="flex flex-col items-center gap-1 text-muted">
      <Icon size={30} strokeWidth={1.6} aria-hidden />
      <span className="text-[11px] font-semibold uppercase tracking-wide">{pdf ? "PDF" : media === "video" ? "Video" : media === "photo" ? "Photo" : "Document"}</span>
    </div>
  );
}

function MediaBadge({ media, pdf }: { media: AttachmentMediaKind; pdf: boolean }) {
  const label = media === "photo" ? "Photo" : media === "video" ? "Video" : pdf ? "PDF" : "Document";
  return (
    <span className="inline-flex rounded-full border border-[var(--line)] bg-[color:color-mix(in_oklab,var(--panel)_88%,transparent)] px-2 py-0.5 text-[11px] font-semibold text-[var(--ink)] backdrop-blur">
      {label}
    </span>
  );
}

function SectionChip({ label }: { label: string }) {
  return (
    <span className="inline-flex max-w-[60%] truncate rounded-full border border-[color:color-mix(in_oklab,var(--brand)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_14%,var(--panel))] px-2 py-0.5 text-[11px] font-semibold text-[var(--brand)]" title={label}>
      {label}
    </span>
  );
}

type OpenTarget = "here" | "tab" | "window";

function OpenMenu({
  open,
  onToggle,
  onSelect,
  busy,
}: {
  open: boolean;
  onToggle: () => void;
  onSelect: (target: OpenTarget) => void;
  busy: boolean;
}) {
  const items: Array<{ target: OpenTarget; label: string; icon: ReactNode }> = [
    { target: "here", label: "Open here", icon: <Eye size={14} strokeWidth={1.9} aria-hidden /> },
    { target: "tab", label: "Open in a new tab", icon: <ExternalLink size={14} strokeWidth={1.9} aria-hidden /> },
    { target: "window", label: "Open in a new window", icon: <AppWindow size={14} strokeWidth={1.9} aria-hidden /> },
  ];
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-md border border-[var(--line)] bg-[color:color-mix(in_oklab,var(--panel)_92%,transparent)] px-2 py-1 text-xs font-semibold text-[var(--ink)] shadow-sm backdrop-blur hover:bg-[var(--panel)] disabled:opacity-60"
      >
        {busy ? "Opening…" : "Open"}
        <ChevronDown size={13} strokeWidth={2} aria-hidden />
      </button>
      {open ? (
        <div role="menu" className="absolute bottom-full left-0 z-20 mb-1 min-w-48 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-1 shadow-xl">
          {items.map((item) => (
            <button
              key={item.target}
              type="button"
              role="menuitem"
              onClick={() => onSelect(item.target)}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-medium hover:bg-[var(--panel-soft)]"
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function AttachmentTile({
  item,
  resolver,
  showSection,
  onOpenHere,
  onError,
}: {
  item: SubmissionLibraryItem;
  resolver: AttachmentUrlResolver;
  showSection: boolean;
  onOpenHere: (item: SubmissionLibraryItem, url: string) => void;
  onError: (message: string) => void;
}) {
  const { attachment, media, sectionLabel } = item;
  const pdf = isPdfAttachment(attachment);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState<"open" | "download" | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);
  const preview = media === "photo" ? resolver.previewUrl(attachment.id) : null;

  useEffect(() => {
    if (media === "photo") resolver.requestPreview(attachment.id);
  }, [attachment.id, media, resolver]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  async function withUrl(kind: "open" | "download", action: (url: string) => void | Promise<void>) {
    setBusy(kind);
    try {
      const url = await resolver.resolve(attachment.id);
      await action(url);
    } catch (error: any) {
      onError(error?.message ?? "Could not access this attachment.");
    } finally {
      setBusy(null);
    }
  }

  function onSelectOpen(target: OpenTarget) {
    setMenuOpen(false);
    void withUrl("open", (url) => {
      if (target === "tab") openAttachmentInNewTab(url);
      else if (target === "window") openAttachmentInNewWindow(url);
      else onOpenHere(item, url);
    });
  }

  return (
    <article
      ref={rootRef}
      className="attachment-tile relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)] transition-shadow hover:shadow-[var(--shadow)]"
      data-menu-open={menuOpen ? "true" : "false"}
    >
      <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-[var(--panel-soft)]">
        {preview && !imageFailed ? (
          <img
            src={preview}
            alt={attachment.file_name}
            loading="lazy"
            className="h-full w-full object-cover"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <MediaGlyph media={media} pdf={pdf} />
        )}
        <div className="pointer-events-none absolute inset-x-2 top-2 flex items-start justify-between gap-2">
          <MediaBadge media={media} pdf={pdf} />
          {showSection ? <SectionChip label={sectionLabel} /> : null}
        </div>
        <div className="attachment-tile-actions absolute inset-x-2 bottom-2 flex items-center justify-between gap-2">
          <OpenMenu open={menuOpen} onToggle={() => setMenuOpen((open) => !open)} onSelect={onSelectOpen} busy={busy === "open"} />
          <button
            type="button"
            disabled={busy === "download"}
            onClick={() => void withUrl("download", (url) => downloadAttachmentFile(url, attachment.file_name))}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--line)] bg-[color:color-mix(in_oklab,var(--panel)_92%,transparent)] px-2 py-1 text-xs font-semibold text-[var(--ink)] shadow-sm backdrop-blur hover:bg-[var(--panel)] disabled:opacity-60"
          >
            <Download size={13} strokeWidth={2} aria-hidden />
            {busy === "download" ? "Saving…" : "Download"}
          </button>
        </div>
      </div>
      <div className="min-w-0 px-3 py-2">
        <div className="truncate text-sm font-medium" title={attachment.file_name}>{attachment.file_name}</div>
        <div className="mt-0.5 flex flex-wrap gap-x-1.5 text-xs text-muted">
          <span>{attachmentTypeLabel(attachment)}</span>
          <span aria-hidden>·</span>
          <span title={`${attachment.file_size_bytes.toLocaleString()} bytes`}>{formatFileSize(attachment.file_size_bytes)}</span>
          <span aria-hidden>·</span>
          <span>#{attachment.id}</span>
        </div>
      </div>
    </article>
  );
}

export function AttachmentInlineViewer({
  item,
  url,
  onBack,
  onError,
}: {
  item: SubmissionLibraryItem;
  url: string;
  onBack: () => void;
  onError: (message: string) => void;
}) {
  const { attachment, media } = item;
  const pdf = isPdfAttachment(attachment);
  const [failed, setFailed] = useState(false);

  let body: ReactNode;
  if (failed) {
    body = <UnavailablePreview attachment={attachment} url={url} />;
  } else if (media === "photo") {
    body = <img src={url} alt={attachment.file_name} className="mx-auto max-h-[70vh] w-auto max-w-full rounded-lg object-contain" onError={() => setFailed(true)} />;
  } else if (media === "video") {
    body = <video src={url} controls preload="metadata" className="mx-auto max-h-[70vh] w-full rounded-lg bg-black" onError={() => setFailed(true)} />;
  } else if (pdf) {
    body = <iframe src={url} title={attachment.file_name} className="h-[70vh] w-full rounded-lg border border-[var(--line)] bg-white" />;
  } else {
    body = <UnavailablePreview attachment={attachment} url={url} />;
  }

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 text-xs font-semibold hover:bg-[var(--panel-soft)]">
          <ArrowLeft size={14} strokeWidth={2} aria-hidden />
          Back to files
        </button>
        <div className="min-w-0 flex-1 truncate text-sm font-medium" title={attachment.file_name}>{attachment.file_name}</div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => openAttachmentInNewTab(url)} className="inline-flex items-center gap-1 rounded-md border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 text-xs font-semibold hover:bg-[var(--panel-soft)]">
            <ExternalLink size={13} strokeWidth={2} aria-hidden />
            New tab
          </button>
          <button
            type="button"
            onClick={() => downloadAttachmentFile(url, attachment.file_name).catch((error: any) => onError(error?.message ?? "Download failed."))}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1.5 text-xs font-semibold hover:bg-[var(--panel-soft)]"
          >
            <Download size={13} strokeWidth={2} aria-hidden />
            Download
          </button>
        </div>
      </div>
      <div className="mt-3 rounded-xl border border-[var(--line)] bg-[var(--panel-soft)] p-2">{body}</div>
    </div>
  );
}

function UnavailablePreview({ attachment, url }: { attachment: Attachment; url: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-sm text-muted">
      <FileText size={32} strokeWidth={1.5} aria-hidden />
      <div className="font-semibold text-[var(--ink)]">Preview unavailable in this browser</div>
      <div>{attachment.mime_type || "Unknown file type"} · {formatFileSize(attachment.file_size_bytes)}</div>
      <button type="button" onClick={() => openAttachmentInNewTab(url)} className="mt-2 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-1.5 text-xs font-semibold hover:brightness-95">
        Open in a new tab
      </button>
    </div>
  );
}

export function AttachmentTileGrid({
  items,
  resolver,
  showSection,
  emptyMessage,
}: {
  items: SubmissionLibraryItem[];
  resolver: AttachmentUrlResolver;
  showSection: boolean;
  emptyMessage: string;
}) {
  const [viewer, setViewer] = useState<{ item: SubmissionLibraryItem; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (viewer && !items.some((item) => item.attachment.id === viewer.item.attachment.id)) setViewer(null);
  }, [items, viewer]);

  return (
    <div className="min-w-0">
      {error ? (
        <div className="mb-3 flex items-start justify-between gap-2 rounded-md border border-[color:color-mix(in_oklab,var(--bad)_45%,transparent)] bg-[color:color-mix(in_oklab,var(--bad)_10%,transparent)] px-3 py-2 text-sm text-[var(--bad)]">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss" className="shrink-0"><X size={14} aria-hidden /></button>
        </div>
      ) : null}
      {viewer ? (
        <AttachmentInlineViewer item={viewer.item} url={viewer.url} onBack={() => setViewer(null)} onError={setError} />
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--line)] bg-[var(--panel-soft)] px-4 py-8 text-center text-sm text-muted">{emptyMessage}</div>
      ) : (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(200px,100%),1fr))]">
          {items.map((item) => (
            <AttachmentTile
              key={item.attachment.id}
              item={item}
              resolver={resolver}
              showSection={showSection}
              onOpenHere={(target, url) => setViewer({ item: target, url })}
              onError={setError}
            />
          ))}
        </div>
      )}
    </div>
  );
}

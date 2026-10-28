import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";

import { ApiError, api } from "../../../api/client";
import type { AttachmentUrlResolver } from "../SubmissionAttachmentTiles";
import { fieldInput, fieldLabel, NumberField, Segmented } from "../gisaFields";
import {
  changesOf,
  CRACK_MEASURES,
  CRACK_ORIENTATIONS,
  crackSummary,
  crackTitle,
  draftOf,
  locationText,
  shapeText,
  trendText,
  type Crack,
  type CrackDraft,
} from "./crackModel";

const button = "inline-flex items-center gap-1 rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2.5 py-1.5 text-xs font-medium hover:brightness-95 disabled:opacity-60";
const primary = "inline-flex items-center gap-1 rounded-md bg-[var(--brand)] px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-60";

/**
 * The form's cracks: each its own record with the same fields, saved on its
 * own (not with the rest of the form), so two people can work on different
 * cracks. A crack saved by someone else since it was opened is refused by the
 * server and shown as they left it.
 */
export default function CrackList({
  submissionId,
  initial,
  canEdit,
  photos,
  resolver,
}: {
  submissionId: number;
  initial: Crack[];
  canEdit: boolean;
  photos: ReadonlyArray<{ id: number; name: string }>;
  resolver: AttachmentUrlResolver;
}) {
  const [cracks, setCracks] = useState<Crack[]>(initial);
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => setCracks(initial), [initial]);

  const replace = (next: Crack) => setCracks((list) => list.map((c) => (c.id === next.id ? next : c)));

  const add = async () => {
    setAdding(true);
    setProblem(null);
    try {
      const made = await api<{ crack: Crack }>(`/submissions/${submissionId}/cracks`, {
        method: "POST",
        body: JSON.stringify({ client_uuid: crypto.randomUUID() }),
      });
      setCracks((list) => [...list, made.crack]);
      setOpen(made.crack.id);
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="space-y-2">
      {cracks.length === 0 ? (
        <p className="text-sm text-muted">No cracks recorded. Each crack is recorded on its own, with its own measurements and photo.</p>
      ) : null}
      {cracks.map((crack, index) => (
        <CrackRow
          key={crack.id}
          crack={crack}
          index={index}
          open={open === crack.id}
          onToggle={() => setOpen(open === crack.id ? null : crack.id)}
          canEdit={canEdit}
          photos={photos}
          resolver={resolver}
          submissionId={submissionId}
          onSaved={replace}
          onDeleted={() => setCracks((list) => list.filter((c) => c.id !== crack.id))}
        />
      ))}
      {problem ? <p className="text-xs text-[var(--bad)]">{problem}</p> : null}
      {canEdit ? (
        <button type="button" className={button} onClick={() => void add()} disabled={adding}>
          <Plus size={14} /> {adding ? "Adding…" : "Add crack"}
        </button>
      ) : null}
    </div>
  );
}

function CrackRow({
  crack,
  index,
  open,
  onToggle,
  canEdit,
  photos,
  resolver,
  submissionId,
  onSaved,
  onDeleted,
}: {
  crack: Crack;
  index: number;
  open: boolean;
  onToggle: () => void;
  canEdit: boolean;
  photos: ReadonlyArray<{ id: number; name: string }>;
  resolver: AttachmentUrlResolver;
  submissionId: number;
  onSaved: (crack: Crack) => void;
  onDeleted: () => void;
}) {
  const [draft, setDraft] = useState<CrackDraft>(() => draftOf(crack));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => setDraft(draftOf(crack)), [crack]);

  const result = changesOf(crack, draft);
  const dirty = "changes" in result ? Object.keys(result.changes).length > 0 : true;
  const set = (patch: Partial<CrackDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const save = async () => {
    if ("error" in result) {
      setMessage(result.error);
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const saved = await api<{ crack: Crack }>(`/submissions/${submissionId}/cracks/${crack.id}`, {
        method: "PATCH",
        body: JSON.stringify({ revision: crack.revision, ...result.changes }),
      });
      onSaved(saved.crack);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const theirs = (error.detail as { crack?: Crack } | undefined)?.crack;
        if (theirs) onSaved(theirs);
        setMessage("Someone else saved this crack after you opened it. It now shows their version; make your change again.");
      } else {
        setMessage((error as Error).message);
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      await api(`/submissions/${submissionId}/cracks/${crack.id}`, { method: "DELETE" });
      onDeleted();
    } catch (error) {
      setMessage((error as Error).message);
      setSaving(false);
    }
  };

  const where = locationText(crack);
  return (
    <div className="rounded-lg border border-[var(--line)] bg-[var(--panel)]">
      <button type="button" className="flex w-full items-start gap-2 px-3 py-2 text-left" onClick={onToggle} aria-expanded={open}>
        {open ? <ChevronDown size={16} className="mt-0.5 shrink-0" /> : <ChevronRight size={16} className="mt-0.5 shrink-0" />}
        <span className="min-w-0">
          <span className="block text-sm font-semibold">{crackTitle(crack, index)}</span>
          <span className="block text-xs text-muted">{crackSummary(crack)}</span>
        </span>
      </button>
      {open ? (
        <div className="space-y-3 border-t border-[var(--line)] px-3 py-3">
          {crack.photo_attachment_id ? (
            <AnnotatedPhoto crack={crack} attachmentId={crack.photo_attachment_id} resolver={resolver} />
          ) : null}
          <fieldset disabled={!canEdit || saving} className="space-y-3">
            <div className="grid gap-x-4 gap-y-2 @lg:grid-cols-2">
              <label className="block">
                <span className={fieldLabel}>Name</span>
                <input className={fieldInput} value={draft.label} placeholder={`Crack ${index + 1}`} maxLength={80}
                  onChange={(event) => set({ label: event.target.value })} />
              </label>
              <label className="block">
                <span className={fieldLabel}>Photo</span>
                <select className={fieldInput} value={draft.photo_attachment_id ?? ""}
                  onChange={(event) => set({ photo_attachment_id: event.target.value ? Number(event.target.value) : null })}>
                  <option value="">No photo</option>
                  {photos.map((photo) => <option key={photo.id} value={photo.id}>{photo.name}</option>)}
                </select>
              </label>
              {CRACK_MEASURES.map((measure) => (
                <NumberField key={measure.key} label={measure.label} unit={measure.unit} value={draft[measure.key]}
                  onChange={(value) => set({ [measure.key]: value } as Partial<CrackDraft>)} />
              ))}
              <NumberField label="Direction (compass)" unit="°" value={draft.trend_deg} onChange={(value) => set({ trend_deg: value })} />
            </div>
            {trendText(Number(draft.trend_deg)) && draft.trend_deg.trim() ? (
              <p className="text-xs text-muted">Runs {trendText(Number(draft.trend_deg))}</p>
            ) : null}
            <div>
              <span className={fieldLabel}>Orientation to the roadway</span>
              <Segmented label="Orientation to the roadway" options={CRACK_ORIENTATIONS} value={draft.orientation}
                onChange={(value) => set({ orientation: draft.orientation === value ? "" : (value as CrackDraft["orientation"]) })} />
            </div>
            <div className="grid gap-x-4 gap-y-2 @lg:grid-cols-2">
              <NumberField label="Latitude" unit="°" value={draft.latitude} onChange={(value) => set({ latitude: value })} />
              <NumberField label="Longitude" unit="°" value={draft.longitude} onChange={(value) => set({ longitude: value })} />
            </div>
            {where ? <p className="text-xs text-muted">Saved location: {where}</p> : null}
            <label className="block">
              <span className={fieldLabel}>Notes</span>
              <textarea className={`${fieldInput} min-h-[64px]`} value={draft.notes} onChange={(event) => set({ notes: event.target.value })} />
            </label>
          </fieldset>
          {message ? <p className="text-xs text-[var(--bad)]">{message}</p> : null}
          {canEdit ? (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={primary} onClick={() => void save()} disabled={saving || !dirty}>
                {saving ? "Saving…" : "Save crack"}
              </button>
              {dirty ? (
                <button type="button" className={button} onClick={() => { setDraft(draftOf(crack)); setMessage(null); }} disabled={saving}>
                  Undo changes
                </button>
              ) : null}
              <span className="flex-1" />
              {confirmDelete ? (
                <>
                  <span className="text-xs">Delete {crackTitle(crack, index)}? Its photo stays on the form.</span>
                  <button type="button" className={button} onClick={() => void remove()} disabled={saving}>Delete</button>
                  <button type="button" className={button} onClick={() => setConfirmDelete(false)}>Keep</button>
                </>
              ) : (
                <button type="button" className={button} onClick={() => setConfirmDelete(true)} disabled={saving}>
                  <Trash2 size={14} /> Delete
                </button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The crack's photo with its drawn shapes and labels laid over it. */
function AnnotatedPhoto({ crack, attachmentId, resolver }: { crack: Crack; attachmentId: number; resolver: AttachmentUrlResolver }) {
  const url = resolver.previewUrl(attachmentId);
  useEffect(() => {
    if (!url) resolver.requestPreview(attachmentId);
  }, [attachmentId, url, resolver]);
  const shapes = crack.annotations_json?.shapes ?? [];
  return (
    <figure className="relative overflow-hidden rounded-md border border-[var(--line)] bg-[var(--panel-soft)]">
      {url ? <img src={url} alt={`Photo of ${crackTitle(crack, crack.sort_order - 1)}`} className="block w-full" /> : (
        <div className="aspect-[4/3] w-full animate-pulse" />
      )}
      {url && shapes.length ? (
        <>
          <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <marker id={`crack-arrow-${crack.id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="#ffcc33" />
              </marker>
            </defs>
            {shapes.map((shape, i) => shape.type === "label" ? null : (
              <polyline key={i} points={shape.points.map(([x, y]) => `${x},${y}`).join(" ")} fill="none"
                stroke={shape.color ?? "#ffcc33"} strokeWidth={3} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round"
                markerEnd={shape.type === "arrow" ? `url(#crack-arrow-${crack.id})` : undefined}
                markerStart={shape.type === "arrow" ? `url(#crack-arrow-${crack.id})` : undefined} />
            ))}
          </svg>
          {shapes.map((shape, i) => {
            const words = shapeText(shape, crack);
            if (!words) return null;
            const [x, y] = shape.type === "label" ? shape.at : shape.points[Math.floor(shape.points.length / 2)];
            return (
              <span key={`label-${i}`} className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold text-white"
                style={{ left: `${x * 100}%`, top: `${y * 100}%` }}>
                {words}
              </span>
            );
          })}
        </>
      ) : null}
      <figcaption className="sr-only">{shapes.map((shape) => shapeText(shape, crack)).filter(Boolean).join("; ")}</figcaption>
    </figure>
  );
}

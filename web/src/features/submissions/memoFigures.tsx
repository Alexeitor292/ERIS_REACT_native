import { mergeAttributes, Node, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { ImageOff, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";

import { figureText, type FigureEntry } from "./memoFigureModel";

/**
 * Figures and citations in a memo (memoFigureModel.ts has the numbering and
 * the stored HTML). A figure shows the photo itself, uploaded to the form, with
 * its caption; a citation reads "Figure 1.1" and follows its figure wherever it
 * moves. The page hands each editor a context: the memo's number, every memo's
 * figures, and how to fetch a photo.
 */

export type FigureContext = {
  /** This memo's place in the numbering (Observations 1, …). */
  memoNumber: number;
  /** Every memo's figures, by attachment id. */
  registry: Map<number, FigureEntry>;
  resolveUrl: (attachmentId: number) => Promise<string>;
};

/** What a memo editor needs from the page for figures and Word files. */
export type MemoFigureTools = {
  /** Which memo (observations_notes, …), for its numbering and its photo section. */
  memoKey: string;
  registry: Map<number, FigureEntry>;
  /** The form's photos to pick from, newest first. */
  photos: Array<{ id: number; name: string }>;
  /** A thumbnail already loaded, or null (then requestThumb asks for it). */
  thumbUrl: (attachmentId: number) => string | null;
  requestThumb: (attachmentId: number) => void;
  resolveUrl: (attachmentId: number) => Promise<string>;
  /** Uploads a picture to this memo's section; resolves with its attachment id. */
  uploadPhoto: ((file: File) => Promise<number>) | null;
};

type FigureStorage ={ context: FigureContext | null; listeners: Set<() => void> };

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    memoFigure: {
      /** A photo of the form as a figure, with its caption. */
      insertMemoFigure: (attrs: { attachmentId: number; caption?: string }) => ReturnType;
      /** "Figure 1.1" pointing at a figure. */
      insertFigureRef: (attachmentId: number) => ReturnType;
    };
  }
}

function storageOf(editor: Editor): FigureStorage {
  return (editor.storage as unknown as { memoFigure: FigureStorage }).memoFigure;
}

/** Hand the editor its figure context (and redraw the figures and citations). */
export function setFigureContext(editor: Editor | null, context: FigureContext | null) {
  if (!editor || editor.isDestroyed) return;
  const storage = storageOf(editor);
  storage.context = context;
  storage.listeners.forEach((listener) => listener());
}

function useFigureContext(editor: Editor): FigureContext | null {
  const storage = storageOf(editor);
  return useSyncExternalStore(
    (listener) => {
      storage.listeners.add(listener);
      return () => storage.listeners.delete(listener);
    },
    () => storage.context,
  );
}

function FigureView({ node, editor, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const context = useFigureContext(editor);
  const attachmentId = Number(node.attrs.attachmentId);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    if (!context || !attachmentId) return;
    context.resolveUrl(attachmentId).then(
      (resolved) => !cancelled && setUrl(resolved),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [attachmentId, context]);
  const label = node.attrs.label || context?.registry.get(attachmentId)?.label || "";
  const stored = Number(node.attrs.width) || 100;
  const editable = editor.isEditable;
  // Dragging a corner resizes like Word: live while dragging, saved on release.
  const figureRef = useRef<HTMLElement | null>(null);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? stored;
  const startResize = (side: "left" | "right") => (event: ReactPointerEvent<HTMLSpanElement>) => {
    const frame = figureRef.current;
    const box = event.currentTarget.parentElement;
    if (!frame || !box) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startPx = box.getBoundingClientRect().width;
    const fullPx = frame.getBoundingClientRect().width || 1;
    let latest = stored;
    // The figure is centred, so one side moving by d changes its width by 2d.
    const onMove = (move: PointerEvent) => {
      const dx = (move.clientX - startX) * (side === "right" ? 1 : -1);
      latest = Math.max(10, Math.min(100, Math.round(((startPx + 2 * dx) / fullPx) * 100)));
      setDragWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragWidth(null);
      if (latest !== stored) updateAttributes({ width: latest });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const handle = (corner: string, side: "left" | "right", cursor: string) => (
    <span
      aria-hidden
      draggable={false}
      onPointerDown={startResize(side)}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      className={`absolute ${corner} z-10 h-3 w-3 rounded-sm border-2 border-white bg-[var(--accent)] shadow ${selected || dragWidth != null ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
      style={{ cursor, touchAction: "none" }}
    />
  );

  return (
    <NodeViewWrapper
      as="figure"
      data-figure-view={attachmentId}
      ref={figureRef}
      className={`eris-memo-figure my-3 rounded-lg p-1 ${selected && editable ? "ring-2 ring-[var(--accent)]" : ""}`}
      contentEditable={false}
    >
      <div className="group relative mx-auto" style={{ width: `${width}%` }} data-drag-handle>
        {editable ? (
          <>
            {handle("-left-1.5 -top-1.5", "left", "nwse-resize")}
            {handle("-right-1.5 -top-1.5", "right", "nesw-resize")}
            {handle("-left-1.5 -bottom-1.5", "left", "nesw-resize")}
            {handle("-right-1.5 -bottom-1.5", "right", "nwse-resize")}
          </>
        ) : null}
        {dragWidth != null ? (
          <span className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white">{dragWidth}%</span>
        ) : null}
        {url && !failed ? (
          <img src={url} alt={node.attrs.caption || "Figure"} className="block h-auto w-full rounded border border-[var(--line)]" onError={() => setFailed(true)} />
        ) : (
          <div className="flex aspect-[4/3] w-full items-center justify-center gap-2 rounded border border-dashed border-[var(--line)] text-xs text-muted">
            {failed ? <><ImageOff size={16} /> Photo #{attachmentId} is not available</> : "Loading photo…"}
          </div>
        )}
      </div>
      <figcaption className="mx-auto mt-1.5 flex items-baseline gap-1.5 text-sm" style={{ width: `${width}%` }}>
        <span className="shrink-0 font-semibold">{figureText(label)}.</span>
        {editable ? (
          <input
            value={node.attrs.caption ?? ""}
            onChange={(event) => updateAttributes({ caption: event.target.value })}
            placeholder="Caption"
            className="min-w-0 flex-1 border-b border-transparent bg-transparent italic outline-none focus:border-[var(--accent)]"
          />
        ) : (
          <span className="italic">{node.attrs.caption}</span>
        )}
      </figcaption>
      {selected && editable ? (
        <div className="mt-1 flex items-center justify-center gap-1 text-xs">
          {[25, 50, 75, 100].map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => updateAttributes({ width: w })}
              className={`rounded border px-2 py-0.5 ${w === stored ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--line)]"}`}
            >
              {w}%
            </button>
          ))}
          <button type="button" onClick={deleteNode} className="ml-2 inline-flex items-center gap-1 rounded border border-[var(--line)] px-2 py-0.5 text-[var(--bad)]">
            <Trash2 size={12} /> Remove
          </button>
        </div>
      ) : null}
    </NodeViewWrapper>
  );
}

function RefView({ node, editor, selected }: NodeViewProps) {
  const context = useFigureContext(editor);
  const target = Number(node.attrs.target);
  const label = context?.registry.get(target)?.label ?? node.attrs.label;
  const caption = context?.registry.get(target)?.caption;
  return (
    <NodeViewWrapper
      as="span"
      className={`eris-figure-ref cursor-pointer rounded px-0.5 font-medium text-[var(--accent)] underline decoration-dotted underline-offset-2 ${selected ? "bg-[color:color-mix(in_oklab,var(--accent)_15%,transparent)]" : ""}`}
      title={caption ? `${figureText(label)}. ${caption}` : "The cited figure is not in the memos"}
      onClick={() => document.querySelector(`[data-figure-view="${target}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
    >
      {figureText(label)}
    </NodeViewWrapper>
  );
}

export const MemoFigure = Node.create({
  name: "memoFigure",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addStorage() {
    return { context: null, listeners: new Set() } as FigureStorage;
  },

  addAttributes() {
    return {
      attachmentId: {
        default: null,
        parseHTML: (el) => Number(el.getAttribute("data-figure")) || null,
        renderHTML: (attrs) => ({ "data-figure": attrs.attachmentId }),
      },
      caption: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-caption") ?? "",
        renderHTML: (attrs) => ({ "data-caption": attrs.caption ?? "" }),
      },
      width: {
        default: 100,
        parseHTML: (el) => Number(el.getAttribute("data-width")) || 100,
        renderHTML: (attrs) => ({ "data-width": attrs.width }),
      },
      label: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-label") ?? "",
        renderHTML: (attrs) => ({ "data-label": attrs.label ?? "" }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "figure[data-figure]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    // The caption is written out too, for the plain-text copy (PDF, mobile app).
    return ["figure", mergeAttributes(HTMLAttributes), ["figcaption", {}, `${figureText(node.attrs.label)}. ${node.attrs.caption ?? ""}`.trim()]];
  },

  addNodeView() {
    return ReactNodeViewRenderer(FigureView);
  },

  addCommands() {
    return {
      insertMemoFigure:
        ({ attachmentId, caption }) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { attachmentId, caption: caption ?? "", width: 100 } }),
      insertFigureRef:
        (attachmentId) =>
        ({ commands }) =>
          commands.insertContent([{ type: "memoFigureRef", attrs: { target: attachmentId } }, { type: "text", text: " " }]),
    };
  },

  addProseMirrorPlugins() {
    const storage = this.storage as FigureStorage;
    // Numbers: this memo's figures in order (1.1, 1.2…); citations follow their figure.
    return [
      new Plugin({
        key: new PluginKey("memoFigureNumbers"),
        appendTransaction: (transactions, _old, state) => {
          const context = storage.context;
          if (!context || !transactions.some((tr) => tr.docChanged)) return null;
          const local = new Map<number, string>();
          const updates: Array<{ pos: number; attrs: Record<string, unknown> }> = [];
          let n = 0;
          state.doc.descendants((node, pos) => {
            if (node.type.name !== "memoFigure") return;
            n += 1;
            const label = `${context.memoNumber}.${n}`;
            const id = Number(node.attrs.attachmentId);
            if (!local.has(id)) local.set(id, label);
            if (node.attrs.label !== label) updates.push({ pos, attrs: { ...node.attrs, label } });
          });
          state.doc.descendants((node, pos) => {
            if (node.type.name !== "memoFigureRef") return;
            const target = Number(node.attrs.target);
            const label = local.get(target) ?? context.registry.get(target)?.label ?? "";
            if (node.attrs.label !== label) updates.push({ pos, attrs: { ...node.attrs, label } });
          });
          if (!updates.length) return null;
          const tr = state.tr;
          for (const update of updates) tr.setNodeMarkup(update.pos, undefined, update.attrs);
          return tr;
        },
      }),
    ];
  },
});

export const MemoFigureRef = Node.create({
  name: "memoFigureRef",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      target: {
        default: null,
        parseHTML: (el) => Number(el.getAttribute("data-figure-ref")) || null,
        renderHTML: (attrs) => ({ "data-figure-ref": attrs.target }),
      },
      label: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-label") ?? "",
        renderHTML: (attrs) => ({ "data-label": attrs.label ?? "" }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-figure-ref]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), figureText(node.attrs.label)];
  },

  renderText({ node }) {
    return figureText(node.attrs.label);
  },

  addNodeView() {
    return ReactNodeViewRenderer(RefView);
  },
});

import { useEffect, useRef, useState, type ReactNode } from "react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import Highlight from "@tiptap/extension-highlight";
import { TextStyleKit } from "@tiptap/extension-text-style";
import { TableKit } from "@tiptap/extension-table";
import { CharacterCount, Placeholder } from "@tiptap/extensions";
import DOMPurify from "dompurify";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  Eraser,
  Highlighter,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  Strikethrough,
  Table2,
  Underline,
  Undo2,
} from "lucide-react";

type Props = {
  value: string;
  onChange: (html: string) => void;
  editable: boolean;
  placeholder: string;
  /** Taller page for the full-screen view. */
  tall?: boolean;
};

const TEXT_COLORS = ["#111827", "#b91c1c", "#c2410c", "#a16207", "#15803d", "#0f766e", "#1d4ed8", "#7e22ce"];
const HIGHLIGHTS = ["#fef08a", "#bbf7d0", "#bfdbfe", "#fbcfe8", "#fed7aa"];

/** Stored memos are sanitized by the server; sanitize again before they reach the editor. */
const clean = (html: string) => DOMPurify.sanitize(html || "", { USE_PROFILES: { html: true } });

/**
 * A word-processor for one memo: a ribbon of formatting tools over a page.
 * Read-only viewers get the page alone.
 */
export default function RichMemoEditor({ value, onChange, editable, placeholder, tall = false }: Props) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true, protocols: ["http", "https", "mailto"] },
      }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Highlight.configure({ multicolor: true }),
      TextStyleKit,
      TableKit.configure({ table: { resizable: true } }),
      Placeholder.configure({ placeholder }),
      CharacterCount,
    ],
    content: clean(value),
    editable,
    onUpdate: ({ editor: current }) => onChangeRef.current(current.isEmpty ? "" : current.getHTML()),
  });

  // Content that changes from outside (the form loads, another memo is picked).
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const next = clean(value);
    const current = editor.isEmpty ? "" : editor.getHTML();
    if (next !== current) editor.commands.setContent(next, { emitUpdate: false });
  }, [editor, value]);

  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.setEditable(editable);
  }, [editor, editable]);

  const words = useEditorState({
    editor,
    selector: ({ editor: current }) => (current ? current.storage.characterCount.words() : 0),
  });

  return (
    <div className="eris-memo overflow-hidden rounded-xl border border-[var(--line)]">
      {editable && editor ? <Ribbon editor={editor} /> : null}
      <div className="eris-memo-desk">
        <div className={`eris-memo-page ${tall ? "eris-memo-page--tall" : ""}`}>
          <EditorContent editor={editor} />
        </div>
      </div>
      <div className="flex items-center justify-between border-t border-[var(--line)] bg-[var(--panel)] px-3 py-1.5 text-[11px] text-muted">
        <span>
          {words} {words === 1 ? "word" : "words"}
        </span>
        <span>{editable ? "Saved with the form" : "Read only"}</span>
      </div>
    </div>
  );
}

function Ribbon({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      quote: e.isActive("blockquote"),
      link: e.isActive("link"),
      table: e.isActive("table"),
      align: (["center", "right", "justify"] as const).find((a) => e.isActive({ textAlign: a })) ?? "left",
      block: e.isActive("heading", { level: 1 }) ? "h1" : e.isActive("heading", { level: 2 }) ? "h2" : e.isActive("heading", { level: 3 }) ? "h3" : "p",
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const chain = () => editor.chain().focus();

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-[var(--line)] bg-[var(--panel)] px-2 py-1.5" role="toolbar" aria-label="Formatting">
      <Group>
        <Tool label="Undo" onClick={() => chain().undo().run()} disabled={!s.canUndo}><Undo2 size={15} /></Tool>
        <Tool label="Redo" onClick={() => chain().redo().run()} disabled={!s.canRedo}><Redo2 size={15} /></Tool>
      </Group>
      <Group>
        <select
          aria-label="Text style"
          className="h-7 rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-1.5 text-xs"
          value={s.block}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "p") chain().setParagraph().run();
            else chain().toggleHeading({ level: Number(value.slice(1)) as 1 | 2 | 3 }).run();
          }}
        >
          <option value="p">Normal text</option>
          <option value="h1">Heading 1</option>
          <option value="h2">Heading 2</option>
          <option value="h3">Heading 3</option>
        </select>
      </Group>
      <Group>
        <Tool label="Bold" active={s.bold} onClick={() => chain().toggleBold().run()}><Bold size={15} /></Tool>
        <Tool label="Italic" active={s.italic} onClick={() => chain().toggleItalic().run()}><Italic size={15} /></Tool>
        <Tool label="Underline" active={s.underline} onClick={() => chain().toggleUnderline().run()}><Underline size={15} /></Tool>
        <Tool label="Strikethrough" active={s.strike} onClick={() => chain().toggleStrike().run()}><Strikethrough size={15} /></Tool>
        <Swatches
          label="Text color"
          icon={<Baseline size={15} />}
          colors={TEXT_COLORS}
          onPick={(color) => chain().setColor(color).run()}
          onClear={() => chain().unsetColor().run()}
        />
        <Swatches
          label="Highlight"
          icon={<Highlighter size={15} />}
          colors={HIGHLIGHTS}
          onPick={(color) => chain().setHighlight({ color }).run()}
          onClear={() => chain().unsetHighlight().run()}
        />
      </Group>
      <Group>
        <Tool label="Bulleted list" active={s.bullet} onClick={() => chain().toggleBulletList().run()}><List size={15} /></Tool>
        <Tool label="Numbered list" active={s.ordered} onClick={() => chain().toggleOrderedList().run()}><ListOrdered size={15} /></Tool>
        <Tool label="Quote" active={s.quote} onClick={() => chain().toggleBlockquote().run()}><Quote size={15} /></Tool>
      </Group>
      <Group>
        <Tool label="Align left" active={s.align === "left"} onClick={() => chain().setTextAlign("left").run()}><AlignLeft size={15} /></Tool>
        <Tool label="Center" active={s.align === "center"} onClick={() => chain().setTextAlign("center").run()}><AlignCenter size={15} /></Tool>
        <Tool label="Align right" active={s.align === "right"} onClick={() => chain().setTextAlign("right").run()}><AlignRight size={15} /></Tool>
        <Tool label="Justify" active={s.align === "justify"} onClick={() => chain().setTextAlign("justify").run()}><AlignJustify size={15} /></Tool>
      </Group>
      <Group>
        <Tool label="Insert table" active={s.table} onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><Table2 size={15} /></Tool>
        <LinkTool editor={editor} active={s.link} />
        <Tool label="Horizontal line" onClick={() => chain().setHorizontalRule().run()}><Minus size={15} /></Tool>
        <Tool label="Clear formatting" onClick={() => chain().unsetAllMarks().clearNodes().run()}><Eraser size={15} /></Tool>
      </Group>
      {s.table ? (
        <div className="flex w-full flex-wrap items-center gap-1 border-t border-[var(--line)] pt-1.5 text-[11px]">
          <span className="mr-1 font-semibold uppercase tracking-wide text-muted">Table</span>
          <TextTool onClick={() => chain().addRowBefore().run()}>Row above</TextTool>
          <TextTool onClick={() => chain().addRowAfter().run()}>Row below</TextTool>
          <TextTool onClick={() => chain().addColumnBefore().run()}>Column left</TextTool>
          <TextTool onClick={() => chain().addColumnAfter().run()}>Column right</TextTool>
          <TextTool onClick={() => chain().toggleHeaderRow().run()}>Header row</TextTool>
          <TextTool onClick={() => chain().deleteRow().run()}>Delete row</TextTool>
          <TextTool onClick={() => chain().deleteColumn().run()}>Delete column</TextTool>
          <TextTool onClick={() => chain().deleteTable().run()} danger>Delete table</TextTool>
        </div>
      ) : null}
    </div>
  );
}

function Group({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-0.5 border-r border-[var(--line)] pr-1 last:border-r-0">{children}</div>;
}

function Tool({ label, active = false, disabled = false, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-35 ${
        active ? "bg-[color:color-mix(in_oklab,var(--accent)_16%,transparent)] text-[var(--accent)]" : "text-[var(--ink)] hover:bg-[var(--panel-soft)]"
      }`}
    >
      {children}
    </button>
  );
}

function TextTool({ onClick, danger = false, children }: { onClick: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={`rounded-md border border-[var(--line)] px-2 py-0.5 hover:bg-[var(--panel-soft)] ${danger ? "text-[var(--bad)]" : ""}`}
    >
      {children}
    </button>
  );
}

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return { open, setOpen, ref };
}

function Swatches({ label, icon, colors, onPick, onClear }: { label: string; icon: ReactNode; colors: string[]; onPick: (color: string) => void; onClear: () => void }) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div ref={ref} className="relative">
      <Tool label={label} active={open} onClick={() => setOpen(!open)}>{icon}</Tool>
      {open ? (
        <div className="absolute left-0 z-30 mt-1 flex items-center gap-1 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-1.5 shadow-lg">
          {colors.map((color) => (
            <button
              key={color}
              type="button"
              title={color}
              aria-label={`${label} ${color}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onPick(color);
                setOpen(false);
              }}
              className="h-5 w-5 rounded-full border border-[var(--line)]"
              style={{ background: color }}
            />
          ))}
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onClear();
              setOpen(false);
            }}
            className="ml-1 rounded-md px-1.5 text-[11px] text-muted hover:bg-[var(--panel-soft)]"
          >
            None
          </button>
        </div>
      ) : null}
    </div>
  );
}

function LinkTool({ editor, active }: { editor: Editor; active: boolean }) {
  const { open, setOpen, ref } = usePopover();
  const [url, setUrl] = useState("");
  const apply = () => {
    const href = url.trim();
    const chain = editor.chain().focus().extendMarkRange("link");
    if (!href) chain.unsetLink().run();
    else chain.setLink({ href: /^(https?:|mailto:)/i.test(href) ? href : `https://${href}` }).run();
    setOpen(false);
  };
  return (
    <div ref={ref} className="relative">
      <Tool
        label="Link"
        active={active || open}
        onClick={() => {
          setUrl(editor.getAttributes("link").href ?? "");
          setOpen(!open);
        }}
      >
        <Link2 size={15} />
      </Tool>
      {open ? (
        <form
          className="absolute left-0 z-30 mt-1 flex w-72 items-center gap-1 rounded-lg border border-[var(--line)] bg-[var(--panel)] p-1.5 shadow-lg"
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
        >
          <input
            autoFocus
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://…"
            aria-label="Link address"
            className="min-w-0 flex-1 rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1 text-xs"
          />
          <button type="submit" className="rounded-md bg-[var(--accent)] px-2 py-1 text-xs font-medium text-white">
            {url.trim() ? "Apply" : "Remove"}
          </button>
        </form>
      ) : null}
    </div>
  );
}

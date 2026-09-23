import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import Highlight from "@tiptap/extension-highlight";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TextStyleKit } from "@tiptap/extension-text-style";
import { TableKit } from "@tiptap/extension-table";
import { CharacterCount, Placeholder } from "@tiptap/extensions";
import DOMPurify from "dompurify";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  Baseline,
  Bold,
  CalendarDays,
  ChevronDown,
  Code2,
  Columns2,
  Eraser,
  Heading,
  Highlighter,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link2,
  Link2Off,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  PaintBucket,
  Printer,
  Quote,
  Redo2,
  Replace,
  Rows2,
  Search,
  Sigma,
  SplitSquareHorizontal,
  Strikethrough,
  Subscript as SubscriptIcon,
  Superscript as SuperscriptIcon,
  Table2,
  TableCellsMerge,
  Trash2,
  Underline,
  Undo2,
  WrapText,
} from "lucide-react";

import { BlockFormatting, ShadedTableCell, ShadedTableHeader } from "./memoEditorExtensions";

type Props = {
  value: string;
  onChange: (html: string) => void;
  editable: boolean;
  placeholder: string;
  /** Shown on printouts. */
  documentTitle: string;
  /** Taller writing area for the full-screen view. */
  tall?: boolean;
};

const FONT_FAMILIES = [
  { label: "Default", value: "" },
  { label: "Arial", value: "Arial, Helvetica, sans-serif" },
  { label: "Calibri", value: "Calibri, Carlito, sans-serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Times New Roman", value: "'Times New Roman', Times, serif" },
  { label: "Verdana", value: "Verdana, Geneva, sans-serif" },
  { label: "Courier New", value: "'Courier New', Courier, monospace" },
];
const FONT_SIZES = ["8", "9", "10", "11", "12", "14", "16", "18", "20", "24", "28", "32", "36", "48"];
const LINE_SPACINGS = ["1", "1.15", "1.5", "2", "2.5", "3"];

// Word's layout: a row of theme colors, then lighter and darker tints, then standard colors.
const PALETTE = [
  ["#000000", "#434343", "#666666", "#999999", "#b7b7b7", "#cccccc", "#d9d9d9", "#efefef", "#f3f3f3", "#ffffff"],
  ["#980000", "#ff0000", "#ff9900", "#ffff00", "#00ff00", "#00ffff", "#4a86e8", "#0000ff", "#9900ff", "#ff00ff"],
  ["#e6b8af", "#f4cccc", "#fce5cd", "#fff2cc", "#d9ead3", "#d0e0e3", "#c9daf8", "#cfe2f3", "#d9d2e9", "#ead1dc"],
  ["#cc4125", "#e06666", "#f6b26b", "#ffd966", "#93c47d", "#76a5af", "#6d9eeb", "#6fa8dc", "#8e7cc3", "#c27ba0"],
  ["#85200c", "#990000", "#b45f06", "#bf9000", "#38761d", "#134f5c", "#1155cc", "#0b5394", "#351c75", "#741b47"],
];
const HIGHLIGHTS = ["#fff59d", "#c5e1a5", "#80deea", "#90caf9", "#ce93d8", "#f48fb1", "#ffcc80", "#bcaaa4", "#e0e0e0"];

// Symbols a geotechnical memo actually needs.
const SYMBOLS = ["°", "±", "×", "÷", "≈", "≠", "≤", "≥", "′", "″", "µ", "²", "³", "½", "¼", "¾", "Δ", "θ", "α", "β", "γ", "σ", "τ", "φ", "ψ", "Ω", "→", "←", "↑", "↓", "✓", "✗", "•", "—", "§", "¶"];

type TabKey = "home" | "insert" | "table" | "review";

/** Stored memos are sanitized by the server; sanitize again before they reach the editor. */
const clean = (html: string) => DOMPurify.sanitize(html || "", { USE_PROFILES: { html: true } });

/**
 * A word processor for one memo: a tabbed ribbon (Home, Insert, Table, Review)
 * over a writing surface that fills the container. Read-only viewers get the
 * document alone.
 */
export default function RichMemoEditor({ value, onChange, editable, placeholder, documentTitle, tall = false }: Props) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
        link: { openOnClick: false, autolink: true, protocols: ["http", "https", "mailto"] },
      }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Highlight.configure({ multicolor: true }),
      Subscript,
      Superscript,
      TaskList,
      TaskItem.configure({ nested: true }),
      TextStyleKit,
      BlockFormatting,
      TableKit.configure({ table: { resizable: true }, tableCell: false, tableHeader: false }),
      ShadedTableCell,
      ShadedTableHeader,
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

  const [ribbonTab, setRibbonTab] = useState<TabKey>("home");
  const [findOpen, setFindOpen] = useState(false);

  const stats = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      current
        ? { words: current.storage.characterCount.words(), characters: current.storage.characterCount.characters() }
        : { words: 0, characters: 0 },
  });

  return (
    <div className="eris-memo rounded-xl border border-[var(--line)] bg-[var(--panel)]">
      {editable && editor ? (
        <Ribbon
          editor={editor}
          documentTitle={documentTitle}
          tab={ribbonTab}
          setTab={setRibbonTab}
          findOpen={findOpen}
          setFindOpen={setFindOpen}
          pinned={tall ? "top-0" : "top-16"}
        />
      ) : null}
      <div
        className={`eris-memo-surface ${tall ? "eris-memo-surface--tall" : ""}`}
        onKeyDownCapture={(event) => {
          // Ctrl+F in the memo opens Find here instead of the browser's search.
          if (editable && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
            event.preventDefault();
            setRibbonTab("review");
            setFindOpen(true);
          }
        }}
      >
        <EditorContent editor={editor} />
      </div>
      <div className="flex items-center justify-between gap-3 rounded-b-xl border-t border-[var(--line)] bg-[var(--panel-soft)] px-4 py-1.5 text-[11px] text-muted">
        <span>
          {stats?.words ?? 0} words · {stats?.characters ?? 0} characters
        </span>
        <span>{editable ? "Saved with the form" : "Read only"}</span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Ribbon
 * ------------------------------------------------------------------------- */

function Ribbon({
  editor,
  documentTitle,
  tab,
  setTab,
  findOpen,
  setFindOpen,
  pinned,
}: {
  editor: Editor;
  documentTitle: string;
  tab: TabKey;
  setTab: (tab: TabKey) => void;
  findOpen: boolean;
  setFindOpen: (open: boolean) => void;
  /** Where the ribbon pins while the memo scrolls (below the app header on the page). */
  pinned: string;
}) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const textStyle = e.getAttributes("textStyle");
      const block = e.isActive("paragraph") ? e.getAttributes("paragraph") : e.getAttributes("heading");
      return {
        bold: e.isActive("bold"),
        italic: e.isActive("italic"),
        underline: e.isActive("underline"),
        strike: e.isActive("strike"),
        sub: e.isActive("subscript"),
        sup: e.isActive("superscript"),
        bullet: e.isActive("bulletList"),
        ordered: e.isActive("orderedList"),
        task: e.isActive("taskList"),
        quote: e.isActive("blockquote"),
        code: e.isActive("codeBlock"),
        link: e.isActive("link"),
        table: e.isActive("table"),
        align: (["center", "right", "justify"] as const).find((a) => e.isActive({ textAlign: a })) ?? "left",
        style: e.isActive("heading", { level: 1 })
          ? "h1"
          : e.isActive("heading", { level: 2 })
            ? "h2"
            : e.isActive("heading", { level: 3 })
              ? "h3"
              : e.isActive("heading", { level: 4 })
                ? "h4"
                : e.isActive("blockquote")
                  ? "quote"
                  : e.isActive("codeBlock")
                    ? "code"
                    : "p",
        fontFamily: (textStyle.fontFamily as string | undefined) ?? "",
        fontSize: ((textStyle.fontSize as string | undefined) ?? "").replace(/pt$/, ""),
        color: (textStyle.color as string | undefined) ?? null,
        lineHeight: (block.lineHeight as string | undefined) ?? null,
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
        canMerge: e.can().mergeCells(),
        canSplit: e.can().splitCell(),
      };
    },
  });
  const chain = () => editor.chain().focus();

  // Leaving a table while its tab is open goes back to Home.
  useEffect(() => {
    if (!s.table && tab === "table") setTab("home");
  }, [s.table, tab, setTab]);

  const setStyle = (style: string) => {
    const c = chain();
    if (style === "p") c.setParagraph().run();
    else if (style === "quote") c.toggleBlockquote().run();
    else if (style === "code") c.toggleCodeBlock().run();
    else c.setHeading({ level: Number(style.slice(1)) as 1 | 2 | 3 | 4 }).run();
  };
  const indent = () => {
    if (editor.can().sinkListItem("listItem")) chain().sinkListItem("listItem").run();
    else if (editor.can().sinkListItem("taskItem")) chain().sinkListItem("taskItem").run();
    else chain().indentBlocks().run();
  };
  const outdent = () => {
    if (editor.can().liftListItem("listItem")) chain().liftListItem("listItem").run();
    else if (editor.can().liftListItem("taskItem")) chain().liftListItem("taskItem").run();
    else chain().outdentBlocks().run();
  };

  const tabs: Array<{ key: TabKey; label: string; show: boolean }> = [
    { key: "home", label: "Home", show: true },
    { key: "insert", label: "Insert", show: true },
    { key: "table", label: "Table", show: s.table },
    { key: "review", label: "Review", show: true },
  ];

  return (
    <div className={`sticky ${pinned} z-20 rounded-t-xl border-b border-[var(--line)] bg-[var(--panel)]`}>
      <div className="flex items-end gap-1 border-b border-[var(--line)] px-2 pt-1.5" role="tablist" aria-label="Ribbon">
        {tabs
          .filter((item) => item.show)
          .map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setTab(item.key)}
              className={`-mb-px rounded-t-md border px-3 py-1 text-xs font-medium ${
                tab === item.key
                  ? "border-[var(--line)] border-b-[var(--panel-soft)] bg-[var(--panel-soft)] text-[var(--accent)]"
                  : "border-transparent text-muted hover:text-[var(--ink)]"
              } ${item.key === "table" ? "text-[var(--accent)]" : ""}`}
            >
              {item.key === "table" ? "Table design" : item.label}
            </button>
          ))}
        <div className="ml-auto flex items-center gap-0.5 pb-1">
          <Tool label="Undo (Ctrl+Z)" onClick={() => chain().undo().run()} disabled={!s.canUndo}><Undo2 size={15} /></Tool>
          <Tool label="Redo (Ctrl+Y)" onClick={() => chain().redo().run()} disabled={!s.canRedo}><Redo2 size={15} /></Tool>
        </div>
      </div>

      <div className="flex flex-wrap items-stretch gap-y-1 bg-[var(--panel-soft)] px-1 py-1.5">
        {tab === "home" ? (
          <>
            <Group caption="Font">
              <div className="flex items-center gap-1">
                <Select
                  label="Font"
                  width="w-36"
                  value={FONT_FAMILIES.some((f) => f.value === s.fontFamily) ? s.fontFamily : ""}
                  options={FONT_FAMILIES.map((f) => ({ value: f.value, label: f.label, style: f.value ? { fontFamily: f.value } : undefined }))}
                  onChange={(v) => (v ? chain().setFontFamily(v).run() : chain().unsetFontFamily().run())}
                />
                <Select
                  label="Font size"
                  width="w-16"
                  value={FONT_SIZES.includes(s.fontSize) ? s.fontSize : ""}
                  options={[{ value: "", label: "Auto" }, ...FONT_SIZES.map((size) => ({ value: size, label: size }))]}
                  onChange={(v) => (v ? chain().setFontSize(`${v}pt`).run() : chain().unsetFontSize().run())}
                />
              </div>
              <div className="flex items-center gap-0.5">
                <Tool label="Bold (Ctrl+B)" active={s.bold} onClick={() => chain().toggleBold().run()}><Bold size={15} /></Tool>
                <Tool label="Italic (Ctrl+I)" active={s.italic} onClick={() => chain().toggleItalic().run()}><Italic size={15} /></Tool>
                <Tool label="Underline (Ctrl+U)" active={s.underline} onClick={() => chain().toggleUnderline().run()}><Underline size={15} /></Tool>
                <Tool label="Strikethrough" active={s.strike} onClick={() => chain().toggleStrike().run()}><Strikethrough size={15} /></Tool>
                <Tool label="Subscript" active={s.sub} onClick={() => chain().toggleSubscript().run()}><SubscriptIcon size={15} /></Tool>
                <Tool label="Superscript" active={s.sup} onClick={() => chain().toggleSuperscript().run()}><SuperscriptIcon size={15} /></Tool>
                <ColorPicker
                  label="Font color"
                  icon={<Baseline size={15} />}
                  current={s.color}
                  onPick={(color) => chain().setColor(color).run()}
                  onClear={() => chain().unsetColor().run()}
                  clearLabel="Automatic"
                />
                <ColorPicker
                  label="Highlight"
                  icon={<Highlighter size={15} />}
                  swatches={HIGHLIGHTS}
                  onPick={(color) => chain().setHighlight({ color }).run()}
                  onClear={() => chain().unsetHighlight().run()}
                  clearLabel="No highlight"
                />
                <Tool label="Clear formatting" onClick={() => chain().unsetAllMarks().clearNodes().run()}><Eraser size={15} /></Tool>
              </div>
            </Group>

            <Group caption="Paragraph">
              <div className="flex items-center gap-0.5">
                <Tool label="Bulleted list" active={s.bullet} onClick={() => chain().toggleBulletList().run()}><List size={15} /></Tool>
                <Tool label="Numbered list" active={s.ordered} onClick={() => chain().toggleOrderedList().run()}><ListOrdered size={15} /></Tool>
                <Tool label="Checklist" active={s.task} onClick={() => chain().toggleTaskList().run()}><ListChecks size={15} /></Tool>
                <Tool label="Decrease indent (Shift+Tab)" onClick={outdent}><IndentDecrease size={15} /></Tool>
                <Tool label="Increase indent (Tab)" onClick={indent}><IndentIncrease size={15} /></Tool>
                <Menu
                  label="Line and paragraph spacing"
                  trigger={<WrapText size={15} />}
                  render={(close) => (
                    <div className="w-40 py-1">
                      {LINE_SPACINGS.map((value) => (
                        <MenuItem
                          key={value}
                          active={s.lineHeight === value}
                          onClick={() => {
                            chain().setBlockLineHeight(value).run();
                            close();
                          }}
                        >
                          {value === "1" ? "1.0" : value}
                        </MenuItem>
                      ))}
                      <MenuItem
                        onClick={() => {
                          chain().setBlockLineHeight(null).run();
                          close();
                        }}
                      >
                        Reset spacing
                      </MenuItem>
                    </div>
                  )}
                />
              </div>
              <div className="flex items-center gap-0.5">
                <Tool label="Align left (Ctrl+Shift+L)" active={s.align === "left"} onClick={() => chain().setTextAlign("left").run()}><AlignLeft size={15} /></Tool>
                <Tool label="Center (Ctrl+Shift+E)" active={s.align === "center"} onClick={() => chain().setTextAlign("center").run()}><AlignCenter size={15} /></Tool>
                <Tool label="Align right (Ctrl+Shift+R)" active={s.align === "right"} onClick={() => chain().setTextAlign("right").run()}><AlignRight size={15} /></Tool>
                <Tool label="Justify (Ctrl+Shift+J)" active={s.align === "justify"} onClick={() => chain().setTextAlign("justify").run()}><AlignJustify size={15} /></Tool>
                <Tool label="Quote" active={s.quote} onClick={() => chain().toggleBlockquote().run()}><Quote size={15} /></Tool>
                <Tool label="Code block" active={s.code} onClick={() => chain().toggleCodeBlock().run()}><Code2 size={15} /></Tool>
              </div>
            </Group>

            <Group caption="Styles">
              <div className="flex flex-wrap items-stretch gap-1">
                {[
                  { key: "p", label: "Normal", className: "text-xs" },
                  { key: "h1", label: "Heading 1", className: "text-sm font-bold" },
                  { key: "h2", label: "Heading 2", className: "text-[13px] font-bold" },
                  { key: "h3", label: "Heading 3", className: "text-xs font-semibold" },
                  { key: "h4", label: "Heading 4", className: "text-xs font-semibold italic" },
                  { key: "quote", label: "Quote", className: "text-xs italic text-muted" },
                ].map((style) => (
                  <button
                    key={style.key}
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setStyle(style.key)}
                    className={`h-[46px] min-w-[74px] rounded-md border px-2 text-left leading-tight ${style.className} ${
                      s.style === style.key
                        ? "border-[var(--accent)] bg-[color:color-mix(in_oklab,var(--accent)_10%,var(--panel))]"
                        : "border-[var(--line)] bg-[var(--panel)] hover:border-[var(--accent)]"
                    }`}
                  >
                    {style.label}
                  </button>
                ))}
              </div>
            </Group>
          </>
        ) : null}

        {tab === "insert" ? (
          <>
            <Group caption="Tables">
              <TablePicker onPick={(rows, cols) => chain().insertTable({ rows, cols, withHeaderRow: true }).run()} />
            </Group>
            <Group caption="Links">
              <div className="flex items-center gap-1">
                <LinkMenu editor={editor} active={s.link} />
                <BigTool label="Remove link" disabled={!s.link} onClick={() => chain().extendMarkRange("link").unsetLink().run()}>
                  <Link2Off size={18} />
                </BigTool>
              </div>
            </Group>
            <Group caption="Elements">
              <div className="flex items-center gap-1">
                <BigTool label="Horizontal line" onClick={() => chain().setHorizontalRule().run()}><Minus size={18} /></BigTool>
                <BigTool label="Heading" onClick={() => chain().setHeading({ level: 2 }).run()}><Heading size={18} /></BigTool>
                <BigTool label="Checklist" onClick={() => chain().toggleTaskList().run()}><ListChecks size={18} /></BigTool>
              </div>
            </Group>
            <Group caption="Symbols">
              <div className="flex items-center gap-1">
                <Menu
                  label="Symbol"
                  big
                  trigger={<><Sigma size={18} /><span className="text-[11px]">Symbol</span></>}
                  render={(close) => (
                    <div className="grid w-64 grid-cols-9 gap-1 p-2">
                      {SYMBOLS.map((symbol) => (
                        <button
                          key={symbol}
                          type="button"
                          title={`Insert ${symbol}`}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            chain().insertContent(symbol).run();
                            close();
                          }}
                          className="h-7 rounded border border-[var(--line)] text-sm hover:border-[var(--accent)] hover:bg-[var(--panel-soft)]"
                        >
                          {symbol}
                        </button>
                      ))}
                    </div>
                  )}
                />
                <Menu
                  label="Date and time"
                  big
                  trigger={<><CalendarDays size={18} /><span className="text-[11px]">Date</span></>}
                  render={(close) => {
                    const now = new Date();
                    const choices = [
                      now.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }),
                      now.toLocaleDateString(),
                      now.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
                      now.toISOString().slice(0, 10),
                    ];
                    return (
                      <div className="w-60 py-1">
                        {choices.map((text) => (
                          <MenuItem
                            key={text}
                            onClick={() => {
                              chain().insertContent(text).run();
                              close();
                            }}
                          >
                            {text}
                          </MenuItem>
                        ))}
                      </div>
                    );
                  }}
                />
              </div>
            </Group>
          </>
        ) : null}

        {tab === "table" ? (
          <>
            <Group caption="Rows and columns">
              <div className="flex items-center gap-0.5">
                <Tool label="Insert row above" onClick={() => chain().addRowBefore().run()}><ArrowUpToLine size={15} /></Tool>
                <Tool label="Insert row below" onClick={() => chain().addRowAfter().run()}><ArrowDownToLine size={15} /></Tool>
                <Tool label="Insert column left" onClick={() => chain().addColumnBefore().run()}><ArrowLeftToLine size={15} /></Tool>
                <Tool label="Insert column right" onClick={() => chain().addColumnAfter().run()}><ArrowRightToLine size={15} /></Tool>
              </div>
              <div className="flex items-center gap-1">
                <TextTool onClick={() => chain().deleteRow().run()}>Delete row</TextTool>
                <TextTool onClick={() => chain().deleteColumn().run()}>Delete column</TextTool>
              </div>
            </Group>
            <Group caption="Merge">
              <div className="flex items-center gap-1">
                <BigTool label="Merge cells" disabled={!s.canMerge} onClick={() => chain().mergeCells().run()}><TableCellsMerge size={18} /></BigTool>
                <BigTool label="Split cell" disabled={!s.canSplit} onClick={() => chain().splitCell().run()}><SplitSquareHorizontal size={18} /></BigTool>
              </div>
            </Group>
            <Group caption="Header">
              <div className="flex items-center gap-1">
                <BigTool label="Header row" onClick={() => chain().toggleHeaderRow().run()}><Rows2 size={18} /></BigTool>
                <BigTool label="Header column" onClick={() => chain().toggleHeaderColumn().run()}><Columns2 size={18} /></BigTool>
              </div>
            </Group>
            <Group caption="Shading">
              <ColorPicker
                label="Cell shading"
                icon={<PaintBucket size={18} />}
                big
                swatches={PALETTE[2].concat(PALETTE[0].slice(5))}
                onPick={(color) => chain().setCellAttribute("backgroundColor", color).run()}
                onClear={() => chain().setCellAttribute("backgroundColor", null).run()}
                clearLabel="No shading"
              />
            </Group>
            <Group caption="Table">
              <BigTool label="Delete table" danger onClick={() => chain().deleteTable().run()}><Trash2 size={18} /></BigTool>
            </Group>
          </>
        ) : null}

        {tab === "review" ? (
          <>
            <Group caption="Editing">
              <div className="flex items-center gap-1">
                <BigTool label="Find and replace (Ctrl+F)" active={findOpen} onClick={() => setFindOpen(!findOpen)}>
                  <Search size={18} />
                </BigTool>
              </div>
            </Group>
            <Group caption="Proofing">
              <DocumentStats editor={editor} />
            </Group>
            <Group caption="Output">
              <BigTool label="Print" onClick={() => printMemo(editor, documentTitle)}><Printer size={18} /></BigTool>
            </Group>
          </>
        ) : null}
      </div>

      {findOpen ? <FindReplace editor={editor} onClose={() => setFindOpen(false)} /> : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Ribbon building blocks
 * ------------------------------------------------------------------------- */

function Group({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="flex flex-col justify-between border-r border-[var(--line)] px-2 last:border-r-0">
      <div className="flex flex-col gap-1">{children}</div>
      <div className="mt-1 text-center text-[10px] font-medium uppercase tracking-wide text-muted">{caption}</div>
    </div>
  );
}

const toolClass = (active: boolean) =>
  `inline-flex items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
    active ? "bg-[color:color-mix(in_oklab,var(--accent)_18%,transparent)] text-[var(--accent)]" : "text-[var(--ink)] hover:bg-[var(--panel)]"
  }`;

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
      className={`h-7 w-7 ${toolClass(active)}`}
    >
      {children}
    </button>
  );
}

/** A large ribbon button: icon over a label. */
function BigTool({ label, active = false, disabled = false, danger = false, onClick, children }: { label: string; active?: boolean; disabled?: boolean; danger?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={`flex h-[46px] min-w-[52px] flex-col items-center justify-center gap-0.5 px-1.5 ${toolClass(active)} ${danger ? "text-[var(--bad)]" : ""}`}
    >
      {children}
      <span className="max-w-[72px] truncate text-[11px] leading-none">{label.replace(/ \(.*\)$/, "")}</span>
    </button>
  );
}

function TextTool({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className="h-7 rounded-md border border-[var(--line)] bg-[var(--panel)] px-2 text-[11px] hover:border-[var(--accent)]"
    >
      {children}
    </button>
  );
}

function Select({
  label,
  width,
  value,
  options,
  onChange,
}: {
  label: string;
  width: string;
  value: string;
  options: Array<{ value: string; label: string; style?: CSSProperties }>;
  onChange: (value: string) => void;
}) {
  return (
    <select
      aria-label={label}
      title={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={`h-7 ${width} rounded-md border border-[var(--line)] bg-[var(--panel)] px-1.5 text-xs`}
    >
      {options.map((option) => (
        <option key={option.label} value={option.value} style={option.style}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

function Popover({ children }: { children: ReactNode }) {
  return <div className="absolute left-0 top-full z-40 mt-1 rounded-lg border border-[var(--line)] bg-[var(--panel)] shadow-xl">{children}</div>;
}

function Menu({ label, trigger, render, big = false }: { label: string; trigger: ReactNode; render: (close: () => void) => ReactNode; big?: boolean }) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen(!open)}
        className={big ? `flex h-[46px] min-w-[52px] flex-col items-center justify-center gap-0.5 px-1.5 ${toolClass(open)}` : `h-7 gap-0.5 px-1 ${toolClass(open)}`}
      >
        {trigger}
        {big ? null : <ChevronDown size={11} />}
      </button>
      {open ? <Popover>{render(() => setOpen(false))}</Popover> : null}
    </div>
  );
}

function MenuItem({ active = false, onClick, children }: { active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={`block w-full px-3 py-1.5 text-left text-xs hover:bg-[var(--panel-soft)] ${active ? "font-semibold text-[var(--accent)]" : ""}`}
    >
      {children}
    </button>
  );
}

function ColorPicker({
  label,
  icon,
  current = null,
  swatches,
  onPick,
  onClear,
  clearLabel,
  big = false,
}: {
  label: string;
  icon: ReactNode;
  current?: string | null;
  swatches?: string[];
  onPick: (color: string) => void;
  onClear: () => void;
  clearLabel: string;
  big?: boolean;
}) {
  const { open, setOpen, ref } = usePopover();
  const [recent, setRecent] = useState<string | null>(null);
  const pick = (color: string) => {
    onPick(color);
    setRecent(color);
    setOpen(false);
  };
  const bar = current ?? recent ?? (swatches ? swatches[0] : "#c00000");
  return (
    <div ref={ref} className="relative flex items-center">
      {/* Split button: apply the last color, or open the palette. */}
      <button
        type="button"
        title={label}
        aria-label={label}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => pick(bar)}
        className={`${big ? "flex h-[46px] min-w-[44px] flex-col items-center justify-center" : "flex h-7 w-7 flex-col items-center justify-center"} ${toolClass(false)}`}
      >
        {icon}
        <span className="mt-0.5 h-1 w-4 rounded-sm" style={{ background: bar }} aria-hidden />
        {big ? <span className="text-[11px] leading-none">{label}</span> : null}
      </button>
      <button
        type="button"
        title={`${label} options`}
        aria-label={`${label} options`}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen(!open)}
        className={`${big ? "h-[46px]" : "h-7"} w-4 ${toolClass(open)}`}
      >
        <ChevronDown size={11} />
      </button>
      {open ? (
        <Popover>
          <div className="w-60 p-2">
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onClear();
                setOpen(false);
              }}
              className="mb-2 w-full rounded-md border border-[var(--line)] px-2 py-1 text-left text-xs hover:bg-[var(--panel-soft)]"
            >
              {clearLabel}
            </button>
            {(swatches ? [swatches] : PALETTE).map((row, index) => (
              <div key={index} className={`grid grid-cols-10 gap-1 ${index === 1 && !swatches ? "mb-2" : "mb-1"}`}>
                {row.map((color) => (
                  <button
                    key={color}
                    type="button"
                    title={color}
                    aria-label={`${label} ${color}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => pick(color)}
                    className="h-5 w-5 rounded-sm border border-[var(--line)] hover:scale-110"
                    style={{ background: color }}
                  />
                ))}
              </div>
            ))}
            <label className="mt-2 flex cursor-pointer items-center justify-between rounded-md px-1 py-1 text-xs hover:bg-[var(--panel-soft)]">
              More colors…
              <input type="color" className="h-5 w-8 cursor-pointer border-0 bg-transparent p-0" onChange={(event) => pick(event.target.value)} />
            </label>
          </div>
        </Popover>
      ) : null}
    </div>
  );
}

function TablePicker({ onPick }: { onPick: (rows: number, cols: number) => void }) {
  const { open, setOpen, ref } = usePopover();
  const [hover, setHover] = useState<[number, number]>([0, 0]);
  const ROWS = 8;
  const COLS = 10;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title="Insert table"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen(!open)}
        className={`flex h-[46px] min-w-[52px] flex-col items-center justify-center gap-0.5 px-1.5 ${toolClass(open)}`}
      >
        <Table2 size={18} />
        <span className="text-[11px] leading-none">Table</span>
      </button>
      {open ? (
        <Popover>
          <div className="p-2" onMouseLeave={() => setHover([0, 0])}>
            <div className="mb-1.5 text-xs font-medium">{hover[0] ? `${hover[1]} × ${hover[0]} table` : "Insert table"}</div>
            <div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${COLS}, 1rem)` }}>
              {Array.from({ length: ROWS * COLS }, (_, index) => {
                const row = Math.floor(index / COLS) + 1;
                const col = (index % COLS) + 1;
                const lit = row <= hover[0] && col <= hover[1];
                return (
                  <button
                    key={index}
                    type="button"
                    aria-label={`${col} by ${row} table`}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setHover([row, col])}
                    onClick={() => {
                      onPick(row, col);
                      setOpen(false);
                    }}
                    className={`h-4 w-4 rounded-[3px] border ${lit ? "border-[var(--accent)] bg-[color:color-mix(in_oklab,var(--accent)_30%,transparent)]" : "border-[var(--line)] bg-[var(--panel)]"}`}
                  />
                );
              })}
            </div>
          </div>
        </Popover>
      ) : null}
    </div>
  );
}

function LinkMenu({ editor, active }: { editor: Editor; active: boolean }) {
  const { open, setOpen, ref } = usePopover();
  const [url, setUrl] = useState("");
  const apply = () => {
    const href = url.trim();
    const c = editor.chain().focus().extendMarkRange("link");
    if (!href) c.unsetLink().run();
    else c.setLink({ href: /^(https?:|mailto:)/i.test(href) ? href : `https://${href}` }).run();
    setOpen(false);
  };
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title="Insert link (Ctrl+K)"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          setUrl(editor.getAttributes("link").href ?? "");
          setOpen(!open);
        }}
        className={`flex h-[46px] min-w-[52px] flex-col items-center justify-center gap-0.5 px-1.5 ${toolClass(active || open)}`}
      >
        <Link2 size={18} />
        <span className="text-[11px] leading-none">Link</span>
      </button>
      {open ? (
        <Popover>
          <form
            className="flex w-80 items-center gap-1 p-2"
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
        </Popover>
      ) : null}
    </div>
  );
}

function DocumentStats({ editor }: { editor: Editor }) {
  const stats = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      let paragraphs = 0;
      e.state.doc.descendants((node) => {
        if (node.isTextblock && node.textContent.trim()) paragraphs += 1;
      });
      return {
        words: e.storage.characterCount.words(),
        characters: e.storage.characterCount.characters(),
        paragraphs,
      };
    },
  });
  return (
    <dl className="grid grid-cols-3 gap-3 px-1 text-center">
      {[
        ["Words", stats.words],
        ["Characters", stats.characters],
        ["Paragraphs", stats.paragraphs],
      ].map(([label, count]) => (
        <div key={label as string}>
          <dt className="text-[10px] text-muted">{label}</dt>
          <dd className="text-base font-semibold tabular-nums">{count}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ---------------------------------------------------------------------------
 * Find and replace
 * ------------------------------------------------------------------------- */

type Match = { from: number; to: number };

function findMatches(editor: Editor, query: string, matchCase: boolean): Match[] {
  const out: Match[] = [];
  if (!query) return out;
  const needle = matchCase ? query : query.toLowerCase();
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const haystack = matchCase ? node.text : node.text.toLowerCase();
    let index = haystack.indexOf(needle);
    while (index !== -1) {
      out.push({ from: pos + index, to: pos + index + needle.length });
      index = haystack.indexOf(needle, index + needle.length);
    }
  });
  return out;
}

function FindReplace({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const version = useEditorState({ editor, selector: ({ editor: e }) => e.state.doc });
  const matches = useMemo(() => findMatches(editor, query, matchCase), [editor, query, matchCase, version]);
  const selection = useEditorState({ editor, selector: ({ editor: e }) => ({ from: e.state.selection.from, to: e.state.selection.to }) });
  const currentIndex = matches.findIndex((m) => m.from === selection.from && m.to === selection.to);

  const go = (direction: 1 | -1) => {
    if (!matches.length) return;
    const { from, to } = editor.state.selection;
    const next =
      direction === 1
        ? matches.find((m) => m.from >= to) ?? matches[0]
        : [...matches].reverse().find((m) => m.to <= from) ?? matches[matches.length - 1];
    editor.chain().focus().setTextSelection(next).scrollIntoView().run();
  };
  const replaceOne = () => {
    if (currentIndex === -1) return go(1);
    const target = matches[currentIndex];
    editor.chain().focus().insertContentAt(target, replacement).run();
    go(1);
  };
  const replaceAll = () => {
    if (!matches.length) return;
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        for (const m of [...matches].reverse()) tr.insertText(replacement, m.from, m.to);
        return true;
      })
      .run();
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-xs">
      <Search size={14} className="text-muted" aria-hidden />
      <input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            go(event.shiftKey ? -1 : 1);
          }
          if (event.key === "Escape") onClose();
        }}
        placeholder="Find"
        aria-label="Find"
        className="w-44 rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1"
      />
      <input
        value={replacement}
        onChange={(event) => setReplacement(event.target.value)}
        placeholder="Replace with"
        aria-label="Replace with"
        className="w-44 rounded-md border border-[var(--line)] bg-[var(--panel-soft)] px-2 py-1"
      />
      <label className="flex items-center gap-1">
        <input type="checkbox" checked={matchCase} onChange={(event) => setMatchCase(event.target.checked)} />
        Match case
      </label>
      <span className="text-muted tabular-nums">
        {query ? (matches.length ? `${currentIndex === -1 ? "–" : currentIndex + 1} of ${matches.length}` : "No results") : ""}
      </span>
      <div className="ml-auto flex items-center gap-1">
        <TextTool onClick={() => go(-1)}>Previous</TextTool>
        <TextTool onClick={() => go(1)}>Next</TextTool>
        <TextTool onClick={replaceOne}>
          <span className="inline-flex items-center gap-1"><Replace size={12} /> Replace</span>
        </TextTool>
        <TextTool onClick={replaceAll}>Replace all</TextTool>
        <TextTool onClick={onClose}>Close</TextTool>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Print
 * ------------------------------------------------------------------------- */

function printMemo(editor: Editor, title: string) {
  const html = DOMPurify.sanitize(editor.getHTML(), { USE_PROFILES: { html: true } });
  const win = window.open("", "_blank", "width=900,height=700");
  if (!win) return;
  const safeTitle = title.replace(/[<>&]/g, "");
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title>
<style>
  body { font: 11pt/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; color: #111; margin: 2cm; }
  h1.memo-title { font-size: 16pt; border-bottom: 1px solid #999; padding-bottom: 6px; margin-bottom: 18px; }
  table { border-collapse: collapse; width: 100%; } td, th { border: 1px solid #999; padding: 4px 6px; vertical-align: top; }
  th { background: #f0f0f0; } blockquote { border-left: 3px solid #999; margin-left: 0; padding-left: 10px; color: #444; }
  ul[data-type="taskList"] { list-style: none; padding-left: 0; }
  li[data-type="taskItem"] { display: flex; gap: 6px; } li[data-type="taskItem"]::before { content: "☐"; }
  li[data-type="taskItem"][data-checked="true"]::before { content: "☑"; }
  pre { background: #f5f5f5; padding: 8px; white-space: pre-wrap; }
</style></head><body><h1 class="memo-title">${safeTitle}</h1>${html}</body></html>`);
  win.document.close();
  win.focus();
  win.print();
}

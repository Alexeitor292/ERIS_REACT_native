// The iPhone app's memo editor: the web form's own editor (the same
// extensions, figures and styles), bundled into the app by
// scripts/build-memo-ios.mjs so a memo written on one opens on the other with
// nothing lost. The app shows its own toolbar and talks to this page through
// `window.erisMemo` (in) and the `memo` message handler (out).
import "./memoIos.css";

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import DOMPurify from "dompurify";

import { memoExtensions } from "../features/submissions/memoEditorExtensions";
import { figureRegistry, memoNumber } from "../features/submissions/memoFigureModel";
import { setFigureContext } from "../features/submissions/memoFigures";

type Load = {
  /** observations_notes, … */
  memoKey: string;
  html: string;
  editable: boolean;
  placeholder: string;
  /** Every memo's document, for the figure numbers and citations across memos. */
  memos: Record<string, string>;
  dark: boolean;
};

type Bridge = { postMessage: (message: unknown) => void };
const bridge = (): Bridge | undefined =>
  (window as unknown as { webkit?: { messageHandlers?: { memo?: Bridge } } }).webkit?.messageHandlers?.memo;
const post = (message: unknown) => bridge()?.postMessage(message);

/** Stored memos are sanitized by the server; sanitize again before they reach the editor (as the web form does). */
const clean = (html: string) => DOMPurify.sanitize(html || "", { USE_PROFILES: { html: true } });

/** Figures are fetched by the app, with its own sign-in, never by this page. */
const figureUrl = (attachmentId: number) => Promise.resolve(`eris-figure://attachment/${attachmentId}`);

function indent(e: Editor, deeper: boolean) {
  for (const item of ["taskItem", "listItem"]) {
    if (e.isActive(item)) return deeper ? e.chain().focus().sinkListItem(item).run() : e.chain().focus().liftListItem(item).run();
  }
  return deeper ? e.chain().focus().indentBlocks().run() : e.chain().focus().outdentBlocks().run();
}

const COMMANDS: Record<string, (e: Editor, arg?: any) => boolean> = {
  bold: (e) => e.chain().focus().toggleBold().run(),
  italic: (e) => e.chain().focus().toggleItalic().run(),
  underline: (e) => e.chain().focus().toggleUnderline().run(),
  strike: (e) => e.chain().focus().toggleStrike().run(),
  highlight: (e) => e.chain().focus().toggleHighlight({ color: "#fff59d" }).run(),
  bulletList: (e) => e.chain().focus().toggleBulletList().run(),
  orderedList: (e) => e.chain().focus().toggleOrderedList().run(),
  taskList: (e) => e.chain().focus().toggleTaskList().run(),
  heading: (e, level: number) =>
    level ? e.chain().focus().toggleHeading({ level: level as 1 | 2 | 3 | 4 }).run() : e.chain().focus().setParagraph().run(),
  quote: (e) => e.chain().focus().toggleBlockquote().run(),
  indent: (e) => indent(e, true),
  outdent: (e) => indent(e, false),
  align: (e, value: string) => e.chain().focus().setTextAlign(value).run(),
  clear: (e) => e.chain().focus().unsetAllMarks().clearNodes().run(),
  undo: (e) => e.chain().focus().undo().run(),
  redo: (e) => e.chain().focus().redo().run(),
  symbol: (e, text: string) => e.chain().focus().insertContent(text).run(),
  figure: (e, arg: { id: number; caption: string }) => e.chain().focus().insertMemoFigure({ attachmentId: arg.id, caption: arg.caption }).run(),
  cite: (e, id: number) => e.chain().focus().insertFigureRef(id).run(),
  table: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  addRow: (e) => e.chain().focus().addRowAfter().run(),
  addColumn: (e) => e.chain().focus().addColumnAfter().run(),
  deleteRow: (e) => e.chain().focus().deleteRow().run(),
  deleteColumn: (e) => e.chain().focus().deleteColumn().run(),
  deleteTable: (e) => e.chain().focus().deleteTable().run(),
  done: (e) => e.commands.blur(),
};

/** What the toolbar shows as on, and the figures that can be cited. */
function report(e: Editor, load: Load) {
  const memos = { ...load.memos, [load.memoKey]: e.isEmpty ? "" : e.getHTML() };
  const figures = [...figureRegistry(memos).values()].map((f) => ({ id: f.attachmentId, label: f.label, caption: f.caption }));
  const heading = [1, 2, 3, 4].find((level) => e.isActive("heading", { level })) ?? 0;
  post({
    type: "state",
    active: ["bold", "italic", "underline", "strike", "highlight", "bulletList", "orderedList", "taskList", "blockquote", "table"]
      .filter((name) => e.isActive(name)),
    heading,
    canUndo: e.can().undo(),
    canRedo: e.can().redo(),
    figures,
  });
  return memos;
}

// The app may call in before React has drawn the page: hold what it sends.
let pendingLoad: Load | null = null;
let showLoad: ((next: Load) => void) | null = null;
let activeEditor: Editor | null = null;

(window as unknown as { erisMemo: unknown }).erisMemo = {
  load: (next: Load) => {
    if (showLoad) showLoad(next);
    else pendingLoad = next;
  },
  run: (name: string, arg?: unknown) => {
    const command = COMMANDS[name];
    return activeEditor && command ? command(activeEditor, arg) : false;
  },
  setEditable: (editable: boolean) => activeEditor?.setEditable(editable),
};

function MemoEditor({ load }: { load: Load }) {
  const editor = useEditor({
    extensions: memoExtensions(load.placeholder),
    content: clean(load.html),
    editable: load.editable,
  });

  useEffect(() => {
    if (!editor) return;
    activeEditor = editor;
    const sync = () => {
      const memos = report(editor, load);
      setFigureContext(editor, { memoNumber: memoNumber(load.memoKey) || 9, registry: figureRegistry(memos), resolveUrl: figureUrl });
    };
    sync();
    const onUpdate = () => {
      post({ type: "change", html: editor.isEmpty ? "" : editor.getHTML() });
      sync();
    };
    const onSelection = () => report(editor, load);
    const onFocus = () => post({ type: "focus", focused: true });
    const onBlur = () => post({ type: "focus", focused: false });
    editor.on("update", onUpdate);
    editor.on("selectionUpdate", onSelection);
    editor.on("focus", onFocus);
    editor.on("blur", onBlur);
    post({ type: "loaded" });
    return () => {
      editor.off("update", onUpdate);
      editor.off("selectionUpdate", onSelection);
      editor.off("focus", onFocus);
      editor.off("blur", onBlur);
      if (activeEditor === editor) activeEditor = null;
    };
  }, [editor, load]);

  return (
    <div className="eris-memo-surface eris-memo-ios">
      <EditorContent editor={editor} />
    </div>
  );
}

function MemoPage() {
  const [load, setLoad] = useState<Load | null>(pendingLoad);
  useEffect(() => {
    showLoad = setLoad;
    post({ type: "ready" });
    return () => {
      showLoad = null;
    };
  }, []);
  useEffect(() => {
    if (load) document.documentElement.dataset.theme = load.dark ? "dark" : "light";
  }, [load]);
  return load ? <MemoEditor key={load.memoKey} load={load} /> : null;
}

createRoot(document.getElementById("root")!).render(<MemoPage />);

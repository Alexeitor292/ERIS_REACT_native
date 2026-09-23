import { Extension, type CommandProps } from "@tiptap/core";
import { TableCell, TableHeader } from "@tiptap/extension-table";

const BLOCK_TYPES = ["paragraph", "heading"];
const INDENT_STEP_EM = 2;
const MAX_INDENT = 8;

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    blockFormatting: {
      /** Indent the selected paragraphs one step (like Word's Increase Indent). */
      indentBlocks: () => ReturnType;
      /** Outdent the selected paragraphs one step. */
      outdentBlocks: () => ReturnType;
      /** Line spacing of the selected paragraphs, e.g. "1.5"; null resets it. */
      setBlockLineHeight: (value: string | null) => ReturnType;
    };
  }
}

type BlockAttrs = { indent?: number; lineHeight?: string | null };

function updateBlocks(change: (attrs: BlockAttrs) => BlockAttrs | null) {
  return ({ tr, state }: CommandProps) => {
    const { from, to } = state.selection;
    let changed = false;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!BLOCK_TYPES.includes(node.type.name)) return;
      const next = change(node.attrs as BlockAttrs);
      if (!next) return;
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...next });
      changed = true;
    });
    return changed;
  };
}

/** Paragraph-level indent and line spacing, stored as inline styles on the block. */
export const BlockFormatting = Extension.create({
  name: "blockFormatting",
  addGlobalAttributes() {
    return [
      {
        types: BLOCK_TYPES,
        attributes: {
          indent: {
            default: 0,
            parseHTML: (element) => {
              const match = /([\d.]+)em/.exec(element.style.marginLeft || "");
              return match ? Math.min(MAX_INDENT, Math.round(parseFloat(match[1]) / INDENT_STEP_EM)) : 0;
            },
            renderHTML: (attrs) => (attrs.indent ? { style: `margin-left: ${attrs.indent * INDENT_STEP_EM}em` } : {}),
          },
          lineHeight: {
            default: null,
            parseHTML: (element) => element.style.lineHeight || null,
            renderHTML: (attrs) => (attrs.lineHeight ? { style: `line-height: ${attrs.lineHeight}` } : {}),
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      indentBlocks: () => updateBlocks((attrs) => ((attrs.indent ?? 0) < MAX_INDENT ? { indent: (attrs.indent ?? 0) + 1 } : null)),
      outdentBlocks: () => updateBlocks((attrs) => ((attrs.indent ?? 0) > 0 ? { indent: (attrs.indent ?? 0) - 1 } : null)),
      setBlockLineHeight: (value: string | null) => updateBlocks(() => ({ lineHeight: value })),
    };
  },
});

const cellBackground = {
  backgroundColor: {
    default: null,
    parseHTML: (element: HTMLElement) => element.style.backgroundColor || null,
    renderHTML: (attrs: Record<string, unknown>) =>
      attrs.backgroundColor ? { style: `background-color: ${attrs.backgroundColor}` } : {},
  },
};

/** Table cells that can be shaded, like Word's cell shading. */
export const ShadedTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...cellBackground };
  },
});

export const ShadedTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...cellBackground };
  },
});

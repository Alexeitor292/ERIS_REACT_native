// A memo out to Word (.docx) and back. Both run in the browser: no conversion
// server. The figures go out as the photos themselves, each tagged with its
// attachment in the picture's alt text ("eris-attachment:12") and followed by a
// Caption-style paragraph bookmarked "eris_fig_12"; a citation is a link to that
// bookmark. Coming back, a tagged picture is the same figure again, any other
// picture is uploaded to the form as a new photo, and links to the bookmarks are
// citations again. Colours, fonts and spacing come back simplified.

import type { JSONContent } from "@tiptap/core";

import { apiUrl } from "../../api/client";
import { getToken } from "../../auth/token";
import { figureText, stripFigurePrefix } from "./memoFigureModel";

const ALT_PREFIX = "eris-attachment:";
const BOOKMARK_PREFIX = "eris_fig_";
/** Letter page, 1-inch margins: 6.5 in of text width at 96 px per inch. */
const TEXT_WIDTH_PX = 624;

/** The photo's bytes, through the API (the storage links are not readable from scripts). */
export async function fetchAttachmentBytes(attachmentId: number): Promise<ArrayBuffer> {
  const token = getToken();
  const response = await fetch(apiUrl(`/attachments/${attachmentId}/content`), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error(`Photo #${attachmentId} could not be read (${response.status}).`);
  return response.arrayBuffer();
}

type Picture = { data: ArrayBuffer | Uint8Array; type: "png" | "jpg" | "gif" | "bmp"; width: number; height: number };

/** A picture Word can hold, with its size: JPEG, PNG, GIF and BMP as they are, anything else redrawn as PNG. */
async function toPicture(bytes: ArrayBuffer): Promise<Picture | null> {
  const head = new Uint8Array(bytes.slice(0, 4));
  const type =
    head[0] === 0x89 && head[1] === 0x50 ? "png"
      : head[0] === 0xff && head[1] === 0xd8 ? "jpg"
        : head[0] === 0x47 && head[1] === 0x49 ? "gif"
          : head[0] === 0x42 && head[1] === 0x4d ? "bmp"
            : null;
  const blobUrl = URL.createObjectURL(new Blob([bytes]));
  try {
    const image = new Image();
    image.src = blobUrl;
    await image.decode();
    const width = image.naturalWidth || 800;
    const height = image.naturalHeight || 600;
    if (type) return { data: bytes, type, width, height };
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")?.drawImage(image, 0, 0);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    return png ? { data: await png.arrayBuffer(), type: "png", width, height } : null;
  } catch {
    // A format the browser cannot draw (HEIC outside Safari).
    return null;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

/* ---------------------------------------------------------------------------
 * Export
 * ------------------------------------------------------------------------- */

export async function exportMemoDocx(options: {
  doc: JSONContent;
  title: string;
  memoTitle: string;
  fetchBytes?: (attachmentId: number) => Promise<ArrayBuffer>;
}): Promise<Blob> {
  const d = await import("docx");
  const fetchBytes = options.fetchBytes ?? fetchAttachmentBytes;

  // Every figure's picture, fetched once up front.
  const figureIds = new Set<number>();
  const walk = (node: JSONContent) => {
    if (node.type === "memoFigure" && node.attrs?.attachmentId) figureIds.add(Number(node.attrs.attachmentId));
    node.content?.forEach(walk);
  };
  walk(options.doc);
  const pictures = new Map<number, Picture | null>();
  await Promise.all(
    [...figureIds].map(async (id) => {
      try {
        pictures.set(id, await toPicture(await fetchBytes(id)));
      } catch {
        pictures.set(id, null);
      }
    }),
  );

  let listInstance = 0;
  type Child = InstanceType<typeof d.Paragraph> | InstanceType<typeof d.Table>;
  type Run = InstanceType<typeof d.TextRun> | InstanceType<typeof d.ExternalHyperlink> | InstanceType<typeof d.InternalHyperlink> | InstanceType<typeof d.ImageRun>;

  const alignment = (align: unknown) =>
    align === "center" ? d.AlignmentType.CENTER : align === "right" ? d.AlignmentType.RIGHT : align === "justify" ? d.AlignmentType.JUSTIFIED : undefined;

  const hex = (color: unknown) => {
    if (typeof color !== "string") return undefined;
    const match = /^#([0-9a-f]{6})$/i.exec(color.trim()) ?? /^#([0-9a-f]{3})$/i.exec(color.trim());
    if (!match) return undefined;
    return match[1].length === 3 ? match[1].split("").map((c) => c + c).join("") : match[1];
  };

  function textRun(node: JSONContent, extra: { style?: string } = {}) {
    const marks = new Map((node.marks ?? []).map((mark) => [mark.type, mark.attrs ?? {}]));
    const style = marks.get("textStyle") ?? {};
    const size = Number(String(style.fontSize ?? "").replace(/pt$/, ""));
    const highlight = marks.get("highlight");
    return new d.TextRun({
      text: node.text ?? "",
      bold: marks.has("bold") || undefined,
      italics: marks.has("italic") || undefined,
      underline: marks.has("underline") || marks.has("link") ? {} : undefined,
      strike: marks.has("strike") || undefined,
      subScript: marks.has("subscript") || undefined,
      superScript: marks.has("superscript") || undefined,
      color: hex(style.color) ?? (marks.has("link") ? "0563C1" : undefined),
      size: size ? Math.round(size * 2) : undefined,
      font: typeof style.fontFamily === "string" && style.fontFamily ? style.fontFamily.split(",")[0].replace(/['"]/g, "").trim() : marks.has("code") ? "Courier New" : undefined,
      shading: highlight ? { type: d.ShadingType.CLEAR, color: "auto", fill: hex(highlight.color) ?? "FFF59D" } : undefined,
      ...extra,
    });
  }

  function runs(nodes: JSONContent[] | undefined): Run[] {
    const out: Run[] = [];
    for (const node of nodes ?? []) {
      if (node.type === "text") {
        const link = node.marks?.find((mark) => mark.type === "link")?.attrs?.href;
        out.push(link ? new d.ExternalHyperlink({ link: String(link), children: [textRun(node)] }) : textRun(node));
      } else if (node.type === "hardBreak") {
        out.push(new d.TextRun({ text: "", break: 1 }));
      } else if (node.type === "memoFigureRef") {
        const target = Number(node.attrs?.target);
        out.push(
          new d.InternalHyperlink({
            anchor: `${BOOKMARK_PREFIX}${target}`,
            children: [new d.TextRun({ text: figureText(node.attrs?.label), color: "0563C1", underline: {} })],
          }),
        );
      }
    }
    return out;
  }

  function paragraphOptions(node: JSONContent) {
    return { alignment: alignment(node.attrs?.textAlign) };
  }

  function blocks(nodes: JSONContent[] | undefined, list?: { kind: "bullet" | "ordered"; level: number; instance: number }): Child[] {
    const out: Child[] = [];
    for (const node of nodes ?? []) {
      switch (node.type) {
        case "paragraph":
          out.push(
            new d.Paragraph({
              ...paragraphOptions(node),
              children: runs(node.content),
              ...(list
                ? list.kind === "bullet"
                  ? { bullet: { level: list.level } }
                  : { numbering: { reference: "eris-ordered", level: list.level, instance: list.instance } }
                : {}),
            }),
          );
          break;
        case "heading": {
          const levels = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3, d.HeadingLevel.HEADING_4];
          out.push(new d.Paragraph({ ...paragraphOptions(node), heading: levels[Math.min(3, Math.max(0, Number(node.attrs?.level ?? 1) - 1))], children: runs(node.content) }));
          break;
        }
        case "bulletList":
        case "orderedList": {
          const kind = node.type === "bulletList" ? "bullet" : "ordered";
          const level = list ? Math.min(list.level + 1, 3) : 0;
          const instance = kind === "ordered" && (!list || list.kind !== "ordered") ? ++listInstance : list?.instance ?? ++listInstance;
          for (const item of node.content ?? []) out.push(...blocks(item.content, { kind, level, instance }));
          break;
        }
        case "taskList":
          for (const item of node.content ?? []) {
            const [first, ...rest] = item.content ?? [];
            out.push(new d.Paragraph({ children: [new d.TextRun({ text: item.attrs?.checked ? "☑ " : "☐ " }), ...runs(first?.content)] }));
            out.push(...blocks(rest, list));
          }
          break;
        case "blockquote":
          for (const child of blocks(node.content, list)) out.push(child);
          break;
        case "codeBlock":
          for (const line of (node.content?.map((c) => c.text ?? "").join("") ?? "").split("\n")) {
            out.push(new d.Paragraph({ children: [new d.TextRun({ text: line, font: "Courier New", size: 20 })] }));
          }
          break;
        case "horizontalRule":
          out.push(new d.Paragraph({ border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: "999999", space: 1 } }, children: [] }));
          break;
        case "table":
          out.push(table(node));
          break;
        case "memoFigure":
          out.push(...figure(node));
          break;
        default:
          if (node.content) out.push(...blocks(node.content, list));
      }
    }
    return out;
  }

  function table(node: JSONContent) {
    return new d.Table({
      width: { size: 100, type: d.WidthType.PERCENTAGE },
      rows: (node.content ?? []).map(
        (row) =>
          new d.TableRow({
            tableHeader: (row.content ?? []).every((cell) => cell.type === "tableHeader") || undefined,
            children: (row.content ?? []).map((cell) => {
              const children = blocks(cell.content).filter((child): child is InstanceType<typeof d.Paragraph> => child instanceof d.Paragraph);
              const fill = hex(cell.attrs?.backgroundColor) ?? (cell.type === "tableHeader" ? "F2F2F2" : undefined);
              return new d.TableCell({
                children: children.length ? children : [new d.Paragraph("")],
                columnSpan: Number(cell.attrs?.colspan) > 1 ? Number(cell.attrs?.colspan) : undefined,
                rowSpan: Number(cell.attrs?.rowspan) > 1 ? Number(cell.attrs?.rowspan) : undefined,
                shading: fill ? { type: d.ShadingType.CLEAR, color: "auto", fill } : undefined,
              });
            }),
          }),
      ),
    });
  }

  function figure(node: JSONContent): Child[] {
    const id = Number(node.attrs?.attachmentId);
    const caption = String(node.attrs?.caption ?? "");
    const label = figureText(node.attrs?.label);
    const picture = pictures.get(id);
    const widthPx = Math.round((TEXT_WIDTH_PX * (Number(node.attrs?.width) || 100)) / 100);
    const image = picture
      ? new d.ImageRun({
          type: picture.type,
          data: picture.data,
          transformation: { width: widthPx, height: Math.round((widthPx * picture.height) / picture.width) },
          altText: { name: `Figure ${id}`, title: caption || label, description: `${ALT_PREFIX}${id};width=${Number(node.attrs?.width) || 100}` },
        } as ConstructorParameters<typeof d.ImageRun>[0])
      : new d.TextRun({ text: `[Photo #${id} could not be included]`, italics: true });
    return [
      new d.Paragraph({ alignment: d.AlignmentType.CENTER, keepNext: true, children: [image] }),
      new d.Paragraph({
        style: "Caption",
        alignment: d.AlignmentType.CENTER,
        children: [new d.Bookmark({ id: `${BOOKMARK_PREFIX}${id}`, children: [new d.TextRun({ text: `${label}. `, bold: true })] }), new d.TextRun(caption)],
      }),
    ];
  }

  const body = blocks(options.doc.content);
  const document = new d.Document({
    creator: "ERIS",
    title: `${options.title} - ${options.memoTitle}`,
    styles: {
      default: { document: { run: { font: "Calibri", size: 22 } } },
      paragraphStyles: [
        { id: "Caption", name: "caption", basedOn: "Normal", next: "Normal", quickFormat: true, run: { italics: true, size: 18, color: "44546A" }, paragraph: { spacing: { after: 200 } } },
      ],
    },
    numbering: {
      config: [
        {
          reference: "eris-ordered",
          levels: [d.LevelFormat.DECIMAL, d.LevelFormat.LOWER_LETTER, d.LevelFormat.LOWER_ROMAN, d.LevelFormat.DECIMAL].map((format, level) => ({
            level,
            format,
            text: `%${level + 1}.`,
            alignment: d.AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children: body.length ? body : [new d.Paragraph("")] }],
  });
  return d.Packer.toBlob(document);
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.replace(/[\\/:*?"<>|]+/g, " ").trim();
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---------------------------------------------------------------------------
 * Import
 * ------------------------------------------------------------------------- */

export type DocxImport = { html: string; uploaded: number; warnings: string[] };

/**
 * A Word document as memo HTML. `known` says whether an attachment is still on
 * the form; pictures that are not are handed to `uploadPicture` and come back
 * as figures of the new photo.
 */
export async function importMemoDocx(
  file: File,
  options: { known: (attachmentId: number) => boolean; uploadPicture: (file: File) => Promise<number> },
): Promise<DocxImport> {
  const mammoth = (await import("mammoth")).default;
  let uploaded = 0;
  const warnings: string[] = [];
  let pictureNumber = 0;
  // Figures whose photo is no longer on the form come back as new photos; their citations follow.
  const renumbered = new Map<number, number>();
  const widths = new Map<number, number>();

  const result = await mammoth.convertToHtml(
    { arrayBuffer: await file.arrayBuffer() },
    {
      styleMap: ["p[style-name='Caption'] => p.eris-caption:fresh", "p[style-name='caption'] => p.eris-caption:fresh", "u => u"],
      convertImage: mammoth.images.imgElement(async (image) => {
        pictureNumber += 1;
        const alt = String((image as unknown as { altText?: string }).altText ?? "");
        const tagged = Number(new RegExp(`${ALT_PREFIX}(\\d+)`).exec(alt)?.[1]);
        const width = Number(/width=(\d+)/.exec(alt)?.[1]);
        if (tagged && options.known(tagged)) {
          if (width) widths.set(tagged, width);
          return { src: `eris:${tagged}` };
        }
        try {
          const bytes = await image.readAsArrayBuffer();
          const ext = (image.contentType.split("/")[1] || "png").replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "");
          const id = await options.uploadPicture(new File([bytes], `${file.name.replace(/\.docx$/i, "")} picture ${pictureNumber}.${ext}`, { type: image.contentType }));
          uploaded += 1;
          if (tagged) renumbered.set(tagged, id);
          if (width) widths.set(id, width);
          return { src: `eris:${id}` };
        } catch (error) {
          warnings.push(`Picture ${pictureNumber} was not uploaded: ${error instanceof Error ? error.message : String(error)}`);
          return { src: "eris:0" };
        }
      }),
    },
  );

  const page = new DOMParser().parseFromString(`<body>${result.value}</body>`, "text/html");
  const body = page.body;

  // Pictures become figures, with the caption paragraph that follows them.
  for (const img of [...body.querySelectorAll("img")]) {
    const id = Number(/^eris:(\d+)$/.exec(img.getAttribute("src") ?? "")?.[1]);
    const block = img.closest("p, li, td, th, h1, h2, h3, h4, h5, h6") ?? img;
    img.remove();
    if (!id) continue;
    const next = block.nextElementSibling;
    let caption = "";
    if (next && next.tagName === "P" && (next.classList.contains("eris-caption") || /^\s*fig(ure|\.)?\s*\d/i.test(next.textContent ?? ""))) {
      caption = stripFigurePrefix(next.textContent ?? "");
      next.remove();
    }
    const figure = page.createElement("figure");
    figure.setAttribute("data-figure", String(id));
    figure.setAttribute("data-caption", caption);
    if (widths.has(id)) figure.setAttribute("data-width", String(widths.get(id)));
    // A figure is a block of its own: after the paragraph it sat in (or the table holding it).
    const anchor = block.closest("table") ?? block;
    anchor.after(figure);
    if (block !== img && !(block.textContent ?? "").trim() && !block.querySelector("img")) block.remove();
  }

  // Captions Word kept without a picture before them stay as plain paragraphs.
  body.querySelectorAll("p.eris-caption").forEach((p) => p.removeAttribute("class"));

  // Links to a figure's bookmark are citations; the bookmarks themselves go.
  for (const link of [...body.querySelectorAll("a")]) {
    const href = link.getAttribute("href") ?? "";
    const bookmarked = Number(new RegExp(`#.*${BOOKMARK_PREFIX}(\\d+)$`).exec(href)?.[1]);
    const target = renumbered.get(bookmarked) ?? bookmarked;
    if (target) {
      const ref = page.createElement("span");
      ref.setAttribute("data-figure-ref", String(target));
      ref.textContent = link.textContent;
      link.replaceWith(ref);
    } else if (!href) {
      link.replaceWith(...link.childNodes);
    }
  }

  for (const message of result.messages) {
    if (message.type === "error") warnings.push(message.message);
  }
  return { html: body.innerHTML, uploaded, warnings };
}

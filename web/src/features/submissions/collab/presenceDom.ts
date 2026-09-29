// Where in the form someone is, read from the page: the area (a card of the
// GISA sheet, a memo) is the closest `data-presence-area`; the field is named
// by its label, which reads the same on every screen.

const LABELS = "label, legend, [data-presence-label]";

const labelText = (label: Element) => (label.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160);

function nearestLabel(node: Element): Element | null {
  for (const child of Array.from(node.children)) {
    if (child.matches(LABELS)) return child;
  }
  for (const child of Array.from(node.children)) {
    const inner = Array.from(child.children).find((grandchild) => grandchild.matches(LABELS));
    if (inner) return inner;
  }
  return null;
}

/** The area (`card:…`, `memo:…`) an element is in, and that area's element. */
export function areaOf(element: Element | null): { key: string; element: HTMLElement } | null {
  const area = element?.closest<HTMLElement>("[data-presence-area]");
  const key = area?.dataset.presenceArea;
  return area && key ? { key, element: area } : null;
}

/** The label of the field an element belongs to, inside its area. */
export function fieldOf(element: Element, area: Element): string | null {
  let node: Element | null = element;
  while (node && node !== area) {
    const label = nearestLabel(node);
    const text = label ? labelText(label) : "";
    if (text) return text;
    node = node.parentElement;
  }
  return null;
}

/** The element to outline for a field named `field` inside `area`. */
export function fieldElement(area: Element, field: string): HTMLElement | null {
  const label = Array.from(area.querySelectorAll(LABELS)).find((candidate) => labelText(candidate) === field);
  let wrapper = label?.parentElement ?? null;
  // A field whose label sits in a header row: outline the whole field.
  const outer = wrapper?.parentElement;
  if (wrapper && outer && outer !== area && outer.querySelectorAll(LABELS).length === 1) wrapper = outer;
  return wrapper as HTMLElement | null;
}

// Dependency-free so it runs under `node --test`. How the header search finds
// things in ERIS: every word typed must match some field of an item (a whole
// word, the start of a word, inside a word, or one typo away); matches in the
// name or title count most.

export type SearchKind = "page" | "person" | "office" | "branch" | "incident" | "assessment" | "group" | "form";

export type SearchField = { text: string | null | undefined; weight: number };

export type SearchEntry = {
  key: string;
  kind: SearchKind;
  label: string;
  description: string;
  link: string;
  fields: SearchField[];
};

/** Lower case, accents and punctuation out ("05-MON-001" -> "05 mon 001"). */
export function normalize(text: string | null | undefined): string {
  return (text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9@.]+/g, " ")
    .replace(/\.(?=\s|$)/g, " ")
    .trim();
}

function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else if (a[i + 1] === b[j] && a[i] === b[j + 1]) {
      i += 2; // a swapped pair
      j += 2;
    } else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** How well one typed word matches one field: 0 when it does not. */
function termScore(term: string, text: string): number {
  if (!text) return 0;
  const words = text.split(" ");
  if (words.includes(term)) return 3;
  if (words.some((w) => w.startsWith(term))) return 2;
  if (term.length >= 3 && text.includes(term)) return 1;
  if (term.length >= 4 && words.some((w) => withinOneEdit(term, w.slice(0, term.length + 1)) || withinOneEdit(term, w))) return 0.6;
  return 0;
}

/** The entry's score for a query, or null when some typed word matches nothing. */
export function scoreEntry(entry: SearchEntry, query: string): number | null {
  const terms = normalize(query).split(" ").filter(Boolean);
  if (!terms.length) return null;
  const fields = entry.fields.map((f) => ({ text: normalize(f.text), weight: f.weight }));
  let total = 0;
  for (const term of terms) {
    let best = 0;
    for (const field of fields) best = Math.max(best, termScore(term, field.text) * field.weight);
    if (!best) return null;
    total += best;
  }
  return total;
}

/** The best matches, best first. */
export function search(entries: readonly SearchEntry[], query: string, limit = 14): SearchEntry[] {
  const scored: Array<[number, SearchEntry]> = [];
  for (const entry of entries) {
    const score = scoreEntry(entry, query);
    if (score != null) scored.push([score, entry]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].label.localeCompare(b[1].label));
  return scored.slice(0, limit).map(([, entry]) => entry);
}

/** "05" -> "05 district 5 d5", so a district reads however it is typed. */
export function districtWords(district: string | null | undefined): string {
  const n = Number(String(district ?? "").replace(/\D/g, ""));
  if (!n) return "";
  return `${String(n).padStart(2, "0")} district ${n} d${n}`;
}

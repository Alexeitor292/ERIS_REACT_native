// Dependency-free so it runs under `node --test`. Who else is in a technical
// form, as the page shows them: a coloured circle with their initials on the
// card and field they are in.

export type PresenceOther = {
  session_id: string;
  user_id: number;
  name: string;
  /** "card:<id>" or "memo:<key>": the part of the form they are in. */
  area: string | null;
  /** The label of the field they are in, inside that area. */
  field: string | null;
  /** Memos they are writing (locked for everyone else). */
  memos: string[];
};

export type PresenceReply = {
  others: PresenceOther[];
  granted: string[];
  denied: Record<string, { user_id: number; name: string }>;
  revision: number;
  saved_by: { user_id: number; name: string } | null;
  saved_at: string | null;
};

/** "Maria Garcia" -> "MG"; "maria.garcia@dot.ca.gov" -> "MG"; one name -> its first two letters. */
export function initialsOf(name: string): string {
  const cleaned = name.includes("@") ? name.split("@")[0].replace(/[._-]+/g, " ") : name;
  const words = cleaned.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

// Mid-tone colours that carry white initials on either theme and stay apart
// from the brand blue and the good/bad colours.
const COLORS = ["#c2410c", "#7c3aed", "#0f766e", "#be185d", "#4d7c0f", "#b45309", "#1d4ed8", "#9f1239"];

/** One colour per person, the same on every screen. */
export function colorFor(userId: number): string {
  return COLORS[Math.abs(Math.trunc(userId)) % COLORS.length];
}

/** The people in one area of the form, one mark per person. */
export function othersIn(others: readonly PresenceOther[], area: string): PresenceOther[] {
  const seen = new Set<number>();
  return others.filter((other) => {
    if (other.area !== area || seen.has(other.user_id)) return false;
    seen.add(other.user_id);
    return true;
  });
}

/** Everyone in the form, once each. */
export function people(others: readonly PresenceOther[]): PresenceOther[] {
  const seen = new Set<number>();
  return others.filter((other) => (seen.has(other.user_id) ? false : (seen.add(other.user_id), true)));
}

/** Memo key -> the person writing it. */
export function memoWriters(others: readonly PresenceOther[]): Record<string, PresenceOther> {
  const writers: Record<string, PresenceOther> = {};
  for (const other of others) for (const memo of other.memos) writers[memo] ??= other;
  return writers;
}

/** "Maria Garcia is also in this form", "Maria Garcia and Juan Campos…", "3 others…". */
export function presenceSentence(others: readonly PresenceOther[]): string {
  const names = people(others).map((other) => other.name);
  if (!names.length) return "";
  if (names.length === 1) return `${names[0]} is also in this form`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are also in this form`;
  return `${names.length} others are also in this form`;
}

const UNITS: Record<string, string> = { ft: "ft", in: "in", pct: "%", deg: "°" };
const NAMED: Record<string, string> = {
  ea: "EA",
  project_id: "Project ID",
  post_mile: "Post mile",
  route: "Highway (route)",
  geometry_json: "Site areas",
  district_contact: "District contacts",
  observations_notes: "Observations",
  geotechnical_assessment_notes: "Geotechnical assessment",
  recommendations_notes: "Recommendations",
  sketchpad_notes: "Sketch notes",
  record_of_event_notes: "Notes on earlier incidents",
  maintenance_history_notes: "Notes on maintenance",
  "list:inc": "Incident types",
  "list:imm": "Immediate actions",
  "list:fol": "Follow-up actions",
};

/** A readable name for a form field ("crack_length_ft" -> "Crack length (ft)"). */
export function fieldLabel(key: string): string {
  const bare = key.replace(/^memo:/, "").replace(/_html$/, "");
  if (NAMED[bare]) return NAMED[bare];
  const parts = bare.split("_");
  const unit = UNITS[parts[parts.length - 1]];
  if (unit) parts.pop();
  if (parts[0] === "est") parts[0] = "estimated";
  const words = parts.join(" ");
  const label = words.charAt(0).toUpperCase() + words.slice(1);
  return unit ? `${label} (${unit})` : label;
}

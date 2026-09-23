import type { PickerGroup, RoutingUserOption } from "../../api/assessments";

/**
 * The pure model behind PersonPicker. No React, no network — unit tested with
 * node --test.
 *
 * ONE RULE governs this file, and it is the reason the model is separate from
 * the component: **inform, never choose** (owner decision 7). Grouping,
 * location, workload and availability are annotations a human reads; nothing
 * here returns a default, a recommendation or a ranking, and
 * `initialPickerValue` returns null for every data shape — including a list
 * with exactly one candidate, which is the case an implementer's instinct
 * "helpfully" preselects.
 *
 * The second rule: **nobody is hidden**. A person marked ROTATION_OUT is
 * rendered with their return date. A branch that is not staffed yet is rendered
 * disabled with the reason. Filtering either of them out would be the picker
 * making the choice.
 *
 * Like every unit-tested model here it is dependency-free — `node --test` needs
 * explicit extensions for runtime imports — so the two district formatters below
 * are its own rather than imported from `utils/orgDistricts`, which holds the
 * same rules for the bundled admin surface. Both are covered by tests; if one
 * changes, the other must.
 */

export type PickerPerson = RoutingUserOption & { roles?: string[] };

export type PickerSection = {
  group: PickerGroup;
  label: string;
  /** Non-null when nobody in this group may be chosen, and says why. */
  disabledReason: string | null;
  /** The group's home city / district, for the heading. */
  place: string | null;
  items: PickerPerson[];
};

const OTHER_GROUP_KEY = "__other__";
const OTHER_GROUP_LABEL = "Not in a listed group";

/** "D4", "D11" — a district as it reads in a sentence, from the stored "04". */
export function districtLabel(district: string | null | undefined): string | null {
  const code = (district ?? "").trim();
  if (!code) return null;
  return `D${code.replace(/^0+(?=\d)/, "")}`;
}

/** "Oakland D4", "Oakland", "D4" — whichever parts exist, or null. */
export function placeLabel(city: string | null | undefined, district: string | null | undefined): string | null {
  const parts = [(city ?? "").trim(), districtLabel(district) ?? ""].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

/** A branch's display name; letter-first when the branch has no printed name. */
export function branchLabelOf(source: { branch_name?: string | null; branch_letter?: string | null } | null | undefined): string | null {
  if (!source) return null;
  const name = (source.branch_name ?? "").trim();
  if (name) return name;
  const letter = (source.branch_letter ?? "").trim();
  return letter ? `Branch ${letter}` : null;
}

/**
 * Why this group cannot be chosen from, or null.
 *
 * SOUTH Branch E is the case this exists for: it is on the chart, its chief box
 * is vacant and its three staff boxes are dashed, so the server returns it with
 * `accepts_assignments = 0` rather than omitting it. Omitting it would tell an
 * office chief that a branch they can see on the wall does not exist.
 */
export function groupDisabledReason(group: PickerGroup): string | null {
  const name = branchLabelOf(group) ?? group.label ?? "This group";
  if (group.is_active === false) return `${name} has been retired`;
  if (group.accepts_assignments === false) return `${name} is not staffed yet`;
  return null;
}

/**
 * Groups and their people, in the order the server gave them.
 *
 * A person whose `group_key` names no group is not dropped — they land in a
 * trailing "Not in a listed group" section. Losing a candidate silently is
 * worse than an ugly heading: the chief would never know the person existed.
 */
export function buildPickerSections(groups: PickerGroup[], items: PickerPerson[]): PickerSection[] {
  const known = new Map<string, PickerSection>();
  const sections: PickerSection[] = (groups ?? []).map((group) => {
    const section: PickerSection = {
      group,
      label: (group.label ?? "").trim() || branchLabelOf(group) || "Group",
      disabledReason: groupDisabledReason(group),
      place: placeLabel(group.home_city, group.home_district),
      items: [],
    };
    known.set(group.group_key, section);
    return section;
  });

  let other: PickerSection | null = null;
  for (const item of items ?? []) {
    const section = known.get(item.group_key);
    if (section) {
      section.items.push(item);
      continue;
    }
    if (!other) {
      other = {
        group: { group_key: OTHER_GROUP_KEY, label: OTHER_GROUP_LABEL, branch_id: null, branch_letter: null, branch_name: null },
        label: OTHER_GROUP_LABEL,
        disabledReason: null,
        place: null,
        items: [],
      };
    }
    other.items.push(item);
  }
  if (other) sections.push(other);
  return sections;
}

/** Every person in render order, groups first, as the server ordered them. */
export function flattenPickerOptions(sections: PickerSection[]): PickerPerson[] {
  return sections.flatMap((section) => section.items);
}

/** The people who may actually be chosen: a disabled group's members may not. */
export function selectablePickerOptions(sections: PickerSection[]): PickerPerson[] {
  return sections.filter((section) => !section.disabledReason).flatMap((section) => section.items);
}

export function pickerOptionCount(sections: PickerSection[]): number {
  return flattenPickerOptions(sections).length;
}

/**
 * The initial value of a picker. ALWAYS null.
 *
 * Written as a function rather than a constant so the rule has somewhere to be
 * tested: a single-candidate list must still require an explicit choice, and a
 * future "convenience" that preselects it has to delete this function to do so.
 */
export function initialPickerValue(_sections?: PickerSection[]): number | null {
  return null;
}

/** Has a human chosen? A primary action stays disabled until this is true. */
export function isChoiceMade(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** The chosen person, or null. Never falls back to "the only one". */
export function selectedPerson(sections: PickerSection[], value: number | null): PickerPerson | null {
  if (!isChoiceMade(value)) return null;
  return flattenPickerOptions(sections).find((person) => person.id === value) ?? null;
}

const AVAILABILITY_LABELS: Record<string, string> = {
  ROTATION_OUT: "Rotation out",
  ACTING_ELSEWHERE: "Acting elsewhere",
  UNAVAILABLE: "Unavailable",
};

/**
 * "2/5/27" from "2027-02-05".
 *
 * Parsed off the string rather than through `Date`, so a date-only value cannot
 * shift a day backwards in a western time zone — which is exactly what would
 * happen to every return date in California.
 */
export function formatAvailabilityDate(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (match) {
    const [, year, month, day] = match;
    return `${Number(month)}/${Number(day)}/${year.slice(2)}`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return `${parsed.getMonth() + 1}/${parsed.getDate()}/${String(parsed.getFullYear()).slice(2)}`;
}

/**
 * "Rotation out — back 2/5/27", or null for someone who is simply around.
 *
 * Rendered beside the name and nothing else: the person is not hidden, not
 * greyed out and not moved down the list (design §5, open question 9).
 */
export function availabilityNote(person: Pick<PickerPerson, "availability" | "available_until">): string | null {
  const state = (person.availability ?? "AVAILABLE").toUpperCase();
  const label = AVAILABILITY_LABELS[state];
  if (!label) return null;
  const back = formatAvailabilityDate(person.available_until);
  return back ? `${label} — back ${back}` : label;
}

/**
 * "4 open · 2 waiting on them".
 *
 * "them", not "you": in a picker the number is about a third party. The same
 * count is "waiting on you" in My Work, where the reader is the subject.
 */
export function workloadNote(person: Pick<PickerPerson, "open_assessment_count" | "awaiting_action_count">): string {
  const open = Number(person.open_assessment_count ?? 0);
  const awaiting = Number(person.awaiting_action_count ?? 0);
  if (open <= 0 && awaiting <= 0) return "No open assessments";
  const parts = [`${open} open`];
  if (awaiting > 0) parts.push(`${awaiting} waiting on them`);
  return parts.join(" · ");
}

/** "Branch C · Oakland D4" — where this person sits, under their name. */
export function personPlaceNote(person: PickerPerson): string | null {
  const parts = [branchLabelOf(person) ?? "", placeLabel(person.home_city, person.home_district) ?? ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** The next selectable index for an arrow key, wrapping at both ends. */
export function moveHighlight(options: PickerPerson[], current: number, delta: number): number {
  if (options.length === 0) return -1;
  if (current < 0) return delta > 0 ? 0 : options.length - 1;
  const next = (current + delta + options.length) % options.length;
  return next;
}

/**
 * Typeahead: the next option whose name starts with the buffer, searching after
 * the current position and wrapping once, so repeated letters cycle.
 */
export function typeaheadIndex(options: PickerPerson[], buffer: string, current: number): number {
  const needle = buffer.trim().toLowerCase();
  if (!needle || options.length === 0) return -1;
  for (let offset = 1; offset <= options.length; offset += 1) {
    const index = ((current < 0 ? -1 : current) + offset + options.length) % options.length;
    if ((options[index].full_name ?? "").toLowerCase().startsWith(needle)) return index;
  }
  return -1;
}

/**
 * Whether a chosen Staff member sits outside the branch this assessment was
 * handed to. The server allows it WITH a recorded reason and refuses it without
 * one, so the client warns before the refusal rather than after (design §5).
 */
export function isOutOfBranchChoice(
  person: PickerPerson | null,
  assessmentBranchId: number | null | undefined,
): boolean {
  if (!person || assessmentBranchId == null) return false;
  if (person.branch_id == null) return false;
  return Number(person.branch_id) !== Number(assessmentBranchId);
}

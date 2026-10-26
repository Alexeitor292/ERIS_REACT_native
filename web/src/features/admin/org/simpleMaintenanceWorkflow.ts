import type { Definition, Duty, Person, Step } from "../../../api/maintenanceWorkflows";

export type SimpleReview = {
  /** The review duty ID; keep it stable when editing or reordering steps. */
  id: string;
  name: string;
  userIds: number[];
  rule: "ANY" | "ALL";
};

export type SimpleWorkflow = {
  managerIds: number[];
  reporterIds: number[];
  decisionIds: number[];
  notifyIds: number[];
  reviews: SimpleReview[];
  allowMaintenance: boolean;
  allowGeotech: boolean;
};

const REPORTERS = "reporters";
const DECISION = "decision";
const INFORMED = "informed";
const REPORTER_NAME = "Incident reporters";
const DECISION_NAME = "Final decision makers";
const INFORMED_NAME = "Keep informed";
const FINAL_STEP_NAME = "Maintenance or GeoTech decision";
const RESERVED_IDS = new Set([REPORTERS, DECISION, INFORMED]);

function duty(id: string, name: string, userIds: number[], overrides: Partial<Duty> = {}): Duty {
  return { id, name, user_ids: [...userIds], report: false, view_district: false, edit_report: false, ...overrides };
}

function step(name: string, kind: Step["kind"], dutyId: string, rule: Step["rule"]): Step {
  return {
    name, kind, duty_ids: [dutyId], notify_duty_ids: [], rule,
    request_information: true, allow_maintenance: false, allow_geotech: false,
  };
}

export function createInitialDefinition(
  managerId: number,
  reporterIds: number[] = [],
  decisionIds: number[] = managerId > 0 ? [managerId] : [],
): Definition {
  return fromSimpleWorkflow({
    managerIds: managerId > 0 ? [managerId] : [], reporterIds, decisionIds,
    notifyIds: [], reviews: [], allowMaintenance: true, allowGeotech: true,
  });
}

export function fromSimpleWorkflow(state: SimpleWorkflow): Definition {
  const duties = [
    duty(REPORTERS, REPORTER_NAME, state.reporterIds, { report: true }),
    duty(DECISION, DECISION_NAME, state.decisionIds, { view_district: true }),
    ...state.reviews.map(review => duty(review.id, review.name, review.userIds)),
  ];
  if (state.notifyIds.length) duties.push(duty(INFORMED, INFORMED_NAME, state.notifyIds));
  const steps = state.reviews.map(review => step(review.name, "REVIEW", review.id, review.rule));
  steps.push({
    ...step(FINAL_STEP_NAME, "DECISION", DECISION, "ANY"),
    allow_maintenance: state.allowMaintenance,
    allow_geotech: state.allowGeotech,
  });
  return {
    manager_user_ids: [...state.managerIds], duties, steps,
    notify_duty_ids: state.notifyIds.length ? [INFORMED] : [],
  };
}

function standardDuty(value: Duty | undefined, name: string, flags: { report: boolean; view_district: boolean }): boolean {
  return !!value && value.name === name && value.report === flags.report &&
    value.view_district === flags.view_district && value.edit_report === false;
}

/** Complex saved definitions stay in the full editor so conversion cannot hide or erase settings. */
export function isSimpleDefinition(definition: Definition): boolean {
  if (!definition.steps.length || definition.steps[definition.steps.length - 1]?.kind !== "DECISION") return false;
  const byId = new Map(definition.duties.map(item => [item.id, item]));
  if (byId.size !== definition.duties.length) return false;
  if (!standardDuty(byId.get(REPORTERS), REPORTER_NAME, { report: true, view_district: false }) ||
      !standardDuty(byId.get(DECISION), DECISION_NAME, { report: false, view_district: true })) return false;

  const informed = byId.get(INFORMED);
  if (informed && !standardDuty(informed, INFORMED_NAME, { report: false, view_district: false })) return false;
  if (definition.notify_duty_ids.length !== (informed?.user_ids.length ? 1 : 0) ||
      (definition.notify_duty_ids.length === 1 && definition.notify_duty_ids[0] !== INFORMED)) return false;

  const reviewIds = new Set<string>();
  for (const review of definition.steps.slice(0, -1)) {
    if (review.kind !== "REVIEW" || review.duty_ids.length !== 1 || review.notify_duty_ids.length ||
        !review.request_information || review.allow_maintenance || review.allow_geotech ||
        (review.rule !== "ANY" && review.rule !== "ALL")) return false;
    const id = review.duty_ids[0];
    const assignedDuty = byId.get(id);
    if (RESERVED_IDS.has(id) || reviewIds.has(id) || !assignedDuty ||
        !standardDuty(assignedDuty, review.name, { report: false, view_district: false })) return false;
    reviewIds.add(id);
  }
  const final = definition.steps[definition.steps.length - 1];
  if (final.name !== FINAL_STEP_NAME || final.duty_ids.length !== 1 || final.duty_ids[0] !== DECISION ||
      final.notify_duty_ids.length || final.rule !== "ANY" || !final.request_information) return false;
  return definition.duties.every(item => RESERVED_IDS.has(item.id) || reviewIds.has(item.id));
}

export function toSimpleWorkflow(definition: Definition): SimpleWorkflow {
  if (!isSimpleDefinition(definition)) throw new Error("This workflow has advanced settings; use the full editor.");
  const byId = new Map(definition.duties.map(item => [item.id, item]));
  return {
    managerIds: [...definition.manager_user_ids],
    reporterIds: [...byId.get(REPORTERS)!.user_ids],
    decisionIds: [...byId.get(DECISION)!.user_ids],
    notifyIds: [...(byId.get(INFORMED)?.user_ids || [])],
    reviews: definition.steps.slice(0, -1).map(item => ({
      id: item.duty_ids[0], name: item.name,
      userIds: [...byId.get(item.duty_ids[0])!.user_ids], rule: item.rule,
    })),
    allowMaintenance: definition.steps[definition.steps.length - 1].allow_maintenance,
    allowGeotech: definition.steps[definition.steps.length - 1].allow_geotech,
  };
}

/** Client-side guidance; the publish API remains the authority on validity and active users. */
export function validateSimpleWorkflow(state: SimpleWorkflow, people: Person[] | Record<number, Person> = []): string[] {
  const errors: string[] = [];
  if (!state.managerIds.length) errors.push("Choose at least one workflow manager.");
  if (!state.reporterIds.length) errors.push("Choose at least one person who can submit reports.");
  if (!state.decisionIds.length) errors.push("Choose at least one final decision maker.");
  if (!state.allowMaintenance && !state.allowGeotech) errors.push("Allow at least one final outcome.");

  const selected = [state.managerIds, state.reporterIds, state.decisionIds, state.notifyIds,
    ...state.reviews.map(item => item.userIds)];
  if (selected.some(ids => ids.some(id => !Number.isInteger(id) || id <= 0) || new Set(ids).size !== ids.length)) {
    errors.push("Each person must be selected once per group.");
  }
  const knownPeople = Array.isArray(people) ? people : Object.values(people);
  const inactive = new Set(knownPeople.filter(person => person.is_active === false).map(person => person.id));
  if (selected.some(ids => ids.some(id => inactive.has(id)))) errors.push("Remove inactive people before publishing.");

  const seen = new Set<string>();
  state.reviews.forEach((review, index) => {
    const label = review.name.trim() || `review step ${index + 1}`;
    if (!review.name.trim()) errors.push(`Name review step ${index + 1}.`);
    else if (review.name.length > 100) errors.push(`Keep ${label} under 100 characters.`);
    if (!review.userIds.length) errors.push(`Choose at least one reviewer for ${label}.`);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(review.id) || RESERVED_IDS.has(review.id) || seen.has(review.id)) {
      errors.push(`Review step ${index + 1} needs a unique identifier.`);
    }
    seen.add(review.id);
  });
  return errors;
}

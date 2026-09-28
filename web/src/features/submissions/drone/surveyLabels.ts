// How a drone survey is named on screen, and which of two was flown first.

export type SurveyIdentity = { id: number; label: string | null; dsm_filename: string | null; captured_on: string | null };

/** The survey's name: what it was called, else its elevation file, else its number. */
export function surveyName(s: SurveyIdentity): string {
  return s.label?.trim() || s.dsm_filename || `Survey ${s.id}`;
}

/** Its name and flight date: "After the storm, 2017-05-27". */
export function surveyTitle(s: SurveyIdentity): string {
  return s.captured_on ? `${surveyName(s)}, ${s.captured_on}` : surveyName(s);
}

/** True when `before` was flown after `now` (both dates known), so lost and gained read reversed. */
export function flownOutOfOrder(before: SurveyIdentity, now: SurveyIdentity): boolean {
  return !!before.captured_on && !!now.captured_on && before.captured_on > now.captured_on;
}

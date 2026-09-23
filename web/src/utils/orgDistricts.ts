// District codes, as ERIS stores and shows them.
//
// This module is dependency-free on purpose: it is unit tested with `node --test`
// (which needs explicit extensions for runtime imports) and shared by the org
// admin API client and the admin pages.
//
// The rule it exists to hold: a district is TWO DIGITS, zero-padded, everywhere
// it is stored and compared — "4" and "04" are the same district, and half the
// org model's joins are string comparisons on this value. An admin typing "5"
// into a districts-served field must not create a district nothing matches.

/**
 * A district as the server stores it: `"04"`, `"11"`. Returns null for anything
 * that is not a Caltrans district number, so a typo is refused by the form
 * rather than by a 422 from the API.
 */
export function normalizeDistrictCode(value: string | null | undefined): string | null {
  const digits = (value ?? "").trim().replace(/^d/i, "");
  if (!/^\d{1,2}$/.test(digits)) return null;
  const code = digits.padStart(2, "0");
  return code === "00" ? null : code;
}

/**
 * `"1, 4, 05"` → `["01", "04", "05"]`, sorted and de-duplicated.
 *
 * `invalid` names every token that could not be read, so the form can say which
 * one it refused instead of rejecting the whole field.
 */
export function parseDistrictList(value: string): { districts: string[]; invalid: string[] } {
  const districts: string[] = [];
  const invalid: string[] = [];
  for (const token of (value ?? "").split(/[\s,;]+/).filter(Boolean)) {
    const code = normalizeDistrictCode(token);
    if (!code) invalid.push(token);
    else if (!districts.includes(code)) districts.push(code);
  }
  districts.sort();
  return { districts, invalid };
}

/** `"04"` → `"D4"` — the way a district reads in a sentence. */
export function districtLabel(district: string | null | undefined): string | null {
  const code = (district ?? "").trim();
  if (!code) return null;
  return `D${code.replace(/^0+(?=\d)/, "")}`;
}

/** `"Oakland D4"`, `"Sacramento"`, `"D11"` — whichever parts exist, or null. */
export function placeLabel(city: string | null | undefined, district: string | null | undefined): string | null {
  const parts = [(city ?? "").trim(), districtLabel(district) ?? ""].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

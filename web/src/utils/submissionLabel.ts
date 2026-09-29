import { countyCodeFromNameOrCode } from "./caltransLookups";
import { normalizePostMileInput, normalizeRouteInput } from "./precision";

type SubmissionLabelParts = {
  id: number;
  created_at?: string | null;
  district?: string | null;
  county?: string | null;
  route?: string | null;
  post_mile?: string | null;
};

function formatCreatedAt(createdAt?: string | null): string {
  if (!createdAt) return "";
  const dt = new Date(createdAt);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Two digits, as in incident names: "5" and "District 5" read "05". */
function formatDistrict(district?: string | null): string {
  const raw = (district ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  return digits ? digits.padStart(2, "0") : raw || "?";
}

/** The county's Caltrans code, as in incident names: "Monterey" reads "MON". */
function formatCounty(county?: string | null): string {
  const raw = (county ?? "").trim();
  return countyCodeFromNameOrCode(raw) ?? (raw || "?");
}

function formatRoute(route?: string | null): string {
  return normalizeRouteInput(route) || "?";
}

function formatPostMile(postMile?: string | null): string {
  return normalizePostMileInput(postMile) || "?";
}

export function buildSubmissionDescriptor(parts: SubmissionLabelParts): string {
  const district = formatDistrict(parts.district);
  const county = formatCounty(parts.county);
  const route = formatRoute(parts.route);
  const postMile = formatPostMile(parts.post_mile);
  const when = formatCreatedAt(parts.created_at);
  const base = `${district}-${county}-${route}-${postMile}`;
  return when ? `${base} - ${when}` : base;
}

export function buildSubmissionDisplayTitle(parts: SubmissionLabelParts): string {
  return buildSubmissionDescriptor(parts);
}

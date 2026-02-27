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

function formatRoute(route?: string | null): string {
  const raw = (route || "").trim();
  if (!raw) return "?";
  if (/^\d+$/.test(raw)) return raw.padStart(3, "0");
  return raw;
}

function formatPostMile(postMile?: string | null): string {
  const raw = (postMile || "").trim();
  if (!raw) return "?";
  const num = Number(raw);
  if (Number.isNaN(num)) return raw;
  return num.toFixed(2);
}

export function buildSubmissionDescriptor(parts: SubmissionLabelParts): string {
  const district = (parts.district || "?").trim() || "?";
  const county = (parts.county || "?").trim() || "?";
  const route = formatRoute(parts.route);
  const postMile = formatPostMile(parts.post_mile);
  const when = formatCreatedAt(parts.created_at);
  const base = `${district}-${county}-${route}-${postMile}`;
  return when ? `${base} - ${when}` : base;
}

export function buildSubmissionDisplayTitle(parts: SubmissionLabelParts): string {
  return buildSubmissionDescriptor(parts);
}

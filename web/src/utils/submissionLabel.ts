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

export function buildSubmissionDescriptor(parts: SubmissionLabelParts): string {
  const district = (parts.district || "?").trim() || "?";
  const county = (parts.county || "?").trim() || "?";
  const route = (parts.route || "?").trim() || "?";
  const postMile = (parts.post_mile || "?").trim() || "?";
  const when = formatCreatedAt(parts.created_at);
  const base = `D${district}-${county}-R${route}-PM${postMile}`;
  return when ? `${base} • ${when}` : base;
}

export function buildSubmissionDisplayTitle(parts: SubmissionLabelParts): string {
  return buildSubmissionDescriptor(parts);
}

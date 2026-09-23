import { api } from "./client";
import type { UserOrg } from "./types";

// ---------------------------------------------------------------------------
// The organization — web API client
// ---------------------------------------------------------------------------
//
// Every organizational fact ERIS has is admin-editable data, not a constant in
// a client file (owner decision 8). This module is the only place the web app
// learns what an office is called, which districts it serves, what branches it
// has and who covers a district — the hard-coded office maps it replaces are
// deleted, not left beside it as a second answer.
//
// TWO READ LEVELS, deliberately different:
//   `/org/*`        labels, for every signed-in account including a read-only
//                   viewer, because an approved record names an office and a
//                   client that cannot resolve the name renders codes at people.
//   `/admin/org/*`  the records themselves, ADMIN only.

/** The public label view of an office: no personnel, no counts. */
export type OrgOfficeSummary = {
  id: number;
  code: string;
  org_type: string;
  unit_number: string | null;
  name: string | null;
  short_name: string | null;
  home_city: string | null;
  home_district: string | null;
  home_location_label: string | null;
  is_routing_target: boolean;
  is_active: boolean;
  sort_order: number;
  /** Active districts served, as plain codes. */
  districts?: string[];
  branches?: OrgBranchSummary[];
};

export type OrgBranchSummary = {
  id: number;
  unit_type: string;
  letter: string | null;
  name: string | null;
  home_city: string | null;
  home_district: string | null;
  accepts_assignments: boolean;
  is_active: boolean;
};

export type OrgOfficeDistrict = {
  id: number;
  district: string;
  is_primary: boolean;
  is_active: boolean;
};

/** The admin record: the same office, with its district rows and counts. */
export type OrgOfficeRecord = Omit<OrgOfficeSummary, "districts" | "branches"> & {
  districts: OrgOfficeDistrict[];
  branch_count?: number;
  member_count?: number;
};

/**
 * Where a branch's district coverage came from. No chart states branch-level
 * coverage for any office, so every row a deployment has was entered by a
 * person — the label is what keeps an inference from passing as fact.
 */
export type OrgBranchDistrictSource = "CHART" | "INFERRED" | "ADMIN";

export type OrgBranchDistrict = {
  id: number;
  district: string;
  source: OrgBranchDistrictSource;
  notes: string | null;
  is_active: boolean;
};

export type OrgUserBrief = { id: number; email: string; full_name: string };

export type OrgBranchRecord = {
  id: number;
  office_id: number;
  office_code: string | null;
  parent_branch_id: number | null;
  unit_type: string;
  letter: string | null;
  name: string | null;
  home_city: string | null;
  home_district: string | null;
  home_location_label: string | null;
  chief_user_id: number | null;
  accepts_assignments: boolean;
  is_active: boolean;
  sort_order: number;
  districts?: OrgBranchDistrict[];
  chief: OrgUserBrief | null;
  member_count?: number;
};

export type OrgCoverageUser = {
  coverage_id: number;
  id: number;
  email: string;
  full_name: string;
  is_primary: boolean;
  user_is_active: boolean;
};

export type OrgCoverageDistrict = { district: string; users: OrgCoverageUser[] };

export type OrgClassificationRule = {
  id: number;
  rule_kind: "CLASS" | "PATTERN" | string;
  class_code: string | null;
  marker: string | null;
  title_pattern: string | null;
  level_code: string | null;
  title: string | null;
  eris_role: string | null;
  is_supervisor: boolean | number;
  priority: number;
  notes: string | null;
  is_active: boolean | number;
};

/**
 * What the stored rules SUGGEST for a classification, and whether the account
 * already holds it. A suggestion is never a grant: `PUT /admin/users/{id}/org`
 * does not write `user_roles`, because the charts show a vacant office chief
 * filled out of class and a senior specialist covered out of class for eight
 * months (org model design §6).
 */
export type RoleSuggestion = {
  suggested_role: string | null;
  rule_kind: string;
  rule_id: number | null;
  title: string | null;
  is_supervisor: boolean;
  notes: string | null;
  matches_granted?: boolean;
  granted_roles?: string[];
};

export type UserOrgResponse = { user_id: number; org: UserOrg; role_suggestion: RoleSuggestion | null };

export type OfficeDirectory = Map<string, OrgOfficeSummary>;

// ---------------------------------------------------------------------------
// Labels: any signed-in account
// ---------------------------------------------------------------------------

export function listOrgOffices(includeInactive = false): Promise<{ offices: OrgOfficeSummary[] }> {
  return api<{ offices: OrgOfficeSummary[] }>(`/org/offices${includeInactive ? "?include_inactive=true" : ""}`);
}

let officeDirectoryPromise: Promise<OfficeDirectory> | null = null;

/**
 * The office label directory, fetched once per session.
 *
 * Cached at module scope because it is a small, slow-changing dictionary read by
 * several unrelated surfaces, and because the alternative — every panel fetching
 * it — is what the deleted hard-coded map was standing in for. `refreshOfficeDirectory`
 * exists for the admin pages, which change the very thing this caches.
 */
export function loadOfficeDirectory(): Promise<OfficeDirectory> {
  if (!officeDirectoryPromise) {
    officeDirectoryPromise = listOrgOffices(true)
      .then((response) => new Map((response.offices ?? []).map((office) => [office.code, office])))
      .catch((error) => {
        // A failed fetch must not poison the cache: the next caller retries and
        // the surfaces fall back to the office CODE in the meantime.
        officeDirectoryPromise = null;
        throw error;
      });
  }
  return officeDirectoryPromise;
}

export function refreshOfficeDirectory(): Promise<OfficeDirectory> {
  officeDirectoryPromise = null;
  return loadOfficeDirectory();
}

export function resolveDistrictOffice(district: string): Promise<{
  district: string | null;
  office: { id: number | null; code: string; name: string | null; short_name: string | null } | null;
  source: string | null;
}> {
  return api(`/org/districts/${encodeURIComponent(district)}/office`);
}

// ---------------------------------------------------------------------------
// Offices: ADMIN
// ---------------------------------------------------------------------------

export function adminListOffices(params: { includeInactive?: boolean; orgType?: string } = {}): Promise<{ items: OrgOfficeRecord[] }> {
  const query = new URLSearchParams();
  if (params.includeInactive) query.set("include_inactive", "true");
  if (params.orgType) query.set("org_type", params.orgType);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return api<{ items: OrgOfficeRecord[] }>(`/admin/org/offices${suffix}`);
}

export type OfficeCreateBody = {
  code: string;
  org_type?: "GEOTECH" | "MAINTENANCE";
  unit_number?: string | null;
  name: string;
  short_name?: string | null;
  home_city?: string | null;
  home_district?: string | null;
  home_location_label?: string | null;
  is_routing_target?: boolean;
  sort_order?: number;
};

/** `code` is absent on purpose: it is immutable after creation (org model design §3.8). */
export type OfficePatchBody = Partial<Omit<OfficeCreateBody, "code" | "org_type">> & { is_active?: boolean };

export function adminCreateOffice(body: OfficeCreateBody): Promise<{ office: OrgOfficeRecord }> {
  return api(`/admin/org/offices`, { method: "POST", body: JSON.stringify(body) });
}

export function adminPatchOffice(officeId: number, body: OfficePatchBody): Promise<{ office: OrgOfficeRecord }> {
  return api(`/admin/org/offices/${officeId}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function adminDeactivateOffice(officeId: number, reason?: string): Promise<{ office: OrgOfficeRecord; affected_assessments: number }> {
  return api(`/admin/org/offices/${officeId}/deactivate`, { method: "POST", body: JSON.stringify({ reason: reason ?? null }) });
}

export function adminReplaceOfficeDistricts(
  officeId: number,
  districts: string[],
  primaryDistrict?: string | null,
): Promise<{ districts: OrgOfficeDistrict[] }> {
  return api(`/admin/org/offices/${officeId}/districts`, {
    method: "PUT",
    body: JSON.stringify({ districts, primary_district: primaryDistrict ?? null }),
  });
}

// ---------------------------------------------------------------------------
// Branches: ADMIN
// ---------------------------------------------------------------------------

export function adminListBranches(params: { officeId?: number; includeInactive?: boolean } = {}): Promise<{ items: OrgBranchRecord[] }> {
  const query = new URLSearchParams();
  if (params.officeId != null) query.set("office_id", String(params.officeId));
  if (params.includeInactive) query.set("include_inactive", "true");
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return api<{ items: OrgBranchRecord[] }>(`/admin/org/branches${suffix}`);
}

export type BranchCreateBody = {
  office_id: number;
  unit_type?: "BRANCH" | "REGION" | "AREA" | "YARD";
  letter?: string | null;
  name: string;
  parent_branch_id?: number | null;
  home_city?: string | null;
  home_district?: string | null;
  home_location_label?: string | null;
  chief_user_id?: number | null;
  accepts_assignments?: boolean;
  sort_order?: number;
};

export type BranchPatchBody = Partial<Omit<BranchCreateBody, "office_id" | "unit_type">> & { is_active?: boolean };

export function adminCreateBranch(body: BranchCreateBody): Promise<{ branch: OrgBranchRecord }> {
  return api(`/admin/org/branches`, { method: "POST", body: JSON.stringify(body) });
}

export function adminPatchBranch(branchId: number, body: BranchPatchBody): Promise<{ branch: OrgBranchRecord }> {
  return api(`/admin/org/branches/${branchId}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function adminReplaceBranchDistricts(
  branchId: number,
  districts: string[],
  source: OrgBranchDistrictSource = "ADMIN",
  notes?: string | null,
): Promise<{ districts: OrgBranchDistrict[] }> {
  return api(`/admin/org/branches/${branchId}/districts`, {
    method: "PUT",
    body: JSON.stringify({ districts, source, notes: notes ?? null }),
  });
}

// ---------------------------------------------------------------------------
// Coordinator coverage: ADMIN
// ---------------------------------------------------------------------------

export function adminListCoverage(district?: string): Promise<{ items: OrgCoverageDistrict[]; uncovered_districts: string[] }> {
  const suffix = district ? `?district=${encodeURIComponent(district)}` : "";
  return api(`/admin/org/coverage${suffix}`);
}

export function adminAddCoverage(district: string, userId: number, isPrimary = true): Promise<unknown> {
  return api(`/admin/org/coverage`, {
    method: "POST",
    body: JSON.stringify({ district, user_id: userId, is_primary: isPrimary }),
  });
}

export function adminRemoveCoverage(coverageId: number): Promise<unknown> {
  return api(`/admin/org/coverage/${coverageId}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Classification rules and one person's place: ADMIN
// ---------------------------------------------------------------------------

export function adminListClassifications(includeInactive = true): Promise<{ items: OrgClassificationRule[] }> {
  return api(`/admin/org/classifications?include_inactive=${includeInactive ? "true" : "false"}`);
}

export function getUserOrg(userId: number): Promise<UserOrgResponse> {
  return api<UserOrgResponse>(`/admin/users/${userId}/org`);
}

/**
 * A PER-FIELD MERGE: omitted fields are untouched, so editing a branch cannot
 * silently clear a classification somebody else recorded. Grants nothing —
 * the response's `role_suggestion` is for a human to act on, or not.
 */
export type UserOrgBody = {
  office_id?: number | null;
  branch_id?: number | null;
  home_city?: string | null;
  home_district?: string | null;
  classification_code?: string | null;
  classification_marker?: string | null;
  position_number?: string | null;
  job_title?: string | null;
  level_code?: string | null;
  supervisor_user_id?: number | null;
  availability?: "AVAILABLE" | "ROTATION_OUT" | "ACTING_ELSEWHERE" | "UNAVAILABLE" | null;
  available_from?: string | null;
  available_until?: string | null;
  notes?: string | null;
};

export function putUserOrg(userId: number, body: UserOrgBody): Promise<UserOrgResponse> {
  return api<UserOrgResponse>(`/admin/users/${userId}/org`, { method: "PUT", body: JSON.stringify(body) });
}

// ---------------------------------------------------------------------------
// Display helpers shared by the pages
// ---------------------------------------------------------------------------

// District parsing and labelling live in utils/orgDistricts, which is
// dependency-free so `node --test` can cover the padding rule; they are
// re-exported here because every caller already imports this module.
export { districtLabel, normalizeDistrictCode, parseDistrictList, placeLabel } from "../utils/orgDistricts";

const BRANCH_DISTRICT_SOURCE_LABELS: Record<string, string> = {
  CHART: "From the chart",
  INFERRED: "Inferred",
  ADMIN: "Entered",
};

export function branchDistrictSourceLabel(source: string | null | undefined): string {
  return BRANCH_DISTRICT_SOURCE_LABELS[(source ?? "").toUpperCase()] ?? "Entered";
}

/** A branch's display name, letter-first when it has no printed name. */
export function branchLabel(branch: { letter?: string | null; name?: string | null } | null | undefined): string | null {
  if (!branch) return null;
  const name = (branch.name ?? "").trim();
  if (name) return name;
  const letter = (branch.letter ?? "").trim();
  return letter ? `Branch ${letter}` : null;
}

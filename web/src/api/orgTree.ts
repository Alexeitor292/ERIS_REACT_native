import { api } from "./client";

// The organization as trees (one per GeoTech office) and maintenance lists (one per
// district). Where a person sits decides their roles; see backend services/org_tree.py.

export type TreePosition = "OFFICE_CHIEF" | "SENIOR_SPECIALIST" | "BRANCH_CHIEF" | "STAFF";

export type TreePerson = {
  id: number;
  full_name: string;
  email: string;
  position: TreePosition | null;
  availability: string;
  available_until: string | null;
};

export type TreeBranch = {
  id: number;
  letter: string | null;
  name: string;
  home_city: string | null;
  home_district: string | null;
  accepts_assignments: boolean;
  chief: TreePerson | null;
  staff: TreePerson[];
  can_manage: boolean;
};

export type OfficeTree = {
  office: {
    id: number;
    code: string;
    name: string;
    short_name: string | null;
    unit_number: string | null;
    home_city: string | null;
    home_district: string | null;
    is_routing_target: boolean;
    is_active: boolean;
    districts: string[];
  };
  chiefs: TreePerson[];
  specialists: TreePerson[];
  branches: TreeBranch[];
  unbranched: TreePerson[];
  can_manage: boolean;
  can_name_chiefs: boolean;
};

export type Placement = {
  position: TreePosition | null;
  office_id: number | null;
  branch_id: number | null;
  office_code: string | null;
  label: string | null;
};

export type UnplacedPerson = { id: number; full_name: string; email: string; role: string };

export type TreePayload = {
  offices: OfficeTree[];
  me: Placement & { id: number; is_admin: boolean };
  unplaced: UnplacedPerson[];
};

export type PersonHit = {
  id: number;
  full_name: string;
  email: string;
  placement: Placement;
  maintenance: { coordinator: string[]; crew: string[] };
  roles: string[];
  is_admin: boolean;
};

export type MaintenanceDistrict = {
  district: string;
  coordinators: Array<{ id: number; full_name: string; email: string; is_primary: boolean }>;
  crew: Array<{ id: number; full_name: string; email: string }>;
};

export type MaintenancePayload = { districts: MaintenanceDistrict[]; unplaced: UnplacedPerson[] };

export type PersonDetails = {
  user_id: number;
  classification_code: string | null;
  classification_marker: string | null;
  position_number: string | null;
  job_title: string | null;
  level_code: string | null;
  home_city: string | null;
  home_district: string | null;
  availability: string;
  available_until: string | null;
};

const post = <T>(path: string, body?: unknown) => api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const getTree = () => api<TreePayload>("/org/tree");
export const findPeople = (q: string) => api<{ items: PersonHit[] }>(`/org/people?q=${encodeURIComponent(q)}`);
export const addOfficeChief = (officeId: number, userId: number) => post<TreePayload>(`/org/offices/${officeId}/chiefs`, { user_id: userId });
export const addSpecialist = (officeId: number, userId: number) => post<TreePayload>(`/org/offices/${officeId}/specialists`, { user_id: userId });
export const addBranch = (officeId: number, body: { name?: string; letter?: string | null; home_city?: string | null; home_district?: string | null }) =>
  post<TreePayload>(`/org/offices/${officeId}/branches`, body);
export const editBranch = (branchId: number, body: { name?: string; letter?: string | null; home_city?: string | null; home_district?: string | null }) =>
  api<TreePayload>(`/org/branches/${branchId}`, { method: "PATCH", body: JSON.stringify(body) });
export const setBranchChief = (branchId: number, userId: number) => post<TreePayload>(`/org/branches/${branchId}/chief`, { user_id: userId });
export const addStaff = (branchId: number, userId: number) => post<TreePayload>(`/org/branches/${branchId}/staff`, { user_id: userId });
export const retireBranch = (branchId: number) => post<TreePayload>(`/org/branches/${branchId}/retire`);
export const removeFromTree = (userId: number) => api<TreePayload>(`/org/tree/people/${userId}`, { method: "DELETE" });
export const getDetails = (userId: number) => api<PersonDetails>(`/org/tree/people/${userId}/details`);
export const putDetails = (userId: number, body: Partial<Omit<PersonDetails, "user_id">>) =>
  api<PersonDetails>(`/org/tree/people/${userId}/details`, { method: "PUT", body: JSON.stringify(body) });

export const getMaintenance = () => api<MaintenancePayload>("/org/maintenance");
export const addMaintenance = (district: string, kind: "coordinators" | "crew", userId: number) =>
  post<MaintenancePayload>(`/org/maintenance/${district}/${kind}`, { user_id: userId });
export const removeMaintenance = (district: string, kind: "coordinators" | "crew", userId: number) =>
  api<MaintenancePayload>(`/org/maintenance/${district}/${kind}/${userId}`, { method: "DELETE" });
export const makePrimaryCoordinator = (district: string, userId: number) =>
  post<MaintenancePayload>(`/org/maintenance/${district}/coordinators/${userId}/primary`);

export const setAdmin = (userId: number, isAdmin: boolean) =>
  api<{ user_id: number; roles: string[] }>(`/admin/users/${userId}/admin`, { method: "PUT", body: JSON.stringify({ is_admin: isAdmin }) });

export const POSITION_LABEL: Record<TreePosition, string> = {
  OFFICE_CHIEF: "Office Chief",
  SENIOR_SPECIALIST: "Senior Specialist",
  BRANCH_CHIEF: "Branch Chief",
  STAFF: "Staff",
};

/** Caltrans district headquarters, for the maintenance list. */
export const DISTRICT_HQ: Record<string, string> = {
  "01": "Eureka",
  "02": "Redding",
  "03": "Marysville",
  "04": "Oakland",
  "05": "San Luis Obispo",
  "06": "Fresno",
  "07": "Los Angeles",
  "08": "San Bernardino",
  "09": "Bishop",
  "10": "Stockton",
  "11": "San Diego",
  "12": "Irvine",
};

import { api } from "./client";

export type Person = {
  id: number;
  full_name: string;
  email?: string;
  is_active?: boolean;
  placement?: { label?: string | null };
  maintenance?: { coordinator?: string[]; crew?: string[] };
};
export type Duty = { id: string; name: string; user_ids: number[]; report: boolean; view_district: boolean; edit_report: boolean };
export type Step = { name: string; kind: "REVIEW" | "DECISION"; duty_ids: string[]; notify_duty_ids: string[]; rule: "ANY" | "ALL"; request_information: boolean; allow_maintenance: boolean; allow_geotech: boolean };
export type Definition = { manager_user_ids: number[]; duties: Duty[]; steps: Step[]; notify_duty_ids: string[] };
export type DistrictWorkflow = { district: string; revision: number; definition: Definition | null; can_manage: boolean; people: Person[] };
export type WorkItem = { id: number; title: string; district: string; outcome: string | null; step_name: string; waiting_reporter: boolean; my_turn: boolean };
export type WorkflowDetail = {
  incident_id: number; district: string; revision: number; version: number;
  state: { step_index: number; approved_user_ids: number[]; waiting_reporter: boolean; pending_outcome?: string | null; decision?: { event_group_id: number | null; new_group_title: string | null } };
  step: Step; steps: Array<{ name: string; kind: string }>; outcome: string | null;
  assigned: Person[]; events: Array<{ id: number; action: string; notes: string | null; actor_name: string; created_at: string }>;
  groups: Array<{ id: number; title: string }>;
  can_act: boolean; can_edit: boolean; can_resubmit: boolean; can_restart: boolean;
};
export const getWorkflows = () => api<{ districts: DistrictWorkflow[] }>("/maintenance-workflows");
export const workflowPeople = (district: string, q: string) => api<{ items: Person[] }>(`/maintenance-workflows/${district}/people?q=${encodeURIComponent(q)}`);
export const publishWorkflow = (district: string, revision: number, definition: Definition) => api<DistrictWorkflow>(`/maintenance-workflows/${district}`, { method: "PUT", body: JSON.stringify({ revision, definition }) });
export const maintenanceWork = () => api<{ items: WorkItem[] }>("/maintenance-work/incidents");
export const maintenanceDetail = (id: number) => api<WorkflowDetail>(`/maintenance-work/incidents/${id}`);
export const maintenanceAction = (id: number, body: { version: number; action: string; notes: string; description?: string; event_group_id?: number | null; new_group_title?: string | null }) => api<WorkflowDetail>(`/maintenance-work/incidents/${id}/actions`, { method: "POST", body: JSON.stringify(body) });

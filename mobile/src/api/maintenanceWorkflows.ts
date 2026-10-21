import { apiFetch } from "./client";

export type MaintenanceMembership = { district: string; report: boolean; manage: boolean };
export type MaintenanceWorkItem = { id: number; title: string; district: string; outcome: string | null; step_name: string; waiting_reporter: boolean; my_turn: boolean };
export type MaintenanceDetail = {
  version: number; revision: number; district: string; outcome: string | null;
  state: { step_index: number; approved_user_ids: number[]; waiting_reporter: boolean; pending_outcome?: string; decision?: { event_group_id: number | null; new_group_title: string | null } };
  step: { name: string; kind: string; rule: string; allow_geotech: boolean; allow_maintenance: boolean; request_information: boolean };
  steps: Array<{ name: string; kind: string }>;
  assigned: Array<{ id: number; full_name: string; is_active: boolean }>;
  groups: Array<{ id: number; title: string }>;
  events: Array<{ id: number; actor_name: string; action: string; notes: string; created_at: string }>;
  can_act: boolean; can_edit: boolean; can_resubmit: boolean; can_restart: boolean;
};
export const maintenanceWork = (token: string) => apiFetch<{ items: MaintenanceWorkItem[] }>("/maintenance-work/incidents", { token });
export const maintenanceDetail = (token: string, id: number) => apiFetch<MaintenanceDetail>(`/maintenance-work/incidents/${id}`, { token });

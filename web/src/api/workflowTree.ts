import { api } from "./client";

// ---------------------------------------------------------------------------
// Incident Workflow Tree — web API client
// ---------------------------------------------------------------------------

export type WorkflowNodeStatus =
  | "COMPLETED"
  | "CURRENT"
  | "PENDING"
  | "WAITING_ON_REPORTER"
  | "REVISION_REQUESTED"
  | "SKIPPED"
  | "TERMINAL"
  | "UNASSIGNED";

export type WorkflowPathType =
  | "PENDING_TRIAGE"
  | "ASSESSMENT_REQUIRED"
  | "NEEDS_REPORTER_INFORMATION"
  | "NO_ASSESSMENT_REQUIRED"
  | "DUPLICATE_OR_LINKED";

export type WorkflowUser = {
  user_id: number;
  full_name: string | null;
  email: string | null;
};

export type WorkflowNode = {
  key: string;
  role: string;
  role_title: string;
  label: string;
  status: WorkflowNodeStatus;
  user: WorkflowUser | null;
  completed_at: string | null;
  notes: string | null;
  event_type: string | null;
  disposition?: string | null;
  linked_incident_id?: number | null;
  linked_location_id?: number | null;
};

export type WorkflowCurrentOwner = {
  role: string;
  role_title: string;
  user_id: number | null;
  full_name: string | null;
  email: string | null;
  node_key: string;
} | null;

export type WorkflowTree = {
  incident_id: number;
  path_type: WorkflowPathType;
  overall_status: WorkflowNodeStatus;
  current_owner: WorkflowCurrentOwner;
  assessment: {
    id: number;
    state: string;
    office_code: string | null;
    assigned_engineer_user_id: number | null;
    branch_chief_user_id: number | null;
  } | null;
  linked_incident_id: number | null;
  linked_location_id: number | null;
  nodes: WorkflowNode[];
};

export function getWorkflowTree(incidentId: number): Promise<WorkflowTree> {
  return api<WorkflowTree>(`/incidents/${incidentId}/workflow-tree`);
}

import { api } from "./client";
import type { ActingOption } from "./types";

export type DelegationStatus = "SCHEDULED" | "ACTIVE" | "ENDED" | "CANCELLED";

export type Delegation = {
  id: number;
  delegator: { id: number; full_name: string };
  delegate: { id: number; full_name: string };
  starts_on: string;
  ends_on: string;
  note: string | null;
  status: DelegationStatus;
  action_count: number;
};

export type DelegationOverview = { given: Delegation[]; received: Delegation[]; acting_options: ActingOption[] };
export type DelegationCandidate = { id: number; full_name: string; email: string; placement: string };
export type DelegatedAction = { method: string; path: string; actor_name: string; created_at: string };

export function myDelegations(): Promise<DelegationOverview> {
  return api<DelegationOverview>("/delegations");
}

export function delegationPeople(): Promise<{ items: Array<{ id: number; full_name: string }> }> {
  return api("/delegations/people");
}

export function delegationCandidates(forUserId?: number | null): Promise<{ items: DelegationCandidate[] }> {
  return api(`/delegations/candidates${forUserId ? `?for_user_id=${forUserId}` : ""}`);
}

export function createDelegation(body: {
  delegate_user_id: number;
  starts_on: string;
  ends_on: string;
  note?: string;
  for_user_id?: number;
}): Promise<DelegationOverview> {
  return api("/delegations", { method: "POST", body: JSON.stringify(body) });
}

export function cancelDelegation(id: number): Promise<DelegationOverview> {
  return api(`/delegations/${id}/cancel`, { method: "POST" });
}

export function delegationActions(id: number): Promise<{ items: DelegatedAction[] }> {
  return api(`/delegations/${id}/actions`);
}

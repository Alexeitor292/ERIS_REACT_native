import { api } from "./client";

export type DistrictContacts = {
  district: string;
  default_user_id: number | null;
  can_edit: boolean;
  candidates: Array<{ id: number; full_name: string }>;
};

export function districtContacts(district: string): Promise<DistrictContacts> {
  return api(`/district-contacts/${encodeURIComponent(district)}`);
}

export function setDistrictContact(district: string, userId: number | null): Promise<DistrictContacts> {
  return api(`/district-contacts/${encodeURIComponent(district)}`, { method: "PUT", body: JSON.stringify({ user_id: userId }) });
}

export type DeliveryResult = { delivered: boolean; already: boolean; supervisor_told?: boolean; contact_told?: boolean };

export function deliverImmediateActions(submissionId: number, body: { actions: string[]; description: string; client_uuid: string }): Promise<DeliveryResult> {
  return api(`/submissions/${submissionId}/immediate-actions/deliver`, { method: "POST", body: JSON.stringify(body) });
}

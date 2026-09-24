import { api } from "./client";

/** What sharing with someone would take: approvals needed, and who is told. */
export type ShareRoute = { immediate: boolean; approvals: string[]; notices: string[] };

export type ShareReview = {
  id: number;
  unit_type: "BRANCH" | "OFFICE";
  unit_id: number;
  unit_label: string;
  /** APPROVAL: must approve first. NOTICE: told, and may stop it. */
  kind: "APPROVAL" | "NOTICE";
  decision: "PENDING" | "APPROVED" | "REJECTED" | "ACKNOWLEDGED";
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
};

export type SharePerson = { id: number; full_name: string | null; email: string | null; placement?: string | null };

export type ShareStatus = "PENDING" | "ACTIVE" | "REJECTED" | "REVOKED" | "CANCELLED";

export type FormShare = {
  id: number;
  status: ShareStatus;
  recipient: SharePerson;
  sharer: SharePerson;
  created_at: string | null;
  activated_at: string | null;
  ended_at: string | null;
  ended_by: string | null;
  end_note: string | null;
  reviews: ShareReview[];
};

export type ShareCandidate = { id: number; email: string; full_name: string; placement: string | null; route: ShareRoute };

export type LegacyGrant = { user_id: number; full_name: string; email: string; can_edit: boolean };

export type FormShares = { shares: FormShare[]; grants: LegacyGrant[]; candidates: ShareCandidate[] };

/** A share waiting on the signed-in chief. */
export type ShareReviewItem = {
  review_id: number;
  share_id: number;
  kind: "APPROVAL" | "NOTICE";
  unit_label: string;
  status: ShareStatus;
  created_at: string | null;
  submission: { id: number; title: string | null };
  owner: SharePerson;
  sharer: SharePerson;
  recipient: SharePerson;
  reviews: ShareReview[];
};

export function getFormShares(submissionId: number) {
  return api<FormShares>(`/submissions/${submissionId}/shares`);
}

export function listShareReviews() {
  return api<{ items: ShareReviewItem[] }>("/shares/reviews");
}

export function decideShare(item: Pick<ShareReviewItem, "share_id" | "review_id">, decision: "APPROVE" | "REJECT" | "ACKNOWLEDGE", note?: string) {
  return api<{ share_id: number; status: ShareStatus }>(`/shares/${item.share_id}/reviews/${item.review_id}`, {
    method: "POST",
    body: JSON.stringify({ decision, note: note?.trim() || null }),
  });
}

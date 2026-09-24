import { api } from "./client";

/** One thing somebody was told (the same feed the mobile app shows). */
export type FeedItem = {
  id: number;
  kind: string;
  title: string;
  body: string | null;
  /** A web path: where acting on it happens. */
  link: string | null;
  actor: string | null;
  created_at: string | null;
  read: boolean;
};

export type Feed = { items: FeedItem[]; unread: number };

export function getFeed(params: { limit?: number; beforeId?: number; unreadOnly?: boolean } = {}) {
  const query = new URLSearchParams();
  if (params.limit) query.set("limit", String(params.limit));
  if (params.beforeId) query.set("before_id", String(params.beforeId));
  if (params.unreadOnly) query.set("unread_only", "true");
  const suffix = query.toString();
  return api<Feed>(`/notifications${suffix ? `?${suffix}` : ""}`);
}

export function getUnread() {
  return api<{ unread: number }>("/notifications/unread");
}

/** Mark these read, or with no ids every one of them. Returns the new unread count. */
export function markRead(ids?: number[]) {
  return api<{ unread: number }>("/notifications/read", { method: "POST", body: JSON.stringify(ids ? { ids } : {}) });
}

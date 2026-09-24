import { apiFetch } from "./client";

/** One thing somebody was told: the same feed as the web portal's bell. */
export type FeedItem = {
  id: number;
  kind: string;
  title: string;
  body: string | null;
  /** A web path; notificationRoutes maps it to a screen here. */
  link: string | null;
  actor: string | null;
  created_at: string | null;
  read: boolean;
};

export type Feed = { items: FeedItem[]; unread: number };

export function getFeed(token: string, params: { limit?: number; beforeId?: number } = {}) {
  const query = new URLSearchParams();
  if (params.limit) query.set("limit", String(params.limit));
  if (params.beforeId) query.set("before_id", String(params.beforeId));
  const suffix = query.toString();
  return apiFetch<Feed>(`/notifications${suffix ? `?${suffix}` : ""}`, { token });
}

export function getUnread(token: string) {
  return apiFetch<{ unread: number }>("/notifications/unread", { token });
}

/** Mark these read, or with no ids all of them. Returns the new unread count. */
export function markRead(token: string, ids?: number[]) {
  return apiFetch<{ unread: number }>("/notifications/read", { method: "POST", token, body: ids ? { ids } : {} });
}

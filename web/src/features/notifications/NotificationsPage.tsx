import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { getFeed, markRead, type FeedItem } from "../../api/notifications";
import AppShell from "../../ui/AppShell";
import { internalLink, whenLabel } from "./notificationModel";

const PAGE = 30;

/** Everything the signed-in person was told, newest first — the same feed as the mobile app. */
export default function NotificationsPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<FeedItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (beforeId?: number) => {
    setLoading(true);
    setError(null);
    try {
      const feed = await getFeed({ limit: PAGE, beforeId, unreadOnly });
      setItems((current) => (beforeId ? [...current, ...feed.items] : feed.items));
      setUnread(feed.unread);
      setMore(feed.items.length === PAGE);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load notifications.");
    } finally {
      setLoading(false);
    }
  }, [unreadOnly]);

  useEffect(() => { void load(); }, [load]);

  async function follow(item: FeedItem) {
    if (!item.read) {
      const r = await markRead([item.id]).catch(() => null);
      if (r) setUnread(r.unread);
    }
    const to = internalLink(item.link);
    if (to) navigate(to);
    else setItems((current) => current.map((i) => (i.id === item.id ? { ...i, read: true } : i)));
  }

  async function readAll() {
    const r = await markRead();
    setUnread(r.unread);
    setItems((current) => (unreadOnly ? [] : current.map((item) => ({ ...item, read: true }))));
  }

  return (
    <AppShell title="Notifications">
      <div className="mx-auto grid w-full max-w-3xl gap-3 p-4 md:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm"><b>{unread}</b><span className="text-muted"> unread</span></span>
          <label className="ml-auto flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Unread only
          </label>
          <button type="button" onClick={readAll} disabled={!unread} className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">
            Mark all read
          </button>
        </div>
        {error ? <p className="text-sm text-[var(--bad)]">{error}</p> : null}
        <ul className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
          {items.map((item) => (
            <li key={item.id} className="border-b border-[var(--line)] last:border-b-0">
              <button type="button" onClick={() => follow(item)} className={`flex w-full gap-3 px-4 py-3 text-left hover:bg-[var(--panel-soft)] ${item.read ? "" : "bg-[color:color-mix(in_oklab,var(--brand)_6%,var(--panel))]"}`}>
                {!item.read ? <span aria-label="Unread" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--brand)]" /> : <span className="w-2 shrink-0" aria-hidden />}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{item.title}</span>
                  {item.body ? <span className="mt-0.5 block text-sm text-muted">{item.body}</span> : null}
                </span>
                <span className="shrink-0 text-xs text-muted">{whenLabel(item.created_at)}</span>
              </button>
            </li>
          ))}
          {!items.length && !loading ? <li className="px-4 py-8 text-center text-sm text-muted">{unreadOnly ? "Nothing unread." : "Nothing yet. Steps waiting on you, and shares, appear here."}</li> : null}
        </ul>
        {more ? (
          <button type="button" onClick={() => load(items[items.length - 1]?.id)} disabled={loading} className="justify-self-center rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--panel-soft)] disabled:opacity-50">
            {loading ? "Loading…" : "Older notifications"}
          </button>
        ) : null}
      </div>
    </AppShell>
  );
}

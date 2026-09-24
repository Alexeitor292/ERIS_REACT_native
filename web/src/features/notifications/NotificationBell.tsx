import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Bell } from "lucide-react";

import { getFeed, getUnread, markRead, type FeedItem } from "../../api/notifications";
import { badgeText, internalLink, whenLabel } from "./notificationModel";

const POLL_MS = 60_000;

/**
 * The header bell: the unread count, and the latest notices in a panel. The
 * same feed reaches the mobile app. Refreshed every minute, when the window
 * regains focus, and whenever the panel opens.
 */
export default function NotificationBell() {
  const navigate = useNavigate();
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const refreshCount = useCallback(() => {
    getUnread().then((r) => setUnread(r.unread)).catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshCount();
    const timer = window.setInterval(refreshCount, POLL_MS);
    window.addEventListener("focus", refreshCount);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshCount);
    };
  }, [refreshCount]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    getFeed({ limit: 8 })
      .then((feed) => { setItems(feed.items); setUnread(feed.unread); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load notifications."));
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const onClick = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  async function follow(item: FeedItem) {
    setOpen(false);
    if (!item.read) {
      markRead([item.id]).then((r) => setUnread(r.unread)).catch(() => undefined);
    }
    const to = internalLink(item.link);
    if (to) navigate(to);
  }

  async function readAll() {
    const r = await markRead();
    setUnread(r.unread);
    setItems((current) => current?.map((item) => ({ ...item, read: true })) ?? null);
  }

  const badge = badgeText(unread);
  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={badge ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        className="relative rounded-md border border-[var(--line)] bg-[var(--panel)] p-2 hover:bg-[var(--panel-soft)]"
      >
        <Bell size={17} aria-hidden />
        {badge ? (
          <span className="absolute -right-1.5 -top-1.5 min-w-5 rounded-full bg-[var(--bad)] px-1 text-center text-[11px] font-bold leading-5 text-white tabular-nums">{badge}</span>
        ) : null}
      </button>
      {open ? (
        <div role="dialog" aria-label="Notifications" className="absolute right-0 z-40 mt-2 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)] shadow-xl">
          <div className="flex items-center justify-between border-b border-[var(--line)] px-3 py-2">
            <span className="text-sm font-semibold">Notifications</span>
            {unread ? <button type="button" onClick={readAll} className="text-xs font-medium text-[var(--brand)] hover:underline">Mark all read</button> : null}
          </div>
          <div className="max-h-[26rem] overflow-y-auto">
            {error ? <p className="p-4 text-sm text-[var(--bad)]">{error}</p> : null}
            {!error && items === null ? <p className="p-4 text-sm text-muted">Loading…</p> : null}
            {items && items.length === 0 ? <p className="p-4 text-sm text-muted">Nothing yet. Steps waiting on you, and shares, appear here.</p> : null}
            {items?.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => follow(item)}
                className={`block w-full border-b border-[var(--line)] px-3 py-2.5 text-left last:border-b-0 hover:bg-[var(--panel-soft)] ${item.read ? "" : "bg-[color:color-mix(in_oklab,var(--brand)_7%,var(--panel))]"}`}
              >
                <div className="flex items-start gap-2">
                  {!item.read ? <span aria-label="Unread" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--brand)]" /> : <span className="w-2 shrink-0" aria-hidden />}
                  <div className="min-w-0">
                    <div className="text-sm font-semibold">{item.title}</div>
                    {item.body ? <div className="mt-0.5 line-clamp-2 text-xs text-muted">{item.body}</div> : null}
                    <div className="mt-1 text-[11px] text-muted">{whenLabel(item.created_at)}</div>
                  </div>
                </div>
              </button>
            ))}
          </div>
          <Link to="/notifications" onClick={() => setOpen(false)} className="block border-t border-[var(--line)] px-3 py-2 text-center text-xs font-medium text-[var(--brand)] hover:bg-[var(--panel-soft)]">
            See all notifications
          </Link>
        </div>
      ) : null}
    </div>
  );
}

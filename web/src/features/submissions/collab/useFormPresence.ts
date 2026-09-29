import { useCallback, useEffect, useRef, useState } from "react";

import { api, apiUrl } from "../../../api/client";
import { getToken } from "../../../auth/token";
import { areaOf, fieldOf } from "./presenceDom";
import { memoWriters, type PresenceOther, type PresenceReply } from "./presenceModel";

const BEAT_MS = 5000;

function newSessionId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * This copy of a technical form tells the server where it is (the card and
 * field in focus, the memos being written) every few seconds and whenever that
 * changes, and learns who else is in the form, which memos they are writing,
 * and the form's saved revision.
 *
 * `memos`: the memos this person is writing (changed and not yet saved);
 * `typed()` is called on each change to one, which keeps its lock alive.
 */
export function useFormPresence({ submissionId, enabled, memos }: { submissionId: number; enabled: boolean; memos: readonly string[] }) {
  const sessionId = useRef(newSessionId()).current;
  const [reply, setReply] = useState<PresenceReply | null>(null);
  const place = useRef<{ area: string | null; field: string | null }>({ area: null, field: null });
  const memosRef = useRef<readonly string[]>(memos);
  const typing = useRef(false);
  const timer = useRef<number | null>(null);
  const inFlight = useRef(false);

  const beat = useCallback(async () => {
    if (!enabled || inFlight.current) return;
    inFlight.current = true;
    const wasTyping = typing.current;
    typing.current = false;
    try {
      const next = await api<PresenceReply>(`/submissions/${submissionId}/presence`, {
        method: "POST",
        body: JSON.stringify({ session_id: sessionId, ...place.current, memos: memosRef.current, typing: wasTyping }),
      });
      setReply(next);
    } catch {
      // Presence is a courtesy; the saves themselves refuse what would overwrite someone.
    } finally {
      inFlight.current = false;
    }
  }, [enabled, sessionId, submissionId]);

  const soon = useCallback(() => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void beat();
    }, 250);
  }, [beat]);

  // The memos being written: a new one is taken at once.
  useEffect(() => {
    const before = memosRef.current;
    memosRef.current = memos;
    if (memos.some((memo) => !before.includes(memo)) || before.some((memo) => !memos.includes(memo))) soon();
  }, [memos, soon]);

  // Where the focus is.
  useEffect(() => {
    if (!enabled) return;
    const onFocus = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const area = areaOf(target);
      const next = area && target ? { area: area.key, field: fieldOf(target, area.element) } : { area: null, field: null };
      if (next.area !== place.current.area || next.field !== place.current.field) {
        place.current = next;
        soon();
      }
    };
    const onBlur = (event: FocusEvent) => {
      // Focus leaving for nothing (a click on blank page): no longer anywhere.
      if (!event.relatedTarget && place.current.area) {
        window.setTimeout(() => {
          if (document.activeElement === document.body || !document.activeElement) {
            place.current = { area: null, field: null };
            soon();
          }
        }, 0);
      }
    };
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    return () => {
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
    };
  }, [enabled, soon]);

  // The heartbeat, and goodbye when the form closes.
  useEffect(() => {
    if (!enabled) return;
    void beat();
    const every = window.setInterval(() => void beat(), BEAT_MS);
    const leave = () => {
      const token = getToken();
      void fetch(apiUrl(`/submissions/${submissionId}/presence/${sessionId}`), {
        method: "DELETE",
        keepalive: true,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      }).catch(() => undefined);
    };
    window.addEventListener("pagehide", leave);
    return () => {
      window.clearInterval(every);
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [beat, enabled, sessionId, submissionId]);

  const typed = useCallback(() => {
    typing.current = true;
  }, []);

  const others: PresenceOther[] = enabled ? reply?.others ?? [] : [];
  return {
    others,
    /** Memo key -> the person writing it (it is read-only here meanwhile). */
    writers: memoWriters(others),
    revision: reply?.revision ?? null,
    savedBy: reply?.saved_by ?? null,
    typed,
    refresh: soon,
  };
}

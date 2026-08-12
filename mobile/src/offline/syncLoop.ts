import { AppState, AppStateStatus } from "react-native";
import { getToken } from "../auth/tokenStore";
import { flushOfflineQueue } from "./queue";
import { flushQueuedIncidents } from "./incidentQueue";

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
let appSub: { remove: () => void } | null = null;
let inFlight = false;

export type OfflineSyncRunResult = {
  processed: number;
  remaining: number;
  skipped: boolean;
};

async function runSyncOnce(): Promise<OfflineSyncRunResult> {
  if (inFlight) return { processed: 0, remaining: 0, skipped: true };
  inFlight = true;
  try {
    const token = await getToken();
    if (!token) return { processed: 0, remaining: 0, skipped: true };

    // Keep the established submission queue ordering semantics intact, then run
    // the independent incident queue. Either queue can retain failed work for the
    // next retry without discarding the other queue's durable state.
    const submissionResult = await flushOfflineQueue(token);
    const incidentResult = await flushQueuedIncidents(token);
    return {
      processed: submissionResult.processed + incidentResult.processed,
      remaining: submissionResult.remaining + incidentResult.remaining,
      skipped: false,
    };
  } catch {
    // Durable queues retain their work; the loop will retry.
    return { processed: 0, remaining: 0, skipped: false };
  } finally {
    inFlight = false;
  }
}

export function startOfflineSyncLoop(intervalMs = 15000) {
  if (started) return;
  started = true;

  runSyncOnce().catch(() => {});
  timer = setInterval(() => {
    runSyncOnce().catch(() => {});
  }, intervalMs);

  appSub = AppState.addEventListener("change", (state: AppStateStatus) => {
    if (state === "active") {
      runSyncOnce().catch(() => {});
    }
  });
}

export function stopOfflineSyncLoop() {
  started = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (appSub) {
    appSub.remove();
    appSub = null;
  }
}

export async function triggerOfflineSyncNow() {
  return runSyncOnce();
}

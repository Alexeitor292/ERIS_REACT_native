import { AppState, AppStateStatus } from "react-native";
import { getToken } from "../auth/tokenStore";
import { flushOfflineQueue } from "./queue";
import { flushQueuedIncidents } from "./incidentQueue";
import { flushQueuedPhotoCorrections } from "./fieldPhotoMetadata";

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

    // Keep submission/incident ordering intact, then flush append-only photo
    // metadata corrections. Any queue can retain failed work for a later retry
    // without discarding successful work from the other durable queues.
    const submissionResult = await flushOfflineQueue(token);
    const incidentResult = await flushQueuedIncidents(token);
    const photoCorrectionResult = await flushQueuedPhotoCorrections(token);
    return {
      processed: submissionResult.processed + incidentResult.processed + photoCorrectionResult.processed,
      remaining: submissionResult.remaining + incidentResult.remaining + photoCorrectionResult.remaining,
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

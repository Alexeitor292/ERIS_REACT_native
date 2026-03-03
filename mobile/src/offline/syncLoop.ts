import { AppState, AppStateStatus } from "react-native";
import { getToken } from "../auth/tokenStore";
import { flushOfflineQueue } from "./queue";

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
let appSub: { remove: () => void } | null = null;
let inFlight = false;

async function runSyncOnce() {
  if (inFlight) return;
  inFlight = true;
  try {
    const token = await getToken();
    if (!token) return;
    await flushOfflineQueue(token);
  } catch {
    // swallow; loop will retry
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
  await runSyncOnce();
}


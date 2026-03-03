import * as SecureStore from "expo-secure-store";

const KEY = "eris_access_token";
const SESSION_EXPIRED_KEY = "eris_session_expired_notice";
const LAST_ONLINE_AUTH_AT_KEY = "eris_last_online_auth_at";
export const OFFLINE_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const AUTH_FRESHNESS_WRITE_THROTTLE_MS = 5 * 60 * 1000;

let lastFreshnessWriteAt = 0;

export async function setToken(token: string) {
  await SecureStore.setItemAsync(KEY, token);
  await markOnlineAuthSuccess({ force: true });
}

export async function getToken() {
  const token = await SecureStore.getItemAsync(KEY);
  if (!token) return null;

  const jwtExpMs = getTokenExpiryMs(token);
  if (jwtExpMs != null && Date.now() >= jwtExpMs) {
    await clearToken();
    await setSessionExpiredNotice("Session expired. Please sign in again.");
    return null;
  }

  const offlineExpiryMs = await getOfflineSessionExpiryMs();
  if (offlineExpiryMs == null) {
    await markOnlineAuthSuccess({ force: true });
    return token;
  }
  if (offlineExpiryMs != null && Date.now() >= offlineExpiryMs) {
    await clearToken();
    await setSessionExpiredNotice(
      "Offline session expired after 24 hours without server contact. Please sign in again."
    );
    return null;
  }

  return token;
}

export async function clearToken() {
  await SecureStore.deleteItemAsync(KEY);
  await SecureStore.deleteItemAsync(LAST_ONLINE_AUTH_AT_KEY);
}

export async function setSessionExpiredNotice(message = "Session expired. Please sign in again.") {
  await SecureStore.setItemAsync(SESSION_EXPIRED_KEY, message);
}

export async function consumeSessionExpiredNotice() {
  const message = await SecureStore.getItemAsync(SESSION_EXPIRED_KEY);
  if (message) {
    await SecureStore.deleteItemAsync(SESSION_EXPIRED_KEY);
    return message;
  }
  return null;
}

export function getTokenExpiryMs(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(global.atob(padded)) as { exp?: number };
    if (typeof payload.exp !== "number") return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

export async function getOfflineSessionExpiryMs(): Promise<number | null> {
  try {
    const raw = await SecureStore.getItemAsync(LAST_ONLINE_AUTH_AT_KEY);
    if (!raw) return null;
    const ts = Number(raw);
    if (!Number.isFinite(ts)) return null;
    return ts + OFFLINE_SESSION_MAX_AGE_MS;
  } catch {
    return null;
  }
}

export async function markOnlineAuthSuccess(opts?: { force?: boolean }) {
  const now = Date.now();
  if (!opts?.force && now - lastFreshnessWriteAt < AUTH_FRESHNESS_WRITE_THROTTLE_MS) {
    return;
  }
  try {
    await SecureStore.setItemAsync(LAST_ONLINE_AUTH_AT_KEY, String(now));
    lastFreshnessWriteAt = now;
  } catch {
    // ignore freshness persistence failures
  }
}

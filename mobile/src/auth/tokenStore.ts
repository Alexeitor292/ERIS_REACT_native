import * as SecureStore from "expo-secure-store";

const KEY = "eris_access_token";
const SESSION_EXPIRED_KEY = "eris_session_expired_notice";

export async function setToken(token: string) {
  await SecureStore.setItemAsync(KEY, token);
}

export async function getToken() {
  return SecureStore.getItemAsync(KEY);
}

export async function clearToken() {
  await SecureStore.deleteItemAsync(KEY);
}

export async function setSessionExpiredNotice() {
  await SecureStore.setItemAsync(SESSION_EXPIRED_KEY, "1");
}

export async function consumeSessionExpiredNotice() {
  const flag = await SecureStore.getItemAsync(SESSION_EXPIRED_KEY);
  if (flag) {
    await SecureStore.deleteItemAsync(SESSION_EXPIRED_KEY);
    return true;
  }
  return false;
}

// mobile/src/api/baseUrl.ts
import Constants from "expo-constants";
import { Platform } from "react-native";

function getMetroHost(): string | null {
  // Example hostUri: "10.117.219.34:8082"
  const hostUri =
    (Constants.expoConfig as any)?.hostUri ??
    (Constants as any).hostUri ??
    (Constants.expoConfig as any)?.debuggerHost ??
    null;

  if (!hostUri || typeof hostUri !== "string") return null;

  // take "10.117.219.34" from "10.117.219.34:8082"
  const host = hostUri.split(":")[0];
  return host || null;
}

export function getApiBaseUrl(): string {
  return getApiBaseCandidates()[0];
}

export function getApiBaseCandidates(): string[] {
  const out: string[] = [];
  const add = (url: string | null | undefined) => {
    if (!url) return;
    const trimmed = url.trim().replace(/\/+$/, "");
    if (!trimmed) return;
    if (!out.includes(trimmed)) out.push(trimmed);
  };

  // Optional explicit override
  add(process.env.EXPO_PUBLIC_API_URL);

  // Same host as Metro for physical devices and emulators
  const metroHost = getMetroHost();
  if (metroHost) add(`http://${metroHost}:8000`);

  // Platform-specific fallbacks
  if (Platform.OS === "android") add("http://10.0.2.2:8000");
  add("http://127.0.0.1:8000");

  return out;
}

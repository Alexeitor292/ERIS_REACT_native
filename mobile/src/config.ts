export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL;
export const ARCGIS_MMPK_PATH = process.env.EXPO_PUBLIC_ARCGIS_MMPK_PATH ?? "";
export const ARCGIS_MMPK_URL = process.env.EXPO_PUBLIC_ARCGIS_MMPK_URL ?? "";

if (!API_BASE_URL) {
  throw new Error("Missing EXPO_PUBLIC_API_URL in mobile/.env. Restart Expo after adding it.");
}

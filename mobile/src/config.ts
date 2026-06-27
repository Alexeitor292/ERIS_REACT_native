// EXPO_PUBLIC_API_URL is optional. When unset, mobile/src/api/baseUrl.ts
// derives the API host from the Metro dev server host, Android emulator
// address, or localhost — suitable for local development. Set this variable
// for Proxmox/server testing so the app hits a fixed endpoint.
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? null;
export const ARCGIS_MMPK_PATH = process.env.EXPO_PUBLIC_ARCGIS_MMPK_PATH ?? "";
export const ARCGIS_MMPK_URL = process.env.EXPO_PUBLIC_ARCGIS_MMPK_URL ?? "";

// Base URL of the ERIS WebUI. Used by the mobile "Open full 3D map" action to
// launch the interactive 3D terrain scene in the device browser (the mobile app
// has no native 3D SceneView). When unset, the action is disabled with a note —
// it is never guessed, so the link is never broken.
export const WEB_APP_URL = (process.env.EXPO_PUBLIC_WEB_URL ?? "").replace(/\/+$/, "");

if (!API_BASE_URL) {
  console.warn(
    "[ERIS] EXPO_PUBLIC_API_URL is not set. Using Metro/emulator host fallback from baseUrl.ts. " +
      "Set EXPO_PUBLIC_API_URL in mobile/.env to target a fixed server."
  );
}

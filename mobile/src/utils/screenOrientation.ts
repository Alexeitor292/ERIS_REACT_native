/**
 * Thin, crash-safe wrapper around expo-screen-orientation.
 *
 * The native module ships with the custom dev-client / EAS build (it is a
 * dependency in package.json) but is NOT present in stock Expo Go. Every call is
 * guarded so a missing native module degrades gracefully (the screen simply
 * follows the OS rotation lock) instead of throwing.
 *
 * Note: the app-wide rotation capability is controlled by `expo.orientation`
 * in app.json ("default"). That change requires a native rebuild/prebuild to
 * take effect — these helpers only adjust orientation at runtime.
 */

import * as ScreenOrientation from "expo-screen-orientation";

/** Force landscape — used while the measurement diagram is fullscreen. */
export async function lockLandscape(): Promise<void> {
  try {
    await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
  } catch {
    // Native module unavailable (e.g. Expo Go) — non-fatal.
  }
}

/** Return to the device's natural rotation behavior (follows the sensor). */
export async function unlockOrientation(): Promise<void> {
  try {
    await ScreenOrientation.unlockAsync();
  } catch {
    // Native module unavailable — non-fatal.
  }
}

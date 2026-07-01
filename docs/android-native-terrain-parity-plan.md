# Android native offline 3D terrain — parity plan (NOT yet implemented)

**Status: UNSUPPORTED on Android.** The native offline 3D terrain viewer
(`eristerrain` bundle → local mesh + hillshade, fully offline) is implemented and
shipped for **iOS only** (SceneKit, via the `withArcGisIos` Expo config plugin +
Objective-C sources). There is **no** Android native renderer or bridge in this
repository, and none is claimed. This document is the concrete plan to reach
parity; it is not a description of existing behavior.

Android users today get the honest fallbacks that already exist:
- The web interactive 3D SceneView opened in the device browser (online), and
- The compact diagnostic terrain relief card.

The mobile UI must state "iOS native only" wherever the native bridge is absent
(`supportsOfflineTerrainScene()` / `supportsScenePackageIntegrity()` are false on
Android) — never present a browser/WebView as if it were the native offline viewer.

## Why it is not "just recompile"

The iOS renderer depends on iOS-only frameworks (SceneKit) and an iOS config
plugin. Android needs an independent, reproducible implementation:

1. **Reproducible Expo config plugin** (`withArcGisAndroid` or `withErisTerrainAndroid`)
   that injects the native sources + Gradle wiring at prebuild — committed as
   source templates, never a checked-in generated `android/` tree.
2. **Native renderer** for the validated extracted `eristerrain` bundle:
   - Decode `elevation-grid.bin` (float32 LE, row 0 = north) into a height mesh.
   - Render with **SceneView (Filament)** or OpenGL ES / Vulkan; drape
     `hillshade.png`; place incident marker, uploaded geometry (GeoJSON + Esri,
     all types), sample-extent rectangle, and real road bearing — all through the
     manifest `local_transform`, clipped to bounds. Mirror
     `mobile/src/arcgis/terrainOverlays.ts` exactly (the tested reference).
   - Camera: orbit / pan / zoom / tilt, North (north-up, framing preserved),
     Reset-to-incident (fallback terrain center).
3. **Identical integrity + lifecycle**: the SAME JS path
   (`eristerrainBundle.ts` validation, `offlineScenePackages.ts` download/verify/
   extract/registry) with a native SHA-256 bridge (`sha256OfFile`) and the format
   routing (`usesMspkRuntime`) — an `eristerrain` bundle is never opened as `.mspk`.
4. **Correct app package namespace** and a native module exposing
   `openOfflineTerrainScene` / `sha256OfFile` / `validateScenePackage` so
   `supportsOfflineTerrainScene()` / `supportsScenePackageIntegrity()` become true.
5. **Gradle build validation** in CI (assembleDebug) — no completion claim without
   a successful build.

## Acceptance criteria (Definition of Done)

- [ ] `withErisTerrainAndroid` config plugin committed as source templates; `expo
      prebuild --platform android` produces a compiling project with no manual edits.
- [ ] `./gradlew :app:assembleDebug` succeeds in CI on a clean checkout.
- [ ] Native module methods present so `supportsOfflineTerrainScene()` returns true
      on a device/emulator build.
- [ ] Airplane-mode acceptance (mirrors the iOS checklist,
      `docs/offline-3d-terrain-device-acceptance.md`): mesh + hillshade + incident
      marker + uploaded geometry + sample extent + real bearing render offline;
      orbit/pan/zoom/tilt/North/Reset work; corrupt manifest/grid/CRC/SHA fail closed.
- [ ] Bundle validation + registry durability tests run unchanged (shared JS).
- [ ] Docs updated to state Android is supported ONLY after the above pass on a
      real device/emulator with evidence.

Until every box is checked, Android remains explicitly unsupported and the UI says so.

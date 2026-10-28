# Expo app (reference)

`mobile/` is the original ERIS field app, written in React Native with Expo
SDK 54 (React Native 0.81, expo-router 6) and the ArcGIS Runtime SDK for iOS
100.15. It is **being replaced by the native Swift app** ([iOS](ios.md)),
because Caltrans distributes iPhone apps through Intune and the Swift app
signs in with MSAL and Microsoft Authenticator.

Keep `mobile/` as the reference for behavior the Swift app must match (offline
drafts, offline 3D terrain, field photo capture) until the Swift app reaches
parity and IT approves its rollout. After that, archive it (move it to a
`legacy/` tag) in a pull request that also removes its CI jobs.

## Status

| Topic | State |
| --- | --- |
| Sign-in | Password sign-in through the API. **Not usable** against a Caltrans production server, where password sign-in is off. Does not use Entra. |
| Push | Expo push tokens. Production uses APNs through the Swift app. |
| Distribution | EAS builds ([compose deployment](../operations/compose-deployment.md#mobile-app-releases)). Not the Caltrans channel. |
| Android | Builds, but maps and offline terrain are iOS-only. Caltrans has no Android plan. |
| CI | Lint, types, Jest, many source-contract checks and an iOS prebuild still run in `ci.yml` and four `*-contract.yml` workflows. |

## Layout

```
mobile/
├── app/            # expo-router screens (file-based routes)
├── src/
│   ├── api/        # API calls
│   ├── auth/       # sign-in and token storage
│   ├── arcgis/     # ArcGIS Runtime bridge (iOS)
│   ├── offline/    # offline drafts and terrain packages
│   ├── photos/     # capture with position and heading
│   ├── measurements/, roadInventory/, notifications/, services/, ui/, utils/
│   └── config.ts   # EXPO_PUBLIC_* settings
├── plugins/        # Expo config plugins (adds the ArcGIS pod)
├── scripts/        # source-contract checks run in CI
└── app.json, eas.json
```

## Running it

From [getting started](getting-started.md#4-mobile-app): macOS with Xcode,
`npm ci`, `cp .env.example .env`, `npx expo run:ios`. It needs a development
build; Expo Go cannot load the ArcGIS SDK. Point `EXPO_PUBLIC_API_URL` at a
development API with password sign-in on.

Tests: `npm test`, `npx tsc --noEmit`, `npx expo lint`.

## What to port to Swift

The Swift app's specification lists the remaining parity items:
[iOS: what else must be ported](ios.md#what-else-must-be-ported). When porting
a feature, read the Expo implementation and its source-contract script in
`mobile/scripts/`: each contract encodes a bug that was fixed once and must
not return (for example terrain texture coordinates and vertical scale).

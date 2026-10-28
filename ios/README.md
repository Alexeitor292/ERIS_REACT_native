# ERIS iOS app (native Swift)

The Caltrans ERIS iPhone app: SwiftUI, Microsoft Entra sign-in through MSAL and
Microsoft Authenticator, APNs push. The build contract is
[docs/ios-native-app.md](../docs/ios-native-app.md); the Expo app in
[`mobile/`](../mobile) is the reference until this app reaches parity.

| Folder | What it is |
| --- | --- |
| `ERISKit/` | Swift package: models, API client, sign-in orchestration, role and notification rules. No UIKit, so its tests also run on Linux. |
| `ERIS/` | The app: SwiftUI screens, MSAL token provider, Keychain session store, push registration. |
| `project.yml` | XcodeGen definition. CI generates and commits `ERIS.xcodeproj`; edit this file, not the project. |

## On the Caltrans Mac (Xcode only, no other tools)

1. `git pull` the `claude/ios-swift-app` branch and open `ios/ERIS.xcodeproj`.
2. Target **ERIS → Signing & Capabilities**: choose the Caltrans team. Use the bundle
   identifier registered for ERIS (default `gov.ca.dot.eris`; change it in
   `project.yml` if Caltrans uses another).
3. Set `ERIS_API_BASE_URL` (target build settings) to the ERIS staging API, e.g.
   `https://eris-stage.<domain>/api`. The server must have `ENTRA_MOBILE_CLIENT_ID` set.
4. Run on your Caltrans iPhone. Sign in goes through Microsoft Authenticator.

Archive for Intune: **Product → Archive** with the Release configuration, export with the
Enterprise (in-house) distribution profile, and upload the `.ipa` to Intune as an iOS
line-of-business app (see the spec for renewal dates).

## Port status

| Area | Status |
| --- | --- |
| Sign-in (MSAL + exchange), silent renewal, sign-out, Keychain | Ported |
| Push registration and notification routing | Ported |
| Role rules (`roleModel.ts`) with tests | Ported |
| Incidents: list, detail, report (GPS + Caltrans postmile + photos), claim/forward/revision/resolve | Ported; needs device test |
| Notifications feed | Ported |
| Submissions: list, opening each in the GISA editor | Ported. The GISA PDF export is retired (2026-10-28) and not ported |
| Assessments: worklists, detail, branch-chief and Staff pickers, submit, review, timeline | Ported; needs device test. Picker rules from the web's `personPickerModel.ts` (grouped, disabled branches, time-zone-safe return dates) |
| GISA editor (`mobile/app/(tabs)/submissions/[id].tsx`, ~7,100 lines) | In progress. Core (load, rules, validation, save) and step 1 (Header, district contacts, Location with northing/easting) ported. Step 2: Distribution, Highway Status, Incident Type, Material and Pavement / Ground Status ported. Cracks are their own records (server `submission_gisa_cracks`): each with its photo, the five GISA-001 measures, direction, location and labels drawn on the photo; saved on their own. Vegetation on Slope, Water / Drainage (with the impact table), Water Content and Measurements (road inventory card, elevation profile with chart and manual bearing, the eight measurements) ported: step 2 is done except the cross-section diagram (next, with its parity tests) and the 3D terrain (maps phase). Step 3 (Assessment) next. Unported blocks show saved values and keep them on save. Per-section photo uploads and figure citations come with the Gallery step. Saving is online only until the offline queue is ported; the map editor and Site Photo Map come with the maps phase |
| Section photos: camera recording GPS and the rear camera's true-north direction, photo library (EXIF), filed per form section, photo view with location/direction and typed corrections | Ported (stage 1 of the crack/LiDAR plan); needs a device test, the simulator has no camera or compass. Map view and drag-to-correct come with the ArcGIS Site Photo Map |
| Drafts, offline queue and sync (`mobile/src/offline`) | Next |
| Maintenance work, road inventory | Next |
| Maps and offline terrain (ArcGIS Maps SDK for Swift) | Later; rewrite of `mobile/plugins/arcgis-ios` |

## Working on it on the Mac

- `cd ios/ERISKit && swift test` runs the core tests in seconds.
- Without XcodeGen installed, use the `ERIS.xcodeproj` CI committed; after changing
  `project.yml`, push and let CI regenerate it (or install the XcodeGen release
  binary into `~/bin`, which needs no admin rights).
- Port one screen at a time. Put logic and API calls in `ERISKit` with tests ported
  from the matching `*.test.ts`; keep SwiftUI views thin.
- **Demo mode (Debug builds only).** Launch with the arguments `-ERISDemo YES` (Xcode:
  scheme → Run → Arguments) to use built-in sample data with no sign-in and no network;
  `-ERISDemoRoles OFFICE_CHIEF,STAFF` tries other roles (default `ADMIN`). An orange
  banner shows it is on. `ERIS/Platform/DemoServer.swift` is wrapped in `#if DEBUG`, so
  Release and Intune builds do not contain it.
- **Screen tour.** `ERISUITests/ScreenTour.swift` walks the screens in demo mode and saves
  a screenshot of each:
  `TEST_RUNNER_ERIS_SCREENSHOT_DIR=/tmp/shots xcodebuild test -project ios/ERIS.xcodeproj -scheme ERIS -destination 'platform=iOS Simulator,name=iPhone 17'`.
  Add a step there for each new screen.
- **App icon.** `ERIS/Assets.xcassets/AppIcon.appiconset/AppIcon.png` is the web portal's logo
  (`web/public/eris-logo.svg`) rendered on its yellow, edge to edge, by
  `swift ios/scripts/render-app-icon.swift web/public/eris-logo.svg ios/ERIS/Assets.xcassets/AppIcon.appiconset/AppIcon.png 1024`.
  Rerun it if the logo changes.
- **Parity fixtures.** `node ios/scripts/make-parity-fixtures.mjs` (Node 22.18+) runs the Expo app's
  TypeScript helpers and writes `ERISKit/Tests/ERISKitTests/Fixtures/gisa-helpers.json`; the Swift
  tests check the ports against it. Rerun it when those TypeScript files change.
- The server contract is `docs/ios-native-app.md`; never put a token in a URL, and
  decode GISA forms with `preservingKeys: true`.

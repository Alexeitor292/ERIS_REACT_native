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
| GISA editor (`mobile/app/(tabs)/submissions/[id].tsx`, ~7,100 lines) | In progress. Core (load, rules, validation, save) and step 1 (Header, district contacts, Location with northing/easting) ported. Step 2: Distribution, Highway Status, Incident Type, Material and Pavement / Ground Status ported. Cracks are their own records (server `submission_gisa_cracks`): each with its photo, the five GISA-001 measures, direction, location and labels drawn on the photo; saved on their own. Vegetation on Slope, Water / Drainage (with the impact table), Water Content and Measurements (road inventory card, elevation profile with chart and manual bearing, the eight measurements) ported: the cross-section diagram (road from the road inventory, ground from the form and elevation profile, slide templates, full screen in landscape) is held to the Expo app's output by parity fixtures. Step 2 is done except the 3D terrain (maps phase). Step 3 (Assessment): the four memos (Observations, Geotechnical assessment, Recommendations, Sketch notes) are edited with the web form's own editor, built into `ERIS/Resources/MemoEditor.html` by `web/scripts/build-memo-ios.mjs` (CI checks it is current), so formatting, tables, figures and citations written on either survive the other; Record of incidents shows the site's history (earlier incidents with their maintenance) above the notes on earlier incidents, for operational roles as on the web. The Sketchpad draws with PencilKit (Apple Pencil or a finger) and files a PNG sketch under the Sketchpad section, ready to place as a figure in Sketch notes. Saving follows the web form's rules for a form several people have open: only changed fields are sent, each with the value it started from; someone else's saves are brought in where you have not typed; a field both changed is yours to choose; memos are locked while someone else writes them. Step 4 (Actions): immediate and follow-up actions from the server's lists (the lanes left open with Open highway traffic), and Notify Coordinator, which saves and sends the immediate actions with a justification; notices already sent stay listed on the step. Sending for review: the last step lists what the server requires (location, Geotechnical Assessment, a photo, soil and debris totals) and leads to each missing item; a form that belongs to an assessment is saved and sent for review on that assessment, as the server requires, and a legacy form without one is submitted, and decided by an administrator, on itself. Step 5 (Gallery): the Submission library lists every file on the form (photos, videos, documents, sketches) with its section, filtered as on the web; photos open with where and which way they were taken, everything else in Quick Look; photos and videos (several at a time) come from the camera or library, and PDFs, CAD and Office files from Files, up to the server's 95 MB each (HEIC becomes JPEG for the web). Files cannot be removed from a form: the server has no way to do so yet. Saving is online only until the offline queue is ported; the map editor and Site Photo Map come with the maps phase |
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

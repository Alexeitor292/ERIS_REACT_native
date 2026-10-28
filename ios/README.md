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
| Submissions: list, read-only detail (GISA fields, photos, latest PDF) | Ported; GISA editor not yet |
| Assessments: model, worklist queues by role (ERISKit only) | Model ported; screen next |
| GISA editor (`mobile/app/(tabs)/submissions/[id].tsx`, ~7,100 lines) | Next, in sections |
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
- The server contract is `docs/ios-native-app.md`; never put a token in a URL, and
  decode GISA forms with `preservingKeys: true`.

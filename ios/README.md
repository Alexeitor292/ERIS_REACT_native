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
| Incidents: list and detail (read) | Ported |
| Notifications feed | Ported |
| Role rules (`roleModel.ts`) with tests | Ported |
| Incident create/edit, triage and assignment actions | Next |
| Submissions (GISA), drafts, offline queue and sync | Next |
| Assessments, maintenance work, road inventory | Next |
| Maps and offline terrain (ArcGIS Maps SDK for Swift) | Later; rewrite of `mobile/plugins/arcgis-ios` |

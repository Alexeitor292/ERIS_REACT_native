# ERIS iOS app (native Swift) — build specification

**Decision, 2026-10-28:** the Caltrans ERIS mobile app will be a native **Swift** iOS app.
Caltrans has the **Apple Developer Enterprise Program**, so the app is signed for in-house
distribution and published through **Intune as a line-of-business app**; staff install it from
**Company Portal**. There is no Android app and none is planned. Push notifications are
allowed and use Apple Push Notification service (APNs).
It is built in Xcode on the Caltrans-issued Mac mini. Expo/React Native is not used for the
Caltrans release. The Expo project in [`mobile/`](../mobile) stays as the **reference
implementation** until the Swift app reaches parity. Its TypeScript logic and unit tests are
the behaviour to match.

This document is the contract between the Swift app and the ERIS API. **The server needs no
change**: everything below already exists.

## Evidence from a Caltrans-issued iPhone (2026-10-28)

Checked on one Caltrans-issued iPhone, by its user:

| Check | Result | Meaning |
| --- | --- | --- |
| Management profile (Settings → General → VPN & Device Management) | Present; includes Microsoft Authenticator, Company Portal and other managed apps | Enrolled in Intune (MDM) |
| Company Portal → Devices | "Can access company resources" | Device compliance is evaluated |
| Microsoft Authenticator | Installed, signed in with the dot.ca.gov account | The broker for MSAL sign-ins (and the host of the Enterprise SSO plug-in) is present |
| App PIN / "your organization is protecting its data" / blocked copy-paste | None observed | No sign of Intune app protection (MAM) policies on Microsoft apps |
| Safari sign-in to `https://myapps.microsoft.com` | Signed in immediately | Browser and SSO sign-in is allowed from a managed, compliant device |

Conclusion: Caltrans's iOS Conditional Access appears to rely on **device compliance**, not
app protection. Caltrans's Intune or identity admin must still confirm the policy that will
apply to the **ERIS** app registrations specifically, and whether the Enterprise SSO plug-in
profile allows the ERIS bundle identifier. One device's behaviour is not the policy.

## Sign-in: MSAL for iOS with the Authenticator broker

Use Microsoft's [MSAL for iOS and macOS](https://github.com/AzureAD/microsoft-authentication-library-for-objc)
(Swift Package Manager; pin an exact current release when you start). In a native app it is
Microsoft's supported path. It signs in through Microsoft Authenticator (the broker), so the
device's Caltrans sign-in, MFA, device compliance and the SSO plug-in all apply. If Caltrans
later requires app protection, the Intune App SDK builds on MSAL.

### Entra registration (IT)

The **ERIS Mobile** app registration (public client, single tenant), described in the
[runbook](caltrans-podman.md#mobile-sign-in-entra):

- **Authentication → Add a platform → iOS / macOS**, with the app's **bundle ID** (for
  example `gov.ca.dot.eris`). Entra generates the redirect URI
  `msauth.<bundle-id>://auth`. This replaces the Expo app's custom-scheme redirect.
- **API permissions:** the delegated `access_as_user` permission on the ERIS web API, with
  admin consent. The web registration exposes that scope with
  `"requestedAccessTokenVersion": 2`.
- No client secret or certificate: the app is a public client.
- Conditional Access and assignment: the same as other Caltrans mobile apps (see the evidence
  above).

### Xcode project

- **Info.plist:**
  - `CFBundleURLTypes` with the scheme `msauth.$(PRODUCT_BUNDLE_IDENTIFIER)`.
  - `LSApplicationQueriesSchemes` containing `msauthv2` and `msauthv3`, so MSAL can call
    Authenticator.
- **Signing & Capabilities → Keychain Sharing:** add `com.microsoft.adalcache`, which MSAL's
  token cache needs.
- Forward the broker's response:
  `MSALPublicClientApplication.handleMSALResponse(url, sourceApplication:)` from
  `scene(_:openURLContexts:)` (or `.onOpenURL` in SwiftUI).

### Flow

1. **`GET /api/auth/config`.** Read `entra_mobile`:
   `{ "authority": "https://login.microsoftonline.com/<tenant>", "client_id": "<ERIS Mobile id>", "scopes": ["api://<web-app-id>/access_as_user"] }`.
   Refuse any authority whose host is not `login.microsoftonline.com` or
   `login.microsoftonline.us`, or whose path is not a tenant GUID. If `entra_mobile` is null,
   mobile sign-in is not enabled on that server. The Caltrans build shows **no password
   form**: production is Entra-only.
2. **Interactive sign-in.** Create `MSALPublicClientApplication` with that client ID and an
   `MSALAADAuthority` built from that authority. Call
   `acquireToken(with: MSALInteractiveTokenParameters(scopes: entra_mobile.scopes, webviewParameters: …))`.
   Do not add `openid`/`profile`/`offline_access`; MSAL adds them. Do not use an embedded
   `WKWebView`; keep the default web view type so the broker and SSO plug-in are used.
3. **Exchange.** `POST /api/auth/entra/native` with JSON body
   `{"access_token": "<MSAL result.accessToken>"}` and no `Authorization` header. The server
   verifies the token's signature, issuer, tenant, audience, `access_as_user` scope and `azp`
   (it must be the ERIS Mobile client ID), then matches the prelinked `(tenant, object ID)`.
   - **200:** `{"access_token": "<ERIS session>", "token_type": "bearer", "expires_at": "…Z"}`.
   - **401:** the token could not be verified.
   - **403:** no active ERIS account is linked; show "Ask an ERIS administrator for access".

   Discard the Entra access token after the exchange.
4. **Store the ERIS session** in the Keychain (`kSecClassGenericPassword`,
   `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`). Never put it in `UserDefaults`, files or
   logs.
5. **Call the API** with `Authorization: Bearer <ERIS session>`. Never put a token in a URL;
   the server refuses query-string tokens.
6. **Session end.** ERIS mobile sessions last 12 hours (absolute) and have no idle timeout. On
   any **401** from the API:
   - call `acquireTokenSilent` for the cached MSAL account;
   - if it succeeds, exchange the new Entra token again (step 3) and retry the request once;
   - only on `MSALError.interactionRequired` go back to interactive sign-in.

   This makes the twice-daily re-sign-in invisible on a compliant device.
7. **Sign out.** `POST /api/auth/logout` with the bearer token (it ends this device's session
   only), then delete the Keychain item. Removing the MSAL account is optional: Authenticator
   holds the Caltrans sign-in for the whole device.

Administrators can end every session of an account (**Sign out everywhere**, or by disabling
the account); the app then gets 401 and, once the account is disabled, a 403 at the next
exchange.

## API surface the app uses

All paths are under `https://<web-host>/api`, with JSON unless noted. The inventory comes from
the Expo app's `apiFetch` calls; its request and response shapes in `mobile/src/api/*.ts`
are the reference.

| Area | Endpoints |
| --- | --- |
| Session | `GET /auth/config`, `POST /auth/entra/native`, `GET /auth/me`, `POST /auth/logout` |
| Lookups | `GET /gisa/lookups`, `GET /arcgis/runtime-config` |
| Incidents | `GET/POST /incidents`, `GET/PATCH /incidents/{id}`, `POST /incidents/{id}/attachments` (multipart), `…/assessment`, `…/assign`, `…/unassign`, `…/claim`, `…/triage`, `…/resolve`, `…/branch-chief/assign-engineer`, `…/coordinator/request-revision`, `…/location-candidates`, `…/location-link`, `…/workflow-tree`; `GET /incident-locations/{id}/timeline`; `GET /mission-center/incidents` |
| Assessments | `GET /assessments`, `GET /assessments/{id}`, `POST /assessments/routing/preview`, `…/{id}/assign-engineer`, `…/branch-options`, `…/delegate-branch`, `…/review`, `…/submit` |
| Submissions (GISA) | `GET/POST /submissions`, `GET/PATCH /submissions/{id}`, `…/gisa`, `…/gisa/actions`, `…/gisa/incident-types`, `…/gisa/pdf`, `…/geometry`, `…/photo-map`, `…/permissions`, `…/title`, `…/review`, `…/submit`, `…/notify-coordinator`, `POST /submissions/{id}/attachments` (multipart) |
| Attachments | `GET /attachments/{id}/download-url` (a presigned S3 URL, valid for about 15 minutes: fetch it **without** an `Authorization` header), `POST /attachments/complete` |
| Offline terrain | `GET /submissions/{id}/gisa/offline-scene-package`, `…/generate`, `…/job`, `…/job/cancel`, `…/job/retry`, `…/download` |
| Road inventory | `GET /road-inventory/manifest`, `GET /road-inventory/package`, `GET /road-inventory/mobile-package/download` |
| Maintenance | `GET /maintenance-work/incidents`, `GET /maintenance-work/incidents/{id}`, `POST …/{id}/actions` |
| Notifications | `GET /notifications`, `GET /notifications/unread`, `POST /notifications/read`, `POST /notifications/devices`, `POST /notifications/devices/unregister` |
| Admin (read) | `GET /admin/users` (pickers) |

Do not call `/auth/login`: the Caltrans deployment is Entra-only.

## What else must be ported

| Expo app | Swift replacement |
| --- | --- |
| Screens in `mobile/app/(tabs)`: incidents (list, create, detail, track), submissions (list, map, GISA detail), drafts, assessments, maintenance, notifications, road inventory, settings | SwiftUI screens |
| Native ArcGIS module (`mobile/plugins/arcgis-ios`, about 8,400 lines of Objective-C on **ArcGIS Runtime SDK for iOS 100.15.6**): mission-center map, site photo map, polygon and pencil sketch, offline terrain scenes (`.mspk`/`.eristerrain`), immersive corridor, camera direction | **ArcGIS Maps SDK for Swift (200.x)**. The 100.x Runtime is Esri's previous generation; its APIs differ, so treat this as a rewrite guided by the Objective-C code |
| Offline (`mobile/src/offline`): drafts, incident queue, lookups cache, sync loop, scene packages, road-inventory packages, photo metadata | Local store plus a background sync queue. Data files use `NSFileProtectionComplete` (they hold incident data and photos) |
| Business logic in TypeScript with unit tests (`mobile/src/measurements`, `mobile/src/arcgis/*Model.ts`, fixtures in `__fixtures__`) | Swift ports with XCTest. Port the existing tests and fixtures first: they are the parity check |
| `expo-secure-store`, `expo-camera`, `expo-location`, `expo-image-picker` | Keychain, AVFoundation, Core Location, PhotosUI |
| Expo push (`EXPO_PUSH_*` server settings) | APNs (below). The server side is implemented |

## Push notifications (APNs)

Push is allowed. The server sends each new notification-feed item to the person's registered
iPhones through APNs, using **token-based authentication**.

**Caltrans Apple developer account:**
- Create an APNs auth key (`.p8`; Keys → +, Apple Push Notifications service). Note its
  **Key ID** and the account's **Team ID**.
- Enable the **Push Notifications** capability on the app ID.

**Server (`app.env`):**
- `APNS_ENABLED=true`
- `APNS_KEY_FILE=/run/secrets/eris/apns-auth-key.p8`: put the key in
  `deploy/podman/secrets/`, mode 600. It is mounted read-only into the API only, and
  backups include it.
- `APNS_KEY_ID`, `APNS_TEAM_ID`, and `APNS_TOPIC=<bundle id>`.
- The host needs outbound HTTPS to `api.push.apple.com:443` (HTTP/2).

**App:**
1. After sign-in, call `UNUserNotificationCenter.requestAuthorization` and then
   `UIApplication.shared.registerForRemoteNotifications()`.
2. In `didRegisterForRemoteNotificationsWithDeviceToken`, hex-encode the token and call
   `POST /api/notifications/devices` with `{"token": "<hex>", "platform": "apns"}`. Use
   `"apns-sandbox"` for builds run from Xcode, which get sandbox tokens. Enterprise and
   Intune builds use the production gateway (`"apns"`).
3. On sign-out, call `POST /api/notifications/devices/unregister` with the same token
   **before** `POST /api/auth/logout`.
4. The payload is `{"aps": {"alert": {"title", "body"}, "sound": "default"}, "link": "/…", "id": n}`.
   Open `link` in the app when the person taps the notification, and mark it read with
   `POST /api/notifications/read`.

The server retires a device token Apple reports as unregistered or invalid. It retries on
throttling, an Apple outage or an expired provider token, and never logs tokens or message
text. Notification titles and bodies appear on the lock screen. They come from ERIS's
notification templates, which name incidents and actions; if Caltrans wants lock-screen text
reduced, that is a template change.

## Security baseline for the Swift app

- App Transport Security on, with no exceptions; the API and file host are HTTPS only.
- The ERIS session lives only in the Keychain (this device only). MSAL manages its own cache.
  Nothing secret goes in `Info.plist`, the bundle or logs.
- Offline data and photos are protected with `NSFileProtectionComplete`.
- Presigned S3 URLs are fetched without the ERIS token, and the token never appears in a URL.
- No password UI, no embedded web view for sign-in, no certificate pinning (Caltrans TLS
  inspection and certificate rotation would break it; ATS plus Entra suffice).
- Distribution: archive with the Enterprise (in-house) distribution certificate and
  provisioning profile, upload the `.ipa` to Intune as an iOS line-of-business app, and assign
  it to the ERIS group; it appears in Company Portal. Intune pushes updates when a new version
  (higher build number) is uploaded. The in-house **provisioning profile expires every year**,
  and the distribution certificate every three years. Re-sign and re-upload before either
  expires, or the app stops launching on every phone. Put both dates in the operations
  calendar.

## Acceptance on the Mac mini

1. Build and run on the Caltrans iPhone against ERIS staging with `ENTRA_MOBILE_CLIENT_ID`
   set.
2. Sign in: Authenticator or SSO with no password prompt, then the ERIS landing screen. Test
   a linked account, an unlinked account (403 message), and a disabled account.
3. Force a 401 (an admin uses **Sign out everywhere**): the app silently signs in again
   while the account is active, and fails once the account is disabled.
4. Sign out: that device's session ends and the web session stays.
5. Upload a photo, open it through its presigned URL, generate and open an offline terrain
   package, then queue a draft offline and sync it.
6. Check that no token appears in the device console logs or in any URL in the gateway logs.

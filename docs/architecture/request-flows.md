# Request flows

How a request travels through ERIS, step by step. Each diagram names the code
that does the work, so you can follow it in the source.

- [Web sign-in through Entra](#web-sign-in-through-entra)
- [iPhone sign-in through MSAL](#iphone-sign-in-through-msal)
- [An authenticated write from the browser](#an-authenticated-write-from-the-browser)
- [Session expiry and silent renewal on the iPhone](#session-expiry-and-silent-renewal-on-the-iphone)
- [Uploading a photo](#uploading-a-photo)
- [Downloading a file through a presigned URL](#downloading-a-file-through-a-presigned-url)
- [Generating an offline terrain package](#generating-an-offline-terrain-package)
- [Notifications and push](#notifications-and-push)
- [Sign-out and revocation](#sign-out-and-revocation)

## Web sign-in through Entra

Code: `backend/app/entra.py`, `backend/app/routes/auth.py` (`start_session`),
`backend/app/sessions.py`, `backend/app/entra_credential.py`,
`web/src/pages/LoginPage.tsx`, `web/src/pages/EntraCompletePage.tsx`.

```mermaid
sequenceDiagram
    autonumber
    actor U as Person
    participant B as Browser (SPA)
    participant API as ERIS API
    participant E as Microsoft Entra ID
    participant DB as MariaDB

    U->>B: Opens ERIS
    B->>API: GET /api/auth/config
    API-->>B: entra_enabled, local_login_enabled=false
    B->>API: GET /api/auth/entra/start (auto, SSO-only)
    API-->>B: 302 to Entra authorize (PKCE S256, state, nonce)<br/>Set-Cookie eris_entra_state (signed, HttpOnly, 5 min)
    B->>E: Authorize
    E->>U: Sign in, MFA, Conditional Access (silent on a managed device)
    E-->>B: 302 /api/auth/entra/callback?code&state
    B->>API: Callback with code, state, state cookie
    API->>API: Check state cookie matches state
    API->>E: POST token: code + PKCE verifier + client assertion<br/>(JWT signed with the ERIS certificate)
    E-->>API: ID token
    API->>E: Fetch signing keys (JWKS)
    API->>API: Verify signature, issuer, audience, tenant, nonce, object ID
    API->>DB: Find active account linked to (tenant, object ID)
    API->>DB: INSERT user_sessions (SHA-256 of a random credential)
    API-->>B: 303 /auth/entra/complete<br/>Set-Cookie __Host-eris_session (HttpOnly, Secure, SameSite=Strict)<br/>Set-Cookie __Host-eris_csrf (readable)
    B->>API: GET /api/auth/me (cookie)
    API-->>B: Account and roles
    B->>U: Landing page (My Work or Incidents)
```

If anything fails, the API redirects to `/login?entra=cancelled|failed|not_linked|unavailable`
and logs the reason on the `eris.auth` logger. Nothing in the URL or page script
can carry a session.

## iPhone sign-in through MSAL

Code: `ios/ERISKit/Sources/ERISKit/Auth/AuthService.swift`,
`ios/ERIS/Platform/MSALTokenProvider.swift`, `backend/app/entra.py` (`native`).

```mermaid
sequenceDiagram
    autonumber
    actor U as Person
    participant App as ERIS iPhone app
    participant MA as Microsoft Authenticator (MSAL broker)
    participant E as Microsoft Entra ID
    participant API as ERIS API
    participant KC as iOS Keychain

    App->>API: GET /api/auth/config
    API-->>App: entra_mobile: authority, ERIS Mobile client ID, API scope
    App->>App: Check the authority is a Microsoft tenant
    App->>MA: acquireToken(scope access_as_user)
    MA->>E: Sign in (device's Caltrans account, MFA, compliance)
    E-->>MA: Access token for the ERIS API (azp = ERIS Mobile)
    MA-->>App: Access token
    App->>API: POST /api/auth/entra/native {access_token}
    API->>API: Verify signature, issuer, tenant, audience,<br/>scope access_as_user, azp = ERIS Mobile, object ID
    API->>API: Refuse if the caller is a browser
    API-->>App: ERIS bearer session (Entra token discarded)
    App->>KC: Store session (this device only)
```

## An authenticated write from the browser

Code: `backend/app/main.py` (`refuse_cross_site_writes`), `backend/app/sessions.py`
(`check_origin`, `authenticate`), `backend/app/deps.py`, `web/src/api/client.ts`.

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant N as nginx (eris-web)
    participant MW as API middleware
    participant AU as sessions.authenticate
    participant G as Role guard
    participant H as Route handler
    participant DB as MariaDB

    B->>N: POST /api/incidents/12/claim<br/>Cookie: __Host-eris_session<br/>X-CSRF-Token
    N->>MW: Proxy to :8000 (strips /api)
    MW->>MW: Origin is ERIS? Sec-Fetch-Site not cross-site? else 403
    MW->>AU: Dependency: current_session
    AU->>DB: Session by SHA-256(credential)
    AU->>AU: Not revoked, not expired,<br/>idle under 30 min, account active
    AU->>AU: Cookie session: X-CSRF-Token = HMAC(session)? else 403
    AU->>DB: Touch last_seen_at (at most once a minute)
    AU->>DB: Load roles
    AU-->>G: user + roles
    G->>G: Role allowed for this route? else 403
    G-->>H: user
    H->>H: Record rules (district, office, assignment, owner)
    H->>DB: Write, commit
    H-->>B: 200 JSON
```

## Session expiry and silent renewal on the iPhone

Code: `ios/ERISKit/Sources/ERISKit/API/APIClient.swift` (`RenewalGate`).

```mermaid
sequenceDiagram
    autonumber
    participant App as iPhone app
    participant API as ERIS API
    participant MSAL as MSAL (silent)

    App->>API: GET /api/incidents (Bearer old session)
    API-->>App: 401 (12-hour limit reached or revoked)
    App->>MSAL: acquireTokenSilent (one renewal shared by concurrent calls)
    alt Device sign-in still valid
        MSAL-->>App: New Entra access token
        App->>API: POST /api/auth/entra/native
        API-->>App: New ERIS session
        App->>API: Retry GET /api/incidents
        API-->>App: 200
    else Interaction required or account disabled
        App->>App: Clear session, show sign-in
    end
```

## Uploading a photo

Code: `backend/app/main.py` (submission attachments), `backend/app/routes/incidents.py`
(incident attachments), `backend/app/storage.py`, `backend/app/services/field_media_*.py`.

```mermaid
sequenceDiagram
    autonumber
    participant C as Browser or iPhone
    participant API as ERIS API
    participant S3 as SeaweedFS (eris-uploads)
    participant DB as MariaDB

    C->>API: POST /api/submissions/7/attachments?section_key=…<br/>multipart file (≤ MAX_UPLOAD_MB)
    API->>API: Authenticate, check the person may edit the form
    API->>API: Validate size and type, read EXIF position and heading
    API->>S3: PUT object (private bucket, generated key)
    API->>DB: INSERT attachments (bucket, key, metadata), link to section
    API-->>C: attachment_id
```

File bytes are never stored in MariaDB; tables hold the bucket and key.

## Downloading a file through a presigned URL

Code: `backend/app/main.py` (`/attachments/{id}/download-url`), `backend/app/storage.py`.

```mermaid
sequenceDiagram
    autonumber
    participant C as Browser or iPhone
    participant API as ERIS API
    participant GW as TLS gateway (file hostname)
    participant S3 as SeaweedFS

    C->>API: GET /api/attachments/9/download-url (session)
    API->>API: Visibility rules (Guests: approved records only)
    API-->>C: Presigned URL on the file hostname, about 15 minutes
    C->>GW: GET https://eris-files…/eris-uploads/…?X-Amz-Signature=…<br/>(no ERIS session sent)
    GW->>S3: Forward unchanged (Host, path, query) to :9800
    S3->>S3: Verify the signature and expiry
    S3-->>C: File bytes
```

Anyone holding an unexpired presigned URL can fetch the file, so gateways should
not log query strings.

## Generating an offline terrain package

Code: `backend/app/services/offline_scene_jobs.py`, `backend/app/worker/offline_scene_worker.py`,
`backend/app/services/offline_scene_*.py`. Operator detail:
[offline scene packages](../operations/offline-scene-packages.md).

```mermaid
sequenceDiagram
    autonumber
    participant C as Author (web or phone)
    participant API as ERIS API
    participant DB as MariaDB
    participant W as eris-worker
    participant G as USGS 3DEP, NAIP, Census, Caltrans
    participant S3 as SeaweedFS (eris-offline-scenes)

    C->>API: POST /api/submissions/7/gisa/offline-scene-package/generate
    API->>DB: INSERT offline_scene_jobs (queued)
    API-->>C: Job queued
    loop Poll
        W->>DB: Claim the next queued job, heartbeat
    end
    W->>G: Elevation, imagery, road context for the bounded area
    W->>W: Build the eristerrain bundle
    W->>S3: Upload package (private, versioned)
    W->>DB: offline_scene_packages row, job done
    C->>API: GET …/offline-scene-package/job
    API-->>C: Ready
    C->>API: GET …/offline-scene-package/download
    API-->>C: Presigned URL
```

## Notifications and push

Code: `backend/app/services/notification_feed.py`, `push.py`, `apns.py`,
`notifications.py` (email), `backend/app/routes/notifications.py`.

```mermaid
sequenceDiagram
    autonumber
    participant H as Workflow step (handler)
    participant DB as MariaDB
    participant L as Push loop (in the API, every 10 s)
    participant APNS as Apple Push
    participant P as iPhone
    participant B as Browser bell

    H->>DB: INSERT user_notifications (feed item), commit
    L->>DB: Feed items not pushed yet (last 24 h)
    L->>DB: The person's active push_devices
    L->>APNS: HTTP/2 POST /3/device/<token><br/>ES256 provider token
    APNS-->>P: Alert (title, body, in-app link)
    L->>DB: push_state SENT, NONE or FAILED, and retire dead tokens
    B->>DB: GET /api/notifications/unread (via the API)
    P->>DB: Tap → POST /api/notifications/read (via the API)
```

Email (when `SMTP_*` is set) goes through an outbox table and is retried at
startup and by `app.tools.flush_email_outbox`.

## Sign-out and revocation

Code: `backend/app/routes/auth.py`, `backend/app/admin_users.py`, `backend/app/sessions.py`.

```mermaid
flowchart LR
    signout["Sign out<br/>POST /auth/logout"] --> one["This session revoked,<br/>cookies cleared"]
    everywhere["Sign out everywhere<br/>POST /auth/sessions/revoke-all"] --> all["Every session of the account revoked"]
    adminrevoke["Admin: Sign out everywhere<br/>POST /admin/users/{id}/revoke-sessions"] --> all
    disable["Admin disables the account"] --> all
    reset["Admin resets a password<br/>(rehearsal only)"] --> all
    idle["30 min without a request (web)"] --> expired["Session refused at the next request"]
    absolute["12 h after sign-in"] --> expired
    all --> expired
    one --> expired
```

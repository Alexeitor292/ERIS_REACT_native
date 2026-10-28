# Caltrans deployment readiness audit — 2026-10-28

An audit of the implementation against the [IT briefing](caltrans-it-deployment-brief.md),
the [Podman runbook](caltrans-podman.md), [`Jenkinsfile.podman`](../Jenkinsfile.podman) and
[`deploy/podman`](../deploy/podman). It records what changed on the
`claude/caltrans-deployment-readiness` branch, what remains open, and how each change was
tested. It does **not** claim Caltrans approval of Podman, the security design, or the
network configuration, and nothing here was applied to the running Proxmox rehearsal.

## Changed

| Area | Gap found | Change |
| --- | --- | --- |
| Session security | The web kept a 120-minute bearer JWT in `localStorage`, readable by any script on the page. An issued token could not be ended: sign-out only cleared the browser, and disabling someone in Entra left the token valid. | **Server-side sessions** (`app/sessions.py`, table `user_sessions`, migration `20261028_user_sessions`). Each session is a random 256-bit credential; only its SHA-256 is stored. Browsers get it in a `__Host-eris_session` cookie (HttpOnly, Secure, SameSite=Strict, Path=/, no expiry) that scripts cannot read. The Entra callback sets it directly, so the old token handoff is gone. Writes need a signed double-submit CSRF token (`X-CSRF-Token`). A middleware refuses browser writes from other origins, including login CSRF. Sessions end after `SESSION_IDLE_MINUTES` (30, web) and `SESSION_ABSOLUTE_MINUTES` (720), per NIST SP 800-63B AAL2. Sign-out ends one session. `POST /auth/sessions/revoke-all`, admin **Sign out everywhere**, disabling an account and password resets end all of them. A cookie cannot be replayed as a bearer token, nor the reverse. Native clients get a bearer token only when the request lacks the browser-only `Sec-Fetch-*` headers. Ended rows are purged after 90 days. Upgrading signs everyone out once. |
| Session security | Production would start with a placeholder or short `JWT_SECRET`, an unbounded session, or over plain HTTP. | With `ENV=prod` the API refuses to start unless `JWT_SECRET` has at least 32 characters, `WEB_BASE_URL` is HTTPS, and the session limits are within AAL2 bounds. |
| Session security | `GET /attachments/{id}/content?access_token=…` accepted bearer tokens in URLs, which TLS gateway logs record. | Removed: that route authenticates like every other (cookie or `Authorization` header). The mobile submission screen loads presigned storage URLs; if those fail it uses the API content proxy with an `Authorization` header (`mobile/src/api/attachmentUrls.ts`), and "Open file" fetches a fresh presigned URL. The fullscreen viewer no longer sends the bearer token to presigned storage URLs. Mobile sign-out now ends its server session. |
| Entra sign-in | A failed, unlinked or misconfigured Entra sign-in left the browser on a raw JSON API error page. | `/auth/entra/start` and `/callback` return to `/login?entra=cancelled|failed|not_linked|unavailable`. Inactive and unknown accounts get the same `not_linked` reason. Outcomes go to the `eris.auth` logger with user ID or tenant/object ID, never tokens or codes. |
| Passwords | Caltrans web apps sign in through Entra SSO, but ERIS shipped a password form and seeded the first admin with a password. | The Caltrans template is **Entra-only** (`LOCAL_LOGIN_ENABLED=false`). The first admin is seeded by Entra object ID; bootstrap, account creation, password reset and `create_admin` all refuse passwords in that mode. `create_admin --entra-object-id` is the recovery path. The login page goes straight to Entra when it is the only method, so a Caltrans device can sign in silently with MFA/Conditional Access. After sign-out or a failed attempt it shows a button instead, so it never loops. Admin pages hide password fields. Passwords remain only for development and the Campos Labs rehearsal, which has no Entra. |
| Administrator handover | An administrator could disable their own account or the last active administrator, locking everyone out of role management. | Both are refused (409). The last-admin rule is shared with the existing ADMIN-role removal check. |
| Administrator handover | Turning password sign-in off required rebuilding the web image, and there was no check that handover had finished. | Public `GET /auth/config` reports the enabled sign-in methods, and the login page uses it. `eris-pod.sh handover-check` runs `app.tools.handover_status` in the running API: it requires at least two active Entra-linked admins who have signed in through Entra, a disabled (or Entra-only) bootstrap admin, no active admin with a password, password sign-in off, and no `bootstrap.env`. |
| Jenkins/Harbor | The host deployed tags; the pipeline recorded nothing it pushed and had no SBOM, vulnerability gate or signing. | Images carry OCI revision/version labels. `deploy/ci/release-gate.sh`: Trivy writes a CycloneDX SBOM per image and fails the build, before any push, on a fixable HIGH/CRITICAL vulnerability or an embedded secret (exceptions in `.trivyignore`, with reason, approver and expiry). The two IT-approved third-party mirrors pass the same gate. All five digests are signed with cosign using a Caltrans key held in Jenkins, with each SBOM attached as a signed attestation; no public transparency log. Each signature is verified. The build archives five digests, SBOMs, scan reports and the public key. On the host, a Podman `sigstoreSigned` policy (`deploy/podman/signature-policy`) rejects unverified ERIS images, `eris-pod.sh pull` fetches them under that policy, and `ERIS_REQUIRE_DIGESTS=true` refuses tags. |
| Entra credential | The web confidential client authenticated with a client secret. | Certificate credential (`app/entra_credential.py`): a PS256 client assertion with `x5t#S256`, signed by an RSA key of at least 2048 bits that is mounted read-only into the API container only (`deploy/podman/secrets`, which must be private). The key must match the certificate, and expired certificates are refused. `ENV=prod` with Entra requires a certificate and refuses a secret. `eris-pod.sh cert-check` prints the Entra thumbprint and expiry; production verification fails within 30 days of expiry. Backups include the certificate. |
| Mobile sign-in | The mobile app had no Entra sign-in, so an Entra-only deployment left it unable to sign in. | RFC 8252 native flow: system browser (`expo-web-browser` auth session), authorization code + PKCE (`expo-crypto` randomness and SHA-256), a separate public client, and no secret. The app reads its public settings from `/auth/config`. `POST /auth/entra/native` verifies the Entra access token's signature, issuer, tenant, audience, `access_as_user` scope and `azp` (issued to the ERIS mobile app), matches the prelinked identity, and returns a revocable ERIS bearer session; browsers are refused. The redirect uses the bundle-identifier scheme. |
| Release automation | Releases were a manual sequence of backup, image edit, recreate and verify, with manual rollback. | `eris-pod.sh release FILE`: strict release-file validation (exactly five digests, so no shell syntax reaches `source`), a single-release lock, signed pull, matched pre-release backup, switch and migrate, production verification, and on any failure automatic rollback to the previous images with the backup restored into new volumes (recorded in `volumes.env`). Outcomes go to `releases.log`. Jenkins `DEPLOY_TO=staging-then-production` sends the signed release file to `deploy-hook.sh`, an SSH forced command with `restrict` that ignores the requested command and size-limits stdin, so Jenkins has no shell. Production gets the staging-proven digests after a named approval. |
| iOS push | Push went only through Expo's service, which a native Swift app does not use. | APNs sender (`app/services/apns.py`): token-based ES256 provider JWT from the `.p8` key in the private secrets folder (renewed every 45 minutes, and immediately after `ExpiredProviderToken`), HTTP/2 (`httpx[http2]`), alert payload with the in-app link. Devices register as platform `apns` or `apns-sandbox` (hex token validated). Unregistered or invalid tokens are retired; throttling, outages and auth errors are retried. Existing Expo devices still go to Expo. `ENV=prod` refuses a partial APNs configuration. |
| Backup and restore | Backup and restore existed only as runbook prose with no checksums, no schema/image record, and nothing stopping an import that merges into a live volume. | `eris-pod.sh backup DIR` (cold; DB + object volumes + config; `manifest.env` with Alembic revision and images; `SHA256SUMS`; restarts the pod on failure). `verify-backup DIR` checks completeness, checksums and archives. `restore DIR` imports only into new volumes, only with the pod removed, and only with matching `db.env`/`storage.env`/`app.env`. It warns when `images.env` differs. |
| Deployment verification | `verify-rehearsal.sh` checked only that containers ran, health, and the Alembic head. | It also checks running images against `images.env`, internal ports not published, env file modes, API docs hidden, the Entra redirect (tenant authority, PKCE, this site's callback), anonymous requests not signed in, anonymous bucket listing refused, and gateway headers. `ERIS_VERIFY_PROFILE=production` turns the production gates into failures: unpinned images, password sign-in on, a leftover `bootstrap.env`, and missing HSTS. |
| Browser hardening | nginx sent no security headers. | `nosniff`, `Referrer-Policy`, `X-Frame-Options: SAMEORIGIN`, CSP `frame-ancestors 'self'`, `server_tokens off`. HSTS stays with the TLS gateway. |

## Open — needs a Caltrans decision or further work

- **Caltrans Entra configuration.** ERIS relies on Caltrans for MFA (a Conditional Access
  policy on the ERIS app) and should be paired with **Assignment required** on the
  enterprise app. ERIS does not inspect MFA claims. Test with real linked, unknown,
  unassigned and disabled accounts.
- **Session limits.** 30 minutes idle and 12 hours absolute are defaults; confirm them against
  Caltrans policy. Disabling someone only in Entra does not end an existing ERIS session;
  the offboarding procedure must also disable the ERIS account.
- **Native iOS app.** The Caltrans iOS app will be rewritten in Swift (MSAL for iOS with the
  Authenticator broker, ArcGIS Maps SDK for Swift) on the Caltrans Mac mini; see
  [ios-native-app.md](ios-native-app.md) for the API contract, porting map and acceptance
  steps. A check on a Caltrans-issued iPhone (2026-10-28) found Intune enrollment,
  "Can access company resources", Authenticator signed in, no app-protection prompts, and an
  immediate Safari sign-in to My Apps: device-compliance Conditional Access, not MAM. Caltrans
  must confirm the policy for the ERIS registrations. The server exchange needs no change for
  MSAL tokens.
- **Mobile device test and Intune (Expo reference app).** Mobile Entra sign-in needs the ERIS Mobile app
  registration, the exposed `access_as_user` scope (v2 tokens), a development or store build,
  and a test on enrolled devices. Caltrans uses Intune. If Conditional Access requires a
  **compliant device**, the current system-browser sign-in should pass through the Enterprise
  SSO plug-in once the app is allowed in it (test needed). If it requires an **app protection
  policy**, the app needs the Intune App SDK and MSAL with the Authenticator broker: native
  iOS/Android work on macOS. The server exchange already accepts those tokens.
- **Release access.** Automated releases need SSH from the Jenkins agent to each host
  (forced-command keys, pinned host keys). Without it, an operator runs `eris-pod.sh release`.
- **Supply-chain operation.** Caltrans creates and guards the cosign key pair, mirrors the
  Trivy and cosign images (and the Trivy database for an offline agent), sets Harbor's
  enforcement options, decides severity and exceptions, and binds `agent any` to an approved
  Linux Podman agent. Deployment itself is still manual (`eris-pod.sh`), by design.
- **Certificate lifecycle.** Caltrans issues the Entra client certificate and owns its rotation;
  ERIS reports expiry but cannot renew it.
- **Full CSP, HSTS, WAF/rate limits** at the gateway; the CSP needs the agreed ArcGIS/map
  source list.
- **Backups** are cold (an outage per backup) and are not encrypted or moved off-host by the
  script; Caltrans's backup product may replace them. They have not been run on Caltrans storage.

## How it was tested

- Backend, no database: `tests/test_session_security.py` (cookie attributes, hash-only
  storage, CSRF, origin checks, idle/absolute expiry, cookie/bearer separation, logout scope,
  query-string tokens refused, Entra callback cookies and failures, production settings) and
  `tests/test_admin_handover.py` (last-admin guards, revocation, SSO-only refusals,
  `create_admin` Entra recovery, handover status). The whole no-database suite passes, with
  `test_asgi_entrypoint.py` giving its simulated production run a real key and HTTPS URL.
- **Not run:** the database-marked tests (no MariaDB was available), including migration
  `20261028_user_sessions` on a real database. They sign in through `/auth/login` without
  browser headers, so they receive bearer tokens as before. Run the DB suite and a staging
  upgrade before release.
- Web: `tsc --noEmit` and `npm test` pass, including `src/auth/token.test.ts` and
  `src/pages/loginModel.test.ts`. Sign-in, sign-out, uploads, form presence and the admin
  page were **not** exercised in a browser against a running API.
- Entra certificate and mobile exchange: `tests/test_entra_certificate_and_mobile.py` generates
  real certificates and keys. It checks the assertion header, claims and PS256 signature
  against the certificate, refusal of mismatched, weak and expired credentials, that no secret
  is sent, the production rules, and the check tool. For mobile it uses tokens signed by a test
  JWKS: valid; wrong `azp`, scope, audience, tenant or expiry; unlinked; and browser callers.
- Mobile: `tsc --noEmit` and `npm test` pass, including `src/api/attachmentUrls.test.ts` and
  `src/auth/entraPkce.test.ts` (base64url, the S256 challenge against node's SHA-256, the
  authorize and token requests, state and authority checks, and error handling). Sign-in,
  attachment previews and "Open file" were **not** exercised on a device.
- Release automation: `test-eris-pod.sh` covers refused release files (tag, shell injection,
  missing image), the lock, a successful release (pull, backup, switch, log), automatic
  rollback after a health failure and after a verification failure (previous images running
  on restored volumes, `volumes.env` written), and the SSH hook (stdin, size limit, ignored
  command).
- Deployment and release scripts: `deploy/podman/tests/test-eris-pod.sh`,
  `test-verify-rehearsal.sh` and `deploy/ci/tests/test-release-gate.sh` run the real scripts
  against stub `podman`/`curl`, including failure paths: the vulnerability gate, tag signing,
  certificate checks and the signature policy. Each shell block in the Jenkinsfile passes
  `bash -n`; the Jenkinsfile itself has not run in Jenkins, and Trivy and cosign have not run
  against real images. File-mode
  assertions run only on Linux. Nothing was run against real Podman, Harbor, Jenkins or Entra.
- nginx: the configuration was not syntax-checked with an nginx binary.

# Guided web demo deployment, November 9, 2026

Open [the internal demo](https://eris.camposlabs.org/demo/). This release replaces
the initial imitation UI with the actual deployed ERIS web page components and
styles from `0f91da9`. Only identity and data service boundaries use mock adapters.
The native Swift iOS walkthrough is deferred. All demo pages and assets now require an active ERIS session at the gateway.

## Deployment

- Build: `npm run build:demo` from `web/`; output `web/dist-demo/`.
- Build context on VM 118: `/home/eris/guided-demo-internal-20261109/`.
- Image: `localhost/eris/guided-demo:20261109-internal`.
- Image ID: `825adf84fd17c386f9d2eea1a97f8402e6df36a885a0e1954fe7fcf563b435c4`.
- [Dedicated Dockerfile](../../../deploy/demo/Dockerfile) and
  [nginx configuration](../../../deploy/demo/nginx.conf).
- Systemd user service: `eris-demo.service`, user `eris`, with lingering enabled.
  [Service unit](../../../deploy/demo/eris-demo.service).
- Independent container `eris-demo`, published at `192.168.20.216:8081`.
  No backend credentials, API proxy, database, production mounts or migrations.
  UID/GID 101, read-only root, bounded resources and temporary nginx directories.
- Caddy in LXC 102 routes only `/demo` and `/demo/*` to the dedicated service,
  checking the session and stripping `/demo`. [Route snippet](../../../deploy/demo/caddy-route.caddy).
- Original Caddy configuration: `/etc/caddy/Caddyfile.pre-guided-demo-20261109`
  inside LXC 102. It remains available if the special route must be removed.

The browser runtime uses memory-only mock records and shadows browser storage.
The nginx policy permits static resources, public GIS basemaps and map workers,
while refusing API/auth paths. Unsupported mock actions fail closed. See
[the walkthrough guide](../../user-guides/guided-demo.md) for its scope and isolation.

The main portal now shows **Guided Demo** on login, built with
`VITE_GUIDED_DEMO_ENABLED=true`. Its frontend-only image is
`localhost/eris/web:0f91da9-internal-demo`, ID
`0ab387022958942f79fbf0ca0137089983dfd43fc5f2cb3d74bdd821a19cb21b`.
Context: `/home/eris/web-internal-demo-20261109/`. This layer preserves previous
static chunks for already-open pages. `/opt/eris/deploy/podman/images.env` points
to the new frontend so restarts retain it; its prior copy is
`images.env.pre-internal-demo-20261109` in that directory. No sign-in methods,
API credentials, data services, database schema or data were changed.

The controls release fixes sample-location filling from every tab and performs
the lookup automatically. Manual coordinate entry retains its real confirmation
step, now with clearer instructions. Guide highlights draw inside their controls
and no longer clip onto adjacent tabs. The guide supports pointer and keyboard
movement, remains reachable after resizing, and recognizes reports sent before
every introductory prompt has advanced.

## Verification

The complete browser check passed against the public HTTPS URL using the real
controls and dialogs: 16 checkpoints through approval, including revision and
resubmission. Finish, exit, reload, and fresh tabs clear the mock world. It
observed no live ERIS API requests, no persistent browser-storage access and no
JavaScript runtime errors. Cloudflare's injected inline script is blocked by the
static site's content security policy; this does not prevent the walkthrough.

Web unit tests: 303 passed. The normal portal production build and standalone
demo build both passed. The backend fixture moved out of the retired React Native
project has 13 passing affected tests. Documentation link checking found no
broken links. Native Swift/Xcode tests were not run on this Windows host.
The broader Windows backend run had 1,377 passes and three existing platform
failures (Windows strftime formatting and missing timezone data). A separate
Linux API-image test attempt lacked worker test dependencies; neither run is
reported as a complete backend pass.

After the login invitation was authorized, only `eris-web` and `eris-demo` were
replaced. The new web container ID is
`ae866fb891b9f9188c9bf9901295e4ce7807b112e1e3f3df53c1abdb9fd57d7b`.
API, worker, database and storage container IDs matched before and after the
frontend update. Their snapshots and the rollout script are in the web context.
The public login-to-demo controls check and full 16-checkpoint walkthrough passed
again, including sample lookup, invalidation, sending, early submission, dragging,
resize/minimize, revision, approval and isolation. Portal and API health returned
HTTP 200. No live ERIS records were created by these checks.

## Internal access protection

At the owner's request, public demo access was removed. The Caddy gateway checks
`/api/auth/me` before every `/demo` page and asset. An unsigned-in, invalid or
expired session receives a 303 to `/login?demo=1`. Client-supplied identity headers
do not grant access. The gateway strips Cookie and Authorization before sending
the approved request to the static mock service. Auth checks use one connection
to avoid racing the existing session-activity update during parallel asset loads.

The login invitation requires ERIS sign-in; authenticated staff also have a
Guided Demo link in the portal header. The exercise uses only mock business
records and scenario identities. Same-origin static requests carry the session
for gateway checks; external map requests omit credentials. A protected health
probe closes an open exercise within a minute of losing access.

The access browser check passed for anonymous documents, deep links, scripts,
health, invalid cookies and spoofed identity headers. A short-lived access-check
session verified successful authenticated parallel loading and the full workflow.
It also verified that losing the cookie closes the open exercise. The temporary
session was revoked and its private browser state file deleted afterward. No
live incident, assessment, organization or file record was created by these checks.

Current authenticated Caddy backup in LXC 102:
`/etc/caddy/Caddyfile.internal-demo-authenticated-20261109`.
The earlier `Caddyfile.pre-internal-demo-20261109` snapshot contains the public
route and must not be restored to a running demo.

## Rollback

Keep the authenticated gateway route in place during any image rollback.
Do not restore an earlier public demo route. To withdraw training altogether,
stop `eris-demo.service` and keep or replace its route with an unavailable response.

The immediately prior demo unit is
`~/.config/systemd/user/eris-demo.service.pre-internal`. Earlier images remain
available, but pre-authentication demo builds did not support authenticated map
resource loading, so prefer the current internal build.

The immediately prior frontend image is
`localhost/eris/web:0f91da9-guided-demo`; its image configuration backup is
`/opt/eris/deploy/podman/images.env.pre-internal-demo-20261109`. A frontend rollback
recreates only `eris-web` in the existing pod and leaves API, worker, database and
storage running. The gateway restriction must remain active even if the older
frontend still contains the old invitation wording.

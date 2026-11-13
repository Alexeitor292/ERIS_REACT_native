# Actual ERIS pages backed by an isolated mock world

Date: 2026-11-09

## Context

Maintenance outreach requires a walkthrough that teaches the pages people will actually use. A separately drawn demo UI does not meet that requirement, even if it follows the correct workflow. The demonstration must also avoid reading live records or changing a real account.

## Decision

A standalone Vite entry compiles the production App, routes, page components, styles, dialogs and forms. A demo-only resolver substitutes mock implementations at service boundaries: API client, identity provider, CSRF helper, postmile resolution, and section uploads. UI components are not duplicated. App accepts an optional router basename, leaving normal portal behavior unchanged.

The mock database is per-tab memory. Fictional identities change at guided handoffs, while the actual page role gates and controls still apply. Native browser storage is shadowed with temporary memory stores before importing the pages. A fail-closed network guard refuses real API requests; public read-only GIS resources can draw the actual map controls and basemaps. Mock uploads create temporary blob URLs and are cleared with the session.

A separate read-only static container serves `/demo`. The gateway checks the real ERIS session before every demo page and asset, using the existing authentication service. Only active signed-in accounts may enter. Credentials are stripped before the static service receives the request. Authentication checks are serialized to avoid racing concurrent session-activity updates during asset loading. A minute-by-minute gateway probe closes an open exercise when the session ends. The login page invites staff to sign in; the portal header links to the exercise after sign-in.

The scenario itself uses mock identities and records. Finish, exit, reload, navigation away, and back/forward-cache restoration clear it. No record seed, permanent account, API route, database table or new permission is added. API and data services remain on their existing release.

## Scope

The current tour covers the web portal and the branch-route assessment through approval, with a revision loop. The native Swift iOS portion is deferred. React Native/Expo was retired separately at the owner's request. Full GISA views come directly from production source; unsupported mock operations refuse rather than falling back to live services.

## Validation

Browser checks execute the actual controls and dialogs, confirm revision/approval, verify cleanup and independent tabs, and assert zero ERIS API requests or persistent-storage access. Unit tests verify the mock model's transitions and refusals. The deployed web source baseline is commit `0f91da910bd430a3de379c30dc0c3cdfdc919518`.

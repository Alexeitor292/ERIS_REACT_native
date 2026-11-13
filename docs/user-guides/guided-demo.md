# Guided web demo

Open the [ERIS login page](https://eris.camposlabs.org/login), choose **Guided Demo**, and sign in with an authorized ERIS account. Signed-in staff can also choose **Guided Demo** in the portal header. Then select **Start guided web demo**. The [direct demo link](https://eris.camposlabs.org/demo/) also requires sign-in.

The demo compiles the actual ERIS web pages, navigation, dialogs, pickers, GISA form, and styles from the deployed release. It does not recreate those screens. A small floating guide sits over the pages. Minimize it whenever it covers a control.

## The walkthrough

Sixteen checkpoints follow a fictional report through the actual web interface:

1. Open **Incidents**, then **Report an incident**.
2. Choose **Coordinates**, enter 38.450100 and -122.900100, then **Find its post mile**. Typing coordinates alone does not confirm a location. Alternatively, **Fill the sample coordinates** selects Coordinates, fills both values, and performs the sample lookup in one click, from any location tab.
3. Enter **What was seen** and **First seen**, optionally attaching sample evidence.
4. **Send report**.
5. As the sample supervisor, use **My Work**, complete review, enter notes, and **Record action**.
6. As the district decision maker, select **Send to GeoTech**, choose the sample District Contact and Incident Group, enter notes, and **Record action**.
7. As the Office Chief, hand off to the sample Branch Chief using the real routing picker.
8. As the Branch Chief, assign the sample Staff member.
9. Open the linked technical submission.
10. Explore the full GISA page, write sample observations or a memo, and **Save draft**.
11. Submit the assessment from **My Work**, confirming the real dialog.
12. As the reviewer, request a revision with a workflow note.
13. Revise and save the same GISA form.
14. Resubmit the assessment.
15. As the reviewer, approve it.
16. Read the approved assessment record, then **Finish & clear**.

The guide switches only fictional identities. Maintenance duties and review steps illustrate one sample district configuration. The branch route is interactive; other routes and tools remain visible according to the actual role-based interface. Unsupported mock actions fail closed instead of contacting a live API.

Drag the guide by its header to move it out of the way. Its move handle also accepts arrow keys (Shift for larger moves), and Home restores the default position. The guide stays within the browser window when resized or expanded. If you send the report before advancing the introductory prompts, the guide recognizes the sent report and continues to supervisor review.

The browser walkthrough covers the web portal only. The native Swift iOS walkthrough is deferred. There is no recreated phone UI.

## Isolation

Every visitor and tab has independent memory-only records, files, notifications, identities, and preferences. Start, finish, exit, reload, and navigation away discard demo data. Back/forward-cache restoration clears the session too. File previews use temporary blob URLs, which are revoked when cleared.

The gateway verifies the real ERIS session before serving any demo page, script or asset. Anonymous, invalid and expired sessions cannot open it. The real session credential is stripped before forwarding to the static mock service. An already-open demo checks the protected health path once a minute and clears and returns to sign-in when access ends.

Inside the exercise, the build replaces the API client, scenario auth context, CSRF helper, postmile lookup and file-upload adapter. The production components themselves render the UI. Browser storage is replaced with temporary memory stores, so real account preferences are neither read nor changed. A network guard rejects live business API calls and unknown requests. Same-origin static resources carry the session for gateway checks; public GIS requests omit credentials. GIS basemaps do not supply incident or organization data.

## Building and checking

From `web/`:

```powershell
npm run build:demo
npx vite preview --config vite.demo.config.ts --host 127.0.0.1 --port 4177
```

The output is `web/dist-demo/`, served independently through `/demo` and `/demo/*` using `deploy/demo/`. It requires no database, API proxy, credentials or migrations. See the [deployment record](../operations/history/guided-demo-20261109.md).

The normal portal shows its sign-in invitation and signed-in header link when built with `VITE_GUIDED_DEMO_ENABLED=true`. This is enabled on the hosted portal. The flag only controls discoverability; gateway authentication protects the separately deployed demo even if someone knows its URL. The Podman web builder forwards this environment variable.

`npm test` includes mock data isolation, state transitions, identity constraints, stale writes, and reset tests. The full browser check uses Playwright:

```powershell
$env:ERIS_DEMO_URL = 'http://127.0.0.1:4177'
node scripts/verify-real-pages-demo.mjs
```

If Playwright is supplied separately, set `ERIS_PLAYWRIGHT_MODULE` to its absolute `index.mjs` path. Optional `ERIS_DEMO_SCREENSHOTS` names an output directory. The browser check covers the actual controls and dialogs through approval, revision, cleared sessions, tab isolation, no live ERIS API traffic, and no access to persistent browser storage.

Against the deployed static service, `node scripts/verify-demo-map.mjs` also checks that the incident map loads visible tiles successfully and identifies the website using an origin-only referrer. Run it with `ERIS_DEMO_URL=https://eris.camposlabs.org`; Vite's local preview does not apply the nginx response headers.

`node scripts/verify-demo-controls.mjs` checks sample lookup, location invalidation, sending a report, early submission, pointer and keyboard dragging, resize/minimize, and inset highlights. Set `ERIS_VERIFY_LOGIN=1` against the hosted site to verify the login-page invitation and enter through it.

`node scripts/verify-demo-access.mjs` verifies anonymous page/asset refusal and rejection of invalid credentials or spoofed identity headers. For authenticated checks, set `ERIS_DEMO_AUTH_STATE` to a private Playwright storage-state file from an authorized account. The access check then verifies parallel asset loading and closure after session loss. The other browser checks accept the same variable. Never commit or share that state file.

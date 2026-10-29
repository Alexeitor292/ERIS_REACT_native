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
| The app's shape | A narrow tool, not the web portal: each person gets the tabs their job needs (`AppTab`) and nothing to browse. My Work for anyone with steps waiting; Report for maintenance reporters; Forms for Staff and Senior Specialists; Notifications and Account for everyone. Records are read on the web |
| Report: report an incident (GPS + Caltrans postmile + photos) and follow one's own reports, read only; a report sent back for more information is answered from My Work | Ported; needs device test. The general incident list and the Expo app's claim/forward/resolve are gone: triage is done in My Work |
| Notifications feed | Ported |
| Forms: the technical forms a person is completing (and any with changes still to send), each opening in the GISA editor | Ported. The GISA PDF export is retired (2026-10-28) and not ported |
| Assessments, from My Work: detail, branch-chief and Staff pickers, submit, review, timeline (the Assessments tab and its worklists are gone) | Ported; needs device test. Picker rules from the web's `personPickerModel.ts` (grouped, disabled branches, time-zone-safe return dates) |
| GISA editor (`mobile/app/(tabs)/submissions/[id].tsx`, ~7,100 lines) | In progress. Core (load, rules, validation, save) and step 1 (Header, district contacts, Location with northing/easting) ported. Step 2: Distribution, Highway Status, Incident Type, Material and Pavement / Ground Status ported. Cracks are their own records (server `submission_gisa_cracks`): each with its photo, the five GISA-001 measures, direction, location and labels drawn on the photo; saved on their own. Vegetation on Slope, Water / Drainage (with the impact table), Water Content and Measurements (road inventory card, elevation profile with chart and manual bearing, the eight measurements) ported: the cross-section diagram (road from the road inventory, ground from the form and elevation profile, slide templates, full screen in landscape) is held to the Expo app's output by parity fixtures. Step 2 is done; Measurements also opens the site in 3D (see Maps). Step 3 (Assessment): the four memos (Observations, Geotechnical assessment, Recommendations, Sketch notes) are edited with the web form's own editor, built into `ERIS/Resources/MemoEditor.html` by `web/scripts/build-memo-ios.mjs` (CI checks it is current), so formatting, tables, figures and citations written on either survive the other; Record of incidents shows the site's history (earlier incidents with their maintenance) above the notes on earlier incidents, for operational roles as on the web. The Sketchpad draws with PencilKit (Apple Pencil or a finger) and files a PNG sketch under the Sketchpad section, ready to place as a figure in Sketch notes. Saving follows the web form's rules for a form several people have open: only changed fields are sent, each with the value it started from; someone else's saves are brought in where you have not typed; a field both changed is yours to choose; memos are locked while someone else writes them. Step 4 (Actions): immediate and follow-up actions from the server's lists (the lanes left open with Open highway traffic), and Notify Coordinator, which saves and sends the immediate actions with a justification; notices already sent stay listed on the step. Sending for review: the last step lists what the server requires (location, Geotechnical Assessment, a photo, soil and debris totals) and leads to each missing item; a form that belongs to an assessment is saved and sent for review on that assessment, as the server requires, and a legacy form without one is submitted, and decided by an administrator, on itself. Step 5 (Gallery): the Submission library lists every file on the form (photos, videos, documents, sketches) with its section, filtered as on the web; photos open with where and which way they were taken, everything else in Quick Look; photos and videos (several at a time) come from the camera or library, and PDFs, CAD and Office files from Files, up to the server's 95 MB each (HEIC becomes JPEG for the web). Files cannot be removed from a form: the server has no way to do so yet. Working offline (`mobile/src/offline`, redesigned for saving with others): the iPhone keeps the last copy of each form opened, the submissions list and the choice lists, so a form opened once opens again without a connection. Every change is kept on the iPhone as it is typed; Save without a connection keeps it to send, and photos, sketches and Gallery files wait on the iPhone too. When ERIS can be reached again (network back, app to the front, every 30 seconds, or Send Now) the changes are sent the way an online save is: caught up with what others saved first, so nothing of theirs is overwritten, and a field both changed waits for this person's choice; a file whose earlier answer was lost is looked for before it is sent again. Unlike the Expo app, a form is not created offline (forms now start from an assessment), and sending for review, notifying the coordinator and adding a crack need a connection. Signing out deletes what the iPhone kept, after a warning if anything is unsent; files are protected while the iPhone is locked and left out of backups. The map editor and Site Photo Map come with the maps phase |
| Section photos: camera recording GPS and the rear camera's true-north direction, photo library (EXIF), filed per form section, photo view with location/direction and typed corrections | Ported (stage 1 of the crack/LiDAR plan); needs a device test, the simulator has no camera or compass. Map view and drag-to-correct come with the ArcGIS Site Photo Map |
| Drafts, offline queue and sync (`mobile/src/offline`) | Ported, redesigned (see the GISA editor row). Incident reports (`incidentQueue.ts`): every report is kept on the iPhone with its photos (as JPEG) before it is sent, so a lost connection never loses one; kept reports are filed when ERIS can be reached, reports first. A report whose answer was lost is looked for (this reporter, the same moment first seen, place and words, in the incident list and in the district maintenance list) before it is filed again, and never filed blind when that check cannot be made. Photo corrections made offline are not queued yet |
| Staying current without refreshing | Ported. One round (`OfflineSync.catchUp`) sends what is waiting, reloads My Work (kept on the iPhone for offline) and keeps the work assigned to the person ready (`AssignedWork`: for each assessment assigned to them in Draft or Revision requested, the assessment, its incident and the incident's photos, every technical form with its site history and photos, and the choice lists; photos of work no longer assigned are dropped). It runs every minute while the app is open, when it comes to the front, when the network returns, when a notice arrives (pushes carry `content-available`, so iOS wakes the app in the background; Apple delivers the latest one once an offline iPhone is back) and in iOS background refresh. Screens follow each round. Kept files are protected until the iPhone is first unlocked after a restart, so work can arrive while it is locked. The ArcGIS offline map comes with the maps phase |
| My Work: one queue, as on the web: coordinator triage (decision, Incident Group, corrections, duplicates), maintenance workflow reviews and decisions (including the reporter answering a request), assessments to route, assign, complete and review, form shares to approve; administrators choose geotechnical, maintenance or both | Ported; needs device test |
| Road inventory (`mobile/src/services/roadInventoryOffline.ts`) | Ported as a tool, not a screen: the published package (road segments and Caltrans postmile reference points) is checked against its SHA-256 and kept on the iPhone, checked daily and downloaded on Wi-Fi (on any network when there is none yet), with its status and Update Now under Account. Report's Use my location and the form header's Use My Location find the post mile from it without a connection, then online; Report can also find a post mile's coordinates and shows the road there (lanes, surface, speed). The Expo app's road inventory browsing screen is not ported. The server serves the package to every account but a read-only viewer, and to a viewer who reports for a district maintenance workflow |
| Maps and offline terrain (ArcGIS Maps SDK for Swift 200.8) | In progress. The API key and license come from ERIS (`/arcgis/runtime-config`), kept for the server's offline window; without a license the SDK shows "Licensed for Developer Use Only", and a 100.x Runtime license (the Expo app's) does not license 200.x. Site areas: the form header's map draws, reshapes and removes the site's areas around its location, stored in `geometry_json` exactly as the web does (`SiteAreas`, ported with its tests). A published offline basemap (`mmpk_url`) is downloaded (on Wi-Fi unless there is none yet) and used when the online one cannot load; with neither, areas are drawn on a plain grid. The Site Photo Map shows where and which way each photo was taken. Offline 3D terrain: the site's ERIS terrain package (USGS 3DEP elevation, hillshade, aerial imagery when packaged, roads) comes to the iPhone with the assigned work, checked (SHA-256, each entry's CRC) and unpacked (`AssignedTerrain`, with the terrain models ported with their tests); a form not assigned can ask for it from Measurements. Measurements opens it in SceneKit, with no network: elevation at true scale, vertical exaggeration 0.5× to 3×, imagery or relief, the site pin, its areas and the roads draped on the ground. Not yet: the road slice, inspection and corridor tools, and removing terrain of work no longer assigned. Not ported: the Mission Center map (browsing) |

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

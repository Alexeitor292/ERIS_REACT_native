# ERIS UX discovery brief - every current screen

Per screen: purpose, who reaches it, what they come to do, every data element the analysts classified as essential / secondary / noise, actions, responsive behaviour, and major pain points. Route paths are the current React Router routes.

## Area: Administration: Users and Road Inventory

### User Administration  -  `/admin/users`
Purpose: Single-page admin console to create ERIS accounts, edit each account's application roles inline, reset passwords, and enable/disable sign-in access.
Roles: ADMIN only. Route is wrapped in RoleRoute roles={["ADMIN"]} (web/src/App.tsx:143-150); sidebar entry 'Administration > Users' is pushed only when isAdmin(roles) (web/src/ui/AppShell.tsx:93-101). Non-admins hitting the URL are redirected to /submissions (web/src/auth/RoleRoute.tsx:18-19); unauthenticated users go to /login (RoleRoute.tsx:15-16).
Primary tasks: Create a new account with an initial password and one or more roles; Find a user and change their roles (Save roles); Reset a user's password or disable/enable their access

Essential data (9): Page title 'User Administration' (AppShell h1); Create form inputs: Email *, Full name *, Initi...; Create form 'Initial roles' chip group (all rol...; Search box (placeholder 'Search name, email, ro...; Error banner / success notice banner; Table column 'User': full name; Table column 'User': email; Table column 'Status': Active/Inactive badge; Table column 'Roles': the user's assigned roles...
Secondary data (8): Count card 'Accounts' + hint 'All ERIS users'; Count card 'Active' + hint 'Can sign in'; Count card 'Inactive' + hint 'Access disabled'; Create form heading 'Create ERIS account' + hel...; Status filter select (All accounts / Active / I...; Table column 'Roles': every UNASSIGNED role opt...; Empty/loading row text ('Loading users…' / 'No ...; Busy label swaps ('Refreshing…', 'Creating…')
Noise (5): Count card 'Administrators' + hint 'ADMIN r... (Hint is a raw role code that merely restates the card label.); Header card 'ERIS access management' + sent... (Restates the page title and lists the buttons already visible below; ...); Table column 'User': 'User #<id>' (Internal database id shown on every row; only justification is that s...); Chip hover title showing the raw role code ... (Hover-only raw enum under a humanized label.); AppShell header: signed-in name + raw role ... (Raw enum strings such as 'ADMIN · GEOTECH_ENGINEER' in the chrome.)

Actions: New account / Close new account (toggle) [ADMIN]; Cancel (top-right of create form) [ADMIN]; Cancel (bottom) and Create account [ADMIN]; Toggle initial role chips [ADMIN]; Search (type-to-filter) [ADMIN]; Status filter [ADMIN]; Refresh [ADMIN]; Toggle role chip (per row) [ADMIN]; Save roles [ADMIN]; Reset password (opens dialog) [ADMIN]; Disable / Enable [ADMIN]; Sidebar navigation links, Collapse/Expa... [ADMIN (nav sections vary by r...]
Entry points: Sidebar 'Administration > Users' (AppShell.tsx:97), rendered only for ADMIN; Direct URL /admin/users (App.tsx:144); unauthenticated -> /login, non-admin -> /submissio...
Layout: Single vertical stack inside AppShell (non-workspace mode): count-card grid, header card, optional inline create form, filter row, banners, full-width table. Below lg the sidebar becomes a nav card stacked ABOVE the con...
Breakpoints used: p-4 md:p-5 (:174, :191), grid grid-cols-2 gap-3 lg:grid-cols-4 (:175), flex-col md:flex-row md:items-center md:justify-between; self-start md:self-auto (:185-187), grid gap-4 md:grid-cols-3 (:193), flex-col md:flex-row md:items-center; md:max-w-xl; md:w-52 (:203-205), flex-1 overflow-auto container around a w-full table with no min-w (:212-213), RoleChoices max-w-3xl when compact (:240), AppShell: lg:hidden stacked nav / hidden lg:block sidebar w-64|w-16; header name hidden md:block; theme select hidden sm:flex (AppShell.tsx:146,157,164-165)
Phone risks:
- Stacked navigation card (AppShell.tsx:164) renders the full section list above the page content on every visit, so the count cards and table start roughly one screen down.
- Table is w-full with 4 columns and no min-width (:213): on ~280px of usable width the Roles chip cloud collapses to one chip per line, giving each row 6+ lines of chips; long emai...
- The three row buttons (Save roles / Reset password / Disable) wrap into a vertical stack via inline-flex flex-wrap (:224); each is ~28px tall (py-1.5 text-xs) and role chips ~24px...
- Create form stacks to one column (fine) but exposes two Cancel buttons plus the header toggle (:187, :192, :199).
- No hover fallback for chip title tooltips (:244) - purely cosmetic loss.
Tablet risks:
- 768-1023px is still below lg, so the nav card stays stacked above content (AppShell.tsx:164) - portrait iPads pay the same scroll cost as phones.
- Table gets ~650-900px: chip cloud wraps to 2-3 lines per row; action buttons wrap to two lines; no column is hidden or collapsed.
- md:grid-cols-3 create form (:193) yields ~200px inputs at 768px - usable but tight for emails.
Pain points (blocker/major):
- [major] Unsaved role edits on any row are silently discarded whenever load() runs - i.e. after saving roles for a different user, toggling Disable/Enable, creating an account, or pressing... - AdminUsersOperationsPage.tsx:49 (draftRoles reset in load), :113, :136, :151 (load() afte...
- [major] Disable is a single click with no confirmation and no client-side guard against disabling your own account or the last administrator. - AdminUsersOperationsPage.tsx:224 (onClick -> setActive), :144-157 (immediate PATCH)
- [major] Every row renders the full role-option chip set as inline editors, so the table is tall and, on phones and tablets, becomes a wall of chips with the actions pushed off to the righ... - AdminUsersOperationsPage.tsx:223, :238-251
Strengths to keep:
- Dirty-checking: 'Save roles' is disabled until the draft differs from the saved roles, preventing no-op saves (:218, :224).
- Client-side guardrails with clear copy: at least one role required for new and existing accounts (:101-103, :123-125); required-field messa...
- Success notices name the affected user ('Updated roles for Jane Doe.') (:111, :135, :150, :165).

### Password Reset Dialog  -  `/admin/users (modal opened from a table row)`
Purpose: Modal that lets an admin set a new password for a chosen user with a confirmation field.
Roles: ADMIN (only reachable from User Administration, App.tsx:146)
Primary tasks: Enter and confirm a new password for the named user

Essential data (5): Title 'Reset password'; Description 'Set a new password for {userName}....; New password input; Confirm password input; Inline error (role=alert)
Secondary data (1): Busy label 'Resetting…'
Noise (0): 

Actions: Close (x) [ADMIN]; Cancel [ADMIN]; Reset password (primary) [ADMIN]; Escape key / backdrop click closes when... [ADMIN]
Entry points: 'Reset password' button on a user row (AdminUsersOperationsPage.tsx:224, :233)
Layout: Centered overlay (fixed inset-0 flex items-center justify-center p-4) with a w-full max-w-lg panel; body scroll locked.
Breakpoints used: max-w-lg panel (PasswordResetDialog.tsx:43), overlay p-4 (ModalDialog.tsx:25), no sm/md/lg classes inside the dialog
Phone risks:
- Panel spans full width minus 32px - fine. Panel has no max-height/overflow-y-auto (ModalDialog.tsx:26), but content is short so it fits even in landscape.
- Footer buttons are 36px tall (py-2 text-sm) - acceptable; the x close is ~30px.
Tablet risks:
- None specific; dialog is 512px wide centered.
Pain points (blocker/major):
- (none)
Strengths to keep:
- Accessible modal: role=dialog, aria-modal, aria-labelledby/aria-describedby, focus trap, Escape, focus restore, backdrop click blocked whil...
- Initial focus lands on the first password input (PasswordResetDialog.tsx:56).
- Error region uses role=alert (PasswordResetDialog.tsx:63).

### Road Inventory Workspace (header, summary, authoritative dataset, dataset versions)  -  `/admin/road-inventory`
Purpose: Admin console for the authoritative road-inventory dataset: see what is published, generate/download the mobile package, and publish or roll back dataset versions (import and lookup panels are embedded and inventoried separately).
Roles: ADMIN only. RoleRoute roles={["ADMIN"]} (web/src/App.tsx:151-158); sidebar 'Administration > Road Inventory' only for admins (web/src/ui/AppShell.tsx:93-101). Non-admins redirected to /submissions (RoleRoute.tsx:19).
Primary tasks: Check which version is authoritative and whether the mobile package is ready; Publish a pending version (or roll back to a superseded one) with confirmation; Generate/regenerate and download the mobile package after a change

Essential data (12): Page title 'Road Inventory' (AppShell h1); Summary card 'Authoritative version' = version_...; Summary card 'Mobile package' = Ready/Not ready...; Error / notice banners; 'Current authoritative dataset' heading + empty...; Metric 'Extract date'; Metric 'Published'; 'Download package' link (new tab); Warning 'Field devices cannot synchronize this ...; Versions table 'Version' tag; Versions table 'Status' badge (pending/publishe...; Versions table 'Actions' (Publish / Rollback / ...
Secondary data (12): h2 'Road inventory operations'; Intro paragraph 'Manage the version ERIS uses.....; Summary card 'Pending versions' count, hint 'Im...; Summary card 'Superseded' count, hint 'Availabl...; Package 'Size'; Package 'Generated' date; 'Dataset versions' heading + sentence 'Only one...; Versions table 'Source file' (truncated max-w-6...; Versions table 'Rows' and 'Skipped'; Versions table 'Extract' and 'Uploaded' dates; Green tint on the published row; Empty state 'No road inventory versions have be...
Noise (6): Eyebrow 'Authoritative roadway reference' (Third title-like line stacked with the h1 and the h2; decorative.); Metric 'Version' (Exact duplicate of the 'Authoritative version' card value.); Metric 'Segments' (Duplicate of the card hint; also labelled 'Rows' elsewhere.); Package card label 'Mobile package' + badge... (Repeats the summary card with different wording ('Not generated' vs '...); Package 'SHA-256' truncated to 16 hex chars... (A truncated hash cannot be used to verify anything and has no copy af...); Versions table 'ID' (#id) (Internal id column; the version tag is the human key.)

Actions: Refresh state [ADMIN]; Generate mobile package / Regenerate pa... [ADMIN]; Download package (opens new tab) [ADMIN]; Publish (pending rows only) [ADMIN]; Rollback (superseded rows only) [ADMIN]; Import and lookup controls [ADMIN]
Entry points: Sidebar 'Administration > Road Inventory' (AppShell.tsx:98), admins only; Direct URL /admin/road-inventory (App.tsx:152); no query params or anchors for the embedd...
Layout: One long vertical stack: header section, 2x2/4-up summary cards, banners, 'Current authoritative dataset' (metrics dl left + package card right at lg), Import panel, Dataset versions table, Lookup panel. Below lg the Ap...
Breakpoints used: p-4 md:p-5 (:122, :123, :146, :183), flex-col md:flex-row md:items-start md:justify-between (:124), grid grid-cols-2 gap-3 lg:grid-cols-4 (:136), flex-col gap-4 lg:flex-row lg:items-start lg:justify-between (:147), dl grid gap-x-8 gap-y-2 sm:grid-cols-2 lg:grid-cols-4 (:155), package card min-w-72 (288px) (:165), max-w-3xl intro (:128), overflow-x-auto wrapper around a 9-column w-full table (:190-191); max-w-64 truncate on Source file (:195), SummaryCard value truncate with title (:213)
Phone risks:
- Package card min-w-72 = 288px exceeds the ~279px available at 375px (375 - 2x16 shell px-4 - 2x16 page p-4 - 2x16 section p-4), so the card spills into the section padding and on ...
- Versions table has 9 columns in overflow-x-auto (:190-196); the Actions column with Publish/Rollback is the rightmost, so the primary controls are off-screen until the user scroll...
- Page height: nav card + six stacked sections (~4-5 screens) with no in-page navigation; the notice for a publish/rollback appears at :144 above the fold while the user is at the v...
- Summary cards 2x2 (fine); SummaryCard values truncate with hover-only title (:213).
- Row buttons ~28px tall (py-1.5 text-xs, :196) - small touch targets.
Tablet risks:
- Below 1024px the nav card is stacked above content (AppShell.tsx:164) and the authoritative section stays stacked (lg:flex-row only, :147): the package card drops under the metric...
- Versions table gets ~650-900px for 9 columns: filenames truncate at max-w-64, dates wrap to two lines, but usually no horizontal scroll until sidebar appears at exactly 1024.
- Summary cards remain 2x2 until lg (:136).
Pain points (blocker/major):
- [major] Page order runs against the workflow: import lives in the middle, the resulting pending version and its Publish button are below it, and the package Generate/Regenerate control th... - RoadInventoryWorkspacePage.tsx:146-179 (package card), :181 (import panel), :183-202 (ver...
- [major] On phones the Publish/Rollback buttons are the 9th column of a horizontally scrolling table with no scroll affordance, hiding the page's primary actions. - RoadInventoryWorkspacePage.tsx:190-196
Strengths to keep:
- Authoritative-state changes are explicit and confirmed through a dialog that names both the target and the version being superseded (RoadIn...
- Action buttons are rendered only when valid for the row status (Publish for pending, Rollback for superseded), and the published row is tin...
- Summary cards carry tone: package readiness turns warn/red when the field package is missing, with a plain-language consequence sentence (:...

### Import Road Inventory panel  -  `/admin/road-inventory (embedded section between the authoritative dataset and the versions table)`
Purpose: Upload an .xlsx road-inventory extract as an import job, watch it progress, and review recent import jobs.
Roles: ADMIN (rendered only inside RoadInventoryWorkspacePage, RoadInventoryWorkspacePage.tsx:181)
Primary tasks: Choose an Excel file, optionally tag it, and start an import; See whether the import succeeded, how many rows were imported/skipped, and that a pending version now exists; Review recent import jobs and failures

Essential data (8): Heading 'Import road inventory' + sentence 'Upl...; File input 'Excel file (.xlsx)' (native, accept...; 'Selected: {name} · {size}'; Error banner (shared by history load and submit); Current job card: status badge (queued/processi...; Success summary '{rows} rows imported; {skipped...; Failure error_message; History 'Status' badge
Secondary data (7): Version tag input (placeholder 'Optional, e.g. ...; Current job card: upload filename; Current job card: message; 'Recent import history' heading + loading/empty...; History 'File' (truncated max-w-60, hover title); History 'Rows'; History 'Created' / 'Finished' datetimes
Noise (3): Current job card: raw 'stage' string in mon... (Backend stage code shown verbatim; no progress percentage.); History 'Job' = first 8 chars of job_uuid (... (Truncated UUID no one types or compares.); History 'Dataset' = raw dataset_version_id (Bare integer with no link to the versions table where the tag lives.)

Actions: Refresh history [ADMIN]; Choose file (native file input) [ADMIN]; Version tag (text) [ADMIN]; Start import (primary; disabled until a... [ADMIN]
Entry points: Scroll within /admin/road-inventory; no anchor or tab (RoadInventoryWorkspacePage.tsx:181)
Layout: Card with header row, a 3-column form (file / tag / button) at md+, selected-file line, error, current-job card, then a 7-column history table in overflow-x-auto.
Breakpoints used: p-4 md:p-5 (:111), flex-wrap header (:112), grid gap-3 md:grid-cols-[minmax(260px,1fr)_220px_auto] md:items-end (:122), file: pseudo-element styling on the native input (:135), flex-wrap current-job header with ml-auto stage (:152), overflow-x-auto history wrapper; max-w-60 truncate on File (:162, :165)
Phone risks:
- Form stacks to one column (good); the native file input's button styling relies on file: pseudo-classes, which iOS Safari renders as a 'Choose File' control of its own height.
- History table (7 columns) scrolls horizontally with no scroll hint; job uuid/filename only expand on hover title (:165).
- Current-job stage text is pushed to the right with ml-auto and wraps under the filename on narrow widths (:152).
Tablet risks:
- At exactly 768px the md grid needs ~614px (260 + 220 + ~110 button + 2x12 gap) inside ~656px of content width - fits but the file input is squeezed to its 260px minimum.
- History table fits ~650-900px with wrapped dates.
Pain points (blocker/major):
- [major] The import succeeds into a pending version but the only pointer to it is 'Dataset #id' text; the admin must scroll down to the versions table and match the id to find the Publish ... - RoadInventoryImportPanel.tsx:154, :165 vs RoadInventoryWorkspacePage.tsx:195-196
Strengths to keep:
- Clear expectation-setting copy that imports stay pending until explicitly published (:115).
- Start import is disabled until a file is chosen; the selected file name and size are echoed back (:142, :147).
- Accept filter restricts the picker to .xlsx (:128); the file input and tag are cleared after submit (:97-99).

### Verify Authoritative Lookup panel  -  `/admin/road-inventory (last embedded section)`
Purpose: Lets an admin test how the published road inventory resolves a county/route/post-mile before field workflows rely on it.
Roles: ADMIN (rendered only inside RoadInventoryWorkspacePage, RoadInventoryWorkspacePage.tsx:204)
Primary tasks: Enter county, route, post mile (and optional district) and confirm a segment resolves; Inspect the matched segment's attributes

Essential data (4): Inputs: County code (placeholder SAC, maxLength...; Validation error 'County, route, and a numeric ...; No-match message 'No matching road segments wer...; Results columns District, County, Route(+suffix...
Secondary data (4): Heading 'Verify authoritative lookup' + explana...; Results column 'PM Prefix'; Results columns Length mi, Left/Right Lanes, Le...; Busy label 'Looking up…'
Noise (0): 

Actions: Run lookup (primary) [ADMIN]
Entry points: Scroll to the bottom of /admin/road-inventory (RoadInventoryWorkspacePage.tsx:204); no an...
Layout: Card with a 5-cell form grid and a 17-column results table in overflow-x-auto.
Breakpoints used: p-4 md:p-5 (:33), grid gap-3 sm:grid-cols-2 lg:grid-cols-[140px_140px_160px_160px_auto] lg:items-end (:39), w-full inputs (:40-43), overflow-x-auto results wrapper; whitespace-nowrap headers; text-xs; max-w-52 truncate on Landmark (:51-54)
Phone risks:
- Results table has 17 columns with nowrap headers (:53) - several screens of horizontal scroll to reach Landmark; the essential columns are first, which mitigates it.
- No scroll affordance on the overflow container; Landmark full text only on hover title (:54).
- Form stacks to one column (fine); inputs 36px tall.
Tablet risks:
- sm-lg: 2-column grid puts the 'Run lookup' button alone in a third row, stretched to half width and not aligned with any input (:39).
- 17-column results still overflow at 768-1024.
Pain points (blocker/major):
- [major] Validation bug: Number('') is 0 and Number.isFinite(0) is true, so leaving Post mile empty passes validation and silently queries PM 0.000 even though the error copy says a numeri... - RoadInventoryLookupPanel.tsx:15-17
Strengths to keep:
- Explicit no-match empty state distinct from errors (:48).
- County code is normalized to upper case client-side (:24); post mile uses a numeric input with 0.001 step (:42).
- Essential columns (District, County, Route, PMs) are ordered first (:53).

### Publish / Rollback Confirmation Dialog  -  `/admin/road-inventory (modal opened from the versions table)`
Purpose: Confirms an authoritative-state change by restating the target version, what will be superseded, and the follow-up package regeneration.
Roles: ADMIN (only reachable from Road Inventory Workspace, RoadInventoryWorkspacePage.tsx:207)
Primary tasks: Confirm or cancel publishing a pending version or rolling back to a superseded one

Essential data (3): Title 'Publish road inventory version' / 'Rollb...; 'Target version' tag; Consequence paragraph naming the target and the...
Secondary data (5): Eyebrow 'Authoritative dataset change'; 'Rows'; 'Current status' (pending/superseded); Reminder 'After this change, regenerate the mob...; Busy label 'Applying…'
Noise (1): 'Dataset ID' #id (Internal id repeated from the table.)

Actions: Close (x) [ADMIN]; Cancel (initial focus) [ADMIN]; Publish version (brand) / Confirm rollb... [ADMIN]; Escape / backdrop click (blocked while ... [ADMIN]
Entry points: 'Publish' or 'Rollback' button in the versions table (RoadInventoryWorkspacePage.tsx:196,...
Layout: Centered overlay with a w-full max-w-xl rounded-2xl panel; 2-column dl at sm+.
Breakpoints used: max-w-xl (:34), dl grid gap-3 sm:grid-cols-2 (:45), overlay p-4 (ModalDialog.tsx:25)
Phone risks:
- Panel is full width minus 32px; dl stacks to one column; total height ~420px fits portrait, may need scroll in landscape but the panel has no overflow-y-auto (ModalDialog.tsx:26).
Tablet risks:
- None specific.
Pain points (blocker/major):
- (none)
Strengths to keep:
- Cancel receives initial focus so Enter cannot accidentally publish/roll back (:70).
- Consequence text names both the target and the version being superseded, and rollback is styled destructive (:53-65, :71).
- Consequence block is the aria-describedby target of the dialog (:31, :53).

## Area: Assessments record view and shared assessment detail panel

### Assessments record view (list rail + toolbar)  -  `/assessments and /assessments/:id (App.tsx:79-94, both render pages/AssessmentsPage.tsx which re-exports features/assessments/AssessmentWorkspacePage.tsx)`
Purpose: Read-only browse of every assessment record with a filterable/searchable rail on the left and the selected assessment's detail on the right; workflow actions are deliberately pushed to My Work.
Roles: Gated by RoleRoute roles={OPERATIONAL_ROLE_NAMES} (App.tsx:82, 90): MAINTENANCE_COORDINATOR / MAINT_COORDINATOR, GEOTECH_OFFICE_CHIEF / OFFICE_CHIEF, GEOTECH_BRANCH_CHIEF / BRANCH_CHIEF, GEOTECH_ENGINEER / FIELD_WORKER, REVIEWER, ADMIN (utils/roleModel.ts:17-25), Maintenance field workers (MAINTENANCE_FIELD_WORKER / MAINTENANCE) are redirected to /submissions (auth/RoleRoute.tsx:19); unauthenticated users to /login (RoleRoute.tsx:15-16), Sidebar entry 'Operations > Assessments' appears only for operational users (ui/AppShell.tsx:87)
Primary tasks: Find a specific assessment (by id, incident, district, office, state, or attached submission descriptor) and open its r...; Check where an assessment is in the pipeline and who it is waiting on; Jump from the assessment to its incident, map, event group, or technical submissions

Essential data (9): State filter select: 'All states' + 7 humanized...; Search input, placeholder 'Search assessments, ...; Error banner (list, detail, or action error tex...; Rail empty/loading text ('Loading assessments…'...; Rail card: 'Assessment #id'; Rail card: 'Incident #id'; Rail card: state badge (mini); Rail card: 'Waiting on {role or Engineer · Name...; Detail placeholder 'No assessment selected.' / ...
Secondary data (6): Count text 'N of M assessments' (toolbar); Read-only orientation banner with 'My Work' link; Rail card: 'Office NORTH' (raw office_code) or ...; Rail card: 'D03' district abbreviation; Rail card: submissions line ('No technical subm...; Page title 'Assessments' (AppShell h1)
Noise (1): Rail header count 'N of M assessments' (Exact duplicate of the toolbar count 12px above it.)

Actions: State filter (select) [All operational roles]; Search (text input) [All operational roles]; Refresh / 'Refreshing…' [All operational roles]; 'My Work' link [All operational roles]; Rail card (Link to /assessments/:id) [All operational roles]
Entry points: Sidebar 'Operations > Assessments' (ui/AppShell.tsx:87; also highlighted while on /submis...; Deep link /assessments/:id from Incidents table 'AS #id' (features/incidents/IncidentsOpe...; Deep link from Event Group detail 'Assessment #id' button (pages/EventGroupDetailPage.tsx...; Deep link from Submission detail body 'assessment #id' (pages/SubmissionDetailPage.tsx:11...; My Work empty state 'Operations › Assessments' (features/myWork/MyWorkPage.tsx:133)
Layout: AppShell (non-workspace mode) -> product-card -> 'grid gap-3.5 p-4 md:p-5'. Toolbar is 'flex flex-wrap'. Body is a two-column grid only at xl: 'grid items-start gap-4 xl:grid-cols-[minmax(320px,0.7fr)_minmax(0,1.8fr)]' ...
Breakpoints used: md: p-5 padding (AssessmentWorkspacePage.tsx:103); AppShell px-6 and user-name block (AppShell.tsx:139, 151), xl: two-column grid rail/detail (AssessmentWorkspacePage.tsx:120), lg (AppShell): sidebar visible, inline nav card hidden (AppShell.tsx:155-156), sm (AppShell): theme select hidden below sm (AppShell.tsx:143), Fixed pixels: max-h-[860px] rail (121), min-w-40 search (109), max-w-[1900px] shell (AppShell.tsx:139)
Phone risks:
- 375px: the full navigation card renders above the content (AppShell.tsx:155), so the toolbar starts roughly one screen down
- Toolbar wraps into 3-4 rows (select, search, count, Refresh) because everything is flex-wrap with no mobile ordering (104-111)
- Rail and detail stack (xl only grid). The rail can be up to 860px tall; tapping a card changes the URL but nothing scrolls the detail into view — the scrollIntoView only targets t...
- Rail cards are Links styled with hover-only border/background changes (AssessmentDetailPanel.tsx:447); on touch the only selected cue is the brand border
- Refresh button ~38px tall is acceptable, but the select uses native styling with 'text-sm' and no min-height
Tablet risks:
- 768-1279px: still single column — the side-by-side record browser never appears on any tablet, even 1024px landscape, because the split is gated at xl (1280px) while the sidebar a...
- At 1024px the sidebar (w-64) plus the stacked 860px rail means the detail pane is far below the fold
- Two nested scroll regions (rail overflow-auto, page scroll) make trackpad/touch scrolling ambiguous
Pain points (blocker/major):
- [major] Submission index is capped at the first 200 submissions (`/submissions/page?limit=200`); assessments whose submissions fall outside it show 'Submission #id' with no descriptor in ... - C:/ERIS-worktrees/eris-design-system/web/src/features/assessments/AssessmentWorkspacePage...
- [major] Two-column browse layout only exists at xl (>=1280px); on phones and all tablets the rail (up to 860px tall) stacks above the detail and selecting a card does not scroll to the de... - AssessmentWorkspacePage.tsx:120-123, 88-94
- [major] List loads up to 1000 assessments in one call with no pagination, sorting, or 'load more'; rail order is whatever the server returns and there is no sort control (e.g., by updated... - AssessmentWorkspacePage.tsx:49-50, 60-69
Strengths to keep:
- Clear IA: record browsing here, actions in My Work, with a targeted CTA deep link (/my-work?assessment=id) when the step belongs to the vie...
- Search covers linked submission descriptors and statuses, not just assessment fields (assessmentModel.ts:142-166), and the model is unit-te...
- Submission summaries are loaded once as an index to avoid N+1 requests, and the page degrades gracefully if that call fails (AssessmentWork...

### Assessment detail panel (shared; record mode at /assessments/:id, work mode in /my-work)  -  `Component, not a route: rendered by AssessmentWorkspacePage.tsx:140 with mode='record' and by features/myWork/MyWorkPage.tsx:181 with mode='work' (route /my-work, ProtectedRoute; My Work self-gates on hasWorkQueue)`
Purpose: Shows one assessment's identity, pipeline position, next step, attached technical submissions, assignments, and history — and in work mode exposes the role-appropriate workflow actions inline.
Roles: Record mode: any operational role (via /assessments RoleRoute), Work mode: operational roles with a queue (MyWorkPage.tsx:117 hasWorkQueue); action visibility per assessmentPermissions (assessmentModel.ts:115-135): delegate = Office Chief/Admin in PENDING_OFFICE_DELEGATION; assignEngineer = Branch Chief/Admin in PENDING_ENGINEER_ASSIGNMENT; submit = assigned engineer/Admin in DRAFT or REVISION_REQUESTED; addSubmission = assigned engineer with GEOTECH_ENGINEER role (or Admin) in engineering step; review = assigned REVIEWER/APPROVER or Admin in SUBMITTED; finalize = Office Chief/Admin in APPROVED; addReviewer = Office Chief/Branch Chief/Admin unless FINALIZED, Role flags derived from utils/roleModel.ts isAdmin, canDelegateBranch, canAssignEngineer, isEngineer (AssessmentDetailPanel.tsx:151-154)
Primary tasks: Understand the assessment's current state, who it is waiting on, and what happens next; Open the attached technical submission(s) to fill out or review them; (Work mode) Perform the step owned by my role: delegate, assign engineer, submit, approve/request revision, finalize, m...

Essential data (19): Eyebrow 'ASSESSMENT #id'; Title 'Incident #id · {incident title}' (fallba...; State badge (full size); Pipeline: 6 steps 'Office delegation, Branch as...; 'Workflow complete. Finalized {timestamp}.' ban...; 'NEXT STEP' eyebrow + 'Waiting on {who}'; Next-step instruction sentence (e.g., 'Assign a...; Record mode: CTA 'This step is yours — act on i...; Work mode: textarea 'Optional workflow notes'; Card title 'Technical submissions (N)'; Empty text 'No technical submission is attached...; Table column 'Submission' descriptor link 'D-Co...; Table column 'Status' — SubmissionStatusBadge w...; Card title 'Assignments' + empty text 'No activ...; Assignment row: full_name; History event: humanized event_type (· humanize...; History event: 'by {actor_name || actor_email |...; History event: timestamp
Secondary data (14): Meta line: office label ('North GeoTech Office'...; Meta line: 'District {district}'; Meta line: 'Updated {Mon D, YYYY, h:mm AM}'; 'Routing override: {reason}' box; Work mode: 'No actions for your role on this st...; Work mode: helper 'At least one submission is r...; Work mode: option labels '{full_name} · {email}...; Card hint 'All GISA forms attached to this asse...; Table column 'ID' (#id); Table columns 'Created' and 'Submitted' timesta...; Table column 'Action' — 'Review' (SUBMITTED) or...; Assignment row: humanized role ('Engineer', 'Re...
Noise (1): Table column 'Reporter' — 'You' or 'User #i... (Raw user id with no name; the Submission type has no reporter name (a...)

Actions: Open incident [All roles (both modes)]; View on map [All roles, only when the inci...]; Event Group #gid [All roles, only when event_gr...]; This step is yours — act on it in My Wo... [Record mode; viewer for whom ...]; Fill out submission #id [Work mode; assigned engineer ...]; Create draft technical submission / Add... [Work mode; assigned engineer ...]; Optional workflow notes (textarea) [Work mode; any actionable role]; Select branch chief… / Assign engineer ... [Work mode; Office Chief or Ad...]; Select engineer… / Assign engineer [Work mode; Branch Chief or Ad...]; Submit for review [Work mode; assigned engineer ...]; Request revision (red text) / Approve a... [Work mode; assigned REVIEWER/...]; Finalize assessment (green) [Work mode; Office Chief or Ad...]
Entry points: Selected via rail card in /assessments/:id (AssessmentWorkspacePage.tsx:125-133, 140); Selected via rail card or ?assessment=:id deep link in /my-work (MyWorkPage.tsx:84-88, 16...
Layout: Vertical stack 'grid gap-3.5' of cards (228): header card, next-step card, submissions card (table body 'overflow-x-auto'), assignments card, history card ('max-h-[420px] overflow-auto'). Header uses 'flex flex-wrap ite...
Breakpoints used: None — the panel contains no sm/md/lg/xl classes; it relies entirely on flex-wrap, overflow-x-auto, and the parent's xl grid, Fixed pixels: min-w-[74px] per pipeline step (91), min-w-3 connectors (105), max-h-[420px] history (390)
Phone risks:
- Pipeline minimum width is ~504px (6 × 74px + 5 × 12px) against ~311px of card width at 375px, so it scrolls horizontally with no scroll hint; 'Finalized' and 'Approval' steps are ...
- Technical submissions table has 7 columns and scrolls horizontally inside its card; the right-aligned 'Action' column (Review/Open) is hidden off-screen (342-343, 336)
- All action buttons use 'px-3 py-1.5 text-xs' (~28px tall) and the Add-reviewer select is 'px-2 py-1 text-xs' — below the 44px touch target guideline (126-129, 370)
- Work mode: Delegate row places two flex-1 selects plus a button in one flex-wrap row; option text '{name} · {email}' overflows native pickers (296-306)
- Header meta line 'Office · District · Updated …' wraps to 2-3 lines; badge drops beneath the title (230-238)
Tablet risks:
- 768px: the 7-column submissions table still overflows (~800px of natural width) so the Action column requires a horizontal scroll
- Pipeline fits from ~600px card width onward, so tablets are fine for it
- Because the parent stacks rail above detail until 1280px, the panel sits below up to 860px of rail on every tablet
Pain points (blocker/major):
- [major] One shared 'Optional workflow notes' textarea feeds six different actions, and destructive/irreversible ones (Request revision, Approve, Finalize, Remove assignment) fire immediat... - C:/ERIS-worktrees/eris-design-system/web/src/features/assessments/AssessmentDetailPanel.t...
- [major] Reviewer comments (the reason for a revision) are buried in the History card's notes box at the bottom of the panel; the 'Next step' card tells the engineer to 'Address the review... - AssessmentDetailPanel.tsx:265, 390-400; assessmentModel.ts:84
- [major] Technical submissions table: 7 columns with a raw 'User #id' Reporter column, a redundant Action column that duplicates the descriptor link, and silent dashes when the submission ... - AssessmentDetailPanel.tsx:342-357; AssessmentWorkspacePage.tsx:19
Strengths to keep:
- Single component serves both record and work modes, so vocabulary, layout, and state logic never drift between browsing and acting (146, 18...
- 'Next step / Waiting on {who}' with a role-specific instruction sentence is a strong coordination pattern, and revision state is visually d...
- Permissions mirror server guards through a pure, unit-tested model (assessmentModel.ts:115-139; assessmentModel.test.ts), and buttons are d...

## Area: Event Groups list/detail plus legacy Projects pages

### Event Groups list  -  `/event-groups`
Purpose: Read-only worklist of Event Groups (shared grouping context across independent incidents) that lets operational staff find a group by title/location and open its record.
Roles: MAINTENANCE_COORDINATOR / MAINT_COORDINATOR, GEOTECH_OFFICE_CHIEF / OFFICE_CHIEF, GEOTECH_BRANCH_CHIEF / BRANCH_CHIEF, GEOTECH_ENGINEER / FIELD_WORKER, REVIEWER, ADMIN, Gate: RoleRoute roles={OPERATIONAL_ROLE_NAMES} (web/src/App.tsx:61-68; web/src/utils/roleModel.ts:17-24). Maintenance field workers are redirected to /submissions (web/src/auth/RoleRoute.tsx:19). Sidebar entry only when isOperationalUser (web/src/ui/AppShell.tsx:85).
Primary tasks: Find a specific Event Group by title, county, route or description; Scan open groups for incident volume and recency to decide where to look next; Open an Event Group record

Essential data (7): Search box (placeholder: Search title, county, ...; Status filter select (Open / Closed / Archived ...; Error banner; Column: Event Group title (link); Column: Location label 'D<district> · <county> ...; Column: Incidents '<count> total · <open_count>...; Column: Last activity (latest_incident_activity...
Secondary data (6): Summary line 'N groups · N incidents · N active'; Refresh button label ('Refresh' / 'Refreshing…'); Sub-line 'Event Group #<id>'; Column: Status badge (Open/Closed/Archived, col...; Empty/loading row text ('Loading Event Groups…'...; AppShell page heading 'Event Groups'
Noise (1): Column: 'Open Event Group' link button (Duplicates the title link in the same row; adds a sixth column that f...)

Actions: Type in search [All operational roles]; Change status filter [All operational roles]; Refresh [All operational roles]; Open Event Group via title link [All operational roles]; Open Event Group via 'Open Event Group'... [All operational roles]
Entry points: Sidebar Operations › Event Groups (web/src/ui/AppShell.tsx:85), operational users only; Legacy redirect /projects → /event-groups (web/src/App.tsx:77); '← Event Groups' back link on the detail page (web/src/pages/EventGroupDetailPage.tsx:77)
Layout: AppShell (sidebar becomes a stacked 'Navigation' card below lg) → single column: flex-wrap toolbar, optional error banner, one 6-column table inside an overflow-x-auto rounded panel.
Breakpoints used: md:p-5 (EventGroupsPage.tsx:63), min-w-[280px] flex-1 on search input (EventGroupsPage.tsx:65), overflow-x-auto on table wrapper, w-full table (EventGroupsPage.tsx:78-79), whitespace-nowrap on status badge (EventGroupsPage.tsx:23), Shell: lg:flex-row sidebar, lg:hidden mobile nav card, md:px-6 (AppShell.tsx:163-165)
Phone risks:
- 375px: the 6-column table cannot fit; the wrapper scrolls horizontally with no sticky first column, so title and Action are never visible together (EventGroupsPage.tsx:78-80).
- Toolbar wraps into 3-4 rows (search full width, then select, summary text, Refresh) pushing the table below the fold (EventGroupsPage.tsx:64-74).
- 'Open Event Group' chip is text-[11px] px-2 py-1 (~22px tall) — well under a 44px touch target (EventGroupsPage.tsx:91).
- Title is a Link styled text-[var(--ink)] with hover-only colour change; on touch there is no visible cue that it is tappable (EventGroupsPage.tsx:86).
- Mobile nav card is rendered above the content, so the user scrolls past the whole navigation list before reaching the toolbar (AppShell.tsx:164).
Tablet risks:
- 768-1024px: sidebar is still the stacked mobile card (lg breakpoint is 1024), consuming ~300px of vertical space above the list (AppShell.tsx:164-165).
- Table generally fits at 768px but title/location cells wrap onto 2-3 lines; row hover highlight is hover-only (EventGroupsPage.tsx:85).
Pain points (blocker/major):
- [major] Hard-coded limit=500 with no pagination, sorting or truncation notice; the summary counts silently describe only the first 500 groups. - web/src/pages/EventGroupsPage.tsx:38,55-59,72
Strengths to keep:
- Single compact table with the same column grammar as Incidents/Assessments; header styling (11px uppercase tracking) consistent across the ...
- Sensible default (OPEN) plus a four-option filter that covers the whole lifecycle including ARCHIVED (EventGroupsPage.tsx:66-71).
- Debounced server search with explicit 'Refreshing…' state and distinct loading vs empty messaging (EventGroupsPage.tsx:49-53,73,83).

### Event Group detail  -  `/event-groups/:id`
Purpose: Read-only record of one Event Group showing its header facts, the incidents grouped under it with cross-links, and the audited group history.
Roles: Same as list: OPERATIONAL_ROLE_NAMES via RoleRoute (web/src/App.tsx:69-76); others redirected to /submissions (web/src/auth/RoleRoute.tsx:19)., No role-conditional UI inside the page — every reaching role sees identical content and links (no edit/close/reopen controls exist).
Primary tasks: Understand what the group is (title, location, status, volume, recency); See which incidents belong to it and their status/stage, then jump to an incident, its assessment/submission, or the Mi...; Review the group's history (who did what, when)

Essential data (12): Page heading = group title (fallback 'Event Gro...; Header: group title + status badge; Header: 'Event Group #<id> · <location label>'; Header dl: Incidents '<count> · <open> active'; Header dl: Last activity <date>; Data integrity alert (incidents without permane...; Error banner / loading text / 'Event Group unav...; Associated Incidents table: '#<id> <title>' lin...; Associated Incidents: 'Missing permanent incide...; Associated Incidents: Location label per incide...; Associated Incidents: Status '<Resolved|In prog...; Associated Incidents: 'Map' chip → /mission-cen...
Secondary data (12): Header dl: Created <date>; Header: description paragraph (if present); Toolbar link labels ('← Event Groups', 'View on...; Associated Incidents: 'Observed <first_observed...; Associated Incidents: 'Assessment #<id>' chip; Associated Incidents: 'Submission #<id>' chips ...; Associated Incidents empty state; History: event type label (title-cased raw even...; History: date · actor name/email; History: 'Incident #<id>' link → Mission Center; History: notes paragraph; History empty state 'No Event Group history rec...
Noise (0): 

Actions: ← Event Groups [All reaching roles]; View on Mission Center map [All reaching roles]; Refresh [All reaching roles]; Open incident (title link) [All reaching roles]; Map chip [All reaching roles]; Assessment #N chip [All reaching roles]; Submission #N chip(s) [All reaching roles]; Incident #N link in history [All reaching roles]
Entry points: Event Groups list row links (EventGroupsPage.tsx:86,91); Incidents operations table 'Event Group #N' link (web/src/features/incidents/IncidentsOpe...; Assessment detail panel 'Event Group #N' button (web/src/features/assessments/AssessmentD...; Mission Center explorer 'Open full Event Group workspace' / 'Open Event Group' (web/src/f...; Legacy deep links /projects/:id → /event-groups/:id (web/src/App.tsx:78,180-183)
Layout: Single column: toolbar → optional banners → header card (flex-wrap title block left, 2-column dl right) → xl two-column grid (incidents table 1.6fr | history 0.8fr, min 320px) that stacks below 1280px.
Breakpoints used: md:p-5 (EventGroupDetailPage.tsx:75), xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,0.8fr)] (EventGroupDetailPage.tsx:107), flex-wrap header with gap-x-8, dl grid-cols-[auto_auto] shrink-0 (EventGroupDetailPage.tsx:87,92), overflow-x-auto incidents table, whitespace-nowrap on Status and Links cells (EventGroupDetailPage.tsx:110,126-127), max-h-[520px] overflow-auto history panel (EventGroupDetailPage.tsx:144), ml-auto Refresh in a flex-wrap toolbar (EventGroupDetailPage.tsx:76-79)
Phone risks:
- 375px: 4-column incidents table with nowrap Status ('In progress · Awaiting Assessment') and nowrap Links cell forces horizontal scroll; the incident title is off-screen while tap...
- Chips are text-[11px] px-2 py-1 (~22px tall) and several can wrap into a cluster; small, adjacent touch targets (EventGroupDetailPage.tsx:129-131).
- Header dl (Incidents/Created/Last activity) wraps under the title as a 2-column grid — works, but 'shrink-0' means a long title block can push it below rather than compress (Event...
- Toolbar: 'View on Mission Center map' is long; with Refresh ml-auto the three buttons wrap into two rows (EventGroupDetailPage.tsx:76-80).
- History panel is a nested scroll region (max-h 520px) inside the page scroll — nested scrolling on touch (EventGroupDetailPage.tsx:144).
Tablet risks:
- 768-1279px: incidents and history stack (xl breakpoint), so the history sits below a potentially long incidents table; no jump link (EventGroupDetailPage.tsx:107).
- Below lg (1024) the sidebar is a stacked card above content, so the record header is ~300px down the page (AppShell.tsx:164).
Pain points (blocker/major):
- [major] Page fetches the entire assessments list (limit 1000) in parallel with the group just to map incident→assessment links; render waits for both, and incidents whose assessment is ou... - web/src/pages/EventGroupDetailPage.tsx:52-57,115-116
- [major] No lifecycle or edit actions on the record (read-only by design per AppShell IA comment); the legacy Project detail had Close/Reopen/Edit, so coordinators lose an obvious place to... - web/src/pages/EventGroupDetailPage.tsx:26,76-80; web/src/ui/AppShell.tsx:64-70; web/src/f...
Strengths to keep:
- Compact single header card with a dl of the three facts that matter (incidents, created, last activity) — denser and calmer than the legacy...
- Data-integrity guard: incidents without a permanent key are flagged at page level (role=alert) and per row, with plain-language explanation...
- Rich, consistent cross-linking to Mission Center, incident, assessment and submission records using one chip style (EventGroupDetailPage.ts...

### Legacy Projects list (unrouted)  -  `none — file web/src/pages/ProjectsPage.tsx is not imported by App.tsx; /projects redirects to /event-groups (web/src/App.tsx:77)`
Purpose: Superseded predecessor of the Event Groups list: a worklist of 'Projects' (operational parent of incidents) with KPI cards, search, status filter and table.
Roles: Unreachable in the running app (dead code)., No internal role gating; if routed it would rely on the wrapping route only.
Primary tasks: Find a Project by title/location; See counts of projects / incidents / active incidents; Open a Project record

Essential data (7): Search box (same placeholder as Event Groups); Status select (Open/Closed/Archived/All Project...; Error banner; Table: Project title (button) + 'Project #<id>'; Table: Location label; Table: Incidents '<count> total · <open> active'; Table: Last activity (toLocaleString)
Secondary data (4): Intro banner 'Project operations' + explanatory...; KPI cards: Projects shown / Incidents in Projec...; Table: StatusBadge; Refresh button
Noise (1): Table: 'Open Project' button (Duplicate of the title button.)

Actions: Refresh [n/a (dead)]; Search / status filter [n/a (dead)]; Open Project (title button, 'Open Proje... [n/a (dead)]
Entry points: None. Not routed; /projects → Navigate to /event-groups (App.tsx:77). No sidebar entry (A...
Layout: h-full flex-col page: intro banner (md:flex-row), 3 KPI cards (md:grid-cols-3), toolbar, then a flex-1 overflow-auto table panel.
Breakpoints used: md:p-5, md:flex-row md:items-center md:justify-between, md:self-auto (ProjectsPage.tsx:61-67), md:grid-cols-3 KPI grid (ProjectsPage.tsx:70), min-w-[280px] flex-1 search (ProjectsPage.tsx:77), flex-1 overflow-auto table wrapper (ProjectsPage.tsx:88)
Phone risks:
- Banner + three stacked KPI cards + wrapped toolbar consume roughly the whole first screen before the table appears (ProjectsPage.tsx:62-84).
- 6-column table scrolls horizontally inside overflow-auto; buttons are px-3 py-1.5 text-xs (~28px tall) (ProjectsPage.tsx:88,115).
- Title is a <button> with text-left — no link semantics, no long-press/open-in-new-tab (ProjectsPage.tsx:106).
Tablet risks:
- KPI cards go to 3 columns at md, which is fine; banner becomes a row with Refresh at the far right, separated from the filters (ProjectsPage.tsx:62-67).
Pain points (blocker/major):
- [major] Dead code: not imported by any routed module while /projects redirects to /event-groups; the file will drift from the live Event Groups page (it already differs in date format, ba... - web/src/App.tsx:77 (redirect); grep shows ProjectsPage referenced only at web/src/pages/P...
- [major] Navigation via <button onClick={navigate}> instead of <Link> — breaks open-in-new-tab, middle-click and link semantics for screen readers. - web/src/pages/ProjectsPage.tsx:106,115
Strengths to keep:
- KPI cards make the three aggregates legible at a glance — a pattern worth carrying into Event Groups instead of the xs inline text (Project...
- Intro banner states the domain concept in one sentence ('Projects are the operational parent of Incidents…'), which the Event Groups page l...

### Legacy Project detail (unrouted)  -  `none — web/src/pages/ProjectDetailPage.tsx is not imported; /projects/:id → LegacyProjectRedirect → /event-groups/:id (web/src/App.tsx:78,180-183)`
Purpose: Superseded record page for a Project: five summary cards, a coordinator management panel, an ArcGIS incident map, an incidents table with classification, and history.
Roles: Unreachable in the running app (dead code)., Internal gating that would apply if routed: ProjectManagementPanel only for canTriage = ADMIN or MAINTENANCE_COORDINATOR (ProjectDetailPage.tsx:108; roleModel.ts:46-48).
Primary tasks: Review a Project's facts and its incidents (with classification provenance); Coordinator: edit title/description, close or reopen the Project; See incidents on a map and in the audited history

Essential data (8): Card 'Project': title, status pill, location, d...; Card 'Incidents': count + '<n> active'; Card 'Latest incident activity': date; ProjectManagementPanel (see separate panel entr...; Incidents table: '#<id> <title>' + 'Observed <d...; Incidents table: Location label; Incidents table: Classification cell (label + '...; Loading / unavailable / error / invalid-id stat...
Secondary data (6): Toolbar: '← Projects', 'Refresh'; Card 'Created': date + 'Project #<id>'; ProjectDetailMap: hybrid basemap, project centr...; Incidents table header + explanatory sentence a...; Incidents table: 'Open in Incidents' button; Project history: event type, date · actor, 'Inc...
Noise (1): Incidents table: Status = raw incident.stat... (Raw backend code shown verbatim; the live page humanises it.)

Actions: ← Projects [n/a (dead)]; Refresh [n/a (dead)]; Edit details / Close Project / Reopen P... [ADMIN, MAINTENANCE_COORDINATO...]; Map pan/zoom, Home, Compass, popups; do... [n/a (dead)]; Open in Incidents [n/a (dead)]
Entry points: None. /projects/:id is intercepted by LegacyProjectRedirect (App.tsx:78,180-183); old boo...
Layout: Stacked: toolbar → 5-card grid (md:grid-cols-2, xl:grid-cols-5 with Project card col-span-2) → management panel → 420px map → xl two-column incidents/history grid.
Breakpoints used: md:p-5 (ProjectDetailPage.tsx:79), md:grid-cols-2 xl:grid-cols-5, xl:col-span-2 (ProjectDetailPage.tsx:93-94), xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,0.8fr)] (ProjectDetailPage.tsx:112), overflow-auto incidents table, max-h-[480px] overflow-auto history (ProjectDetailPage.tsx:115,135), Map: inline style height=420 (ProjectDetailMap.tsx:24,107)
Phone risks:
- ArcGIS MapView at a fixed 420px inside a scrolling page captures touch pan/pinch — a scroll trap occupying half the 812px viewport (ProjectDetailMap.tsx:38-44,107).
- 5-column incidents table (with multi-line Classification cell) scrolls horizontally (ProjectDetailPage.tsx:116-117).
- Five stacked cards + panel push the map and table far down; no summary-first ordering (ProjectDetailPage.tsx:93-106).
Tablet risks:
- md:grid-cols-2 with five cards leaves an orphan card in the third row because col-span-2 applies only at xl (ProjectDetailPage.tsx:93-94).
- Incidents/history stack below 1280px; map at 420px is fine.
Pain points (blocker/major):
- [major] Dead code: page, map and panel are not routed; /projects/:id redirects to the Event Group detail. Any fix here is wasted; any UI it has that the live page lacks (map, lifecycle ac... - web/src/App.tsx:78,180-183; grep: ProjectDetailPage referenced only at web/src/pages/Proj...
- [major] 'Open in Incidents' navigates to the /incidents list rather than /incidents/:id, losing the selected incident. - web/src/pages/ProjectDetailPage.tsx:125
Strengths to keep:
- Inline map with a three-item legend (centroid / active / resolved) and informative popups gives spatial context the live Event Group page o...
- Classification column with provenance copy ('Confirmed from approved assessment' / 'Pending assessment review') explains where the classifi...
- Role-gated management panel is rendered only for coordinators/admins, keeping the record page clean for others (ProjectDetailPage.tsx:108).

### Legacy Project management panel (unrouted)  -  `none — component web/src/features/projects/ProjectManagementPanel.tsx is only mounted by the dead ProjectDetailPage (ProjectDetailPage.tsx:108)`
Purpose: Coordinator/admin panel to edit a Project's title/description and to close or reopen it with an inline confirmation and optional note.
Roles: Would be shown only when canTriage(me.roles): ADMIN or MAINTENANCE_COORDINATOR/MAINT_COORDINATOR (ProjectDetailPage.tsx:108; roleModel.ts:46-48)., Panel copy names 'Maintenance Coordinators and administrators' explicitly (ProjectManagementPanel.tsx:82).
Primary tasks: Edit Project title/description; Close an open Project (blocked while it has active incidents); Reopen a closed Project

Essential data (5): Close-blocked notice: 'This Project still has N...; Archived notice: 'Archived legacy Projects are ...; Error banner / success notice ('Project details...; Edit form: 'Project title *' input, 'Descriptio...; Lifecycle confirmation: heading ('Close this Pr...
Secondary data (1): Heading 'Project management' + role sentence
Noise (1): Disabled-button tooltip on Close Project (Duplicates the inline notice and is unreachable on touch / with disab...)

Actions: Edit details / Cancel edit (toggle) [ADMIN, MAINTENANCE_COORDINATOR]; Close Project [ADMIN, MAINTENANCE_COORDINATOR]; Reopen Project [ADMIN, MAINTENANCE_COORDINATOR]; Cancel / Save Project [ADMIN, MAINTENANCE_COORDINATOR]; Cancel / Confirm closure | Confirm reop... [ADMIN, MAINTENANCE_COORDINATOR]
Entry points: Embedded in the dead ProjectDetailPage only (ProjectDetailPage.tsx:108).
Layout: One card: flex-wrap header (title block left, button group right) → stacked notices → optional edit form (grid gap-3) or lifecycle confirmation (grid gap-3), each with a right-aligned button row.
Breakpoints used: No responsive prefixes; relies on flex-wrap and full-width inputs (ProjectManagementPanel.tsx:79,84,141-152,166-173)
Phone risks:
- Header buttons wrap below the heading — acceptable; primary buttons are px-3/px-4 py-2 (~38px) so touch is OK.
- Tooltip on the disabled Close button is invisible on touch; the inline notice compensates (ProjectManagementPanel.tsx:106,128-132).
Tablet risks:
- None specific; single card scales.
Pain points (blocker/major):
- [major] Dead code (mounted only by the unrouted ProjectDetailPage); the lifecycle UX it implements has no visible counterpart on the live Event Group detail page. - web/src/pages/ProjectDetailPage.tsx:108; web/src/App.tsx:78
Strengths to keep:
- Inline confirmation with a one-sentence consequence for Close and Reopen instead of a modal (ProjectManagementPanel.tsx:159-164).
- Business rule surfaced as UI: Close is disabled and explained when active incidents remain; ARCHIVED is explained rather than silently disa...
- Optional lifecycle note captured with the action, feeding the audited history (ProjectManagementPanel.tsx:166-169).

### Legacy Project association dialog (unmounted)  -  `none — modal component web/src/features/projects/ProjectAssociationDialog.tsx is imported by no file; superseded by web/src/features/eventGroups/EventGroupAssociationDialog.tsx (mounted from web/src/features/incidents/IncidentDecisionDialogs.tsx:73)`
Purpose: Coordinator-review modal that lets a coordinator attach an incident to an existing nearby Project (map + ranked list) or create a new Project, then continue to triage.
Roles: Unreachable (dead)., If mounted: the associate button is rendered only when the server says context.can_change_association; 'Continue to triage' needs an assigned project (ProjectAssociationDialog.tsx:280,305).
Primary tasks: Decide whether the incident belongs to an existing nearby Project or needs a new one; Record the association (with an optional coordinator note); Continue to triage once a Project is assigned

Essential data (12): Error / notice banners; Context card: Reported location; Context card: Current Project (title or 'Not as...; ProjectAssociationMap: reported incident (red d...; Nearby Projects panel: heading, subtitle 'Open ...; Nearby Project card: title, location, distance ...; Mode toggle 'Existing Project' / 'Create new'; Selected Project summary (title, location, desc...; Create form: 'Project title *' (prefilled 'Rout...; Primary button label: 'Create Project and assoc...; Footer sentence: 'Incident belongs to <title>.'...; Loading / unavailable text
Secondary data (3): Eyebrow 'Coordinator review', h2 'Choose the Pr...; Nearby empty state 'No open Projects were found...; 'Coordinator note' textarea (placeholder 'Why t...
Noise (2): Context card: Coordinates to 6 decimals (Sub-10cm precision lat/long is not actionable for a coordinator; the ...); Context card: Classification 'Unclassified'... (Hard-coded static text, identical for every incident.)

Actions: Close (header) [Any viewer]; Change search radius [Any viewer]; Select Project (list card or map click) [Any viewer]; Existing Project / Create new toggle [Any viewer]; Edit title / description / coordinator ... [Any viewer]; Associate with selected Project / Creat... [Only when context.can_change_...]; Close (footer) [Any viewer]; Continue to triage [Any viewer]
Entry points: None — no component imports ProjectAssociationDialog (grep). The live equivalent is Event...
Layout: Full-screen overlay (fixed inset-0, p-3 md:p-6) containing a max-w-[1500px], max-h-[94vh] flex-col panel: header, scrollable body (xl two-column: context cards + map | nearby list + decision card), sticky footer.
Breakpoints used: p-3 md:p-6 overlay padding (ProjectAssociationDialog.tsx:135), max-h-[94vh] max-w-[1500px] (ProjectAssociationDialog.tsx:136), xl:grid-cols-[minmax(0,1.7fr)_minmax(360px,0.8fr)] (ProjectAssociationDialog.tsx:155), md:grid-cols-4 context cards (ProjectAssociationDialog.tsx:157), max-h-72 overflow-auto nearby list (ProjectAssociationDialog.tsx:212), grid-cols-2 mode toggle (ProjectAssociationDialog.tsx:245), Map inline height 520px (ProjectAssociationMap.tsx:28,196)
Phone risks:
- 375x812: the 520px ArcGIS map fills ~65% of the viewport inside a 94vh scroll region; touch pans the map instead of the dialog — a scroll trap between the context cards and the de...
- Order on a single column is header → 4 stacked context cards → map → nearby list (own 288px scroll) → decision card; the primary button is 3-4 screens down (ProjectAssociationDial...
- Two 'Close' buttons plus 'Continue to triage' in the footer; footer stays visible (good) but header Close is redundant (ProjectAssociationDialog.tsx:145,301).
- Nested scroll regions: dialog body, nearby list, map — three competing gesture targets.
Tablet risks:
- 768-1279px: still single column (xl breakpoint), so map and list are stacked; 4 context cards fit at md (ProjectAssociationDialog.tsx:155,157).
- 1024px landscape: dialog is 1024-48px wide but still stacked; a lot of vertical scrolling for the decision card.
Pain points (blocker/major):
- [major] Dead code: never mounted; the live EventGroupAssociationDialog duplicates this flow for Event Groups, so two ~300-line association dialogs and two ArcGIS map components coexist. - grep: ProjectAssociationDialog only defined at web/src/features/projects/ProjectAssociati...
- [major] Modal accessibility: no focus trap, no autofocus, no Escape-to-close; background remains tabbable. - web/src/features/projects/ProjectAssociationDialog.tsx:135-136
- [major] Fixed 520px map height regardless of viewport; on phones the map alone exceeds 60% of the screen. - web/src/features/projects/ProjectAssociationMap.tsx:28,196
Strengths to keep:
- Map + ranked list with distance and incident counts gives the coordinator two coordinated ways to pick a Project; selection syncs both (Pro...
- Primary button label changes with state ('Project already assigned', 'Create Project and associate'), and it is disabled when nothing would...
- Sensible auto-mode: existing Project preselected, first nearby preselected, or Create new when nothing is nearby (ProjectAssociationDialog....

## Area: Incidents record view, new-incident intake panel, workflow tree

### Incidents record view (Incident records / Awaiting intake tabs)  -  `/incidents and /incidents/:id (deep link highlights + scrolls to a row) - web/src/App.tsx:45-60; page alias web/src/pages/IncidentsPage.tsx:1 re-exports web/src/features/incidents/IncidentsOperationsPage.tsx`
Purpose: Read-only, tabbed table of every incident in ERIS, split into coordinator-accepted records and field reports still awaiting coordinator intake, with links out to the Event Group, map, assessment and submissions.
Roles: All authenticated roles (ProtectedRoute only, App.tsx:48,56): MAINTENANCE_FIELD_WORKER/MAINTENANCE, MAINTENANCE_COORDINATOR/MAINT_COORDINATOR, GEOTECH_OFFICE_CHIEF/OFFICE_CHIEF, GEOTECH_BRANCH_CHIEF/BRANCH_CHIEF, GEOTECH_ENGINEER/FIELD_WORKER, REVIEWER, ADMIN, Nav item 'Operations > Incidents' shown to every role (web/src/ui/AppShell.tsx:86), Default landing page for roles without a work queue, i.e. maintenance-only reporters (App.tsx:174-178, roleModel.ts:71-73), Assessment / Submission column data is fetched only for operational roles via isOperationalUser (IncidentsOperationsPage.tsx:59,85; roleModel.ts:17-25,36-38)
Primary tasks: Look up an incident by id, title or location and read its current status, assignee and assessment state; Arrive by deep link from My Work / Assessments / Mission Center / Event Group and jump onward to the Event Group, map, ...; (Reporters) check whether a filed field report is still awaiting intake or has been accepted into the record

Essential data (13): Tab labels with live counts: 'Incident records ...; Error banner (load failure or create-form valid...; Success notice after filing ('Incident reported...; Incident title; Classification label (type codes joined by ' · ...; 'Event Group #id' link; Location label 'D7 · County · R001 · PM 12.30' ...; 'View on map' link to /mission-center/:gid/:iid; Status badge New / In progress / Resolved; Assignment: assignee name, else email, else 'Un...; 'AS #id' link + AssessmentStateBadge (mini); Deep-linked row highlight (brand tint + inset l...; Empty state 'No incidents match the current fil...
Secondary data (7): Result count 'X of Y incidents'; Explanatory banner (intake: 'These field report...; ID column '#id'; Classification state line 'Pending assessment r...; Coordinates 'lat, lon' at 6 decimals; 'Sub #id' links to /submissions/:id; AppShell chrome: product name, 'Caltrans | Geot...
Noise (2): 'Loading classification…' placeholder (Classifications load in the same Promise.all as items, so this text p...); 'No assessment' text (Always shown for non-operational users (assessments never fetched, li...)

Actions: Tab 'Incident records' / 'Awaiting inta... [All roles]; Search input (placeholder 'Search title... [All roles]; Status filter select (All / New / In pr... [All roles]; 'Unclaimed only' checkbox [All roles]; 'New incident' / 'Close report' toggle [canReportIncident: ADMIN, MAI...]; 'Refresh' / 'Refreshing…' [All roles]; 'My Work' inline link inside banners [All roles see it; only hasWor...]; Row link 'Event Group #id' [All roles when event_group_id...]; Row link 'View on map' [All roles when event_group_id...]; Row link 'AS #id' [Operational roles only]; Row links 'Sub #id' [All roles when submission ids...]; No row click / no per-incident open, cl... [n/a]
Entry points: Sidebar 'Operations > Incidents' for every role (ui/AppShell.tsx:86); Home redirect '/' -> /incidents for roles without a work queue (App.tsx:174-178); My Work triage item 'Open incident record' -> /incidents/:id (features/myWork/TriageWorkI...; Assessment detail 'Open incident' -> /incidents/:id (features/assessments/AssessmentDetai...; Mission Center explorer 'Open in Incidents' -> /incidents/:id (features/missionCenter/Mis...
Layout: Single column: AppShell (sticky header; sidebar only at lg+, inline nav card below lg) -> page 'grid gap-4 p-4 md:p-5' -> wrapping toolbar ('flex flex-wrap') -> optional create panel -> banner -> 'overflow-x-auto' card ...
Breakpoints used: md:p-5 page padding (IncidentsOperationsPage.tsx:219), Toolbar flex-wrap with min-w-[220px] flex-1 search and ml-auto button group (220,225,237), overflow-x-auto table wrapper, w-full table (274-275), whitespace-nowrap on tab buttons and status badges (28,211), AppShell: lg:flex-row layout, 'aside lg:hidden' inline nav, 'hidden lg:block' sidebar w-64/w-16, md:px-6, 'hidden sm:flex' theme select, 'hidden md:block' user identity (ui/AppShell.tsx:138-185)
Phone risks:
- Below lg the full navigation card renders inline above the content, so a 375px user scrolls past up to ~10 nav items before reaching the tabs (ui/AppShell.tsx:164)
- Toolbar wraps into 4-5 rows: nowrap tab pair (~300px), search on its own row, select + checkbox + count, then the New incident / Refresh group (220-244)
- Six-column table has no min-width or column hiding: columns compress and coordinates/location labels wrap into narrow stacks, or content forces horizontal scrolling inside overflo...
- Links are colour-only ('text-[var(--brand)] hover:underline'); on touch there is no hover so nothing marks them as links (304,309,315,318)
- Touch targets: tab buttons, select and inputs are ~36-38px tall (py-2 text-sm); native checkbox is ~13px; AS#/Sub# links are 11-12px text (225-243,315-318)
Tablet risks:
- 768-1024px still uses the inline nav card (lg breakpoint is 1024), so tablet portrait pays the same nav-scroll cost (ui/AppShell.tsx:164-165)
- Six columns fit but Incident and Location cells wrap 3-4 lines each ('Unclassified · assessment not started' under the title, coordinates + label + map link)
- Toolbar wraps to two rows and the ml-auto button group jumps to the second line
Pain points (blocker/major):
- [major] The 'record view' never shows the record: description, first_observed_at, first_occurred_at, current_stage, office_code, incident_key, reporter, created_at, resolved_at and resolu... - IncidentsOperationsPage.tsx:274-326 vs api/types.ts:243-277; TriageWorkItem.tsx:63
- [major] 'Event Group #id' link sends maintenance-only reporters to a RoleRoute-gated page that bounces them to /submissions, a page with no nav entry for their role - IncidentsOperationsPage.tsx:304; App.tsx:69-76; auth/RoleRoute.tsx:19; ui/AppShell.tsx:83...
- [major] 'No assessment' is shown to non-operational users even when an assessment exists, because assessments are only fetched for operational roles - IncidentsOperationsPage.tsx:85,314-316
Strengths to keep:
- Clear conceptual split between accepted records and awaiting-intake reports, documented in code and echoed in tab labels and banners (Incid...
- Deep link /incidents/:id auto-selects the right tab, scrolls and highlights the row (IncidentsOperationsPage.tsx:102-112,298)
- Instant client-side search across id, title, description, district, county, route and post mile (IncidentsOperationsPage.tsx:116-130)

### New incident intake panel (IncidentCreatePanel)  -  `/incidents (inline section toggled by the toolbar 'New incident' button; no route of its own such as /incidents/new) - IncidentsOperationsPage.tsx:238-259; web/src/features/incidents/IncidentCreatePanel.tsx`
Purpose: Lets a reporting role file a field report (title, when, where, supporting files) that enters the 'Awaiting intake' queue for Maintenance Coordinator review.
Roles: canReportIncident only: ADMIN, MAINTENANCE_FIELD_WORKER (+MAINTENANCE alias), GEOTECH_ENGINEER (+FIELD_WORKER alias) (utils/roleModel.ts:76-78), Coordinators, office/branch chiefs and reviewers never see the 'New incident' button (IncidentsOperationsPage.tsx:238)
Primary tasks: File a new incident with a title, first-observed time and coordinates; Attach photos, videos, PDFs or CAD as supporting evidence at filing time

Essential data (4): Field labels: Title*, Description, First observ...; Pending file rows: file name (truncated), infer...; Button state 'Creating…'; Validation messages ('Incident title is require...
Secondary data (3): Heading 'Create incident' + helper paragraph ab...; Supporting files label + helper 'Add photos, vi...; Blur-normalised values: coordinates to 6 dp, ro...
Noise (2): 'Classification: Unclassified · assigned af... (Repeats the paragraph immediately above it); Hidden form field incident_type (Exists in IncidentCreateForm/EMPTY_INCIDENT_FORM but is never rendere...)

Actions: 'Cancel' (header) [canReportIncident roles]; 'Cancel' (footer) [canReportIncident roles]; 'Create incident' / 'Creating…' [canReportIncident roles]; Native file chooser (multiple) [canReportIncident roles]; 'Remove' per pending file [canReportIncident roles]; 'New incident' / 'Close report' toolbar... [canReportIncident roles]
Entry points: Toolbar 'New incident' button on /incidents (IncidentsOperationsPage.tsx:238-242); No deep link (no /incidents/new route in App.tsx), so My Work, Mission Center and mobile ...
Layout: Section card 'p-4 md:p-5'; header 'flex flex-wrap items-start justify-between'; fields 'grid gap-4 md:grid-cols-2 xl:grid-cols-3' with Description spanning two columns at xl and a 'hidden xl:block' spacer keeping Latitu...
Breakpoints used: md:p-5 (IncidentCreatePanel.tsx:45), md:grid-cols-2 xl:grid-cols-3 (67), md:col-span-1 xl:col-span-2 on Description (71), hidden xl:block spacer cell (82), min-h-20 w-full textarea (73), min-w-0 + truncate on file names (149-150), Header flex-wrap so Cancel drops under the title on narrow widths (46)
Phone risks:
- Single column of 10 fields plus the files block is roughly 2.5 screens tall; the Create button sits at the bottom and validation errors render in the page banner below the panel, ...
- No geolocation or map pick: a field worker on a phone types six-decimal latitude/longitude by hand; California longitudes are negative and type=number keypads often hide the minus...
- datetime-local twice on a phone is fine natively, but there is no 'now' shortcut for First observed (76-78)
- Native file input with no capture attribute means no direct camera shortcut; no thumbnails for chosen photos (131-138)
- 'Remove' buttons are ~26px tall, below the 44px touch minimum (157)
Tablet risks:
- md 2-column grid pairs Title with Description; the min-h-20 textarea makes row one uneven and pushes the required First observed field below the fold on 768px landscape (67-78)
- datetime-local inputs are wide on iPadOS and can exceed a 2-column cell at 768px because inputClass sets no width constraints (18,76-81)
Pain points (blocker/major):
- [major] Coordinates must be hand-typed; no 'use my location' (navigator.geolocation) and no map picker even though Mission Center already hosts an ArcGIS map - IncidentCreatePanel.tsx:83-104
- [major] Validation is imperative and page-level: no required/aria-invalid attributes, no field-level messages, errors surface in the shared page banner outside the panel - IncidentsOperationsPage.tsx:163-167,271; IncidentCreatePanel.tsx:68-126
- [major] Attachment failures cannot be retried: the incident is created, the panel resets, the notice truncates to two failures, and this page has no attachments UI to add the files afterw... - IncidentsOperationsPage.tsx:139-144,188-196
Strengths to keep:
- Every field is an implicit <label> wrapper, giving accessible names for free (IncidentCreatePanel.tsx:20-28)
- Blur normalisation of route, post mile and coordinates enforces ERIS precision rules at entry (IncidentCreatePanel.tsx:91,102,116,124; util...
- Attachment kind is inferred client-side so the user does not pick a type per file (incidentUiModel.ts:38-48)

### Workflow tree modal (WorkflowTreeModal / WorkflowTreeView) - unmounted  -  `None. Exported from web/src/components/WorkflowTree.tsx:77,110 but no page or feature imports it (grep across web/src finds only self-references); the API client getWorkflowTree -> GET /incidents/:id/workflow-tree (web/src/api/workflowTree.ts:71-73) is likewise unused by the web app.`
Purpose: Intended to visualise an incident's review chain (coordinator, office chief, branch chief, engineer, ...) as a row of status cards showing the current owner, path type and per-step details.
Roles: Unreachable by any role today (dead code), The component itself has no role gate; if mounted it would depend solely on the backend endpoint's authorisation
Primary tasks: See where an incident sits in the workflow and who currently owns it; Inspect a completed step's notes, timestamp and actor

Essential data (6): Modal title 'Incident #id — Workflow'; Overall status pill (glyph + label, e.g. '► Cur...; 'Path: Awaiting triage / Assessment required / ...; 'Current owner: Role — Name' | 'Role — Unassign...; Per-node card: status glyph on coloured dot, RO...; 'Loading workflow…' text and role=alert error b...
Secondary data (2): Linked / duplicate banner '→ incident #n → loca...; Node details: actor email, notes, 'Linked incid...
Noise (2): 'Assessment: <raw state code> · Office <cod... (Raw state such as PENDING_OFFICE_DELEGATION is shown verbatim even th...); WorkflowNode.disposition (Typed in the API client but never rendered)

Actions: 'Close' [n/a (unmounted); would be any...]; Escape key / backdrop mousedown [n/a]; Node card body button toggles 'Details'... [n/a]
Entry points: None - no page renders WorkflowTreeModal or WorkflowTreeView
Layout: ModalDialog overlay 'fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/50 p-4'; panel 'mt-10 w-full max-w-[1400px] p-4'; summary bar 'flex flex-wrap gap-3'; nodes 'flex flex-col gap-2 xl:flex-row...
Breakpoints used: xl:flex-row xl:flex-wrap xl:items-stretch on the node list and each node wrapper (WorkflowTree.tsx:98,100), xl:hidden ↓ / hidden xl:inline → connector glyphs, xl:px-1 (74), min-w-[180px] flex-1 node cards (49), max-w-[1400px] w-full panel, mt-10 (128), flex-wrap summary bar with ml-auto assessment chip (82,89)
Phone risks:
- Vertical stack of 4-6 cards plus connectors exceeds a 375x667 viewport; the overlay scrolls but body scroll is locked so the incident context behind is hidden (WorkflowTree.tsx:98...
- 'Close' is px-3 py-1 text-sm, roughly 30px tall (132)
- Summary bar wraps to 3-4 lines and the ml-auto assessment chip drops to its own line (82-90)
- mt-10 plus p-4 overlay padding wastes ~56px of vertical space before the title (127-128)
Tablet risks:
- Below xl (1280px) the tree stays a vertical list even on 1024px landscape tablets where four or five 180px cards would fit side by side (74,98)
- Current-node ring uses a fixed rgba(31,94,255,0.25) shadow that ignores the theme (49)
Pain points (blocker/major):
- [major] Component and API client are dead code: never mounted, so users have no workflow visualisation anywhere on the incident record - components/WorkflowTree.tsx:77,110 and api/workflowTree.ts:71 have no importers; Incident...
- [major] Hard-coded Tailwind palette tuned for a dark background (text-emerald-300, text-sky-200, text-amber-200, text-red-200/300, bg-slate-500/600, text-black on dots) breaks contrast on... - WorkflowTree.tsx:12-19,52,93,134; ui/AppShell.tsx:125-129
Strengths to keep:
- ModalDialog supplies focus trap, Escape, backdrop close, focus restore and role=dialog/aria-modal/aria-labelledby (ui/ModalDialog.tsx:43-12...
- Workflow status and path codes are mapped to plain-English labels in one place (WorkflowTree.tsx:11-28)
- Current-owner card ring is a clear 'you are here' cue (WorkflowTree.tsx:49,101)

## Area: Mission Center GIS explorer (statewide Event Groups -> incidents -> evidence). Source of truth: web/src/features/missionCenter/MissionCenterProjectExplorer.tsx (page + aside), web/src/features/missionCenter/MissionCenterProjectGisMap.tsx (ArcGIS map + legend), web/src/features/missionCenter/missionCenterGisModel.ts (types/helpers), web/src/components/mapTheme.ts (basemap), web/src/components/MissionCenterMap.tsx (unrouted legacy). All paths relative to C:\ERIS-worktrees\eris-design-system. Routes are registered in web/src/App.tsx:95-118 via web/src/pages/MissionCenterPage.tsx (a bare re-export). Role gate is in-component (isOperationalUser, MissionCenterProjectExplorer.tsx:225) and server-side (backend/app/routes/mission_center_event_groups.py:20 require_roles(OPERATIONAL_ROLES)).

### Statewide Event Groups (PROJECTS mode)  -  `/mission-center`
Purpose: Show every California Event Group as a marker on one map with a searchable/filterable card list so an operational user can find and open the group they care about.
Roles: MAINTENANCE_COORDINATOR / MAINT_COORDINATOR, GEOTECH_OFFICE_CHIEF / OFFICE_CHIEF, GEOTECH_BRANCH_CHIEF / BRANCH_CHIEF, GEOTECH_ENGINEER / FIELD_WORKER, REVIEWER, ADMIN, (route itself is only ProtectedRoute at web/src/App.tsx:95-102; gating is isOperationalUser at web/src/features/missionCenter/MissionCenterProjectExplorer.tsx:225 using web/src/utils/roleModel.ts:17-38; nav entry only for operational users at web/src/ui/AppShell.tsx:84)
Primary tasks: Locate an Event Group geographically (by district/county/route or by scanning the map) and drill into it; Get a statewide pulse: how many groups are open and how many incidents are active; Filter groups by status (Open/Closed/Archived) and by free-text search

Essential data (7): Search box (placeholder 'Search Event Groups — ...; Status select: All statuses / Open / Closed / A...; Event Group map markers (circle; blue Open, sla...; Group card: title; Group card: StatusPill Open/Closed/Archived (go...; Group card: 'Event Group #{id} · D{district} · ...; Group card: '{n} associated Incident(s) · {m} a...
Secondary data (7): Summary strip '{n} Event Groups · {n} open · {n...; 'Updated {date time}' / 'Not refreshed yet'; Map legend footer: blue dot 'Event Group' + 'Ma...; ArcGIS widgets: Home, Compass (top-left), Scale...; Aside header 'Event Groups' + '{n} shown on map'; Empty/loading states: 'Loading Event Groups…' /...; Error banner (role=alert) e.g. 'Failed to load ...
Noise (1): Marker popup 'Event Group #{id} · {title}' ... (Click navigates immediately (hitTest -> onSelectProject), so the popu...)

Actions: Type in search [All operational roles]; Status select [All operational roles]; Refresh [All operational roles]; Click an Event Group card [All operational roles]; Click an Event Group marker [All operational roles]; Home / Compass / Search map / Basemaps ... [All operational roles]
Entry points: Sidebar nav 'Mission Center' under Operations (web/src/ui/AppShell.tsx:84, operational us...; Breadcrumb link 'California Event Groups' and '← All California Event Groups' button from...; NotFoundPage primary button sends signed-in users to /mission-center (web/src/pages/NotFo...
Layout: AppShell (px-4 md:px-6; sidebar only at lg, otherwise a 'Navigation' card stacked above the content) > page 'grid gap-4 p-4 md:p-5' > toolbar (flex-wrap) > 'grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(340p...
Breakpoints used: md:p-5 (MissionCenterProjectExplorer.tsx:239), xl:grid-cols-[minmax(0,2fr)_minmax(340px,0.8fr)] (MissionCenterProjectExplorer.tsx:271), AppShell: sm:flex (theme select), md:block (user name), md:px-6, lg:flex-row / lg:hidden / lg:block (sidebar) (web/src/ui/AppShell.tsx:140-165), No sm/lg/2xl, no overflow-x-auto, no min-w in the Mission Center files; MissionCenterProjectGisMap.tsx uses no breakpoints at all
Phone risks:
- 375 px: content width is ~309 px (shell px-4 + page p-4 + card border). The search/select grid has flex-basis 340 px and grid-cols-[minmax(220px,1fr)_auto]; 220 px input floor + ~...
- The 'Navigation' card for <lg renders above the page content (web/src/ui/AppShell.tsx:164), so ~10 nav links push the toolbar and map below the first screen.
- Map min height is 540 px (clamp floor) regardless of viewport (MissionCenterProjectExplorer.tsx:283); on an 812 px-tall phone the Event Group list is a full screen below the map a...
- Aside has its own max-h-[760px] scroll region inside the page scroll (MissionCenterProjectExplorer.tsx:286) — nested scrolling on touch.
- Refresh button is px-2.5 py-1.5 text-xs (~28 px tall) — under the 44 px touch target guideline (MissionCenterProjectExplorer.tsx:255).
Tablet risks:
- 768–1024 px is still below xl, so the map and the aside stack; on a 1024×768 landscape tablet calc(100vh-320px)=448 px which clamps up to 540 px, so the map takes the whole viewpo...
- The aside's max-h-[760px] is taller than a landscape tablet viewport; the list scroll region and page scroll compete.
- At 768 px the toolbar fits (search grid 340 px + summary text wraps under it).
Pain points (blocker/major):
- [major] Every 60 s auto-refresh (and every search keystroke / status change) creates a new projects array, which re-runs the marker effect and calls view.goTo(CALIFORNIA_EXTENT), snapping... - MissionCenterProjectExplorer.tsx:148, 157-161, 203-207 (new array identity) -> MissionCen...
- [major] Marker popup content is dead: clicking a marker navigates in the same click handler, so 'Click the marker to inspect this Event Group.' and the popup fields are never read; on tou... - MissionCenterProjectGisMap.tsx:196-205 (navigate on click), 255-258 (popup template)
- [major] Search/status toolbar overflows horizontally on a 375 px phone because of the 220 px minmax floor plus an auto-width select inside a 340 px flex basis. - MissionCenterProjectExplorer.tsx:242-244
- [major] Map is forced to ≥540 px tall and sits above the card list, so on phones/tablets the accessible fallback list (the only keyboard-reachable navigation) is a full screen below the f... - MissionCenterProjectExplorer.tsx:271, 283, 286; web/src/ui/AppShell.tsx:164
Strengths to keep:
- Deep-linkable, route-driven state: mode is derived purely from URL params so browser back/forward and shared links work (MissionCenterProje...
- Cursor pagination follows has_more/next_cursor with a guard against a non-advancing cursor, so the statewide view is never silently capped ...
- Cards and markers are two synchronized entry points to the same navigation, giving keyboard/screen-reader users a non-map path (MissionCent...

### Event Group drill-down (PROJECT mode)  -  `/mission-center/:gid`
Purpose: Zoom the map to one Event Group's incidents and list them with status and classification so the user can pick the incident whose GIS evidence they need.
Roles: Same operational set as /mission-center (MAINTENANCE_COORDINATOR, GEOTECH_OFFICE_CHIEF, GEOTECH_BRANCH_CHIEF, GEOTECH_ENGINEER, REVIEWER, ADMIN and their legacy aliases) — route is ProtectedRoute at web/src/App.tsx:103-110, gate at MissionCenterProjectExplorer.tsx:225
Primary tasks: See where a group's incidents sit relative to each other and which are still active; Pick an incident to inspect its GIS evidence; Jump to the full Event Group workspace (/event-groups/:id) for history and assessments

Essential data (9): Breadcrumb 'California Event Groups › {group ti...; Event Group title; Pills: status (Open/Closed/Archived), '{n} inci...; 'Open full Event Group workspace' link; Incident card: '#{id} {title or 'Incident'}'; Incident card: StatusPill New / In progress / R...; Incident card: location label (D/county/R/PM); Incident card: classification label (e.g. 'Land...; Map: incident markers (diamond red NEW, diamond...
Secondary data (6): 'Event Group #{id} · {location label}'; Group description (when present); Section label 'Associated Incidents'; Map legend: red diamond 'Active Incident', grey...; Loading / empty states: 'Loading associated Inc...; 'Incident #{iid} is not part of this Event Grou...
Noise (3): '← All California Event Groups' button (Duplicates the breadcrumb link two rows above it; 11 px text, ~22 px ...); Eyebrow 'Selected Event Group' (Redundant label; the breadcrumb and title already say what this is.); Incident marker popup 'Incident #{id} · {ti... (Same dead-popup problem as the statewide level: click navigates immed...)

Actions: Breadcrumb 'California Event Groups' [All operational roles]; '← All California Event Groups' [All operational roles]; 'Open full Event Group workspace' [All operational roles]; Click an incident card [All operational roles]; Click an incident marker [All operational roles]; ArcGIS Home / Compass / Search / Basema... [All operational roles]
Entry points: Card/marker click from /mission-center; 'View on Mission Center map' on Event Group detail (web/src/pages/EventGroupDetailPage.ts...; Breadcrumb group-title link and '← Event Group Incidents' from the incident level (Missio...; Direct URL
Layout: Identical shell to the statewide mode: breadcrumb bar (flex-wrap) replaces the search toolbar; map card then aside, side by side only at xl.
Breakpoints used: md:p-5 (MissionCenterProjectExplorer.tsx:239), xl:grid-cols-[minmax(0,2fr)_minmax(340px,0.8fr)] (MissionCenterProjectExplorer.tsx:271)
Phone risks:
- Long group titles wrap in the breadcrumb, pushing the ml-auto location label to a third line (MissionCenterProjectExplorer.tsx:259-265).
- Aside header stacks back button + eyebrow + title + id/location + three pills + description + full-width link (≈260 px) before the incident list begins, all below a ≥540 px map (M...
- Back button is text-[11px] px-2 py-1 (~22 px tall) — well under the 44 px touch target (MissionCenterProjectExplorer.tsx:310).
- Diamond markers are 13 px with a 2 px outline; adjacent incidents in one group are hard to tap distinctly, and a tap navigates immediately (MissionCenterProjectGisMap.tsx:291-293,...
- Card hover affordance (hover:border/hover:bg) is the only visual hint that cards are buttons; no focus-visible ring is declared (MissionCenterProjectExplorer.tsx:321).
Tablet risks:
- Stacked layout below 1280 px: map (≥540 px) then a 760 px-max aside; a user comparing marker positions to the list must scroll back and forth.
- Undocked popups (dockEnabled:false) on a 768 px-wide map obscure neighbouring markers when opened by a stray tap (MissionCenterProjectGisMap.tsx:183).
Pain points (blocker/major):
- [major] Classification label falls back to 'Loading classification…' permanently when /incident-classifications/query fails or returns no row for an incident, so a failure reads as an in-... - web/src/features/incidents/incidentClassification.ts:19; MissionCenterProjectExplorer.tsx...
- [major] A deep link whose incident GIS loads but whose incident is not in the group's incident list leaves the aside blank: mode becomes INCIDENT (only incidentGis is checked) but the INC... - MissionCenterProjectExplorer.tsx:122-126, 221, 331, 390-391
- [major] Incident marker popup is unreadable in practice because the click navigates; the 'Click the marker to inspect GIS evidence.' sentence is dead copy. - MissionCenterProjectGisMap.tsx:206-210, 295-298
Strengths to keep:
- Map auto-fits to the group's incidents (view.goTo(graphics)) so the first view is always useful (MissionCenterProjectGisMap.tsx:303-306).
- Classification is loaded for all incidents in one POST rather than per card (MissionCenterProjectExplorer.tsx:174-177).
- Direct link to the fuller Event Group workspace keeps Mission Center a read-only GIS lens rather than duplicating the workspace (MissionCen...

### Incident GIS evidence (INCIDENT mode)  -  `/mission-center/:gid/:iid`
Purpose: Show one incident's saved affected-area geometry and geotagged field photos (with camera-heading wedges) on the map, with a synchronized evidence list, so a reviewer can verify where the evidence was captured.
Roles: Same operational set (MAINTENANCE_COORDINATOR, GEOTECH_OFFICE_CHIEF, GEOTECH_BRANCH_CHIEF, GEOTECH_ENGINEER, REVIEWER, ADMIN + aliases) — route ProtectedRoute at web/src/App.tsx:111-118; gate MissionCenterProjectExplorer.tsx:225; backend require_roles(MISSION_CENTER_ROLES) at backend/app/routes/mission_center_gis.py:186-190
Primary tasks: Verify photo evidence locations and camera headings against the incident location and saved geometry; Check evidence coverage (how many photos are mapped / have heading / are unmapped); Jump to the technical submission, the incident record, or the Event Group workspace

Essential data (11): Breadcrumb 'California Event Groups › {group ti...; '#{id} {title or 'Incident'}'; Pills: incident status (New/In progress/Resolve...; Incident location '{lat}, {lng}' (6 decimals, t...; Photo summary tiles: Photos / Mapped / Heading ...; Action links: 'Open technical submission' (prim...; Photo evidence rows: thumbnail (80×56 img, alt=...; Map: selected incident marker only (sibling inc...; Map: saved geometry graphics (blue fill polygon...; Map: photo markers (accent 11 px circle), camer...; Photo popup: file name title, 'Field photo', 'C...
Secondary data (10): Eyebrow 'Incident GIS Evidence'; Classification state line 'Pending assessment r...; 'Loading GIS evidence…'; Observed {date time}; Linked submission '#{id}' or 'Not created yet'; Report description (when present); Notice '{file} has no mapped location; opening ...; 'No field photo evidence is linked to this Inci...; Map legend: accent dot 'Field photo', faded wed...; Fetched but never shown: geometry_srid, geometr...
Noise (2): '← Event Group Incidents' button (Duplicates the breadcrumb group link; 11 px text.); Saved geometry: raw GeoJSON type ('Polygon'... (Raw code where a human label ('Affected area drawn' / 'Not drawn') is...)

Actions: Breadcrumb links ('California Event Gro... [All operational roles]; '← Event Group Incidents' [All operational roles]; 'Open technical submission' [All operational roles (render...]; 'Open in Incidents' [All operational roles]; 'Open Event Group' [All operational roles]; Click a photo row [All operational roles]; Click a photo marker / wedge on the map [All operational roles]; 'Open original' link inside the popup [All operational roles]; ArcGIS Home / Compass / Search / Basema... [All operational roles]
Entry points: Card/marker click from /mission-center/:gid; 'View on map' on the Incidents operations table (web/src/features/incidents/IncidentsOper...; 'Map' link per incident row and incident links in history on Event Group detail (web/src/...; 'View on map' in AssessmentDetailPanel (web/src/features/assessments/AssessmentDetailPane...
Layout: Same page grid; the aside content is the densest of the three modes: header block, 2-column <dl>, 4-tile summary, description card, action row, then the photo list, all inside the max-h-[760px] scroll region.
Breakpoints used: md:p-5 (MissionCenterProjectExplorer.tsx:239), xl:grid-cols-[minmax(0,2fr)_minmax(340px,0.8fr)] (MissionCenterProjectExplorer.tsx:271), dl is a fixed grid-cols-2 with no breakpoint (MissionCenterProjectExplorer.tsx:343), Photo summary row uses flex-wrap gap-x-6 (MissionCenterProjectExplorer.tsx:350)
Phone risks:
- grid-cols-2 <dl> at ~309 px gives ~150 px columns; '38.123456, -121.123456' at text-sm font-medium (~170 px) wraps mid-coordinate (MissionCenterProjectExplorer.tsx:343-344).
- Photo popup embeds an image up to 320 px wide inside a map that is ~309 px wide, with dockEnabled:false; the popup can exceed the map card (MissionCenterProjectGisMap.tsx:183, 329...
- Photo rows rely on a hover title tooltip ('Show this photo on the map' / 'Open the original file') to explain that a tap may open a new tab instead of moving the map (MissionCente...
- Unmapped-photo tap calls window.open, which mobile browsers may block as a popup after the async path (MissionCenterProjectExplorer.tsx:375).
- Back button is text-[11px] px-2 py-1 (~22 px) (MissionCenterProjectExplorer.tsx:334).
Tablet risks:
- Stacked layout: tapping a photo row scrolls nothing — the map (above) recentres off-screen; the user has to scroll up to see the effect (MissionCenterProjectExplorer.tsx:372-373 d...
- The 760 px aside scroll region plus 540–900 px map exceed a portrait tablet's height; the notice banner sits above the grid and can be off-screen when it appears (MissionCenterPro...
Pain points (blocker/major):
- [major] On any viewport below xl the map and the evidence list are not visible together, defeating the click-row-to-focus-map interaction; nothing scrolls the map into view after focusPho... - MissionCenterProjectExplorer.tsx:271, 283, 372-373; MissionCenterProjectGisMap.tsx:151
- [major] Photo correction/provenance data (location_overridden, heading_overridden, horizontal_accuracy_m, location_source, heading_source) is fetched but not shown, so a reviewer cannot t... - web/src/features/submissions/photoEvidenceApi.ts:3-30; MissionCenterProjectExplorer.tsx:3...
Strengths to keep:
- List-to-map sync through a small imperative handle (focusPhoto) with a graceful fallback for unmapped photos and an explanatory notice (Mis...
- Camera-heading wedge geometry is shared with the submission evidence map (headingWedgeRing, PHOTO_HEADING_WEDGE_FILL_ALPHA), so reviewers s...
- Accent colour for photo evidence is read from the CSS theme variable with a fallback, so markers follow light/dark/coastal themes (web/src/...

### Mission Center GIS map panel (shared across all three modes)  -  `/mission-center, /mission-center/:gid, /mission-center/:gid/:iid (component web/src/features/missionCenter/MissionCenterProjectGisMap.tsx)`
Purpose: Single ArcGIS MapView that re-symbolizes five graphics layers according to the current mode and exposes standard GIS widgets plus a mode-specific legend footer.
Roles: Rendered only for operational users (parent gate at MissionCenterProjectExplorer.tsx:225)
Primary tasks: Pan/zoom to find and select Event Groups or incidents by clicking markers; Inspect photo/geometry evidence via popups; Switch basemap, toggle layers, geocode a place with the ArcGIS Search widget

Essential data (1): Basemap: topo-vector (light) / dark-gray-vector...
Secondary data (5): Five GraphicsLayers titled 'Event Groups', 'Eve...; Home, Compass, dual-unit ScaleBar; Expand buttons with tooltips 'Search map', 'Bas...; Legend footer (mode-specific chips); aria-label 'Mission Center Event Group and Inci...
Noise (0): 

Actions: Click marker (PROJECTS: group; PROJECT:... [All operational roles]; Click photo / wedge / geometry (INCIDEN... [All operational roles]; Home, Compass, Search, BasemapGallery, ... [All operational roles]
Entry points: Always mounted inside MissionCenterProjectExplorer (MissionCenterProjectExplorer.tsx:272-...
Layout: Wrapper 'map-stack-guard overflow-hidden rounded-xl border' with a div whose height is a prop (Explorer passes clamp(540px, calc(100vh - 320px), 900px); component default 650 px) and a flex-wrap legend footer.
Breakpoints used: None in MissionCenterProjectGisMap.tsx; height comes from the parent prop (MissionCenterProjectExplorer.tsx:283); legend uses flex-wrap (MissionCenterProjectGisMap.tsx:376)
Phone risks:
- Fixed-min 540 px height consumes ~66% of a 812 px phone viewport; ArcGIS captures single-finger pan so the page is hard to scroll past the map.
- Three Expand buttons + Home + Compass at ArcGIS default 32 px on a 309 px-wide map crowd the top edge; the Search widget when expanded is wider than the map.
- popup dockEnabled:false means popups float over the small map; the photo popup contains a 320 px image (MissionCenterProjectGisMap.tsx:183, 329).
- Legend chips wrap into 2–3 rows under the map on narrow widths (fine, but adds height).
Tablet risks:
- At 768–1024 px the map is full-width; the 5-layer LayerList and BasemapGallery panels open at ArcGIS default widths (~300 px) over the map — usable.
- Home widget resets to the statewide extent even when drilled into an incident (Home stores the initial viewpoint), which is disorienting at incident level (MissionCenterProjectGis...
Pain points (blocker/major):
- (none)
Strengths to keep:
- One MapView instance for all three modes (no remount on drill), keeping ArcGIS init cost to once per page (MissionCenterProjectGisMap.tsx:1...
- Callbacks and mode are held in refs so the single click handler never goes stale without re-subscribing (MissionCenterProjectGisMap.tsx:134...
- Clean teardown: click handle removed, view destroyed, refs nulled (MissionCenterProjectGisMap.tsx:217-226).

### Access notice for non-operational users  -  `/mission-center, /mission-center/:gid, /mission-center/:gid/:iid (same routes; rendered when isOperationalUser is false)`
Purpose: Tell a maintenance-reporting account that Mission Center is not available to them.
Roles: MAINTENANCE_FIELD_WORKER / MAINTENANCE (maintenance-only accounts) and any signed-in user with no operational role (web/src/utils/roleModel.ts:16, 36-44; MissionCenterProjectExplorer.tsx:225-235)
Primary tasks: Understand why the page is empty and go somewhere useful

Essential data (1): Message: 'Mission Center is available to ERIS o...
Secondary data (1): AppShell header, nav card/sidebar (without a Mi...
Noise (0): 

Actions: None on the page itself [Maintenance-only users]
Entry points: Direct URL or a shared /mission-center/... deep link (the nav item is hidden for these us...
Layout: AppShell > div.p-6 > rounded notice panel.
Breakpoints used: Inherited AppShell breakpoints only (web/src/ui/AppShell.tsx:140-165)
Phone risks:
- None specific; short text block.
Tablet risks:
- None.
Pain points (blocker/major):
- (none)
Strengths to keep:
- Message states the rule in plain language and names who is scoped where (MissionCenterProjectExplorer.tsx:230).
- The fetch is short-circuited for non-operational users so no 403 noise reaches the console (MissionCenterProjectExplorer.tsx:133).

## Area: My Work queue and coordinator triage dialogs (paths relative to C:\ERIS-worktrees\eris-design-system)

### My Work queue (rail + detail shell)  -  `/my-work (optional ?assessment=<id> deep link); wrapped in ProtectedRoute only, not RoleRoute (web/src/App.tsx:29-36)`
Purpose: Single role-driven inbox listing every incident awaiting coordinator triage and every assessment step waiting on the signed-in user, with the selected item's work panel beside it.
Roles: Any signed-in user can hit the route (ProtectedRoute, web/src/App.tsx:29-36); the queue itself renders only for hasWorkQueue() = isOperationalUser(): MAINTENANCE_COORDINATOR/MAINT_COORDINATOR, GEOTECH_OFFICE_CHIEF/OFFICE_CHIEF, GEOTECH_BRANCH_CHIEF/BRANCH_CHIEF, GEOTECH_ENGINEER/FIELD_WORKER, REVIEWER, ADMIN (web/src/utils/roleModel.ts:17-24,71-73; web/src/features/myWork/MyWorkPage.tsx:46,106), MAINTENANCE_FIELD_WORKER/MAINTENANCE (maintenance-only) see the 'No workflow steps are assigned to your role' state (MyWorkPage.tsx:106-117), Queue composition per role: coordinator/admin -> triage incidents (canTriage, MyWorkPage.tsx:59-61); office chief/admin -> office_chief queue + APPROVED (52,56); branch chief/admin -> branch_chief queue (53); engineer/admin -> DRAFT/REVISION_REQUESTED (54); everyone -> reviewer queue SUBMITTED (55); admin -> all SUBMITTED (57)
Primary tasks: See what is waiting on me and pick the next item; Act on the selected item (triage a field report or advance an assessment step); Jump to the underlying incident / submission / map record when more context is needed

Essential data (15): Page title 'My Work' (AppShell h1); 'N items waiting on your role' count; Error banner (red); Notice banner (green) e.g. 'Incident #12 accept...; Empty state 'Nothing needs your attention' + li...; Loading state 'Loading your queue…'; No-queue state 'No workflow steps are assigned ...; Triage card: 'Triage · Incident #<id>'; Triage card: incident title or 'Field report' f...; Triage card: location label 'D7 · Los Angeles ·...; Assessment card: 'Assessment #<id>'; Assessment card: 'Incident #<id>'; Assessment card: state badge (mini) e.g. 'Pendi...; Assessment card: 'Waiting on <role>' or 'Comple...; 'Loading assessment…' placeholder in the detail...
Secondary data (3): Refresh button label / 'Refreshing…'; Assessment card: submissions line ('No technica...; AppShell navigation (Workspace › My Work, Opera...
Noise (4): Rail header 'N items waiting on you' (Exact duplicate of the count 15px above it); Triage card: 'New report' red pill (Constant on every triage card; the 'Triage ·' prefix already says it,...); Assessment card: 'Office NORTH' raw office ... (Raw code where the detail panel spells 'North GeoTech Office · Distri...); AppShell header: product name, 'Caltrans | ... (Raw role enum strings shown to end users in the header on every page)

Actions: Refresh [All queue roles]; Select queue item (rail card button) [All queue roles]; Link 'Operations › Assessments' [All queue roles (empty queue ...]; Link 'Incidents' [Maintenance-only roles]; Sidebar nav items, theme select, Sign o... [All]
Entry points: Sidebar 'Workspace › My Work' (only when hasWorkQueue) — web/src/ui/AppShell.tsx:79-81; '/' HomeRedirect -> /my-work for queue roles, /incidents otherwise — web/src/App.tsx:175-...; Login success always navigates to /my-work regardless of role — web/src/pages/LoginPage.t...; Deep link /my-work?assessment=<id> from 'This step is yours — act on it in My Work' in th...; Inline text links from Assessments page (AssessmentWorkspacePage.tsx:115) and Incidents o...
Layout: AppShell: sticky header; nav is an inline 'product-card' list above content below lg and a 256px/64px collapsible sidebar at lg+ (AppShell.tsx:163-185). Page body 'grid gap-3.5 p-4 md:p-5'; queue rail and detail become ...
Breakpoints used: md:p-5 (MyWorkPage.tsx:121), xl:grid-cols-[minmax(320px,0.7fr)_minmax(0,1.8fr)] (MyWorkPage.tsx:136), max-h-[860px] + overflow-auto on the rail (MyWorkPage.tsx:137,139), AppShell: lg:hidden / hidden lg:block sidebars, lg:flex-row, md:px-6, sm:flex theme select, md:block user block (AppShell.tsx:146,157,163-165)
Phone risks:
- 375px: rail and detail stack; the rail can be up to 860px tall, so the auto-selected item's detail panel sits below the fold and tapping a card does not scroll to it (MyWorkPage.t...
- Inline navigation card (all 6-8 nav links) occupies the top ~250px of every page instead of a drawer (AppShell.tsx:164)
- Header product name + subtitle truncate next to Sign out; user name/roles hidden (AppShell.tsx:143,157)
- Rail cards are full-width buttons with p-3 (adequate touch targets), but the active state is colour/border only
Tablet risks:
- 768-1024px: still a single stacked column because two-column needs xl; at 1024 the lg sidebar appears (w-64) and steals width, so a 1024px landscape tablet shows one column plus a...
- Same scroll-past-the-rail problem as phone; no sticky rail/tabs to switch between list and detail
Pain points (blocker/major):
- [major] Side-by-side rail/detail only at ≥1280px; on anything narrower the 860px rail pushes the work panel below the fold and selecting a card does not scroll to the panel - web/src/features/myWork/MyWorkPage.tsx:136-139,148,166
- [major] Mixed queue (triage + five assessment states) with no filter, grouping, search, or per-kind counts; up to 1000 items per queue fetched and rendered in one list - web/src/features/myWork/MyWorkPage.tsx:52-61,67-72,139-170
- [major] Active rail card is conveyed by colour only (no aria-current/aria-pressed); the rail is a plain div grid with no list semantics; error/notice banners are not live regions - web/src/features/myWork/MyWorkPage.tsx:127-128,139-149; web/src/features/assessments/Asse...
- [major] Mobile navigation is an always-open inline card, not a drawer, costing vertical space on every page - web/src/ui/AppShell.tsx:164
Strengths to keep:
- One inbox for every role, composed from the exact server queues the role can act on; triage items always sort first, then by recency (MyWor...
- Purposeful empty/no-queue states that point to the right next place (MyWorkPage.tsx:110-113,131-134)
- Record view -> My Work deep link makes 'act on it' a one-click hop (AssessmentDetailPanel.tsx:269; MyWorkPage.tsx:82-86)

### Triage work item panel (field report awaiting coordinator intake)  -  `/my-work (detail column when a 'triage' item is selected)`
Purpose: Shows the coordinator a not-yet-accepted field report and offers the single next step: start the two-step triage dialog.
Roles: MAINTENANCE_COORDINATOR/MAINT_COORDINATOR and ADMIN (canTriage) — only these roles receive triage items (web/src/utils/roleModel.ts:46-48; MyWorkPage.tsx:59-61)
Primary tasks: Understand what and where the report is before triaging; Start triage (Event Group review -> disposition); Open the full incident record when the summary is not enough

Essential data (5): Eyebrow 'Field report #<id> — not yet in the in...; Title or fallback 'Incident #<id>'; Location label (D · County · R · PM); 'Reported <date time>'; Description paragraph (when present)
Secondary data (3): Latitude, longitude at 6 decimals; 'NEXT STEP' eyebrow + 'Waiting on Maintenance C...; Explanatory paragraph ('This report has not bee...
Noise (1): 'Awaiting triage' red pill (Third label for the same state (rail says 'New report', eyebrow says ...)

Actions: Open incident record [Coordinator/admin]; Start triage (primary) [Coordinator/admin]
Entry points: Selecting a triage card in the My Work rail (MyWorkPage.tsx:174-179); triage items are au...
Layout: Two stacked cards ('grid gap-3.5'); header uses 'flex flex-wrap items-start justify-between' so the pill wraps under the title; action row 'flex flex-wrap' (TriageWorkItem.tsx:51-64).
Breakpoints used: None — relies on flex-wrap and parent 'min-w-0' (TriageWorkItem.tsx:53-54,62)
Phone risks:
- Panel itself wraps cleanly; the risk is positional — on <xl it renders under the 860px rail (see queue screen)
- Coordinate string plus location plus timestamp wraps into 2-3 lines at 13px
Tablet risks:
- Same positional issue as phone; no other layout concerns
Pain points (blocker/major):
- [major] Triage/API errors are sent to the page-level banner behind the modal overlay while the dialog stays open, so the coordinator sees no error inside the dialog they are working in - web/src/features/myWork/TriageWorkItem.tsx:43-44,82-84; web/src/features/myWork/MyWorkPag...
- [major] Only title, description, location and time are surfaced; photos, reporter identity, and incident type require leaving the queue via 'Open incident record' before a disposition can... - web/src/features/myWork/TriageWorkItem.tsx:52-65
Strengths to keep:
- Single, unmistakable primary action ('Start triage') with a plain-language explanation of what 'Assessment required' does (TriageWorkItem.t...
- Outcome message names both the incident and the newly created assessment id so the coordinator can follow it (TriageWorkItem.tsx:39-41)
- Escape hatch to the full incident record without losing the queue (TriageWorkItem.tsx:63)

### Assessment work item panel (AssessmentDetailPanel mode='work')  -  `/my-work (detail column when an assessment item is selected; same component renders read-only at /assessments/:id with mode='record')`
Purpose: Lets the responsible role perform the current assessment step (delegate, assign engineer, draft/submit, review, finalize, manage reviewers) with full context of pipeline, submissions, assignments and history.
Roles: Office Chief/admin: Delegate at PENDING_OFFICE_DELEGATION, Finalize at APPROVED, add/remove reviewers (assessmentModel.ts:127,132-133), Branch Chief/admin: Assign engineer at PENDING_ENGINEER_ASSIGNMENT, add/remove reviewers (assessmentModel.ts:128,133), Assigned engineer (GEOTECH_ENGINEER/FIELD_WORKER matching assigned_engineer_user_id)/admin: create/fill submission and Submit for review at DRAFT/REVISION_REQUESTED (assessmentModel.ts:129-130), Assigned REVIEWER/APPROVER (any role with an assignment)/admin: Request revision / Approve at SUBMITTED (assessmentModel.ts:131), Anyone else in the queue sees 'No actions for your role on this step.' (AssessmentDetailPanel.tsx:272)
Primary tasks: Perform the one workflow action the step is waiting on; Check the attached technical submissions and open the right one; See who is assigned and what happened so far

Essential data (10): Eyebrow 'Assessment #<id>'; Heading 'Incident #<id> · <title>' or 'Incident...; State badge (full size); Six-step pipeline (Office delegation → Branch a...; 'NEXT STEP' + 'Waiting on <role or Engineer · N...; Submissions table: Submission descriptor link; Submissions table: Status badge showing the raw...; Submissions table: Action 'Review' / 'Open'; Empty submissions message (state-aware); Assignments card: full name, humanized role · e...
Secondary data (9): 'North GeoTech Office · District 7 · Updated <d...; 'Routing override: <reason>' box (when present); 'Workflow complete. Finalized <date>' banner; 'No actions for your role on this step.'; Submission requirement helper ('At least one su...; Select options 'Full name · email' for branch c...; Technical submissions card title with count and...; Submissions table: Created / Submitted timestam...; Assessment history card: humanized event type ·...
Noise (2): Submissions table: ID column '#<id>' (Duplicated by the descriptor link and the Action column in the same r...); Submissions table: Reporter 'You' or 'User ... (Raw user id instead of a name)

Actions: Open incident [All]; View on map [All (when event group known)]; Event Group #N [All (when event group known)]; Fill out submission #N [Assigned engineer / admin]; Create draft technical submission / Add... [Assigned engineer with engine...]; Optional workflow notes (textarea) [Any actionable role]; Select branch chief / Assign engineer n... [Office Chief / admin at PENDI...]; Select engineer / Assign engineer [Branch Chief / admin at PENDI...]; Submit for review [Assigned engineer / admin]; Request revision (red text) / Approve a... [Assigned reviewer/approver / ...]; Finalize assessment (green) [Office Chief / admin at APPRO...]; Add reviewer… select + Add [Office Chief / Branch Chief /...]
Entry points: Selecting an assessment card in the rail (MyWorkPage.tsx:180-181); /my-work?assessment=<id> from the record view (MyWorkPage.tsx:82-86)
Layout: Vertical stack of four cards ('grid gap-3.5'); header and action rows use flex-wrap; selects are 'min-w-0 flex-1'; pipeline is an 'overflow-x-auto' <ol> whose six steps each reserve 'min-w-[74px]'; submissions table sit...
Breakpoints used: None — flex-wrap only, overflow-x-auto on Pipeline (AssessmentDetailPanel.tsx:84) and submissions card (336), min-w-[74px] per pipeline step (91), max-h-[420px] history (390)
Phone risks:
- Pipeline needs ~500px, so it scrolls horizontally inside the card on 375px with no scroll affordance (84-105)
- 7-column submissions table scrolls horizontally; the Action column is off-screen by default (342-343)
- Buttons are 'py-1.5 text-xs' (~28-30px tall), below 44px touch guidance (126-128)
- Office chief's two flex-1 selects and Delegate wrap into three rows (296-307)
- Nested vertical scroll region for history inside the page scroll (390)
Tablet risks:
- Pipeline fits at 736px+ but the submissions table can still overflow when descriptors are long
- Select+button rows wrap unevenly at 768-900px
Pain points (blocker/major):
- [major] Irreversible workflow transitions (Delegate, Approve, Request revision, Finalize) fire on a single click with no confirmation and no required reason; 'Request revision' silently s... - web/src/features/assessments/AssessmentDetailPanel.tsx:306,315,323-328
- [major] Form controls have no visible/programmatic labels: three selects rely on placeholder options, the notes textarea has only a placeholder - web/src/features/assessments/AssessmentDetailPanel.tsx:294,298-305,311-314,370-373
Strengths to keep:
- Pipeline visual plus 'Waiting on' sentence make the workflow position and the expected action unambiguous (AssessmentDetailPanel.tsx:79-111...
- Client permissions mirror the server guards so only actionable controls render; 'record' vs 'work' mode reuses one component (assessmentMod...
- Cross-links to incident, map and Event Group keep context one click away (241-243)

### Event Group review dialog (triage step 1)  -  `/my-work (modal; no URL). Rendered by IncidentTriageDialog while the Event Group step is incomplete`
Purpose: Have the coordinator decide whether the new report belongs to an existing nearby open Event Group or starts its own, and persist that decision before recording the disposition.
Roles: MAINTENANCE_COORDINATOR/MAINT_COORDINATOR and ADMIN (reached only via 'Start triage' on a triage item; roleModel.ts:46-48)
Primary tasks: Compare the new report's location against nearby open Event Groups; Record 'use selected Event Group' or 'starts its own event' (optionally titling the new group); Continue to the disposition step

Essential data (12): Title 'Event Group review — incident #<id>'; Error banner; 'Loading Event Group context…'; 'Nearby open Event Groups' heading + radius sel...; Option 'Starts its own event' + 'No existing Ev...; 'No open Event Groups within N miles.'; Group option: title; Group option: location label; Group option: distance ('820 ft away' / '3.4 mi...; New-group form: Event Group title (prefilled 'R...; Status line 'Decision recorded: <title>' or 'Re...; Map pane (see separate entry)
Secondary data (5): Description 'Confirm shared-event context befor...; Group option: 'N incidents'; New-group form: Description; Coordinator note; Selected group summary under the map: title, lo...
Noise (1): Group option: '#<id>' (Internal id prefixed to every row; title + location already distingui...)

Actions: Radius select [Coordinator/admin]; Radio 'Starts its own event' [Coordinator/admin]; Radio per nearby group (whole card is t... [Coordinator/admin]; 'Record decision · use selected Event G... [Coordinator/admin]; Cancel [Coordinator/admin]; Continue to triage (primary) [Coordinator/admin]; × close, Esc, backdrop click [Coordinator/admin]
Entry points: 'Start triage' on the triage panel (TriageWorkItem.tsx:75 -> IncidentDecisionDialogs.tsx:...; 'Review Event Group again' from step 2 remounts this dialog (IncidentDecisionDialogs.tsx:...
Layout: Full-screen overlay 'fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4'; panel 'flex max-h-[92vh] w-full max-w-6xl flex-col'; body 'min-h-0 flex-1 overflow-y-auto px-5 py-4'; inside, 'grid gap-4 lg:gri...
Breakpoints used: lg:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.4fr)] (177), max-w-6xl, max-h-[92vh] (163), max-h-[52vh] overflow-auto list (185), fixed height={380} map (221), overlay p-4 (ModalDialog.tsx:25)
Phone risks:
- 375×667: dialog is 92vh (~614px) with ~80px header and ~56px footer; the body must scroll through a 52vh list box, the form, then a 380px map, then the summary — three nested scro...
- The ArcGIS map captures touch pan/zoom, so swiping over the map does not scroll the dialog; the coordinator can get stuck on the map (EventGroupTriageMap.tsx:54)
- Radius select is 'text-xs px-2 py-1.5' (~28px) and radio inputs are browser-default size, though the whole p-3 card is the label (181,186,193)
- Marker popups with dockEnabled:false open inside a 343px-wide, 380px-tall map and can be clipped (EventGroupTriageMap.tsx:54,92,103,115)
Tablet risks:
- 768-1023px portrait stacks list over map (same as phone); at exactly 1024px landscape the two-column grid engages with a 280px minimum list beside the map
- Nested list scroll (52vh) plus body scroll still applies
Pain points (blocker/major):
- [major] The nearest group is pre-selected as the default decision whenever any group is within range, biasing the coordinator toward association; 'Starts its own event' must be actively c... - web/src/features/eventGroups/EventGroupAssociationDialog.tsx:92-94
- [major] The association is persisted the moment 'Record decision' is pressed — before any disposition — and the dialog offers no undo; if the server then reports can_change_association=fa... - web/src/features/eventGroups/EventGroupAssociationDialog.tsx:131-152,208,211
- [major] Fixed 380px map inside a scrollable modal inside a scroll-locked page: touch users fight nested scrolling and map gesture capture - web/src/features/eventGroups/EventGroupAssociationDialog.tsx:173,185,221; web/src/ui/Moda...
Strengths to keep:
- Distance-sorted list with human distances (ft/mi) and a radius control (EventGroupAssociationDialog.tsx:11-15,181-183)
- Auto-generated Event Group title from route/PM/county removes naming friction (40-48,99)
- Continue is gated on a recorded decision with an explicit status line, so the two-step flow cannot be skipped (211,237)

### Nearby Event Groups map (pane inside the Event Group review dialog)  -  `/my-work (modal pane; EventGroupTriageMap)`
Purpose: Plots the new report, every nearby open Event Group (clickable) and the selected group's existing incidents so the coordinator can judge spatial fit.
Roles: Same as the review dialog: MAINTENANCE_COORDINATOR/MAINT_COORDINATOR, ADMIN
Primary tasks: See how far the new report is from candidate groups; Select a group by clicking its marker; Preview the selected group's incidents

Essential data (4): New report marker (16px red circle, white outli...; Open Event Group markers (blue circles, larger ...; Selected group's incidents (red diamonds active...; Legend: 'New incident', 'Open Event Group — cli...
Secondary data (1): Basemap (theme-aware), default ArcGIS zoom widg...
Noise (1): Layer titles 'Open Event Groups', 'Event Gr... (Set on GraphicsLayers but no layer list widget exists, so never visib...)

Actions: Click a group marker to select [Coordinator/admin]; Pan / zoom (mouse, touch, default zoom ... [Coordinator/admin]; Marker popups [Coordinator/admin]
Entry points: Rendered whenever the review dialog has loaded context (EventGroupAssociationDialog.tsx:2...
Layout: 'map-stack-guard overflow-hidden rounded-xl' wrapper (isolation:isolate, z-index:0 from index.css:120-124) around a div with inline style height=380px and a flex-wrap legend bar underneath.
Breakpoints used: None — fixed pixel height via prop (EventGroupTriageMap.tsx:129; EventGroupAssociationDialog.tsx:221), flex-wrap legend (130)
Phone risks:
- 380px fixed height is ~57% of a 667px viewport inside a 92vh modal; touch gestures are captured by the map; undocked popups clip in a 343px-wide view
- Marker sizes 13-18px are small touch targets; hitTest tolerance is ArcGIS default
Tablet risks:
- Acceptable at 768px+ width but still fixed 380px; nested inside the modal's scroll
Pain points (blocker/major):
- [major] Fixed 380px height regardless of viewport; no vh/aspect-based sizing - web/src/features/eventGroups/EventGroupTriageMap.tsx:32,129; web/src/features/eventGroups...
Strengths to keep:
- Three-layer story (new report / candidate groups / selected group's incidents) with status-coded symbology and a matching legend (86-120,13...
- Auto-fit to all graphics with zoom clamp avoids over-zooming on a single point (121-122)
- map-stack-guard isolation prevents the map from stacking over the modal chrome (index.css:120-124)

### Triage disposition dialog (triage step 2)  -  `/my-work (modal; no URL). IncidentTriageDialog after the Event Group step`
Purpose: Record the coordinator's disposition (assessment required / not required / needs reporter info / duplicate) with optional notes, which accepts the report into ERIS.
Roles: MAINTENANCE_COORDINATOR/MAINT_COORDINATOR and ADMIN (roleModel.ts:46-48)
Primary tasks: Choose the disposition; Add decision notes for the timeline; Confirm, or go back to the Event Group step

Essential data (4): Title 'Triage incident #<id>'; Disposition select with four labels (Assessment...; Selected option description (e.g. 'Route the in...; Busy label 'Recording…'
Secondary data (3): Description paragraph about Event Group confirm...; Green banner 'Event Group decision recorded for...; Decision notes textarea (placeholder 'Add conte...
Noise (0): 

Actions: Disposition (select, initial focus) [Coordinator/admin]; Decision notes (textarea) [Coordinator/admin]; Review Event Group again [Coordinator/admin]; Cancel [Coordinator/admin]; Record triage decision (primary) [Coordinator/admin]; × close / Esc / backdrop [Coordinator/admin]
Entry points: 'Continue to triage' from the Event Group review dialog (IncidentDecisionDialogs.tsx:71-7...
Layout: Default ModalDialog panel 'w-full max-w-xl p-5' in a p-4 overlay; body 'grid gap-4'; footer 'flex justify-between gap-2' containing a left button and a right 'flex gap-2' pair, with no flex-wrap.
Breakpoints used: None — max-w-xl only (ModalDialog.tsx:26), No flex-wrap on the footer (IncidentDecisionDialogs.tsx:102-107)
Phone risks:
- 375px: 'Review Event Group again' + 'Cancel' + 'Record triage decision' need ~430px in a ~303px row, so buttons shrink/overflow or their labels wrap mid-word (102-107)
- Long description paragraph pushes the form down; the textarea (rows=4) plus on-screen keyboard leaves little room
Tablet risks:
- Fits at 768px; centred 576px panel
Pain points (blocker/major):
- [major] Footer button row does not wrap; three buttons overflow a 375px panel - web/src/features/incidents/IncidentDecisionDialogs.tsx:102-107
- [major] 'Duplicate or linked' and 'Needs reporter information' have no structured input (no target incident picker, no question to the reporter) — only free-text notes - web/src/features/incidents/IncidentDecisionDialogs.tsx:18-23,99-101
- [major] Errors from Record are not displayed inside the dialog; they go to the page banner behind the overlay while the dialog stays open - web/src/features/myWork/TriageWorkItem.tsx:43-44; web/src/features/incidents/IncidentDeci...
Strengths to keep:
- Each disposition has a one-line consequence shown live under the select (IncidentDecisionDialogs.tsx:18-23,98)
- Back path to step 1 without losing the recorded association (103)
- Accessible dialog shell: labelled title/description ids, initial focus on the select, focus trap and Escape (44-50,94; ModalDialog.tsx)

### Resolve incident dialog (IncidentResolveDialog) — unreachable  -  `None. Exported from IncidentDecisionDialogs.tsx but no file in web/src imports it (grep for IncidentResolveDialog hits only its definition)`
Purpose: Would mark an incident resolved with an optional resolution note.
Roles: None can reach it; dead code
Primary tasks: (none — not rendered anywhere)

Essential data (0): 
Secondary data (0): 
Noise (2): Title 'Resolve incident #<id>' and descript... (Never rendered); Resolution note textarea (Never rendered)

Actions: Cancel / Resolve incident (green) [Nobody (unreferenced)]
Entry points: None
Layout: Default max-w-xl ModalDialog
Breakpoints used: None
Phone risks:
- n/a — unreachable
Tablet risks:
- n/a — unreachable
Pain points (blocker/major):
- (none)
Strengths to keep:
- Shares DialogShell/Field with the triage dialog, so if revived it would match

## Area: App shell, navigation, login, settings, theming

### App shell (header, sidebar navigation, page frame, footer)  -  `Wrapper rendered by every authenticated page via <AppShell title> (17 call sites: /my-work, /incidents, /event-groups, /event-groups/:id, /assessments, /mission-center, /gis/terrain-cross-sections, /submissions, /submissions/:id, /submissions/:id/photo-evidence, /admin/users, /admin/road-inventory, /settings). Not a layout route: each page mounts its own AppShell (web/src/ui/AppShell.tsx:131).`
Purpose: Frame every authenticated page with the ERIS brand header, a role-filtered section navigation, signed-in identity + Sign out, a quick theme switch, and a titled content card.
Roles: All authenticated roles see the shell; nav sections vary by role (AppShell.tsx:72-104), Workspace › My Work: operational roles only (hasWorkQueue = isOperationalUser; roleModel.ts:71-73), Operations › Mission Center / Event Groups / Assessments: OPERATIONAL_ROLE_NAMES (MAINTENANCE_COORDINATOR, GEOTECH_OFFICE_CHIEF, GEOTECH_BRANCH_CHIEF, GEOTECH_ENGINEER + legacy aliases, REVIEWER, ADMIN), Operations › Incidents: every role incl. MAINTENANCE_FIELD_WORKER/MAINTENANCE (AppShell.tsx:86), GIS Tools › Terrain Cross Sections: operational roles (AppShell.tsx:90-92), Administration › Users / Road Inventory: ADMIN only (AppShell.tsx:93-101), Account › Settings: every role (AppShell.tsx:102)
Primary tasks: Move between ERIS areas (My Work, Operations records, GIS tools, Admin, Settings); Confirm who is signed in and with which roles, then sign out; Switch the colour theme without leaving the current page

Essential data (6): Display name (full_name, else email, else 'Sign...; 'Sign out' button label; Section labels: Workspace, Operations, GIS Tool...; Nav item label + lucide icon per entry (My Work...; Active nav highlight (brand fill + shadow), inc...; Page title <h1> (text-xl, or text-lg in workspa...
Secondary data (4): ERIS logo image (/eris-logo.svg, 36x36); Product name 'Emergency Response Information Sy...; Theme <select> (Light / Dark / Coastal); Collapsed-mode hairline separators between sect...
Noise (5): Subtitle 'Caltrans | Geotechnical Services' (Organisational tagline repeated on every page; adds nothing to any ta...); Raw role codes joined by ' · ' (e.g. 'GEOTE... (Internal enum codes shown verbatim; no humanised label (AppShell.tsx:...); Fallback text 'ERIS user' when roles are em... (Placeholder that conveys nothing (AppShell.tsx:157)); 'Navigation' card heading (mobile aside and... (Redundant caption above an obviously navigational list; repeated in b...); Footer '© {year} Caltrans | ERIS (Internal)' (Legal boilerplate on every non-workspace page; already stated on Logi...)

Actions: Nav links (role-filtered) [All roles; entries filtered p...]; Theme select (Light / Dark / Coastal) [All roles]; Sign out [All roles]; Collapse / Expand navigation toggle [All roles]; Logo / product name [All roles]
Entry points: Any authenticated route renders AppShell (17 <AppShell title=...> call sites); '/' → HomeRedirect → /my-work (work-queue roles) or /incidents (maintenance) (App.tsx:174...; Deep links to any route survive ProtectedRoute after AuthGateLoading
Layout: Sticky header (z-20, backdrop-blur) + max-w-[1900px] container. Below lg: flex-col with a full-width 'Navigation' card stacked above <main>. lg+: flex-row with a sticky (top-[82px]) sidebar fixed at w-64 (256px) or w-16...
Breakpoints used: sm:flex — theme select shown at ≥640px (AppShell.tsx:146), md:block / md:px-6 — identity block shown and wider gutters at ≥768px (AppShell.tsx:140,157,163,189), lg:hidden / lg:block / lg:flex-row / lg:h-screen / lg:overflow-hidden / lg:min-h-0 / lg:gap-4|6 — sidebar vs stacked nav flips at ≥1024px (AppShell.tsx:138,163-165,183-185), Fixed widths: w-64, w-16, h-9 w-9 logo, h-8 w-8 toggle, h-10 w-10 collapsed items, max-w-64 name, max-w-[1900px], sticky top-[82px], Overflow handling: min-w-0 + truncate on title/subtitle/name/nav labels; product-card overflow-hidden on content, No xl/2xl usage; Tailwind v4 default breakpoints (no @theme override found in web/)
Phone risks:
- 375px: the entire navigation renders as a card ABOVE the page content on every page (AppShell.tsx:164). An admin sees 5 section headings + 9 links (~430px) before the page title —...
- Identity block (name + roles) hidden below md (AppShell.tsx:157) and theme select hidden below sm (AppShell.tsx:146): on a phone there is no indication who is signed in, and theme...
- Header title 'Emergency Response Information System' (text-sm) truncates to roughly 'Emergency Response Inf…' next to the 36px logo and Sign out button (AppShell.tsx:143).
- Touch targets: nav items are px-3 py-2 text-sm (≈36px tall), Sign out ≈38px, both under the 44px guideline (AppShell.tsx:39,158).
Tablet risks:
- 768–1023px (iPad portrait, most Android tablets): still the stacked-nav phone layout because the sidebar only appears at lg (1024px) (AppShell.tsx:164-165) — a large nav card wast...
- At exactly 1024px (iPad landscape): sidebar appears; main content width ≈ 1024 − 48 (px-6) − 256 − 24 (gap) ≈ 696px, which is tight for pages that lay out lg:grid-cols-5 summary c...
- sticky top-[82px] is a magic number tied to the current header height; if the header wraps or the brand text changes height the sidebar overlaps or gaps (AppShell.tsx:166).
Pain points (blocker/major):
- [blocker] No responsive navigation pattern below lg: the full nav list is stacked above content on phone and tablet, pushing the page title and content below the fold on every page. - web/src/ui/AppShell.tsx:164 (aside lg:hidden renders <SidebarNavigation /> as a card) and...
- [major] Sidebar collapse state is not persisted; it resets to expanded on every navigation because each page mounts its own AppShell with local useState. - web/src/ui/AppShell.tsx:134 (useState(true)); 17 per-page <AppShell> call sites (e.g. Set...
- [major] Raw role enum codes are shown to the user in the header ('GEOTECH_OFFICE_CHIEF · ADMIN'); there is no shared human-readable role label. - web/src/ui/AppShell.tsx:157; only local helper is AdminUsersOperationsPage.tsx:8-10; role...
- [major] On phones the shell shows no signed-in identity at all (name and roles are md:block) and no theme control (sm:flex). - web/src/ui/AppShell.tsx:146 and :157
Strengths to keep:
- Role-filtered information architecture is documented inline and implemented in one hook (AppShell.tsx:63-104), so users never see areas the...
- Collapsed sidebar keeps accessibility: sr-only section labels, per-link title + aria-label, aria-expanded on the toggle (AppShell.tsx:45-46...
- Header is sticky with translucent backdrop-blur and z-20, keeping Sign out and theme reachable while scrolling (AppShell.tsx:139).

### Login  -  `/login (App.tsx:28; no guard)`
Purpose: Authenticate an ERIS user with email + password and explain why they were signed out when the session expired.
Roles: Unauthenticated visitors (any role). Signed-in users are bounced to /my-work (LoginPage.tsx:27-28)
Primary tasks: Sign in with ERIS email and password; Understand why they landed here (session expired notice) and recover; Know who to contact when access fails

Essential data (6): H2 'Sign in to ERIS'; Session-expired notice 'Your ERIS session expir...; Error banner (validation or API message); Email field with placeholder name@dot.ca.gov; Password field; Submit label 'Sign in' / 'Signing in…'
Secondary data (5): Brand tile 'ERIS' (text in brand square; deskto...; Eyebrow 'Caltrans · Geotechnical Services' (des...; H1 'Emergency Response Information System' (lg ...; Card 'Internal Caltrans system — Access is limi...; Help text 'If you cannot access ERIS, contact y...
Noise (3): Marketing paragraph 'Secure access to emerg... (Feature list for an internal tool whose users already know it (LoginP...); Footer line 'Emergency Response Information... (Third repetition of product name on the same screen (LoginPage.tsx:73)); 'Use your authorized ERIS account to contin... (Restates the heading (LoginPage.tsx:86))

Actions: Sign in (submit) [Unauthenticated]; Forgot password / request access [n/a]
Entry points: Direct URL /login; <Navigate to='/login' replace> from ProtectedRoute (ProtectedRoute.tsx:14) and RoleRoute ...; Hard reload window.location.href='/login' on token expiry (AuthContext.tsx:59-61) or API ...; NotFoundPage 'Go to sign in' when unauthenticated (NotFoundPage.tsx:20-21)
Layout: Full-viewport <main> with a centred max-w-6xl card. Card is a CSS grid: single column below lg; lg:grid-cols-[1.15fr_0.85fr] with a hidden-until-lg brand/marketing panel on the left and the form (max-w-md, centred) on t...
Breakpoints used: sm:px-6 / sm:p-10 — gutters and form padding (LoginPage.tsx:51,77), lg:px-8, lg:grid-cols-[1.15fr_0.85fr], lg:flex (brand panel), lg:hidden (mobile brand block), lg:mt-0 (LoginPage.tsx:51,53,54,79,84), Fixed sizes: min-h-[620px] on both sections, min-h-[calc(100vh-4rem)] wrapper, h-12 w-12 / h-11 w-11 brand tiles, max-w-6xl card, max-w-md form, No md/xl/2xl usage
Phone risks:
- 375x667: the card is forced to min-h-[620px] inside a min-h-[calc(100vh-4rem)] wrapper, so the page is a near-full-screen card whose short form floats in vertical whitespace; with...
- No autofocus on the email field; users must tap into it (LoginPage.tsx:104-113).
- Inputs are py-2.5 (~42px) and the button ~40px — acceptable but under 44px.
Tablet risks:
- 768–1023: single column; the max-w-6xl card spans most of the width while the form is capped at max-w-md, leaving large empty panel margins and hiding all brand copy until 1024px ...
Pain points (blocker/major):
- [major] After sign-in every role is sent to /my-work, but maintenance-only roles have no work queue and land on an empty-state page telling them to go to Incidents; '/' already knows the ... - web/src/pages/LoginPage.tsx:28,42 vs web/src/App.tsx:174-178 and web/src/features/myWork/...
- [major] Deep link is lost on re-authentication: guards redirect to /login without carrying the original location, and expiry handlers do a full window.location reload, so after signing ba... - web/src/auth/ProtectedRoute.tsx:14, web/src/auth/RoleRoute.tsx:15-16 (no state/from), web...
Strengths to keep:
- Session-expiry notice tells users why they were signed out, and storage access is wrapped in try/catch for hardened browsers (LoginPage.tsx...
- Correct autocomplete tokens (username / current-password) and inputMode='email' help password managers and mobile keyboards (LoginPage.tsx:...
- Clear busy state on the submit button and a consistent brand focus ring on inputs (LoginPage.tsx:111,124,128-130).

### Session validation gate (AuthGateLoading)  -  `Rendered in place of any ProtectedRoute/RoleRoute child while AuthContext.isInitializing is true, and on /login when a stored token exists (ProtectedRoute.tsx:13, RoleRoute.tsx:14, LoginPage.tsx:27)`
Purpose: Block protected UI until GET /auth/me confirms the stored token and roles.
Roles: Any user with a stored token (before roles are known)
Primary tasks: Wait for the session to validate

Essential data (1): 'Validating ERIS session'
Secondary data (3): Brand tile 'ERIS'; 'Confirming your account and access before load...; Pulsing half-width bar
Noise (0): 

Actions: 
Entry points: Automatic on app start with a stored token, for every guarded route and /login
Layout: Full-viewport main with a centred max-w-lg card (AuthGateLoading.tsx:3-5).
Breakpoints used: None; fixed max-w-lg, max-w-48 bar
Phone risks:
- None significant; card shrinks to viewport width with px-4.
Tablet risks:
- None.
Pain points (blocker/major):
- (none)
Strengths to keep:
- Prevents a flash of protected content and a redirect loop while the token is checked (ProtectedRoute.tsx:13, LoginPage.tsx:27).
- Consistent brand tile and card styling with Login and Not Found screens.

### Settings  -  `/settings (App.tsx:159-166, ProtectedRoute; nav Account › Settings)`
Purpose: Let the user choose the ERIS colour palette (light / dark / coastal) for this browser.
Roles: All authenticated roles
Primary tasks: Pick a theme; Understand what this page does and does not control

Essential data (2): Section heading 'Appearance'; Three theme cards: label (Caltrans Light / Dark...
Secondary data (1): 'Choose the color palette used across ERIS. Thi...
Noise (1): Section 'About these settings' with paragra... (Meta-explanation of absent features; a page should not need to explai...)

Actions: Select theme (3 aria-pressed buttons) [All roles]
Entry points: Sidebar Account › Settings (AppShell.tsx:102); Header theme select title hints 'Settings › Appearance' (AppShell.tsx:151); Direct URL
Layout: AppShell content card → space-y-4 p-4 md:p-5 → Appearance section (rounded-xl) with theme grid gap-3 md:grid-cols-3 → About section (SettingsPage.tsx:27-71).
Breakpoints used: md:p-5, md:grid-cols-3 (SettingsPage.tsx:27-28,36), max-w-2xl / max-w-3xl text measures
Phone risks:
- Theme cards stack to one column; each card is large (p-4) so touch targets are fine. Inherits the stacked-nav problem from AppShell.
Tablet risks:
- Three cards side by side at md (768px) inside ~700px: each ≈ 220px wide; descriptions wrap to 3 lines — acceptable.
Pain points (blocker/major):
- [major] The 'Account' nav section leads to a page with no account information (name, email, roles) and no password change, so the one place users expect identity details shows only a colo... - web/src/ui/AppShell.tsx:102 (section label 'Account') vs web/src/pages/SettingsPage.tsx:2...
Strengths to keep:
- Immediate, persisted effect with honest wording about browser-local scope (SettingsPage.tsx:31-33; UiSettingsContext.tsx:31-35).
- Selected state communicated by border, tinted background and dot, plus aria-pressed (SettingsPage.tsx:44-56).
- Each theme has a one-line purpose ('Reduced-glare dark workspace for low-light environments') that helps field/office users choose (Setting...

### Not Found  -  `* (App.tsx:167; no guard — renders for signed-in and anonymous users)`
Purpose: Recover from an outdated or mistyped URL by sending the user to a known ERIS workspace.
Roles: Anyone; content varies only by presence of a token, not by role (NotFoundPage.tsx:6,20-27)
Primary tasks: Get back to a working ERIS page

Essential data (2): Eyebrow 'Page not found'; H1 'This ERIS location does not exist.'
Secondary data (2): Brand tile 'ERIS'; Paragraph 'The address may be outdated, incompl...
Noise (0): 

Actions: Go to Mission Center (signed in) / Go t... [All]; Open submissions [Signed-in users]
Entry points: Any unmatched URL, including stale bookmarks; Also reached while auth is still initialising (no gate)
Layout: Full-viewport main → centred max-w-3xl card (p-6 sm:p-10) with centred text and a flex-wrap button row (NotFoundPage.tsx:9-28).
Breakpoints used: sm:px-6, sm:p-10, sm:text-3xl (NotFoundPage.tsx:9,11,14), flex-wrap justify-center gap-2 button row
Phone risks:
- Buttons wrap to two rows on 375px; ~40px tall (py-2.5). Otherwise fine.
Tablet risks:
- None.
Pain points (blocker/major):
- [major] Signed-in users see the 404 outside AppShell — no header, nav or Sign out — so the fastest recovery (the sidebar) is unavailable. - web/src/pages/NotFoundPage.tsx:8-32 (renders its own <main>, does not use AppShell)
- [major] Primary CTA sends every authenticated user to /mission-center, but maintenance-only roles are shown an 'available to operational roles' refusal there; the role-aware '/' HomeRedir... - web/src/pages/NotFoundPage.tsx:20-22; web/src/features/missionCenter/MissionCenterProject...
Strengths to keep:
- Plain-language explanation and distinct CTAs for signed-in vs anonymous visitors (NotFoundPage.tsx:14-27).
- Theme-aware card styling consistent with Login and the auth gate.

### Route guards and redirects (no UI of their own)  -  `'/' (HomeRedirect), '/projects' → '/event-groups', '/projects/:id' → '/event-groups/:id', <ProtectedRoute>, <RoleRoute roles> (App.tsx:27,77-78,174-183; ProtectedRoute.tsx; RoleRoute.tsx)`
Purpose: Send each user to a role-appropriate landing page and keep unauthenticated or under-privileged users out of routes they cannot use.
Roles: HomeRedirect: hasWorkQueue (operational) → /my-work; otherwise (MAINTENANCE_FIELD_WORKER/MAINTENANCE) → /incidents (App.tsx:175-178), RoleRoute OPERATIONAL_ROLE_NAMES: /event-groups, /event-groups/:id, /assessments, /assessments/:id, /gis/terrain-cross-sections (App.tsx:61-94,119-126), RoleRoute ['ADMIN']: /admin/users, /admin/road-inventory (App.tsx:143-158), ProtectedRoute only (any signed-in role): /, /my-work, /submissions*, /incidents*, /mission-center*, /settings
Primary tasks: Land on the right page after opening ERIS; Follow old /projects links to Event Groups

Essential data (1): AuthGateLoading while isInitializing
Secondary data (0): 
Noise (0): 

Actions: 
Entry points: App start; Legacy /projects bookmarks; Any deep link
Layout: Non-visual.
Breakpoints used: 
Phone risks:
- (none)
Tablet risks:
- (none)
Pain points (blocker/major):
- [major] RoleRoute silently redirects under-privileged users to /submissions — a page with no nav entry and not the user's home — with no 'you do not have access' feedback. - web/src/auth/RoleRoute.tsx:19; web/src/ui/AppShell.tsx:66-67 (submissions intentionally h...
- [major] Four different 'home' definitions: '/' is role-aware (/my-work or /incidents), Login always → /my-work, NotFound → /mission-center, RoleRoute fallback → /submissions. - web/src/App.tsx:177; web/src/pages/LoginPage.tsx:28,42; web/src/pages/NotFoundPage.tsx:20...
Strengths to keep:
- Central role model mirrors backend aliases and states clearly that it is for gating only, not security (roleModel.ts:1-14).
- HomeRedirect encodes the correct landing per role in one place (App.tsx:174-178).
- Legacy /projects and /projects/:id URLs redirect instead of 404-ing (App.tsx:77-78,180-183).

### Modal dialog primitive (shared ModalDialog)  -  `Not routed; used by 7 dialogs: EventGroupAssociationDialog, IncidentDecisionDialogs, RoadInventoryVersionActionDialog, PasswordResetDialog, SubmissionDeleteDialog, SubmissionSectionAttachmentsDialog, WorkflowTree (grep ModalDialog)`
Purpose: Provide one accessible overlay container (focus trap, Escape, backdrop close, scroll lock, focus restore) for every modal in ERIS.
Roles: Whatever role the consuming feature exposes it to
Primary tasks: Complete or cancel a focused task without losing page context

Essential data (0): 
Secondary data (0): 
Noise (0): 

Actions: Escape key closes (unless busy) [All]; Backdrop mousedown closes (unless busy) [All]; Explicit close button [n/a]
Entry points: Opened by consumer state
Layout: Default overlay: fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4. Default panel: w-full max-w-xl rounded-xl p-5. Both are fully overridable strings, and 6 of 7 consumers override the panel (ModalDial...
Breakpoints used: None in the primitive; consumers use max-h-[92vh] / max-h-[88vh] and max-w-* only
Phone risks:
- Default panel has no max-height or overflow-y, so a tall dialog (or the on-screen keyboard) pushes buttons off-screen; only two consumers add max-h + flex-col (ModalDialog.tsx:26;...
- Backdrop closes on mousedown/touchstart, so an accidental touch outside a wide panel on a small screen dismisses in-progress input (ModalDialog.tsx:108-110).
Tablet risks:
- Wide consumers (max-w-6xl, 1400px) fill the tablet width with p-4 margins — acceptable.
Pain points (blocker/major):
- (none)
Strengths to keep:
- Real focus management: initial focus (with data-dialog-initial-focus override), Tab/Shift+Tab wrap, focus restored to the opener on unmount...
- Escape and backdrop dismissal are suppressed while busy, protecting in-flight saves (ModalDialog.tsx:62-68,109).
- Body scroll lock with restoration and proper role='dialog' aria-modal aria-labelledby aria-describedby (ModalDialog.tsx:46-47,103,116-119).

## Area: Submission attachments, library, review cards, worklist, photo evidence page

### Submissions worklist  -  `/submissions`
Purpose: Paginated table of every submission visible to the signed-in user, with status counts, client-side search/filter/sort, and per-row Review/Open and Delete actions.
Roles: Any authenticated user (ProtectedRoute, no RoleRoute) — web/src/App.tsx:37-44; page is a re-export shim web/src/pages/SubmissionsPage.tsx:1, Delete: ADMIN for any status; record owner (me.id === created_by_user_id) only while status is DRAFT — web/src/features/submissions/SubmissionsWorklistPage.tsx:96-101, Also the landing page for users bounced off RoleRoute-gated pages — web/src/auth/RoleRoute.tsx:19
Primary tasks: Find submissions awaiting review (SUBMITTED) and open them to review; Locate a specific submission by ID/district/county/route/post mile and open it; Delete a draft (owner) or any record (admin)

Essential data (7): Search worklist text input; Error banner; Column: Submission descriptor link 'District-Co...; Column: Status badge (raw status string); Column: Submitted timestamp; Empty states: 'No submissions available' vs 'No...; Loading rows 'Loading submissions…' / button 'R...
Secondary data (7): Summary cards: Loaded / Submitted / Approved / ...; Sort select (Newest created / Submitted first /...; Column: ID (#n); Column: Reporter ('You' or 'User #id'); Column: Created timestamp (formatted, raw ISO i...; Row tint for SUBMITTED rows; Footer 'Showing X matching submissions from Y l...
Noise (1): Status select with raw codes and counts, e.... (Duplicates the summary-card filter and exposes raw enum codes instead...)

Actions: Summary card (click to filter by status... [All]; Search / Status / Sort controls [All]; Clear filters [All (only when a filter is ac...]; Refresh [All]; Submission descriptor link → /submissio... [All]; Review (brand-filled, SUBMITTED rows) /... [All]; ••• More actions → Delete submission [ADMIN any status; owner for D...]; Load older submissions [All (when has_more)]
Entry points: Direct URL /submissions (App.tsx:37-44); RoleRoute fallback: any user lacking a page's role is redirected here (auth/RoleRoute.tsx...; NotFoundPage link (pages/NotFoundPage.tsx:24); Photo evidence page back-link when the id is invalid (pages/SubmissionPhotoEvidencePage.t...; No sidebar nav item of its own; for operational users the 'Assessments' item is highlight...
Layout: Vertical stack inside AppShell (sidebar stacks above content below lg): stat grid → filter bar → full-width table in an overflow-x-auto card → footer.
Breakpoints used: p-4 md:p-5 (L168), grid-cols-2 lg:grid-cols-5 for summary cards (L169), flex-col xl:flex-row xl:items-end for filter bar (L188), md:grid-cols-[minmax(260px,1fr)_220px_220px] for search/status/sort (L189), overflow-x-auto + table-fixed + colgroup w-20 w-80 w-36 w-36 w-48 w-48 w-32 = 75rem/1200px fixed table (L219-221), sm:flex-row sm:items-center for footer (L250)
Phone risks:
- Table is a fixed 1200px wide (colgroup L221) inside overflow-x-auto (L219): on a 375px phone the user sees only the ID column and a slice of the descriptor; Status, Submitted and ...
- The ••• dropdown is absolutely positioned inside the overflow-x-auto container (L219,L240); overflow-x:auto forces overflow-y:auto, so a menu opened on the last row is clipped/scr...
- ••• button (px-2.5 py-1.5 text-sm, L240) and Review/Open links (py-1.5, L239) are ~32px tall — under a 44px touch target.
- Hover-only tooltips carry the raw timestamps and 'Creator user ID' (title attributes L234-236) — unreachable on touch.
- Summary cards fall to 2 columns (L169) so the 5th card (Draft) sits alone on a third row.
Tablet risks:
- 1200px fixed table still overflows at 768–1024px (content width ≈ 680–940px), so the Action column is off-screen on iPad portrait and partly on landscape.
- At md (768px) the filter grid needs 260+220+220px + 2×8px gaps = 716px but only ≈680px is available (AppShell px-6 + page p-5), and AppShell's product-card is overflow-hidden (ui/...
- Summary cards stay 2-col until lg (1024px).
Pain points (blocker/major):
- [major] Search, status counts and sort operate only on the rows already loaded (50 per page); a reviewer searching for an older ID gets 'No submissions match these filters' until they cli... - SubmissionsWorklistPage.tsx:12,59,128-154,192
- [major] Fixed 1200px table (colgroup) forces horizontal scrolling on phones and tablets with the primary Review action in the far-right column. - SubmissionsWorklistPage.tsx:219-221,237-242
- [major] Summary cards read like global KPIs ('Submitted 3 — Awaiting review') but count only the loaded page; nothing in the card says so ('Loaded' card hint aside). - SubmissionsWorklistPage.tsx:120-126,156-162
Strengths to keep:
- Status summary cards double as the filter with aria-pressed state — one tap to see the review queue (L173-184).
- SUBMITTED rows are tinted and get a brand-filled 'Review' CTA while others get a neutral 'Open' — the queue is visually obvious (L230,L239).
- Cursor pagination with duplicate-id guard and a footer that states exactly how many rows are loaded (L71-89,L250-253).

### Delete submission dialog  -  `/submissions (modal)`
Purpose: Confirms permanent deletion of a submission, with stronger warning copy when the record has already entered review.
Roles: ADMIN (any status); owner for DRAFT only — SubmissionsWorklistPage.tsx:96-101 (only mounted from the worklist per grep)
Primary tasks: Confirm or cancel deletion of the chosen submission

Essential data (3): Title 'Delete submission #id?'; Descriptor (District-County-Route-PM - date); Explanation paragraph (draft vs submitted varia...
Secondary data (2): Eyebrow 'Destructive action'; Status: raw code; Creator: 'User #id'
Noise (1): 'This action cannot be undone from the Web ... (Implies it can be undone elsewhere; should be plain 'cannot be undone')

Actions: Cancel (initial focus) [Admin / draft owner]; Delete submission (red, 'Deleting…' whi... [Admin / draft owner]; × close, Escape, backdrop click [Admin / draft owner]
Entry points: Worklist ••• → Delete submission (SubmissionsWorklistPage.tsx:240,256)
Layout: Centered modal, w-full max-w-lg, overlay p-4, panel p-5; content stacks vertically.
Breakpoints used: None; relies on w-full max-w-lg and overlay p-4 (SubmissionDeleteDialog.tsx:32; ui/ModalDialog.tsx:25)
Phone risks:
- Fits at 375px (panel ≈343px wide). The header row keeps the '×' button beside a text-xl title (L34-40) so long titles wrap to two lines — acceptable.
- '×' close is a text glyph in a px-2.5 py-1.5 button (~32px) — small touch target (L39).
Tablet risks:
- None observed.
Pain points (blocker/major):
- (none)
Strengths to keep:
- Safe default: initial focus lands on Cancel, not Delete (L61; ModalDialog.tsx:49-54).
- Copy changes when the record has already entered review, explaining that deletion is not the same as returning it (L50-56).
- Busy state disables every dismissal path so a double-click cannot fire twice (L39,61-62; ModalDialog.tsx:63,109).

### Submission library (attachment tile grid + inline viewer)  -  `/submissions/:id (panel below the GISA canvas and notes)`
Purpose: Shows every file attached to the submission as media tiles tagged with the GISA section they were captured under, filterable by Photos/Videos/Documents, with open/preview/download actions that resolve short-lived object-storage URLs.
Roles: Any authenticated user who can load the submission (ProtectedRoute App.tsx:135-142; visibility enforced server-side). No role-specific controls inside the library — SubmissionLibrary.tsx:19; mounted at pages/SubmissionDetailPage.tsx:1288
Primary tasks: Look at the field photos/videos for the submission being reviewed; Find which section a file belongs to and open or download it; Preview a PDF/photo without leaving the page

Essential data (7): Filter tabs All / Photos / Videos / Documents w...; Tile thumbnail (photos only; lazy, from presign...; Section chip (e.g. 'Highway Status', 'Sketchpad...; Open menu label 'Open' / 'Opening…'; Download '...; Error banner (dismissable) at top of grid; Empty state 'No files are attached to this subm...; Inline viewer: 'Back to files', file name, imag...
Secondary data (5): Header icon + 'Submission library' title; Count label 'N items · x photos · y videos · z ...; File name (truncated, full name in title); File size (formatted; exact bytes in title); Viewer fallback 'Preview unavailable in this br...
Noise (3): Media badge (Photo/Video/PDF/Document) top-... (Redundant with the glyph label and with the type label under the file...); Type label under the name ('Photo', 'PDF', ... (Third repetition of the media type on one tile); '#id' attachment id (Internal database id, no user task needs it)

Actions: Filter tab (All/Photos/Videos/Documents) [All]; Open ▾ → Open here / Open in a new tab ... [All]; Download [All]; Back to files [All]; New tab / Download [All]; Open in a new tab (fallback) [All]; Dismiss error (X) [All]
Entry points: Scroll down the submission detail page; it sits after 'Notes and actions' and before the ...; No anchor/deep link or jump control from the detail header
Layout: Full-width card: header (title + count left, filter pills right, flex-wrap) → tile grid auto-fill minmax(min(200px,100%),1fr); selecting 'Open here' swaps the grid for a single viewer.
Breakpoints used: No sm/md/lg classes; container-driven grid [grid-template-columns:repeat(auto-fill,minmax(min(200px,100%),1fr))] (SubmissionAttachmentTiles.tsx:394), aspect-[4/3] thumbnails (L251), max-h-[70vh] image/video, h-[70vh] PDF iframe (L313-317), flex-wrap header (SubmissionLibrary.tsx:27,37), index.css:127-142 hover / focus-within / hover:none rules for the action overlay
Phone risks:
- Tiles go single-column at ≈300px wide — fine — but the four filter pills plus counts wrap under the title and the whole header becomes ~3 rows (SubmissionLibrary.tsx:27-58).
- Open/Download overlay buttons are text-xs px-2 py-1 (≈24px tall) — well under a 44px touch target (SubmissionAttachmentTiles.tsx:158,273).
- Full file name and full section label are exposed only via title tooltips (L126,L281) — unreadable on touch.
- PDF preview is an iframe with h-[70vh] and no error fallback (L317); iOS Safari renders only the first page with no scrolling, so 'Open here' on a multi-page PDF is a dead end on ...
- 'Open in a new window' uses a popup feature string (L82) which mobile browsers ignore or block.
Tablet risks:
- Grid yields 3 tiles per row at ≈680px content width; section chips are capped at max-w-[60%] and truncate (L126) so 'Pavement / Ground Status' is cut on 200–220px tiles.
- Same iPad PDF-iframe limitation as phones.
- Inside the modal variant (see next screen) the grid scrolls in a max-h-[88vh] area.
Pain points (blocker/major):
- [major] PDF 'Open here' uses a bare iframe with no onError/fallback and 70vh height; on iOS/iPadOS it shows a single unscrollable page, and the 'Preview unavailable' fallback is only wire... - SubmissionAttachmentTiles.tsx:310-320
- [major] Selecting 'Open here' hides the whole grid; there is no next/previous between files, so stepping through 15 photos means 15 round trips via 'Back to files'. - SubmissionAttachmentTiles.tsx:389-406
Strengths to keep:
- Section chips translate the mobile form's section_key values into GISA section names, giving reviewers the context the old flat attachments...
- Media classification by MIME with kind as fallback lives in one pure module with tests (submissionAttachmentModel.ts:80-97).
- Presigned URL resolver caches per attachment with an early-refresh TTL and de-duplicates in-flight requests; photo-map URLs seed the cache ...

### Section attachments dialog + 'Open attachments (n)' button  -  `/submissions/:id (modal opened from a GISA canvas card header or a Notes field label)`
Purpose: Shows only the files the field form tagged to one GISA section, in the same tile grid, so a reviewer can check evidence while reading that section.
Roles: Any user viewing the detail page; button renders only when the section has ≥1 tagged file — SubmissionSectionAttachmentsDialog.tsx:8-9; mounted pages/SubmissionDetailPage.tsx:104,1258,1325-1332
Primary tasks: See the photos tagged to the section currently being reviewed

Essential data (3): 'Open attachments (n)' paperclip button in the ...; Dialog title '{Section} attachments'; Tile grid without section chips (same tile data...
Secondary data (1): Description '{N items · …} tagged to this secti...
Noise (1): Empty state 'No attachments are tagged to t... (Practically unreachable because the button is hidden at count 0)

Actions: Open attachments (n) [All]; Close (X icon), Escape, backdrop click [All]; Tile actions (Open ▾, Download, inline ... [All]
Entry points: GISA card headers and Notes labels on the detail page (pages/SubmissionDetailPage.tsx:104...
Layout: Centered modal max-w-5xl, max-h-[88vh], flex column: fixed header, scrolling body (overflow-y-auto) containing the tile grid.
Breakpoints used: Overlay p-4, panel w-full max-w-5xl max-h-[88vh] (SubmissionSectionAttachmentsDialog.tsx:40-41), Body min-h-0 flex-1 overflow-y-auto px-5 py-4 (L52), Tile grid auto-fill minmax(min(200px,100%),1fr) inherited
Phone risks:
- Modal becomes ≈343px wide with single-column tiles; scrolling happens inside the body while the page behind is locked — workable.
- The tile Open menu pops upward (bottom-full) and, on the first row, is clipped by the dialog's overflow-y-auto body (SubmissionAttachmentTiles.tsx:164; SubmissionSectionAttachment...
- 'Open attachments (n)' is text-[11px] px-2 py-1 (~22px tall) — a very small target sitting inside the card's mouse-down drag handle (pages/SubmissionDetailPage.tsx:95-105).
Tablet risks:
- Fine at 768–1024px (2–3 tiles per row). Because the GISA canvas is drag/resize driven (mouse events only), the button may be the only usable affordance inside those card headers o...
Pain points (blocker/major):
- (none)
Strengths to keep:
- Contextual evidence: the count badge appears exactly where the reviewer is reading, and the dialog reuses the library tiles with the redund...
- Proper dialog semantics (role=dialog, aria-modal, labelledby/describedby, focus trap, scroll lock) come free from ModalDialog (ui/ModalDial...
- Description sentence states provenance ('tagged … by the field form') so reviewers know why a file appears here (L46).

### Review context cards (Summary, Reviewer Note, Workflow History, Access Sharing)  -  `/submissions/:id (card grid at the bottom of the detail page)`
Purpose: Always-open cards giving the reviewer the record's lifecycle timestamps, a place to write the approval/return note, the full status history, and (for owners/admins) read-access sharing.
Roles: Summary + Workflow History: any user who can load the submission, Reviewer Note editable: REVIEWER or ADMIN (canReview, pages/SubmissionDetailPage.tsx:161); everyone else sees it disabled with 'Read-only for your current role.' (SubmissionReviewerSupport.tsx:24,31), Access Sharing: only when the API flags submission.can_manage_permissions (pages/SubmissionDetailPage.tsx:164,1309)
Primary tasks: Write the note that accompanies Approve / Return; Understand what happened to the record and when (who submitted, who returned, comments); Grant or revoke read access for a colleague

Essential data (9): Reviewer Note card title + subtitle ('Recorded ...; Reviewer note textarea (4 rows, placeholder var...; Event label (Submission created / Submitted for...; Event timestamp (<time>, raw ISO in title); Event comment box; Access Sharing subtitle 'Grant read access … wi...; 'Find a user' search input; 'Available users' results: name + email + Grant...; 'Users with explicit read access (n)' list: nam...
Secondary data (5): Summary card rows: Descriptor, Submission ID, C...; Workflow History title with count; Transition text ('Draft → Submitted', 'Status s...; Empty state 'No workflow events have been recor...; 'No matching users are available to grant.' / '...
Noise (1): 'Event SUBMIT · Actor user #id' line (Raw event code duplicates the label above it; actor is a bare numeric...)

Actions: Edit reviewer note (textarea) [REVIEWER, ADMIN (disabled oth...]; Search users (type=search) [Users with can_manage_permiss...]; Grant read access [Users with can_manage_permiss...]; Revoke access [Users with can_manage_permiss...]
Entry points: Scroll to the bottom of the detail page, after the Submission library (pages/SubmissionDe...
Layout: SubmissionDetailCardGrid: auto-fit minmax(min(420px,100%),1fr) → 1 column below ≈880px content width, 2 columns to ≈1320px, 3 columns above; each card is a bordered section with uppercase brand title, optional subtitle ...
Breakpoints used: [grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr))] (SubmissionDetailPrimitives.tsx:65), grid-cols-3 label/value rows in SubmissionDetailRow (L22-24), flex-wrap headers and rows (SubmissionDetailPrimitives.tsx:51; SubmissionReviewerSupport.tsx:48; SubmissionAccessSharing.tsx:58,86)
Phone risks:
- Summary rows use a fixed 1/3 label column (grid-cols-3, L22): at ≈300px the value column is ≈190px, so raw ISO timestamps like 2026-09-04T18:22:11.123456+00:00 wrap awkwardly.
- Workflow event header wraps the timestamp under the label (flex-wrap, SubmissionReviewerSupport.tsx:48) — fine.
- Grant/Revoke rows wrap the button under the name/email (flex-wrap, SubmissionAccessSharing.tsx:58,86); buttons are py-1.5 text-xs (~28px) — small targets.
- Reviewer note textarea is w-full 4 rows — fine.
Tablet risks:
- Single column at 768px portrait (content ≈680px < 2×420px), so Access Sharing sits far below Reviewer Note; at 1024px landscape two columns fit only if the sidebar is collapsed (s...
Pain points (blocker/major):
- [major] Reviewer note has no explicit save affordance or unsaved indicator; the only cue that it is persisted with Approve/Return is a subtitle, and a note typed by a reviewer who then na... - SubmissionReviewerSupport.tsx:24-35
Strengths to keep:
- Cards are always open — the previous collapsed <details> sections hid the reviewer note and history (SubmissionDetailPrimitives.tsx:29-33).
- Workflow event codes are mapped to plain-language labels ('Returned for correction') and transitions are rendered as 'Draft → Submitted' (s...
- Reviewer note is still readable (disabled textarea with value) for non-reviewers, with a subtitle explaining why it is read-only (Submissio...

### Photo evidence page  -  `/submissions/:id/photo-evidence`
Purpose: Standalone page listing every field photo linked to the submission (or its incident) with effective location, camera heading, capture provenance and telemetry-correction history.
Roles: Any authenticated user (ProtectedRoute, no RoleRoute) — web/src/App.tsx:127-134; no role-specific controls on the page
Primary tasks: Check whether the field photos are geotagged/oriented well enough to trust before approving; Open the original full-resolution photo; See whether telemetry was corrected and by whom

Essential data (8): AppShell H1 'Photo Evidence — {descriptor}' (fa...; '← Back to submission' link; Photo image (object-contain, lazy) or 'Preview ...; Badges: Mapped/Unmapped, Heading recorded, Corr...; Captured timestamp (with seconds); Effective Location lat, long + 'Accuracy: n m'; Camera Heading (deg) + heading source · referen...; Loading 'Loading photo evidence…', 'Invalid sub...
Secondary data (7): Summary cards: Photos / Mapped / With Heading /...; Evidence context: 'Linked incident #id' or 'No ...; Reference location lat, long (6 decimals) or 'N...; File name; 'Incident photo' / 'Submission photo' scope; Location Source, Altitude; Telemetry correction history <details>: Locatio...
Noise (4): Panel header 'Photo evidence' + 'Field phot... (Repeats the H1 directly above it; subtitle is jargon); 'Attachment #id' (Internal id); 'Section: highway_status' (raw section_key) (Raw key; the library shows 'Highway Status' for the same value); MIME Type (Developer-facing; reviewers do not act on image/jpeg)

Actions: ← Back to submission [All]; Refresh evidence [All]; Open original (anchor, target=_blank, p... [All]; Telemetry correction history (native de... [All (only when correction.has...]
Entry points: Detail header button labelled '{n} photos · {m} mapped' (or 'Photo evidence' / 'Checking ...; Location hero 'Photo evidence details' link inside the 'Mapped evidence' box (features/su...; Direct URL
Layout: AppShell page: back link → header card → 4 stat cards → context card → photo cards (1 column, 2 at xl), each card = image area on top and a definition list below.
Breakpoints used: p-4 md:p-5 (pages/SubmissionPhotoEvidencePage.tsx:49), flex-col sm:flex-row for the header card (SubmissionPhotoEvidencePanel.tsx:76), grid-cols-2 lg:grid-cols-4 stat cards (L90), grid gap-4 xl:grid-cols-2 photo cards (L122), min-h-72 image well, max-h-[34rem] image (L131-133), sm:flex-row for name/Open original row (L141); dl sm:grid-cols-2 (L146); correction grid sm:grid-cols-2 (L158)
Phone risks:
- Image well is min-h-72 (288px) with object-contain, so a landscape photo at ≈300px width renders ≈225px tall and letterboxes inside a 288px grey box; portrait photos can reach 544...
- Stat cards are 2×2 (L90) — fine. Definition list is single column below sm so each card is very tall (image + 6 dl items + details).
- Evidence-context coordinates use text-right inside a flex-wrap row (L106-115); when it wraps under the incident line it is right-aligned while the label is left-aligned.
- 'Open original' (py-1.5 text-sm ≈32px) is the only sub-44px control; details/summary is native and touch-friendly.
Tablet risks:
- Photo grid stays single-column until xl (1280px), so on a 1024px iPad every card is full-width with images up to 544px tall — heavy scrolling for 20+ photos.
- Header card goes side-by-side at sm — fine.
Pain points (blocker/major):
- [major] The page is about mapped telemetry but shows no map: coordinates and headings are printed as numbers while the actual photo map with heading wedges lives on the detail page (Submi... - SubmissionPhotoEvidencePanel.tsx:105-153; components/SubmissionArcGisMap.tsx:50
- [major] Images and 'Open original' use the raw presigned download_url with no refresh; the URL expires after 900 s so a page left open shows broken previews with a misleading 'Preview una... - SubmissionPhotoEvidencePanel.tsx:133-135,143; SubmissionAttachmentTiles.tsx:16
- [major] This page largely duplicates the detail page's Submission library (same photos, same URLs) with a different card design, different timestamp format and a second URL strategy — two... - SubmissionPhotoEvidencePanel.tsx:6-13,123-167 vs SubmissionAttachmentTiles.tsx:183-292; p...
Strengths to keep:
- Per-photo Mapped/Unmapped, Heading recorded and Corrected telemetry badges give an immediate trust signal without reading the numbers (L137...
- Not-recorded values are spelled out ('Not recorded', 'Not mapped', 'Not usable') instead of blanks or nulls (L15-28,147-152).
- Correction history is progressively disclosed in a native <details> element (L155-165).

## Area: Submission detail: header, location hero, GISA card canvas, notes, measurements/3D terrain

### Submission detail page frame and action header  -  `/submissions/:id`
Purpose: Command bar for one GISA technical submission: status, provenance links, and the role-appropriate lifecycle actions (save/submit, approve/return, delete).
Roles: Route is wrapped in ProtectedRoute, not RoleRoute, so ANY authenticated user can open it (web/src/App.tsx:135-142; web/src/auth/ProtectedRoute.tsx:10-16), Edit (Save draft / Submit): roles include raw string FIELD_WORKER or ADMIN AND status DRAFT or REJECTED (web/src/pages/SubmissionDetailPage.tsx:162), Review (Approve / Return): roles include REVIEWER or ADMIN AND status SUBMITTED (SubmissionDetailPage.tsx:161,163), Delete: ADMIN, or DRAFT owned by the current user (SubmissionDetailPage.tsx:165-168), Access sharing card: server flag submission.can_manage_permissions (SubmissionDetailPage.tsx:164)
Primary tasks: Engineer: complete the GISA form and submit (or resubmit) it for review; Reviewer: approve the submission or return it for correction with a note; Anyone: orient (status, parent assessment/incident) and jump to photo evidence

Essential data (9): Page h1 title = descriptor 'DD-County-Route-PM ...; Back link 'Assessment #N' or 'Submissions'; Status badge (DRAFT/SUBMITTED/APPROVED/REJECTED); 'N unmapped' red pill; 'Incident #N' chip link; Photo evidence button label 'N photos · M mappe...; 'Returned for correction: <review_comment>' ban...; Error banner (load/save/submit/review/share/del...; 'Invalid submission id.' / 'Loading...' / 'No d...
Secondary data (4): Status caption ('Ready for reviewer decision', ...; 'View on map' link (Mission Center); Refresh button label 'Working…' while busy; Edit-mode banner 'You are completing this techn...
Noise (1): '· descriptor · owner you / user #N' meta l... (Descriptor repeats the h1 directly above; owner is a raw user id rath...)

Actions: ← Assessment #N / Submissions (back lin... [all]; Photo evidence (link to /submissions/:i... [all]; Refresh [all]; Save draft [canEdit (FIELD_WORKER/ADMIN o...]; Submit for review / Resubmit for review... [canEdit]; Return for correction (red outline) [canAct (REVIEWER/ADMIN on SUB...]; Approve submission (primary brand butto... [canAct]; ••• → Delete submission [canDelete (ADMIN or DRAFT own...]
Entry points: /assessments/:id technical-forms list (backTo resolves to the assessment) — SubmissionDet...; /submissions worklist (route exists: web/src/App.tsx:38-41); Incident and Mission Center pages that link to a submission; Deep link /submissions/:id?section=terrain scrolls to the 3D terrain block — web/src/feat...; Sidebar: no Submissions nav item; 'Assessments' is highlighted for /submissions/* — web/s...
Layout: Single column page (space-y-4 p-4) inside AppShell; header is a flex-wrap row with a flex-wrap action cluster on the right; no Tailwind breakpoint classes in the header itself.
Breakpoints used: none in SubmissionDetailHeader.tsx (flex-wrap only: lines 83, 89, 117), AppShell sidebar collapse handled elsewhere
Phone risks:
- Action cluster wraps to 2–3 rows at 375px (Photo evidence + Refresh + Save draft + Submit + •••), pushing the form below the fold (SubmissionDetailHeader.tsx:117-158)
- Buttons are px-3 py-2 text-sm (~36px tall), below the 44px touch minimum (SubmissionDetailHeader.tsx:26)
- Photo-heading count is only in a title tooltip, invisible on touch (SubmissionDetailHeader.tsx:119)
Tablet risks:
- Fits on one row at 768px only when no review actions are present; SUBMITTED + ADMIN shows 6 controls and wraps
Pain points (blocker/major):
- [major] Role gating uses the raw string 'FIELD_WORKER' instead of the canonical GEOTECH_ENGINEER alias set from roleModel, so a user carrying only GEOTECH_ENGINEER gets a read-only form; ... - SubmissionDetailPage.tsx:161-162 vs web/src/utils/roleModel.ts:12,27-30
- [major] The submit comment (engineer) and the reviewer note (reviewer) are typed at the bottom of a very long page, while the Submit / Approve / Return buttons that consume them sit in th... - SubmissionDetailPage.tsx:1282-1284 (placeholder even says 'when you submit for review fro...
- [major] Refresh silently discards unsaved edits; there is no dirty-state indicator, no beforeunload guard, and no 'saved' confirmation. - SubmissionDetailPage.tsx:262-330 (load overwrites draft), 366, 1182
- [major] All validation and API errors surface in one banner under the header, far from the offending card (e.g. soil percentages in the Material card). - SubmissionDetailPage.tsx:228-247,368-372,1205
Strengths to keep:
- Status-aware captions and a 'Resubmit for review' label when the record was returned (SubmissionDetailHeader.tsx:91-99; SubmissionDetailPag...
- Back link resolves to the parent assessment rather than a generic list (SubmissionDetailHeader.tsx:77-79)
- Destructive delete is tucked into an overflow menu and styled red; primary CTA uses the brand fill so hierarchy is clear (SubmissionDetailH...

### Location and ERIS map hero  -  `/submissions/:id (section 'Location and ERIS map')`
Purpose: Show where the incident is (stored D/C/R/PM plus coordinates) and let the engineer fix the point, draw the affected geometry, and see mapped photo evidence on an ArcGIS map.
Roles: Visible to every user who reaches the page, Latitude/Longitude, Northing/Easting, GPS autofill and map Sketch tools only when canEdit (SubmissionLocationHero.tsx:109-119,153,167,189,203; SubmissionArcGisMap.tsx:194-249)
Primary tasks: Verify or set the incident coordinates; Draw or adjust the affected-area geometry on the map; Check photo geotag coverage before review

Essential data (5): Latitude / Longitude inputs; State plane conversion error; Geometry save status ('Saving map geometry...',...; Photo loading / error text; Map: hybrid basemap, blue submission point, red...
Secondary data (7): Stored District / County / Route / Post mile ti...; 'CCS83 Zone N · US survey ft' + Northing / East...; Mapped evidence legend: submission point, N map...; 'Photo evidence details' link; Photo popup: thumbnail, Captured, Camera headin...; ArcGIS widget chrome: Home, Locate, Compass, Sc...; 'Expand map' button / expanded modal (66vh)
Noise (0): 

Actions: Use GPS autofill / Detecting… [canEdit]; Show N/E / Hide N/E [all (disabled until a county ...]; Edit Latitude / Longitude (formatCoordi... [canEdit]; Edit Northing / Easting (converted on b... [canEdit]; Photo evidence details (link) [all]; Expand map / Close expanded map (Esc) [all]; ArcGIS widgets (search, basemap, layers... [all]; Sketch: draw point/polyline/polygon/rec... [canEdit]
Entry points: Rendered second on the page, directly under the header/banners (SubmissionDetailPage.tsx:...
Layout: grid gap-4, two columns from lg: [minmax(280px,380px)] fields + [minmax(0,1fr)] map; below lg the fields stack above the map. Inner value/coord grids are grid-cols-2 at all widths. Map height is a fixed 360px prop.
Breakpoints used: lg:grid-cols-[minmax(280px,380px)_minmax(0,1fr)] (SubmissionLocationHero.tsx:132), md:p-4 (SubmissionLocationHero.tsx:102), no sm/xl/2xl
Phone risks:
- 360px-tall map with 11 ArcGIS widgets plus the custom 'Expand map' button at right-2 top-2 overlapping the ArcGIS top-right Expand stack (SubmissionArcGisMap.tsx:183-192 vs 613-61...
- grid-cols-2 stored-value tiles at 375px give ~150px cells; values truncate with title-only overflow (SubmissionLocationHero.tsx:49-51,134)
- Hero buttons are text-xs py-1.5 (~30px) and the Expand-map button px-2 py-1 (~26px): below touch minimum (SubmissionLocationHero.tsx:114,124; SubmissionArcGisMap.tsx:618)
- Sketching on touch works in ArcGIS but the Sketch Expand icon competes with Measurement and Coordinates in the bottom-right corner
Tablet risks:
- At 768–1023px the fields stack over the map, so the map is full width but still only 360px tall; the expanded modal (min(96vw,1400px), 66vh) is the only way to get a useful map ar...
Pain points (blocker/major):
- [major] Three vocabularies for the same location facts on one screen: raw codes in the hero ('03', county code, '050'), 'District 3' + county name in the Report Header selects, and the co... - SubmissionLocationHero.tsx:135-138; SubmissionDetailPage.tsx:826,845; submissionLabel.ts:...
- [major] Hero shows the STORED gisa values while the Report Header edits the DRAFT; after changing district in the card the hero keeps the old value until Save draft, with no explanation o... - SubmissionLocationHero.tsx:135-138 (gisa?.district) vs SubmissionDetailPage.tsx:811-827 (...
- [major] Mixed persistence model: map geometry autosaves on every sketch completion, while every other field waits for Save draft; the same geometry is also editable as raw JSON in the Not... - SubmissionDetailPage.tsx:399-424 vs 332-364; 1271-1273
- [major] Eleven ArcGIS widgets plus a custom Expand button on a 360px map; the custom button overlaps the widget stack and the map is chrome-heavy on small screens. - SubmissionArcGisMap.tsx:152-214,613-623; SubmissionLocationHero.tsx:259
- [major] GPS autofill calls the public ArcGIS geocoder directly from the browser and guesses the route from any 1–3 digit number in the address text, silently overwriting county/district/r... - SubmissionDetailPage.tsx:463-482; submissionDetailModel.ts:194-197
Strengths to keep:
- State Plane N/E is hidden behind a toggle and auto-derives from lat/lon (SubmissionLocationHero.tsx:120-128,172-208)
- Legend swatches match the actual map symbols and include live counts (SubmissionLocationHero.tsx:229-249)
- Geometry autosave has role=status feedback and error colouring (SubmissionLocationHero.tsx:211-215)

### GISA sheet card canvas  -  `/submissions/:id (section 'GISA Sheet')`
Purpose: Data-entry surface for the GISA checklist organised as ten draggable, resizable, absolutely positioned cards (Report Header, Distribution, Highway Status, Incident Type, Material, Pavement/Ground Status, Vegetation on Slope, Water/Drainage, Water Content, Mea...
Roles: All users see the cards; inputs are wrapped in <fieldset disabled> unless canEdit (SubmissionDetailPage.tsx:108,725), Layout tools (drag, resize, Tidy, Reset, Full screen) are available to every role, including read-only viewers (SubmissionDetailPage.tsx:762-794)
Primary tasks: Fill in or verify the GISA checklist values section by section; Open the attachments the field crew tagged to a section; Reviewer: scan the sheet for completeness

Essential data (11): Card header: grip icon + uppercase title + 'Ope...; Report Header: Report Date (YYYY-MM-DD) and Dat...; Report Header: District select ('District N'), ...; Distribution: six icon buttons (40px PNG + labe...; Highway Status: 'Cause Of Highway Status' text;...; Incident Type: 13 chips (Rock Fall … Heaving) +...; Material: Rock / Soil; Bedding / Joints / Fract...; Pavement / Ground Status: Cracks YES/NO; Length...; Vegetation on Slope: Trees / Bushes-Shrubs / Gr...; Water / Drainage: Clogged Inlet, Compromised Dr...; Water Content: Dry / Moist / Wet / Flowing; See...
Secondary data (3): Report Header: EA, Project ID; Report Header: District Contacts accordion (Fir...; Drag ghost tooltip 'Moving: <card title>'
Noise (2): Toolbar: 'GISA Sheet' title, 'Custom layout... (Layout-mode state is irrelevant to the field task; the hint describes...); Report Header: 'Raw Contact Data' <details>... (Debug fallback shown when the stored text is not parseable JSON.)

Actions: Tidy layout [all (only in custom layout)]; Reset layout [all]; Full screen / Exit full screen (Esc) [all]; Drag card by header (mouse only, 5px th... [all]; Resize card: right edge (6px), bottom e... [all]; Open attachments (n) → section attachme... [all]; Chips / inputs / selects per card [canEdit]; Add District Contact / Remove Contact /... [canEdit (toggle: all)]
Entry points: Third block on the page, under the Location hero (SubmissionDetailPage.tsx:1235-1245)
Layout: Absolutely positioned pixel canvas. Cards are a fixed 520px wide (report header 1052px when two columns fit); auto-fit column count = floor((containerWidth-12)/532), so one column below ~1076px. Card heights are fixed p...
Breakpoints used: md:inline for the drag hint only (SubmissionDetailPage.tsx:769), no Tailwind grid breakpoints; layout is computed in JS (submissionLayoutModel.ts:69-70,93-96,117-152; useSubmissionDashboardLayout.ts:136-150,287-295), inner field grids: grid-cols-[repeat(auto-fit,minmax(220px,1fr))] (SubmissionDetailPage.tsx:800,893,990,1050,1068,1091,1145)
Phone risks:
- Every card is 520px wide on a 375px viewport: the right ~145px of each card (attachment button, second input column) is clipped until the user side-scrolls the canvas (submissionL...
- Fixed card heights with inner overflow-auto create nested scroll regions inside the page scroll; touch scrolling gets trapped inside cards (SubmissionDetailPage.tsx:106; submissio...
- Drag/resize are mouse-only; the toolbar still shows Tidy/Reset/Full screen and the cursor-grab header, which do nothing useful on touch (useSubmissionDashboardLayout.ts:154-194)
- Chips are text-xs px-2.5 py-1 (~26px tall) and icon buttons in Distribution are the only comfortably sized targets (SubmissionDetailPage.tsx:61,955)
- Free-text date inputs bring up the full keyboard instead of a date picker (SubmissionDetailPage.tsx:803,807)
Tablet risks:
- At 768–1024px the canvas is one 520px column with ~250–500px of dead space to the right; the report header cannot span two columns so its 300px height forces internal scrolling fo...
- Resize handles are 6px wide hover targets, effectively unusable with a finger (SubmissionDetailPage.tsx:112-113)
Pain points (blocker/major):
- [blocker] Fixed 520px card width on an absolute canvas means horizontal scrolling and clipped inputs on any viewport narrower than ~545px; the form is effectively unusable on a phone. - submissionLayoutModel.ts:69; useSubmissionDashboardLayout.ts:287-295; SubmissionDetailPag...
- [major] Draggable/resizable dashboard tooling (Tidy, Reset, Full screen, custom layout pill, localStorage persistence) adds cognitive load to what is a checklist form, and none of it work... - SubmissionDetailPage.tsx:762-794,95-120; useSubmissionDashboardLayout.ts:154-256
- [major] Fixed card heights force nested scrolling: Measurements defaults to 980px holding a 460px 3D scene + diagram + 8 inputs; Report Header is 300px with an expanding contacts accordio... - submissionLayoutModel.ts:29,39; SubmissionDetailPage.tsx:106,872-941,1132-1155
- [major] Report Date and Date Incident Reported are free-text 'YYYY-MM-DD' inputs rather than type=date. - SubmissionDetailPage.tsx:802-807
- [major] Invisible cross-panel dependency: 'Open Highway Traffic Lanes' appears only when the OPEN_HIGHWAY_TRAFFIC chip in the Notes panel (far below) is selected; highway status chips app... - SubmissionDetailPage.tsx:499-506,977-1010,1276-1277
- [major] Toggle chips convey selected state by colour only (brand border/text vs line), with no aria-pressed and no check glyph. - SubmissionDetailPage.tsx:61-62,984,1020,1039-1046,1063,1101,1107-1108,1121
Strengths to keep:
- Card sections mirror the paper GISA sheet and the data dictionary sections A–M (submissionLayoutModel.ts:42-54; docs/GISA_DATA_DICTIONARY.m...
- Conditional reveal keeps cards short: Cracks→dimensions, Rock→subtypes, Soil→percentages, Flowing→Seep/Spring, Lanes closed→count (Submissi...
- District→County→Route cascading selects with normalised lookups prevent invalid combinations (SubmissionDetailPage.tsx:809-858; caltransLoo...

### Measurements card with 3D terrain scene  -  `/submissions/:id (canvas card 'Measurements'; deep link ?section=terrain)`
Purpose: Capture landslide geometry measurements (H, alpha, Wd, Ld, Hs, beta, Lr, Wr) against a reference diagram, with an interactive ArcGIS 3D terrain scene of the incident for context.
Roles: All users see the scene and the diagram, Measurement inputs only when canEdit (inside the disabled fieldset), 'Sample terrain' / 'Refresh terrain samples' is rendered via the tools slot OUTSIDE the disabled fieldset, so read-only viewers can trigger the backend USGS sampling POST (SubmissionDetailPage.tsx:83-84,107,1134-1140; SubmissionMeasurementContext.tsx:39-53,67-74)
Primary tasks: Enter the eight field measurements using the diagram as a key; Inspect slope/road context in 3D before or during review; Sample USGS terrain around the point so the road-bearing and extent overlays exist

Essential data (8): Scene overlay panel: incident label 'Submission...; Non-blocking amber warning (imagery or elevatio...; Loading spinner 'Loading 3D terrain & imagery…'...; Blocking error '3D map could not load' + explan...; Empty state '3D terrain map unavailable' when c...; Terrain sampling error / terrain.error; Landslide measurement diagram image (H, alpha, ...; Eight numeric inputs: Slope Height ft (H), Orig...
Secondary data (3): '3D terrain' label + 'Terrain samples YYYY-MM-D...; Satellite / Topographic basemap buttons; Reset ...; Overlay chips: Incident, Road bearing, Sample e...
Noise (0): 

Actions: Sample terrain / Refresh terrain sample... [all, including read-only view...]; Satellite / Topographic [all]; Reset view [all]; Full screen / Exit full screen (Fullscr... [all]; Overlay toggles Incident / Road bearing... [all]; Retry [all]; Home / Compass ArcGIS widgets; drag/til... [all]; Edit the eight measurement inputs [canEdit]
Entry points: Last card in the canvas flow (submissionLayoutModel.ts:15); ?section=terrain deep link scrolls #terrain-3d-section into view after 400ms (SubmissionM...
Layout: Scene is a fixed 460px-tall block at the top of a 520px-wide, 980px-tall canvas card whose body scrolls internally; diagram and inputs follow below inside the same scrolling card. Inputs use auto-fit minmax(220px,1fr).
Breakpoints used: none; fixed height prop 460 (InteractiveTerrainScene.tsx:73; SubmissionMeasurementContext.tsx:83), card size 520×980 (submissionLayoutModel.ts:39), input grid auto-fit (SubmissionDetailPage.tsx:1145)
Phone risks:
- Scene captures wheel/touch for camera control inside a card that scrolls inside a page that scrolls: three nested scroll/gesture surfaces (SubmissionDetailPage.tsx:106; Interactiv...
- Controls are 9–10px text (overlay chips text-[9px], buttons text-[10px], sample button text-[10px]) far below legibility and touch minimums (InteractiveTerrainScene.tsx:420,427,43...
- A high-quality SceneView (qualityProfile 'high') is mounted automatically for every viewer, heavy on mobile GPUs and data (InteractiveTerrainScene.tsx:161)
- The 520px card is clipped at 375px, so the scene's right-hand controls are off-screen (see canvas blocker)
Tablet risks:
- Card inner scroll hides the measurement inputs ~700px below the top of the card; users may not realise the inputs exist
- Native Fullscreen API generally unavailable on iPadOS Safari for arbitrary elements, so the fixed inset-0 CSS fallback is used (InteractiveTerrainScene.tsx:319-344; terrainScene.t...
Pain points (blocker/major):
- [major] The card is titled 'Measurements' but opens with a 460px 3D scene; the diagram and the eight inputs the card exists for are pushed below an internal scroll. - SubmissionDetailPage.tsx:107-110,1132-1155; submissionLayoutModel.ts:39
- [major] 9–10px control text inside the scene and the sample button; 8px attribution. - InteractiveTerrainScene.tsx:409,420,427,436,444,531,542; SubmissionMeasurementContext.tsx...
- [major] Scene camera gestures conflict with the card's overflow-auto and the page scroll (nested scroll trap). - SubmissionDetailPage.tsx:106; InteractiveTerrainScene.tsx:402-403
- [major] A heavyweight ArcGIS SceneView is auto-mounted on every visit for every role, even reviewers who only need the checklist. - SubmissionMeasurementContext.tsx:7,78-102; InteractiveTerrainScene.tsx:153-162
Strengths to keep:
- Overlay chips are disabled with line-through when no real data backs them, so the scene never invents geometry (InteractiveTerrainScene.tsx...
- Health probing distinguishes blocking failure (Retry) from non-blocking warnings (terrainScene.ts:353-387; InteractiveTerrainScene.tsx:118-...
- Stable SceneView anchor prevents camera resets on parent re-render (terrainScene.ts:55-65; InteractiveTerrainScene.tsx:90-99)

### Notes and actions panel  -  `/submissions/:id (section 'Notes and actions')`
Purpose: Narrative notes for the GISA record, raw geometry JSON, immediate and follow-up action codes, and the optional submit comment.
Roles: All users see the panel; fieldset disabled unless canEdit (SubmissionDetailPage.tsx:1249), Submit comment textarea only when canEdit (SubmissionDetailPage.tsx:1280-1285)
Primary tasks: Write the observation / event / assessment / recommendation narrative; Record immediate and follow-up actions; Add a comment to accompany submission

Essential data (3): Observations (3 rows), Record of Event, Mainten...; Immediate actions chips / Follow-up actions chi...; Submit comment (optional) textarea with placeho...
Secondary data (0): 
Noise (1): Geometry JSON textarea (font-mono, placehol... (Raw JSON duplicate of the map sketch; parse failure only surfaces on ...)

Actions: Edit six note textareas [canEdit]; Open attachments (n) per note [all]; Edit Geometry JSON [canEdit]; Toggle immediate / follow-up action chi... [canEdit (enforced by the disa...]; Type submit comment [canEdit]
Entry points: Fourth block on the page, after the canvas (SubmissionDetailPage.tsx:1247)
Layout: Fluid CSS grid: notes use repeat(auto-fit, minmax(min(320px,100%),1fr)); actions use grid-cols-1 lg:grid-cols-2; chips wrap.
Breakpoints used: [grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr))] (SubmissionDetailPage.tsx:1250), lg:grid-cols-2 (SubmissionDetailPage.tsx:1275)
Phone risks:
- Works: single column with full-width textareas
- Action chips are rounded-full px-2 py-1 text-xs (~26px) targets (SubmissionDetailPage.tsx:1276-1277)
- Two-row textareas are cramped for long narrative on a soft keyboard (SubmissionDetailPage.tsx:67-71)
Tablet risks:
- Two-column notes at ≥~680px; fine
- Actions stay single column until lg (1024px)
Pain points (blocker/major):
- [major] Submit comment is separated from the Submit button by the whole page; the placeholder text itself apologises for it. - SubmissionDetailPage.tsx:1282-1284 vs SubmissionDetailHeader.tsx:129
- [major] Raw Geometry JSON textarea exposed to field users, duplicating the map sketch; invalid JSON throws only on Save. - SubmissionDetailPage.tsx:1270-1273,335-338
- [major] Action chips have no aria-pressed and rely on colour/tint for selected state. - SubmissionDetailPage.tsx:1276-1277
Strengths to keep:
- Fluid auto-fit grid with min(320px,100%) is the most responsive layout on the page (SubmissionDetailPage.tsx:1250)
- Every textarea has an id and htmlFor label (SubmissionDetailPage.tsx:1257,1261,1271-1272,1282-1283)
- Per-note attachment buttons connect mobile-tagged evidence to the right narrative field (SubmissionDetailPage.tsx:1252-1258)

### Submission library and per-section attachments dialog  -  `/submissions/:id (section 'Submission library'; modal '<Section> attachments')`
Purpose: Browse every file attached to the submission (photos, videos, documents) with the GISA section it was captured under, and open or download them via short-lived object-storage URLs.
Roles: All users who reach the page
Primary tasks: Find and view the evidence for a section; Download a file

Essential data (5): Header 'Submission library' + count label 'N it...; Tile: thumbnail or media glyph, media badge, se...; Inline viewer (image / video / PDF iframe / 'Pr...; Dialog title '<Section> attachments' + '<counts...; Empty states 'No files are attached…', 'No file...
Secondary data (1): Filter tabs All / Photos / Videos / Documents w...
Noise (0): 

Actions: Filter tabs [all]; Open ▾ → Open here / Open in a new tab ... [all]; Download [all]; Back to files / New tab / Download (inl... [all]; Close (X) section dialog [all]
Entry points: Fifth block on the page (SubmissionDetailPage.tsx:1288); 'Open attachments (n)' buttons in card headers and note labels open the dialog (Submissio...
Layout: Tile grid repeat(auto-fill, minmax(min(200px,100%),1fr)); dialog max-w-5xl, max-h-[88vh], internal scroll.
Breakpoints used: [grid-template-columns:repeat(auto-fill,minmax(min(200px,100%),1fr))] (SubmissionAttachmentTiles.tsx:394), @media (hover: none) shows tile actions permanently (index.css:138-142)
Phone risks:
- Open ▾ menu pops upward (bottom-full) and can clip above the first row (SubmissionAttachmentTiles.tsx:164)
- Filter tab row wraps under the title at 375px
Tablet risks:
- Three tiles per row; fine
Pain points (blocker/major):
- (none)
Strengths to keep:
- Hover affordances degrade to always-visible on touch (index.css:138-142)
- Presigned URL caching with early refresh avoids repeated API calls (SubmissionAttachmentTiles.tsx:16-75)
- Inline viewer supports image, video and PDF with a graceful fallback (SubmissionAttachmentTiles.tsx:309-320,350-361)

### Review context cards (Summary, Reviewer Note, Workflow History, Access Sharing)  -  `/submissions/:id (bottom card grid)`
Purpose: Support the review decision with record identity and timestamps, the reviewer's note, the full status-transition history, and read-access grants.
Roles: Summary, Reviewer Note (read-only unless REVIEWER/ADMIN) and Workflow History: all users (SubmissionDetailPage.tsx:1290-1307; SubmissionReviewerSupport.tsx:24-36), Access Sharing: only when can_manage_permissions (SubmissionDetailPage.tsx:1309-1319)
Primary tasks: Reviewer: write the note that accompanies Approve/Return; Audit who did what and when; Grant or revoke read access

Essential data (2): Reviewer Note textarea + subtitle 'Recorded wit...; Workflow History (N): event label, 'Event <RAW_...
Secondary data (2): Summary rows: Descriptor, Submission ID, Create...; Access Sharing: 'Find a user' search, Available...
Noise (0): 

Actions: Edit reviewer note [REVIEWER / ADMIN]; Grant read access / Revoke access [can_manage_permissions]
Entry points: Last block on the page (SubmissionDetailPage.tsx:1290-1320)
Layout: Card grid repeat(auto-fit, minmax(min(420px,100%),1fr)); summary rows are a 3-column grid (label / value spanning 2).
Breakpoints used: [grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr))] (SubmissionDetailPrimitives.tsx:65), grid-cols-3 rows (SubmissionDetailPrimitives.tsx:22)
Phone risks:
- Raw ISO timestamps wrap awkwardly in the 2/3-width value column at 375px (SubmissionDetailPage.tsx:1294-1297)
Tablet risks:
- Two cards per row from ~860px; fine
Pain points (blocker/major):
- [major] Reviewer note is written at the bottom of the page but consumed by Approve/Return buttons in the header. - SubmissionDetailPage.tsx:1301-1307,375; SubmissionDetailHeader.tsx:133-142
Strengths to keep:
- Always-open cards with explanatory subtitles (SubmissionDetailPrimitives.tsx:29-61; SubmissionReviewerSupport.tsx:24,38)
- Sharing copy explains that it does not change ownership or edit rights (SubmissionAccessSharing.tsx:33)
- Workflow comments are shown inline under each transition (SubmissionReviewerSupport.tsx:60-64)

## Area: Terrain Cross Sections GIS workspace

### Terrain cross-section scene (3D map canvas, floating toolbar, overlays)  -  `/gis/terrain-cross-sections`
Purpose: Let an operational user click a multi-point path onto Esri 3D terrain, sample an ArcGIS World Elevation profile along it, and hand off to the analysis panels, Save dialog or Aerial capture.
Roles: MAINTENANCE_COORDINATOR / MAINT_COORDINATOR, GEOTECH_OFFICE_CHIEF / OFFICE_CHIEF, GEOTECH_BRANCH_CHIEF / BRANCH_CHIEF, GEOTECH_ENGINEER / FIELD_WORKER, REVIEWER, ADMIN, (gate: RoleRoute roles=OPERATIONAL_ROLE_NAMES at web/src/App.tsx:119-126, defined in web/src/utils/roleModel.ts:17-24; MAINTENANCE_FIELD_WORKER/MAINTENANCE are excluded; the nav entry is only pushed when isOperationalUser at web/src/ui/AppShell.tsx:90-92; there is no per-role gating inside the feature files - every operational role sees every button)
Primary tasks: Place two or more control points on the terrain and build (sample) an elevation profile; Open the Profile / Stats / Points / Setup side panels to inspect the result; Save the cross section to a Project, or export a north-up aerial JPEG

Essential data (12): ArcGIS SceneView: satellite or topo-vector base...; Control-point markers P1..Pn (blue circles + wh...; Control path polyline (dashed while drawing, so...; Sampled DEM profile polyline (yellow, 5px, +1 m...; Red hover marker synced from the profile chart; Drawing hint 'Click terrain to place P{n}' + 'F...; Crosshair cursor while drawing; Right rail labels: Profile, Stats, Points {coun...; Draft pill '{distance} path selected · Build pr...; Profile error alert (role=alert); Loading overlay 'Loading ArcGIS 3D terrain…'; Scene error overlay '3D terrain unavailable' + ...
Secondary data (10): Page heading 'Terrain Cross Sections' (AppShell...; Control-point popup 'Control point P#' with lat...; DEM source-resolution coverage overlay layer (t...; Esri Search widget (top-right), Home and Compas...; 'Saved to {project_number} · {title}' chip unde...; Bottom-left basemap toggle Imagery / Topographic; DEM source coverage legend: 7 colour classes (<...; Scale bar (imperial line + 'SCALE' caption); Bottom pill 'Elevation analysis · Profile + 3D ...; Full-screen hint 'Terrain workspace full screen...
Noise (1): Legend footnote 'Color = finest cataloged E... (Nine-pixel jargon paragraph; unreadable and repeats the Setup panel c...)

Actions: + New [All operational roles]; Add points [All operational roles]; Undo [All operational roles]; Build profile / Finish & profile / Rebu... [All operational roles]; Save / Save changes [All operational roles]; Capture [All operational roles]; Clear [All operational roles]; DEM coverage (toggle, aria-pressed) [All operational roles]; Full screen / Exit full screen (aria-pr... [All operational roles]; Click on terrain (place P{n}) [All operational roles]; Profile / Stats / Points N / Setup (ari... [All operational roles]; Imagery / Topographic [All operational roles]
Entry points: Sidebar › GIS Tools › Terrain Cross Sections (web/src/ui/AppShell.tsx:91), rendered only ...; Direct URL /gis/terrain-cross-sections (web/src/App.tsx:120); non-operational users are r...; No deep link exists for a saved cross section or Project; the route takes no params
Layout: AppShell 'workspace' mode: min-h-screen, lg:h-screen lg:overflow-hidden shell with the nav as a card above the content below lg and a sticky w-64/w-16 column at lg+ (AppShell.tsx:138, 163-185). The workspace root is rel...
Breakpoints used: None inside TerrainCrossSectionWorkspace.tsx - no sm/md/lg classes; layout is purely absolute + calc(), sm:grid-cols-4 on the chart hover-field grid (CrossSectionProfileChart.tsx:82) and on the slice stats grid (TerrainSlice3D.tsx:623), AppShell: lg:hidden / lg:block nav, lg:flex-row, md:px-6 (AppShell.tsx:163-166), Fixed pixel values: min-h-[620px] (594-596), max-w-[calc(100%-360px)] (600), w-[min(720px,...)] / w-[min(360px,...)] (713-715), w-64 legend (954), min-w-[520px] chart SVG (ProfileChart:104), h-[430px] slice scene (TerrainSlice3D:424, 603), left-[17.5rem] hint offset (991)
Phone risks:
- Toolbar max-w-[calc(100%-360px)] computes to <= 0 at 375px (content width 343px), so the nine flex-wrap buttons stack one per row overflowing a 12px-wide dark box that overlaps th...
- The map is a 620px-tall box inside a scrolling page (min-h-[620px], 596); SceneView captures touch for pan/tilt so scrolling past it is a classic map trap, and Full screen (the fi...
- Aside panel becomes 279px wide (calc(100%-6rem)) at right-20, covering the map; the grid-cols-4 metric row squeezes to ~65px cells and the chart SVG min-w-[520px] forces horizonta...
- Bottom row collides: basemap pill (left), the centred 'Elevation analysis' pill (~330px of text) and the scale bar (right) overlap at 375px (940-951, 975-983, SceneDualScaleBar.ts...
- Touch targets ~30-32px: toolbar px-3 py-2 text-xs, rail min-w-16 py-2, close button h-8 w-8, basemap pill py-2 text-[11px] (606, 1051, 730, 946)
Tablet risks:
- 768px portrait: content width 720px minus 360 leaves a 360px toolbar, so buttons wrap to three rows that overlap the 'Click terrain to place' hint at top-16 (600, 698-703)
- 1024px landscape (lg): the w-64 nav appears so the workspace is ~704px wide; toolbar max-w is 344px (still 3 rows) and the wide Profile panel is 608px at right-20, hiding almost a...
- Below lg the workspace does not fill the viewport (h-full of an auto parent = 620px) so a 1024px-tall tablet shows a short map with page scroll; only at lg+ does lg:h-screen kick ...
- Slice tab: a 430px ArcGIS SceneView with wheel/touch zoom sits inside an overflow-y-auto aside, creating a scroll trap when the user tries to reach the stats below it (TerrainSlic...
Pain points (blocker/major):
- [blocker] Toolbar width calc breaks below ~1360px viewport and collapses completely on phones - TerrainCrossSectionWorkspace.tsx:600 max-w-[calc(100%-360px)] with flex-wrap at 601; no b...
- [major] Only 'Undo last point' exists: no drag, delete or reorder of an individual control point, and the Points panel is read-only - TerrainCrossSectionWorkspace.tsx:445-453, 833-845
- [major] '+ New' and 'Clear' wipe the path, profile and saved-state with no confirmation; 'Add points' silently discards the built profile - TerrainCrossSectionWorkspace.tsx:423-433, 435-443, 455-465
- [major] Saved cross sections cannot be reopened: the API exposes getSavedCrossSection/listProjectCrossSections but no screen calls them, and the 'Saved to' state dies on New/Clear/navigat... - web/src/api/terrainCrossSections.ts:84-92 (no callers); TerrainCrossSectionWorkspace.tsx:...
- [major] Same facts shown up to five times: Path/Samples/Spacing/Source coverage in the panel subtitle, metric row, DEM block, Stats panel, Setup card and bottom pill; demQualityNote rende... - TerrainCrossSectionWorkspace.tsx:583, 761-764, 773-774, 810-815, 899-904, 982; 771 and 90...
- [major] Esri-internal vocabulary leaks into user copy: 'Terrain3D', 'Data Extents catalog', 'PixelSize footprint', 'finest-contiguous'; long caveat paragraphs are shown by default rather ... - TerrainCrossSectionWorkspace.tsx:77-95, 767-776, 870-872, 893-895, 931-933, 967-969
Strengths to keep:
- Chart-to-scene hover linkage: moving over the profile drops a red marker at the exact sampled 3D point, with a deliberate shared 1 m Z offs...
- Honest DEM provenance: source-footprint pixel size is kept separate from Terrain3D sampling resolution instead of conflating them (terrainC...
- Adaptive sampling with no distance cap - long transects raise spacing instead of failing, and the Setup copy explains the ~1,800 sample bud...

### Elevation analysis panel (Profile tab and 3D Terrain Slice tab)  -  `/gis/terrain-cross-sections (activePanel = 'profile')`
Purpose: Show the sampled elevation profile as an interactive chart or as a textured 3D corridor slice, with summary metrics and DEM provenance.
Roles: Same as the workspace: all OPERATIONAL_ROLE_NAMES (App.tsx:119-126); no in-panel gating
Primary tasks: Read elevation, distance and grade at any point along the path; Compare min/max/gain/loss and the DEM source resolution; Visualise the terrain corridor in 3D at a chosen width

Essential data (10): Segmented tabs 'Elevation Profile' / '3D Terrai...; Metric row: Path (ft), Samples, Spacing (m), So...; Hover readout: Distance (ft), Elevation (ft), C...; SVG profile: filled area + brand line, 5 y-tick...; Minimum / Maximum / Gain / Loss (ft); Slice: 'Slice width' value (ft) + caption 'Tota...; Slice: range slider 20-1000 m step 10 + presets...; Slice: busy placeholder 'Sampling the DEM acros...; Slice: error alert; Slice: 3D mesh SceneView (430px) with 'Draping ...
Secondary data (7): Panel title 'Elevation analysis' + subtitle '{d...; DEM block 'ArcGIS World Elevation · {mode label...; Chart card title 'DEM cross-section profile' + ...; Slice: 'Surface layer' buttons 'Match map · Ima...; Slice: 'Control points' Show/Hide toggle + 'Sho...; Slice: footer 'Drag to orbit · Scroll to zoom ·...; Slice: Highest terrain / Lowest terrain / Terra...
Noise (1): Slice: explanatory note 'ERIS samples a two... (Implementation description with no decision value for the user.)

Actions: Close panel (×, aria-label) [All operational roles]; Elevation Profile / 3D Terrain Slice ta... [All operational roles]; Hover / pointer-move over chart [All operational roles]; Slice width slider (aria-label) and 4 p... [All operational roles]; Match map / Bare DEM [All operational roles]; Show / Hide control points (aria-presse... [All operational roles]; Orbit / zoom / compass in slice SceneVi... [All operational roles]
Entry points: Auto-opens after a successful Build profile (TerrainCrossSectionWorkspace.tsx:537); Rail 'Profile' button (706); Bottom 'Elevation analysis' pill (976-983)
Layout: Aside w-[min(720px,calc(100%-6rem))] right-20 top-16 bottom-3 overflow-y-auto; inside: grid-cols-4 metric row (no breakpoint), grid-cols-2 DEM pair, chart hover grid grid-cols-2 sm:grid-cols-4, chart overflow-x-auto wit...
Breakpoints used: sm:grid-cols-4 (CrossSectionProfileChart.tsx:82; TerrainSlice3D.tsx:623), No other breakpoints; widths via calc()/min(), Fixed: min-w-[520px] (ProfileChart:104), h-[430px] (TerrainSlice3D:424, 603), h-[58px] hover fields (ProfileChart:169)
Phone risks:
- Panel is 279px wide at 375px; grid-cols-4 metric row cells ~65px so 'Source coverage' label and values like '1.00 m–10.3 m' wrap or clip (760-765)
- Chart requires horizontal scrolling inside the panel (520px min) while the pointer-move handler maps clientX to the scrolled SVG - usable but awkward on touch (ProfileChart:101-10...
- Slice tab: 430px 3D scene + controls + stats inside a 279px panel; the ArcGIS scene captures touch so scrolling the panel over it is trapped (TerrainSlice3D:424)
Tablet risks:
- At 1024px the panel is 608px wide and sits over the map the user is analysing; there is no way to dock it below the map
- Slice scene wheel-zoom inside an overflow-y-auto aside intercepts scroll (TerrainSlice3D:439)
- Hover readout 'Coordinates' (22+ chars at text-xs) truncates in ~140px cells even at 4 columns (ProfileChart:93, 171)
Pain points (blocker/major):
- [major] Chart readout is pointer-only; there is no keyboard or touch-tap way to step through samples - CrossSectionProfileChart.tsx:102-109 (onPointerMove/onPointerLeave only, no tabIndex or k...
- [major] Slice texture is regenerated on every main-map scale change, even though the panel covers the map the user is zooming - TerrainSlice3D.tsx:320 dependency on referenceScale, fed by view.watch('scale') at Terrai...
- [major] Three stacked headings before any data (panel title, tab, card title) plus a 40-word provenance paragraph push the chart below the fold in a 360-720px panel - TerrainCrossSectionWorkspace.tsx:722-776; CrossSectionProfileChart.tsx:77-80
Strengths to keep:
- Control-point markers on the chart (dashed lines + P# labels) map exactly to map labels and slice labels (CrossSectionProfileChart.tsx:137-...
- Hover fields use aria-live=polite and tabular-nums; chart has role=img with a descriptive aria-label (ProfileChart:82, 104-106)
- Chart colours use theme tokens (var(--brand), var(--bad), var(--line)) so it adapts to Light/Dark/Coastal (ProfileChart:110-158)

### Cross-section statistics panel (rail: Stats)  -  `/gis/terrain-cross-sections (activePanel = 'details')`
Purpose: List every profile measurement and DEM sampling figure in one two-column tile grid.
Roles: All OPERATIONAL_ROLE_NAMES; no in-panel gating
Primary tasks: Read elevation min/max/range/gain/loss and start/end values; Check the DEM request mode and resolved source coverage

Essential data (3): Path (ft) - draft length before a profile, samp...; Elevation range, Minimum, Maximum, Gain, Loss (...; Start, End elevation (ft)
Secondary data (4): Panel title 'Cross-section statistics' + subtit...; Samples, Spacing (m); DEM request (mode label); Source coverage, Terrain3D sampling
Noise (3): Coverage samples 'covered / total' (Internal count of profile coordinates matched to Esri footprints; unl...); Terrain metadata (= resolution_sample_count) (Number of sampleInfo entries with a finite demResolution; the label d...); '—' placeholders for 13 of 15 tiles before ... (Panel is reachable before a profile but almost empty.)

Actions: Close (×) [All operational roles]
Entry points: Rail 'Stats' button (707)
Layout: Aside w-[min(360px,calc(100%-6rem))]; grid-cols-2 gap-px tiles, no breakpoints.
Breakpoints used: None
Phone risks:
- 279px panel -> ~135px tiles; long values like '1.00 m–10.3 m' and labels 'Terrain3D sampling' wrap to 2-3 lines (809-825)
- Panel covers the map; 15 tiles need scrolling
Tablet risks:
- Fine at 360px; still overlays the map
Pain points (blocker/major):
- [major] Ten of fifteen tiles duplicate the Profile panel; the panel adds only Start/End and two noise counters - TerrainCrossSectionWorkspace.tsx:810-824 vs 761-764, 788-791
Strengths to keep:
- Consistent DrawerMetric tile with uppercase tracked label and tabular-nums value (1058-1065)
- Draft path length is shown before sampling (570, 810)

### Control points panel (rail: Points N)  -  `/gis/terrain-cross-sections (activePanel = 'points')`
Purpose: List the placed control points with cumulative distance, coordinates and resolved elevation.
Roles: All OPERATIONAL_ROLE_NAMES; no in-panel gating
Primary tasks: Verify point order and spacing; Copy a coordinate or read the elevation at a vertex

Essential data (4): Per row: 'P#' label; Per row: cumulative distance from P1 (ft, brand...; Per row: 'Elevation {ft}' or 'Sample profile to...; Empty state 'Start a cross section and click th...
Secondary data (2): Panel title 'Control points' + subtitle '{n} se...; Per row: lat, lon to 6 decimals
Noise (0): 

Actions: Close (×) [All operational roles]
Entry points: Rail 'Points N' button (708)
Layout: Aside 360px; stacked rows with flex justify-between header line.
Breakpoints used: None
Phone risks:
- Rows fit in 279px; the panel hides the markers it describes
Tablet risks:
- None beyond overlay coverage
Pain points (blocker/major):
- [major] Read-only list: cannot delete, reorder, nudge, or zoom to a point; the map popup is the only per-point interaction - TerrainCrossSectionWorkspace.tsx:833-845
Strengths to keep:
- Cumulative chainage per vertex is exactly what field engineers need for a section (837)
- Row key is the coordinate pair so React state stays stable on Undo (834, 59-61)

### Cross-section setup panel (rail: Setup)  -  `/gis/terrain-cross-sections (activePanel = 'settings')`
Purpose: Choose profile sample spacing, the Terrain3D elevation query mode, and the basemap.
Roles: All OPERATIONAL_ROLE_NAMES; no in-panel gating
Primary tasks: Pick sample spacing (1-50 m); Pick DEM query mode (best available / auto / target 1, 3, 10 m); Switch basemap

Essential data (1): 'Profile sample spacing' select: 1 m maximum de...
Secondary data (5): Panel title 'Cross-section setup' + subtitle 'S...; Spacing caveat paragraph ('This controls profil...; 'Terrain3D elevation query' select with 5 modes; 'Basemap' Imagery / Topographic buttons; Units note ('Terrain distances and elevations a...
Noise (2): Query caveat paragraph ('...not used as pro... (Fifty words of Esri internals; repeats the Profile panel note.); If profile: 'Source footprint resolution' /... (Third repetition of the same two values and paragraph.)

Actions: Sample spacing select [All operational roles]; DEM query mode select [All operational roles]; Imagery / Topographic [All operational roles]; Close (×) [All operational roles]
Entry points: Rail 'Setup' button (709)
Layout: Aside 360px; space-y-5 sections; full-width selects; grid-cols-2 basemap buttons.
Breakpoints used: None
Phone risks:
- Native selects are fine on touch; the three caveat paragraphs make the panel ~900px tall and require scrolling inside a 279px panel
- Selects have no associated <label> element (uppercase div headings only) so the accessible name is missing (852-853, 876-877)
Tablet risks:
- None specific
Pain points (blocker/major):
- [major] Three caveat paragraphs and a repeated resolution card make the settings panel mostly prose - TerrainCrossSectionWorkspace.tsx:870-872, 893-908, 931-933
Strengths to keep:
- Spacing option labels pair the number with intent ('25 m — long transects') (863-868)
- Auto-rebuild keeps the profile in sync with settings (858, 882)

### Save cross section dialog  -  `/gis/terrain-cross-sections (modal, saveDialogOpen)`
Purpose: Persist the current control points and profile snapshot under a named cross section inside a cross-section Project, creating the Project inline if needed.
Roles: All OPERATIONAL_ROLE_NAMES; no in-dialog gating (server enforces)
Primary tasks: Pick or create a Project; Name the cross section and save/update it

Essential data (4): Title 'Save cross section' / 'Update cross sect...; Project select ('Choose a Project' + '{number} ...; Name input (default 'Cross Section'); Error alert (red-50 light-theme colours)
Secondary data (4): Inline create form: Project number, Project tit...; Selected project card '{number} · {title}' + 'D...; Notes textarea; Metrics: Points, Samples, Spacing (m)
Noise (0): 

Actions: Close (text button) [All operational roles]; + Create Project / Cancel new Project (... [All operational roles]; Create and select [All operational roles]; Save to Project / Update cross section ... [All operational roles]
Entry points: Toolbar 'Save' / 'Save changes' (TerrainCrossSectionWorkspace.tsx:640-647)
Layout: fixed inset-0 z-[140] flex items-center p-4; card w-full max-w-3xl; body grid gap-5 p-5 md:grid-cols-2.
Breakpoints used: md:grid-cols-2 (CrossSectionSaveDialog.tsx:140)
Phone risks:
- Card has no max-height or overflow-y-auto; with the create-project form open the stacked content (~750px) exceeds an 812px viewport minus padding and is clipped with no way to scr...
- Inputs are py-2.5 (~40px) - acceptable; Close is py-1.5 (~32px)
Tablet risks:
- Two columns at 768px are 330px each - fine
Pain points (blocker/major):
- [major] No max-height/scroll on the dialog card, so tall content is clipped on short viewports - CrossSectionSaveDialog.tsx:130-131 (compare AerialCaptureDialog.tsx:431-433 which has max...
- [major] Dialog has role=dialog aria-modal but no aria-labelledby, no focus trap, no Escape handling; labels use <label> without htmlFor and the create-project inputs rely on placeholders - CrossSectionSaveDialog.tsx:130, 158-160, 171, 175
- [major] 'Project' vocabulary conflicts with the rest of ERIS, which redirects /projects to Event Groups; cross-section Projects are a separate entity - CrossSectionSaveDialog.tsx:135, 148, 153; web/src/App.tsx:77-78; api/terrainCrossSections...
Strengths to keep:
- Create-or-select Project inline without leaving the flow (152-163)
- Save button disabled rules exactly mirror the payload requirements (183)
- Update path reuses the same dialog with prefilled name/notes/project (44-46, 117-119)

### Aerial capture dialog  -  `/gis/terrain-cross-sections (modal, captureDialogOpen)`
Purpose: Render a north-up satellite JPEG of the control points with north arrow, feet scale bar and attribution, then copy or download it.
Roles: All OPERATIONAL_ROLE_NAMES; no in-dialog gating
Primary tasks: Pick an aspect ratio; Copy or download the JPEG

Essential data (5): Title 'Aerial capture' + 'Export the current cr...; Format buttons 1:1 / 16:9 / 9:16 + '{w} × {h} J...; Error alert / success notice ('JPEG downloaded....; Preview: 'Preparing north-up aerial capture…' /...; Inside the image: P# markers, line, 'N' arrow p...
Secondary data (2): 'Capture standard' checklist (north-up, top-dow...; 'Capture files stay in the browser. ERIS does n...
Noise (0): 

Actions: Close (×, aria-label) [All operational roles]; 1:1 / 16:9 / 9:16 [All operational roles]; Copy JPEG to clipboard (primary) [All operational roles]; Download JPEG [All operational roles]
Entry points: Toolbar 'Capture' (TerrainCrossSectionWorkspace.tsx:649-656)
Layout: fixed inset-0 z-[150] p-4; card grid max-h-[94vh] max-w-5xl overflow-hidden lg:grid-cols-[340px_minmax(0,1fr)]; left pane overflow-y-auto with lg:border-r; preview pane min-h-[420px] overflow-auto bg-slate-950; img max-...
Breakpoints used: lg:grid-cols-[340px_minmax(0,1fr)], lg:border-b-0 lg:border-r (AerialCaptureDialog.tsx:431-433), grid-cols-3 format buttons (453), Fixed: min-h-[420px] (520), max-h-[94vh]/[84vh] (431, 527)
Phone risks:
- Below lg the two panes stack: ~560px of form + a 420px min-height preview inside a 94vh overflow-hidden card; grid rows do not shrink so the preview (and on short phones the Downl...
- Generating a 1400x1400 or 1920x1080 hidden MapView screenshot is heavy on mobile GPUs
Tablet risks:
- 768-1023px portrait: same stacked clipping (card 962px max vs ~980px content)
- 1024px landscape switches to two columns - fine
Pain points (blocker/major):
- [major] 'Copy JPEG to clipboard' (the primary button) writes an image/jpeg ClipboardItem, which the async Clipboard API does not accept in Chrome, Edge, Safari or Firefox (only image/png ... - AerialCaptureDialog.tsx:414-416, 419
- [major] Stacked layout below lg clips the preview/actions because the card is overflow-hidden with a fixed max-height and non-shrinking grid rows - AerialCaptureDialog.tsx:431-433, 520
Strengths to keep:
- Consistent capture standard (north-up, scale bar in feet, attribution) is enforced in code, not left to the user (250-254, 307-309, 329-331)
- Generation-counter and object-URL cleanup prevent stale previews and leaks (353-391)
- Descriptive alt text on the preview and aria-labelledby on the dialog (430, 526)

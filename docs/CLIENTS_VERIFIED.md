# Clients (Web/Mobile) Verified Behavior

## Web

Source: `web/src/App.tsx`, `web/src/ui/AppShell.tsx`, `web/src/pages/*`, `web/src/features/*`

Information architecture (2026-09 redesign, Claude Design handoff):

- `Workspace › My Work` (`/my-work`) — the single queue of workflow steps waiting on the
  signed-in role: coordinator intake triage (Event Group review with map → disposition),
  office-chief delegation (optionally assigning the engineer at delegation), branch-chief
  engineer assignment, engineer draft submissions (multiple per assessment) + submit for
  review, assigned-reviewer approve / request revision, office-chief finalize.
- `Operations` — read-only record views that cross-link to each other and to My Work:
  - Mission Center (`/mission-center/:gid?/:iid?`): statewide Event Groups → group incidents →
    incident GIS evidence with camera-heading wedges; deep-linkable; photo list ↔ map focus.
  - Event Groups (`/event-groups`, `/event-groups/:id`): compact header, incidents table with
    Map / Assessment / Submission links; a grouped incident without a permanent key renders a
    data-integrity error.
  - Incidents (`/incidents`, `/incidents/:id`): tabs "Incident records" / "Awaiting intake";
    no workflow action buttons (they live in My Work); deep link highlights + scrolls the row.
    Reporting roles keep the "New incident" intake panel.
  - Assessments (`/assessments`, `/assessments/:id`): rail + detail (pipeline, next-step banner,
    technical submissions table, assignments, history); state filter + search across
    assessments and their submissions.
- Submissions have no nav item; `/submissions/:id` (+ `/photo-evidence`) stay as deep links
  reached from assessments, incidents, and the map. The legacy worklist remains at `/submissions`.
- `GIS Tools › Terrain Cross Sections`, `Administration › Users / Road Inventory`,
  `Account › Settings` are unchanged apart from the shell restyle (Lucide nav icons,
  collapsible icon rail, header theme switch).

Submission detail (`web/src/pages/SubmissionDetailPage.tsx`):

- Location hero (stored D/C/R/PM rendered verbatim, editable coordinates, ArcGIS map with the
  submission point plus mapped field photos and camera-heading wedges, "Expand map" modal).
- GISA form as a drag/resize card canvas: auto-fit column flow by default (ResizeObserver),
  custom layout after the first drag/resize (`eris_submission_layout_v2`), Tidy / Reset /
  Full screen.
- Per-section "Open attachments (n)" dialogs and the Submission library (Photos / Videos /
  Documents chips, Open here / new tab / new window, Download) replace the attachments table.
- Measurement context shows the 3D Terrain scene only (elevation profile, road-inventory
  context, and USGS relief were removed from this view; backend data untouched).
- Summary / Reviewer Note / Workflow History / Access Sharing are always-open cards.
- Header actions: Save draft / Submit for review (engineer), Approve / Return for correction
  (reviewer); draft banner links the assessment and incident (`context` from the API).

## Mobile

Source: `mobile/app/(tabs)/_layout.tsx`, `mobile/app/(tabs)/*`, `mobile/src/offline/*`

Current tab behavior:

- `Incidents` tab shown for workflow roles (`MAINTENANCE`, `MAINT_COORDINATOR`, `OFFICE_CHIEF`, `BRANCH_CHIEF`, `FIELD_WORKER`, `ADMIN`)
- `Drafts` + `Submissions` tabs only for (`FIELD_WORKER`, `REVIEWER`, `ADMIN`)
- Mission Center tab removed from active mobile tabs.

Incidents mobile API calls request `scope=mobile` for backend-filtered visibility.

## Mobile Target (maintenance-first minimal tabs)

- `MAINTENANCE` should only see two workflow tabs:
  - Create Incident
  - Track Incidents (my incidents + status timeline)
- Other roles should receive only role-essential tabs for their step in the process (smallest viable UI surface).
- This is the current priority and first implementation wave.

## Mobile Offline Layer

Implemented components:

- local drafts:
  - `mobile/src/offline/localDrafts.ts`
  - chunked SecureStore via `secureStoreLarge.ts`
- offline queue:
  - `mobile/src/offline/queue.ts`
  - op types include create submission, patch submission, replace incident types/actions, submit, upload attachment
- sync loop:
  - `mobile/src/offline/syncLoop.ts`
  - interval + app-foreground trigger

## ArcGIS on Mobile

- Native bridge defined in `mobile/src/arcgis/ArcGISNative.ts`
- Supports sketch map flows and runtime key/license methods.
- Mission-center native bridge methods still exist in native code/bridge but are not currently surfaced as a tab.

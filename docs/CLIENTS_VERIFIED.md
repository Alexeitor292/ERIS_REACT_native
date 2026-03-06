# Clients (Web/Mobile) Verified Behavior

## Web

Source: `web/src/App.tsx`, `web/src/ui/AppShell.tsx`, `web/src/pages/*`

Routes:

- `/login`
- `/submissions`
- `/submissions/:id`
- `/incidents`
- `/mission-center`
- `/admin/users`
- `/settings`

Navigation includes Mission Center, Incidents, Submissions, Settings; Admin Users shown for ADMIN.

Mission Center map:

- Uses ArcGIS JS SDK component `web/src/components/MissionCenterMap.tsx`
- Current basemap set to `"osm"` with explicit OSM fallback logic.
- Pin colors: red/yellow/green by incident status.

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

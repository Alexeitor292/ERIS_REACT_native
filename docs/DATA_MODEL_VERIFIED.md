# Data Model (Verified)

Source: `database/init/010_schema.sql` (baseline) + Alembic migrations in
`backend/migrations/versions/` (post-baseline changes).

## Core Identity

- `users`
- `roles`
- `user_roles`

## Submission Domain

- `submissions`
- `workflow_events`
- `submission_visibility`
- `submission_editors`

## Attachment Domain

- `attachments`
- `attachment_links` (includes `section_key`, `kind`, `sort_order`)

## Incident Domain

- `incidents` (now includes `location_id`, `location_match_status`, `location_reviewed_*`)
- `incident_locations`
- `incident_attachments`
- `incident_assignments` (`assignment_stage`, `assignment_mode`, `is_active`)
- `incident_routing_assignments`
- `incident_notifications`
- `incident_submission_links`

## GISA Domain

- `submission_gisa` (wide denormalized paper-form field model)
- `submission_gisa_incident_types`
- `submission_gisa_actions`

## Location-first implementation status

- `incident_locations` is the current first-class location object table.
  - stable identity by District/Country/Route/PM
  - optional geometry and naming metadata
- Keep `incidents` as event rows linked to a location object (`location_id`).
- This enables:
  - many incidents at the same physical location across time,
  - location-level incident history,
  - timeline/pattern queries by location without duplicating location fields in each event.
- Proposed operational relationship:
  - `incident_locations 1 -> N incidents`
  - `incidents 1 -> N incident_attachments`
  - `incidents 1 -> 1 incident_submission_link` (if/when engineering handoff occurs)
- Current implementation now stores identity linkage in `location_id` and uses `incidents` for historical event rows.

## Notes on Schema Source of Truth

- `database/init/010_schema.sql` defines the complete initial schema (19 tables) as of
  git commit `ce447ab`. This is the bootstrap source for fresh Docker installs.
- Alembic baseline `0001_baseline` corresponds exactly to this init SQL. All schema
  changes after commit `ce447ab` must go through Alembic migrations.
- Backend startup calls `check_migration_head()` and fails with a `RuntimeError` if
  the database is not at the current Alembic head. Runtime ALTER TABLE shims have been
  removed. Both local dev and Proxmox are confirmed stamped at `0001_baseline`.
- See `docs/MIGRATIONS.md` for the full migration system documentation.

## Seed Data (`020_seed.sql`)

Seeded roles:

- `FIELD_WORKER`
- `MAINTENANCE`
- `MAINT_COORDINATOR`
- `OFFICE_CHIEF`
- `BRANCH_CHIEF`
- `REVIEWER`
- `ADMIN`

Seeded users (dev/bootstrap):

- `admin@local`
- `maintenance@local`
- `coordinator@local`
- `officechief@local`
- `branchchief@local`
- `engineer@local`
- `reviewer@local`

All seeded users currently use the same argon2 password hash in seed (password string used in development flow).

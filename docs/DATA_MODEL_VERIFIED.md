# Data Model (Verified)

Source: `database/init/010_schema.sql` + runtime upgrade function in `backend/app/routes/incidents.py`.

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

- `incidents`
- `incident_attachments`
- `incident_assignments` (`assignment_stage`, `assignment_mode`, `is_active`)
- `incident_routing_assignments`
- `incident_notifications`
- `incident_submission_links`

## GISA Domain

- `submission_gisa` (wide denormalized paper-form field model)
- `submission_gisa_incident_types`
- `submission_gisa_actions`

## Notes on Schema Source of Truth

- Base schema is declared in `database/init/010_schema.sql`.
- Backend startup currently calls `ensure_incident_runtime_schema`, which can add incident-related columns/tables if missing:
  - `incidents.first_observed_at`
  - `incidents.first_occurred_at`
  - `incidents.office_code`
  - `incidents.current_stage`
  - `incident_assignments.assignment_stage`
  - `incident_routing_assignments` table
  - `incident_notifications` table

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

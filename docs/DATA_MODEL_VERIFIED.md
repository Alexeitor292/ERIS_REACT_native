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
- `incident_notifications` (now also the **email outbox**: `delivery_attempts INT
  NOT NULL DEFAULT 0`, `last_error VARCHAR(255) NULL`, `last_attempt_at DATETIME
  NULL`, and `idx_inc_notify_outbox (channel, delivered_at, last_attempt_at, id)`
  — migration `20260910_routing_v2`. `chk_inc_notify_channel` already permitted
  `EMAIL`, so the channel needed no change.)
- `incident_submission_links`

## Assessment Domain

- `assessments` (one per incident; `submission_id` = latest technical form)
  - `routing_path VARCHAR(24) NULL` — the routing v2 route discriminator, with
    `chk_assessment_routing_path (routing_path IS NULL OR routing_path IN
    ('BRANCH','SENIOR_ENGINEER'))` and `idx_assessment_routing (routing_path,
    state)`. `NULL` means the office chief has not chosen yet; the choice is not
    reversible.
  - `assigned_engineer_user_id` holds the assignee on **both** routes — on a
    `SENIOR_ENGINEER` row it names a senior engineer, not a Staff member. The
    column keeps its name because renaming it is destructive; the API exposes
    `assigned_user_id` / `assigned_user_kind` instead.
  - `state` — `APPROVED` is terminal. `FINALIZED` is legacy history and
    `trg_assessment_no_new_finalize` (BEFORE UPDATE, `FOLLOWS
    trg_assessment_engineer_elig_bu`) signals `45000` on any new transition into
    it. `chk_assessment_state` is untouched, so every existing row stays valid.
- `assessment_submissions` (join: every technical submission attached to an assessment — migration `20260904_assessment_subs`)
- `assessment_assignments` — `assignment_role` widened to `VARCHAR(24)`
  (`'SENIOR_ENGINEER'` is 15 characters and would have fitted the original
  `VARCHAR(16)`; the widening is kept as headroom) with
  `chk_assessment_assign_role IN ('ENGINEER','SENIOR_ENGINEER','REVIEWER',
  'APPROVER','CONSULTED')`. `REVIEWER`/`APPROVER` stay listed so historical rows
  remain valid, but they **confer no authority** and are never written again;
  `CONSULTED` is the only writable non-assignee role.
- `assessment_events`

### Routing v2 triggers (`20260910_routing_v2`)

The six eligibility triggers from `20260817_engineer_assignment_eligibility` are
dropped and re-created **route-aware**: on `routing_path='SENIOR_ENGINEER'` the
target must hold `GEOTECH_SENIOR_ENGINEER` or `ADMIN`; otherwise the original
`GEOTECH_ENGINEER`/`FIELD_WORKER` (Staff) rule applies, with its message
verbatim.
`trg_incident_engineer_elig_bi/bu` decides which rule to apply from
`EXISTS (SELECT 1 FROM assessments a WHERE a.incident_id = NEW.incident_id AND
a.routing_path='SENIOR_ENGINEER')`, which is single-valued only because of
`uk_assessment_incident`. The triggers fire only when
`assigned_engineer_user_id` changes, so a backfilled senior-engineer-route row
still holding a legacy Staff member keeps advancing.

The migration creates **no new table**, and its backfill **raises** rather than
completing if any non-terminal assessment cannot be given a reviewer.

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
  - `incidents 1 -> 1 incident_submission_link` (if/when the technical hand-off occurs)
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

Seeded roles — legacy names, then the canonical Assessment-model names (both
work, via `app/roles.py` aliasing):

- `FIELD_WORKER`, `MAINTENANCE`, `MAINT_COORDINATOR`, `OFFICE_CHIEF`,
  `BRANCH_CHIEF`, `REVIEWER` (**deprecated** — broad read only, no authority),
  `ADMIN`
- `MAINTENANCE_FIELD_WORKER`, `MAINTENANCE_COORDINATOR`, `GEOTECH_OFFICE_CHIEF`,
  `GEOTECH_BRANCH_CHIEF`, `GEOTECH_ENGINEER`
- `GEOTECH_SENIOR_ENGINEER` — **new in routing v2, no legacy alias**

Seeded users (dev/bootstrap):

- `admin@local`
- `maintenance@local`
- `coordinator@local` (district `01`)
- `coordinator04@local` (district `04`) — **new.** Every assessment fixture
  creates district-`04` incidents, so without this account the
  "approval notifies the coordinator" assertions would pass vacuously against an
  empty recipient list.
- `officechief@local` (office `WEST`)
- `branchchief@local` (office `WEST`)
- `engineer@local`
- `seniorengineer@local` (office `WEST`) — **new.** Office-scoped on purpose so
  it is preferred for WEST work. Legacy senior-engineer accounts without an
  `office_code` remain assignable, while accounts explicitly scoped to another
  office are excluded.
- `reviewer@local` (legacy `REVIEWER`; kept as the proof that the role keeps
  broad read)

All seeded users currently use the same argon2 password hash in seed (password string used in development flow).

> **After upgrading an existing database, re-run `020_seed.sql`.** Migration
> `20260910_routing_v2` deliberately seeds only the `GEOTECH_SENIOR_ENGINEER`
> *role row*, never users — the clean base→head CI job never loads the seed, so a
> migration assuming seeded users would silently no-op there. The seed is
> idempotent.

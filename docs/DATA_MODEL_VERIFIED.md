# Data Model (Verified)

Source: `database/init/010_schema.sql` (baseline) + Alembic migrations in
`backend/migrations/versions/` (post-baseline changes).

## Core Identity

- `users` — `password_hash` is nullable (an account without one signs in through
  Entra ID only) and `last_login_at` records the last sign-in
  (`20260923_entra_identity`)
- `roles` — the seven work roles and `ADMIN`, one code each
  (`20260923_roles_consolidated`)
- `user_roles`
- `user_external_identities` — links an account to its Entra ID identity,
  keyed on `(provider, tenant_id, object_id)`; unique per identity and per
  account. It carries no role and no org field: Entra authenticates, ERIS
  assigns roles and org placement (`20260923_entra_identity`)
- `role_consolidation_audit` — every grant of a retired role code, kept by
  `20260923_roles_consolidated` for tracing and for its downgrade

See [roles-and-identity.md](roles-and-identity.md).

## Organization Domain (`20260911_org_model`)

Seven additive tables. They replace three hard-coded copies of the district→office
map and the free-text `users.metadata_json.office_code`, and they are shaped so a
maintenance chart lands later **without a schema change**.

- `org_offices` — `code` (immutable after creation; assessments and incidents
  join on it), `org_type` (`GEOTECH|MAINTENANCE`), `unit_number`, `name` (full
  chart name), `short_name` (conversational form), `home_city`/`home_district`/
  `home_location_label`, `is_routing_target`, `is_active`, `sort_order`.
  `uk_org_office_code (org_type, code)` — the code is unique *within* an org
  type, so a future maintenance office may reuse `WEST`.
  `uk_org_office_id_type (id, org_type)` exists only to be the parent key of the
  composite FK below.
- `org_office_districts` — districts an office serves, as **rows, not JSON**:
  `office_for_district` is on the incident-creation path and needs an index,
  which `JSON_CONTAINS` is not. `active_district_key` is a **stored generated
  column** (`IF(is_active = 1, CONCAT(org_type, ':', RTRIM(district)), NULL)`)
  carrying "at most one active office **of a given org type** per district" —
  MariaDB has no partial unique index, and `UNIQUE` ignores NULLs. `RTRIM` is
  required: MariaDB refuses a bare `CHAR` inside any generated expression
  (error 1901). `org_type` is denormalized here and held true by
  `fk_org_office_districts_office (office_id, org_type)`, which is
  `ON UPDATE RESTRICT` for the same 1901 rule.
- `org_branches` — a branch, or later a maintenance `REGION`/`AREA`/`YARD`:
  `office_id`, `parent_branch_id`, `unit_type`, `letter` (nullable), `name`,
  home city/district, `chief_user_id`, `accepts_assignments`, `is_active`.
  **Two** generated keys, not one: `active_key` enforces one active letter per
  office; `active_unit_key` enforces one active letterless unit of a given name
  under a given parent. A single key would make the second letterless yard in an
  office un-insertable.
- `org_branch_districts` — districts a branch covers, each row labelled `source`
  (`CHART|INFERRED|ADMIN`). **Seeded empty for every office**: no chart states
  branch-to-district coverage anywhere, and the `source` column is what keeps a
  charted fact distinguishable from a later guess.
- `org_user_profiles` — 1:1 with `users` (PK `user_id`), not columns on `users`:
  `0001_baseline` forbids adding columns to `010_schema.sql`, `users` is the
  authentication hot path, and the admin `PATCH` replaces `metadata_json`
  **wholesale** on every save — org facts kept there would be silently
  destroyed. Holds `office_id`, `branch_id`, home city/district,
  `classification_code`, `classification_marker`, `position_number`, `job_title`,
  `level_code`, `supervisor_user_id`, `availability`
  (`AVAILABLE|ROTATION_OUT|ACTING_ELSEWHERE|UNAVAILABLE`) with
  `available_from`/`available_until`, and `source` (`MANUAL|IDP` — Entra ID
  populates the identity fields later and must leave `MANUAL` overrides alone).
- `org_coordinator_coverage` — district → coordinator, many-to-many, with
  `is_primary` for a deterministic first recipient. Replaces
  `JSON_EXTRACT(metadata_json,'$.district')` in `_routing_users_for`.
- `org_classifications` — the classification → role rules **as data**:
  `rule_kind` (`CLASS|PATTERN`), `class_code`, `marker`, `title_pattern`,
  `level_code`, `title`, `eris_role` (nullable — an undecided class is stored
  with a note rather than guessed), `is_supervisor`, `priority`. Every part of
  the natural key is `NOT NULL` with a `''` default so the seed upsert stays
  deterministic and re-runnable.

`users.metadata_json` is now a **mirror, never the source**.
`services/org_directory.resolve_user_org` reads the profile row first and falls
back to the mirror when there is no row **or** the row's `office_id IS NULL`; it
applies **no `is_active` filter**, so deactivating an office cannot revoke review
authority on work already routed to it. Both write paths
(`PUT /admin/users/{id}/org` and the legacy `PATCH /admin/users/{id}`) write the
profile and re-render the mirror in one transaction.

`geotech_office_routing` survives one release as a **mirror with exactly one
writer** (`services/org_directory`), so a rollback to the previous backend still
routes correctly. It is dropped in the **follow-up** revision
`20260912_drop_geotech_office_routing` — not in this release — whose only job is
that drop.

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
- `incident_routing_assignments` — **kept as history, no longer read.**
  Coordinator coverage moved to `org_coordinator_coverage`; the three
  `/incidents/routing/assignments` endpoints answer `410`. Nothing is dropped.
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
  - **Routing snapshot** (`20260911_org_model`): `routed_office_id BIGINT NULL`,
    `routed_office_name VARCHAR(160) NULL`, `routed_branch_id BIGINT NULL`,
    `routed_branch_name VARCHAR(160) NULL`, `routed_branch_letter VARCHAR(4)
    NULL`, with `idx_assessment_routed_office` and the two foreign keys
    `fk_assessment_routed_office` / `fk_assessment_routed_branch`
    (`ON DELETE SET NULL`). The **ids** are the live link; the **names** are
    frozen at triage and at `delegate-branch` so a later rename, a moved district
    or a retired branch cannot rewrite what an existing record says.
    `office_code` is untouched and remains what routing and review authority key
    on.
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
target must hold `SENIOR_SPECIALIST` or `ADMIN`; otherwise the Staff rule
(`STAFF` or `ADMIN`) applies. (Routing v2 wrote these with the codes of the
time; `20260923_roles_consolidated` re-created them with the current codes and
messages.)
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

Seeded roles — seven work roles and the Administrator, one code each
(`MAINTENANCE_CREW`, `MAINTENANCE_COORDINATOR`, `OFFICE_CHIEF`, `BRANCH_CHIEF`,
`SENIOR_SPECIALIST`, `STAFF`, `GUEST`, `ADMIN`). `GUEST` is read-only access to
approved records and deliberately *not* in `OPERATIONAL_ROLES`.

`database/init/` creates **no accounts**: it is MariaDB's first-boot init,
which production shares, and `test_first_boot_init_creates_no_account` keeps it
that way. A production database gets its first administrator from
`python -m app.tools.create_admin`.

Seeded organization structure (`020_seed.sql`, guarded so it no-ops on a database
that has not yet run `20260911_org_model`). **Structure only — no real person
from any org chart is seeded anywhere**; a fictional demo roster is the separate,
explicitly-flagged `backend/scripts/seed_demo_org_roster.py`:

- **5 offices** — `WEST` (59-315, Oakland D04, districts 01/04/05), `NORTH`
  (59-323, Sacramento/Translab, `home_district` NULL, districts 02/03/06/09/10),
  `SOUTH` (59-324, Los Angeles D07, districts 07/08/11/12), `POLICY` (59-325) and
  `SUPPORT` (59-316). POLICY and SUPPORT are seeded `is_routing_target = 0`:
  POLICY is shaped inversely to the design offices and has no district list, and
  SUPPORT has no chart at all.
- **17 branches** — WEST 6 (A–D Oakland D04, E San Luis Obispo D05, F Eureka
  D01), NORTH 4 (Districts Branch A–D, Sacramento/Translab), SOUTH 5 (A/D Los
  Angeles D07, B San Diego D11, C Santa Ana D12, E San Bernardino D08 with
  `accepts_assignments = 0` — proposed and unstaffed), POLICY 2.
- **12 `org_office_districts` rows**, migrated from `geotech_office_routing`.
- **0 `org_branch_districts` rows** — see above.
- **16 `org_classifications` rules** — 14 `CLASS` + 2 `PATTERN`. Class 5758
  (Research Data Specialist II) is seeded with `eris_role` **NULL** and a note:
  one WEST Branch D position is mid-reclassification and the owner has not
  decided.

`backend/tests/test_seed_shape_db.py` pins every one of those counts.

Mock accounts (development and test only) are
`database/dev/030_mock_accounts.sql`, loaded after `020_seed.sql` and never into
production. All use the password "password", and each holds one role:

- `mock.admin@dot.ca.gov` — `ADMIN` only: an account that could act as every
  role would hide a missing guard in any test that signs in as it
- `mock.maintenance.crew@dot.ca.gov`
- `mock.coordinator.d01@dot.ca.gov` (district `01`)
- `mock.coordinator.d04@dot.ca.gov` (district `04`) — every assessment fixture
  creates district-`04` incidents, so without this account the "approval
  notifies the coordinator" assertions would pass vacuously
- `mock.office.chief@dot.ca.gov` (office `WEST`)
- `mock.branch.chief@dot.ca.gov` (office `WEST`)
- `mock.senior.specialist@dot.ca.gov` (office `WEST`) — office-scoped on
  purpose: the Senior Specialist picker filters strictly
- `mock.staff@dot.ca.gov`, `mock.staff.2@dot.ca.gov` — the second is an
  operational bystander with no authority over the first one's assessment
- `mock.guest@dot.ca.gov` (`GUEST`, no office, no district) — the guest suite
  needs an account whose *only* role is Guest, because `is_public_only` is what
  narrows the reads

> The seed and the mock accounts are idempotent. On an existing development
> database, re-run them after migrating if the tests report a missing account.
> Never run either against production.

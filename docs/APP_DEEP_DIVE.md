# ERIS Application Deep Dive

This document explains how the full application works end-to-end across backend, database, web, and mobile.

## 1) Product Purpose

ERIS supports two connected domains:

- Incident intake and routing workflow
- Engineer submission/GISA workflow

An incident can be routed through operations roles and then linked to an engineer draft submission.

## 2) Main Components

- Backend API (`backend/app`)
  - Auth, role checks, workflow transitions, validation, storage orchestration
- Database (MariaDB)
  - Source of truth for users, incidents, submissions, workflow state, links
- Object storage (MinIO)
  - File bytes for photos/attachments
- Web UI (`web/src`)
  - Administrative and big-picture workflows (incidents, mission center, submissions)
- Mobile app (`mobile/app`, `mobile/src`)
  - Field workflows, role-focused tab visibility, offline queue + local drafts

## 3) Core Domain Objects

- User + Role
  - Roles drive access and view scope
- Incident
  - Intake record with location, timeline, status, stage, ownership/routing
- Submission
  - Engineer form container with GISA data + lifecycle state
- Attachment
  - Metadata in DB, content in MinIO
- Incident-Submission Link
  - Joins incident routing side to engineer submission side

## 4) Incident Lifecycle (Operational)

### Current staged model

- `COORDINATOR_REVIEW`
- `OFFICE_CHIEF_REVIEW`
- `BRANCH_CHIEF_REVIEW`
- `ENGINEER_ASSIGNED`
- `RESOLVED`

Status values still tracked independently:

- `NEW`, `IN_PROGRESS`, `RESOLVED`

### Progression

1. Incident is created.
2. Coordinator forwards to office chief.
3. Office chief assigns branch chief.
4. Branch chief assigns engineer.
5. Engineer resolves.

### Assignment model

Assignments are stored in `incident_assignments` with:

- `assignment_stage` (`COORDINATOR`, `OFFICE_CHIEF`, `BRANCH_CHIEF`, `ENGINEER`)
- `assignment_mode` (`ASSIGN`, legacy `CLAIM`)
- `is_active` flag (active assignment per stage)

## 5) Submission/GISA Lifecycle (Engineering)

Submission states:

- `DRAFT`
- `SUBMITTED`
- `APPROVED`
- `REJECTED`

Key operations:

- Create draft
- Patch GISA form data
- Replace incident type/action selections
- Attach photos/files
- Submit for review
- Approve/reject

Audit trail in `workflow_events`.

## 6) Incident -> Submission Bridge

When engineer assignment occurs:

- backend checks `incident_submission_links`
- if linked submission exists:
  - grants editor access as needed
- else:
  - creates new `submissions` row (`DRAFT`)
  - creates `workflow_events` create event
  - pre-fills baseline `submission_gisa` fields from incident location/timeline
  - creates `incident_submission_links` row

## 7) How Data Moves

### Reads

- Clients call API endpoints.
- API reads MariaDB for relational state.
- API may issue MinIO presigned URLs or direct content stream endpoints.

### Writes

- Clients send writes to API.
- API validates role + business rules.
- API updates MariaDB transactionally.
- For file uploads, API stores bytes to MinIO and metadata/link rows in DB.

## 8) Mobile Behavior

### Role-focused tabs

Mobile tab visibility is role-derived at runtime:

- Incidents tab for incident workflow roles
- Drafts/Submissions only for engineering/review/admin roles

### Offline

Implemented:

- Local draft store (chunked SecureStore persistence)
- Offline operation queue
- Auto sync loop (interval + app foreground)
- Queue diagnostics and retry

Flow:

1. User edits local draft.
2. Ops are enqueued.
3. Sync loop replays ops in order when token/network available.
4. Failed op is retained with attempts + error; queue stops at first failure.

## 9) Authorization Model

Backend-enforced role gating via dependency checks.

Mobile-scoped incident filtering (`scope=mobile`) is enforced server-side:

- coordinator: district scope
- office chief: office scope post-coordinator
- branch chief: office scope at branch/engineer/resolved
- engineer: only assigned incidents
- maintenance: own reported incidents
- admin: unrestricted

## 10) Database Initialization and Runtime

- Base schema comes from `database/init/010_schema.sql`
- Seed data comes from `database/init/020_seed.sql`
- Current backend startup also runs incident runtime schema upgrades for compatibility

## 11) Operational Summary

- The app is workflow-centric and role-gated.
- Incidents drive operational triage.
- Submissions capture engineering detail.
- Linking ties operational intake to technical resolution.
- Web gives broad visibility; mobile enforces focused role visibility with offline capability.

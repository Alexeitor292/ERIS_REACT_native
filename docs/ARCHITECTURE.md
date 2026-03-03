# ERIS Architecture

## Overview
- `backend`: FastAPI API, business rules, auth, workflow transitions, file storage integration.
- `web`: React web client for review/edit workflows.
- `mobile`: Expo/React Native client for field workflows with offline queueing and local drafts.
- `database/init`: SQL bootstrap for schema and initialization data.

## Backend Boundaries
- `app/main.py`: app bootstrap, shared helpers, router registration, non-domain glue.
- `app/routes/*`: API route declarations grouped by domain.
- `app/schemas/*`: Pydantic request/response models.
- `app/services/*`: domain/business validation and workflow logic.
- `app/constants/*`: controlled vocabularies and static option catalogs.

## Data and Validation Rules
- Frontends may validate for UX, but backend is the final authority.
- Controlled lookup options are backend-defined and served via `GET /gisa/lookups`.
- Submission state transitions and edit permissions are enforced backend-side.

## Initialization Policy
- Runtime app code must not mutate schema or seed business data.
- Schema creation and bootstrap data are performed through `database/init/*.sql`.
- Current approved seed scope: admin bootstrap user/roles only at DB initialization.

## Offline Policy (Mobile)
- Local draft and queue persistence are client-side concerns.
- Sync is attempted automatically when network/auth are available.
- Backend API contract remains unchanged for online and delayed-sync writes.

## Review Expectations
- Deterministic API behavior and explicit ownership of business rules.
- Single source of truth for option catalogs and validation logic.
- No hidden environment-dependent runtime migrations in API startup path.

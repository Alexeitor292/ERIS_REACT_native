# Caltrans Review Checklist

## Backend
- [ ] No runtime schema mutations in API startup code.
- [ ] No runtime seeding of business lookup data.
- [ ] Admin bootstrap is DB-init-only.
- [ ] Request models live in `app/schemas`.
- [ ] Business validations live in `app/services`.
- [ ] Lookup catalogs are centralized in `app/constants`.
- [ ] Routes grouped by domain modules in `app/routes`.

## Database
- [ ] `database/init/010_schema.sql` is the source of schema truth.
- [ ] `database/init/020_seed.sql` contains only approved bootstrap data.
- [ ] Bootstrap can be reproduced from a clean volume with `docker compose up`.

## Mobile/Web
- [ ] Both clients consume lookup values from `GET /gisa/lookups`.
- [ ] Client-side validation does not replace backend validation.
- [ ] Temporary debugging instrumentation is removed before release builds.

## Quality Gates
- [ ] Backend compiles: `python -m py_compile backend/app/main.py`.
- [ ] Web type check passes.
- [ ] Mobile type check passes.
- [ ] Error handling returns stable, non-leaky messages for 5xx responses.

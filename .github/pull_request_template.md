## What and why

<!-- What does this change do, and why is it needed? Link the issue or change request. -->

## How it was tested

<!-- Commands you ran, screens you checked, roles you signed in as. -->

## Checklist

- [ ] Tests added or updated; a bug fix has a test that failed before the fix
- [ ] `pytest -m "not db"` passes; `pytest -m db` too if SQL, routes or permissions changed
- [ ] `npm test && npm run build` pass if `web/` changed
- [ ] Schema change: an idempotent Alembic revision, ERD and schema reference regenerated
- [ ] New or changed route: guarded (`require_roles`, `deny_public_only` or `get_current_user`), API reference regenerated
- [ ] New setting: `config.py`, the `.env.example` files and `docs/operations/configuration.md`
- [ ] Docs updated (user guides, runbook, architecture or security as relevant); `scripts/docs/check_links.py` is clean
- [ ] No secrets, populated `.env` files, keys, certificates or personal data in the diff

## Security impact

<!-- None, or: what changes for sign-in, sessions, roles, data exposure, secrets or the release pipeline. -->

## Deployment notes

<!-- Migrations, new settings operators must set, order of steps, rollback concerns. "None" is fine. -->

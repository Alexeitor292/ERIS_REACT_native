# Contributing to ERIS

Thank you for maintaining ERIS. The full guide is
[docs/development/conventions.md](docs/development/conventions.md); this page
is the short version.

1. **Set up** your machine: [getting started](docs/development/getting-started.md).
2. **Branch** from `main`: `feature/…`, `fix/…`, `docs/…` or `chore/…`.
3. **Change** the code, with tests, and update the docs in the same branch
   ([what to update](docs/development/conventions.md#documentation)).
4. **Run the checks** before pushing:
   ```bash
   cd backend && python -m pytest tests -m "not db" -q
   cd ../web && npm test && npm run build
   cd .. && python scripts/docs/check_links.py
   ```
   Add `python -m pytest tests -m db` when you touched SQL, routes or
   permissions ([testing](docs/development/testing.md)).
5. **Open a pull request** and fill in the template. CI must be green and a
   second person must review it.
6. **Release** through Jenkins after merge ([releasing a change](docs/operations/README.md#releasing-a-change)).

## Never commit

- Passwords, keys, tokens, certificates, `.p8`/`.p12`/`.pem`/`.key` files,
  provisioning profiles.
- Populated `.env` files (only `*.example` files belong in Git).
- Real people's data, database dumps or backups.

If you commit one by mistake, tell the ERIS owner at once: removing it from
the history is not enough, it must be rotated
([secrets and keys](docs/security/secrets-and-keys.md#when-a-secret-is-exposed)).

## Security-sensitive areas

Changes to sign-in, sessions, roles, `config.py` production checks, or
anything under `deploy/` need a reviewer familiar with the
[security architecture](docs/security/README.md).

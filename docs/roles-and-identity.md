# Roles, permits and sign-in

The current role model, the per-record permits beside it, and how the account
tables are prepared for Entra ID. Source of truth: `backend/app/roles.py`
(server) with `web/src/utils/roleModel.ts` and `mobile/src/utils/roleModel.ts`
mirroring it for UI gating only. The server enforces every rule below; the
clients only hide what a person cannot use.

## The roles

Seven work roles and the Administrator. One code each, with no aliases.

| Code | Name | What it is for |
| --- | --- | --- |
| `MAINTENANCE_CREW` | Maintenance Crew | Files field reports from the road. Sees only their own reports. No assessments. |
| `MAINTENANCE_COORDINATOR` | Maintenance Coordinator | Triages field reports in the districts they cover and runs Event Groups. Only "Assessment required" puts a report on the record. |
| `OFFICE_CHIEF` | Office Chief | Routes their GeoTech office's assessments: hands one to a branch chief, or assigns a Senior Specialist directly. Reviews the Senior Specialist route. |
| `BRANCH_CHIEF` | Branch Chief | Assigns Staff to the assessments handed to their branch, and reviews the branch route. |
| `SENIOR_SPECIALIST` | Senior Specialist | Fills the assessments an office chief assigns directly. |
| `STAFF` | Staff | Fills the assessments a branch chief assigns, and can file field reports. |
| `GUEST` | Guest | Read-only. Sees approved and finalized records statewide. No work queue, no workflow step and no mobile surface. Anyone placed nowhere is a guest. |
| `ADMIN` | Administrator | Accounts, the organization model and configuration. Passes every workflow gate, and is not a work role. |

**Where a person sits decides their work role** (`services/org_tree.py`): the top of an
office tree is Office Chief, leading a branch Branch Chief, a leaf under the office chief
Senior Specialist, under a branch Staff, a district's coordinator list Maintenance
Coordinator and its crew list Maintenance Crew; placed nowhere, Guest. Every change of
place rewrites the person's `user_roles` at once, so the guards below keep reading
`user_roles` unchanged. Administrator is the only role granted directly (Administration ›
Users). The page, who may edit which part, and the migration that placed existing
accounts are in [organization.md](organization.md).

Rules that hold across the system:

- **A guard names exactly the roles it admits.** Nothing matches a prefix or an
  alias. `backend/tests/test_route_guards.py` walks the live route table: every
  route carries a role guard, a guest denial, or a reviewed guest read, and no
  guard names a code that is not a role.
- **The most permissive role wins.** The guest's narrowing applies only when
  Guest is an account's *only* role. A chief who is also a guest keeps full
  chief access.
- **Guests see no in-flight records.** New reports, triage, drafts, submitted
  work and revisions answer **404**, not 403, so a guest cannot probe for
  record ids.
- **Review authority comes from the assessment's route, not from a role.** On
  the branch route, only the branch chief named on that assessment may review.
  On the Senior Specialist route, only an office chief of that assessment's
  office may.
- **Scope narrows the reach.** A coordinator reads the districts they cover;
  office and branch chiefs read their office; Staff and Senior Specialists read
  what they are assigned. A missing district or office reads nothing (fail
  closed).

## Special permits

Per-record grants sit beside the roles and never widen them:

- **Reader and editor permits on a technical form** (`submission_visibility`,
  `submission_editors`). An author, or an administrator, names one person who
  may read, or edit, that one form. The grants are ignored for a guest, because
  every route that honors them refuses a guest-only account first.
- **Consulted on an assessment** (`assessment_assignments.assignment_role =
  'CONSULTED'`). An office chief, a branch chief or an administrator attaches
  an operational user for information. Consulted confers no authority: it
  records that the person is informed, and they cannot act on the assessment.

## Accounts and sign-in

**Entra ID authenticates; ERIS authorizes.** Caltrans' Microsoft Entra ID will
prove who is signing in, and nothing more. Roles follow from organization
placement in ERIS (the Organization page, edited by administrators and, for their
own part of their office, by office and branch chiefs). No Entra group, app role or
claim grants either.

The database is ready for that. Migration `20260923_entra_identity` makes three
changes:

- **`users.password_hash` is nullable.** An account without a password can sign
  in only through Entra ID. The password endpoint refuses it with the same
  "Invalid credentials" as a wrong password.
- **`users.last_login_at`** records the last successful sign-in.
- **`user_external_identities`** links an account to its Entra identity. The
  key is `(tenant_id, object_id)`, the token's `tid` and `oid`. Email and user
  principal name are kept for reference only, since they can change. Each
  Entra identity links to one account, and each account has one Entra
  identity.

Planned flow, not built yet:

1. An administrator creates the account (email, name, roles, org placement),
   with or without a password.
2. At the person's first Entra sign-in, ERIS validates the ID token for the
   configured tenant and finds the pre-created account by its verified email.
   It then records the tenant and object ID.
3. From then on, sign-in matches on the tenant and object ID alone.

A person Entra knows, but whom no administrator has created, gets no ERIS
access.

### The first administrator

A fresh production database has no accounts. `database/init/` creates roles
and organization structure only, and a test
(`test_first_boot_init_creates_no_account`) keeps it that way. The first
administrator comes from:

```bash
python -m app.tools.create_admin --email jane.doe@dot.ca.gov --name "Jane Doe"
```

It prompts twice for a password of at least 12 characters, or reads
`ERIS_ADMIN_PASSWORD`. `--sso-only` creates the account without a password, for
Entra sign-in. The command is idempotent: an existing account gains ADMIN and
keeps its other roles. It refuses a `mock.*` address outside `ENV=dev`.

### Mock accounts (development and test only)

`database/dev/030_mock_accounts.sql` holds the development and test accounts,
all with the password "password". Load it after `database/init/020_seed.sql`
and, on a fresh database, before `alembic upgrade head` (the org model builds
coordinator coverage from the accounts it finds). Never load it into
production:

| Account | Role |
| --- | --- |
| `mock.admin@dot.ca.gov` | Administrator only |
| `mock.maintenance.crew@dot.ca.gov` | Maintenance Crew |
| `mock.coordinator.d01@dot.ca.gov` | Maintenance Coordinator, district 01 |
| `mock.coordinator.d04@dot.ca.gov` | Maintenance Coordinator, district 04 |
| `mock.office.chief@dot.ca.gov` | Office Chief, WEST |
| `mock.branch.chief@dot.ca.gov` | Branch Chief, WEST |
| `mock.senior.specialist@dot.ca.gov` | Senior Specialist, WEST |
| `mock.staff@dot.ca.gov`, `mock.staff.2@dot.ca.gov` | Staff |
| `mock.guest@dot.ca.gov` | Guest |

The addresses sit on the real `dot.ca.gov` domain, so the notification service
never hands a `mock.*` address to a live mail relay. A development database
seeded before these addresses existed can be renamed in place with
`database/dev/rename_local_accounts.sql`.

## The retired codes

Migration `20260923_roles_consolidated` moved every grant to the new codes and
deleted the old ones. Design documents written before it use the old codes;
read them with this table:

| Retired code | Now |
| --- | --- |
| `MAINTENANCE`, `MAINTENANCE_FIELD_WORKER` | `MAINTENANCE_CREW` |
| `MAINT_COORDINATOR` | `MAINTENANCE_COORDINATOR` |
| `GEOTECH_OFFICE_CHIEF` | `OFFICE_CHIEF` |
| `GEOTECH_BRANCH_CHIEF` | `BRANCH_CHIEF` |
| `GEOTECH_SENIOR_ENGINEER` ("Senior Engineer") | `SENIOR_SPECIALIST` |
| `GEOTECH_ENGINEER`, `FIELD_WORKER` | `STAFF` |
| `CALTRANS_VIEWER` ("Viewer") | `GUEST` |
| `REVIEWER` | Removed. It had carried no authority since routing v2. An account whose only role was Reviewer became a Guest. |

Every grant of a retired code is kept in `role_consolidation_audit` (user, old
code, when it was granted), and the migration's `downgrade()` restores them
exactly. Classification rules that suggested an old code now suggest the new
one; the Reviewer rule suggests none.

`assessment_assignments.assignment_role` values (`ENGINEER`,
`SENIOR_ENGINEER`, `CONSULTED`, and the historical `REVIEWER`/`APPROVER`) are
assignment stages, not account roles. They are unchanged.

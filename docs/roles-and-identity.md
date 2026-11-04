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
| `MAINTENANCE` | Maintenance | Their own reports. Everything more comes from their part in a district's workflow: reporting, reviewing, the final decision, reading the district, changing the workflow. No assessments. |
| `OFFICE_CHIEF` | Office Chief | Routes their GeoTech office's assessments: hands one to a branch chief of that office, or assigns a Senior Specialist of that office directly. Reviews the Senior Specialist route. |
| `BRANCH_CHIEF` | Branch Chief | Assigns the Staff of their own branch to the assessments handed to it, and reviews the branch route. |
| `SENIOR_SPECIALIST` | Senior Specialist | Fills the assessments an office chief assigns directly. |
| `STAFF` | Staff | Fills the assessments a branch chief assigns, and can file field reports. |
| `GUEST` | Guest | Read-only. Sees approved and finalized records statewide. No work queue, no workflow step and no mobile surface. Anyone placed nowhere is a guest. |
| `ADMIN` | Administrator | Accounts, the organization model and configuration. Passes every workflow gate, and is not a work role. |

**Where a person sits decides their work role** (`services/org_tree.py`): the top of an
office tree is Office Chief, leading a branch Branch Chief, a leaf under the office chief
Senior Specialist, under a branch Staff; anyone named in a district's maintenance workflow
Maintenance; placed nowhere, Guest. Every change of
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
- **A technical form opens to its route until the work is approved.** Everyone
  operational sees that an assessment exists, its stage and who has it. Its
  technical forms (fields, memos, photos and files, drone surveys, the PDF)
  open only to the form's owner, the people it is shared with, the office
  chiefs of the assessment's office, the branch chief it was handed to, whoever
  is assigned to it, and administrators. Once the assessment is approved they
  open to every operational user; a form outside any assessment opens once it
  is approved itself. Anyone else is told the form is in progress and can ask
  its owner to share it (`backend/app/services/form_access.py`).
- **Scope narrows the reach.** Maintenance reads what their workflow part allows;
  office and branch chiefs read their office; Staff and Senior Specialists read
  what they are assigned. A missing district or office reads nothing (fail
  closed).

## Special permits

Per-record grants sit beside the roles and never widen them:

- **Sharing a technical form** (`submission_shares`, granted through
  `submission_visibility` and `submission_editors`). The form's owner, or an
  administrator, shares it with one person, who can then view **and** edit it.
  Who has a say follows the office trees (`services/share_rules.py`):
  - **Branch chiefs gate their branch.** A share into or out of a branch needs
    its chief's approval; across two branches, both chiefs must approve, and it
    takes effect only then. Either may reject it.
  - **Inside one branch** it goes through at once; the branch chief is told and
    may stop it.
  - **Office chiefs are told**, and may stop it, when a share leaves their
    office or involves one of their Senior Specialists. Nothing is asked of them:
    if they do nothing, it stands.
  - **The one thing an office chief approves:** a Senior Specialist sharing with a
    Senior Specialist in another office needs both office chiefs.

  So Senior Specialist to Senior Specialist in one office goes through at once
  (their office chief told); to Staff of their office, that staff member's branch
  chief approves (the office chief told); staff to a Senior Specialist needs the
  staff member's branch chief (the office chiefs told). A branch with no chief is
  decided by its office chiefs, and an administrator may decide for any branch or
  office.
  **A chief is only asked for what needs them:** an approval waits in their
  **My Work**, and a notice is just a notification that opens the share if they
  want to stop it. Stopping a share takes
  the person's access away. Grants from before sharing needed approval stay as
  they were. Every route that honors a grant refuses a guest-only account first.
- **Standing in for someone away** (`user_delegations`, `services/delegations.py`).
  Someone names a colleague in the same office, or on the same district's lists or
  workflow, between two dates (Settings › Out of office on the web, Account on the
  phone). For time off they cannot set themselves, such as an emergency, their direct
  supervisor can: a Staff member's branch chief, or a branch chief's or Senior
  Specialist's office chief. An administrator can too.
  While it runs the colleague may switch to acting for them: each request carries
  `X-ERIS-Acting-For`, and the server judges it as the absent person, so their
  queues, scope and steps all follow. Every write goes in `delegated_actions`, and
  timelines and share decisions name both people. Administrator does not pass;
  accounts, the organization and delegations cannot be changed while acting; and
  nobody can review their own form or decide a share of their own that way. It ends
  by itself after the last day, and either person can end it sooner. The person
  acting gets a copy of each notice with no link: the step waits in the absent
  person's queue.
- **Consulted on an assessment** (`assessment_assignments.assignment_role =
  'CONSULTED'`). An office chief, a branch chief or an administrator attaches
  an operational user for information. Consulted confers no authority: it
  records that the person is informed, and they cannot act on the assessment.

## Accounts and sign-in

**Entra ID authenticates; ERIS authorizes.** Caltrans' Microsoft Entra ID can
prove who is signing in, and nothing more. Roles follow from organization
placement in ERIS (the Organization page, edited by administrators and, for their
own part of their office, by office and branch chiefs). No Entra group, app role or
claim grants either.

Migration `20260923_entra_identity` makes three
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

Current web flow:

1. An administrator creates the account with its Entra object ID and optional
   password, then grants roles or organization placement.
2. ERIS validates the ID token for the configured tenant, client, issuer,
   signature and nonce, and matches the prelinked tenant and object ID.
3. Email is never used to link or find the signed-in user.

A person Entra knows, but whom no administrator has created, gets no ERIS
access.

### The first administrator

A fresh production database has no accounts. `database/init/` creates roles
and organization structure only, and a test
(`test_first_boot_init_creates_no_account`) keeps it that way. The first
administrator is seeded once by `python -m app.tools.bootstrap_initial_admin`
in the [Caltrans Podman deployment](caltrans-podman.md). For manual setups,
the original operator command remains available:

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
| `mock.maintenance.crew@dot.ca.gov` | Maintenance |
| `mock.coordinator.d01@dot.ca.gov` | Maintenance, district 01 |
| `mock.coordinator.d04@dot.ca.gov` | Maintenance, district 04 |
| `mock.office.chief@dot.ca.gov` | Office Chief, WEST |
| `mock.branch.chief@dot.ca.gov` | Branch Chief, WEST Branch A |
| `mock.senior.specialist@dot.ca.gov` | Senior Specialist, WEST |
| `mock.staff@dot.ca.gov`, `mock.staff.2@dot.ca.gov` | Staff, WEST Branch A |
| `mock.guest@dot.ca.gov` | Guest |

Their places come from `database/dev/040_mock_placements.sql`, loaded after
`alembic upgrade head`: no role is held without its place.

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
| `MAINTENANCE_CREW`, `MAINTENANCE_FIELD_WORKER`, `MAINTENANCE_COORDINATOR`, `MAINT_COORDINATOR` | `MAINTENANCE` |
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

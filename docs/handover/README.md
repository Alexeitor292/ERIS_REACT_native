# Handover guide

For whoever takes over ERIS: the Caltrans IT staff who run it, and the
developer or intern who maintains the code. Read this first; it links to
everything else.

**Handoff update — November 13, 2026:** ERIS is owned by **Deh Jeng Jang**.
The outgoing maintainer leaves Caltrans at the end of November. Staging is
currently hosted on personal servers; Caltrans IT still needs to be approached
to provision agency staging and subsequently production. Hostnames, technical
successor and IT service owner are pending assignment.

| Handoff document | Use it for |
| --- | --- |
| [Environment setup worksheet](environment-setup.md) | Exact local/staging/production configuration, matching credentials and feature settings |
| [Remaining work register](open-work.md) | Priorities, accountable roles and completion evidence |
| [Personal-server transfer](server-transfer.md) | IT request, inventory, matched backup, migration, cutover and data disposition |
| [Acceptance record](acceptance.md) | Assign owners/hosts and record independent setup, recovery and go-live evidence |
| [Licensing bill of materials](../caltrans/licensing-bill-of-materials.md) | 300-device Esri Lite assessment, service usage, Apple distribution, Microsoft and developer tooling |
| [Security review](../security/review-2026-11-13.md) | Dated scans, remediation, residual findings and production gates |
| [Image package](image-package.md) | Five image archives, exact identities, SBOMs/scans, source and rootless recovery evidence |

## Build and receive the source package

From a clean checkout of the accepted commit, run:

```powershell
python scripts/handover/build_package.py --output ../ERIS-handoff-release --include-history
```

The output directory must be new and outside the checkout. It contains all
committed source/docs in a ZIP, `manifest.json` with the source commit and
per-file SHA-256 values, `SHA256SUMS` and `START-HERE.txt`. Verify the ZIP with
`Get-FileHash <archive.zip> -Algorithm SHA256` (Linux: `sha256sum -c SHA256SUMS`).
Extract it and start with this guide. The builder refuses a dirty checkout and
restricted tracked config/key paths. Source scanning is a separate release gate.

The source ZIP has no Git history, live DB/files, ignored env files, private keys,
or installed dependencies. `--include-history` also creates a checksummed
`ERIS-history.bundle` containing all Git refs/history; scan history for secrets
before including it. Restore with `git clone -b <manifest-branch> ERIS-history.bundle ERIS`.
Obtain agency repository access for future changes. Transfer the [secure companion](server-transfer.md#secure-companion-to-the-source-package)
separately; source delivery alone does not constitute operational acceptance.

## What you are taking over

ERIS is a web application, an iPhone app and a small server stack:

```mermaid
flowchart LR
    subgraph People
        field["Field and maintenance staff<br/>(iPhone, browser)"]
        geo["GeoTech offices<br/>(browser)"]
        admin["ERIS administrators<br/>(browser)"]
    end
    subgraph Caltrans["Caltrans infrastructure (IT owns)"]
        gw["TLS gateway<br/>DNS, certificates"]
        host["Linux host<br/>one Podman pod"]
        entra["Microsoft Entra ID<br/>sign-in, MFA"]
        jenkins["Jenkins + Harbor<br/>build, scan, sign"]
        intune["Intune + Company Portal<br/>iPhone app delivery"]
        backup["Backup target"]
    end
    subgraph Code["Source code (developer owns)"]
        repo["GitHub repository<br/>backend, web, iOS, deploy, docs"]
    end
    field --> gw
    geo --> gw
    admin --> gw
    gw --> host
    host --> entra
    repo --> jenkins --> host
    repo -. iOS build .-> intune --> field
    host --> backup
```

| Part | What it is | Owner after handover | Start with |
| --- | --- | --- | --- |
| ERIS web app and API | The system people use | Developer (code), IT (servers) | [System overview](../overview/README.md) |
| The Podman pod (5 containers, 2 volumes) | Production and staging servers | Caltrans IT | [Caltrans Podman runbook](../operations/caltrans-podman.md) |
| Release pipeline | Jenkins builds, scans, signs and releases images | Caltrans IT + developer | [Supply chain](../security/supply-chain.md) |
| Sign-in | Entra ID app registrations (web + ERIS Mobile) | Caltrans identity team | [Authentication and sessions](../security/authentication-and-sessions.md) |
| ERIS iPhone app | Native Swift app, delivered through Intune | Developer (code), IT (Intune, Apple account) | [iOS app](../development/ios.md) |
| ERIS accounts and roles | Who may do what inside ERIS | ERIS administrators (at least two) | [Administration guide](../user-guides/administration.md) |
| Backups | Matched DB + files + config | Caltrans IT | [Backup and restore](../operations/caltrans-podman.md#backup-and-restore) |
| Documentation | This folder | Everyone; update it with every change | [Conventions](../development/conventions.md#documentation) |

## Before the original author leaves (checklist)

These items depend on accounts that belong to one person today. Each must move
to Caltrans before the handover is complete. Tick them off in a tracked ticket.

- [ ] **Source code.** The repository is `Alexeitor292/ERIS_REACT_native`, under a
      personal GitHub account. Transfer it to a Caltrans-owned GitHub organization
      (or import it into Caltrans's Git service). Then update the clone URLs in
      [getting started](../development/getting-started.md) and in Jenkins.
- [ ] **GitHub Actions.** Confirm CI runs in the new location (secrets: none are
      required today; the iOS workflow uses only the built-in token).
- [ ] **Two Caltrans administrators** are linked to their Entra accounts in ERIS,
      and `bash deploy/podman/eris-pod.sh handover-check` passes.
- [ ] **Apple distribution.** Verify the existing developer membership type and
      select an approved custom-app or Enterprise path (see licensing). Caltrans
      staff hold the Account Holder/Admin roles, signing assets and APNs key.
- [ ] **Signing and secrets.** The cosign key pair, the Entra client certificate and
      every `deploy/podman/*.env` value are in Caltrans's approved secret store, not
      on a personal machine or in email.
- [ ] **Campos Labs rehearsal servers** (Proxmox, Cloudflare, Caddy; see
      [history](../operations/history/proxmox-podman-cutover.md)). Decide with
      Caltrans whether its data is deleted or handed over, then shut it down. It is
      personal infrastructure and must not keep a copy of Caltrans data.
- [ ] **The Caltrans Mac mini** used for iOS builds, with Claude Code and Xcode.
      Hand it over with agency-managed access and the accepted source commit recorded.
- [ ] **Open work** is merged or recorded: open pull requests, the iOS port status
      ([native port status](../../ios/README.md#port-status)), and the current
      [remaining work register](open-work.md). Swift is on main; Expo is retired.
- [ ] **Remove the author's own access** after the above: ERIS admin role, Jenkins,
      Harbor, Apple account, GitHub organization.

## First day for Caltrans IT

1. Read the [system overview](../overview/README.md) and the
   [deployment topologies](../architecture/deployment-topologies.md).
2. Get access: the ERIS hosts (service account), Jenkins, Harbor, the backup
   target, and an ERIS administrator account linked to your Entra identity.
3. On the staging host, run the read-only checks:
   `bash deploy/podman/eris-pod.sh status`,
   `bash deploy/podman/eris-pod.sh cert-check`,
   `bash deploy/podman/eris-pod.sh handover-check`, and
   `ERIS_VERIFY_PROFILE=production bash deploy/podman/verify-rehearsal.sh https://<web> https://<files>`.
4. Take a backup and restore it into new volumes on staging
   ([procedure](../operations/caltrans-podman.md#backup-and-restore)). If you can do
   that, you can recover the system.
5. Put the [maintenance calendar](#recurring-maintenance-calendar) dates in your
   team calendar.

## First week for a new developer

| Day | Do | Read |
| --- | --- | --- |
| 1 | Set up the local stack and sign in with a mock account | [Getting started](../development/getting-started.md) |
| 1 | Run every test suite once | [Testing](../development/testing.md) |
| 2 | Follow one incident through the system: report → triage → assessment → review | [User guides](../user-guides/README.md), [workflows](../architecture/workflows.md) |
| 2 | Read how a request is authenticated and authorized | [Request flows](../architecture/request-flows.md), [roles and permissions](../security/roles-and-permissions.md) |
| 3 | Tour the backend code and add a trivial endpoint on a branch (and its test) | [Backend guide](../development/backend.md) |
| 4 | Tour the web code and change one screen | [Web guide](../development/web.md) |
| 5 | Make a schema change on a branch: migration, init SQL, regenerated ERD | [Migrations](../data/migrations.md) |
| 5 | Open a pull request following the conventions | [Conventions](../development/conventions.md) |

Ground rules that keep ERIS safe: never commit secrets or populated `.env`
files; never put a session token in a URL; every new route needs a role guard
(a test enforces it); every schema change is a migration **and** an update to
`database/init/010_schema.sql`; update the docs in the same pull request.

## Recurring maintenance calendar

| When | Task | How | Owner |
| --- | --- | --- | --- |
| Every release | Build, gate, sign, release to staging, approve, release to prod | [Releases](../operations/caltrans-podman.md#releases-one-command-automatic-rollback) | IT + developer |
| Daily (or per Caltrans backup policy) | Matched backup, moved off-host | [Backup](../operations/caltrans-podman.md#backup-and-restore) | IT |
| Weekly | Review `releases.log`, container health, disk space, failed push or email | [Monitoring](../operations/monitoring-and-troubleshooting.md) | IT |
| Monthly | Dependency and base-image updates (Python, npm, Swift packages, MariaDB, SeaweedFS); run the pipeline so Trivy re-scans | [Dependency updates](../development/conventions.md#dependency-updates) | Developer |
| Monthly | Review `.trivyignore` and remove expired exceptions | [Supply chain](../security/supply-chain.md#vulnerability-exceptions) | Developer + security |
| Quarterly | Restore drill on staging from a real backup; record the result | [Restore](../operations/caltrans-podman.md#backup-and-restore) | IT |
| Quarterly | Access review: ERIS administrators, disabled leavers, Entra app assignments | [Administration](../user-guides/administration.md), [secrets](../security/secrets-and-keys.md) | ERIS admins + IT |
| 30 days before expiry | Renew the Entra client certificate (`eris-pod.sh cert-check` warns) | [Rotation](../security/secrets-and-keys.md#rotation-procedures) | IT |
| 30 days before expiry | Renew TLS certificates at the gateway | Caltrans PKI process | IT |
| Before its actual expiry, if Enterprise distribution is selected | Renew the in-house provisioning profile, re-sign and update Intune; expiry can stop installed apps | [iOS distribution](../development/ios.md) | Developer + IT |
| Before recorded expiry, for the selected distribution path | Renew agency Apple membership, signing certificates and profiles as applicable; record actual dates | Apple Developer portal | IT |
| Yearly, or on staff change | Rotate the cosign key, APNs key, database and S3 credentials, JWT signing key (ends all sessions) | [Rotation](../security/secrets-and-keys.md#rotation-procedures) | IT |

## Where to get help without the author

| Question | Where |
| --- | --- |
| How does X work? | Search this folder; the [glossary](../overview/glossary.md) explains the domain terms |
| Why was it built this way? | [Architecture decision records](../decisions/README.md) and `git log` / `git blame` on the file |
| Which endpoint does Y? | [API reference](../reference/api.md) (generated) |
| Which table holds Z? | [ERD](../data/erd.md) and [schema reference](../data/schema-reference.md) (generated) |
| Something is broken | [Troubleshooting FAQ](troubleshooting.md), then [incident response](../security/incident-response.md) if it may be a security event |
| Vendor documentation | [FastAPI](https://fastapi.tiangolo.com/), [SQLAlchemy](https://docs.sqlalchemy.org/), [Alembic](https://alembic.sqlalchemy.org/), [React](https://react.dev/), [Podman](https://docs.podman.io/), [Microsoft identity platform](https://learn.microsoft.com/en-us/entra/identity-platform/), [MSAL for iOS](https://learn.microsoft.com/en-us/entra/msal/objc/), [ArcGIS Maps SDKs](https://developers.arcgis.com/), [SeaweedFS](https://github.com/seaweedfs/seaweedfs/wiki), [MariaDB](https://mariadb.com/kb/) |

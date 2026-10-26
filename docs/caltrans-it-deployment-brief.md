# ERIS deployment briefing for Caltrans IT

**Discussion copy — 2026-10-26.** This describes the proposed Caltrans deployment, not an approved Caltrans production service. The [four-page PDF handout](../output/pdf/eris-caltrans-it-briefing.pdf) is for calls; the [operator runbook](caltrans-podman.md) has commands and configuration details. Record Caltrans decisions in the table near the end before a production date is set.

## The 60-second explanation

ERIS is a browser-based incident and geotechnical assessment system. The proposed deployment is **one rootless Linux Podman pod containing five containers**: nginx/web, FastAPI, a background terrain worker, MariaDB, and SeaweedFS object storage. MariaDB and SeaweedFS each have a persistent named volume. Caltrans IT would own the host, DNS/TLS gateway, Jenkins, Harbor, Entra registration, secrets, monitoring, and backups. The ERIS team supplies the source, container build pipeline, deployment scripts, configuration templates, and application support.

Our [Campos Labs Proxmox deployment](proxmox-podman-cutover.md) exercises this pod with migrated ERIS data. It currently uses local image tags, Cloudflare/Caddy, and password sign-in. It **does not** prove Caltrans Harbor, Jenkins, Entra, network policy, or recovery. The first decision is whether Caltrans's “single pod” requirement actually means a Podman pod on a Linux host; if it means a Kubernetes/OpenShift Pod, the deployment artifacts need adaptation.

## Diagram 1 — runtime and trust boundaries

```mermaid
flowchart LR
    Browser[Staff browser] -->|HTTPS 443| Gateway[Caltrans DNS and TLS gateway]
    Mobile[Future mobile app<br/>not yet ready] -.->|HTTPS 443| Gateway
    Gateway -->|private 8080<br/>web and /api| Web
    Gateway -->|private 9800<br/>signed file URLs| S3

    subgraph Host[Caltrans Linux host and rootless Podman pod]
        direction LR
        Web[nginx and React web] -->|localhost 8000| API[FastAPI]
        API -->|localhost 3306| DB[(MariaDB 11)]
        API -->|localhost 8333| S3[SeaweedFS 4.50 S3]
        Worker[Terrain job worker] --> DB
        Worker --> S3
        DB --> DBVolume[(Persistent database volume)]
        S3 --> S3Volume[(Persistent object volume)]
    end

    API <-->|OIDC over HTTPS| Entra[Caltrans Microsoft Entra ID]
    Harbor[Caltrans Harbor] -->|five approved image pulls| Host
    DBVolume -.->|matched encrypted backup| Backup[Caltrans backup target]
    S3Volume -.->|same recovery set| Backup
```

The gateway and Harbor are **outside** the pod. The gateway may run on the same host, using loopback `127.0.0.1:8080/9800`, or elsewhere, using a private interface and firewall rules. MariaDB port 3306, API port 8000, and SeaweedFS internal S3 port 8333 are not published on the host. The browser reaches the web/API origin and a second HTTPS S3 hostname; signed S3 requests must preserve Host, path, query string, and encoding through the gateway.

| Flow | Needed for | Decision/owner |
| --- | --- | --- |
| Staff browser → web hostname, HTTPS 443 | App and same-origin `/api/*` | Caltrans DNS/TLS owner |
| Browser → file hostname, HTTPS 443 | Signed downloads issued by the API | Caltrans DNS/TLS owner |
| TLS gateway → host 8080 and 9800 | Web/API and S3 proxy | Firewall/gateway owner; loopback if co-hosted |
| Host → Harbor | Pull five approved images | Registry/network owner |
| API → Entra authority, HTTPS 443 | Web sign-in and signing keys | Identity/network owner; choose commercial or Government cloud |
| Worker/API/browser → GIS services | Optional maps and terrain jobs | Approve the actual source list for enabled features |
| API → SMTP / Expo | Optional email / future phone push | Decide whether to enable and approve egress |
| Host → backup/logging services | Recovery and operations | Storage/SIEM owners |

## Diagram 2 — how images reach the pod

```mermaid
flowchart LR
    Source[Approved ERIS source commit] --> Jenkins[Caltrans Jenkins agent<br/>Podman build]
    Jenkins -->|API, worker, web| Harbor[Caltrans Harbor project]
    ThirdParty[IT-approved MariaDB and SeaweedFS images] -->|mirror| Harbor
    Harbor --> Review[IT scan, license review, approval<br/>and immutable digests]
    Review --> Host[Podman host pulls five images]
    Host --> Configure[IT supplies runtime secrets<br/>through approved process]
    Configure --> Start[Create pod and volumes<br/>apply Alembic schema migrations, create buckets, seed admin]
    Start --> Verify[Health, Entra, permissions,<br/>file transfer, restart and restore tests]
```

The supplied [`Jenkinsfile.podman`](../Jenkinsfile.podman) **builds and pushes**, but does not deploy. It runs Python compilation, the web build, and two backend security test modules. Image signing, an SBOM, full vulnerability gates, and deployment automation are **not currently implemented in that pipeline**; Caltrans must choose the required tooling and approval gate. Its `agent any` needs an approved **Linux** Jenkins agent with Podman, Harbor reachability, a `harbor-eris-robot` push credential, and memory for the web build's 4 GiB Node heap. Caltrans may need to bind the job to an agent label. The host gets a separate pull-scoped credential. [Harbor supports project robot permissions](https://goharbor.io/cli-docs/cli-docs/harbor-project-robot-create/) and [vulnerability scanning](https://goharbor.io/docs/main/administration/vulnerability-scanning/), subject to Caltrans configuration.

## Stack and data

| Layer | Proposed component | What persists |
| --- | --- | --- |
| Web | nginx 1.27 Alpine serving React 19 / Vite 7 / Tailwind 4 | No application data; replaceable image |
| API | Python 3.12, FastAPI, SQLAlchemy, Alembic | Reads/writes MariaDB and S3 |
| Worker | Separate Python/GIS image, background terrain job processor | Jobs/results in MariaDB and S3 |
| Relational database | MariaDB 11 | Users and ERIS roles, organizations, incidents, assessments, workflow state, metadata, audit/event records, object references |
| Object store | SeaweedFS 4.50 S3 interface | Photos, attachments, generated PDFs, offline terrain/road packages |
| Outside pod | Caltrans TLS gateway, Jenkins, Harbor, Entra, backup/monitoring | Owned and operated per Caltrans policy |

The [SeaweedFS 4.50 source tag carries an Apache-2.0 license](https://github.com/seaweedfs/seaweedfs/blob/4.50/LICENSE); the [MariaDB Server project states GPLv2](https://mariadb.org/about/). These references are a starting point for Caltrans's review of the **exact images, dependencies, redistribution obligations, and support model**, not a completed license approval. The proposed SeaweedFS image is the community project, not SeaweedFS Enterprise.

### Simplified relational view

```mermaid
erDiagram
    USERS ||--o{ USER_ROLES : has
    ROLES ||--o{ USER_ROLES : grants
    USERS ||--o{ USER_EXTERNAL_IDENTITIES : linked_to
    USERS ||--o{ INCIDENTS : reports
    INCIDENTS ||--o| MAINTENANCE_WORKFLOW_RUNS : follows
    INCIDENTS ||--o{ INCIDENT_ATTACHMENTS : includes
    ATTACHMENTS ||--o{ INCIDENT_ATTACHMENTS : referenced_by
    SUBMISSIONS ||--o{ ATTACHMENT_LINKS : includes
    ATTACHMENTS ||--o{ ATTACHMENT_LINKS : referenced_by
    INCIDENTS ||--o| INCIDENT_SUBMISSION_LINKS : connects
    SUBMISSIONS ||--o| INCIDENT_SUBMISSION_LINKS : connects
```

This is a discussion diagram, not the complete schema. Organization, assessments, events, terrain jobs, and other tables are omitted. `attachments` holds metadata and an S3 bucket/key; file bytes are in SeaweedFS. The [schema](../database/init/010_schema.sql) and [Alembic migrations](../backend/migrations/versions) are the authoritative physical model. Typical records include employee names/emails, incident locations, photos, technical reports, and audit events; Caltrans must classify them before deciding retention and export policy.

On a **fresh** install, initialization creates the database schema, eight roles, and minimum organization structure, with **no demo users**. Alembic moves the schema to the current revision; storage bootstrap creates private buckets; then a one-time admin is created or linked. The bootstrap marker prevents a later restart from recreating a disabled initial admin. A populated, unversioned database is deliberately refused. The schema and migrations are in [`database/init`](../database/init) and [`backend/migrations`](../backend/migrations). An import from the Campos Labs environment would be a **separate data migration and authorization decision**; it is not part of the fresh-install procedure.

The persistent set is the MariaDB volume **plus** the SeaweedFS volume **plus** their runtime secrets/configuration. Back up and restore them together. The `eris-uploads` bucket is private. The `eris-offline-scenes` bucket is private and versioned with Object Lock capability, but no retention duration is set automatically. File URLs are normally presigned for 15 minutes; anyone holding an unexpired signed URL can use it, so gateway logs should avoid recording query strings. Caltrans sets data classification, retention, legal hold, encryption at rest, backup encryption, RPO/RTO, and restore-test frequency. A single host is a single point of failure; this proposal is not an HA design.

The Proxmox rehearsal used 4 vCPU, 8 GiB RAM, and an 80 GB disk. The runbook budgets **at least 8 GiB runtime RAM**; Caltrans should size CPU and disk from expected users, evidence, and terrain packages. Jenkins build resources are separate from runtime sizing; the web build uses a 4 GiB Node heap.

## Identity, access, and security facts

| Topic | What ERIS implements today | Caltrans decision or acceptance test |
| --- | --- | --- |
| Entra web sign-in | Single-tenant OIDC authorization code with PKCE. The API validates signing key, issuer, audience, tenant, nonce, and the user's object ID. The exact web redirect is `https://<web-host>/api/auth/entra/callback`. | Choose tenant/cloud and create a **Web** app registration and credential; test real accounts, MFA/Conditional Access, and callback through Caltrans TLS. [Microsoft requires an exact registered redirect URI](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow). |
| Authority | Code permits `login.microsoftonline.com` or `login.microsoftonline.us`. | Identity team confirms which tenant/cloud applies. [Microsoft documents the Government authority](https://learn.microsoft.com/en-us/troubleshoot/entra/entra-id/app-integration/error-aadsts900439-usgclientnotsupportedonpublicendpoint). |
| Entra credential | The current server-side exchange requires a **client secret**. It does not call Microsoft Graph for sign-in. | If policy requires certificate-based client authentication, ERIS needs a code change and a new test before production. |
| User provisioning | Entra proves identity; ERIS holds roles. An admin explicitly links an active ERIS account by tenant ID + Entra **user object ID**. No email-based auto-link or automatic provisioning. | Decide provisioning/offboarding owner and procedure; test linked, unknown, and disabled users. |
| ERIS session | API issues its own HS256 bearer JWT (default 120 minutes). The web currently stores it in `localStorage`; API checks the ERIS user's active flag and roles on each request. | **Security review required:** browser token storage and session lifetime may not meet policy. [OWASP advises against authentication tokens in localStorage](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html). Disabling only the Entra identity does not revoke an already-issued ERIS token; disable the ERIS account for immediate API denial. |
| Network/TLS | The pod speaks localhost HTTP/TCP internally; external HTTPS is terminated by an IT gateway. DB is not host-published. S3 buckets are private with presigned URLs. | Gateway certificates, HSTS/CSP/security headers, rate limits/WAF, upload limit (at least configured `MAX_UPLOAD_MB`, default 95 MB), and firewall policy. Current nginx does not set CSP/HSTS or an application rate limit. |
| Secrets | Runtime `app.env`, `db.env`, `storage.env`, `bootstrap.env` are mode 600 files; Jenkins uses a credential for Harbor push. No secrets belong in images or `VITE_*` build values. | Approved vault/injection and rotation process; host access controls; keep the JWT key stable unless intentionally ending sessions. No vault integration is supplied. |
| Logging/recovery | Application events and container logs exist; a read-only script verifies five containers, health, and Alembic head. | SIEM forwarding, log retention/redaction, alerting, encrypted off-host backups, and a restore drill. The current Campos Labs backups are not yet an off-host recovery proof. |

The Entra handoff cookie is short-lived and HttpOnly, but the subsequent ERIS bearer token is **not** an HttpOnly browser session. Do not describe Entra integration as approved until Caltrans tests it in their tenant. The current API can be configured with `LOCAL_LOGIN_ENABLED=false`; the web must also be rebuilt with that setting so the password form disappears. For future mobile sign-in, register a **separate native/public Entra client** using authorization code + PKCE; the mobile flow is not implemented yet. Microsoft says native clients must not embed a web client secret in the app ([authorization-code guidance](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)).

## How a clean Caltrans deployment would proceed

1. **Agree on the platform and controls.** Confirm Podman versus Kubernetes/OpenShift, whether MariaDB and S3 may live in the same pod, data classification, host/network design, Entra policy, Harbor/Jenkins gates, and RPO/RTO. Identify release, security, DB, identity, network, and application owners.
2. **Create a staging lane.** Caltrans supplies a Linux host, rootless Podman service account, two persistent volumes, approved backup target, two HTTPS names, gateway/firewall rules, Entra test app registration, Jenkins agent, and Harbor project. Allow only agreed outbound destinations.
3. **Build and approve images.** Check out an immutable ERIS commit. Jenkins builds API/worker/web and pushes to Harbor. IT mirrors and approves MariaDB/SeaweedFS, performs required scans/license/SBOM/signature checks, then pins all five image digests. The host proves pull access with its separate robot account.
4. **Set runtime configuration securely.** Use the examples in [`deploy/podman`](../deploy/podman). IT supplies DB/S3/JWT/Entra secrets through its approved mechanism. Match the database and S3 credentials across files; set exact public URLs, CORS origin, and Entra callback. Do not send populated env files in email or tickets.
5. **Run first installation.** As the dedicated service account, run `bash deploy/podman/eris-pod.sh up`. It creates the pod/volumes, initializes MariaDB, applies migrations, verifies buckets, seeds one initial administrator, and starts API, worker, and web. Install the user systemd unit for reboot recovery. The [runbook](caltrans-podman.md#first-installation) has exact commands and failure handling.
6. **Prove the entire path in staging.** Run [`verify-rehearsal.sh`](../deploy/podman/verify-rehearsal.sh), then test the public HTTPS web/API, an evidence upload through the ERIS API and signed download through the S3 hostname, Entra linked/unknown/disabled users, administrator creation, incident workflow, pod restart, reboot, matched backup/restore, and a failed-release rollback. Record results and any accepted exceptions.
7. **Handover and production.** Create and verify at least two named Entra-linked administrators, disable the initial admin, remove its temporary credential, turn off local login in API and rebuilt web, rotate any handover secrets, and repeat the approved release process for production. Caltrans sets the cutover/change window and monitoring.

For an **update**, build and approve new immutable images, capture a matched DB/S3 backup, apply the release in staging, then update pinned references on the host. The supplied Jenkinsfile does not execute that host step. A web-only rollback can restore the previous web image. API/database rollback after a forward migration may require restoring both data volumes and config together; do not assume an older API understands a newer schema.

## What to ask Caltrans IT in the first call

Write down a named owner and answer for each row. An unresolved item is a deployment gate, not an assumed default.

| Priority | Ask them | Why it matters / answer to capture |
| --- | --- | --- |
| 1 | Does “single pod” mean **Podman on one Linux VM**, or Kubernetes/OpenShift? Are stateful MariaDB and S3 allowed in that pod? | Determines whether these scripts are usable as written. |
| 1 | Which Caltrans network/security zone and data classification will ERIS use? Is this a clean install or an authorized import of existing data? | Controls connectivity, retention, reviews, and migration scope. |
| 1 | Who owns the Linux host, rootless service account, disk, SELinux policy, and updates? What CPU/RAM/storage are approved? | Host prerequisites and operational ownership. |
| 1 | Who provides the **web** and **file** DNS names, TLS certificates, gateway, WAF, and firewall rules? Is the gateway co-hosted or remote? | Determines `WEB_BASE_URL`, `S3_PUBLIC_ENDPOINT`, callback, and bind address. |
| 1 | Which Entra tenant/cloud is used? Who owns the Web app registration, exact redirect URI, client credential, first admin object ID, and Conditional Access tests? Is a client secret acceptable? | Current sign-in requires those values; certificate-only policy requires development. |
| 1 | Will Caltrans accept the current browser JWT storage and 120-minute ERIS session? How must offboarding revoke access? | Security decision before SSO production. |
| 1 | Who owns the Harbor project and Jenkins agent? Which digest, scan, signing, SBOM, license, and promotion gates are required? | The supplied pipeline only builds and pushes three ERIS images. |
| 1 | Where will encrypted **matched DB + S3 + config** backups go? What are retention, RPO/RTO, and restore-test requirements? | Single-host failure otherwise loses the service. |
| 1 | Is a single-host service interruption acceptable, or does Caltrans require a failover target? | This deployment has no automatic failover; RPO/RTO alone does not settle availability. |
| 1 | Is browser 3D ArcGIS or Esri offline processing required in the first release? Who supplies a restricted browser API key? | The current Podman web build does not pass `VITE_ARCGIS_API_KEY`; Esri-specific worker sidecars need configuration and a staged test. |
| 2 | Which outbound services may the host and clients reach: Entra, Harbor, GIS, SMTP, Expo? Are proxies required? | Core sign-in needs Entra; optional features have different egress. |
| 2 | Who receives logs/alerts, owns incidents and patch windows, and approves go-live/rollback? | Defines the operating model. |
| 2 | What penetration test, accessibility, privacy, records-retention, and change-control evidence is required? | Prevents a late approval surprise. |
| 2 | What is the eventual mobile distribution and native Entra policy? | The API/S3 network design should support it, but mobile authentication remains future work. |

## What to hand out

**Before the technical call:** this briefing; the [Podman runbook](caltrans-podman.md); [architecture/data model](architecture.md); [role model](roles-and-identity.md); [Jenkinsfile](../Jenkinsfile.podman); [`deploy/podman` templates and scripts](../deploy/podman); a specific source commit and the [Campos Labs rehearsal record](proxmox-podman-cutover.md) labeled as rehearsal evidence. Offer a live screen share of the web workflow.

**After Caltrans settles the design:** an agreed network diagram with real hostnames, port/egress allowlist, five approved image digests, signed/scan/SBOM evidence if required, a completed **non-secret** configuration worksheet, staging test record, backup/restore record, release and rollback steps, administrator handover record, support contacts, and open-risk decisions. Pass credentials and populated env values only through Caltrans's approved secret channel.

## Questions they are likely to ask you

| Question | Direct answer today |
| --- | --- |
| “Is this one image?” | No. It is one Podman pod with five containers and two persistent volumes. |
| “Where do the images come from?” | Caltrans Jenkins builds our three application images from an approved commit and pushes them to Caltrans Harbor. IT mirrors the MariaDB and SeaweedFS images. The host pulls five approved digests. |
| “What about SeaweedFS licensing?” | The upstream 4.50 source tag carries Apache-2.0; Caltrans must review the exact image and dependency inventory. No SeaweedFS Enterprise image is in this design. |
| “Do you require a managed database?” | The supplied design uses MariaDB 11 in the pod. If policy requires a managed DB or external object store, we must adjust and test the topology. |
| “What leaves the network?” | Entra and Harbor are required for the proposed flow. GIS, SMTP, and Expo depend on enabled features. Browsers also fetch map/data sources where configured. We need an approved egress inventory for their environment. |
| “Who can become an administrator?” | Only an authorized ERIS admin grants ERIS roles. Entra authentication alone does not grant ERIS access; users are prelinked by tenant and object ID. |
| “Will disabling an Entra user immediately stop ERIS?” | Not necessarily for an already-issued ERIS JWT. Disable the ERIS account for immediate API denial; session policy needs IT review. |
| “Is this highly available?” | No. A single host is a single point of failure; recovery is from a tested matched backup. |
| “Is the mobile app ready?” | No Caltrans mobile release is in this deployment. Its future native Entra client and network tests are planned separately. |
| “Is security approval complete?” | No Caltrans approval is claimed. We have implementation/tests and a working Podman rehearsal; Caltrans identity, scan, session, gateway, logging, recovery, and governance checks remain. |

## Decision record for the call

| Decision | Answer / owner / due date |
| --- | --- |
| Podman pod accepted; stateful services accepted |  |
| Caltrans environment and data import scope |  |
| Host OS, Podman version, capacity, service account |  |
| Web and S3 DNS/TLS names; gateway placement |  |
| Entra tenant/cloud, app registration, first admin object ID |  |
| Client secret versus certificate requirement |  |
| Session storage/lifetime and offboarding policy |  |
| Harbor/Jenkins owner and supply-chain gates |  |
| Backup target, RPO/RTO, retention, restore-test owner |  |
| Single-host availability accepted or failover target defined |  |
| Browser ArcGIS / Esri offline scope and API key owner |  |
| Egress, logging, WAF and security review owner |  |
| Staging date, acceptance owner, production change window |  |

## Source of truth and limits

The [Podman runbook](caltrans-podman.md), [`eris-pod.sh`](../deploy/podman/eris-pod.sh), [runtime env examples](../deploy/podman), [Entra implementation](../backend/app/entra.py), and [Jenkinsfile](../Jenkinsfile.podman) define the shipped behavior. This briefing is for discussion and does not replace a Caltrans architecture/security review. The Podman worker currently runs the **generic** terrain job entrypoint; Esri-specific high-fidelity offline sidecars require additional runtime configuration and a staged job test. The Podman web build does not currently pass `VITE_ARCGIS_API_KEY`, so browser 3D ArcGIS requires a build change and a restricted key. Do not promise these features as part of the first deployment until they pass staging. The future mobile Entra flow likewise needs implementation and acceptance before release.

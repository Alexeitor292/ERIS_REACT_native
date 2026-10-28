# Caltrans single-Podman-pod deployment

To rehearse this deployment beside the existing Proxmox Compose server, use
the [Proxmox rehearsal plan](history/proxmox-caltrans-rehearsal.md).
For a populated Compose database and MinIO cutover, use the
[Proxmox data cutover record](history/proxmox-podman-cutover.md). On an imported
database, set `ERIS_ADOPT_ADMIN_EMAIL` to the exact active existing admin
email for the first Podman start; `adopt_existing_admin` verifies the ADMIN
role and creates the one-time marker before bootstrap runs. Remove the env
value after success. `ERIS_DB_VOLUME` and `ERIS_STORAGE_VOLUME` can select
new named volumes while retaining earlier rehearsal data.

This is the operator runbook for a **single Linux Podman pod**. Harbor is the
container registry; Jenkins builds and pushes the ERIS images. The pod contains
five containers: nginx/web, FastAPI, the terrain worker, MariaDB, and SeaweedFS.
They share one network namespace and reach each other at `127.0.0.1`. By
default only host loopback ports 8080 (web and `/api`) and 9800 (SeaweedFS S3)
are published.
Caltrans IT supplies the host, TLS reverse proxy, DNS, Harbor, Jenkins, and
backup target. This is a single-host deployment with one point of failure.

## Decisions to obtain from Caltrans IT

Record these before production cutover:

| Item | Required decision |
| --- | --- |
| Host | Linux distribution, Podman version (5.x preferred), rootless service account, CPU/RAM, disk and SELinux policy. Budget at least 8 GB RAM for runtime; size disk for database, evidence and terrain packages. |
| Harbor | Host/project, robot pull credentials on server, robot push credentials in Jenkins, image scanning policy, and mirror locations for MariaDB 11 and SeaweedFS 4.50. Pin approved digests for production. |
| TLS and DNS | Browser URL (for example `https://eris.example.gov`) and S3 URL (`https://eris-files.example.gov`). A proxy on the same host uses `127.0.0.1:8080` and `127.0.0.1:9800`. A remote proxy needs the pod ports bound to a private host interface with firewall rules. Preserve S3 `Host`, path, query and percent encoding. Upload body limit must exceed `MAX_UPLOAD_MB` (default 95 MB). |
| Entra | Workforce tenant ID, authority cloud (`login.microsoftonline.com` or Azure Government `login.microsoftonline.us`), web app client ID, the client **certificate** (issued by Caltrans PKI or self-signed, per policy), the mobile app registration if mobile is in scope, app registration owner, and the first administrator's **user object ID**. Register web redirect URI exactly `https://eris.example.gov/api/auth/entra/callback`. Single-tenant app; no group or app role grants ERIS privileges. |
| Network | Outbound HTTPS to the chosen Entra authority for sign-in and signing keys; Harbor; optional USGS, Caltrans and other GIS services for terrain jobs; optional SMTP and Expo push. Browsers and future phones must reach both URLs. |
| Operations | Backup location and retention, restart owner, log collection, RPO/RTO, certificate rotation, secret rotation, maintenance window, and vulnerability scan gate. |

## Files and secrets

Place this repository on the host at `/opt/eris` (or another readable path).
The deployment script resolves its location, so the path is not fixed. Copy
the five examples in [`deploy/podman`](../../deploy/podman) to files without
`.example` and set `chmod 600` on `db.env`, `storage.env`, `app.env`, and
`bootstrap.env`.
Never commit these files or the `secrets/` folder, or put credentials in
Jenkins build arguments or any image. `images.env` contains references
only. The examples are placeholders and will not work as-is.

Keep these pairs identical:

- `db.env` `MARIADB_PASSWORD` = `app.env` `DB_PASS`.
- `storage.env` `AWS_ACCESS_KEY_ID` = `app.env` `S3_ACCESS_KEY`; likewise the
  secret keys. SeaweedFS's `S3_BUCKET` and ERIS `S3_BUCKET` must agree.
- `WEB_BASE_URL`, `CORS_ORIGINS`, and the base of `ENTRA_REDIRECT_URI` use the
  browser HTTPS URL. `S3_PUBLIC_ENDPOINT` uses the client-reachable S3 HTTPS URL.
- `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID` are UUIDs. The redirect URI ends in
  `/api/auth/entra/callback` exactly. Set `ENTRA_AUTHORITY_HOST` to the tenant's
  public or Azure Government cloud endpoint.

Use separate randomly generated database, S3, JWT and Entra secrets. `JWT_SECRET`
must remain stable across restarts, or all sessions end. Example generation:
`openssl rand -hex 32`. With `ENV=prod` the API refuses to start unless
`JWT_SECRET` has at least 32 characters, `WEB_BASE_URL` is `https://`, and the
session limits are within NIST SP 800-63B AAL2 bounds: `SESSION_IDLE_MINUTES`
(default 30) at least 5, and `SESSION_ABSOLUTE_MINUTES` (default 720) at most
720. Keep a secure copy of the secrets with the recovery procedure.

The Caltrans template is **Entra-only** (`LOCAL_LOGIN_ENABLED=false`). IT
supplies the first administrator's Entra user object ID as
`ERIS_BOOTSTRAP_ADMIN_ENTRA_OBJECT_ID` in `bootstrap.env`; with password sign-in
off, bootstrap refuses a password. Delete `bootstrap.env` after the first
successful start.

## Jenkins and Harbor

No Jenkins job exists yet: everything it needs is in this repository.

### Creating the Jenkins job

1. **New Item** → name `eris` → **Pipeline**.
2. **Pipeline** → **Definition:** *Pipeline script from SCM*, **SCM:** Git.
   - **Repository URL:** the Caltrans copy of this repository, with a
     read-only credential.
   - **Branch Specifier:** `*/main`.
   - **Script Path:** `deploy/ci/Jenkinsfile.podman`.
3. **Agent:** an approved Linux agent with Podman, repository and Harbor
   access, and room for the web build's 4 GiB Node heap. The pipeline runs
   its tools (Trivy, cosign) as containers, so nothing else is installed.
4. **Credentials:** the three below for publishing; for deploying, also
   `eris-deploy-staging`, `eris-deploy-production` (SSH username with
   private key, one key per host) and `eris-known-hosts` (secret file)
   ([releases from Jenkins](#releases-from-jenkins-no-shell-access-for-jenkins)).
5. **Save**, then **Build with Parameters**. The first run lists the
   parameters; set `HARBOR_HOST`, `HARBOR_PROJECT`, `MARIADB_SOURCE` and
   `SEAWEEDFS_SOURCE` to the Caltrans values and leave `DEPLOY_TO=none`
   until a staging host is ready.

Success: the build is green and archives `release/release-images.env`, the
SBOMs and the scan reports (below).

### What the pipeline does

The job needs these three Jenkins credentials to publish:

| Credential ID | Type | Holds |
| --- | --- | --- |
| `harbor-eris-robot` | Username/password | Harbor robot with push (and signature push) rights on the ERIS project |
| `eris-cosign-key` | Secret file | The release signing private key (`cosign.key`, encrypted) |
| `eris-cosign-password` | Secret text | That key's password |

IT creates the signing key pair once, with `cosign generate-key-pair` run
offline. The private key and password live only in those Jenkins credentials.
The public key (`cosign.pub`) is distributed to each host and to Harbor.

For each release (`HARBOR_HOST`, `HARBOR_PROJECT`, an immutable `RELEASE_TAG`):

1. **Validate.** Syntax-check all scripts, and run the deployment and
   release-gate script tests against stub Podman.
2. **Build.** Build API, worker and web, labelled with the source commit and
   tag. Python compiles, and the web bundle builds in a plain Podman container
   (`deploy/podman/build-web.sh`; Podman/Buildah 4.9 mis-resolved a Lit
   package inside a Dockerfile `RUN`).
3. **Backend security tests.** Sessions, CSRF, route guards, Entra
   certificate, mobile token exchange and handover.
4. **SBOM and vulnerability gate**
   ([`deploy/ci/release-gate.sh`](../../deploy/ci/release-gate.sh)).
   [Trivy](https://trivy.dev/) writes a CycloneDX SBOM of every package in each
   image. The build fails on a `TRIVY_SEVERITY` (default HIGH,CRITICAL)
   vulnerability that has a fix available, or on any secret embedded in an
   image. Nothing is pushed if this fails. Accepted exceptions go in
   [`.trivyignore`](../../.trivyignore), each with a reason, an approver and an
   expiry, reviewed like code.
5. **Publish, sign and attest.**
   - The IT-approved MariaDB and SeaweedFS mirrors (`MARIADB_SOURCE`,
     `SEAWEEDFS_SOURCE`) pass the same gate.
   - The three ERIS images are pushed, and the digests Harbor stored are
     recorded.
   - All five digests are signed with [cosign](https://docs.sigstore.dev/)
     using the Caltrans key, and each SBOM is attached as a signed CycloneDX
     attestation. Signatures are stored in Harbor; nothing goes to the public
     Sigstore transparency log.
   - Each signature is verified before the build succeeds.
6. **Evidence.** The build archives `release/release-images.env` (all five
   digests, `ERIS_REQUIRE_DIGESTS=true`), `release/sbom/*.cdx.json`, the scan
   reports `release/sbom/*.vulns.json` (kept even when the gate fails), and
   `release/cosign.pub`.

Tools run as pinned containers (`TRIVY_IMAGE`, `COSIGN_IMAGE`); mirror both
into Harbor and pin them by digest. For an agent without internet access,
mirror the Trivy vulnerability database into Harbor and set
`TRIVY_DB_REPOSITORY`. Recommended Harbor project settings:
- immutable tags
- **Prevent vulnerable images from running**, using Harbor's scanner, as a
  second gate on images already published
- **Cosign signature enforcement**, so Harbor only serves signed artifacts

The web image is built with API base `/api` (the session cookie only flows
same-origin). The login page asks the API (`/api/auth/config`) which sign-in
methods are on; the `ENTRA_ENABLED`/`LOCAL_LOGIN_ENABLED` build parameters
(defaults true/false) are only a fallback if that request fails. Other browser
`VITE_*` values are compile-time public settings; changing them requires a new
web image. The pipeline never places secrets in images. It deploys only when
`DEPLOY_TO` is `staging` or `staging-then-production`, and then only through
each host's `deploy-hook.sh`.

### On the host: pinned digests and enforced signatures

Copy `release-images.env` into `images.env` after IT approval
(`ERIS_REQUIRE_DIGESTS=true` makes `eris-pod.sh` refuse any tag). Then make
Podman itself refuse unsigned images for the service account:

```bash
mkdir -p ~/.config/containers/registries.d
cp release/cosign.pub /opt/eris/deploy/podman/signature-policy/cosign.pub
cp deploy/podman/signature-policy/policy.json.example ~/.config/containers/policy.json
cp deploy/podman/signature-policy/registries.d-eris.yaml.example ~/.config/containers/registries.d/eris.yaml
# Edit both: replace harbor.example.gov/eris and the keyPath.
podman login harbor.example.gov            # pull-only robot
bash deploy/podman/eris-pod.sh pull         # fails if any signature does not verify
```

The policy rejects every image source except signed images from the ERIS
Harbor project and images already in local storage. Pull before each
installation or release, so every image in local storage arrived through a
verified signature. `verify-rehearsal.sh` checks that the policy is in place.
Source images and licenses should be reviewed by IT; the SBOMs list every
package and license.

## First installation

Run as the dedicated Podman service account on the Linux host:

```bash
cd /opt/eris
for name in images db storage app bootstrap; do
  cp "deploy/podman/$name.env.example" "deploy/podman/$name.env"
done
chmod 600 deploy/podman/{db,storage,app,bootstrap}.env
# Edit the five .env files; replace every CHANGE_ME and example.gov value.
# Put the Entra certificate and key in deploy/podman/secrets (see "Client certificate").
# Install the signature policy (see "On the host: pinned digests and enforced signatures").
podman login harbor.example.gov
bash deploy/podman/eris-pod.sh pull
bash deploy/podman/eris-pod.sh up
bash deploy/podman/eris-pod.sh status
bash deploy/podman/eris-pod.sh cert-check
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/api/health
```

The copies above create five named files. The script
starts MariaDB with `database/init` mounted read-only. MariaDB runs those SQL
files only for an empty named volume: they create schema, roles and minimum
organization data, with **no demo accounts**. The script waits for MariaDB,
starts SeaweedFS, stamps the fresh SQL baseline and upgrades migrations,
creates/verifies private S3 buckets, seeds one initial admin, then starts API,
worker and web. A failure exits nonzero; inspect `podman logs eris-<name>` and
fix the cause before proceeding. The named `eris-mariadb` and `eris-seaweedfs`
volumes persist even if the pod is removed.

For unattended restart, install
[`eris.service.example`](../../deploy/podman/eris.service.example) as the
dedicated account's user systemd unit, adjusting `/opt/eris` if needed. Enable
it with `systemctl --user enable --now eris.service` and configure user
lingering according to IT policy. Its `start` action starts an existing pod or
creates a fresh one. Do not run two copies against the same volumes.

The HTTPS reverse proxy must forward `/api/*` unchanged to port 8080; nginx
removes `/api/` before sending to FastAPI. It forwards every S3 request to
port 9800 without changing the signed host or URI. Test both URLs through TLS,
not just loopback, before Entra sign-in or uploads. Do not publish MariaDB or
the SeaweedFS admin interface. Keep 8080/9800 on loopback when the proxy is
local. If Caltrans uses a remote TLS gateway, run
`ERIS_BIND_IP=<host-private-IP> bash deploy/podman/eris-pod.sh up` and set the same environment in the
systemd unit; permit ports 8080 and 9800 only from the gateway. The binding
is fixed at pod creation, so changing it requires an explicit pod removal and
recreation while retaining the volumes. The nginx example below assumes a
same-host gateway; replace its upstream addresses for a remote gateway.
For an nginx TLS gateway, the essential forwarding rules are:

```nginx
# Inside the eris.example.gov TLS server block:
location / {
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_pass http://127.0.0.1:8080;
}
# Inside the eris-files.example.gov TLS server block:
location / {
    client_max_body_size 100m;
    proxy_request_buffering off;
    proxy_set_header Host $host;
    proxy_pass http://127.0.0.1:9800;
}
```

TLS certificates, timeouts and gateway access logs follow Caltrans policy.
After an interrupted first start, inspect logs, fix the cause, run
`bash deploy/podman/eris-pod.sh remove` and then `up` again; removing the pod
does not remove the two named data volumes.

## Entra sign-in and handover

ERIS for Caltrans has **no passwords**. Opening the ERIS address sends the
browser straight to Caltrans's Entra sign-in, as other Caltrans web apps do. On
a managed Windows device Entra usually recognises the signed-in dot.ca.gov
account and applies MFA and Conditional Access according to Caltrans policy.
Entra then returns to ERIS, which admits the person only if an active ERIS
account is linked to that exact Entra identity. Two independent checks decide
who gets in:

- **Entra (Caltrans IT):** recommended: set the ERIS enterprise application to
  **Assignment required = Yes** and assign only the ERIS staff group, so
  unassigned staff are stopped by Entra. Enforce MFA through a Conditional
  Access policy targeting the ERIS app. ERIS does not check MFA itself; it
  trusts Caltrans's Entra policy.
- **ERIS (administrators):** an Entra identity gets in only when an ERIS
  administrator has linked it, by tenant ID + user object ID, to an active ERIS
  account. Roles come from ERIS, never from Entra claims or groups.

The sign-in uses authorization code + PKCE and verifies tenant, issuer,
audience, signature and nonce. After a sign-out, or a failed or refused
attempt, the page shows a button instead of redirecting, so it never loops.

Handover:

1. Sign in through Entra as the initial administrator (the object ID from
   `bootstrap.env`).
2. Open **Administration → Users**. Create another admin with their work email,
   name and Entra **user object ID** (from the tenant's Users directory), then
   grant Administrator. Account creation alone makes a Guest; it does not grant
   admin rights. No password field is offered: the API refuses to set one.
3. Have the new administrator sign in through Entra and confirm their admin
   page works. Create at least one more admin for recovery. ERIS refuses to let
   an administrator disable their own account or the last active
   administrator. A disabled account is refused at its next request, and
   disabling also ends its sessions.
4. Delete `bootstrap.env`. Keep the bootstrap marker and initial user record;
   re-running bootstrap never recreates or reactivates it.
5. Run `bash deploy/podman/eris-pod.sh handover-check`. It reads the running
   API's settings and the database and exits 0 only when at least two active
   administrators are Entra-linked and have signed in through Entra, the
   bootstrap admin is disabled (or Entra-only), no active administrator has a
   password, password sign-in is off, and `bootstrap.env` is gone. It prints
   user IDs and counts only, so its output can go into the change record.

Recovery without passwords: if every administrator is lost, IT links a new
administrator with `app.tools.create_admin` run in the pod (see the tool's
`--help`), under change control. Caltrans's own Entra emergency-access
accounts cover the identity side.

If Entra sign-in fails, the browser returns to the ERIS sign-in page with a
short reason (`cancelled`, `failed`, `not_linked` or `unavailable`) instead of
an API error page. The API logs each outcome to the `eris.auth` logger
(`podman logs eris-api`): successful sign-ins by ERIS user ID, refusals with
tenant and object ID, never tokens or authorization codes.

### Sessions

After a verified sign-in ERIS creates a **server-side session**, following the
OWASP Session Management guidance:

- The browser holds only a random 256-bit credential in a `__Host-eris_session`
  cookie marked HttpOnly, Secure, SameSite=Strict, Path=/, with no expiry (it
  ends with the browser). Page scripts cannot read it, so a cross-site
  scripting bug cannot steal a session. The database stores only its SHA-256.
- Every state-changing request must carry the session's CSRF token
  (`X-CSRF-Token`, signed double-submit). Browser writes from another origin are
  refused before any route runs.
- A session ends after `SESSION_IDLE_MINUTES` without a request (30) and after
  `SESSION_ABSOLUTE_MINUTES` in total (720), whichever comes first. On a Caltrans
  device the next Entra sign-in is usually silent.
- **Sign out** ends that browser's session only. **Sign out everywhere**
  (`POST /auth/sessions/revoke-all`, or **Administration → Users → Sign out
  everywhere** for someone else), disabling the account, and a password reset
  (rehearsals only) end all of them. Roles and the active flag are read on
  every request.
- Disabling someone only in Entra stops new sign-ins but not a session ERIS
  already issued; offboarding should disable the ERIS account. That takes
  effect at the person's next request.
- Native clients (the future mobile app, scripts) get the credential once as a
  bearer token instead of a cookie. Browsers are recognised by headers they
  always send, so the web never receives one.

Upgrading to this release signs everyone out once: earlier tokens are not
sessions.

Entra accounts are **prelinked by object ID**, never auto-linked by email.
Users who exist in Entra but have no active linked ERIS account get 403. If an
object ID was entered incorrectly, create a corrected account through the
admin process; do not edit IDs by hand without an audited recovery procedure.
No Microsoft Graph permission is needed for sign-in. The app registration
needs the ordinary OpenID Connect scopes `openid profile email` and a web
redirect URI.

### Client certificate (no client secret)

The API authenticates to Entra with a **certificate**: it signs a short-lived
client assertion (PS256, `x5t#S256`) with a private key that never leaves the
host. There is no shared secret to leak or copy into a ticket. With `ENV=prod`
the API refuses to start with Entra on and no certificate configured, and
refuses a client secret outright.

1. Obtain an RSA certificate of at least 2048 bits: from Caltrans PKI per
   policy, or self-signed, which Entra accepts for client credentials:
   ```bash
   install -d -m 700 deploy/podman/secrets
   openssl req -x509 -newkey rsa:3072 -sha256 -days 365 -nodes \
     -subj "/CN=ERIS Entra client" \
     -keyout deploy/podman/secrets/entra-client.key -out deploy/podman/secrets/entra-client.crt
   chmod 600 deploy/podman/secrets/*
   ```
2. Upload **only the certificate** (`entra-client.crt`) under the web app
   registration's **Certificates & secrets → Certificates**. Delete any client
   secrets there.
3. `app.env` names the files as the API sees them:
   `ENTRA_CLIENT_CERT_FILE=/run/secrets/eris/entra-client.crt` and
   `ENTRA_CLIENT_KEY_FILE=/run/secrets/eris/entra-client.key`. `eris-pod.sh`
   mounts `deploy/podman/secrets` read-only into the API container only. It
   refuses to start if the folder or its files are readable by others.
4. `bash deploy/podman/eris-pod.sh cert-check` prints the certificate's
   thumbprint (compare it with the one Entra lists) and its expiry. It fails
   if the key and certificate do not match, the key is weaker than 2048 bits,
   or the certificate has expired. It warns within 30 days of expiry, and the
   production verification fails on that warning.

Rotation: upload the new certificate beside the old one, replace both files in
`deploy/podman/secrets`, then recreate the pod (`eris-pod.sh remove`, then
`up`). Confirm with `cert-check` and an Entra sign-in, then delete the old
certificate from the app registration. Backups include the `secrets` folder.

## Operations

| Task | Command / rule |
| --- | --- |
| Status | `bash deploy/podman/eris-pod.sh status`; `podman logs eris-api`, `eris-worker`, `eris-mariadb`, `eris-seaweedfs`, `eris-web`. |
| Stop/start | `podman pod stop eris` / `podman pod start eris`. |
| Release | `eris-pod.sh release FILE` (below): pull, matched backup, migrate, verify, and automatic rollback on failure. Run it by hand, or let Jenkins trigger it through `deploy-hook.sh`. |
| Rollback | Automatic when a release fails. By hand: `eris-pod.sh restore` the pre-release backup into new volumes, with the previous images/env together. Do not point an older API at a database upgraded by a newer release unless that migration is explicitly backward compatible. |
| Backup | `eris-pod.sh backup DIR` (below): cold, matched MariaDB + SeaweedFS + config, with checksums. The two volumes are a single recovery set; a DB-only backup leaves missing evidence. Encrypt it and move it off the host. |
| Verify | `bash deploy/podman/verify-rehearsal.sh https://<web-host> https://<files-host>` after every install, release, restore and handover (below). |
| Health | `/healthz` tests nginx; `/api/health` tests API. Confirm a sign-in, an admin operation and an upload/download through public TLS URLs in staging. |

### Releases: one command, automatic rollback

`eris-pod.sh release FILE` applies a release file (the `release-images.env`
Jenkins archives) in one step:

1. **Check the file.** It must contain exactly the five `name@sha256:` image
   references (and optionally `ERIS_REQUIRE_DIGESTS=true`) and nothing else,
   so no shell syntax can reach the script. Only one release runs at a time.
2. **Pull** all five images under the signature policy, before anything stops.
3. **Back up.** A matched pre-release backup goes to
   `$ERIS_BACKUP_ROOT/pre-release-<time>`; the pod stops briefly.
4. **Switch.** Install the new `images.env` (the old one is kept as
   `images.env.previous`) and recreate the pod. Forward migrations run before
   the API starts.
5. **Verify.** Run `verify-rehearsal.sh` against `ERIS_PUBLIC_URL` in the
   production profile, or, if no URL is set, wait for API health only.
6. **Roll back on any failure.** Restore the previous images, restore the
   pre-release backup into **new** volumes (the failed release may have
   migrated the data), record those volume names in `volumes.env` (systemd and
   later commands follow it), and start again. The volumes the failed release
   touched are kept for investigation.

Every outcome is appended to `deploy/podman/releases.log`. Settings come from
`deploy/podman/release.env` (copy
[`release.env.example`](../../deploy/podman/release.env.example); no secrets).
The release takes the service down for the backup and restart, so schedule it
in the change window. If even the rollback fails, the command says so and the
pre-release backup is the recovery point.

```bash
bash deploy/podman/eris-pod.sh release /path/to/release-images.env
```

### Releases from Jenkins (no shell access for Jenkins)

With `DEPLOY_TO=staging` or `staging-then-production`, the pipeline sends the
release file it just built and signed to each host's
[`deploy-hook.sh`](../../deploy/podman/deploy-hook.sh) over SSH. The production
release is the same digests that just passed staging, sent only after a named
approver in `PRODUCTION_APPROVERS` approves it in Jenkins; put the change
ticket in the approval comment. A failed release on either host fails the
build, after that host has rolled itself back.

The deploy key can do nothing but release. On each host, as the service
account, add Jenkins's public key to `~/.ssh/authorized_keys` as a forced
command on one line:

```
restrict,command="/opt/eris/deploy/podman/deploy-hook.sh" ssh-ed25519 AAAA... jenkins-eris-deploy-staging
```

`restrict` turns off port, agent and X11 forwarding and the terminal. Any
command Jenkins asks for is ignored. The hook reads at most 4 KB from stdin and
passes it to `release`, which validates it strictly. Jenkins needs the
credentials `eris-deploy-staging` and `eris-deploy-production` (SSH username
with private key; a separate key per host) and `eris-known-hosts` (a secret
file pinning each host's SSH key). The firewall must allow SSH from the Jenkins
agent to the hosts. Changes to the deployment scripts themselves (this
repository on the host) are still applied by updating the host checkout to the
approved commit.

### Backup and restore

`backup` takes a **cold** matched backup. It stops the pod, exports both named
volumes, copies `images.env`, `db.env`, `storage.env` and `app.env` (not
`bootstrap.env`), and writes `manifest.env` (time, volume names, Alembic
revision, image references and image IDs) and `SHA256SUMS`. It then restarts the
pod if it was running and verifies the result. The directory is created mode
700 and must not exist yet. If an export fails, the pod is restarted and the
command exits nonzero. Expect an outage for the length of the export.

```bash
bash deploy/podman/eris-pod.sh backup /secure/eris-backups/2026-10-28
bash deploy/podman/eris-pod.sh verify-backup /secure/eris-backups/2026-10-28
```

The backup contains the database, evidence and **secrets**. Encrypt it and move
it to the approved off-host target; re-run `verify-backup` after copying it back.

`restore` imports into **new, empty** volumes only (`podman volume import`
merges into an existing volume, which would mix two points in time). It refuses
to run while the pod exists, when a target volume already exists, or when
`db.env`, `storage.env` or `app.env` differ from the backup's copies. Copy the
backup's `config/*.env` into `deploy/podman` first, and use the backup's
`images.env` unless the newer images are known to handle that schema; restore
warns when `images.env` differs.

```bash
bash deploy/podman/eris-pod.sh remove      # keeps the current volumes
export ERIS_DB_VOLUME=eris-mariadb-r20261028 ERIS_STORAGE_VOLUME=eris-seaweedfs-r20261028
bash deploy/podman/eris-pod.sh restore /secure/eris-backups/2026-10-28
bash deploy/podman/eris-pod.sh up
```

Set the same two variables in the systemd unit, run the verification below,
and keep the old volumes until the restore is accepted. Rehearse this on
staging: the scripts are tested against a stub Podman
(`deploy/podman/tests`), not yet against Caltrans storage. The approved backup
product may replace these commands if it gives a consistent, jointly restorable
snapshot of both volumes.

### Deployment verification

`verify-rehearsal.sh` is read-only. Run it as the service account after every
install, release, restore and handover:

```bash
bash deploy/podman/verify-rehearsal.sh https://eris.example.gov https://eris-files.example.gov
```

It **fails** when a container is stopped or runs an image other than the one
`images.env` names, MariaDB/API/SeaweedFS internal ports are published, a
runtime env file is not mode 600/400, `/healthz` or `/api/health` fail, API docs
are reachable, the Entra start redirect is not the tenant authority with PKCE
and this site's callback, the database is not at Alembic head, or an anonymous
request can list the upload bucket, or an anonymous request is signed in. It
**warns** on images without digests, HSTS missing at the gateway, password
sign-in on, and a leftover `bootstrap.env`. Those four are production gates:
run production verification as

```bash
ERIS_VERIFY_PROFILE=production bash deploy/podman/verify-rehearsal.sh https://eris.example.gov https://eris-files.example.gov
```

and each becomes a failure. Entra sign-in with real accounts (linked,
unknown, unassigned, disabled), MFA prompts, upload and signed download,
restart/reboot, restore and rollback remain manual tests.

Monitor free space (especially terrain packages), DB health, S3 bucket checks,
worker logs, certificate and Entra-secret expiration. SMTP and Expo push are
optional; enable only after Caltrans supplies approved relays/credentials.

## Mobile sign-in (Entra)

**The Caltrans iOS app will be native Swift** (decided 2026-10-28), built on the Caltrans Mac
mini, signed with Caltrans's Apple Developer Enterprise Program account, and distributed as an
Intune line-of-business app through Company Portal. There is no Android app. Push goes
through APNs (`APNS_*` settings; the `.p8` key goes in `deploy/podman/secrets`; outbound
`api.push.apple.com:443`). It signs in with **MSAL for iOS
through Microsoft Authenticator** against the same server endpoint. The
[iOS app specification](../development/ios.md) is the build contract, and records an iPhone check
indicating that Caltrans relies on device compliance, not app protection. The Expo app
described below is the reference implementation until the Swift app reaches parity.


The mobile app signs in through Caltrans Entra following
[OAuth 2.0 for Native Apps (RFC 8252)](https://www.rfc-editor.org/rfc/rfc8252):
1. It opens Entra in the system browser (iOS `ASWebAuthenticationSession`,
   Android Custom Tabs), which shares the device's Entra sign-in, so MFA and
   Conditional Access apply as they do on the web.
2. It uses authorization code + PKCE as a separate **public** client. There is
   no secret in the app.
3. It requests an access token for the ERIS API scope and sends it once to
   `POST /api/auth/entra/native`.
4. ERIS verifies the token: signature, issuer, tenant, audience, the
   `access_as_user` scope, and that it was issued **to the ERIS mobile app**
   (`azp`). ERIS then matches the prelinked `(tenant, object ID)` exactly as
   for the web.
5. ERIS returns its own revocable bearer session. The Entra token is
   discarded, and browsers are refused at this endpoint.

Mobile sessions follow the same rules as the web, except that they have no
idle timeout (12 hours absolute). Signing out on the phone ends that device's
session only.

Entra setup (IT):

1. On the **web** app registration, under **Expose an API**: set the
   Application ID URI (default `api://<web-client-id>`) and add the scope
   `access_as_user`, admin consent only. In its **Manifest**, set
   `"requestedAccessTokenVersion": 2`; ERIS accepts only v2.0 tokens.
2. Create a second app registration, **ERIS Mobile**, single tenant. Under
   **Authentication → Add a platform → Mobile and desktop applications**, add
   the redirect URI `com.juancampos.eris.mobile://auth/entra` (the app's bundle
   identifier; a Caltrans build with another identifier changes both the URI
   and `EXPO_PUBLIC_ENTRA_REDIRECT_URI`). Add no secret or certificate.
3. Under **API permissions**, add the delegated permission
   `access_as_user` on the ERIS web API and grant admin consent.
4. Apply the same assignment and Conditional Access policy to ERIS Mobile.
5. In `app.env`: set `ENTRA_MOBILE_CLIENT_ID=<ERIS Mobile client ID>` and
   `ENTRA_API_SCOPE=api://<web-client-id>/access_as_user`. The app reads
   these public values from `/api/auth/config`, so no app rebuild is needed.

**Intune.** What the app needs depends on the Conditional Access grant that
Caltrans applies to iOS and Android; Caltrans's Intune admin must confirm it:

- **Require a compliant device** (devices enrolled through Company Portal). The
  system-browser sign-in can pass device state through the **Microsoft
  Enterprise SSO plug-in for Apple devices** if Intune's SSO extension profile
  allows the ERIS app's bundle identifier (or allows all apps). This needs no
  ERIS code change, but it must be tested on an enrolled device.
- **Require app protection policy** (Intune MAM: copy/paste, save-as and
  data-transfer rules inside the app). The app must integrate the **Intune App
  SDK** and sign in with **MSAL through the Microsoft Authenticator broker**,
  instead of the system browser. That is native iOS/Android work (an Expo
  native module or config plugin), built and tested on macOS with enrolled
  devices. The server side is already compatible: MSAL returns the same kind of
  access token for the ERIS API scope, issued to the ERIS Mobile client, which
  `/auth/entra/native` accepts unchanged.
- Distribution as a line-of-business app through Intune (or Apple Business
  Manager) is independent of both and needs a signed release build.

The custom redirect scheme needs a development or store build of the app (not
Expo Go). Tested so far: the PKCE and URL logic (unit tests) and the server
exchange (unit tests with signed tokens). A real device against a Caltrans
tenant has **not** been tested. Mobile attachment previews use presigned
storage URLs, falling back to the API with an `Authorization` header; there is
never a token in a URL. Confirm phone reachability to both ERIS and S3 HTTPS
URLs, and decide whether approved Expo push service traffic is allowed.

## Protocol references

- [Podman pods and shared localhost/port publishing](https://docs.podman.io/en/latest/markdown/podman-create.1.html)
- [Podman volume export](https://docs.podman.io/en/stable/markdown/podman-volume-export.1.html) and [volume import](https://docs.podman.io/en/latest/markdown/podman-volume-import.1.html)
- [Microsoft identity platform authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [Microsoft Entra ID token validation](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens) and [user/tenant ID claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference)
- [Microsoft Entra authority for Azure Government](https://learn.microsoft.com/en-us/azure/azure-government/documentation-government-plan-identity)

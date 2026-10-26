# Caltrans single-Podman-pod deployment

To rehearse this deployment beside the existing Proxmox Compose server, use
the [Proxmox rehearsal plan](proxmox-caltrans-rehearsal.md).
For a populated Compose database and MinIO cutover, use the
[Proxmox data cutover record](proxmox-podman-cutover.md). On an imported
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
| Entra | Workforce tenant ID, authority cloud (`login.microsoftonline.com` or Azure Government `login.microsoftonline.us`), web app client ID, client secret/certificate policy, app registration owner, and the first administrator's **user object ID**. Register web redirect URI exactly `https://eris.example.gov/api/auth/entra/callback`. Single-tenant app; no group or app role grants ERIS privileges. |
| Network | Outbound HTTPS to the chosen Entra authority for sign-in and signing keys; Harbor; optional USGS, Caltrans and other GIS services for terrain jobs; optional SMTP and Expo push. Browsers and future phones must reach both URLs. |
| Operations | Backup location and retention, restart owner, log collection, RPO/RTO, certificate rotation, secret rotation, maintenance window, and vulnerability scan gate. |

## Files and secrets

Place this repository on the host at `/opt/eris` (or another readable path).
The deployment script resolves its location, so the path is not fixed. Copy
the five examples in [`deploy/podman`](../deploy/podman) to files without
`.example` and set `chmod 600` on `db.env`, `storage.env`, `app.env`, and
`bootstrap.env`.
Never commit these files, put credentials in Jenkins build arguments, or store
the Entra client secret in the web image. `images.env` contains references
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
`openssl rand -hex 32`. Keep a secure copy of the secrets with the recovery
procedure. `ERIS_BOOTSTRAP_ADMIN_PASSWORD` is a temporary initial credential
in `bootstrap.env`; delete that file after the first successful bootstrap. If IT supplies
the first admin's Entra object ID, set
`ERIS_BOOTSTRAP_ADMIN_ENTRA_OBJECT_ID` and omit the password instead.

## Jenkins and Harbor

Use [`Jenkinsfile.podman`](../Jenkinsfile.podman) as a Pipeline job. The agent
needs Podman, access to the repository and Harbor, and a Jenkins
username/password credential named `harbor-eris-robot` with push rights. Set
`HARBOR_HOST`, `HARBOR_PROJECT` and an immutable `RELEASE_TAG`. The pipeline
builds the API, worker and web image, validates Python syntax and the web build,
then pushes them. The web image uses `deploy/podman/build-web.sh` to build the
bundle in a regular Podman container and package it into nginx. This passed on
rootless Podman 4.9.3, where a Dockerfile `RUN` failed to resolve an installed
Lit package. The web image is built with API base `/api`, Entra enabled,
and a selectable password form. Browser `VITE_*` values are compile-time public
settings; changing them requires a new web image. The pipeline does **not**
place secrets into images or deploy to a server.

Mirror the approved `mariadb:11` and `chrislusf/seaweedfs:4.50` images into
Harbor using IT's supply-chain process. Set the five references in `images.env`
to the exact approved tags or digests, and `podman login` on the deployment
host with pull-only credentials. Ensure the runtime can pull every image before
the maintenance window. Source images and licenses should be reviewed by IT.

## First installation

Run as the dedicated Podman service account on the Linux host:

```bash
cd /opt/eris
for name in images db storage app bootstrap; do
  cp "deploy/podman/$name.env.example" "deploy/podman/$name.env"
done
chmod 600 deploy/podman/{db,storage,app,bootstrap}.env
# Edit the five .env files; replace every CHANGE_ME and example.gov value.
podman login harbor.example.gov
bash deploy/podman/eris-pod.sh up
bash deploy/podman/eris-pod.sh status
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
[`eris.service.example`](../deploy/podman/eris.service.example) as the
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

1. Open the browser URL and sign in as the initial administrator. The Entra
   button uses authorization code + PKCE, verifies tenant, issuer, audience,
   signature and nonce, then matches the prelinked `(tenant ID, object ID)`.
   ERIS roles stay in its database. If the initial admin has only a password,
   use the password form for this first sign-in.
2. Open **Administration → Users**. Create another admin with their work email,
   name and Entra **user object ID** (from the tenant's Users directory). Leave
   the password blank for SSO-only. Then grant Administrator. Account creation
   alone makes a Guest; it does not grant admin rights.
3. Have the new administrator sign in through Entra and confirm their admin
   page works. Create at least one more admin for recovery, then disable the
   initial account in **Administration → Users**. A disabled account fails both
   password and Entra sign-in immediately because every API call checks the
   database's active flag.
4. After handover, set `LOCAL_LOGIN_ENABLED=false` in `app.env`, delete
   `bootstrap.env`, and redeploy the API and web image with the Jenkins
   `LOCAL_LOGIN_ENABLED=false` build setting. The API enforces this even if an
   older web image still shows the form. Keep the bootstrap marker and initial
   user record; re-running bootstrap does not reactivate it.

Entra accounts are **prelinked by object ID**, never auto-linked by email.
Users who exist in Entra but have no active linked ERIS account get 403. If an
object ID was entered incorrectly, create a corrected account through the
admin process; do not edit IDs by hand without an audited recovery procedure.
No Microsoft Graph permission is needed for sign-in. The app registration
needs the ordinary OpenID Connect scopes `openid profile email` and a web
redirect URI. The current server flow uses a **client secret**; if IT requires
certificate-based client authentication, that exchange must be implemented
before production cutover. Rotate its secret before expiry and restart the API
container.

## Operations

| Task | Command / rule |
| --- | --- |
| Status | `bash deploy/podman/eris-pod.sh status`; `podman logs eris-api`, `eris-worker`, `eris-mariadb`, `eris-seaweedfs`, `eris-web`. |
| Stop/start | `podman pod stop eris` / `podman pod start eris`. |
| Release | Snapshot both data volumes and runtime env files; rehearse on staging. `podman pod rm -f eris` removes containers but **not** named volumes. Update image refs, then `eris-pod.sh up`. It applies forward migrations before API startup. |
| Rollback | Restore the matched MariaDB and SeaweedFS volume snapshots and previous images/env together. Do not point an older API at a database upgraded by a newer release unless that migration is explicitly backward compatible. |
| Backup | Consistent MariaDB backup plus SeaweedFS data and all secrets/config, encrypted and tested with a restore drill. The two volumes are a single recovery set; a DB-only backup leaves missing evidence. |
| Health | `/healthz` tests nginx; `/api/health` tests API. Confirm a sign-in, an admin operation and an upload/download through public TLS URLs in staging. |

For a consistent cold backup, stop the pod, export both named volumes, copy
the runtime env files into the same **encrypted, access-controlled** backup
set, and restart. For example, after setting an approved backup destination:

```bash
backup_dir=/secure/eris-backups/2026-10-25
umask 077
mkdir -p "$backup_dir"
podman pod stop eris
podman volume export eris-mariadb --output "$backup_dir/mariadb.tar"
podman volume export eris-seaweedfs --output "$backup_dir/seaweedfs.tar"
cp deploy/podman/{images,db,storage,app}.env "$backup_dir/"
podman pod start eris
```

Change the example date and destination. Verify archives and rehearse a restore
on staging. Restore into **empty** volumes using `podman volume import`; that
command merges into an existing volume, so importing over stale data is unsafe.
The approved backup product may replace these commands if it gives a
consistent, jointly restorable snapshot of both volumes.

Monitor free space (especially terrain packages), DB health, S3 bucket checks,
worker logs, certificate and Entra-secret expiration. SMTP and Expo push are
optional; enable only after Caltrans supplies approved relays/credentials.

## Mobile readiness

The existing mobile project can use the same HTTPS `/api` endpoint and signed
S3 URLs. The API's roles and active-user checks already apply to all clients.
When mobile authentication is implemented, register a **separate public/native
client** in Entra and use authorization code + PKCE through the system browser;
do not embed the web confidential client secret in the app. The current
`/auth/entra/*` flow is for the web confidential client. Mobile token exchange
and app redirect URI remain implementation work before mobile release. Confirm
phone reachability to both ERIS and S3 HTTPS URLs, and decide whether approved
Expo push service traffic is allowed. Offline terrain generation needs its
documented GIS egress; lack of those services does not block core sign-in.

## Protocol references

- [Podman pods and shared localhost/port publishing](https://docs.podman.io/en/latest/markdown/podman-create.1.html)
- [Podman volume export](https://docs.podman.io/en/stable/markdown/podman-volume-export.1.html) and [volume import](https://docs.podman.io/en/latest/markdown/podman-volume-import.1.html)
- [Microsoft identity platform authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [Microsoft Entra ID token validation](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens) and [user/tenant ID claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference)
- [Microsoft Entra authority for Azure Government](https://learn.microsoft.com/en-us/azure/azure-government/documentation-government-plan-identity)

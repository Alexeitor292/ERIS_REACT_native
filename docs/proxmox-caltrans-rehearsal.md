# Recreate ERIS on Proxmox as a Caltrans deployment rehearsal

The clean-install rehearsal was completed, then the existing Compose data was
migrated onto the Podman VM. See the [cutover record](proxmox-podman-cutover.md)
for the current public routes, backup locations, and rollback procedure.

## Recommended layout

Keep the current Docker Compose ERIS VM intact during the rehearsal. Create a
**separate Linux VM** on the same Proxmox host for a single Podman pod. Give it
its own disks/volumes, DNS names, TLS certificates, credentials, and Entra web
app registration. Use the exact ERIS release commit and image digests intended
for Caltrans. This exercises the [Caltrans Podman runbook](caltrans-podman.md)
without putting the existing service or its data at risk. A VM also avoids
nested-container storage and user-namespace differences that an LXC guest can
introduce; Podman rootless needs working subordinate UID/GID ranges and local
storage.

There are **two distinct rehearsals**:

1. **Clean installation** on the new VM, with no copied database or object
   storage. This is the Caltrans acceptance path. It proves fresh schema/role
   seeding, first admin, Entra, SeaweedFS, and the single pod.
2. **Existing-data upgrade** on a *separate snapshot or clone* if you need to
   preserve the current Proxmox ERIS data. Its old Alembic revision and whether
   it uses MinIO or SeaweedFS determine the migration steps. Do not infer that
   path from the clean-install result, and do not attach the live Docker
   volumes to Podman.

## Inventory the current Compose server (read only)

Run these on the current ERIS host from its repository checkout, recording the
output in the change ticket. They do not print `.env.proxmox` or passwords:

```bash
git rev-parse HEAD
cd docker
docker compose --env-file .env.proxmox \
  -f docker-compose.yml -f docker-compose.proxmox.yml ps
docker ps --format '{{.Names}} {{.Image}}'
docker volume ls --format '{{.Name}}'
docker compose --env-file .env.proxmox \
  -f docker-compose.yml -f docker-compose.proxmox.yml \
  exec -T backend alembic current
```

Record the VM's CPU, RAM, free disk, OS, Docker/Compose versions, exposed
ports, HTTPS gateway, and whether storage is **MinIO or SeaweedFS**. Check the
actual bucket names and volumes without displaying credentials in the ticket.
Avoid `docker compose config` in a shared log: it expands environment values,
including secrets. Take a verified Proxmox VM backup and application-level DB
and object-storage backups before any upgrade. Keep the current service
available until the new VM passes the acceptance gate below.

## Build the rehearsal VM

1. Use the closest practical match to the proposed Caltrans Linux OS and
   Podman version. Allocate dedicated local disk for Podman named volumes and
   separate off-host backup capacity. Start with the resource guidance in the
   [Caltrans runbook](caltrans-podman.md#decisions-to-obtain-from-caltrans-it).
2. Create a dedicated rootless service account and check `podman info`,
   subordinate UID/GID mappings, and user systemd. Install the repository at
   `/opt/eris` as that account. First review and commit the current deployment
   changes, then use that immutable release commit rather than a moving branch
   during a test cycle.
3. Publish the three ERIS images through
   [`Jenkinsfile.podman`](../Jenkinsfile.podman) to a **test Harbor project** if
   Caltrans makes one available. Mirror approved MariaDB and SeaweedFS images
   there too. If Harbor access is not yet available, use a private OCI test
   registry or local Podman image tags for runtime testing, then repeat the
   registry pull/authentication test against Caltrans Harbor before cutover.
4. Give staging URLs distinct from the existing ERIS URLs, for example
   `https://eris-stage.example.gov` and
   `https://eris-files-stage.example.gov`. Use its own Entra web app
   registration with the staging callback URI and secret. If no Entra test
   registration is available, use a temporary local-login staging build and
   leave Entra acceptance explicitly pending.
5. Fill the five env files in `deploy/podman/` with **staging-only** credentials
   and URLs, then follow [First installation](caltrans-podman.md#first-installation).
   The init SQL seeds roles and minimum organization data, not demo users.
   Create realistic synthetic users through the admin UI; never load
   `database/dev/030_mock_accounts.sql` into a production-mode rehearsal.

For the highest fidelity, use the same Jenkinsfile, container digests,
`eris-pod.sh`, env **keys** (with different secret values), web `/api` routing,
TLS topology, and outbound-network rules as Caltrans. Differences should be
written down and retested at Caltrans rather than silently accepted.

## Acceptance gate

Record pass/fail, release commit, image digests, config version, date, tester,
and evidence for each item:

Run `bash deploy/podman/verify-rehearsal.sh https://eris-stage.example.gov`
for the repeatable container, HTTPS and schema checks. It is read-only and
does not replace the identity, evidence or recovery tests below.

| Area | Pass condition |
| --- | --- |
| Fresh install | One Podman pod has the five running containers; Alembic is at head; `/healthz` and `/api/health` pass through HTTPS. No mock users or demo records exist. |
| Registry | A new VM can pull every approved digest with read-only Harbor credentials; Jenkins publishes the three ERIS images with its push-only credential. |
| Identity | Entra sign-in works for a prelinked user. Unknown and disabled users are rejected. A second admin can be added, can sign in, and can disable the bootstrap admin; restarting does not reactivate it. Then disable local password login. |
| Database | Create an incident and assessment, restart the pod and VM, and verify data persists. Run the next migration on a snapshot before applying it to the rehearsal VM. |
| Storage | Upload and download a photo and document through the public TLS URLs; generate/download a small offline terrain package if GIS egress is approved. Signed URLs remain private and work from a separate client machine. |
| Recovery | Export both volumes and runtime config, restore into empty volumes on a new test VM, and verify the same records and files. Rehearse a failed release and restore the matched DB/storage snapshot plus previous images. |
| Operations | systemd starts the pod after reboot; logs, free-space alarms, certificate/Entra-secret expiry, and scheduled backups are visible to the operator. |
| Mobile readiness | A phone on the intended network can reach the API and signed S3 URL. The native Entra flow remains a separate implementation gate for the mobile app. |

Do not call the Caltrans deployment proven until the same checks pass using
Caltrans' actual Harbor, TLS gateway, Entra tenant/app registration, DNS, and
network rules. The Proxmox rehearsal proves the application packaging and
operator procedure; it cannot prove Caltrans-owned infrastructure by itself.

## What to do with the old Compose VM

Keep it running while the new VM is built and tested. Once the rehearsal passes,
choose whether to retain it as a historical reference or retire it after
backups and retention are agreed. If the goal is to preserve its real ERIS
records, first inventory its database revision and storage backend. For a
MinIO source, follow the [object-storage migration](storage-migration.md) on
an isolated copy; the copy tool verifies objects and updates catalog version
identifiers. Then rehearse the database upgrade and import into new, empty
Podman volumes. The current fresh-install bootstrap intentionally refuses an
existing database with users and no bootstrap marker, so **do not run the
clean-install script against a restored old database**. That data-preserving
cutover needs a separately reviewed adoption procedure and a matched DB/S3
rollback set.

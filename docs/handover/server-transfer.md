# Transfer from personal hosting to Caltrans

Prepared **2026-11-13**. Owner: **Deh Jeng Jang**. Caltrans IT staging and
production hosts are pending. This procedure is a plan to execute with IT; it
does not claim that any running server was inspected or migrated today.

## Submit the staging request

Send the [IT deployment brief](../caltrans/it-deployment-brief.md),
[environment worksheet](environment-setup.md), [work register](open-work.md),
and [Podman runbook](../operations/caltrans-podman.md) to the assigned IT contact.
The requested initial deliverable is an agency-owned **staging** environment,
followed by an approved production deployment after acceptance.

Ask IT to assign a service owner and provide:

- A Linux staging host and dedicated rootless Podman service account; agree
  supported OS/runtime, capacity, patching and persistent disk ownership.
- Two staging DNS names and trusted TLS routes: web plus `/api`, and signed
  S3 files. Agree production names separately.
- Entra web/native registrations, app owners, certificate custody, Conditional
  Access, bootstrap user object ID, and two administrator identities.
- Harbor, Jenkins, image mirrors/scanners/signing custody, deployment keys,
  secret store, backup destination, monitoring and network rules.
- RPO/RTO, support escalation and change/cutover process. Record decisions in
  [acceptance](acceptance.md), including which native/notification features ship.

## Inventory the source before changing it

Historical routing: `eris.camposlabs.org` (web + `/api`),
`files.camposlabs.org` (S3), and `api.camposlabs.org` (legacy API alias),
through Cloudflare/Caddy to a Proxmox Podman VM. The
[October cutover record](../operations/history/proxmox-podman-cutover.md) and
[November demo record](../operations/history/guided-demo-20261109.md) are dated
evidence, not an authoritative report of today's VM state.

The authorized operator must capture, without copying secrets into Git:

1. Current host, service account, systemd unit/overrides and proxy/tunnel routes.
2. Checked-out source commit **and each running image digest/ID**. Earlier
   web-only deployments mean one `REVISION` file may not describe all images.
3. Actual volume names from `volumes.env`, systemd/environment overrides and
   `podman inspect`; historical cutover names are not defaults.
4. Alembic current/head, user/incident/assessment/submission/attachment counts,
   object bucket counts/bytes and representative attachment keys/checksums.
5. Environment files, certificate/key expiry, APNs/Apple/GIS/SMTP dependencies,
   registry/signature policy and all cron/systemd maintenance jobs.
6. Old Compose/MinIO snapshots and backups still held on personal machines;
   include them in the final data-retention/disposition decision.

Use read-only `eris-pod.sh status`, `cert-check`, `podman ps`,
`podman inspect` and `systemctl --user cat eris.service` privately. Inspection
can expose runtime environment values: do not paste full output into a ticket.
Record safe identifiers and secret-store references instead.

## Rehearse on agency staging

1. Install a **fresh** Caltrans staging environment first using the Podman
   runbook and synthetic records. Prove identity, workflow, signed files and
   backup/restore before importing existing data.
2. Agree which personal-hosted records must transfer. Real data in staging
   requires the data owner's authorization and agency access controls.
3. Schedule an outage for a cold, matched backup. Run as the existing service
   account with the **actual active volumes** selected:

   ```bash
   cd /opt/eris
   bash deploy/podman/eris-pod.sh backup /secure/eris-backups/handoff-rehearsal
   bash deploy/podman/eris-pod.sh verify-backup /secure/eris-backups/handoff-rehearsal
   ```

   Confirm `volumes.env` or environment selects the active volume names first.
   This backup restarts a previously running pod. Encrypt and transfer it using
   an approved channel; it contains DB, evidence and secrets. Capture any
   systemd/proxy/maintenance configuration separately in the secure inventory.
4. Restore into **new empty volumes** with the matching backed-up DB/storage/app
   configuration and compatible images, following the
   [restore procedure](../operations/caltrans-podman.md#backup-and-restore).
   Do not launch copied personal HTTPS/identity settings as agency production.
   Restore runs with the pod removed and checks config matches the backup.
5. Before starting the restored service, make a controlled environment change
   to agency hostnames, Entra registrations/certificate, keys and delivery
   settings. Preserve DB/S3 access until the corresponding services are
   explicitly rotated. Disable outbound mail/push during data reconciliation
   to avoid sending duplicate historical notifications.
6. An imported DB must already contain the initial-admin marker, or use
   `ERIS_ADOPT_ADMIN_EMAIL` for the exact active existing administrator on its
   first Podman start. Remove the value after success. Do not reseed mock users.
   Establish the receiving Entra-linked administrators before disabling the
   old login path. This adoption is different from fresh-install bootstrap.
7. Start with restored volume names, record them in `volumes.env` or the user
   systemd environment for subsequent restarts, and verify current migrations.
   Upgrading runs forward migrations; preserve the original recovery set.
8. Reconcile record/object counts and representative attachment contents;
   verify signed download URLs now use the agency file host. Test newly uploaded
   photos and offline packages, not just `/health`.
9. Run production-profile verification, identity tests, backup/restore and the
   [acceptance exercises](acceptance.md). Record elapsed outage/recovery and
   unresolved differences before scheduling the final cutover.

## Final cutover and rollback

- The owner approves the target, change window, data scope and rollback decision
  maker. Announce a write freeze; stop web/API/worker writers on the source
  during the **final** matched capture and leave the source read-only/stopped
  after it. The normal backup command restarts the pod, so enforce the freeze
  again immediately after export. Include clients with queued offline changes.
- Repeat the proven transfer/restore/reconfiguration steps with a new unique
  backup directory. Do not allow old and new workers to process the same queue.
- Reconcile counts/files, test identity and workflows, check signed URLs and
  client API configuration, then allow writes at the new host. Browser/native
  clients must use the new agency endpoint; iOS build settings require a release.
- Retain the immutable pre-cutover backup and source during an agreed rollback
  window. Before reopening the old service, freeze the new service and reconcile
  writes made there; switching DNS alone can lose records. Prefer restoring
  matching code/data/config over an untested schema downgrade.
- The agency owner signs acceptance. Then revoke personal access, rotate
  transferred credentials, remove personal domains/signing dependencies, and
  securely delete or retain old volumes/snapshots/backups according to the
  owner's documented data-retention decision. Do not erase the only recovery set.

## Secure companion to the source package

| Deliver separately | What the successor must receive |
| --- | --- |
| Matched recovery set | DB and object-volume exports, checksums, manifest, compatible image references and secure runtime config |
| Secret-store entries | DB/S3/JWT values, Entra private key/certificate, APNs key, registry/deploy/signing custody, SMTP credentials if used |
| Host/edge configuration | systemd unit/overrides, active volume selection, firewall, DNS/TLS/proxy/tunnel details, schedules and logs |
| Custody/access | Agency Git, Harbor/Jenkins, identity, Apple/Intune, GIS licensing, backup and domain administrators |
| Release evidence | Image SBOMs/scans/signatures, source commit, acceptance and restore/rollback records |

The public-source archive intentionally cannot substitute for these restricted
operational materials. Use the [package builder](../../scripts/handover/build_package.py)
after committing the accepted source, then transfer this secure companion through
Caltrans-approved storage.

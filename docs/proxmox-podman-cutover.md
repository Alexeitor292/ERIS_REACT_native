# ERIS Proxmox data cutover to Podman — 2026-10-25

## Current routing and service

The existing Cloudflare tunnel and public hostnames were retained. The tunnel
still reaches Caddy in Proxmox LXC 102 (`eris-proxy`, `192.168.20.20`). Caddy
now routes all three hosts to VM 118 (`eris-caltrans-stage`, `192.168.20.216`):

| Public host | Caddy upstream | Application path |
| --- | --- | --- |
| `eris.camposlabs.org` | `192.168.20.216:8080` | Web and same-origin `/api/*` |
| `api.camposlabs.org` | `192.168.20.216:8080` | Caddy prepends `/api` for legacy clients |
| `files.camposlabs.org` | `192.168.20.216:9800` | SeaweedFS S3; signed Host and URI are preserved |

VM 118 runs one rootless Podman pod as user `eris`, started by the enabled
user `eris.service`. The active named volumes are `eris-mariadb-cutover` and
`eris-seaweedfs-cutover`; the systemd unit names both. `app.env` uses the
three HTTPS hosts above, local password login is enabled, and Entra remains
disabled pending an app registration. The legacy JWT signing secret was
carried forward so existing tokens can remain valid. Database and S3 service
credentials are separate generated values stored in mode-600 env files.

The deployed code is commit `227525cc5f5bb7bc7e45ccf7e346639206b280aa` on
`codex/caltrans-podman-rehearsal`. The API and worker images carry the
`227525c` tag. The web image is the previously verified local `05703af` tag;
its source did not change between those commits. All images are local to the
VM; Harbor publication remains a separate Caltrans acceptance gate.

## Source retained for rollback

The old Docker Compose service is LXC 101 (`ERIS-server`, `192.168.20.75`).
Its MariaDB and MinIO containers, volumes, and checkout remain intact.
All six Compose containers were stopped after the public cutover, then LXC 101
was shut down. It is currently **stopped**. The stopped-LXC Proxmox snapshot
`eris-compose-frozen-20261025` records the old service for rollback. Do not
run both application workers against the same public service during a rollback.

The final quiesced source backup is in
`/root/eris-migration-final-20261025/` inside LXC 101. A second copy is in
`/var/lib/vz/dump/eris-migration-final-20261025/` on the Proxmox host, with
mode-600 SQL, MinIO volume archive, and Compose env file. The copied SQL and
archive SHA-256 hashes matched the source:

```text
eris.sql          db8282bd7e4159458e229be52aec793c6dcef9235834316b73fbc05b1755a119
minio-volume.tgz  7a26e54356a4c84f0d6410e374fedea0770ee185bff62df0089cc79b723143be
```

These are two copies on **one physical Proxmox host**. Move an encrypted copy
to an approved off-host backup target and rehearse a restore before retiring
LXC 101 or its volumes. The earlier clean Podman VM snapshot
`podman-baseline-20261025` is a rehearsal rollback point, not a backup of the
migrated data.
Proxmox warned that thin volumes are overprovisioned. Actual local-lvm use
was 53.42% after the frozen Compose snapshot; monitor it as snapshots and
terrain data grow.
The Proxmox backup directory also contains `Caddyfile.before` and
`Caddyfile.after` with verified checksums. The temporary origin-only preview
routes were removed from the active Caddyfile after cutover.

## Migration and verification record

1. Stopped old API, worker, and Adminer to freeze writes. Took a MariaDB
   `--single-transaction` dump and a MinIO volume archive; retained the old
   containers and volumes.
2. Imported that dump into a fresh Podman MariaDB volume. Applied Alembic from
   `20261007_maintenance_workflows` to `20261025_bootstrap_marker`. Explicitly
   adopted the existing active administrator `admin@dot.ca.gov` as bootstrap
   user ID 1. No new user was seeded. The one-time adoption env value was
   removed after success; both adoption and bootstrap are idempotent.
3. Started a fresh SeaweedFS volume and ran the object migration tool with
   SHA-256 and size verification. It copied 51 current objects in
   `eris-uploads`; the preflight inventory totaled 74,658,298 bytes.
   `eris-offline-scenes` had zero.
   The source MinIO volume is retained because historical noncurrent versions
   and delete markers are outside the copy tool's scope.
4. Compared application counts after import: 94 users, 8 roles, 94 user-role
   assignments, 15 incidents, 44 attachments, 7 GISA submissions, and zero
   offline scene packages. The bootstrap marker points at the existing admin.
   All 44 legacy attachment rows use `minio` as the stored provider label;
   the new API resolves their bucket/key in SeaweedFS. Every recorded object
   size matched, and a signed attachment download passed.
5. Tested Caddy with origin-only preview hostnames before changing public
   routes. Web/API returned 200, unsigned S3 returned 403, and a signed
   migrated attachment downloaded over HTTPS.
6. After Caddy cutover, public Cloudflare requests returned 200 for the web,
   same-origin API, and legacy `api.camposlabs.org` API. Unsigned S3 returned
   403. An authenticated admin request through both API routes returned the
   migrated user, a signed legacy attachment downloaded through
   `files.camposlabs.org`, and a signed public PUT was read back from
   SeaweedFS and removed.

Check the running deployment as `eris` on VM 118:

```bash
systemctl --user status eris.service
bash /opt/eris/deploy/podman/eris-pod.sh status
bash /opt/eris/deploy/podman/verify-rehearsal.sh http://192.168.20.216:8080
podman inspect --format '{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}' eris-mariadb eris-seaweedfs
```

The VM still has the earlier clean and preflight migration volumes. They are
**not** the active volumes; do not delete them until the backup and restore
plan is agreed. Temporary copies of source credentials and SQL were removed
from VM 118 after verification.

## Rollback

First determine whether users have created or edited records since cutover.
The old database is frozen at the final dump; sending traffic back to it
without reconciling newer Podman writes would lose those changes. Preserve a
matched backup of the active Podman database and SeaweedFS volume before any
rollback.

If rollback is approved and data reconciliation is handled, stop the Podman
service to prevent further writes, start the old API and worker, restore the
original Caddyfile, validate it, and reload Caddy. On the respective hosts:

```bash
# VM 118, as eris
systemctl --user stop eris.service

# Proxmox host, as root
pct start 101
pct exec 101 -- docker start eris_mariadb eris_minio eris_web
# Wait for MariaDB to become healthy before starting the old API and worker.
pct exec 101 -- docker start eris_backend eris_offline_scene_worker eris_adminer
pct exec 102 -- cp /etc/caddy/Caddyfile.pre-eris-podman-20261025 /etc/caddy/Caddyfile
pct exec 102 -- caddy validate --config /etc/caddy/Caddyfile
pct exec 102 -- systemctl reload caddy
```

The original Caddyfile backup above predates the preview and cutover routes.
`/etc/caddy/Caddyfile.pre-podman-cutover-active` is another copy containing
the origin-only preview routes. Verify all three public hosts after rollback.

## Remaining operations

- Create scheduled, encrypted off-host backups and test restoring the migrated
  MariaDB and SeaweedFS data together. Add free-space and service alerts.
- Publish approved image digests to Harbor through Jenkins and replace local
  image tags with pinned approved references.
- Configure Caltrans Entra registration and test linked, unknown, and disabled
  users before disabling local password login. The mobile Entra flow is later
  application work.
- Create a second administrator, verify login, then disable the inherited
  `admin@dot.ca.gov` account if it is the default account to retire.

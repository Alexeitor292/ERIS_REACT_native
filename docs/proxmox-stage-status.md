# Proxmox Caltrans staging status — 2026-10-25

This is the current **clean-install Podman rehearsal**, not a Caltrans
production deployment or a migration of the old ERIS data.

## Running environment

| Item | Value |
| --- | --- |
| Proxmox host | `192.168.20.215` |
| Existing ERIS | LXC 101 at `192.168.20.75`; Docker Compose, MariaDB and MinIO; left running and unchanged |
| New staging host | VM 118, `eris-caltrans-stage`, Ubuntu 24.04, `192.168.20.216`, 4 vCPU, 8 GiB RAM, 80 GB disk |
| Podman | Rootless 4.9.3 under Linux user `eris`; user lingering and `eris.service` enabled |
| Release | `20aa106e188d454dfa877b2fd08de4af70aee481` on branch `codex/caltrans-podman-rehearsal` |
| Checkout | `/opt/eris`; Git archive of the release, with `/opt/eris/REVISION` |
| Web/API | [http://192.168.20.216:8080](http://192.168.20.216:8080) on the private LAN |
| S3 | `http://192.168.20.216:9800` on the private LAN; buckets `eris-uploads` and `eris-offline-scenes` |
| Data | Rootless Podman volumes `eris-mariadb` and `eris-seaweedfs` on the new VM only |

The VM uses generated staging-only secrets. `db.env`, `storage.env`,
`app.env`, and `images.env` are mode 600 under `/opt/eris/deploy/podman/`.
The one-time initial admin credential was moved out of the deployment directory
after seeding to `/home/eris/staging-bootstrap.env` (mode 600). It is not in
Git or this document. The staging admin email is
`bootstrap.stage@localhost.invalid`. After creating and verifying a second
admin, disable this account through the ERIS admin interface and securely
remove the saved bootstrap credential. The database bootstrap marker prevents
the seed command from restoring a disabled bootstrap account.

## Checks completed

- Fresh install initialized the schema and eight roles, upgraded Alembic to
  `20261025_bootstrap_marker`, and seeded exactly one administrator. No incident
  or demo account data was loaded.
- One pod contains five running application containers: MariaDB, SeaweedFS,
  API, worker, and web. The API and web health checks pass from the VM and from
  the Windows workstation on the private LAN.
- The initial admin signed in successfully through `/api/auth/login`, and
  `/api/auth/me` returned the `ADMIN` role.
- SeaweedFS bucket bootstrap verified the private uploads bucket and the
  private, versioned offline scenes bucket with Object Lock support. An
  unsigned test-object request returned 403; a signed download through the
  host S3 address returned the uploaded bytes.
- An explicit Podman stop/start and a full VM reboot both recovered. After
  reboot, the user systemd unit was active, five containers and health checks
  passed, and the initial admin marker plus the test S3 object persisted.
- The Windows workstation fetched the web page (HTTP 200), and an unsigned S3
  object request returned 403.

Run the repeatable checks as `eris`:

```bash
bash /opt/eris/deploy/podman/verify-rehearsal.sh http://192.168.20.216:8080
systemctl --user status eris.service
bash /opt/eris/deploy/podman/eris-pod.sh status
```

## Build finding

The API and worker images built with rootless Podman. With Podman 4.9.3 on
this VM, the web Dockerfile's `RUN npm run build` failed when Vite/Rollup
could not resolve the installed `@lit/reactive-element` package. The package
was present in the intermediate image. Running the same bundle build as a
normal `podman run` container with `NODE_OPTIONS=--max-old-space-size=4096`
passed; its output was then packaged into the nginx runtime image. The web
Dockerfile now uses Node 22, which is compatible with the lockfile's
`nanoid` engine requirement. The three local runtime image tags are
`localhost/eris/{api,worker,web}:20aa106`; the image contents correspond to
the release's application source (later release commits changed only
deployment scripts and line-ending rules).

This workaround confirms runtime packaging, but **Jenkins' web-image build is
still an open gate**. Reproduce it with Caltrans' approved Podman/Buildah
version and fix or codify the build path before relying on the Jenkinsfile.

## Gates still open

| Gate | Needed for Caltrans acceptance |
| --- | --- |
| Harbor/Jenkins | Create the approved Harbor project and robot accounts; build, push, scan, and pull every image by approved digest. Current staging images use local tags and public MariaDB/SeaweedFS tags. |
| TLS/DNS | Give staging separate browser and S3 HTTPS names and a trusted reverse proxy; repeat signed upload/download through both public URLs. Current LAN HTTP is for packaging tests only. |
| Entra | Obtain a test app registration, tenant and authority, callback URI, first admin object ID, and secret policy. Current staging uses local password login and `ENTRA_ENABLED=false`. Test prelinked, unknown, and disabled users, then disable local login. |
| Application workflow | Create a second admin, disable the bootstrap admin, and test an incident, assessment, photo/document, and their persistence after restart. |
| Recovery | Export and restore matched MariaDB and SeaweedFS volumes plus runtime config on another empty VM; test rollback of a failed release. |
| Mobile/network | Confirm a phone on the intended network reaches the API and signed S3 URL. The native mobile Entra flow remains future application work. |

Use [the Proxmox rehearsal plan](proxmox-caltrans-rehearsal.md) and
[Caltrans Podman runbook](caltrans-podman.md) for the full acceptance procedure.

# Podman deployment scripts

Use the [Caltrans runbook](../../docs/operations/caltrans-podman.md) for the full
installation and operations procedure. Supported target: an agency-managed
Linux host, rootless service account with subordinate UID/GID ranges, Podman
5.x, Bash, Python 3, curl and the standard coreutils. Native secrets require
`podman secret create --replace`; test that capability on the chosen host.

API and worker run as UID/GID **10001:10001**, with all capabilities dropped
and `no-new-privileges`. `db.env`, `storage.env`, `app.env` and bootstrap inputs
must be 600/400 before the script reads them. Keep `secrets/` mode 700 and each
regular file mode 600. Symlinks/subdirectories are refused.

`up` imports those files into Podman's protected secret store and maps them
**only into the API** at `/run/secrets/eris/<filename>`, owned by 10001:10001,
mode 0400. Do not relax host file permissions or mount the directory for a
nonroot API: rootless container UID10001 cannot read a service-account-owned
mode-600 bind mount. `--replace` refreshes the mapping for recreated containers;
rotate the source file, then remove/recreate the pod in a change window. The
running container retains its previous secret until recreation. Podman's
secret store is another protected copy and must be included in host access/
decommission controls. Backups carry the original source files so a recovered
host can recreate its native secrets.

The certificate checker executes inside the running API with that same UID
and mapping. DB/storage/bootstrap one-shot tools run as 10001 with no key
mounts; they do not load Entra/APNs private files.

Production `release` requires two HTTPS origins and runs public verification.
Only an explicit `ERIS_VERIFY_PROFILE=rehearsal` allows isolated packaging
without those endpoints. Unknown profiles fail. Production verification checks
effective `ENV=prod`, process UID/capabilities/NoNewPrivs, complete image
digests, the signature policy/key file, allowed published ports, Entra and
administrator handover. These checks cannot replace actual agency identity,
gateway, licensing and device acceptance.

## Tests

- `tests/test-eris-pod.sh`: stub-based lifecycle, fail-closed releases, private
  secret mapping/rotation and recovery failures.
- `tests/test-verify-rehearsal.sh`: stub-based production refusal cases.
- `tests/test-native-secrets.sh`: **real rootless Podman**, synthetic file only;
  validates UID ownership, mode, isolation and rotation. An approved mirror can
  be supplied as `ERIS_SECRET_TEST_IMAGE`.
- `tests/test-rootless-rehearsal.sh`: **real five-image rootless installation**,
  signed object round-trip and matched cold backup/restore into fresh volumes.
  Requires five preloaded images in `ERIS_TEST_API_IMAGE`,
  `ERIS_TEST_WORKER_IMAGE`, `ERIS_TEST_WEB_IMAGE`, `ERIS_TEST_DB_IMAGE` and
  `ERIS_TEST_STORAGE_IMAGE`. It copies only scripts and public init SQL into a
  temporary repo; it never reads actual runtime env/secrets/data. It refuses an
  account already holding an `eris` pod/container, uses unique disposable
  volumes, and cleans up its own resources. Run this on an isolated CI/test
  account, not a production service account.

The real rehearsal uses synthetic password sign-in to validate packaging and
recovery. It does not pretend to validate Caltrans Entra, certificates,
Conditional Access, Harbor signatures or enrolled iPhones.

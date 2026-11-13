# Candidate patched vendor mirrors

The November 13 security scan found vulnerable Go tooling in the official
MariaDB image and dependencies in SeaweedFS 4.50. These recipes are remediation
candidates for the agency's image mirror process. They do not change a running
database or object store, and are not automatically selected by Compose or
Podman.

From the repository root, on an approved Linux builder:

```bash
podman build -f deploy/images/Dockerfile.mariadb -t <harbor>/eris/mariadb:<release> .
podman build -f deploy/images/Dockerfile.seaweedfs -t <harbor>/eris/seaweedfs:<release> .
```

MariaDB retains the official server/entrypoint, applies available OS updates and
rebuilds gosu 1.20 with Go 1.27.4. SeaweedFS starts from pinned 4.53 source,
updates `x/net` to 0.62.0 and `x/crypto` to 0.59.0, rebuilds with Go 1.27.4 and
applies OS updates. Source download and builder/base images are checksum-pinned.
Neither recipe promises zero findings:
every resulting image must pass the current scanner and functional acceptance.

Before using either:

1. Build, record source/base/image digests and SBOM, scan **all** severities and
   review findings. Preserve notices/licenses for upstream components.
2. On disposable data, test fresh initialization, restart, migration, S3 private
   buckets/object-lock policy, signed attachments, package generation and matched
   backup/restore. Prove recovery from an existing compatible backup.
3. Have IT/security approve the images or explicit expiring exceptions. Publish
   only under new agency tags; never overwrite an upstream vendor tag.
4. Supply the approved mirror refs as `MARIADB_SOURCE` and `SEAWEEDFS_SOURCE`
   in Jenkins. Its normal release gate scans, signs and records all five digests.
5. Deploy staging first. Do not point production at local test tags or downgrade
   the storage/database after it has written incompatible data.

Updating the source recipe later does not replace a pinned runtime image;
rebuild, rescan and issue a new signed release. The
[security review](../../docs/security/review-2026-11-13.md) lists remaining gates.

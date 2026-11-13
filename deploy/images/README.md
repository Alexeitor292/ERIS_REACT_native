# Candidate patched vendor mirrors

The November 13 security scan found vulnerable Go tooling in the official
MariaDB image and dependencies in SeaweedFS 4.50. These recipes are remediation
candidates for the agency's image mirror process. They do not change a running
database or object store. Local Compose builds them by default. Jenkins builds
them when mirror overrides are blank; hosted Podman consumes the approved image
references in `images.env`, never automatically replaces a running release.

From the repository root, on an approved Linux builder:

```bash
podman build -f deploy/images/Dockerfile.mariadb -t <harbor>/eris/mariadb:<release> .
podman build -f deploy/images/Dockerfile.seaweedfs -t <harbor>/eris/seaweedfs:<release> .
```

MariaDB uses Alpine 3.24's **11.8.9** server/client packages, preserving the
official MariaDB initialization and health-check scripts. It applies available
OS fixes and rebuilds gosu 1.20 with Go 1.27.4 and `x/sys` 0.44.0. This is a
distro/build change, not a claim that the old official image's server binaries
are unchanged. Validate initialization, configuration and recovery before
replacing existing data. SeaweedFS starts from pinned 4.53 source,
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
4. Leave `MARIADB_SOURCE` and `SEAWEEDFS_SOURCE` blank in Jenkins to build the
   recipes, or supply approved mirror references. Its release gate scans all
   five images before any push, then signs and records all five digests.
5. Deploy staging first. Do not point production at local test tags or downgrade
   the storage/database after it has written incompatible data.

Updating the source recipe later does not replace a pinned runtime image;
rebuild, rescan and issue a new signed release. The
[security review](../../docs/security/review-2026-11-13.md) lists remaining gates.

## Signing tool candidate

`Dockerfile.cosign` is a release-builder tool, separate from the five runtime
containers. It builds verified upstream Cosign 3.1.4 source with Go 1.27.4 and
explicit patched dependency versions. A small reviewed patch removes the unused
ambient Azure ACR credential helper whose advisory has no fixed upstream
version; explicit Harbor file credentials remain supported. This is an ERIS
candidate build (`v3.1.4-eris.1`), not the unmodified vendor image. Preserve the
patch, upstream license, source checksum and full build/module/SBOM metadata.

Jenkins builds it when `COSIGN_IMAGE` is blank, or pulls the selected approved
mirror. The publisher scans it before passing any signing key, then gates all
five runtime images. CI repeats this with an ephemeral authenticated TLS
registry, signed CycloneDX attestation, and actual Podman signature rejection
controls. A build recipe alone is not evidence that the resulting tool passed.
Review the source patch and dependency pins whenever updating the tool; remove
the local patch when upstream supplies a supported fix or helper removal.

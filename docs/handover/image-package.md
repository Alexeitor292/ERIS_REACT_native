# Image package and release evidence

The GitHub Actions **Deployment images** workflow builds all five runtime
images from one source commit on Linux/amd64. Its `ERIS-image-handoff` artifact
is created only after all five all-severity vulnerability/secret scans, release
regressions, real rootless secret tests, and five-image installation/recovery
rehearsal pass. It additionally requires the full database integration suite
against the exact MariaDB image and an isolated real TLS-registry signing and
signature-policy test. A failed candidate scan still retains its individual reports
for investigation; it does not produce an accepted combined package.

## Contents and verification

Download `ERIS-image-handoff` from the successful workflow for the source commit
being transferred. GitHub artifacts expire: this package requests 90-day
retention. Copy the accepted artifact into agency-controlled storage before
expiry; do not rely on the outgoing maintainer's GitHub account.

The package contains:

- `START-HERE.txt`, `manifest.json` and `SHA256SUMS`.
- `ERIS-source-<commit>.zip`: committed source and documentation.
- `images/<name>/<name>.tar.gz` for API, worker, web, MariaDB and SeaweedFS.
- Each image's `image-id.txt`, `source-commit.txt`, `sbom.cdx.json` and
  `scan.json`; full package metadata remains available for later rescanning.
- `rootless-rehearsal.log`: fresh installation, same-origin web/API health,
  API-only private secret, signed object round-trip, anonymous bucket refusal,
  and matched cold backup restored into fresh volumes with the administrator
  and object intact. This uses disposable credentials and synthetic data.
- `signature-rehearsal.log`: private TLS-registry signature/attestation and
  wrong-key/unsigned-image rejection, using ephemeral test keys.
- `candidate-db.log` and `candidate-db.xml`: full DB integration results bound
  to this source commit and exact MariaDB image identity.

After extracting the artifact on Linux:

```bash
sha256sum -c SHA256SUMS
for name in api worker web mariadb seaweedfs; do
  gzip -dc "images/$name/$name.tar.gz" | podman load
done
```

The builder rejects mixed source commits, findings at any severity, missing
SBOMs, and mismatched image/archive identities. Local image IDs identify the
candidate contents; they are not substitutes for registry manifest digests or
Caltrans cosign signatures. Archive the artifact's GitHub run/commit and hashes
in the [acceptance record](acceptance.md).

The signing rehearsal exercises the real release wrapper and Podman policy,
not a fake signer. It does not sign these candidate archives with an agency
key or prove the agency's Harbor/identity configuration. Final release signing
and acceptance still happen on agency infrastructure.

## Repeat the isolated installation

On an **isolated** rootless Podman 5.x test account, extract the source ZIP,
enter its `ERIS/` directory and run:

```bash
export ERIS_TEST_API_IMAGE=localhost/eris/api:candidate
export ERIS_TEST_WORKER_IMAGE=localhost/eris/worker:candidate
export ERIS_TEST_WEB_IMAGE=localhost/eris/web:candidate
export ERIS_TEST_DB_IMAGE=localhost/eris/mariadb:candidate
export ERIS_TEST_STORAGE_IMAGE=localhost/eris/seaweedfs:candidate
bash deploy/podman/tests/test-native-secrets.sh
bash deploy/podman/tests/test-rootless-rehearsal.sh
```

The rehearsal refuses an existing `eris` pod/container, creates private
temporary configuration and unique disposable volumes, and cleans up its own
resources. It does not read the checkout's actual runtime env files or secrets.
Allow local ports 8080/9800 to be free. It does not accept agency Entra, HTTPS,
Conditional Access, Harbor signature policy, or enrolled devices.

## Turn candidates into an agency release

The generic CI web build uses same-pod API routing and no agency map key. It is
suitable for packaging/recovery tests. Before deployment, IT must supply the
origin-restricted public browser key and any selected `VITE_*` settings, build
the configured web image, and validate its maps and attribution. Browser
settings are embedded during build. API/worker settings and private keys are
runtime inputs; the image package contains none of them.

Use the [Jenkins/Harbor procedure](../operations/caltrans-podman.md#jenkins-and-harbor)
to build the final configuration, scan **all five** images again, publish,
sign/attest and verify the five stored digests. IT can instead tag reviewed
loaded candidates into its local Harbor destination names and call
`deploy/ci/publish-release.sh REGISTRY/PROJECT RELEASE_TAG NEW_OUTPUT_DIRECTORY`
with the documented registry/cosign credentials; that helper performs the same
five-image gate before any push. A modified/rebuilt web image needs its own
fresh report and digest. Do not weaken digest/signature policy to use local
candidate tags on a production host.

Copy the resulting `release-images.env`, signature policy and public key to
agency staging. Complete the [environment worksheet](environment-setup.md),
then perform production-profile verification, real identity/device/workflow
testing, and a recovery/failed-release rollback exercise on that infrastructure.
Promote the accepted digests to production. A clean scan is time-bounded known
vulnerability evidence, not a guarantee of zero risk or a go-live approval.

The separate [source-package builder](../../scripts/handover/build_package.py)
can include a checksummed Git-history bundle. Transfer the live server's
matched data/config/secret recovery set through the secure channel described
in [server transfer](server-transfer.md); CI fixtures contain no live records.

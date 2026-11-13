#!/usr/bin/env bash
# Publish one five-image release only after every image passes the same gate.
# Registry login and cosign credentials are supplied by the caller, never files
# inside images. All input images already have the destination release tags.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
repo="${1:?Usage: publish-release.sh REGISTRY/PROJECT TAG OUTDIR}"
tag="${2:?release tag}" out="${3:?output directory}"
[[ "$repo" =~ ^[a-zA-Z0-9][a-zA-Z0-9./:_-]+$ && "$repo" != *@* ]] || { echo 'Invalid image repository' >&2; exit 2; }
[[ "$tag" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$ ]] || { echo 'Invalid image tag' >&2; exit 2; }
[[ ! -e "$out" ]] || { echo "Release output already exists; choose a fresh directory" >&2; exit 2; }
mkdir -p "$out/sbom"
gate="$ROOT/deploy/ci/release-gate.sh"
names=(api worker web mariadb seaweedfs)
# No push or signing is permitted until ALL five scans have succeeded.
for name in "${names[@]}"; do
  bash "$gate" scan "$repo/$name:$tag" "$name" "$out/sbom"
done
for name in "${names[@]}"; do
  podman push --authfile "${REGISTRY_AUTH_FILE:?registry auth file required}" \
    --digestfile "$out/$name.digest" "$repo/$name:$tag"
  digest="$(cat "$out/$name.digest")"
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "Invalid registry digest for $name" >&2; exit 1; }
  printf '%s@%s\n' "$repo/$name" "$digest" > "$out/$name.ref"
done
bash "$gate" public-key "$out/cosign.pub"
for name in "${names[@]}"; do
  ref="$(cat "$out/$name.ref")"
  bash "$gate" sign "$ref" "$out/sbom/$name.cdx.json"
  bash "$gate" verify "$ref" "$out/cosign.pub"
done
# Write the deployment manifest last; an incomplete publication is not deployable.
{
  printf '# ERIS %s; source %s; five scanned, signed and SBOM-attested images\n' "$tag" "${ERIS_SOURCE_REVISION:-unknown}"
  for pair in API:api WORKER:worker WEB:web DB:mariadb STORAGE:seaweedfs; do
    printf 'ERIS_%s_IMAGE=%s\n' "${pair%%:*}" "$(cat "$out/${pair#*:}.ref")"
  done
  echo 'ERIS_REQUIRE_DIGESTS=true'
} > "$out/release-images.env.tmp"
mv "$out/release-images.env.tmp" "$out/release-images.env"

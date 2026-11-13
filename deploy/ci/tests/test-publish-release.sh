#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/repo/deploy/ci" "$work/bin"
cp "$here/../publish-release.sh" "$work/repo/deploy/ci/"
cat > "$work/repo/deploy/ci/release-gate.sh" <<'GATE'
#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$CALLS"
if [[ "$1" == scan ]]; then
  [[ "$3" != "${FAIL_SCAN:-}" ]] || exit 1
  mkdir -p "$4"; echo '{}' > "$4/$3.cdx.json"
fi
[[ "$1" != verify || -z "${FAIL_VERIFY:-}" ]] || exit 1
[[ "$1" != public-key ]] || echo 'public key' > "$2"
GATE
cat > "$work/bin/podman" <<'PODMAN'
#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$CALLS"
[[ "$1" == push ]] || exit 2
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --digestfile ]]; then
    printf '%s\n' "${PUSH_DIGEST:-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}" > "$2"; break
  fi
  shift
done
PODMAN
chmod +x "$work/bin/podman"
export PATH="$work/bin:$PATH" CALLS="$work/calls" REGISTRY_AUTH_FILE="$work/auth.json"
script="$work/repo/deploy/ci/publish-release.sh"
for failed in api worker web mariadb seaweedfs; do
  : > "$CALLS"
  if FAIL_SCAN="$failed" bash "$script" harbor.test:5443/eris v1 "$work/fail-$failed" >/dev/null 2>&1; then exit 1; fi
  ! grep -q '^push ' "$CALLS"
  [[ ! -e "$work/fail-$failed/release-images.env" ]]
done
echo 'ok - failure of any of five scans prevents every push and deployment manifest'
: > "$CALLS"
bash "$script" harbor.test:5443/eris v1 "$work/success" >/dev/null
[[ "$(grep -c '^scan ' "$CALLS")" == 5 && "$(grep -c '^push ' "$CALLS")" == 5 ]]
[[ "$(sed -n '5p' "$CALLS")" == scan* && "$(sed -n '6p' "$CALLS")" == push* ]]
[[ "$(grep -c '^verify ' "$CALLS")" == 5 ]]
grep -q '^ERIS_DB_IMAGE=harbor.test:5443/eris/mariadb@sha256:' "$work/success/release-images.env"
echo 'ok - all five digests are published and verified, preserving registry ports'
if PUSH_DIGEST=sha256:short bash "$script" harbor.test/eris v1 "$work/bad-digest" >/dev/null 2>&1; then exit 1; fi
[[ ! -e "$work/bad-digest/release-images.env" ]]
echo 'ok - malformed registry digest cannot produce a deployment manifest'
if FAIL_VERIFY=1 bash "$script" harbor.test/eris v1 "$work/bad-signature" >/dev/null 2>&1; then exit 1; fi
[[ ! -e "$work/bad-signature/release-images.env" ]]
echo 'ok - failed signature verification cannot produce a deployment manifest'

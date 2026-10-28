#!/usr/bin/env bash
# Exercises release-gate.sh against a stub `podman` that plays Trivy and cosign:
# the SBOM and report land where Jenkins archives them, a vulnerable image
# fails the gate, signing refuses tags and never uses the public transparency log.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/release-gate.sh"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/bin" "$work/keys" "$work/out"
passed=0

cat > "$work/bin/podman" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$STUB_LOG"
if [[ "$1" == save ]]; then echo image-bytes > "$3"; exit 0; fi
[[ "$1" == run ]] || { echo "unexpected podman $*" >&2; exit 99; }
shift
declare -A mounts=()
env_seen=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --rm) shift ;;
    -e) env_seen+=" $2"; shift 2 ;;
    -v) spec="${2%%:ro,Z}"; spec="${spec%%:Z}"; mounts["${spec#*:}"]="${spec%%:*}"; shift 2 ;;
    *) break ;;
  esac
done
image="$1"; shift
host() { local path="$1"; for target in "${!mounts[@]}"; do
  if [[ "$path" == "$target"/* ]]; then echo "${mounts[$target]}/${path#"$target"/}"; return; fi; done; echo "$path"; }
case "$image" in
  *trivy*)
    out=""; args="$*"
    while [[ $# -gt 0 ]]; do [[ "$1" == --output ]] && out="$2"; shift; done
    if [[ "$args" == *"--format cyclonedx"* ]]; then echo '{"bomFormat":"CycloneDX"}' > "$(host "$out")"; exit 0; fi
    if [[ "$args" == *"--exit-code 1"* ]]; then
      [[ "$args" == *"--ignore-unfixed"* && "$args" == *"--scanners vuln,secret"* ]] || exit 98
      echo '{"Results":[]}' > "$(host "$out")"
      exit "${STUB_VULNERABLE:-0}"
    fi
    exit 0 ;;
  *cosign*)
    if [[ "$1" == public-key ]]; then echo "-----BEGIN PUBLIC KEY-----"; fi
    exit 0 ;;
esac
STUB
chmod +x "$work/bin/podman"
export PATH="$work/bin:$PATH" STUB_LOG="$work/calls"

ok() { echo "ok - $*"; passed=$((passed + 1)); }
check() {
  local description="$1"; shift 2
  if "$@"; then ok "$description"; else echo "not ok - $description"; cat "$work/out.log" 2>/dev/null; exit 1; fi
}
run() { bash "$SCRIPT" "$@" > "$work/out.log" 2>&1; }

check "a clean image passes the gate" -- run scan localhost/eris/api:1 api "$work/out"
check "its CycloneDX SBOM is kept for the release" -- grep -q CycloneDX "$work/out/api.cdx.json"
check "its scan report is kept" -- test -f "$work/out/api.vulns.json"
check "the scan reads a saved archive, not a registry" -- grep -q "image --input /work/image.tar" "$STUB_LOG"
check "accepted exceptions come from .trivyignore" -- grep -q "ignorefile /policy/.trivyignore" "$STUB_LOG"
STUB_VULNERABLE=1 check "a fixable HIGH/CRITICAL vulnerability or secret fails the gate" -- bash -c '! "$0" scan localhost/eris/web:1 web "$1" > /dev/null 2>&1' "$SCRIPT" "$work/out"
check "the failing report is still kept for review" -- test -f "$work/out/web.vulns.json"
TRIVY_DB_REPOSITORY=harbor.test/mirror/trivy-db check "the vulnerability database can come from Harbor" -- \
  run scan localhost/eris/worker:1 worker "$work/out"
check "the database mirror is passed to Trivy" -- grep -q "TRIVY_DB_REPOSITORY=harbor.test/mirror/trivy-db" "$STUB_LOG"
check "names cannot escape the output directory" -- bash -c '! "$0" scan img ../evil "$1" > /dev/null 2>&1' "$SCRIPT" "$work/out"

echo "key" > "$work/keys/cosign.key"
export COSIGN_KEY_FILE="$work/keys/cosign.key" COSIGN_PASSWORD="not-logged"
check "signing a tag is refused" -- bash -c '! "$0" sign harbor.test/eris/api:1 "$1" > /dev/null 2>&1' "$SCRIPT" "$work/out/api.cdx.json"
: > "$STUB_LOG"
check "a digest is signed and its SBOM attested" -- run sign harbor.test/eris/api@sha256:abc "$work/out/api.cdx.json"
check "the signature uses the Caltrans key" -- grep -q "sign --yes --key /keys/cosign.key --tlog-upload=false harbor.test/eris/api@sha256:abc" "$STUB_LOG"
check "the SBOM is attached as a CycloneDX attestation" -- grep -q "attest --yes --key /keys/cosign.key --tlog-upload=false --type cyclonedx --predicate /sbom/api.cdx.json" "$STUB_LOG"
check "the key password is passed by name, never by value" -- bash -c '! grep -q "not-logged" "$0"' "$STUB_LOG"
check "the public key can be exported for hosts" -- run public-key "$work/keys/cosign.pub"
check "signatures can be verified with the public key" -- run verify harbor.test/eris/api@sha256:abc "$work/keys/cosign.pub"

echo "All $passed release-gate.sh checks passed."

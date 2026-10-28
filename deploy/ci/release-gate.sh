#!/usr/bin/env bash
# Supply-chain gate for ERIS images, run by Jenkinsfile.podman on a Linux
# Podman agent. The tools run as pinned containers, so nothing is installed on
# the agent; mirror both tool images into Harbor and point the variables there.
#
#   release-gate.sh scan IMAGE NAME OUTDIR    SBOM + vulnerability/secret gate
#   release-gate.sh sign IMAGE@sha256:... SBOM_FILE
#   release-gate.sh verify IMAGE@sha256:... PUBLIC_KEY
#   release-gate.sh public-key OUT_FILE
#
# scan: writes OUTDIR/NAME.cdx.json (CycloneDX SBOM of every package) and
#   OUTDIR/NAME.vulns.json, and exits 1 when the image has a vulnerability of
#   TRIVY_SEVERITY (default HIGH,CRITICAL) with a fix available, or an embedded
#   secret. Accepted exceptions live in .trivyignore, each with a reason and an
#   expiry, reviewed like code.
# sign: signs the digest (never a tag) with the Caltrans cosign key and attaches
#   the SBOM as a signed CycloneDX attestation. Nothing goes to the public
#   Sigstore transparency log; Harbor stores the signature beside the image.
#
# Environment: TRIVY_IMAGE, COSIGN_IMAGE, TRIVY_SEVERITY, TRIVY_DB_REPOSITORY
# (Harbor mirror of the vulnerability database), TRIVY_CACHE_DIR, COSIGN_KEY_FILE,
# COSIGN_PASSWORD, REGISTRY_AUTH_FILE (the podman login --authfile JSON).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TRIVY_IMAGE="${TRIVY_IMAGE:-docker.io/aquasec/trivy:0.58.1}"
COSIGN_IMAGE="${COSIGN_IMAGE:-ghcr.io/sigstore/cosign/cosign:v2.4.1}"
TRIVY_SEVERITY="${TRIVY_SEVERITY:-HIGH,CRITICAL}"
IGNORE_FILE="$ROOT/.trivyignore"

die() { echo "release-gate: $*" >&2; exit 2; }

trivy() {
  local work="$1"; shift
  local cache="${TRIVY_CACHE_DIR:-$work/.trivy-cache}"
  mkdir -p "$cache"
  local env_args=()
  [[ -z "${TRIVY_DB_REPOSITORY:-}" ]] || env_args+=(-e "TRIVY_DB_REPOSITORY=$TRIVY_DB_REPOSITORY")
  [[ -z "${TRIVY_JAVA_DB_REPOSITORY:-}" ]] || env_args+=(-e "TRIVY_JAVA_DB_REPOSITORY=$TRIVY_JAVA_DB_REPOSITORY")
  podman run --rm "${env_args[@]}" -v "$work:/work:Z" -v "$cache:/cache:Z" -v "$IGNORE_FILE:/policy/.trivyignore:ro,Z" \
    "$TRIVY_IMAGE" --cache-dir /cache "$@"
}

cosign() {
  local keydir="$1" sbomdir="$2"; shift 2
  local auth
  auth="$(mktemp -d)"
  # cosign reads registry credentials from $DOCKER_CONFIG/config.json.
  [[ -z "${REGISTRY_AUTH_FILE:-}" ]] || cp "$REGISTRY_AUTH_FILE" "$auth/config.json"
  local status=0
  podman run --rm -e COSIGN_PASSWORD -e DOCKER_CONFIG=/auth -v "$auth:/auth:ro,Z" -v "$keydir:/keys:ro,Z" \
    -v "$sbomdir:/sbom:ro,Z" "$COSIGN_IMAGE" "$@" || status=$?
  rm -rf -- "$auth"
  return "$status"
}

require_digest() {
  [[ "$1" == *@sha256:* ]] || die "sign and verify digests, never tags: $1"
}

case "${1:-}" in
  scan)
    image="${2:?$0 scan IMAGE NAME OUTDIR}" name="${3:?name}" out="${4:?outdir}"
    [[ "$name" =~ ^[a-z0-9-]+$ ]] || die "invalid name: $name"
    [[ -f "$IGNORE_FILE" ]] || die "missing $IGNORE_FILE"
    mkdir -p "$out"
    out="$(cd "$out" && pwd)"
    work="$(mktemp -d)"
    trap 'rm -rf -- "$work"' EXIT
    podman save -o "$work/image.tar" "$image" >/dev/null
    trivy "$work" image --input /work/image.tar --format cyclonedx --output /work/sbom.cdx.json
    gate=0
    trivy "$work" image --input /work/image.tar --scanners vuln,secret --severity "$TRIVY_SEVERITY" \
      --ignore-unfixed --ignorefile /policy/.trivyignore --exit-code 1 --format json --output /work/vulns.json || gate=$?
    cp "$work/sbom.cdx.json" "$out/$name.cdx.json"
    cp "$work/vulns.json" "$out/$name.vulns.json"
    trivy "$work" convert --format table /work/vulns.json || true
    if [[ "$gate" != 0 ]]; then
      echo "release-gate: $name FAILED: fixable $TRIVY_SEVERITY vulnerabilities or embedded secrets (see $name.vulns.json)" >&2
      exit 1
    fi
    echo "release-gate: $name passed ($TRIVY_SEVERITY with a fix available, secrets); SBOM $name.cdx.json"
    ;;
  sign)
    ref="${2:?$0 sign IMAGE@sha256:... SBOM}" sbom="${3:?sbom}"
    require_digest "$ref"
    key="${COSIGN_KEY_FILE:?COSIGN_KEY_FILE is required}"
    [[ -f "$key" && -f "$sbom" ]] || die "missing cosign key or SBOM"
    keydir="$(cd "$(dirname "$key")" && pwd)" keyname="$(basename "$key")"
    sbomdir="$(cd "$(dirname "$sbom")" && pwd)" sbomname="$(basename "$sbom")"
    cosign "$keydir" "$sbomdir" sign --yes --key "/keys/$keyname" --tlog-upload=false "$ref"
    cosign "$keydir" "$sbomdir" attest --yes --key "/keys/$keyname" --tlog-upload=false \
      --type cyclonedx --predicate "/sbom/$sbomname" "$ref"
    echo "release-gate: signed $ref and attached its SBOM"
    ;;
  verify)
    ref="${2:?$0 verify IMAGE@sha256:... PUBLIC_KEY}" pub="${3:?public key}"
    require_digest "$ref"
    [[ -f "$pub" ]] || die "missing public key $pub"
    keydir="$(cd "$(dirname "$pub")" && pwd)"
    cosign "$keydir" "$keydir" verify --key "/keys/$(basename "$pub")" --insecure-ignore-tlog=true "$ref" >/dev/null
    echo "release-gate: signature verified for $ref"
    ;;
  public-key)
    out="${2:?$0 public-key OUT_FILE}"
    key="${COSIGN_KEY_FILE:?COSIGN_KEY_FILE is required}"
    keydir="$(cd "$(dirname "$key")" && pwd)"
    cosign "$keydir" "$keydir" public-key --key "/keys/$(basename "$key")" > "$out"
    ;;
  *)
    echo "Usage: $0 {scan IMAGE NAME OUTDIR|sign IMAGE@sha256:... SBOM|verify IMAGE@sha256:... PUBKEY|public-key OUT}" >&2
    exit 2
    ;;
esac

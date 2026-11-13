#!/usr/bin/env bash
# Supply-chain gate for ERIS images, run by deploy/ci/Jenkinsfile.podman on a Linux
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
#   TRIVY_SEVERITY (default all severities), even without a fix, or an embedded
#   secret. Accepted exceptions live in .trivyignore, each with a reason and an
#   expiry, reviewed like code.
# sign: signs the digest (never a tag) with the Caltrans cosign key and attaches
#   the SBOM as a signed CycloneDX attestation. Nothing goes to the public
#   Sigstore transparency log; Harbor stores the signature beside the image.
#
# Environment: TRIVY_IMAGE, COSIGN_IMAGE, TRIVY_SEVERITY, TRIVY_DB_REPOSITORY
# (Harbor mirror of the vulnerability database), TRIVY_CACHE_DIR, COSIGN_KEY_FILE,
# COSIGN_PASSWORD, REGISTRY_AUTH_FILE (the podman login --authfile JSON),
# COSIGN_REGISTRY_CA_FILE (optional private registry CA), COSIGN_NETWORK (optional
# Podman network; the isolated TLS-registry integration test uses host/loopback).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TRIVY_IMAGE="${TRIVY_IMAGE:-docker.io/aquasec/trivy:0.76.2@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb}"
# No implicit signer: even the latest upstream release can contain vulnerable
# dependencies. Jenkins builds/audits the repository recipe by default; direct
# callers must explicitly select their built and scanned tool image.
COSIGN_IMAGE="${COSIGN_IMAGE:-}"
TRIVY_SEVERITY="${TRIVY_SEVERITY:-UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL}"
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
  [[ -n "$COSIGN_IMAGE" ]] || die "COSIGN_IMAGE must name a built and scanned signing tool (deploy/images/Dockerfile.cosign)"
  local auth
  auth="$(mktemp -d)"
  # cosign reads registry credentials from $DOCKER_CONFIG/config.json.
  [[ -z "${REGISTRY_AUTH_FILE:-}" ]] || cp "$REGISTRY_AUTH_FILE" "$auth/config.json"
  [[ ! -f "$auth/config.json" ]] || chmod 600 "$auth/config.json"
  local network_args=() ca_args=() args=("$@")
  [[ -z "${COSIGN_NETWORK:-}" ]] || network_args+=(--network "$COSIGN_NETWORK")
  if [[ -n "${COSIGN_REGISTRY_CA_FILE:-}" ]]; then
    [[ -f "$COSIGN_REGISTRY_CA_FILE" ]] || { rm -rf -- "$auth"; die "registry CA file is missing"; }
    local registry_ca
    registry_ca="$(cd "$(dirname "$COSIGN_REGISTRY_CA_FILE")" && pwd)/$(basename "$COSIGN_REGISTRY_CA_FILE")"
    ca_args+=(-v "$registry_ca:/registry-ca.crt:ro,Z")
    case "${args[0]}" in
      sign|attest|verify|verify-attestation) args+=(--registry-cacert /registry-ca.crt) ;;
    esac
  fi
  local status=0
  # The distroless image's default UID65532 cannot read host-private mode-600
  # files. Keep the rootless service account's identity instead; do not loosen
  # the key/auth permissions. State is disposable and credentials stay read-only.
  podman run --rm --userns=keep-id --user "$(id -u):$(id -g)" \
    --cap-drop=ALL --security-opt=no-new-privileges --read-only \
    --workdir /tmp --tmpfs /tmp:rw,noexec,nosuid,size=64m,mode=1777 \
    "${network_args[@]}" "${ca_args[@]}" -e COSIGN_PASSWORD -e HOME=/tmp -e DOCKER_CONFIG=/auth \
    -v "$auth:/auth:ro,Z" -v "$keydir:/keys:ro,Z" \
    -v "$sbomdir:/sbom:ro,Z" "$COSIGN_IMAGE" "${args[@]}" || status=$?
  rm -rf -- "$auth"
  return "$status"
}

require_digest() {
  [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$ ]] \
    || die "sign and verify a complete sha256 digest, never tags or malformed references: $1"
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
      --ignorefile /policy/.trivyignore --exit-code 1 --format json --output /work/vulns.json || gate=$?
    cp "$work/sbom.cdx.json" "$out/$name.cdx.json"
    cp "$work/vulns.json" "$out/$name.vulns.json"
    trivy "$work" convert --format table /work/vulns.json || true
    if [[ "$gate" != 0 ]]; then
      echo "release-gate: $name FAILED: $TRIVY_SEVERITY vulnerabilities or embedded secrets (see $name.vulns.json)" >&2
      exit 1
    fi
    echo "release-gate: $name passed ($TRIVY_SEVERITY, including unfixed findings, secrets); SBOM $name.cdx.json"
    ;;
  sign)
    ref="${2:?$0 sign IMAGE@sha256:... SBOM}" sbom="${3:?sbom}"
    require_digest "$ref"
    key="${COSIGN_KEY_FILE:?COSIGN_KEY_FILE is required}"
    [[ -f "$key" && -f "$sbom" ]] || die "missing cosign key or SBOM"
    keydir="$(cd "$(dirname "$key")" && pwd)" keyname="$(basename "$key")"
    sbomdir="$(cd "$(dirname "$sbom")" && pwd)" sbomname="$(basename "$sbom")"
    # Podman's sigstoreSigned policy consumes legacy .sig attachments. Cosign3
    # supports this explicit compatibility mode; its defaults use newer bundles.
    cosign "$keydir" "$sbomdir" sign --yes --key "/keys/$keyname" --tlog-upload=false \
      --new-bundle-format=false --use-signing-config=false --registry-referrers-mode=legacy "$ref"
    cosign "$keydir" "$sbomdir" attest --yes --key "/keys/$keyname" --tlog-upload=false \
      --new-bundle-format=false --use-signing-config=false --registry-referrers-mode=legacy \
      --type cyclonedx --predicate "/sbom/$sbomname" "$ref"
    echo "release-gate: signed $ref and attached its SBOM"
    ;;
  verify)
    ref="${2:?$0 verify IMAGE@sha256:... PUBLIC_KEY}" pub="${3:?public key}"
    require_digest "$ref"
    [[ -f "$pub" ]] || die "missing public key $pub"
    keydir="$(cd "$(dirname "$pub")" && pwd)"
    cosign "$keydir" "$keydir" verify --key "/keys/$(basename "$pub")" --insecure-ignore-tlog=true \
      --new-bundle-format=false --registry-referrers-mode=legacy "$ref" >/dev/null
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

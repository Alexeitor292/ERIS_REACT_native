#!/usr/bin/env bash
# Build the ArcGIS-heavy web bundle in a regular Podman container, then package
# its static output. Podman/Buildah 4.9 can misresolve an installed Lit package
# during a Dockerfile RUN, although the same bundle builds in podman run.
set -euo pipefail

image="${1:?Usage: build-web.sh IMAGE [ENTRA_ENABLED] [LOCAL_LOGIN_ENABLED]}"
entra_enabled="${2:-false}"
local_login_enabled="${3:-true}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
scratch="$(mktemp -d)"
builder_image=""
cleanup() {
  [[ -z "$builder_image" ]] || podman rmi "$builder_image" >/dev/null 2>&1 || true
  rm -rf -- "$scratch"
}
trap cleanup EXIT

mkdir -p "$scratch/dist"
builder_image="$(podman build -q --target prepared "$root/web")"
podman run --rm --network none \
  -e NODE_OPTIONS=--max-old-space-size=4096 \
  -e VITE_API_BASE_URL=/api -e VITE_API_BASE=/api \
  -e VITE_ENTRA_ENABLED="$entra_enabled" \
  -e VITE_LOCAL_LOGIN_ENABLED="$local_login_enabled" \
  -v "$scratch/dist:/app/dist:Z" \
  "$builder_image" npm run build
cp "$root/web/nginx.conf" "$scratch/nginx.conf"
podman build -f "$root/web/Dockerfile.runtime" \
  --label "org.opencontainers.image.revision=${ERIS_SOURCE_REVISION:-unknown}" \
  -t "$image" "$scratch"

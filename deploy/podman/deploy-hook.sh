#!/usr/bin/env bash
# The only thing Jenkins's deploy key can do on the ERIS host: hand over a
# release file on stdin and run `eris-pod.sh release` with it. Install it as an
# SSH forced command in the service account's ~/.ssh/authorized_keys, on one line:
#
#   restrict,command="/opt/eris/deploy/podman/deploy-hook.sh" ssh-ed25519 AAAA... jenkins-eris-deploy
#
# `restrict` turns off port, agent and X11 forwarding and the terminal. Whatever
# command Jenkins asks for (SSH_ORIGINAL_COMMAND) is ignored, so the key cannot
# open a shell, read files or run anything else. The release file is size-limited
# and strictly validated by eris-pod.sh before anything uses it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAX_BYTES=4096
umask 077
release="$(mktemp)"
trap 'rm -f -- "$release"' EXIT

head -c "$((MAX_BYTES + 1))" > "$release"
if [[ "$(wc -c < "$release")" -gt "$MAX_BYTES" ]]; then
  echo "deploy-hook: release file larger than $MAX_BYTES bytes; refused" >&2
  exit 2
fi
client="${SSH_CLIENT:-local}"
echo "deploy-hook: release requested from ${client%% *}" >&2
bash "$HERE/eris-pod.sh" release "$release"

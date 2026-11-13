#!/usr/bin/env bash
# Integration test against real ROOTLESS Podman. Synthetic bytes only; never
# point this at production secrets. The image can be an approved agency mirror.
set -euo pipefail
image="${ERIS_SECRET_TEST_IMAGE:-docker.io/library/alpine:3.24.3}"
command -v podman >/dev/null || { echo 'Podman is required' >&2; exit 2; }
[[ "$(podman info --format '{{.Host.Security.Rootless}}')" == true ]] || {
  echo 'Run as a rootless Podman service account, not root' >&2; exit 2;
}
podman secret create --help | grep -q -- '--replace' || {
  echo 'Podman secret create --replace is required (supported target: Podman 5.x)' >&2; exit 2;
}
work="$(mktemp -d)"
name="eris-test-$(basename "$work" | tr '[:upper:]' '[:lower:]')"
old="$name-old"
cleanup() {
  podman rm -f "$old" >/dev/null 2>&1 || true
  podman secret rm "$name" >/dev/null 2>&1 || true
  rm -rf -- "$work"
}
trap cleanup EXIT
umask 077
printf 'eris-synthetic-first' > "$work/key"
chmod 700 "$work"; chmod 600 "$work/key"
options=(--user 10001:10001 --cap-drop=ALL --security-opt=no-new-privileges)
mount="$name,type=mount,target=/run/secrets/eris/key,uid=10001,gid=10001,mode=0400"

# A UID10001 process must NOT read the service account's mode-600 bind mount.
if podman run --rm "${options[@]}" -v "$work:/private:ro" "$image" cat /private/key >/dev/null 2>&1; then
  echo 'FAIL private host bind mount unexpectedly readable by UID10001' >&2; exit 1
fi
podman secret create --replace "$name" "$work/key" >/dev/null
podman run --rm "${options[@]}" --secret "$mount" "$image" sh -ec '
  test "$(id -u)" = 10001
  test "$(stat -c %u:%g:%a /run/secrets/eris/key)" = 10001:10001:400
  test "$(cat /run/secrets/eris/key)" = eris-synthetic-first
  test ! -w /run/secrets/eris/key
'
echo 'PASS rootless UID10001 reads only its private 0400 native secret'
if podman run --rm --user 10002:10002 --cap-drop=ALL --security-opt=no-new-privileges \
  --secret "$mount" "$image" cat /run/secrets/eris/key >/dev/null 2>&1; then
  echo 'FAIL another UID read the secret' >&2; exit 1
fi
echo 'PASS other UIDs cannot read the secret'

podman run -d --name "$old" "${options[@]}" --secret "$mount" "$image" sleep 300 >/dev/null
printf 'eris-synthetic-rotated' > "$work/key"
podman secret create --replace "$name" "$work/key" >/dev/null
[[ "$(podman exec "$old" cat /run/secrets/eris/key)" == eris-synthetic-first ]]
podman run --rm "${options[@]}" --secret "$mount" "$image" sh -ec \
  'test "$(cat /run/secrets/eris/key)" = eris-synthetic-rotated'
echo 'PASS rotation applies to recreated containers while the running container retains its snapshot'
podman run --rm "${options[@]}" "$image" test ! -e /run/secrets/eris/key
[[ "$(stat -c %a "$work/key")" == 600 ]]
echo 'PASS a container without --secret has no key and the original host file stays 600'

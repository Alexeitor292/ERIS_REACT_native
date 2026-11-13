#!/usr/bin/env bash
# Real rootless signing test. All keys/passwords/data are synthetic and ephemeral;
# the TLS/basic-auth registry listens only on the runner's loopback interface.
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
gate="$ROOT/deploy/ci/release-gate.sh"
for command in podman openssl htpasswd python3 curl; do command -v "$command" >/dev/null; done
[[ "$(podman info --format '{{.Host.Security.Rootless}}')" == true ]] || {
  echo 'A real rootless Podman service account is required' >&2; exit 2;
}
export COSIGN_IMAGE="${COSIGN_IMAGE:?Build deploy/images/Dockerfile.cosign and set COSIGN_IMAGE to its local tag}"
registry_image="${ERIS_REGISTRY_TEST_IMAGE:-docker.io/library/registry:3.1.2@sha256:82f6ff4a7f982960c8aa51617fea3aabc485df6e55cce80d22deb1de36f1bc3c}"
work="$(mktemp -d)"
name="eris-signature-$(basename "$work" | tr '[:upper:]' '[:lower:]')"
cleanup() {
  podman rm -f "$name" >/dev/null 2>&1 || true
  rm -rf -- "$work"
}
trap cleanup EXIT
mkdir -p "$work"/{registry,data,keys,certs,auth,context,config/containers/registries.d}
export XDG_CONFIG_HOME="$work/config"
# Pull utilities before installing the test-only default-deny signature policy.
podman image exists "$COSIGN_IMAGE" || podman pull "$COSIGN_IMAGE" >/dev/null
podman pull "$registry_image" >/dev/null
# Credentials are not created until the real signing image passes the same
# all-severity vulnerability and secret gate used for deployment images.
bash "$gate" scan "$COSIGN_IMAGE" cosign "${ERIS_SIGNATURE_REPORT_DIR:-$work/tool-audit}"

export COSIGN_PASSWORD="$(openssl rand -hex 32)"
registry_password="$(openssl rand -hex 24)"
registry_user=eris-ci
printf '%s\n' "$registry_password" | htpasswd -Bni "$registry_user" > "$work/registry/htpasswd"
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1 -subj /CN=ERIS-Synthetic-CI-CA \
  -keyout "$work/ca.key" -out "$work/certs/ca.crt" >/dev/null 2>&1
openssl req -new -newkey rsa:2048 -sha256 -nodes -subj /CN=localhost \
  -keyout "$work/registry/server.key" -out "$work/server.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' > "$work/server.ext"
openssl x509 -req -sha256 -days 1 -in "$work/server.csr" -CA "$work/certs/ca.crt" \
  -CAkey "$work/ca.key" -CAcreateserial -extfile "$work/server.ext" \
  -out "$work/registry/server.crt" >/dev/null 2>&1
port="$(python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    print(sock.getsockname()[1])
PY
)"
registry="localhost:$port"
podman run -d --name "$name" --network host --userns=keep-id --user "$(id -u):$(id -g)" \
  --cap-drop=ALL --security-opt=no-new-privileges \
  -v "$work/registry:/fixture:ro,Z" -v "$work/data:/var/lib/registry:Z" \
  -e REGISTRY_HTTP_ADDR="127.0.0.1:$port" \
  -e REGISTRY_HTTP_TLS_CERTIFICATE=/fixture/server.crt -e REGISTRY_HTTP_TLS_KEY=/fixture/server.key \
  -e REGISTRY_AUTH=htpasswd -e REGISTRY_AUTH_HTPASSWD_REALM=ERIS-CI \
  -e REGISTRY_AUTH_HTPASSWD_PATH=/fixture/htpasswd "$registry_image" >/dev/null
ready=0
for _ in $(seq 1 30); do
  status="$(curl -s --cacert "$work/certs/ca.crt" -o /dev/null -w '%{http_code}' "https://$registry/v2/" || true)"
  if [[ "$status" == 401 ]]; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]] || { echo 'TLS registry did not require authenticated access' >&2; exit 1; }
export REGISTRY_AUTH_FILE="$work/auth/config.json" COSIGN_REGISTRY_CA_FILE="$work/certs/ca.crt" COSIGN_NETWORK=host
printf '%s' "$registry_password" | podman login --authfile "$REGISTRY_AUTH_FILE" \
  --cert-dir "$work/certs" --username "$registry_user" --password-stdin "$registry" >/dev/null
chmod 700 "$work/auth" "$work/keys"
chmod 600 "$REGISTRY_AUTH_FILE"

tool() {
  podman run --rm --network host --userns=keep-id --user "$(id -u):$(id -g)" \
    --cap-drop=ALL --security-opt=no-new-privileges \
    --workdir /work -e COSIGN_PASSWORD -e HOME=/tmp -e DOCKER_CONFIG=/auth \
    -v "$work/keys:/work:Z" -v "$work/auth:/auth:ro,Z" \
    -v "$work/certs/ca.crt:/registry-ca.crt:ro,Z" "$COSIGN_IMAGE" "$@"
}
tool generate-key-pair --output-key-prefix /work/approved > "$work/keygen.log" 2>&1
tool generate-key-pair --output-key-prefix /work/wrong > "$work/keygen-wrong.log" 2>&1
[[ "$(stat -c %a "$work/keys/approved.key")" == 600 ]]
[[ "$(stat -c %a "$REGISTRY_AUTH_FILE")" == 600 ]]
export COSIGN_KEY_FILE="$work/keys/approved.key"
bash "$gate" public-key "$work/keys/exported.pub"
cmp "$work/keys/approved.pub" "$work/keys/exported.pub"
echo 'PASS rootless signer reads private key/auth without widening file permissions'

printf 'FROM scratch\nCOPY payload /payload\n' > "$work/context/Containerfile"
for variant in approved unsigned wrong; do
  printf 'ERIS synthetic %s\n' "$variant" > "$work/context/payload"
  podman build --no-cache -f "$work/context/Containerfile" -t "$registry/eris/$variant:ci" "$work/context" >/dev/null
  podman push --authfile "$REGISTRY_AUTH_FILE" --cert-dir "$work/certs" \
    --digestfile "$work/$variant.digest" "$registry/eris/$variant:ci" >/dev/null
done
approved="$registry/eris/approved@$(cat "$work/approved.digest")"
wrong="$registry/eris/wrong@$(cat "$work/wrong.digest")"
unsigned="$registry/eris/unsigned@$(cat "$work/unsigned.digest")"
printf '{"bomFormat":"CycloneDX","specVersion":"1.6","version":1,"components":[]}\n' > "$work/synthetic.cdx.json"
bash "$gate" sign "$approved" "$work/synthetic.cdx.json"
bash "$gate" verify "$approved" "$work/keys/approved.pub"
if bash "$gate" verify "$approved" "$work/keys/wrong.pub" > "$work/wrong-key.log" 2>&1; then
  echo 'FAIL signature accepted an unrelated public key' >&2; exit 1
fi
tool verify-attestation --key /work/approved.pub --type cyclonedx --insecure-ignore-tlog=true \
  --new-bundle-format=false --registry-referrers-mode=legacy --registry-cacert /registry-ca.crt \
  "$approved" > "$work/verified-attestation.json"
python3 - "$work/verified-attestation.json" <<'PY'
import base64, json, sys
result = json.load(open(sys.argv[1]))
envelopes = result if isinstance(result, list) else [result]
assert envelopes
assert any(json.loads(base64.b64decode(item['payload']))['predicate']['bomFormat'] == 'CycloneDX' for item in envelopes)
PY
COSIGN_KEY_FILE="$work/keys/wrong.key" bash "$gate" sign "$wrong" "$work/synthetic.cdx.json"
echo 'PASS real image signature, signed CycloneDX attestation and wrong-key verification rejection'

python3 - "$work/config/containers/policy.json" "$registry/eris" "$work/keys/approved.pub" <<'PY'
import json, sys
policy = {'default': [{'type': 'reject'}], 'transports': {'docker': {sys.argv[2]: [
    {'type': 'sigstoreSigned', 'keyPath': sys.argv[3], 'signedIdentity': {'type': 'matchRepository'}}]}}}
with open(sys.argv[1], 'w') as handle:
    json.dump(policy, handle)
PY
printf 'docker:\n  "%s":\n    use-sigstore-attachments: true\n' "$registry" \
  > "$work/config/containers/registries.d/eris.yaml"
# Always pull: accepting an already-cached local image is not policy proof.
podman pull --authfile "$REGISTRY_AUTH_FILE" --cert-dir "$work/certs" "$approved" >/dev/null
for ref in "$wrong" "$unsigned"; do
  if podman pull --authfile "$REGISTRY_AUTH_FILE" --cert-dir "$work/certs" "$ref" > "$work/refused.log" 2>&1; then
    echo 'FAIL Podman accepted an unsigned or wrong-signer image' >&2; exit 1
  fi
  grep -Eqi 'signature|policy|rejected' "$work/refused.log" || { cat "$work/refused.log" >&2; exit 1; }
done
echo 'PASS actual Podman signature policy accepts approved signer and rejects wrong signer/unsigned images'
echo 'PASS ephemeral TLS registry: signatures, SBOM attestation and Podman rejection controls verified'

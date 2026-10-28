#!/usr/bin/env bash
# Exercises verify-rehearsal.sh against stub `podman` and `curl`: a healthy,
# handed-over deployment passes; each misconfiguration is reported as FAIL.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/deploy" "$work/bin"
cp "$HERE/../verify-rehearsal.sh" "$work/deploy/"
SCRIPT="$work/deploy/verify-rehearsal.sh"
WEB=https://eris.example.test
FILES=https://eris-files.example.test
TENANT=11111111-1111-4111-8111-111111111111
passed=0

cat > "$work/deploy/images.env" <<'EOF'
ERIS_API_IMAGE=harbor.test/eris/api@sha256:aaaa
ERIS_WORKER_IMAGE=harbor.test/eris/worker@sha256:bbbb
ERIS_WEB_IMAGE=harbor.test/eris/web@sha256:cccc
ERIS_DB_IMAGE=harbor.test/eris/mariadb@sha256:dddd
ERIS_STORAGE_IMAGE=harbor.test/eris/seaweedfs@sha256:eeee
EOF
printf 'S3_BUCKET=eris-uploads\n' > "$work/deploy/app.env"
chmod 600 "$work/deploy/app.env"

cat > "$work/bin/podman" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  "inspect --format {{.State.Running}} "*) echo true ;;
  "inspect --format {{.ImageName}} eris-api") echo "${API_IMAGE:-harbor.test/eris/api@sha256:aaaa}" ;;
  "inspect --format {{.ImageName}} eris-worker") echo harbor.test/eris/worker@sha256:bbbb ;;
  "inspect --format {{.ImageName}} eris-web") echo harbor.test/eris/web@sha256:cccc ;;
  "inspect --format {{.ImageName}} eris-mariadb") echo harbor.test/eris/mariadb@sha256:dddd ;;
  "inspect --format {{.ImageName}} eris-seaweedfs") echo harbor.test/eris/seaweedfs@sha256:eeee ;;
  "pod inspect "*) echo "{\"80/tcp\":[{\"HostIp\":\"127.0.0.1\",\"HostPort\":\"8080\"}],\"8333/tcp\":[{\"HostIp\":\"127.0.0.1\",\"HostPort\":\"9800\"}]${EXTRA_PORT:-}}" ;;
  "exec eris-api python -m app.tools.entra_credential_check") echo "Entra certificate credential: OK"; exit "${CERT_EXIT:-0}" ;;
  "exec eris-api "*) exit 0 ;;
  *) echo "unexpected podman $*" >&2; exit 99 ;;
esac
STUB

# Stub curl: answers by URL; honours --write-out for status and redirect.
cat > "$work/bin/curl" <<'STUB'
#!/usr/bin/env bash
url="" write="" head=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --write-out) write="$2"; shift 2 ;;
    --output) shift 2 ;;
    --head) head=1; shift ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
code=200 body="ok" redirect=""
case "$url" in
  */api/docs|*/api/openapi.json) code="${DOCS_CODE:-404}" ;;
  */api/auth/me) code="${ME_CODE:-401}" ;;
  */api/auth/config) body="{\"local_login_enabled\":${LOCAL_LOGIN:-false},\"entra_enabled\":true,\"session_minutes\":120}" ;;
  */api/auth/entra/start) code=303; redirect="${ENTRA_REDIRECT}" ;;
  */eris-uploads/) code="${BUCKET_CODE:-403}" ;;
esac
if [[ "$head" == 1 ]]; then
  printf 'HTTP/1.1 200 OK\r\nX-Content-Type-Options: nosniff\r\nStrict-Transport-Security: max-age=31536000\r\n'
  printf "Content-Security-Policy: frame-ancestors 'self'\r\n\r\n"
  exit 0
fi
if [[ -n "$write" ]]; then
  [[ "$write" == '%{redirect_url}' ]] && printf '%s' "$redirect" || printf '%s' "$code"
  exit 0
fi
[[ "$code" -lt 400 ]] || exit 22
printf '%s' "$body"
STUB
if [[ "$(uname -s)" != Linux ]]; then
  # NTFS and similar report no Unix modes; pretend the files are 600.
  printf '#!/usr/bin/env bash
echo 600
' > "$work/bin/stat"
  chmod +x "$work/bin/stat"
fi
chmod +x "$work/bin/podman" "$work/bin/curl"
# The service account's signature policy (deploy/podman/signature-policy).
mkdir -p "$work/home/.config/containers"
printf '{"transports":{"docker":{"harbor.test/eris":[{"type":"sigstoreSigned","keyPath":"/k.pub"}]}}}'   > "$work/home/.config/containers/policy.json"
export HOME="$work/home" XDG_CONFIG_HOME="$work/home/.config"
export PATH="$work/bin:$PATH"
callback="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$WEB/api/auth/entra/callback" 2>/dev/null || true)"
export ENTRA_REDIRECT="https://login.microsoftonline.com/$TENANT/oauth2/v2.0/authorize?client_id=x&redirect_uri=$callback&code_challenge_method=S256"

ok() { echo "ok - $*"; passed=$((passed + 1)); }
check() {
  local description="$1"; shift 2
  if "$@"; then ok "$description"; else echo "not ok - $description"; cat "$work/out"; exit 1; fi
}
run() { bash "$SCRIPT" "$WEB" "$FILES" >"$work/out" 2>&1; }
expect_pass() {
  if run; then ok "$1"; else echo "not ok - $1"; cat "$work/out"; exit 1; fi
}
expect_fail_line() {
  local description="$1" pattern="$2"
  if run; then echo "not ok - $description (passed)"; cat "$work/out"; exit 1; fi
  if grep -q "^FAIL .*$pattern" "$work/out"; then ok "$description"; else echo "not ok - $description"; cat "$work/out"; exit 1; fi
}

expect_pass "a handed-over deployment passes"
check "reports password sign-in disabled" -- grep -q "^PASS password sign-in is disabled" "$work/out"
ERIS_VERIFY_PROFILE=production expect_pass "a pinned, Entra-only, handed-over deployment passes the production profile"
LOCAL_LOGIN=true expect_pass "password sign-in left on is a warning, not a failure"
check "warns that password sign-in is still on" -- grep -q "^WARN password sign-in is enabled" "$work/out"
EXTRA_PORT=',"3306/tcp":[{"HostIp":"0.0.0.0","HostPort":"3306"}]' expect_fail_line "a published MariaDB port fails" "internal port 3306"
API_IMAGE=harbor.test/eris/api@sha256:old expect_fail_line "a container running a stale image fails" "eris-api runs"
LOCAL_LOGIN=true ERIS_VERIFY_PROFILE=production expect_fail_line "production refuses password sign-in" "password sign-in is enabled"
sed -i 's|^ERIS_API_IMAGE=.*|ERIS_API_IMAGE=harbor.test/eris/api:release-7|' "$work/deploy/images.env"
API_IMAGE=harbor.test/eris/api:release-7 expect_pass "an unpinned image is only a warning in a rehearsal"
API_IMAGE=harbor.test/eris/api:release-7 ERIS_VERIFY_PROFILE=production \
  expect_fail_line "production refuses unpinned images" "not pinned by digest"
sed -i 's|^ERIS_API_IMAGE=.*|ERIS_API_IMAGE=harbor.test/eris/api@sha256:aaaa|' "$work/deploy/images.env"
ME_CODE=200 expect_fail_line "an anonymous request that is signed in fails" "anonymous /api/auth/me returned 200"
CERT_EXIT=2 expect_fail_line "an unusable Entra certificate fails" "Entra credential unusable"
CERT_EXIT=1 ERIS_VERIFY_PROFILE=production expect_fail_line "production refuses a certificate near expiry" "needs attention"
mv "$work/home/.config/containers/policy.json" "$work/policy.saved"
expect_pass "a missing signature policy is only a warning in a rehearsal"
ERIS_VERIFY_PROFILE=production expect_fail_line "production requires a signature policy" "no Podman signature policy"
mv "$work/policy.saved" "$work/home/.config/containers/policy.json"
DOCS_CODE=200 expect_fail_line "public API docs fail" "/api/docs returned 200"
BUCKET_CODE=200 expect_fail_line "a publicly listable bucket fails" "bucket must be private"
ENTRA_REDIRECT="https://evil.example/authorize" expect_fail_line "an unexpected Entra authority fails" "Entra start"
chmod 644 "$work/deploy/app.env"
if [[ "$(uname -s)" == Linux ]]; then
  expect_fail_line "a world-readable app.env fails" "app.env is mode 644"
else
  echo "skip - file mode check (not a Linux filesystem)"
fi

echo "All $passed verify-rehearsal.sh checks passed."

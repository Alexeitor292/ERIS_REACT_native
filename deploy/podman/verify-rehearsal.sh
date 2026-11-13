#!/usr/bin/env bash
# Read-only checks for the automatically verifiable part of a staging or
# production deployment. Run on the Podman host as the service account, through
# the public HTTPS names. FAIL lines exit nonzero; WARN lines are decisions or
# handover steps to record. ERIS_VERIFY_PROFILE=production turns the
# production gates (pinned digests, Entra-only sign-in, no bootstrap.env, HSTS)
# from WARN into FAIL. Sign-in, upload/download, restart and restore tests
# remain manual (docs/operations/caltrans-podman.md).
set -uo pipefail

usage="Usage: verify-rehearsal.sh https://eris-stage.example.gov [https://eris-files-stage.example.gov]"
base_url="${1:?$usage}"
base_url="${base_url%/}"
files_url="${2:-}"
files_url="${files_url%/}"
DEPLOY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
profile="${ERIS_VERIFY_PROFILE:-rehearsal}"
case "$profile" in production|rehearsal) ;; *) echo "FAIL ERIS_VERIFY_PROFILE must be production or rehearsal" >&2; exit 2 ;; esac
command -v python3 >/dev/null || { echo "FAIL python3 is required for deployment verification" >&2; exit 2; }
failures=0
warnings=0

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; failures=$((failures + 1)); }
warn() { echo "WARN $*"; warnings=$((warnings + 1)); }
# A production gate: a warning in a rehearsal, a failure in production.
gate() { if [[ "$profile" == production ]]; then fail "$*"; else warn "$*"; fi; }
echo "Profile: $profile"
status_of() { curl --silent --output /dev/null --write-out '%{http_code}' "$@"; }

# --- Containers and images ---------------------------------------------------
images_env="$DEPLOY/images.env"
for pair in eris-mariadb:ERIS_DB_IMAGE eris-seaweedfs:ERIS_STORAGE_IMAGE eris-api:ERIS_API_IMAGE \
            eris-worker:ERIS_WORKER_IMAGE eris-web:ERIS_WEB_IMAGE; do
  container="${pair%%:*}" var="${pair##*:}"
  if [[ "$(podman inspect --format '{{.State.Running}}' "$container" 2>/dev/null)" != true ]]; then
    fail "$container is not running"
    continue
  fi
  expected="$(sed -n "s/^${var}=//p" "$images_env" 2>/dev/null | tail -n 1)"
  actual="$(podman inspect --format '{{.ImageName}}' "$container")"
  if [[ -z "$expected" ]]; then
    fail "images.env does not name $var"
  elif [[ "$actual" != "$expected" ]]; then
    fail "$container runs $actual but images.env names $expected (recreate the pod after a release)"
  elif [[ ! "$actual" =~ ^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$ ]]; then
    gate "$container image is not pinned by digest: $actual"
  else
    pass "$container runs $actual"
  fi
done

# Inspect the effective process/settings rather than trusting declared flags.
for container in eris-api eris-worker; do
  posture="$(podman exec "$container" python -c '
# ERIS_RUNTIME_POSTURE: never print environment values or validation exceptions.
import os, sys
problems = []
try:
    from app.config import settings
    if settings.ENV.strip().lower() != "prod": problems.append("ENV must be prod")
except Exception:
    problems.append("application settings could not be loaded")
try:
    status = dict(line.split(":", 1) for line in open("/proc/1/status") if ":" in line)
    if os.geteuid() != 10001 or int(status["Uid"].split()[1]) != 10001: problems.append("effective UID must be 10001")
    if int(status["CapEff"].strip(), 16) != 0: problems.append("effective capabilities must be empty")
    if status["NoNewPrivs"].strip() != "1": problems.append("NoNewPrivs must be enabled")
except Exception:
    problems.append("process security status could not be inspected")
print("; ".join(problems))
sys.exit(bool(problems))
' 2>/dev/null)"
  if [[ "$?" == 0 ]]; then pass "$container runtime ENV, UID, capabilities and NoNewPrivs";
  else gate "$container runtime posture failed: ${posture:-inspection did not run}"; fi
done

# Nginx has no Python runtime. Check both the exec identity and its PID1 master.
if podman exec eris-web sh -ec '
# ERIS_WEB_RUNTIME_POSTURE
test "$(id -u)" = 101
awk '\''
  $1 == "Uid:" { if ($3 != 101) exit 1; uid = 1 }
  $1 == "CapEff:" { if ($2 !~ /^0+$/) exit 1; caps = 1 }
  $1 == "NoNewPrivs:" { if ($2 != 1) exit 1; nnp = 1 }
  END { if (!uid || !caps || !nnp) exit 1 }
'\'' /proc/1/status
' >/dev/null 2>&1; then
  pass "eris-web runtime UID, capabilities and NoNewPrivs"
else
  gate "eris-web runtime posture failed: UID101, empty capabilities and NoNewPrivs are required"
fi

# --- Image signatures ----------------------------------------------------------
# Podman enforces cosign signatures at pull time when the service account's
# policy requires them for the Harbor project (deploy/podman/signature-policy).
policy_file="${XDG_CONFIG_HOME:-$HOME/.config}/containers/policy.json"
[[ -f "$policy_file" ]] || policy_file=/etc/containers/policy.json
declare -A required_prefixes=()
while IFS= read -r ref; do
  [[ "$ref" == */* ]] && required_prefixes["${ref%/*}"]=1
done < <(sed -nE 's/^ERIS_(API|WORKER|WEB|DB|STORAGE)_IMAGE=//p' "$images_env" 2>/dev/null)
[[ "${#required_prefixes[@]}" -gt 0 ]] || gate "no image repository prefixes found for signature verification"
for repo_prefix in "${!required_prefixes[@]}"; do
if [[ -f "$policy_file" ]] && python3 - "$policy_file" "$repo_prefix" <<'PY'
import json, os, sys
try:
    policy = json.load(open(sys.argv[1]))
    rules = policy.get("transports", {}).get("docker", {}).get(sys.argv[2], [])
    assert policy.get("default") == [{"type": "reject"}]
    assert rules and all(r.get("type") == "sigstoreSigned" and os.path.isabs(r.get("keyPath", ""))
                         and os.path.isfile(r["keyPath"]) for r in rules)
except (OSError, ValueError, AssertionError, TypeError, AttributeError):
    sys.exit(1)
PY
then
  pass "Podman requires cosign signatures for $repo_prefix ($policy_file)"
else
  gate "no Podman signature policy requires signatures for $repo_prefix"
fi
done

# --- Host exposure -----------------------------------------------------------
ports="$(podman pod inspect --format '{{json .InfraConfig.PortBindings}}' eris 2>/dev/null || true)"
if [[ -z "$ports" ]]; then
  fail "cannot read pod port bindings"
else
  exposure="$(python3 - "$ports" <<'PY'
import ipaddress, json, sys
try:
    ports = json.loads(sys.argv[1])
    extra = set(ports) - {"8080/tcp", "8333/tcp"}
    if extra:
        print("unexpected/internal port " + ", ".join(sorted(extra)) + " is published on the host")
    elif any(not ports.get(p) for p in ("8080/tcp", "8333/tcp")):
        print("web/S3 ports are not published as expected")
    elif any(str(binding.get("HostPort")) != expected for p, expected in (("8080/tcp", "8080"), ("8333/tcp", "9800")) for binding in ports[p]):
        print("web/S3 host ports are not 8080/9800")
    else:
        private_networks = tuple(ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"))
        for bindings in ports.values():
            for binding in bindings:
                address = ipaddress.ip_address(binding.get("HostIp", ""))
                if not (address.is_loopback or any(address in network for network in private_networks)):
                    print("web/S3 must bind to loopback or a private host interface, not a public or wildcard address")
                    sys.exit(0)
except (ValueError, TypeError, AttributeError):
    print("cannot parse pod port bindings")
PY
)"
  [[ -z "$exposure" ]] && pass "only web (8080) and S3 (9800) are published" || fail "$exposure"
fi

# --- Runtime configuration files -------------------------------------------
for file in db.env storage.env app.env bootstrap.env; do
  [[ -f "$DEPLOY/$file" ]] || continue
  mode="$(stat -c '%a' "$DEPLOY/$file")"
  [[ "$mode" == 600 || "$mode" == 400 ]] && pass "$file mode $mode" || fail "$file is mode $mode; chmod 600"
done
[[ -f "$DEPLOY/bootstrap.env" ]] && gate "bootstrap.env still exists; delete it after the initial administrator is seeded"

# --- Public HTTPS endpoints ------------------------------------------------
[[ "$base_url" == https://* ]] || gate "$base_url is not HTTPS; test through the Caltrans TLS gateway"
curl --fail --silent --show-error "$base_url/healthz" >/dev/null && pass "web /healthz" || fail "web /healthz"
curl --fail --silent --show-error "$base_url/api/health" >/dev/null && pass "API /api/health" || fail "API /api/health"
for path in /api/docs /api/openapi.json; do
  code="$(status_of "$base_url$path")"
  [[ "$code" == 404 ]] && pass "$path is not served" || fail "$path returned $code; set API_DOCS_ENABLED=false"
done

headers="$(curl --silent --show-error --head "$base_url/" 2>/dev/null | tr -d '\r')"
grep -qi '^x-content-type-options: nosniff' <<<"$headers" && pass "nosniff header" || warn "X-Content-Type-Options header missing"
grep -qi '^strict-transport-security:' <<<"$headers" && pass "HSTS header" || gate "Strict-Transport-Security is not set by the TLS gateway"
grep -qi '^content-security-policy:.*frame-ancestors' <<<"$headers" && pass "frame-ancestors policy" || warn "frame-ancestors policy missing"

# --- Sign-in configuration -------------------------------------------------
auth_config="$(curl --fail --silent "$base_url/api/auth/config" || true)"
if [[ -z "$auth_config" ]]; then
  fail "API /api/auth/config did not answer"
else
  grep -q '"local_login_enabled":false' <<<"$auth_config" \
    && pass "password sign-in is disabled (Entra only)" \
    || gate "password sign-in is enabled; Caltrans production signs in through Entra only"
  if grep -q '"entra_enabled":true' <<<"$auth_config"; then
    location="$(curl --silent --output /dev/null --write-out '%{redirect_url}' "$base_url/api/auth/entra/start")"
    callback="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$base_url/api/auth/entra/callback" 2>/dev/null)"
    if [[ "$location" =~ ^https://login\.microsoftonline\.(com|us)/[0-9a-f-]{36}/oauth2/v2\.0/authorize\? ]] \
       && [[ "$location" == *"code_challenge_method=S256"* ]] \
       && [[ -z "$callback" || "$location" == *"redirect_uri=$callback"* ]]; then
      pass "Entra start redirects to the tenant authority with PKCE and this site's callback"
    else
      fail "Entra start did not redirect as expected: ${location:-no redirect}"
    fi
  else
    gate "Entra sign-in is disabled"
  fi
fi

cert_status=0
cert_report="$(podman exec eris-api python -m app.tools.entra_credential_check 2>&1)" || cert_status=$?
case "$cert_status" in
  0) pass "Entra credential: $(tail -n 1 <<<"$cert_report")" ;;
  1) gate "Entra credential needs attention: $(tr '
' ' ' <<<"$cert_report")" ;;
  *) fail "Entra credential unusable: $(tr '
' ' ' <<<"$cert_report")" ;;
esac

if podman exec eris-api python -m app.tools.handover_status >/dev/null 2>&1; then
  pass "administrator handover check"
else
  gate "administrator handover check failed; establish two Entra-linked administrators and retire bootstrap access"
fi

code="$(status_of "$base_url/api/auth/me")"
[[ "$code" == 401 ]] && pass "an anonymous request is not signed in" || fail "anonymous /api/auth/me returned $code"

# --- Object storage --------------------------------------------------------
if podman exec eris-api python -c 'from app.migrations_check import check_migration_head; check_migration_head()' 2>/dev/null; then
  pass "database is at Alembic head"
else
  fail "database is not at Alembic head"
fi
if [[ -n "$files_url" ]]; then
  [[ "$files_url" == https://* ]] || gate "$files_url is not HTTPS; signed files need the trusted TLS gateway"
  bucket="$(sed -n 's/^S3_BUCKET=//p' "$DEPLOY/app.env" 2>/dev/null | tail -n 1)"
  code="$(status_of "$files_url/${bucket:-eris-uploads}/")"
  [[ "$code" == 403 || "$code" == 401 ]] && pass "anonymous bucket listing refused ($code)" \
    || fail "anonymous request to $files_url/${bucket:-eris-uploads}/ returned $code; the bucket must be private"
else
  gate "S3 hostname not given; pass it as the second argument to check bucket privacy"
fi

echo
echo "$failures failure(s), $warnings warning(s). Still manual: Entra sign-in for linked/unknown/disabled users,"
echo "upload and signed download, pod restart and reboot, matched backup restore, and release rollback."
[[ "$failures" == 0 ]]

#!/usr/bin/env bash
# Exercises eris-pod.sh against a stub `podman` (no containers, no root):
# digest pinning, handover-check, and backup -> verify-backup -> restore,
# including the refusals that protect existing data. Run: bash test-eris-pod.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$(cd "$HERE/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
passed=0

# A throwaway checkout: the script finds its config relative to itself.
mkdir -p "$work/repo/deploy/podman" "$work/repo/database/init" "$work/bin" "$work/state/volumes"
cp "$SOURCE/eris-pod.sh" "$SOURCE/deploy-hook.sh" "$work/repo/deploy/podman/"
SCRIPT="$work/repo/deploy/podman/eris-pod.sh"
CONF="$work/repo/deploy/podman"
write_config() {
  cat > "$CONF/images.env" <<EOF
ERIS_API_IMAGE=harbor.test/eris/api@sha256:aaaa
ERIS_WORKER_IMAGE=harbor.test/eris/worker@sha256:bbbb
ERIS_WEB_IMAGE=harbor.test/eris/web@sha256:cccc
ERIS_DB_IMAGE=harbor.test/eris/mariadb@sha256:dddd
ERIS_STORAGE_IMAGE=harbor.test/eris/seaweedfs@sha256:eeee
ERIS_REQUIRE_DIGESTS=true
EOF
  printf 'MARIADB_PASSWORD=db-secret\n' > "$CONF/db.env"
  printf 'AWS_ACCESS_KEY_ID=s3\nAWS_SECRET_ACCESS_KEY=s3-secret\n' > "$CONF/storage.env"
  printf 'DB_PASS=db-secret\nS3_BUCKET=eris-uploads\n' > "$CONF/app.env"
  chmod 600 "$CONF"/*.env
}
write_config

# Stub podman: state lives in files under $STATE; every call is logged.
cat > "$work/bin/podman" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$STATE/calls"
case "$1 ${2:-}" in
  "pod exists") [[ -f "$STATE/pod" ]] ;;
  "pod inspect") cat "$STATE/pod" ;;
  "pod stop") echo Exited > "$STATE/pod" ;;
  "pod start") echo Running > "$STATE/pod" ;;
  "pod rm") rm -f "$STATE/pod" ;;
  "volume exists") [[ -d "$STATE/volumes/$3" ]] ;;
  "volume create") mkdir -p "$STATE/volumes/$3" ;;
  "volume export") [[ -z "${FAIL_EXPORT:-}" ]] || exit 1; tar -cf "$5" -C "$STATE/volumes/$3" . ;;
  "volume import") tar -xf "$4" -C "$STATE/volumes/$3" ;;
  "exec eris-api")
    if [[ "$*" == *handover_status* ]]; then echo "Administrator handover: COMPLETE"; exit "${HANDOVER_EXIT:-0}"; fi
    if [[ "$*" == *entra_credential_check* ]]; then echo "Entra certificate credential: OK"; exit "${CERT_EXIT:-0}"; fi
    echo 20261028_user_sessions ;;
  "inspect --format") echo "sha256:image-of-${4}" ;;
  pull\ *) echo "$2" >> "$STATE/pulled" ;;
  "pod create") echo Running > "$STATE/pod" ;;
  "run -d")
    if [[ "$*" == *"--name eris-api"* ]]; then echo "${@: -1}" > "$STATE/api_image"; fi ;;
  "run --rm") exit 0 ;;
  "exec eris-mariadb") exit 0 ;;
  logs\ *) exit 0 ;;
  *) echo "unexpected podman $*" >&2; exit 99 ;;
esac
STUB
printf '#!/usr/bin/env bash\nif grep -qs "@sha256:dead" "$STATE/api_image"; then exit 22; fi\nexit 0\n' > "$work/bin/curl"
chmod +x "$work/bin/podman" "$work/bin/curl"
export PATH="$work/bin:$PATH" STATE="$work/state"

ok() { echo "ok - $*"; passed=$((passed + 1)); }
# check DESCRIPTION -- COMMAND...: a failed assertion stops the run.
check() {
  local description="$1"; shift 2
  if "$@"; then ok "$description"; else echo "not ok - $description"; exit 1; fi
}
expect_fail() {
  local description="$1"; shift
  if "$@" >"$work/out" 2>&1; then echo "not ok - $description (succeeded)"; cat "$work/out"; exit 1; fi
  ok "$description"
}
expect_ok() {
  local description="$1"; shift
  if ! "$@" >"$work/out" 2>&1; then echo "not ok - $description"; cat "$work/out"; exit 1; fi
  ok "$description"
}

# --- digest pinning ----------------------------------------------------------
sed -i 's|^ERIS_WEB_IMAGE=.*|ERIS_WEB_IMAGE=harbor.test/eris/web:release-7|' "$CONF/images.env"
expect_fail "tag references are refused when ERIS_REQUIRE_DIGESTS=true" bash "$SCRIPT" status
check "the refusal names the unpinned image" -- grep -q "ERIS_WEB_IMAGE must be pinned by digest" "$work/out"
write_config
sed -i 's|^DB_PASS=.*|DB_PASS=CHANGE_ME|' "$CONF/app.env"
expect_fail "example values are still refused" bash "$SCRIPT" status
write_config

# --- handover-check ----------------------------------------------------------
echo Running > "$STATE/pod"
expect_ok "handover-check passes when the tool reports complete" bash "$SCRIPT" handover-check
printf 'ERIS_BOOTSTRAP_ADMIN_EMAIL=a@dot.ca.gov\n' > "$CONF/bootstrap.env"
expect_fail "handover-check fails while bootstrap.env remains" bash "$SCRIPT" handover-check
rm "$CONF/bootstrap.env"
HANDOVER_EXIT=1 expect_fail "handover-check fails while the tool reports outstanding items" bash "$SCRIPT" handover-check

# --- backup ------------------------------------------------------------------
mkdir -p "$STATE/volumes/eris-mariadb/mysql" "$STATE/volumes/eris-seaweedfs/buckets"
echo "row-1" > "$STATE/volumes/eris-mariadb/mysql/ibdata1"
echo "photo-bytes" > "$STATE/volumes/eris-seaweedfs/buckets/photo.jpg"
backup="$work/backups/2026-10-28"
expect_ok "backup of a running pod" bash "$SCRIPT" backup "$backup"
check "the pod is running again after the backup" -- grep -qx Running "$STATE/pod"
check "the backup is cold (pod stopped first)" -- grep -q "^pod stop eris" "$STATE/calls"
check "manifest records the schema revision" -- grep -qx "alembic_revision=20261028_user_sessions" "$backup/manifest.env"
check "manifest records image references" -- grep -qx "ERIS_API_IMAGE=harbor.test/eris/api@sha256:aaaa" "$backup/manifest.env"
check "config is captured" -- test -f "$backup/config/app.env"
check "bootstrap secrets are not captured" -- test ! -e "$backup/config/bootstrap.env"
if [[ "$(uname -s)" == Linux ]]; then
  check "backup directory is private (700)" -- test "$(stat -c '%a' "$backup")" = 700
else
  echo "skip - backup directory mode (not a Linux filesystem)"
fi
expect_fail "backup refuses to overwrite an existing directory" bash "$SCRIPT" backup "$backup"
FAIL_EXPORT=1 expect_fail "a failed volume export fails the backup" bash "$SCRIPT" backup "$work/backups/failed"
check "a failed backup restarts the pod it stopped" -- grep -qx Running "$STATE/pod"

# --- verify-backup -----------------------------------------------------------
expect_ok "verify-backup accepts an intact backup" bash "$SCRIPT" verify-backup "$backup"
cp -r "$backup" "$work/tampered"
echo "corrupt" >> "$work/tampered/seaweedfs.tar"
expect_fail "verify-backup rejects a modified archive" bash "$SCRIPT" verify-backup "$work/tampered"
rm "$work/tampered/config/db.env"
expect_fail "verify-backup rejects a backup without its config" bash "$SCRIPT" verify-backup "$work/tampered"

# --- restore -----------------------------------------------------------------
expect_fail "restore refuses while the pod exists" bash "$SCRIPT" restore "$backup"
rm "$STATE/pod"
expect_fail "restore refuses to merge into existing volumes" bash "$SCRIPT" restore "$backup"
printf 'DB_PASS=a-different-secret\nS3_BUCKET=eris-uploads\n' > "$CONF/app.env"
ERIS_DB_VOLUME=eris-mariadb-r1 ERIS_STORAGE_VOLUME=eris-seaweedfs-r1 \
  expect_fail "restore refuses mismatched runtime config" bash "$SCRIPT" restore "$backup"
cp "$backup/config/app.env" "$CONF/app.env"
ERIS_DB_VOLUME=eris-mariadb-r1 ERIS_STORAGE_VOLUME=eris-seaweedfs-r1 \
  expect_ok "restore into new volumes" bash "$SCRIPT" restore "$backup"
check "restored database volume matches the original" -- \
  cmp -s "$STATE/volumes/eris-mariadb-r1/mysql/ibdata1" "$STATE/volumes/eris-mariadb/mysql/ibdata1"
check "restored object volume matches the original" -- \
  cmp -s "$STATE/volumes/eris-seaweedfs-r1/buckets/photo.jpg" "$STATE/volumes/eris-seaweedfs/buckets/photo.jpg"
check "restore prints the start command" -- \
  grep -q "ERIS_DB_VOLUME=eris-mariadb-r1 ERIS_STORAGE_VOLUME=eris-seaweedfs-r1" "$work/out"

# --- pull ----------------------------------------------------------------------
expect_ok "pull fetches the pinned images" bash "$SCRIPT" pull
check "all five digests were pulled" -- test "$(grep -c '@sha256:' "$STATE/pulled")" = 5

# --- cert-check and the secrets directory ---------------------------------------
echo Running > "$STATE/pod"
expect_ok "cert-check passes when the API's credential is usable" bash "$SCRIPT" cert-check
CERT_EXIT=2 expect_fail "cert-check fails when the certificate is unusable" bash "$SCRIPT" cert-check
if [[ "$(uname -s)" == Linux ]]; then
  mkdir -p "$CONF/secrets"
  echo "certificate" > "$CONF/secrets/entra-client.crt"
  chmod 700 "$CONF/secrets"; chmod 600 "$CONF/secrets/entra-client.crt"
  expect_ok "backup with a private secrets directory" bash "$SCRIPT" backup "$work/backups/with-secrets"
  check "the backup carries the Entra certificate" -- test -f "$work/backups/with-secrets/config/secrets/entra-client.crt"
  check "its checksum is recorded" -- grep -q "config/secrets/entra-client.crt" "$work/backups/with-secrets/SHA256SUMS"
  chmod 644 "$CONF/secrets/entra-client.crt"
  expect_fail "a readable secrets directory is refused" bash "$SCRIPT" status
  check "the refusal says to make it private" -- grep -q "must be private" "$work/out"
  rm -rf "$CONF/secrets"
else
  echo "skip - secrets directory permissions (not a Linux filesystem)"
fi

# --- release and automatic rollback -------------------------------------------
digest() { local out=""; while [[ ${#out} -lt 64 ]]; do out+="$1"; done; echo "${out:0:64}"; }
release_file() {  # release_file FILE API_DIGEST_PREFIX
  {
    echo "# ERIS test release"
    echo "ERIS_API_IMAGE=harbor.test/eris/api@sha256:$(digest "$2")"
    echo "ERIS_WORKER_IMAGE=harbor.test/eris/worker@sha256:$(digest 2222)"
    echo "ERIS_WEB_IMAGE=harbor.test/eris/web@sha256:$(digest 3333)"
    echo "ERIS_DB_IMAGE=harbor.test/eris/mariadb@sha256:$(digest 4444)"
    echo "ERIS_STORAGE_IMAGE=harbor.test/eris/seaweedfs@sha256:$(digest 5555)"
    echo "ERIS_REQUIRE_DIGESTS=true"
  } > "$1"
}
echo Running > "$STATE/pod"
printf 'ERIS_BACKUP_ROOT=%s\nERIS_PUBLIC_URL=\n' "$work/release-backups" > "$CONF/release.env"
export ERIS_API_WAIT_ATTEMPTS=1
original_images="$(cat "$CONF/images.env")"

: > "$STATE/pulled"
release_file "$work/tagged.env" 1111
sed -i 's|^ERIS_WEB_IMAGE=.*|ERIS_WEB_IMAGE=harbor.test/eris/web:latest|' "$work/tagged.env"
expect_fail "a release naming a tag is refused" bash "$SCRIPT" release "$work/tagged.env"
check "the tag is the reason" -- grep -q "other than five pinned image digests" "$work/out"
release_file "$work/injected.env" 1111
echo 'ERIS_WORKER_IMAGE=$(touch /tmp/pwned)' >> "$work/injected.env"
expect_fail "a release file with shell syntax is refused before it is read" bash "$SCRIPT" release "$work/injected.env"
check "the shell syntax is the reason" -- grep -q "other than five pinned image digests" "$work/out"
check "the injected command never ran" -- test ! -e /tmp/pwned
release_file "$work/short.env" 1111
sed -i '/^ERIS_DB_IMAGE=/d' "$work/short.env"
expect_fail "a release missing an image is refused" bash "$SCRIPT" release "$work/short.env"
check "the missing image is the reason" -- grep -q "must name ERIS_DB_IMAGE exactly once" "$work/out"
check "nothing was pulled for refused releases" -- test ! -s "$STATE/pulled"

release_file "$work/good.env" 1111
mkdir "$CONF/.release.lock"
expect_fail "a second release cannot run at the same time" bash "$SCRIPT" release "$work/good.env"
check "the lock is the reason" -- grep -q "Another release is in progress" "$work/out"
rmdir "$CONF/.release.lock"

: > "$STATE/pulled"
expect_ok "a good release goes live" bash "$SCRIPT" release "$work/good.env"
check "it pulled all five new digests first" -- test "$(grep -c '@sha256:' "$STATE/pulled")" = 5
check "it took a pre-release backup" -- bash -c 'ls "$0"/pre-release-*/manifest.env >/dev/null' "$work/release-backups"
check "the new images are installed" -- cmp -s "$work/good.env" "$CONF/images.env"
check "the previous images are kept" -- test "$(cat "$CONF/images.env.previous")" = "$original_images"
check "the new API image is running" -- grep -q "sha256:1111" "$STATE/api_image"
check "the release is logged" -- grep -q "release OK harbor.test/eris/api@sha256:1111" "$CONF/releases.log"
check "the release lock is released" -- test ! -e "$CONF/.release.lock"

release_file "$work/bad.env" dead
expect_fail "a release that never becomes healthy fails" bash "$SCRIPT" release "$work/bad.env"
check "it rolled back to the previous images" -- cmp -s "$work/good.env" "$CONF/images.env"
check "the previous API image is running again" -- grep -q "sha256:1111" "$STATE/api_image"
check "the pre-release data was restored into new volumes" -- bash -c 'ls -d "$0"/eris-mariadb-rb* "$0"/eris-seaweedfs-rb* >/dev/null' "$STATE/volumes"
check "the restored volumes are recorded for systemd" -- grep -q "^ERIS_DB_VOLUME=eris-mariadb-rb" "$CONF/volumes.env"
check "the rollback is logged" -- grep -q "release FAILED harbor.test/eris/api@sha256:dead.*rolled back" "$CONF/releases.log"

printf '#!/usr/bin/env bash\nexit "${STUB_VERIFY_EXIT:-0}"\n' > "$CONF/verify-rehearsal.sh"
printf 'ERIS_BACKUP_ROOT=%s\nERIS_PUBLIC_URL=https://eris.example.test\n' "$work/release-backups" > "$CONF/release.env"
release_file "$work/next.env" 6666
STUB_VERIFY_EXIT=1 expect_fail "a release that fails production verification is rolled back" bash "$SCRIPT" release "$work/next.env"
check "verification failure restores the previous images" -- cmp -s "$work/good.env" "$CONF/images.env"
STUB_VERIFY_EXIT=0 expect_ok "a verified release goes live" bash "$SCRIPT" release "$work/next.env"
check "the release is now running" -- grep -q "sha256:6666" "$STATE/api_image"

# --- deploy-hook (the SSH forced command Jenkins uses) -----------------------
release_file "$work/hooked.env" 7777
expect_ok "the hook releases the file it receives on stdin" bash -c 'bash "$0" < "$1"' "$CONF/deploy-hook.sh" "$work/hooked.env"
check "the hooked release is running" -- grep -q "sha256:7777" "$STATE/api_image"
head -c 5000 /dev/zero | tr '\0' '#' > "$work/huge.env"
expect_fail "the hook refuses an oversized input" bash -c 'bash "$0" < "$1"' "$CONF/deploy-hook.sh" "$work/huge.env"
SSH_ORIGINAL_COMMAND="cat /etc/passwd" expect_fail "the hook ignores any command Jenkins asks for" \
  bash -c 'bash "$0" < "$1"' "$CONF/deploy-hook.sh" "$work/injected.env"

echo "All $passed eris-pod.sh checks passed."

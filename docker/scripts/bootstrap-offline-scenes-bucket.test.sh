#!/bin/sh
# Fixture test for the offline-scenes bootstrap anonymous-policy verification.
# Regression guard for: mc reporting a locked-down bucket as
#   Access permission for `<alias>/<bucket>` is `private`
# which the old check rejected. Verifies secure wording passes and any anonymous
# exposure (download/public/upload/list/custom) fails closed.
#
# Run: sh docker/scripts/bootstrap-offline-scenes-bucket.test.sh
set -u

DIR="$(dirname "$0")"
# Source ONLY the helper functions (no MinIO / env required).
BOOTSTRAP_LIB_ONLY=1 . "$DIR/bootstrap-offline-scenes-bucket.sh"

fails=0
# expect: 0 = must be accepted (secure), 1 = must be rejected (insecure)
check() {
  desc="$1"; input="$2"; expect="$3"
  if anon_policy_is_secure "$input"; then got=0; else got=1; fi
  if [ "$got" -eq "$expect" ]; then
    echo "PASS: $desc"
  else
    echo "FAIL: $desc (got=$got want=$expect) :: [$input]"
    fails=$((fails + 1))
  fi
}

# --- SECURE (must pass) ---
check "is \`private\` (the reported bug)" "Access permission for \`erisminio/eris-offline-scenes\` is \`private\`" 0
check "literal 'none'"                    "Access permission for \`erisminio/x\` is \`none\`" 0
check "'no anonymous ... set'"            "There is no anonymous access set on \`erisminio/x\`" 0
check "'is not set'"                      "Anonymous access is not set for \`erisminio/x\`" 0
check "mixed case Private"                "Access permission is PRIVATE" 0

# --- INSECURE / exposed (must fail closed) ---
check "download exposure"                 "Access permission for \`erisminio/x\` is set to \`download\`" 1
check "public exposure"                   "Access permission for \`erisminio/x\` is \`public\`" 1
check "upload exposure"                   "Access permission for \`erisminio/x\` is \`upload\`" 1
check "list exposure"                     "Access permission for \`erisminio/x\` is \`list\`" 1
check "custom policy"                     "Access permission for \`erisminio/x\` is \`custom\`" 1
check "empty / unknown wording"           "" 1
check "unrecognized wording"              "some unexpected mc output" 1

if [ "$fails" -eq 0 ]; then
  echo "ALL ANON-POLICY FIXTURE TESTS PASSED"
  exit 0
fi
echo "$fails FIXTURE TEST(S) FAILED"
exit 1

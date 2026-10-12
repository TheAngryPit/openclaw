#!/usr/bin/env bash
set -euo pipefail

product_sha="$OPENCLAW_PROFILE_QA_PRODUCT_SHA"
variant="$OPENCLAW_PROFILE_QA_VARIANT"
harness_sha="$OPENCLAW_PROFILE_QA_HARNESS_SHA"
qa_root="$GITHUB_WORKSPACE/qa/pr164607-owner61-proof-20261012"
proof_root="$OPENCLAW_UI_E2E_ARTIFACT_DIR"
browser_fixture=ui/src/e2e/profile-current.qa.real-gateway.e2e.test.ts
storage_fixture=src/gateway/channel-identities-final-effect.qa.test.ts
config=.artifacts/pr164607-owner61-proof-20261012/vitest.profile-current.config.ts

[[ "$product_sha" =~ ^[0-9a-f]{40}$ ]]
[[ "$harness_sha" =~ ^[0-9a-f]{40}$ ]]
case "$variant" in baseline|candidate) ;; *) exit 2 ;; esac
test "$(git rev-parse HEAD)" = "$product_sha"
test "$(git -C "$GITHUB_WORKSPACE" rev-parse HEAD)" = "$harness_sha"
test "$(git -C "$GITHUB_WORKSPACE" rev-parse HEAD^1)" = 64123ecc8813b534a01b7cc5b4b3f57744b2bba4
test -z "$(git status --porcelain=v1 --untracked-files=all)"
git -C "$GITHUB_WORKSPACE" diff --exit-code 64123ecc8813b534a01b7cc5b4b3f57744b2bba4 HEAD -- . ':(exclude).github/workflows/ci.yml' ':(exclude)qa/pr164607-owner61-proof-20261012'
mkdir "$proof_root"
printf 'product_sha=%s\nharness_sha=%s\nvariant=%s\n' "$product_sha" "$harness_sha" "$variant" > "$proof_root/receipt.txt"
node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).packageManager' >> "$proof_root/receipt.txt"
test "$(node -p 'process.versions.node')" = 24.21.0
test "$(pnpm --version)" = 12.9.0
test ! -e "$browser_fixture"
test ! -e "$storage_fixture"
test ! -e "$config"
test -z "$(git ls-files -- "$browser_fixture" "$storage_fixture" "$config")"
mkdir -p "$(dirname "$config")"
cp "$qa_root/profile-current.real-gateway.e2e.test.ts" "$browser_fixture"
cp "$qa_root/vitest.profile-current.config.ts" "$config"
if [[ "$variant" = candidate ]]; then
  cp "$qa_root/channel-identities-final-effect.test.ts" "$storage_fixture"
fi
sha256sum "$browser_fixture" "$config" > "$proof_root/qa-digests.txt"
if [[ "$variant" = candidate ]]; then
  sha256sum "$storage_fixture" >> "$proof_root/qa-digests.txt"
fi
expected_status="?? $browser_fixture"
if [[ "$variant" = candidate ]]; then
  expected_status="$(printf '?? %s\n?? %s' "$storage_fixture" "$browser_fixture")"
fi
test "$(git status --porcelain=v1 --untracked-files=all)" = "$expected_status"
find dist/control-ui -type f -print0 | sort -z | xargs -0 sha256sum > "$proof_root/build-digests.txt"
test -s "$proof_root/build-digests.txt"
verify_final_inputs() {
  local result=$?
  trap - EXIT
  local source_ok=1
  test "$(git rev-parse HEAD)" = "$product_sha" || source_ok=0
  test "$(git status --porcelain=v1 --untracked-files=all)" = "$expected_status" || source_ok=0
  sha256sum --check "$proof_root/qa-digests.txt" >/dev/null || source_ok=0
  sha256sum --check "$proof_root/build-digests.txt" >/dev/null || source_ok=0
  printf 'proof_exit=%s\ninputs_unchanged=%s\n' "$result" "$source_ok" >> "$proof_root/receipt.txt"
  if [[ "$source_ok" != 1 ]]; then
    exit 1
  fi
  exit "$result"
}
trap verify_final_inputs EXIT
if [[ "$variant" = candidate ]]; then
  node scripts/run-vitest.mjs ui/src/pages/profile/profile-page.channel-identities.test.ts ui/src/pages/profile/profile-page.test.tsx ui/src/pages/profile/personal-instructions.test.tsx --maxWorkers=1 --reporter verbose
  node scripts/run-vitest.mjs src/gateway/server-methods.channel-identities.test.ts "$storage_fixture" --maxWorkers=1 --reporter verbose
  for change in non-admin scope-revoked role-policy-revoked requester-reassigned; do
    test -s "$proof_root/final-storage-$change.json"
  done
fi
start_seconds=$SECONDS
node scripts/run-vitest.mjs run --config "$config" --configLoader runner --reporter verbose
printf 'browser_test_seconds=%s\n' "$((SECONDS-start_seconds))" >> "$proof_root/receipt.txt"
captured=0
for directory in "$proof_root"/control-ui-profile-page-real-gateway-e2e-*; do
  for size in desktop mobile; do
    test -s "$directory/06-current-profile-$size.png"
    if [[ "$variant" = candidate ]]; then
      for stage in 07-current-channel-form 08-link-added 09-link-reloaded 10-link-removed 11-navigation-abandoned-draft 12-disconnecting-draft 13-disconnected; do
        test -s "$directory/$stage-$size.png"
      done
    fi
  done
  test -s "$directory/served-assets.json"
  if [[ "$variant" = candidate ]]; then
    test -s "$directory/browser-final-storage.json"
  fi
  captured=1
done
test "$captured" = 1
printf 'required_media=present\n' >> "$proof_root/receipt.txt"

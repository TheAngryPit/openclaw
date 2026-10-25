#!/usr/bin/env bash
set -euo pipefail

product_sha="${OPENCLAW_PROFILE_QA_PRODUCT_SHA:?}"
candidate_sha="${OPENCLAW_PROFILE_QA_CANDIDATE_SHA:?}"
baseline_sha="${OPENCLAW_PROFILE_QA_BASELINE_SHA:?}"
old_qa_sha="${OPENCLAW_PROFILE_QA_OLD_QA_SHA:?}"
prep_sha="${OPENCLAW_PROFILE_QA_PREP_SHA:?}"
previous_qa_sha="${OPENCLAW_PROFILE_QA_PREVIOUS_QA_SHA:?}"
variant="${OPENCLAW_PROFILE_QA_VARIANT:?}"
harness_sha="${OPENCLAW_PROFILE_QA_HARNESS_SHA:?}"
qa_root="$GITHUB_WORKSPACE/qa/pr164607-owner61-proof-20261012"
proof_root="${OPENCLAW_UI_E2E_ARTIFACT_DIR:?}"
browser_fixture=ui/src/e2e/profile-current.qa.real-gateway.e2e.test.ts
storage_fixture=src/gateway/channel-identities-final-effect.qa.test.ts
config=.artifacts/pr164607-owner61-proof-20261012/vitest.profile-current.config.ts

[[ "$product_sha" =~ ^[0-9a-f]{40}$ ]]
[[ "$candidate_sha" =~ ^[0-9a-f]{40}$ ]]
[[ "$baseline_sha" =~ ^[0-9a-f]{40}$ ]]
[[ "$old_qa_sha" =~ ^[0-9a-f]{40}$ ]]
[[ "$prep_sha" =~ ^[0-9a-f]{40}$ ]]
[[ "$previous_qa_sha" =~ ^[0-9a-f]{40}$ ]]
[[ "$harness_sha" =~ ^[0-9a-f]{40}$ ]]
test "$baseline_sha" = d79ab6195d8d0566b285008bcc30c01a6ce368e2
test "$old_qa_sha" = ceba1804295df7407fbd42241163d70dcda35d11
test "$prep_sha" = 189c1b7746bfa885911def0c98bb25348f6dc72f
test "$previous_qa_sha" = 51a2fc47c7814c0c66a75c55ce4c57f3fa945458
test "$candidate_sha" != "$baseline_sha"
case "$variant" in
  baseline) test "$product_sha" = "$baseline_sha" ;;
  candidate) test "$product_sha" = "$candidate_sha" ;;
  *) exit 2 ;;
esac
test "$(git rev-parse HEAD)" = "$product_sha"
test "$(git -C "$GITHUB_WORKSPACE" rev-parse HEAD)" = "$harness_sha"
test "$(git -C "$GITHUB_WORKSPACE" rev-parse HEAD^1)" = "$candidate_sha"
test "$(git -C "$GITHUB_WORKSPACE" rev-parse HEAD^2)" = "$previous_qa_sha"
test "$(git -C "$GITHUB_WORKSPACE" rev-parse "$prep_sha^1")" = "$old_qa_sha"
git -C "$GITHUB_WORKSPACE" merge-base --is-ancestor "$prep_sha" "$previous_qa_sha"
git -C "$GITHUB_WORKSPACE" merge-base --is-ancestor "$old_qa_sha" "$previous_qa_sha"
git -C "$GITHUB_WORKSPACE" diff --exit-code "$old_qa_sha" "$previous_qa_sha" -- . ':(exclude).github/workflows/ci.yml' ':(exclude)qa/pr164607-owner61-proof-20261012'
git -C "$GITHUB_WORKSPACE" diff --exit-code "$candidate_sha" HEAD -- . ':(exclude).github/workflows/ci.yml' ':(exclude)qa/pr164607-owner61-proof-20261012'
test -z "$(git status --porcelain=v1 --untracked-files=all)"

package_manager="$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).packageManager')"
[[ "$package_manager" =~ ^pnpm@[0-9]+\.[0-9]+\.[0-9]+\+sha512\.[0-9a-f]{128}$ ]]
package_manager_version="${package_manager#pnpm@}"
package_manager_version="${package_manager_version%%+*}"
test "$package_manager" = "$OPENCLAW_PROFILE_QA_PACKAGE_MANAGER"
test "$package_manager_version" = "$OPENCLAW_PROFILE_QA_PNPM_VERSION"
test "$(node -p 'process.versions.node')" = "$NODE_VERSION"
test "$(corepack pnpm --version)" = "$package_manager_version"
test "$(pnpm --version)" = "$package_manager_version"
playwright_version="$(node -p 'require("./ui/package.json").devDependencies.playwright')"
test "$playwright_version" = "$OPENCLAW_PROFILE_QA_PLAYWRIGHT_VERSION"
test "$(node -p 'require("./ui/node_modules/playwright/package.json").version')" = "$playwright_version"

mkdir "$proof_root"
printf 'candidate_sha=%s\nproduct_sha=%s\nharness_sha=%s\nvariant=%s\nnode=%s\npackage_manager=%s\npnpm_version=%s\nplaywright_version=%s\n' \
  "$candidate_sha" "$product_sha" "$harness_sha" "$variant" "$NODE_VERSION" "$package_manager" "$package_manager_version" "$playwright_version" \
  > "$proof_root/receipt.txt"
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
  test "$(git -C "$GITHUB_WORKSPACE" rev-parse HEAD)" = "$harness_sha" || source_ok=0
  test "$(git -C "$GITHUB_WORKSPACE" rev-parse HEAD^1)" = "$candidate_sha" || source_ok=0
  test "$(git -C "$GITHUB_WORKSPACE" rev-parse HEAD^2)" = "$previous_qa_sha" || source_ok=0
  test "$(git -C "$GITHUB_WORKSPACE" rev-parse "$prep_sha^1")" = "$old_qa_sha" || source_ok=0
  git -C "$GITHUB_WORKSPACE" merge-base --is-ancestor "$prep_sha" "$previous_qa_sha" || source_ok=0
  git -C "$GITHUB_WORKSPACE" merge-base --is-ancestor "$old_qa_sha" "$previous_qa_sha" || source_ok=0
  git -C "$GITHUB_WORKSPACE" diff --exit-code "$candidate_sha" HEAD -- . ':(exclude).github/workflows/ci.yml' ':(exclude)qa/pr164607-owner61-proof-20261012' >/dev/null || source_ok=0
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
  node scripts/run-vitest.mjs src/gateway/server-methods.channel-identities.test.ts "$storage_fixture" --maxWorkers=1 --pool=forks --reporter verbose
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

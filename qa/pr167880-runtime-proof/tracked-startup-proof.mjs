import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const baselineSha = "59d29a7c1683dbb33f25e35c5196475e3a8b7b8d";
const titles = [
  "joins the real Tailscale prerequisite waiter when shutdown cancels recovery",
  "drains after acknowledging the exact tracked startup failure",
  "keeps a tracked startup failure when acknowledgement has a different identity",
  "preserves a second tracked startup failure after acknowledging the first",
  "keeps an unacknowledged tracked startup failure fatal at drain",
  "keeps cleanup failures as startup failures instead of parking them",
  "does not park a foreground Gateway for Tailscale authentication requirements",
];
assert.equal(process.env.CI, "true");
assert.equal(process.env.PRODUCT_SHA, baselineSha);
const git = (args) => {
  const result = spawnSync("git", args, { encoding: "utf8", stdio: "pipe" });
  assert.equal(result.status, 0, "patch or source verification failed");
  return result.stdout.trim();
};
// The workflow pins the checkout; Docker excludes Git metadata from source contexts.
for (const [path, expected] of [
  [
    "src/cli/gateway-cli/run-loop-startup.ts",
    "010d392c31d8ac69caa6065f160fab3f068675497979c56d37d0f41cb48069d0",
  ],
  [
    "src/cli/gateway-cli/run-loop.ts",
    "4ea5f68f680f73efda75687f6eb7c2b42a78771720c167e29bd356334ebf2e13",
  ],
  [
    "src/cli/gateway-cli/run-loop-startup.test-support.ts",
    "4d2a418f20fdc9ae1875bcfef0d0a9ae28fd1ac5add0eed4a87a35f9a3e82d1c",
  ],
]) {
  assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), expected);
}
mkdirSync("/qa/private", { recursive: true, mode: 0o700 });
mkdirSync("/qa/public", { recursive: true });
const apply = (patch) => {
  git(["apply", "--check", patch]);
  git(["apply", patch]);
};
const run = (variant, selected) => {
  const resultFile = `/qa/private/${variant}.json`;
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    [
      "scripts/run-vitest.mjs",
      "run",
      "--config",
      "test/vitest/vitest.cli.config.ts",
      "src/cli/gateway-cli/run-loop.test.ts",
      "--testNamePattern",
      selected.join("|"),
      "--maxWorkers=1",
      "--reporter=json",
      `--outputFile=${resultFile}`,
    ],
    {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        HOME: `/tmp/pr167880-${variant}-home`,
        OPENCLAW_STATE_DIR: `/tmp/pr167880-${variant}-state`,
        OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: `/tmp/pr167880-${variant}-module-cache`,
      },
    },
  );
  writeFileSync(`/qa/private/${variant}.stdout`, result.stdout ?? "", { mode: 0o600 });
  writeFileSync(`/qa/private/${variant}.stderr`, result.stderr ?? "", { mode: 0o600 });
  assert(!result.error && !result.signal, "test process failed to finish");
  const report = JSON.parse(readFileSync(resultFile, "utf8"));
  const cases = report.testResults
    .flatMap((suite) => suite.assertionResults)
    .filter((test) => selected.includes(test.title));
  assert.equal(cases.length, selected.length, "selected tests missing or duplicated");
  return { status: result.status, cases, durationMs: Date.now() - started };
};
apply("/qa/tracked-startup-tests.patch");
const baseline = run("baseline", titles.slice(0, 1));
assert.equal(baseline.status, 1, "baseline must fail");
assert.equal(baseline.cases[0].status, "failed");
assert(
  baseline.cases[0].failureMessages.some((message) => /expected 1 to be \+?0/.test(message)),
  "baseline did not reproduce the retained-failure exit code",
);
apply("/qa/tracked-startup-repair.patch");
const candidate = run("candidate", titles);
assert.equal(candidate.status, 0, "candidate tests must pass");
assert(candidate.cases.every((test) => test.status === "passed"));
const receipt = {
  schemaVersion: 1,
  baselineSha,
  baselineFailed: true,
  baselineExitOneInsteadOfZero: true,
  candidatePassed: true,
  candidateTestsPassed: titles.length,
  baselineDurationMs: baseline.durationMs,
  candidateDurationMs: candidate.durationMs,
};
writeFileSync("/qa/public/tracked-startup-proof.json", JSON.stringify(receipt, null, 2) + "\n");
process.stdout.write(JSON.stringify(receipt) + "\n");

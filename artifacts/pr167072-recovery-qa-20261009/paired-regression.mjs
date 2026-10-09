#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const workspace = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
const repoRoot = resolve(workspace, process.env.QA_PRODUCT_DIR ?? "qa-product");
const manifestPath = resolve(
  workspace,
  process.env.QA_TEST_MANIFEST ??
    "artifacts/pr167072-recovery-qa-20261009/testcase-identities.json",
);
const outputDir = resolve(
  workspace,
  process.env.QA_OUTPUT_DIR ??
    "artifacts/pr167072-recovery-qa-20261009/run-output",
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const baselineSha = manifest.baseline.commit;
const maxLogBytes = 16 * 1024 * 1024;
const processTimeoutMs = 20 * 60 * 1000;
const mode = process.argv[2] ?? "run";

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeWorkspacePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    isAbsolute(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail("unsafe workspace-relative artifact path");
  }
  const path = resolve(workspace, value);
  const rel = relative(workspace, path);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    fail("artifact path escapes workflow checkout");
  }
  return path;
}

function safeRepoPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    isAbsolute(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail("unsafe repository-relative source path");
  }
  const absolute = resolve(repoRoot, value);
  const rel = relative(repoRoot, absolute);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    fail("source overlay path escapes product checkout");
  }
  let parent = repoRoot;
  for (const part of rel.split(sep).slice(0, -1)) {
    parent = resolve(parent, part);
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) {
      fail("refusing a symbolic-link parent in source overlay");
    }
  }
  if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) {
    fail("refusing a symbolic-link source file");
  }
  return absolute;
}

function runGit(args, options = {}) {
  return execFileSync("git", args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: "pipe",
  }).trimEnd();
}

function runGitRaw(args, cwd = repoRoot) {
  return execFileSync("git", args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
    stdio: "pipe",
  }).toString("utf8");
}

function tryGit(args, cwd = repoRoot) {
  try {
    return { ok: true, output: runGit(args, { cwd }) };
  } catch (error) {
    return {
      ok: false,
      output: error instanceof Error ? error.message : String(error),
    };
  }
}

function checkBindings() {
  if (
    manifest.status !== "READY_FOR_ROOT_REVIEW" ||
    manifest.sourceRevisionState?.rootReviewStillRequired !== false ||
    manifest.sourceRevisionState?.dispatchable !== true ||
    JSON.stringify(manifest).includes("<UNBOUND:")
  ) {
    fail(
      "NONDISPATCHABLE: exact source pins are unbound, Root review is pending, or dispatch is not authorized",
    );
  }
  if (
    manifest.baseline.repository !== process.env.QA_BASELINE_REPOSITORY ||
    manifest.baseline.commit !== process.env.QA_BASELINE_SHA ||
    manifest.toolchain.runner !== process.env.QA_RUNNER ||
    manifest.toolchain.node !== process.env.QA_NODE_VERSION ||
    manifest.toolchain.packageManager !== process.env.QA_PNPM_PACKAGE_MANAGER
  ) {
    fail("workflow inputs differ from exact reviewed manifest pins");
  }
  for (const patch of manifest.patches) {
    const bytes = readFileSync(safeWorkspacePath(patch.path));
    if (sha256(bytes) !== patch.sha256) {
      fail("patch identity mismatch: " + patch.id);
    }
  }
  if (!Array.isArray(manifest.candidateFileSha256)) {
    fail("candidate source/test SHA-256 pins are missing");
  }
  const pinnedCandidatePaths = manifest.candidateFileSha256.map((item) => item.path).sort();
  if (
    JSON.stringify(pinnedCandidatePaths) !== JSON.stringify([...manifest.changedPaths].sort()) ||
    new Set(pinnedCandidatePaths).size !== pinnedCandidatePaths.length ||
    manifest.candidateFileSha256.some(
      (item) => typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.sha256),
    )
  ) {
    fail("candidate source/test hashes are malformed or differ from the exact changed-path set");
  }
  if (
    manifest.testCases.baselineRegression.expectedFailedTestSuites !== 1 ||
    !manifest.testCases.candidateSelected.fullNames.includes(
      manifest.testCases.baselineRegression.fullNames[0],
    )
  ) {
    fail("paired proof must compare the same single named baseline regression on candidate");
  }
}

function statusPaths() {
  const output = runGit(["status", "--porcelain", "--untracked-files=all"]);
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/^"(.*)"$/, "$1"))
    .sort();
}

function assertStatusPaths(expectedPaths, cell) {
  const expected = [...expectedPaths].sort();
  const actual = statusPaths();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      cell +
        " source overlay touched an unexpected path set; expected " +
        JSON.stringify(expected) +
        ", observed " +
        JSON.stringify(actual),
    );
  }
  return { expected, observed: actual, exact: true };
}

function applyPatch(patch, index = false, cwd = repoRoot) {
  const artifactPath = safeWorkspacePath(patch.path);
  const checkArgs = [...(index ? ["--index"] : []), "--check", artifactPath];
  runGit(["apply", ...checkArgs], { cwd });
  runGit(["apply", ...(index ? ["--index"] : []), artifactPath], { cwd });
}

function fileIdentities(paths) {
  return [...paths].sort().map((path) => {
    const bytes = readFileSync(safeRepoPath(path));
    return { path, sha256: sha256(bytes), bytes: bytes.length };
  });
}

function verifyCandidateFileHashes() {
  const observed = fileIdentities(manifest.changedPaths);
  const expected = [...manifest.candidateFileSha256]
    .map(({ path, sha256: hash }) => ({ path, sha256: hash }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const actual = observed
    .map(({ path, sha256: hash }) => ({ path, sha256: hash }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail("candidate source/test file hashes differ from reviewed manifest pins");
  }
  return observed;
}

function blobIdentities(paths) {
  return [...paths].sort().map((path) => {
    const result = tryGit(["rev-parse", baselineSha + ":" + path]);
    return { path, baselineBlob: result.ok ? result.output.trim() : null };
  });
}

function captureDependencyIdentities() {
  return manifest.dependencyIdentityPaths.map((path) => {
    const bytes = readFileSync(safeRepoPath(path));
    return { path, sha256: sha256(bytes), bytes: bytes.length };
  });
}

function verifyDependenciesUnchanged(expected) {
  const observed = captureDependencyIdentities();
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    fail("package/lock/config/wrapper identity changed across paired proof cells");
  }
  return observed;
}

async function captureToolchainIdentity() {
  const packageJson = JSON.parse(readFileSync(safeRepoPath("package.json"), "utf8"));
  const versionProcess = await runProcess(
    "toolchain-pnpm-version",
    "corepack",
    ["pnpm", "--version"],
    repoRoot,
    30_000,
  );
  const pnpmVersion = readFileSync(resolve(workspace, versionProcess.stdoutPath), "utf8").trim();
  if (
    process.version !== "v" + manifest.toolchain.node ||
    packageJson.packageManager !== manifest.toolchain.packageManager ||
    pnpmVersion !== manifest.toolchain.pnpmVersion ||
    !processHealthy(versionProcess, 0)
  ) {
    fail("observed Node/packageManager/pnpm differs from the exact reviewed toolchain pin");
  }
  const identity = {
    runner: process.env.QA_RUNNER,
    node: process.version,
    nodePath: process.execPath,
    packageManager: packageJson.packageManager,
    pnpm: pnpmVersion,
    versionCommand: versionProcess,
  };
  writeFileSync(resolve(outputDir, "toolchain.json"), JSON.stringify(identity, null, 2) + "\n");
  return identity;
}

function processEnvironment(cachePath = "") {
  const env = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG"]) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }
  env.CI = "1";
  env.GITHUB_ACTIONS = "true";
  // Product CI runs from the repository root; this workflow keeps its product
  // checkout under qa-product, so child tools must see that nested root.
  env.GITHUB_WORKSPACE = repoRoot;
  env.GITHUB_TOKEN = "";
  env.GH_TOKEN = "";
  env.OPENCLAW_VITEST_MAX_WORKERS = "2";
  if (cachePath) {
    env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH = cachePath;
  }
  return env;
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}

async function stopProcessGroup(pid) {
  let terminateSent = false;
  if (processGroupExists(pid)) {
    try {
      process.kill(-pid, "SIGTERM");
      terminateSent = true;
    } catch {
      // A completed group may disappear between the liveness check and signal.
    }
  }
  const started = Date.now();
  while (processGroupExists(pid) && Date.now() - started < 5_000) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  let killSent = false;
  if (processGroupExists(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
      killSent = true;
    } catch {
      // The process group may have exited during the second check.
    }
  }
  const afterKillStarted = Date.now();
  while (processGroupExists(pid) && Date.now() - afterKillStarted < 2_000) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return {
    terminateSent,
    killSent,
    processGroupEmpty: !processGroupExists(pid),
  };
}

function processHealthy(result, expectedExitCode) {
  const exitCodeValid =
    expectedExitCode === "nonzero"
      ? Number.isInteger(result.exitCode) && result.exitCode !== 0
      : result.exitCode === expectedExitCode;
  return (
    exitCodeValid &&
    result.signal === null &&
    result.spawnError === null &&
    result.timedOut === false &&
    result.overflowed === false &&
    result.processGroup?.processGroupEmpty === true
  );
}

async function runProcess(id, executable, args, cwd, timeoutMs = processTimeoutMs) {
  mkdirSync(outputDir, { recursive: true });
  const stdoutPath = resolve(outputDir, id + ".stdout.log");
  const stderrPath = resolve(outputDir, id + ".stderr.log");
  const startedAt = Date.now();
  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let overflowed = false;
  let timedOut = false;
  let child;
  const result = await new Promise((resolveResult) => {
    try {
      child = spawn(executable, args, {
        cwd,
        env: processEnvironment(
          resolve(outputDir, id.replace(/[^A-Za-z0-9_.-]/g, "-") + "-module-cache"),
        ),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolveResult({
        exitCode: null,
        signal: null,
        spawnError: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
        timedOut: false,
        overflowed: false,
      });
      return;
    }
    const append = (chunks, stream, countBytes) => {
      stream.on("data", (chunk) => {
        countBytes(chunk.length);
        const currentBytes = chunks.reduce((total, item) => total + item.length, 0);
        if (currentBytes + chunk.length <= maxLogBytes) {
          chunks.push(chunk);
        } else if (!overflowed) {
          overflowed = true;
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
        }
      });
    };
    append(stdoutChunks, child.stdout, (length) => {
      stdoutBytes += length;
    });
    append(stderrChunks, child.stderr, (length) => {
      stderrBytes += length;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      setTimeout(() => {
        if (processGroupExists(child.pid)) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }, 5_000).unref();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveResult({
        exitCode: null,
        signal: null,
        spawnError: error.message,
        durationMs: Date.now() - startedAt,
        timedOut,
        overflowed,
      });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolveResult({
        exitCode,
        signal,
        spawnError: null,
        durationMs: Date.now() - startedAt,
        timedOut,
        overflowed,
      });
    });
  });
  const processGroup = child?.pid ? await stopProcessGroup(child.pid) : { processGroupEmpty: true };
  const stdout = Buffer.concat(stdoutChunks);
  const stderr = Buffer.concat(stderrChunks);
  writeFileSync(stdoutPath, stdout);
  writeFileSync(stderrPath, stderr);
  return {
    id,
    executable,
    args,
    cwd,
    ...result,
    processGroup,
    stdoutBytes,
    stderrBytes,
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
    stdoutPath: relative(workspace, stdoutPath).split(sep).join("/"),
    stderrPath: relative(workspace, stderrPath).split(sep).join("/"),
  };
}

function reportAssertions(report, wrapper) {
  if (!Array.isArray(report.testResults)) {
    fail(wrapper.id + " Vitest JSON lacks testResults");
  }
  const expectedSuites = wrapper.entrypoints.map((path) => resolve(repoRoot, path)).sort();
  const actualSuites = report.testResults.map((suite) => resolve(repoRoot, suite.name)).sort();
  if (JSON.stringify(expectedSuites) !== JSON.stringify(actualSuites)) {
    fail(
      wrapper.id +
        " reported a different Vitest suite set than the pinned entrypoints; expected=" +
        JSON.stringify(wrapper.entrypoints) +
        "; observed=" +
        JSON.stringify(
          report.testResults.map((suite) => relative(repoRoot, resolve(repoRoot, suite.name)).split(sep).join("/")),
        ) +
        "; numTotalTestSuites=" +
        String(report.numTotalTestSuites) +
        "; numTotalTests=" +
        String(report.numTotalTests),
    );
  }
  const assertions = [];
  for (const suite of report.testResults) {
    if (!Array.isArray(suite.assertionResults)) {
      fail(wrapper.id + " suite lacks structured assertionResults");
    }
    for (const assertion of suite.assertionResults) {
      const fullName =
        assertion.fullName ??
        [...(assertion.ancestorTitles ?? []), assertion.title ?? ""].filter(Boolean).join(" ");
      assertions.push({ ...assertion, fullName });
    }
  }
  return assertions;
}

function loadWrapperReport(processResult, resultPath, wrapper) {
  if (processResult.timedOut || processResult.overflowed || processResult.spawnError) {
    fail(wrapper.id + " process timed out, overflowed, or failed to spawn");
  }
  if (!existsSync(resultPath)) {
    fail(wrapper.id + " did not write its structured Vitest report");
  }
  const bytes = readFileSync(resultPath);
  const report = JSON.parse(bytes.toString("utf8"));
  return parseWrapperReport(report, bytes, wrapper);
}

function parseWrapperReport(report, bytes, wrapper) {
  const assertions = reportAssertions(report, wrapper);
  const knownStatuses = new Set(["passed", "failed", "skipped", "pending", "todo"]);
  if (assertions.some((assertion) => !knownStatuses.has(assertion.status))) {
    fail(wrapper.id + " returned an unknown assertion status");
  }
  const expectedNames = Array.isArray(wrapper.fullNames) ? [...wrapper.fullNames].sort() : null;
  const selected = (expectedNames
    ? assertions.filter((assertion) => expectedNames.includes(assertion.fullName))
    : assertions
  ).sort((left, right) => left.fullName.localeCompare(right.fullName));
  const excludedByPattern = expectedNames
    ? assertions
        .filter((assertion) => !expectedNames.includes(assertion.fullName))
        .filter((assertion) => ["skipped", "pending", "todo"].includes(assertion.status))
        .map((assertion) => assertion.fullName)
        .sort()
    : [];
  const unexpectedExecutions = expectedNames
    ? assertions
        .filter((assertion) => !expectedNames.includes(assertion.fullName))
        .filter((assertion) => !["skipped", "pending", "todo"].includes(assertion.status))
    : [];
  if (unexpectedExecutions.length > 0) {
    fail(wrapper.id + " executed outside its exact selected testcase identity set");
  }
  return {
    report,
    reportSha256: sha256(bytes),
    suiteEntrypoints: report.testResults
      .map((suite) => relative(repoRoot, resolve(repoRoot, suite.name)).split(sep).join("/"))
      .sort(),
    assertions,
    selected,
    excludedByPattern,
    rawCounts: {
      total: report.numTotalTests,
      passed: report.numPassedTests,
      failed: report.numFailedTests,
      failedSuites: report.numFailedTestSuites,
      pending: report.numPendingTests ?? null,
      todo: report.numTodoTests ?? null,
      skipped: report.numSkippedTests ?? null,
    },
  };
}

function selfTestReportParser() {
  const wrapper = {
    id: "synthetic-infra-owner",
    entrypoints: ["src/infra/synthetic.test.ts"],
    fullNames: ["synthetic reporter parses a passing assertion"],
  };
  const report = {
    numTotalTestSuites: 1,
    numTotalTests: 1,
    numPassedTests: 1,
    numFailedTests: 0,
    numFailedTestSuites: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numSkippedTests: 0,
    testResults: [
      {
        name: resolve(repoRoot, wrapper.entrypoints[0]),
        assertionResults: [
          {
            ancestorTitles: [],
            title: wrapper.fullNames[0],
            status: "passed",
          },
        ],
      },
    ],
  };
  const bytes = Buffer.from(JSON.stringify(report));
  const parsed = parseWrapperReport(JSON.parse(bytes.toString("utf8")), bytes, wrapper);
  if (
    JSON.stringify(parsed.suiteEntrypoints) !== JSON.stringify(wrapper.entrypoints) ||
    parsed.selected.length !== 1 ||
    parsed.selected[0].fullName !== wrapper.fullNames[0] ||
    parsed.selected[0].status !== "passed"
  ) {
    fail("synthetic structured-report parser smoke did not preserve the exact suite and assertion identity");
  }
  let zeroSuiteDiagnostic = null;
  try {
    reportAssertions(
      { numTotalTestSuites: 0, numTotalTests: 0, testResults: [] },
      wrapper,
    );
  } catch (error) {
    zeroSuiteDiagnostic = error instanceof Error ? error.message : String(error);
  }
  if (
    !zeroSuiteDiagnostic?.includes("numTotalTestSuites=0") ||
    !zeroSuiteDiagnostic.includes("numTotalTests=0")
  ) {
    fail("synthetic zero-suite diagnostic smoke did not expose structured counts");
  }
  console.log(
    JSON.stringify({
      status: "SYNTHETIC_REPORT_PARSER_SMOKE_PASS",
      suiteEntrypoints: parsed.suiteEntrypoints,
      selected: parsed.selected.map(({ fullName, status }) => ({ fullName, status })),
      zeroSuiteDiagnostic,
      productCodeExecuted: false,
    }),
  );
}

async function runVitest(cell, wrapper) {
  const resultPath = resolve(outputDir, cell + "-" + wrapper.id + ".vitest.json");
  const args = [
    "scripts/run-vitest.mjs",
    "run",
    "--config",
    wrapper.config,
    "--reporter=json",
    "--outputFile",
    resultPath,
    "--maxWorkers=2",
  ];
  if (wrapper.pattern) {
    args.push("--testNamePattern", wrapper.pattern);
  }
  args.push(...wrapper.entrypoints);
  const processResult = await runProcess(
    cell + "-" + wrapper.id,
    process.execPath,
    args,
    repoRoot,
  );
  let observed;
  let error = null;
  try {
    observed = loadWrapperReport(processResult, resultPath, wrapper);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  return {
    id: wrapper.id,
    command: [process.execPath, ...args],
    process: processResult,
    reportPath: relative(workspace, resultPath).split(sep).join("/"),
    observed: observed
      ? {
          reportSha256: observed.reportSha256,
          suiteEntrypoints: observed.suiteEntrypoints,
          rawCounts: observed.rawCounts,
          selected: observed.selected.map((item) => ({
            fullName: item.fullName,
            status: item.status,
            failureMessages: item.failureMessages ?? [],
          })),
          excludedByPattern: observed.excludedByPattern,
        }
      : null,
    error,
  };
}

async function runVitestGroup(cell, group) {
  if (!Array.isArray(group.wrappers) || group.wrappers.length === 0) {
    fail(group.id + " has no pinned Vitest owner wrappers");
  }
  const runs = [];
  for (const wrapper of group.wrappers) {
    runs.push(await runVitest(cell, wrapper));
  }
  const observedRuns = runs.filter((run) => run.observed !== null);
  const suiteEntrypoints = observedRuns
    .flatMap((run) => run.observed.suiteEntrypoints)
    .sort();
  const expectedSuites = [...group.entrypoints].sort();
  const suiteSetMatches =
    JSON.stringify(suiteEntrypoints) === JSON.stringify(expectedSuites) &&
    new Set(suiteEntrypoints).size === suiteEntrypoints.length;
  const countFields = ["total", "passed", "failed", "failedSuites", "pending", "todo", "skipped"];
  const rawCounts = Object.fromEntries(
    countFields.map((field) => {
      const values = observedRuns.map((run) => run.observed.rawCounts[field]);
      return [
        field,
        observedRuns.length === runs.length && values.every(Number.isInteger)
          ? values.reduce((total, value) => total + value, 0)
          : null,
      ];
    }),
  );
  const selected = observedRuns
    .flatMap((run) => run.observed.selected)
    .sort((left, right) => left.fullName.localeCompare(right.fullName));
  const excludedByPattern = observedRuns
    .flatMap((run) => run.observed.excludedByPattern)
    .sort();
  const runErrors = runs.filter((run) => run.error).map((run) => run.id + ": " + run.error);
  const error =
    runErrors.length > 0
      ? runErrors.join("; ")
      : suiteSetMatches
        ? null
        : group.id + " wrapper suite union differs from the exact pinned group entrypoints";
  return {
    id: group.id,
    runs,
    error,
    observed: {
      suiteEntrypoints,
      rawCounts,
      selected,
      excludedByPattern,
    },
  };
}

function qualifyBaseline(observed) {
  if (observed.error || !observed.observed) {
    return { valid: false, reason: observed.error ?? "missing structured baseline result" };
  }
  const result = observed.observed;
  const selected = result.selected;
  const expected = manifest.testCases.baselineRegression.fullNames;
  const failedNames = selected.filter((item) => item.status === "failed").map((item) => item.fullName).sort();
  const messages = selected.flatMap((item) => item.failureMessages).join("\n");
  const behavioralSignal = manifest.qualificationBoundary.baselineFailureMustContain;
  const nonBehavioralFailure =
    /timed?\s*out|timeout|aborterror|cannot find (?:module|package)|failed to load|failed to import/i.test(
      messages,
    );
  const ok =
    selected.length === 1 &&
    selected[0].fullName === expected[0] &&
    selected[0].status === "failed" &&
    JSON.stringify(failedNames) === JSON.stringify(expected) &&
    result.rawCounts.total >= 1 &&
    result.rawCounts.failed === 1 &&
    result.rawCounts.passed === 0 &&
    result.rawCounts.failedSuites ===
      manifest.testCases.baselineRegression.expectedFailedTestSuites &&
    processHealthy(observed.process, "nonzero") &&
    !nonBehavioralFailure &&
    messages.toLowerCase().includes(behavioralSignal.toLowerCase());
  return {
    valid: ok,
    classification: ok ? "EXPECTED_NAMED_INTERMEDIATE_BASELINE_REGRESSION" : "BASELINE_NOT_QUALIFIED",
    reason: ok ? null : "failure did not match the single named behavioral regression and expected assertion signal",
    excludedByPatternCount: result.excludedByPattern.length,
    actualSelectedFailureCount: failedNames.length,
    expectedSelectedCount: expected.length,
    nonBehavioralFailureSignalRejected: nonBehavioralFailure,
    failureMessageContainsExpectedSignal: messages
      .toLowerCase()
      .includes(behavioralSignal.toLowerCase()),
  };
}

function qualifySelectedCandidate(observed) {
  if (observed.error || !observed.observed) {
    return { valid: false, reason: observed.error ?? "missing structured candidate result" };
  }
  const result = observed.observed;
  const expected = [...manifest.testCases.candidateSelected.fullNames].sort();
  const actual = result.selected.map((item) => item.fullName).sort();
  const ok =
    Array.isArray(observed.runs) &&
    observed.runs.length === manifest.testCases.candidateSelected.wrappers.length &&
    observed.runs.every((run) => !run.error && processHealthy(run.process, 0)) &&
    JSON.stringify(result.suiteEntrypoints) ===
      JSON.stringify([...manifest.testCases.candidateSelected.entrypoints].sort()) &&
    JSON.stringify(actual) === JSON.stringify(expected) &&
    result.selected.length === manifest.testCases.candidateSelected.expectedSelectedCount &&
    result.selected.every((item) => item.status === "passed") &&
    result.rawCounts.failedSuites === 0 &&
    result.selected.filter((item) => ["skipped", "pending", "todo"].includes(item.status)).length === 0;
  return {
    valid: ok,
    classification: ok ? "ALL_NAMED_CANDIDATE_REGRESSIONS_PASS" : "CANDIDATE_SELECTED_CASES_NOT_QUALIFIED",
    reason: ok ? null : "selected full-name set, positive pass outcomes, skip status, or exit code did not qualify",
    selectedCount: result.selected.length,
    selectedPassed: result.selected.filter((item) => item.status === "passed").length,
    selectedSkipped: result.selected.filter((item) => ["skipped", "pending", "todo"].includes(item.status)).length,
    excludedByPatternCount: result.excludedByPattern.length,
    excludedByPatternAreNotCountedAsPasses: true,
  };
}

function qualifyFullSuites(observed, wrapper) {
  if (observed.error || !observed.observed) {
    return { valid: false, reason: observed.error ?? "missing structured full-suite result" };
  }
  const result = observed.observed;
  const statuses = result.selected.map((item) => item.status);
  const total = result.rawCounts.total;
  const actualSkipped = statuses.filter((status) => ["skipped", "pending", "todo"].includes(status)).length;
  const expectedCountMatches =
    Number.isInteger(total) &&
    total > 0 &&
    result.selected.length === total &&
    result.rawCounts.passed === total &&
    result.rawCounts.failed === 0 &&
    result.rawCounts.failedSuites === 0 &&
    actualSkipped === 0;
  const ok =
    Array.isArray(observed.runs) &&
    observed.runs.length === wrapper.wrappers.length &&
    observed.runs.every((run) => !run.error && processHealthy(run.process, 0)) &&
    JSON.stringify(result.suiteEntrypoints) === JSON.stringify([...wrapper.expectedSuites].sort()) &&
    expectedCountMatches &&
    statuses.every((status) => status === "passed") &&
    result.excludedByPattern.length === 0;
  return {
    valid: ok,
    classification: ok ? "ALL_AFFECTED_CANDIDATE_SUITES_PASS" : "FULL_AFFECTED_SUITES_NOT_QUALIFIED",
    reason: ok ? null : "suite identity, counts, skips, failures, or process exit did not qualify",
    suiteEntrypoints: wrapper.entrypoints,
    total: result.rawCounts.total,
    passed: result.rawCounts.passed,
    failed: result.rawCounts.failed,
    skipped: result.rawCounts.skipped,
    pending: result.rawCounts.pending,
    todo: result.rawCounts.todo,
    actualSkipped,
    actualAssertionCount: result.selected.length,
    minimumTests: wrapper.minimumTests,
  };
}

async function runFormatRepairProposal() {
  const tempRoot = mkdtempSync(join(tmpdir(), "qa167072-format-review-"));
  const proposalPath = resolve(outputDir, "generated-format-repair.patch");
  let result;
  try {
    runGit(["clone", "--shared", "--no-checkout", repoRoot, tempRoot], { cwd: workspace });
    runGit(["checkout", "--detach", baselineSha], { cwd: tempRoot });
    const sourceModules = resolve(repoRoot, "node_modules");
    if (!existsSync(sourceModules)) {
      fail("installed node_modules unavailable for isolated formatter proposal");
    }
    symlinkSync(sourceModules, resolve(tempRoot, "node_modules"), "dir");
    for (const patch of manifest.patches) {
      const artifactPath = safeWorkspacePath(patch.path);
      runGit(["apply", "--index", artifactPath], { cwd: tempRoot });
    }
    const formatArgs = ["--write", "--threads=1", ...manifest.changedPaths];
    const formatProcess = await runProcess(
      "format-proposal",
      resolve(tempRoot, "node_modules/.bin/oxfmt"),
      formatArgs,
      tempRoot,
      processTimeoutMs,
    );
    const diff = runGitRaw(["diff", "--binary", "--", ...manifest.changedPaths], tempRoot);
    writeFileSync(proposalPath, diff);
    result = {
      state: "PROPOSAL_ONLY_NOT_APPLIED_TO_PROOF_CHECKOUT",
      command: [resolve(tempRoot, "node_modules/.bin/oxfmt"), ...formatArgs],
      process: formatProcess,
      patchPath: relative(workspace, proposalPath).split(sep).join("/"),
      patchSha256: sha256(readFileSync(proposalPath)),
      patchHasChanges: diff.length > 0,
    };
  } finally {
    const normalizedTempRoot = resolve(tempRoot);
    if (
      dirname(normalizedTempRoot) !== resolve(tmpdir()) ||
      !normalizedTempRoot.split(sep).at(-1).startsWith("qa167072-format-review-")
    ) {
      fail("refusing to remove an unexpected formatter-review temp directory");
    }
    rmSync(normalizedTempRoot, { recursive: true, force: true });
  }
  return result;
}

async function restoreExactOverlays() {
  const reversals = [];
  for (const patch of [...manifest.patches].reverse()) {
    const artifactPath = safeWorkspacePath(patch.path);
    const hashMatches = sha256(readFileSync(artifactPath)) === patch.sha256;
    if (!hashMatches) {
      reversals.push({ id: patch.id, reverted: false, reason: "patch hash mismatch" });
      continue;
    }
    const check = tryGit(["apply", "--reverse", "--check", artifactPath]);
    if (!check.ok) {
      reversals.push({ id: patch.id, reverted: false, reason: "reverse patch not present" });
      continue;
    }
    runGit(["apply", "--reverse", artifactPath]);
    reversals.push({ id: patch.id, reverted: true, reason: null });
  }
  const status = runGit(["status", "--porcelain", "--untracked-files=all"]);
  const clean = status.length === 0;
  const receipt = {
    status: clean ? "CLEANUP_VERIFIED" : "CLEANUP_UNVERIFIED",
    reversals,
    repositoryWorktreeClean: clean,
    remainingStatus: status,
    servicesStartedByHarness: [],
    serviceProof: "NOT RUN; no daemon, service, container, or external provider is part of this unit lane",
  };
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(resolve(outputDir, "cleanup-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}

function writeEvidence(evidence) {
  mkdirSync(outputDir, { recursive: true });
  const path = resolve(outputDir, "paired-regression-results.json");
  writeFileSync(path, JSON.stringify(evidence, null, 2) + "\n");
  console.log("PAIRED_REGRESSION_EVIDENCE_BEGIN");
  console.log(JSON.stringify(evidence, null, 2));
  console.log("PAIRED_REGRESSION_EVIDENCE_END");
}

async function runLane() {
  checkBindings();
  if (runGit(["rev-parse", "HEAD"]) !== baselineSha) {
    fail("product checkout HEAD is not the exact public baseline");
  }
  if (statusPaths().length !== 0) {
    fail("product checkout must be clean before the baseline overlay");
  }
  const identityReceiptPath = resolve(outputDir, "source-and-test-identities.json");
  const identityReceipt = JSON.parse(readFileSync(identityReceiptPath, "utf8"));
  if (
    identityReceipt.status !== "QA_INPUT_IDENTITIES_VERIFIED" ||
    identityReceipt.baseline.commit !== baselineSha
  ) {
    fail("QA input-identity receipt is missing or mismatched");
  }
  const toolchain = await captureToolchainIdentity();
  const dependenciesBefore = captureDependencyIdentities();
  const sourceBaseBlobs = blobIdentities(manifest.changedPaths);
  const evidence = {
    classification: "NOT_CLASSIFIED",
    baseline: {
      repository: manifest.baseline.repository,
      commit: baselineSha,
      kind: manifest.qualificationBoundary.baselineKind,
      label: manifest.qualificationBoundary.baselineLabel,
      explicitlyNotUnchangedMain: true,
    },
    candidate: {
      identityKind: manifest.candidate.identityKind,
      commitRequired: false,
      patches: manifest.patches.map(({ id, path, sha256: hash, paths }) => ({
        id,
        path,
        sha256: hash,
        paths,
      })),
    },
    runtime: {
      runner: process.env.QA_RUNNER,
      image: process.env.ImageOS ?? "runner-image-not-exposed",
      imageVersion: process.env.ImageVersion ?? "runner-image-version-not-exposed",
      node: process.version,
      platform: process.platform + "/" + process.arch,
    },
    toolchain,
    dependencyIdentity: {
      paths: dependenciesBefore,
      installCount: manifest.toolchain.installCount,
      installCommand: manifest.toolchain.installCommand,
      equalityCheckedAfterOverlays: true,
    },
    baselineSourceBlobs: sourceBaseBlobs,
    sourceAndTestIdentities: identityReceipt,
    cells: {},
    changedChecks: {},
    formatRepairProposal: null,
    cleanup: null,
  };
  try {
    applyPatch(manifest.patches.find((patch) => patch.id === "classification-prerequisite"));
    applyPatch(manifest.patches.find((patch) => patch.id === "candidate-tests-overlay"));
    evidence.cells.baselineOverlay = assertStatusPaths(
      manifest.baselineOverlayPaths,
      "classification-prerequisite baseline",
    );
    const baselineLifecycleDiff = tryGit([
      "diff",
      "--quiet",
      baselineSha,
      "--",
      ...manifest.baselineUnmodifiedLifecyclePaths,
    ]);
    if (!baselineLifecycleDiff.ok) {
      fail("baseline lifecycle-fix paths differ from canonical e670");
    }
    evidence.cells.baselineLifecycleUnmodified = manifest.baselineUnmodifiedLifecyclePaths;
    evidence.cells.baselineSourceAndTestHashes = fileIdentities(
      manifest.patches.find((patch) => patch.id === "classification-prerequisite").paths.concat(
        manifest.patches.find((patch) => patch.id === "candidate-tests-overlay").paths,
      ),
    );
    evidence.cells.baselineNamedRegression = await runVitest(
      "baseline",
      manifest.testCases.baselineRegression,
    );
    evidence.cells.baselineNamedRegression.qualification = qualifyBaseline(
      evidence.cells.baselineNamedRegression,
    );

    applyPatch(manifest.patches.find((patch) => patch.id === "lifecycle-fix"));
    evidence.cells.candidateOverlay = assertStatusPaths(manifest.changedPaths, "candidate");
    evidence.cells.candidateSourceAndTestHashesBeforeTests = verifyCandidateFileHashes();
    verifyDependenciesUnchanged(dependenciesBefore);

    evidence.cells.candidateSelectedRegressions = await runVitestGroup(
      "candidate",
      manifest.testCases.candidateSelected,
    );
    evidence.cells.candidateSelectedRegressions.qualification = qualifySelectedCandidate(
      evidence.cells.candidateSelectedRegressions,
    );
    evidence.cells.candidateSourceAndTestHashesAfterSelected = verifyCandidateFileHashes();

    evidence.cells.candidateAffectedSuites = await runVitestGroup(
      "candidate",
      manifest.testCases.candidateAffectedSuites,
    );
    evidence.cells.candidateAffectedSuites.qualification = qualifyFullSuites(
      evidence.cells.candidateAffectedSuites,
      manifest.testCases.candidateAffectedSuites,
    );
    evidence.cells.candidateSourceAndTestHashesAfterSuites = verifyCandidateFileHashes();

    const diffCheck = await runProcess(
      "candidate-git-diff-check",
      "git",
      ["diff", "--check"],
      repoRoot,
      60_000,
    );
    evidence.changedChecks.diffCheck = diffCheck;
    evidence.changedChecks.hashesAfterDiffCheck = verifyCandidateFileHashes();

    const checkPaths = [...manifest.changedPaths];
    const dryRun = await runProcess(
      "candidate-check-changed-dry-run",
      process.execPath,
      [
        "scripts/check-changed.mjs",
        "--dry-run",
        "--base",
        baselineSha,
        "--",
        ...checkPaths,
      ],
      repoRoot,
    );
    evidence.changedChecks.plan = dryRun;
    evidence.changedChecks.hashesAfterDryRun = verifyCandidateFileHashes();
    const check = await runProcess(
      "candidate-check-changed",
      process.execPath,
      [
        "scripts/check-changed.mjs",
        "--base",
        baselineSha,
        "--",
        ...checkPaths,
      ],
      repoRoot,
    );
    evidence.changedChecks.result = check;
    evidence.changedChecks.hashesAfterCheckChanged = verifyCandidateFileHashes();

    const formatCheck = await runProcess(
      "candidate-format-check",
      "corepack",
      ["pnpm", "format:check", "--", ...checkPaths],
      repoRoot,
    );
    evidence.changedChecks.formatCheck = formatCheck;
    evidence.changedChecks.hashesAfterFormatCheck = verifyCandidateFileHashes();
    if (formatCheck.exitCode !== 0 || formatCheck.timedOut || formatCheck.overflowed) {
      evidence.formatRepairProposal = await runFormatRepairProposal();
    }
    evidence.dependencyIdentity.pathsAfterAllCommands =
      verifyDependenciesUnchanged(dependenciesBefore);

    const proofPass =
      evidence.cells.baselineNamedRegression.qualification.valid &&
      evidence.cells.candidateSelectedRegressions.qualification.valid &&
      evidence.cells.candidateAffectedSuites.qualification.valid &&
      processHealthy(diffCheck, 0) &&
      processHealthy(dryRun, 0) &&
      processHealthy(check, 0) &&
      processHealthy(formatCheck, 0) &&
      JSON.stringify(evidence.cells.candidateSourceAndTestHashesBeforeTests) ===
        JSON.stringify(evidence.changedChecks.hashesAfterFormatCheck) &&
      JSON.stringify(evidence.dependencyIdentity.paths) ===
        JSON.stringify(evidence.dependencyIdentity.pathsAfterAllCommands) &&
      evidence.formatRepairProposal === null;
    evidence.classification = proofPass
      ? "QUALIFIED_SECRETLESS_PAIRED_UNIT_AND_CHANGED_CHECKS"
      : evidence.formatRepairProposal
        ? "FORMAT_REPAIR_PROPOSAL_REQUIRES_REVIEW"
        : "INCONCLUSIVE_OR_FAILING_QA_GATES";
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    evidence.classification = "HARNESS_ERROR";
  } finally {
    try {
      evidence.cleanup = await restoreExactOverlays();
    } catch (error) {
      evidence.cleanup = {
        status: "CLEANUP_UNVERIFIED",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (evidence.cleanup?.repositoryWorktreeClean !== true) {
      evidence.classification = "CLEANUP_UNVERIFIED";
    }
    writeEvidence(evidence);
  }
  if (evidence.classification !== "QUALIFIED_SECRETLESS_PAIRED_UNIT_AND_CHANGED_CHECKS") {
    process.exitCode = 1;
  }
}

async function cleanupOnly() {
  const receipt = await restoreExactOverlays();
  console.log("QA_OVERLAY_CLEANUP_BEGIN");
  console.log(JSON.stringify(receipt, null, 2));
  console.log("QA_OVERLAY_CLEANUP_END");
  if (!receipt.repositoryWorktreeClean) {
    process.exitCode = 1;
  }
}

if (mode === "run") {
  await runLane();
} else if (mode === "cleanup") {
  await cleanupOnly();
} else if (mode === "self-test-report") {
  selfTestReportParser();
} else {
  fail("usage: paired-regression.mjs [run|cleanup|self-test-report]");
}

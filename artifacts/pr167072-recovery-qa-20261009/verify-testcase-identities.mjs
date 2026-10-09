#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, relative, sep, isAbsolute } from "node:path";

const workspace = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
const manifestRelative =
  process.env.QA_TEST_MANIFEST ??
  "artifacts/pr167072-recovery-qa-20261009/testcase-identities.json";
const receiptRelative =
  process.env.QA_OUTPUT_DIR ??
  "artifacts/pr167072-recovery-qa-20261009/run-output";
const manifestPath = resolve(workspace, manifestRelative);
const outputDir = resolve(workspace, receiptRelative);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function workspaceFile(relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.includes("\\") ||
    isAbsolute(relativePath) ||
    relativePath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail("unsafe workspace-relative artifact path");
  }
  const path = resolve(workspace, relativePath);
  const fromRoot = relative(workspace, path);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(".." + sep) || isAbsolute(fromRoot)) {
    fail("artifact path escaped the workflow checkout");
  }
  return path;
}

try {
  if (manifest.status !== "READY_FOR_ROOT_REVIEW" || JSON.stringify(manifest).includes("<UNBOUND:")) {
    fail("manifest is unbound or has not reached Root review");
  }
  if (
    manifest.baseline.repository !== process.env.QA_BASELINE_REPOSITORY ||
    manifest.baseline.commit !== process.env.QA_BASELINE_SHA
  ) {
    fail("workflow baseline differs from the reviewed public identity");
  }
  if (
    manifest.toolchain.runner !== process.env.QA_RUNNER ||
    manifest.toolchain.node !== process.env.QA_NODE_VERSION ||
    manifest.toolchain.packageManager !== process.env.QA_PNPM_PACKAGE_MANAGER
  ) {
    fail("workflow toolchain differs from the pinned manifest");
  }
  if (
    manifest.qualificationBoundary.baselineKind !==
      "classification-prerequisite-intermediate" ||
    manifest.qualificationBoundary.notUnchangedMain !== true ||
    manifest.qualificationBoundary.lifecycleFixAppliedToBaseline !== false ||
    typeof manifest.qualificationBoundary.baselineFailureMustContain !== "string" ||
    manifest.qualificationBoundary.baselineFailureMustContain.trim().length === 0 ||
    /timed?\s*out|timeout|aborterror|cannot find (?:module|package)|failed to load|failed to import/i.test(
      manifest.qualificationBoundary.baselineFailureMustContain,
    )
  ) {
    fail("baseline proof boundary is not honestly labeled");
  }

  const patchReceipts = [];
  for (const patch of manifest.patches) {
    const bytes = readFileSync(workspaceFile(patch.path));
    const observedHash = sha256(bytes);
    if (observedHash !== patch.sha256) {
      fail("patch hash does not match manifest: " + patch.id);
    }
    const text = bytes.toString("utf8");
    const changedPaths = [
      ...text.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm),
    ].map((match) => {
      if (match[1] !== match[2]) {
        fail("patch changes a path through a rename: " + patch.id);
      }
      return match[1];
    });
    const expected = [...patch.paths].sort();
    if (
      changedPaths.length !== expected.length ||
      JSON.stringify([...changedPaths].sort()) !== JSON.stringify(expected)
    ) {
      fail("patch path set differs from manifest: " + patch.id);
    }
    patchReceipts.push({ id: patch.id, path: patch.path, sha256: observedHash, paths: expected });
  }

  const changedPaths = [...manifest.changedPaths].sort();
  const candidatePaths = manifest.candidateFileSha256.map((item) => item.path).sort();
  if (
    JSON.stringify(changedPaths) !== JSON.stringify(candidatePaths) ||
    new Set(candidatePaths).size !== candidatePaths.length ||
    manifest.candidateFileSha256.some(
      (item) => typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.sha256),
    )
  ) {
    fail("candidate source identity set differs from the exact overlay allowlist");
  }
  const patchPaths = [...new Set(manifest.patches.flatMap((patch) => patch.paths))].sort();
  const expectedOverlayPaths = [...manifest.baselineOverlayPaths].sort();
  const classification = manifest.patches.find((patch) => patch.id === "classification-prerequisite");
  const tests = manifest.patches.find((patch) => patch.id === "candidate-tests-overlay");
  const lifecycle = manifest.patches.find((patch) => patch.id === "lifecycle-fix");
  if (!classification || !tests || !lifecycle) {
    fail("the three-step intermediate/candidate patch split is incomplete");
  }
  const actualBaselinePaths = [...new Set([...classification.paths, ...tests.paths])].sort();
  const expectedLifecyclePaths = changedPaths.filter((path) => !expectedOverlayPaths.includes(path));
  if (
    JSON.stringify(patchPaths) !== JSON.stringify(changedPaths) ||
    JSON.stringify(actualBaselinePaths) !== JSON.stringify(expectedOverlayPaths) ||
    JSON.stringify([...lifecycle.paths].sort()) !== JSON.stringify(expectedLifecyclePaths) ||
    JSON.stringify([...manifest.baselineUnmodifiedLifecyclePaths].sort()) !==
      JSON.stringify([...lifecycle.paths].sort())
  ) {
    fail("patch split, intermediate baseline overlay, or lifecycle boundary differs from the manifest");
  }
  if (
    manifest.testCases.baselineRegression.fullNames.length !== 1 ||
    manifest.testCases.baselineRegression.expectedSelectedCount !== 1 ||
    manifest.testCases.baselineRegression.expectedFailedTestSuites !== 1 ||
    manifest.testCases.candidateSelected.fullNames.length === 0 ||
    manifest.testCases.candidateSelected.expectedSelectedCount !==
      manifest.testCases.candidateSelected.fullNames.length ||
    new Set(manifest.testCases.candidateSelected.fullNames).size !==
      manifest.testCases.candidateSelected.fullNames.length ||
    !manifest.testCases.candidateSelected.fullNames.includes(
      manifest.testCases.baselineRegression.fullNames[0],
    ) ||
    JSON.stringify([...manifest.testCases.candidateSelected.entrypoints].sort()) !==
      JSON.stringify([...manifest.testCases.candidateAffectedSuites.entrypoints].sort()) ||
    manifest.testCases.candidateAffectedSuites.minimumTests < 1
  ) {
    fail("named regression identities and selected counts are inconsistent");
  }

  const receipt = {
    status: "QA_INPUT_IDENTITIES_VERIFIED",
    baseline: manifest.baseline,
    baselineKind: manifest.qualificationBoundary.baselineKind,
    candidateIdentity: manifest.candidate.identityKind,
    candidateCommitRequired: false,
    rootReviewStillRequired: manifest.sourceRevisionState.rootReviewStillRequired,
    dispatchable: manifest.sourceRevisionState.dispatchable,
    patches: patchReceipts,
    candidateFileSha256: manifest.candidateFileSha256,
    dependencyIdentityPaths: manifest.dependencyIdentityPaths,
    namedTests: {
      baselineRegression: manifest.testCases.baselineRegression.fullNames,
      candidateSelected: manifest.testCases.candidateSelected.fullNames,
      affectedSuiteEntrypoints: manifest.testCases.candidateAffectedSuites.expectedSuites,
    },
    verifiedAt: new Date().toISOString(),
  };
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(resolve(outputDir, "source-and-test-identities.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log("QA_INPUT_IDENTITIES_VERIFIED");
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  console.error("NONDISPATCHABLE: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 2;
}

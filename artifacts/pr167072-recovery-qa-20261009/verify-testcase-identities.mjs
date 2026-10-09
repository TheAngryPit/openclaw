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
const canonicalCoreTestGraphs = [
  "agents-root",
  "agents-other",
  "agents-tools",
  "gateway-root",
  "gateway-server",
  "gateway-other",
  "infra",
  "state-logging",
  "commands",
  "plugins-platform",
  "config-cli",
  "messaging",
  "services",
  "other",
  "ui-pages",
  "ui-e2e",
  "ui-other",
  "packages",
  "plugin-sdk",
  "commands-doctor",
  "cli-update",
  "gateway-methods",
  "ui-chat",
  "agents-sessions",
  "services-cron",
  "ui-app",
  "ui-components",
];

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

function expectedVitestOwnerConfig(entrypoint) {
  if (entrypoint.startsWith("src/cli/")) {
    return "test/vitest/vitest.cli.config.ts";
  }
  if (entrypoint.startsWith("src/infra/")) {
    return "test/vitest/vitest.infra.config.ts";
  }
  return null;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function verifyMatcherIdentities(group, label) {
  if (
    !Array.isArray(group.fullNames) ||
    !Array.isArray(group.matcherIdentities) ||
    group.fullNames.length === 0 ||
    group.matcherIdentities.length !== group.fullNames.length
  ) {
    fail(label + " does not map each reporter identity to one Vitest matcher identity");
  }
  const reporterNames = group.matcherIdentities.map((identity) => identity.reporterFullName);
  const vitestNames = group.matcherIdentities.map((identity) => identity.vitestFullName);
  if (
    group.matcherIdentities.some(
      (identity) =>
        typeof identity.reporterFullName !== "string" ||
        typeof identity.vitestFullName !== "string" ||
        identity.vitestFullName.trim() !== identity.vitestFullName ||
        !identity.vitestFullName.includes(" > ") ||
        identity.vitestFullName.replaceAll(" > ", " ") !== identity.reporterFullName,
    ) ||
    new Set(reporterNames).size !== reporterNames.length ||
    new Set(vitestNames).size !== vitestNames.length ||
    JSON.stringify(reporterNames) !== JSON.stringify(group.fullNames)
  ) {
    fail(label + " matcher identities do not normalize one-to-one to reporter names");
  }
  const expectedPattern = `^(?:${vitestNames.map(escapeRegex).join("|")})$`;
  if (group.pattern !== expectedPattern) {
    fail(label + " Vitest v5 pattern is not the anchored escaped matcher identity set");
  }
  return group.matcherIdentities;
}

function verifyWrapperRoutes(group, label, { requireFullNames = false } = {}) {
  if (!Array.isArray(group.wrappers) || group.wrappers.length === 0) {
    fail(label + " has no explicit owning-config wrappers");
  }
  const wrapperIds = group.wrappers.map((wrapper) => wrapper.id);
  const entrypoints = group.wrappers.flatMap((wrapper) => wrapper.entrypoints ?? []);
  if (
    wrapperIds.some((id) => typeof id !== "string" || id.length === 0) ||
    new Set(wrapperIds).size !== wrapperIds.length ||
    new Set(entrypoints).size !== entrypoints.length ||
    group.wrappers.some(
      (wrapper) =>
        !Array.isArray(wrapper.entrypoints) ||
        wrapper.entrypoints.length === 0 ||
        wrapper.entrypoints.some((entrypoint) => expectedVitestOwnerConfig(entrypoint) !== wrapper.config),
    )
  ) {
    fail(label + " has duplicate entrypoints or a non-owning Vitest config");
  }
  return {
    entrypoints: [...entrypoints].sort(),
    fullNames: requireFullNames
      ? group.wrappers.flatMap((wrapper) => wrapper.fullNames ?? [])
      : [],
  };
}

try {
  if (manifest.status !== "READY_FOR_ROOT_REVIEW" || JSON.stringify(manifest).includes("<UNBOUND:")) {
    fail("manifest is unbound or has not reached Root review");
  }
  if (
    typeof manifest.sourceRevisionState?.rootReviewStillRequired !== "boolean" ||
    typeof manifest.sourceRevisionState?.dispatchable !== "boolean" ||
    manifest.sourceRevisionState.dispatchable === manifest.sourceRevisionState.rootReviewStillRequired ||
    (process.env.GITHUB_ACTIONS === "true" && manifest.sourceRevisionState.rootReviewStillRequired)
  ) {
    fail("identity receipt has inconsistent review state or hosted execution lacks Root acceptance");
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
  const baseline = manifest.testCases.baselineRegression;
  const selected = manifest.testCases.candidateSelected;
  const affected = manifest.testCases.candidateAffectedSuites;
  const selectedRoutes = verifyWrapperRoutes(selected, "candidateSelected", { requireFullNames: true });
  const affectedRoutes = verifyWrapperRoutes(affected, "candidateAffectedSuites");
  const baselineMatcherIdentities = verifyMatcherIdentities(baseline, "baselineRegression");
  const selectedMatcherIdentities = verifyMatcherIdentities(selected, "candidateSelected");
  const wrapperMatcherIdentities = selected.wrappers.flatMap((wrapper) =>
    verifyMatcherIdentities(wrapper, "candidateSelected wrapper " + wrapper.id),
  );
  const selectedNames = [...selectedRoutes.fullNames].sort();
  const selectedEntrypoints = [...selectedRoutes.entrypoints].sort();
  const affectedEntrypoints = [...affectedRoutes.entrypoints].sort();
  if (
    !Array.isArray(baseline.entrypoints) ||
    baseline.entrypoints.length !== 1 ||
    baseline.fullNames.length !== 1 ||
    baseline.expectedSelectedCount !== 1 ||
    baseline.expectedTotalTestSuites !== 2 ||
    baseline.expectedPassedTestSuites !== 0 ||
    baseline.expectedFailedTestSuites !== 2 ||
    baseline.expectedPendingTestSuites !== 0 ||
    baseline.config !== expectedVitestOwnerConfig(baseline.entrypoints[0]) ||
    selected.fullNames.length === 0 ||
    selected.expectedSelectedCount !== selected.fullNames.length ||
    new Set(selected.fullNames).size !== selected.fullNames.length ||
    JSON.stringify(selectedNames) !== JSON.stringify([...selected.fullNames].sort()) ||
    baselineMatcherIdentities.length !== baseline.expectedSelectedCount ||
    selectedMatcherIdentities.length !== selected.expectedSelectedCount ||
    JSON.stringify([...wrapperMatcherIdentities.map((identity) => identity.reporterFullName)].sort()) !==
      JSON.stringify([...selected.fullNames].sort()) ||
    !selected.fullNames.includes(baseline.fullNames[0]) ||
    JSON.stringify(selectedEntrypoints) !== JSON.stringify([...selected.entrypoints].sort()) ||
    JSON.stringify([...selected.entrypoints].sort()) !== JSON.stringify([...affected.entrypoints].sort()) ||
    JSON.stringify(affectedEntrypoints) !== JSON.stringify([...affected.expectedSuites].sort()) ||
    affected.minimumTests < 1
  ) {
    fail("named regression identities, owner routes, and selected counts are inconsistent");
  }
  const stripeSpecs = manifest.changedChecks.coreTestGraphPrequalificationStripes;
  const stripeGraphSlices = Array.isArray(stripeSpecs)
    ? stripeSpecs.map((spec) => {
        const match = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(spec);
        if (!match || Number(match[2]) !== stripeSpecs.length) {
          return [];
        }
        const stripe = Number(match[1]);
        return canonicalCoreTestGraphs.filter((_, index) => index % stripeSpecs.length === stripe - 1);
      })
    : [];
  const stripeUnion = stripeGraphSlices.flat();
  if (
    !Array.isArray(manifest.changedChecks.coreTestGraphNames) ||
    JSON.stringify(manifest.changedChecks.coreTestGraphNames) !==
      JSON.stringify(canonicalCoreTestGraphs) ||
    manifest.changedChecks.coreTestGraphConcurrency !== 1 ||
    JSON.stringify(stripeSpecs) !== JSON.stringify(["1/3", "2/3", "3/3"]) ||
    stripeGraphSlices.some((slice) => slice.length !== 9) ||
    stripeUnion.length !== canonicalCoreTestGraphs.length ||
    new Set(stripeUnion).size !== canonicalCoreTestGraphs.length ||
    JSON.stringify([...stripeUnion].sort()) !== JSON.stringify([...canonicalCoreTestGraphs].sort()) ||
    manifest.changedChecks.coreTestGraphMaximumDurationMs !== 20 * 60 * 1000
  ) {
    fail("changed-check graph prequalification does not retain three disjoint serial stripes, exact 27-graph coverage, and normal runner bounds");
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
    baselineReporterQualification: {
      totalSuites: baseline.expectedTotalTestSuites,
      passedSuites: baseline.expectedPassedTestSuites,
      failedSuites: baseline.expectedFailedTestSuites,
      pendingSuites: baseline.expectedPendingTestSuites,
      exactFailedAssertionCount: baseline.expectedSelectedCount,
    },
    changedCheckGraphCoverage: {
      canonicalCoreTestGraphs,
      prequalificationConcurrencyPerStripe: manifest.changedChecks.coreTestGraphConcurrency,
      prequalificationStripeSpecs: stripeSpecs,
      prequalificationStripeGraphSlices: Object.fromEntries(
        stripeSpecs.map((stripe, index) => [stripe, stripeGraphSlices[index]]),
      ),
      normalPerCommandMaximumDurationMs:
        manifest.changedChecks.coreTestGraphMaximumDurationMs,
      prequalificationDoesNotSetSparseGuardOverride: true,
      canonicalChangedCheckStillRequired: true,
    },
    vitestMatchers: {
      baselineRegression: baseline.matcherIdentities,
      candidateSelected: selected.matcherIdentities,
      candidateSelectedWrappers: selected.wrappers.map(({ id, matcherIdentities }) => ({
        id,
        matcherIdentities,
      })),
    },
    vitestRouting: {
      baselineRegression: {
        config: baseline.config,
        entrypoints: baseline.entrypoints,
      },
      candidateSelected: selected.wrappers.map(({ id, config, entrypoints, fullNames }) => ({
        id,
        config,
        entrypoints,
        fullNames,
      })),
      candidateAffectedSuites: affected.wrappers.map(({ id, config, entrypoints }) => ({
        id,
        config,
        entrypoints,
      })),
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

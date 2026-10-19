import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertConfigWriteAllowedInCurrentMode } from "../../config/config.js";
import { createConfigIO } from "../../config/io.js";
import { resolveGatewayPort } from "../../config/paths.js";
import { withGatewayServiceOperationLock } from "../../daemon/service-operation-lock.js";
import { readInstallOwner } from "../../infra/install-owner.js";
import { readPackageName, readPackageVersion } from "../../infra/package-json.js";
import { assertNoPendingPackageActivation } from "../../infra/package-update-activation.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import { inspectImmutableInstall } from "../../infra/update-immutable-install.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import {
  inspectManagedHandoffRepairFacts,
  readManagedHandoffRepairFacts,
} from "../../infra/update-managed-service-handoff-cleanup.js";
import { captureManagedUpdateLeaseDatabaseIdentity } from "../../infra/update-managed-service-handoff-database.js";
import {
  prepareManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
} from "../../infra/update-managed-service-handoff-lease.js";
import { inspectNewerRecoveryHistory } from "../../infra/update-run-activity.js";
import {
  findActiveUpdateRun,
  getUpdateRun,
  listUpdateRuns,
} from "../../infra/update-run-reader.js";
import { isAcknowledgedAbandonedUpdateRun } from "../../infra/update-run-record.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import { assertNoPendingUpdateRecovery } from "../../infra/update-run-recovery.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  confirmGatewayReachable,
  GATEWAY_RESTART_PROBE_TIMEOUT_MS,
  resolveGatewayRestartProbeContext,
  waitForGatewayHttpReadiness,
} from "../daemon-cli/restart-health-probe.js";
import { hasCliProcessScope } from "../runtime-cleanup-scope.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";

export async function settleTerminalManagedHandoffMirrorFamily({
  installRoot,
  env,
}: {
  installRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<"not-applicable" | "not-qualified" | "settled"> {
  if (!hasCliProcessScope() || process.platform === "win32") {
    return "not-applicable";
  }
  if (!path.isAbsolute(installRoot) || path.resolve(installRoot) !== installRoot) {
    throw new Error("Terminal repair requires an absolute installed package root.");
  }
  const databasePath = resolveManagedUpdateLeaseDatabasePath();
  if (!fs.existsSync(databasePath)) {
    return "not-applicable";
  }
  const identity = captureManagedUpdateLeaseDatabaseIdentity(databasePath);
  const store = await prepareManagedHandoffLeaseStore({
    databasePath,
    existingIdentity: identity,
    serviceManagerEnv: env,
  });
  const family = store.prepareTerminalCancellationFamily(installRoot);
  if (!family) {
    return "not-applicable";
  }
  const packageIdentity = fs.statSync(installRoot, { bigint: true });
  if (
    !packageIdentity.isDirectory() ||
    (process.getuid && packageIdentity.uid !== BigInt(process.getuid())) ||
    (await readPackageName(installRoot)) !== "openclaw" ||
    (await readInstallOwner(installRoot)) ||
    (await inspectImmutableInstall(installRoot))
  ) {
    return "not-qualified";
  }
  assertConfigWriteAllowedInCurrentMode({ env });
  const canonicalRoot = resolveUpdateInstallRoot(installRoot);
  assertNoPendingPackageActivation(canonicalRoot);
  await assertUpdateRecoveryAdmission({ env });
  const statePath = resolveOpenClawStateSqlitePath(env);
  const stateIdentity = fs.statSync(statePath, { bigint: true });
  const runIds = new Set<string>();
  const repairFacts = [];
  for (const lease of family.leases) {
    const facts = await readManagedHandoffRepairFacts(lease, env);
    repairFacts.push({ lease, facts });
    for (const runId of facts.runIds) {
      runIds.add(runId);
    }
  }
  const runId = [...runIds][0];
  if (!runId || runIds.size !== 1) {
    throw new Error("Terminal cancellation repair requires one exact associated update run.");
  }
  const run = getUpdateRun(runId, { env });
  if (!run || run.phase !== "finished" || !isAcknowledgedAbandonedUpdateRun(run)) {
    throw new Error(
      "The associated update still requires native repair before custody can settle.",
    );
  }
  const assertHistory = () => {
    assertConfigWriteAllowedInCurrentMode({ env });
    const currentPackage = fs.statSync(installRoot, { bigint: true });
    if (
      currentPackage.dev !== packageIdentity.dev ||
      currentPackage.ino !== packageIdentity.ino ||
      resolveUpdateInstallRoot(installRoot) !== canonicalRoot
    ) {
      throw new Error("Installed package identity changed; custody was preserved.");
    }
    const currentState = fs.statSync(statePath, { bigint: true });
    if (
      !currentState.isFile() ||
      currentState.dev !== stateIdentity.dev ||
      currentState.ino !== stateIdentity.ino
    ) {
      throw new Error("Associated state database changed during repair; custody was preserved.");
    }
    assertNoPendingUpdateRecovery({ env });
    assertNoPendingPackageActivation(canonicalRoot);
    const history = listUpdateRuns({ limit: 100 }, { env });
    const newer = inspectNewerRecoveryHistory(run.createdAtMs, history);
    if (
      findActiveUpdateRun({ env }) ||
      newer.incomplete ||
      newer.postCoreRuns.length ||
      !isDeepStrictEqual(getUpdateRun(runId, { env }), run)
    ) {
      throw new Error("Update history changed or contains unfinished work; custody was preserved.");
    }
  };
  assertHistory();
  const config = createConfigIO({ env, observe: false, pluginValidation: "skip" });
  const snapshot = await config.readConfigFileSnapshot();
  if (!snapshot.valid) {
    throw new Error("Current configuration is invalid; custody was preserved.");
  }
  const context = await resolveGatewayRestartProbeContext(env);
  const port = resolveGatewayPort(context.config, env);
  const [gateway, http, version, buildId] = await Promise.all([
    confirmGatewayReachable({ port, ...context, env }),
    waitForGatewayHttpReadiness({
      config: context.config,
      port,
      attempts: 1,
      delayMs: 0,
      deadlineAt: performance.now() + GATEWAY_RESTART_PROBE_TIMEOUT_MS,
    }),
    readPackageVersion(installRoot),
    readBuiltGatewayBuildId(installRoot),
  ]);
  if (
    !gateway.reachable ||
    !version ||
    !buildId ||
    gateway.gatewayVersion !== version ||
    gateway.gatewayBuildId !== buildId ||
    gateway.activatedPluginErrors.length ||
    gateway.channelProbeErrors.length ||
    http.healthz !== 200 ||
    http.readyz !== 200
  ) {
    throw new Error(
      "Installed package and Gateway are not positively healthy and converged; custody was preserved.",
    );
  }
  await assertUpdateRecoveryAdmission({ env });
  const currentSnapshot = await config.readConfigFileSnapshot();
  if (!currentSnapshot.valid || currentSnapshot.hash !== snapshot.hash) {
    throw new Error("Configuration changed during terminal repair; custody was preserved.");
  }
  const currentPackage = fs.statSync(installRoot, { bigint: true });
  if (
    currentPackage.dev !== packageIdentity.dev ||
    currentPackage.ino !== packageIdentity.ino ||
    resolveUpdateInstallRoot(installRoot) !== canonicalRoot ||
    (await readPackageVersion(installRoot)) !== version ||
    (await readBuiltGatewayBuildId(installRoot)) !== buildId
  ) {
    throw new Error("Installed package changed during terminal repair; custody was preserved.");
  }
  return await withGatewayServiceOperationLock(env, async (assertNative) => {
    const assertCurrent = () => {
      assertNative();
      assertHistory();
      if (
        family.leases.some((lease) => {
          const current = store.read(lease.key);
          return current.kind !== "current" || !isDeepStrictEqual(current.lease, lease);
        })
      ) {
        throw new Error(
          "Cancellation family changed before native maintenance; custody was preserved.",
        );
      }
    };
    assertCurrent();
    const stopped = await maybeStopManagedServiceBeforeMutableUpdate({
      root: installRoot,
      updateInstallKind: "package",
      shouldRestart: true,
      jsonMode: true,
      phase: "prepare",
      retainNativeIdentity: true,
      expectedService: { serviceEnv: env },
      assertCurrent,
    });
    if (!stopped.stopped || !stopped.inspected || stopped.blockMessage) {
      throw new Error(
        stopped.blockMessage ?? "Native Gateway stop was not established; custody was preserved.",
      );
    }
    let inspected;
    for (const { lease, facts } of repairFacts) {
      inspected = await inspectManagedHandoffRepairFacts(lease, facts, inspected);
    }
    const afterStop = await config.readConfigFileSnapshot();
    if (
      !afterStop.valid ||
      afterStop.hash !== snapshot.hash ||
      (await readPackageVersion(installRoot)) !== version ||
      (await readBuiltGatewayBuildId(installRoot)) !== buildId
    ) {
      throw new Error("Installation changed during native maintenance; custody was preserved.");
    }
    family.retire(assertCurrent);
    return "settled";
  });
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installPrivateUpdateHandoffStore } from "../../../test/helpers/private-update-handoff-store.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  createManagedHandoffLeaseDatabase,
  leaseQueries,
} from "../../infra/update-managed-service-handoff-database.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import {
  acknowledgeAbandonedUpdateRun,
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
} from "../../infra/update-run-ledger.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { withCliProcessScope } from "../runtime-cleanup-scope.js";
import { settleTerminalManagedHandoffMirrorFamily } from "./update-terminal-handoff-family.js";

const probes = vi.hoisted(() => ({
  rpc: vi.fn(),
  http: vi.fn(),
  census: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("./update-command-service-maintenance.js", () => ({
  maybeStopManagedServiceBeforeMutableUpdate: probes.stop,
}));
vi.mock("../../infra/openclaw-process-census.js", () => ({
  inspectOtherOpenClawProcesses: probes.census,
}));
vi.mock("../daemon-cli/restart-health-probe.js", async (original) => ({
  ...(await original<typeof import("../daemon-cli/restart-health-probe.js")>()),
  resolveGatewayRestartProbeContext: async () => ({ config: {} }),
  confirmGatewayReachable: probes.rpc,
  waitForGatewayHttpReadiness: probes.http,
}));

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "terminal-cancellation" });
  await state.writeConfig({ plugins: { enabled: false } });
  probes.rpc.mockReset().mockResolvedValue({
    reachable: true,
    gatewayVersion: "1.0.0",
    gatewayBuildId: "same-build",
    activatedPluginErrors: [],
    channelProbeErrors: [],
  });
  probes.http.mockReset().mockResolvedValue({ healthz: 200, readyz: 200 });
  probes.census.mockReset().mockReturnValue({ matchingPids: [], unverifiedPids: [] });
  probes.stop.mockReset().mockImplementation(async ({ assertCurrent }) => {
    assertCurrent();
    return { stopped: true, inspected: true };
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await state.cleanup();
});

function seedFamily(acknowledged = true) {
  const root = state.path("package");
  const originalRoot = state.path("original");
  const temporary = state.path("lease");
  fs.mkdirSync(root, { mode: 0o700 });
  fs.mkdirSync(originalRoot, { mode: 0o700 });
  fs.mkdirSync(temporary, { mode: 0o700 });
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "1.0.0" }),
  );
  fs.writeFileSync(
    path.join(root, "dist", "build-info.json"),
    JSON.stringify({ buildId: "same-build" }),
  );
  const { databasePath } = installPrivateUpdateHandoffStore(temporary);
  const identities = Array.from({ length: 5 }, (_, index) => ({
    pid: 991101 + index,
    startIdentity: String(index + 1),
  }));
  const parent = {
    version: 2,
    helper: identities[0],
    executor: identities[0],
    action: { kind: "update", mutationProtocol: "original-cancellation-v1" },
  };
  const cancellation = {
    key: originalRoot,
    owner: "old-update",
    payload: JSON.stringify(parent),
    updatedAt: 1,
  };
  const rows = [
    {
      install_root: originalRoot,
      owner: "old-update",
      payload_json: JSON.stringify({ ...parent, version: 4, cancellation }),
      updated_at: 2,
    },
    {
      install_root: root,
      owner: "old-update",
      payload_json: JSON.stringify({ ...parent, mutationOriginal: cancellation }),
      updated_at: 1,
    },
    ...[0, 1].flatMap((index) =>
      [originalRoot, root].map((key) => ({
        install_root: `${key}/.openclaw-update-child-01234567-89ab-cdef-0123-456789abcdef-lineage-${String(index).repeat(64)}`,
        owner: "old-update",
        payload_json: JSON.stringify({
          version: 2,
          helper: identities[index * 2 + 1],
          executor: identities[index * 2 + 2],
          action: {
            kind: "update",
            ...(key === originalRoot ? { mutationProtocol: "original-cancellation-v1" } : {}),
          },
        }),
        updated_at: 3,
      })),
    ),
  ];
  const database = createManagedHandoffLeaseDatabase(databasePath);
  database(true, (db) =>
    executeSqliteQuerySync(db, leaseQueries(db).insertInto("managed_update_handoffs").values(rows)),
  );
  const run = createUpdateRun({
    trigger: "cli",
    origin: {
      driver: { ...identities[0]!, host: os.hostname() },
      previousDrivers: identities
        .slice(1)
        .map((identity) => ({ ...identity, host: os.hostname() })),
    },
  });
  finishUpdateRun(run.runId, { status: "failed", reason: "abandoned" });
  if (acknowledged) {
    acknowledgeAbandonedUpdateRun(run.runId);
  }
  const readRows = () =>
    database(
      false,
      (db) =>
        executeSqliteQuerySync(
          db,
          leaseQueries(db)
            .selectFrom("managed_update_handoffs")
            .selectAll()
            .orderBy("install_root"),
        ).rows,
    );
  const settle = () =>
    withCliProcessScope(() =>
      settleTerminalManagedHandoffMirrorFamily({ installRoot: root, env: state.env }),
    );
  return {
    root,
    originalRoot,
    rows,
    databasePath,
    database,
    readRows,
    settle,
    runId: run.runId,
    store: createManagedHandoffLeaseStore({ databasePath, serviceManagerEnv: state.env }),
  };
}

it.skipIf(process.platform === "win32")(
  "settles only the acknowledged complete family and admits a subsequent updater",
  async () => {
    const fixture = seedFamily();
    const originalRun = getUpdateRun(fixture.runId);
    expect(fixture.store.acquire(fixture.root, "blocked", { kind: "update" }).kind).toBe("busy");
    await expect(fixture.settle()).resolves.toBe("settled");
    expect(fixture.readRows()).toEqual([]);
    expect(getUpdateRun(fixture.runId)).toEqual(originalRun);
    await expect(fixture.settle()).resolves.toBe("not-applicable");
    const next = fixture.store.acquire(fixture.root, "next", { kind: "update" });
    expect(next.kind).toBe("acquired");
    if (next.kind === "acquired") {
      fixture.store.release(next.lease);
    }
  },
);

it
  .skipIf(process.platform === "win32")
  .each([
    "no acknowledgment",
    "unhealthy HTTP",
    "different build",
    "new active run",
    "missing alias",
    "replaced lease database",
    "replaced state database",
    "history beyond prefix",
    "retained repair metadata",
    "inverted alias protocol",
    "surviving orphan outside recorded groups",
    "incomplete process census",
    "native stop refused",
    "unconfirmed native stop",
    "generation changed during stop",
    "configuration changed during stop",
  ] as const)("preserves every surviving generation with %s", async (failure) => {
  const fixture = seedFamily(failure !== "no acknowledgment");
  if (failure === "native stop refused") probes.stop.mockRejectedValue(new Error("native refusal"));
  if (failure === "unconfirmed native stop")
    probes.stop.mockResolvedValue({ stopped: false, inspected: true });
  if (failure === "generation changed during stop")
    probes.stop.mockImplementation(async () => {
      fixture.database(true, (db) =>
        executeSqliteQuerySync(
          db,
          leaseQueries(db)
            .updateTable("managed_update_handoffs")
            .set({ updated_at: 99 })
            .where("install_root", "=", fixture.root),
        ),
      );
      return { stopped: true, inspected: true };
    });
  if (failure === "configuration changed during stop")
    probes.stop.mockImplementation(async () => {
      await state.writeConfig({ plugins: { enabled: false }, gateway: { port: 19999 } });
      return { stopped: true, inspected: true };
    });
  if (failure === "surviving orphan outside recorded groups")
    probes.census.mockReturnValue({ matchingPids: [991999], unverifiedPids: [] });
  if (failure === "incomplete process census")
    probes.census.mockReturnValue({
      matchingPids: [],
      unverifiedPids: [991999],
      error: "incomplete",
    });
  if (failure === "unhealthy HTTP") probes.http.mockResolvedValue({ healthz: 200, readyz: 503 });
  if (failure === "different build")
    probes.rpc.mockResolvedValue({
      reachable: true,
      gatewayVersion: "1.0.0",
      gatewayBuildId: "old-build",
      activatedPluginErrors: [],
      channelProbeErrors: [],
    });
  if (failure === "new active run")
    probes.http.mockImplementation(async () => {
      createUpdateRun({ trigger: "cli" });
      return { healthz: 200, readyz: 200 };
    });
  if (failure === "replaced lease database" || failure === "replaced state database")
    probes.http.mockImplementation(async () => {
      const databasePath =
        failure === "replaced lease database"
          ? fixture.databasePath
          : resolveOpenClawStateSqlitePath(state.env);
      fs.copyFileSync(databasePath, databasePath + ".replacement");
      fs.renameSync(databasePath + ".replacement", databasePath);
      return { healthz: 200, readyz: 200 };
    });
  if (failure === "history beyond prefix") {
    for (let index = 0; index < 101; index++) {
      const newer = createUpdateRun({ trigger: "cli" });
      finishUpdateRun(newer.runId, { status: "skipped", reason: "dry-run" });
    }
  }
  if (failure === "missing alias")
    fixture.database(true, (db) =>
      executeSqliteQuerySync(
        db,
        leaseQueries(db)
          .deleteFrom("managed_update_handoffs")
          .where("install_root", "=", fixture.rows[2]!.install_root),
      ),
    );
  if (failure === "retained repair metadata")
    fixture.database(true, (db) =>
      executeSqliteQuerySync(
        db,
        leaseQueries(db)
          .updateTable("managed_update_handoffs")
          .set({ recovery_json: '{"version":99}' })
          .where("install_root", "=", fixture.root),
      ),
    );
  if (failure === "inverted alias protocol") {
    const payload = JSON.parse(fixture.rows[2]!.payload_json);
    delete payload.action.mutationProtocol;
    fixture.database(true, (db) =>
      executeSqliteQuerySync(
        db,
        leaseQueries(db)
          .updateTable("managed_update_handoffs")
          .set({ payload_json: JSON.stringify(payload) })
          .where("install_root", "=", fixture.rows[2]!.install_root),
      ),
    );
  }
  let retained = fixture.readRows();
  if (failure === "generation changed during stop")
    retained = retained.map((row) =>
      row.install_root === fixture.root ? { ...row, updated_at: 99 } : row,
    );
  await expect(fixture.settle()).rejects.toThrow();
  expect(fixture.readRows()).toEqual(retained);
});

it.skipIf(process.platform === "win32")(
  "preserves custody when an older active update is outside the history prefix",
  async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now - 200_000);
    createUpdateRun({ trigger: "cli" });
    for (let index = 0; index < 101; index++) {
      clock.mockReturnValue(now - 100_000 + index);
      const run = createUpdateRun({ trigger: "cli" });
      finishUpdateRun(run.runId, { status: "skipped", reason: "dry-run" });
    }
    clock.mockRestore();
    const fixture = seedFamily();
    const retained = fixture.readRows();
    await expect(fixture.settle()).rejects.toThrow("unfinished work");
    expect(fixture.readRows()).toEqual(retained);
  },
);

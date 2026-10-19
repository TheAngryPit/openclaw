import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import {
  assertManagedHandoffTestConsumer,
  createManagedHandoffTestBinding,
} from "../../test/helpers/managed-handoff-isolation.js";
import {
  installPrivateUpdateHandoffStore,
  writePrivateUpdateHandoffChildGuard,
} from "../../test/helpers/private-update-handoff-store.js";
import {
  captureUpdateCommandExecutorAuthority,
  requestUpdateCommandExecutorCancellation,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import * as processGroups from "../process/child-process-tree.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as processIdentity from "../shared/pid-alive.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import { createManagedCommandProcessCustody } from "./update-managed-command-custody.js";
import {
  createManagedHandoffLeaseDatabase,
  leaseQueries,
} from "./update-managed-service-handoff-database.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "handoff-reclamation-")));
  roots.push(root);
  const make = (name: string) => {
    const directory = path.join(root, name);
    fs.mkdirSync(directory, { mode: 0o700 });
    return directory;
  };
  const install = make("install");
  const slot = path.join(root, "linked-install");
  fs.symlinkSync(install, slot, process.platform === "win32" ? "junction" : "dir");
  const privateTmp = make("private-tmp");
  const state = make("state");
  const { databasePath: handoff } = installPrivateUpdateHandoffStore(privateTmp);
  const binding = createManagedHandoffTestBinding(privateTmp);
  const childEnv = writePrivateUpdateHandoffChildGuard(handoff, privateTmp);
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("OPENCLAW_STATE_DIR", state);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(state, "openclaw.json"));
  const env = childEnv({
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
  });
  const store = createManagedHandoffLeaseStore({ databasePath: handoff, serviceManagerEnv: env });
  const child = path.join(root, "original-owner.mts");
  const executorUrl = new URL("../cli/update-cli/update-command-executor.ts", import.meta.url).href;
  const leaseUrl = new URL("./update-managed-service-handoff-lease.ts", import.meta.url).href;
  const crash = (mode: "ordinary" | "cancelled" = "ordinary", holderPid?: number) => {
    fs.writeFileSync(
      child,
      `
import { createRequire } from "node:module";
createRequire(import.meta.url)(${JSON.stringify(path.join(privateTmp, "private-handoff-guard.cjs"))});
const { withUpdateCommandExecutor, requestUpdateCommandExecutorCancellation } = await import(${JSON.stringify(executorUrl)});
const { createManagedHandoffLeaseStore } = await import(${JSON.stringify(leaseUrl)});
const runId = ${JSON.stringify(randomUUID())};
await withUpdateCommandExecutor(runId, async (executor) => {
  const fence = await executor.enter(${JSON.stringify(slot)});
  if (${JSON.stringify(holderPid ?? null)} !== null) {
    const store = createManagedHandoffLeaseStore({databasePath:${JSON.stringify(handoff)},serviceManagerEnv:process.env});
    const current = store.read(${JSON.stringify(slot)});
    if (current.kind !== "current" || !store.bind(current.lease, ${JSON.stringify(holderPid ?? 0)})) { throw new Error("Fixture slot binding failed"); }
  }
  if (${JSON.stringify(mode)} === "cancelled") requestUpdateCommandExecutorCancellation(fence, runId, new Error("original cancellation"));
  process.kill(process.pid, "SIGKILL");
});
`,
    );
    const result = spawnSync(
      resolveTestNodeExecPath(),
      ["--import", "tsx", binding.nodeOption, child],
      {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        env,
        encoding: "utf8",
        timeout: 10_000,
        killSignal: "SIGKILL",
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBe("SIGKILL");
    assertManagedHandoffTestConsumer(binding, result.pid, path.resolve("src"));
    const original = store.read(install),
      occupied = store.read(slot);
    expect(original.kind).toBe("current");
    expect(occupied.kind).toBe("current");
    if (original.kind !== "current" || occupied.kind !== "current") {
      throw new Error("Missing crash pair");
    }
    expect(occupied.lease.version).toBe(2);
    if (occupied.lease.version !== 2) {
      throw new Error("Unexpected occupied-slot format");
    }
    expect(occupied.lease.mutationOriginal?.key).toBe(install);
    return { original, occupied };
  };
  const retry = () =>
    withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(slot);
      fence.assertCurrent();
      const original = store.read(install),
        occupied = store.read(slot);
      expect(original.kind).toBe("current");
      expect(occupied.kind).toBe("current");
      if (original.kind !== "current" || occupied.kind !== "current") {
        throw new Error("Missing new pair");
      }
      expect(original.lease.helper.pid).toBe(process.pid);
      expect(occupied.lease.owner).toBe(original.lease.owner);
      expect(store.current(original.lease)).toBe(true);
      expect(store.current(occupied.lease)).toBe(true);
    });
  return { root, install, slot, handoff, store, env, crash, retry };
}

it("preserves both old generations while the occupied slot still has a live executor", async () => {
  const f = fixture();
  const holder = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    env: f.env,
    stdio: ["pipe", "ignore", "pipe"],
  });
  const closed = once(holder, "close");
  try {
    await once(holder, "spawn");
    if (!holder.pid) {
      throw new Error("Missing holder pid");
    }
    const before = f.crash("ordinary", holder.pid);
    await expect(f.retry()).rejects.toThrow("Another update executor");
    expect(f.store.read(f.install)).toEqual(before.original);
    expect(f.store.read(f.slot)).toEqual(before.occupied);
  } finally {
    holder.kill("SIGKILL");
    await closed;
  }
  await f.retry();
  expect(f.store.read(f.install).kind).toBe("absent");
  expect(f.store.read(f.slot).kind).toBe("absent");
});

it("does not reclaim original cancellation custody after the process dies", async () => {
  const f = fixture();
  const before = f.crash("cancelled");
  expect(before.original.lease.version).toBe(4);
  await expect(f.retry()).rejects.toThrow("Another update executor");
  expect(f.store.read(f.install)).toEqual(before.original);
  expect(f.store.read(f.slot)).toEqual(before.occupied);
});

it.skipIf(process.platform === "win32")(
  "settles live original cancellation custody after its bound native command joins",
  async () => {
    const f = fixture();
    const runId = randomUUID();
    const cancellation = new Error("cancel original update");
    const ready = createDeferredCore<void>();
    const execution = withUpdateCommandExecutor(runId, async (executor) => {
      const fence = await executor.enter(f.slot);
      const authority = captureUpdateCommandExecutorAuthority(fence, runId);
      const original = f.store.read(f.install);
      const occupied = f.store.read(f.slot);
      if (original.kind !== "current" || occupied.kind !== "current") {
        throw new Error("Original and occupied-slot owners were not admitted");
      }
      expect(original.lease.action).toMatchObject({
        kind: "update",
        mutationProtocol: "original-cancellation-v1",
      });
      expect(occupied.lease.mutationOriginal).toMatchObject({ key: f.install });

      const native = await createManagedCommandProcessCustody({
        roots: [f.install, f.slot],
        runId,
        databasePath: authority.databasePath,
        databaseIdentity: authority,
        parents: [original.lease, occupied.lease],
        assertCurrent: fence.assertCurrent,
      });
      const socket = path.join(f.root, "c.sock");
      try {
        const result = await withCommandProcessScope(
          async () => {
            const command = runUtf8CommandWithTimeout(
              [
                resolveTestNodeExecPath(),
                "-e",
                `const server=require("node:net").createServer(); process.once("SIGTERM",()=>server.close(()=>process.exit(0))); server.listen(${JSON.stringify(socket)},()=>process.stdout.write("ready\\n"));`,
              ],
              {
                killProcessTree: true,
                requireProcessTreeExtinction: true,
                onOutputChunk(chunk) {
                  if (chunk.toString("utf8").includes("ready")) {
                    ready.resolve();
                  }
                },
              },
            );
            void command.then(
              () => ready.reject(new Error("Native command exited before cancellation")),
              (error: unknown) => ready.reject(error),
            );
            await ready.promise;

            const commands = f.store.readCommandChildren([f.install, f.slot]);
            expect(commands).toHaveLength(2);
            expect(
              commands.every(
                (entry) => entry.action.kind === "update" && entry.action.custody === "bound",
              ),
            ).toBe(true);
            expect(
              commands.every((entry) => f.store.isProcessIdentityCurrent(entry.executor)),
            ).toBe(true);

            requestUpdateCommandExecutorCancellation(fence, runId, cancellation);
            expect(f.store.read(f.install)).toMatchObject({
              kind: "current",
              lease: { version: 4 },
            });
            expect(f.store.read(f.slot)).toMatchObject({
              kind: "current",
              lease: { version: 2, mutationOriginal: { key: f.install } },
            });
            expect(f.store.readCommandChildren([f.install, f.slot])).toEqual(commands);

            const commandResult = await command;
            expect(commandResult).toMatchObject({ termination: "signal", cleanup: "cooperative" });
            expect(f.store.readCommandChildren([f.install, f.slot])).toEqual([]);
            expect(f.store.read(f.install)).toMatchObject({
              kind: "current",
              lease: { version: 4 },
            });
            expect(f.store.read(f.slot)).toMatchObject({ kind: "current", lease: { version: 2 } });
            return commandResult;
          },
          undefined,
          native.custody,
        );
        expect(result).toMatchObject({ termination: "signal", cleanup: "cooperative" });
      } finally {
        native.releaseAnchors();
        fs.rmSync(socket, { force: true });
      }
    });

    await expect(execution).rejects.toBe(cancellation);
    expect(f.store.read(f.install).kind).toBe("absent");
    expect(f.store.read(f.slot).kind).toBe("absent");
    const next = f.store.acquire(f.install, "next-update", { kind: "update" });
    expect(next.kind).toBe("acquired");
    if (next.kind === "acquired") {
      expect(f.store.release(next.lease)).toBe(true);
    }
  },
);

it.each(["release", "releaseAll"] as const)(
  "%s preserves an original until its exact occupied generation settles",
  (method) => {
    const f = fixture();
    const store = createManagedHandoffLeaseStore({
      databasePath: f.handoff,
      serviceManagerEnv: f.env,
      originalUpdateKey: f.install,
    });
    const original = store.acquire(f.install, "original", { kind: "update" });
    if (original.kind !== "acquired") {
      throw new Error("Original acquisition failed");
    }
    const occupied = store.acquire(
      f.slot,
      "original",
      { kind: "update" },
      false,
      undefined,
      original.lease,
    );
    if (occupied.kind !== "acquired") {
      throw new Error("Occupied acquisition failed");
    }
    const beforeOriginal = store.read(f.install);
    const beforeOccupied = store.read(f.slot);
    expect(
      method === "release" ? store.release(original.lease) : store.releaseAll([original.lease]),
    ).toBe(false);
    expect(store.read(f.install)).toEqual(beforeOriginal);
    expect(store.read(f.slot)).toEqual(beforeOccupied);
    expect(store.current(original.lease)).toBe(true);
    expect(store.current(occupied.lease)).toBe(true);
    expect(store.acquire(f.install, "contender", { kind: "update" }).kind).toBe("busy");

    const rebound = store.bind(occupied.lease, process.pid);
    if (!rebound) {
      throw new Error("Occupied rebinding failed");
    }
    expect(store.releaseAll([original.lease, occupied.lease])).toBe(false);
    expect(store.read(f.install)).toEqual(beforeOriginal);
    expect(store.current(rebound)).toBe(true);
    expect(store.releaseAll([original.lease, rebound])).toBe(true);
    expect(store.read(f.install).kind).toBe("absent");
    expect(store.read(f.slot).kind).toBe("absent");
    const next = store.acquire(f.install, "next", { kind: "update" });
    expect(next.kind).toBe("acquired");
    if (next.kind !== "acquired") {
      throw new Error("Next generation acquisition failed");
    }
    expect(store.release(next.lease)).toBe(true);
  },
);

it.skipIf(process.platform === "win32")(
  "retires the exact terminal original/mirror family from its selected mirror root",
  () => {
    const f = fixture();
    const retained = f.crash("cancelled");
    const descendants = [
      {
        name: "01234567-89ab-cdef-0123-456789abcdef-lineage-" + "a".repeat(64),
        helper: { pid: 771101, startIdentity: "101" },
        executor: { pid: 771102, startIdentity: "102" },
      },
      {
        name: "01234567-89ab-cdef-0123-456789abcdef-lineage-" + "b".repeat(64),
        helper: { pid: 771103, startIdentity: "103" },
        executor: { pid: 771104, startIdentity: "104" },
      },
    ];
    const database = createManagedHandoffLeaseDatabase(f.handoff);
    database(true, (db) =>
      executeSqliteQuerySync(
        db,
        leaseQueries(db)
          .insertInto("managed_update_handoffs")
          .values(
            descendants.flatMap((child) =>
              [f.install, f.slot].map((root) => ({
                install_root: `${root}/.openclaw-update-child-${child.name}`,
                owner: retained.original.lease.owner,
                payload_json: JSON.stringify({
                  version: 2,
                  helper: child.helper,
                  executor: child.executor,
                  action: {
                    kind: "update",
                    ...(root === f.install ? { mutationProtocol: "original-cancellation-v1" } : {}),
                  },
                }),
                updated_at: 3,
              })),
            ),
          ),
      ),
    );
    const dead = processIdentity.isPidDefinitelyDead;
    vi.spyOn(processIdentity, "isPidDefinitelyDead").mockImplementation((pid) =>
      descendants.some((child) => [child.helper.pid, child.executor.pid].includes(pid))
        ? true
        : dead(pid),
    );
    const groupAlive = processGroups.isChildProcessTreeAlive;
    vi.spyOn(processGroups, "isChildProcessTreeAlive").mockImplementation((child) =>
      descendants.some((entry) => entry.executor.pid === child.pid) ? false : groupAlive(child),
    );
    const terminal = f.store.prepareTerminalCancellationFamily(f.slot);
    expect(terminal).not.toBeNull();
    terminal!.retire(() => undefined);
    expect(f.store.read(f.install)).toEqual({ kind: "absent" });
    expect(f.store.read(f.slot)).toEqual({ kind: "absent" });
    for (const child of descendants) {
      for (const root of [f.install, f.slot]) {
        expect(f.store.read(`${root}/.openclaw-update-child-${child.name}`)).toEqual({
          kind: "absent",
        });
      }
    }
    const next = f.store.acquire(f.slot, "next-update", { kind: "update" });
    expect(next.kind).toBe("acquired");
  },
);

function retainedCommandFixture(
  options: {
    mirror?: boolean;
    orphan?: boolean;
    custody?: "reserved" | "bound";
    helper?: "dead" | "live" | "unknown";
    groupAlive?: boolean;
  } = {},
) {
  const f = fixture();
  const database = createManagedHandoffLeaseDatabase(f.handoff);
  const rootIdentity = { pid: 777101, startIdentity: "1" };
  const helper = { pid: 777102, startIdentity: "2" };
  const executor = { pid: 777103, startIdentity: "3" };
  const rootLease = {
    version: 2,
    helper: rootIdentity,
    executor: rootIdentity,
    action: {
      kind: "update",
      ...(options.mirror ? { mutationProtocol: "original-cancellation-v1" } : {}),
    },
  };
  const rootPayload = JSON.stringify(rootLease);
  const original = {
    install_root: f.install,
    owner: "previous-update",
    payload_json: rootPayload,
    updated_at: 1,
  };
  const parents = options.orphan ? [] : [original];
  if (options.mirror) {
    parents.push({
      ...original,
      install_root: f.slot,
      payload_json: JSON.stringify({
        ...rootLease,
        mutationOriginal: {
          key: f.install,
          owner: original.owner,
          payload: rootPayload,
          updatedAt: original.updated_at,
        },
      }),
    });
  }
  const commandKeys = [f.install, ...(options.mirror ? [f.slot] : [])].map(
    (root) => `${root}/.openclaw-update-child-previous-doctor/.openclaw-update-child-command`,
  );
  database(true, (db) => {
    executeSqliteQuerySync(
      db,
      leaseQueries(db)
        .insertInto("managed_update_handoffs")
        .values([
          ...parents,
          ...commandKeys.map((install_root) => ({
            install_root,
            owner: "previous-doctor",
            payload_json: JSON.stringify({
              version: 2,
              helper,
              executor,
              action: { kind: "update", custody: options.custody ?? "bound" },
            }),
            updated_at: 2,
          })),
        ]),
    );
  });
  const isDead = processIdentity.isPidDefinitelyDead;
  const readStart = processIdentity.getFileLockProcessStartTime;
  vi.spyOn(processIdentity, "isPidDefinitelyDead").mockImplementation((pid) =>
    pid === rootIdentity.pid || pid === executor.pid
      ? true
      : pid === helper.pid
        ? !options.helper || options.helper === "dead"
        : isDead(pid),
  );
  vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockImplementation((pid, env) =>
    pid === helper.pid ? (options.helper === "unknown" ? null : 2) : readStart(pid, env),
  );
  const groupAlive = processGroups.isChildProcessTreeAlive;
  vi.spyOn(processGroups, "isChildProcessTreeAlive").mockImplementation((child) =>
    child.pid === executor.pid ? (options.groupAlive ?? false) : groupAlive(child),
  );
  const rows = () =>
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
  return { ...f, database, rows, commandKeys, helper };
}

it.skipIf(process.platform === "win32").each([
  { name: "ordinary root", mirror: false, orphan: false },
  { name: "original and occupied slot", mirror: true, orphan: false },
  { name: "orphaned command namespace", mirror: false, orphan: true },
])("retires dead command claims when reopening $name", ({ mirror, orphan }) => {
  const f = retainedCommandFixture({ mirror, orphan });
  const before = f.rows();
  expect(before.some((row) => f.commandKeys.includes(row.install_root))).toBe(true);
  // Reads must not silently prune durable custody before a mutation owner admits repair.
  f.store.read(f.install);
  expect(f.rows()).toEqual(before);
  const repaired = f.store.acquire(f.install, "repair", { kind: "update" });
  expect(repaired.kind).toBe("acquired");
  if (repaired.kind !== "acquired") {
    throw new Error("Expected repaired installation admission");
  }
  expect(f.rows().map((row) => row.install_root)).toEqual([f.install]);
  expect(f.store.release(repaired.lease)).toBe(true);
  expect(f.rows()).toEqual([]);
  const reopenedStore = createManagedHandoffLeaseStore({
    databasePath: f.handoff,
    serviceManagerEnv: f.env,
  });
  const reopened = reopenedStore.acquire(f.install, "next-update", { kind: "update" });
  expect(reopened.kind).toBe("acquired");
  if (reopened.kind === "acquired") {
    expect(reopenedStore.release(reopened.lease)).toBe(true);
  }
});

it.skipIf(process.platform === "win32").each([
  { name: "pending reservation", custody: "reserved" as const },
  { name: "live helper", helper: "live" as const },
  { name: "unverified helper", helper: "unknown" as const },
  { name: "surviving command group", groupAlive: true },
])("preserves every retained row beside a $name", (options) => {
  const f = retainedCommandFixture(options);
  const before = f.rows();
  expect(f.store.acquire(f.install, "repair", { kind: "update" }).kind).toBe("busy");
  expect(f.rows()).toEqual(before);
});

it.skipIf(process.platform === "win32")(
  "refuses reclamation when a command generation changes after observation",
  () => {
    const f = retainedCommandFixture();
    const rootBefore = f.store.read(f.install);
    const isDead = vi.mocked(processIdentity.isPidDefinitelyDead).getMockImplementation();
    if (!isDead) {
      throw new Error("Missing process observation fixture");
    }
    let replaced = false;
    vi.spyOn(processIdentity, "isPidDefinitelyDead").mockImplementation((pid) => {
      if (pid === f.helper.pid && !replaced) {
        replaced = true;
        f.database(true, (db) => {
          executeSqliteQuerySync(
            db,
            leaseQueries(db)
              .updateTable("managed_update_handoffs")
              .set({ owner: "replacement-doctor", updated_at: 3 })
              .where("install_root", "=", f.commandKeys[0]!),
          );
        });
      }
      return isDead(pid);
    });
    expect(f.store.acquire(f.install, "repair", { kind: "update" }).kind).toBe("busy");
    expect(replaced).toBe(true);
    expect(f.store.read(f.install)).toEqual(rootBefore);
    expect(f.rows().find((row) => row.install_root === f.commandKeys[0])).toMatchObject({
      owner: "replacement-doctor",
      updated_at: 3,
    });
  },
);

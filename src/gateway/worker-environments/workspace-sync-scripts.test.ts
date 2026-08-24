import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  REMOTE_WORKSPACE_QUIESCE_JS,
  REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
  REMOTE_WORKSPACE_RESUME_JS,
} from "./workspace-quiescence-scripts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function fixture() {
  const root = tempDirs.make("openclaw-quiescence-test-");
  const home = path.join(root, "home");
  let workspace = path.join(root, "workspace");
  const bin = path.join(root, "bin");
  const extraProcessPath = path.join(root, "extra-process.txt");
  await fs.mkdir(home);
  await fs.mkdir(workspace);
  workspace = await fs.realpath(workspace);
  await fs.mkdir(bin);
  await fs.writeFile(
    path.join(bin, "ps"),
    '#!/bin/sh\ncase "$*" in\n  *"stat=,lstart= -p"*|*"lstart= -p"*) exec /bin/ps "$@" ;;\n  *) printf "%s %s %s S Tue Jul 15 08:00:00 2026\\n" "$$" "$PPID" "$(id -u)"; if [ -f "$OPENCLAW_TEST_PS_EXTRA" ]; then extra_pid=$(cat "$OPENCLAW_TEST_PS_EXTRA"); /bin/ps -o pid=,ppid=,uid=,stat=,lstart= -p "$extra_pid" || true; fi ;;\nesac\n',
  );
  await fs.chmod(path.join(bin, "ps"), 0o755);
  return {
    bin,
    home,
    workspace,
    extraProcessPath,
    env: {
      ...process.env,
      HOME: home,
      OPENCLAW_TEST_PS_EXTRA: extraProcessPath,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    },
  };
}

async function quiesce(
  input: Awaited<ReturnType<typeof fixture>>,
  sharedHost = false,
  watchdogTimeoutMs = "10000",
) {
  const result = await runCommandWithTimeout(
    [
      process.execPath,
      "-e",
      REMOTE_WORKSPACE_QUIESCE_JS,
      input.workspace,
      watchdogTimeoutMs,
      sharedHost ? "shared-host" : "dedicated",
    ],
    { timeoutMs: 10_000, baseEnv: input.env },
  );
  expect(result.code).toBe(0);
  const match = /^quiesced ([a-f0-9]{32})\n$/u.exec(result.stdout);
  expect(match).not.toBeNull();
  if (sharedHost) {
    expect(result.stderr).toContain("shared host declared; skipping process freeze sweep");
  }
  return match![1]!;
}

function leasePath(home: string, workspace: string, nonce: string) {
  const key = createHash("sha256").update(workspace).digest("hex");
  return path.join(home, ".openclaw-worker", "quiescence", `${key}.${nonce}.json`);
}

function windowsSharedLeasePath(home: string, workspace: string) {
  const key = createHash("sha256").update(workspace).digest("hex");
  return path.join(home, ".openclaw-worker", "quiescence", `${key}.shared-host.json`);
}

// Absolute /bin/ps so the fixture's stubbed PATH entry cannot answer for the real host.
async function processState(pid: number) {
  const result = await runCommandWithTimeout(["/bin/ps", "-o", "stat=", "-p", String(pid)], {
    timeoutMs: 5_000,
  });
  return result.stdout.trim();
}

async function waitForProcessState(pid: number, pattern: RegExp) {
  let state = await processState(pid);
  for (let attempt = 0; attempt < 250 && !pattern.test(state); attempt += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    state = await processState(pid);
  }
  return state;
}

// A ps that ignores SIGTERM: execFileSync's timeout signals and then waits for the child, so
// only a killable probe stays bounded against this shape.
const STALLED_PS =
  '#!/bin/sh\ntrap \'\' TERM\ncase "$*" in\n  *"lstart= -p"*) while true; do sleep 1; done ;;\n  *) exit 1 ;;\nesac\n';

function spawnIdleWorker() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  expect(child.pid).toBeDefined();
  return child;
}

async function stopIdleWorker(child: ReturnType<typeof spawnIdleWorker>) {
  child.kill("SIGCONT");
  child.kill("SIGTERM");
  if (child.exitCode === null) {
    await once(child, "exit");
  }
}

async function resume(input: Awaited<ReturnType<typeof fixture>>, nonce: string) {
  const result = await runCommandWithTimeout(
    [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
    { timeoutMs: 10_000, baseEnv: input.env },
  );
  expect(result.code).toBe(0);
}

async function renew(
  input: Awaited<ReturnType<typeof fixture>>,
  nonce: string,
  sharedHost = false,
) {
  const result = await runCommandWithTimeout(
    [
      process.execPath,
      "-e",
      REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
      input.workspace,
      nonce,
      "20000",
      "final",
      sharedHost ? "shared-host" : "dedicated",
    ],
    { timeoutMs: 10_000, baseEnv: input.env },
  );
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`renewed ${nonce}\n`);
}

describe("remote workspace quiescence scripts", () => {
  it.runIf(process.platform === "win32")(
    "uses a process-free shared-host lease on Windows",
    async () => {
      const root = tempDirs.make("openclaw-windows-quiescence-test-");
      const home = path.join(root, "home");
      const workspace = path.join(root, "workspace");
      await fs.mkdir(home);
      await fs.mkdir(workspace);
      const environment = { ...process.env, HOME: home, USERPROFILE: home };

      const quiesced = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_QUIESCE_JS, workspace, "20000", "shared-host"],
        { timeoutMs: 10_000, baseEnv: environment },
      );
      expect(quiesced.code).toBe(0);
      const nonce = /^quiesced ([a-f0-9]{32})\n$/u.exec(quiesced.stdout)?.[1];
      expect(nonce).toBeDefined();
      const leaseFile = windowsSharedLeasePath(home, await fs.realpath(workspace));
      await expect(fs.readFile(leaseFile, "utf8")).resolves.toContain('"sharedHost":true');

      const overlapping = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_QUIESCE_JS, workspace, "20000", "shared-host"],
        { timeoutMs: 10_000, baseEnv: environment },
      );
      expect(overlapping.code).not.toBe(0);
      expect(overlapping.stderr).toContain("workspace quiescence lease is already active");

      const renewed = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
          workspace,
          nonce!,
          "20000",
          "final",
          "shared-host",
        ],
        { timeoutMs: 10_000, baseEnv: environment },
      );
      expect(renewed.code).toBe(0);
      expect(renewed.stdout).toBe(`renewed ${nonce}\n`);

      await expect(
        runCommandWithTimeout(
          [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, workspace, nonce!],
          { timeoutMs: 10_000, baseEnv: environment },
        ),
      ).resolves.toMatchObject({ code: 0 });
      await expect(fs.access(leaseFile)).rejects.toThrow();

      await fs.mkdir(path.dirname(leaseFile), { recursive: true });
      await fs.writeFile(
        leaseFile,
        JSON.stringify({
          version: 1,
          nonce: "d".repeat(32),
          sharedHost: true,
          processes: [],
          watchdog: null,
          expiresAtMs: 1,
        }),
      );
      const simultaneous = await Promise.all([
        runCommandWithTimeout(
          [process.execPath, "-e", REMOTE_WORKSPACE_QUIESCE_JS, workspace, "20000", "shared-host"],
          { timeoutMs: 10_000, baseEnv: environment },
        ),
        runCommandWithTimeout(
          [process.execPath, "-e", REMOTE_WORKSPACE_QUIESCE_JS, workspace, "20000", "shared-host"],
          { timeoutMs: 10_000, baseEnv: environment },
        ),
      ]);
      expect(simultaneous.filter((result) => result.code === 0)).toHaveLength(1);
      const loser = simultaneous.find((result) => result.code !== 0);
      expect(loser?.stderr).toContain("workspace quiescence lease is already active");
      const winner = simultaneous.find((result) => result.code === 0)!;
      const winnerNonce = /^quiesced ([a-f0-9]{32})\n$/u.exec(winner.stdout)?.[1];
      expect(winnerNonce).toBeDefined();
      await expect(
        runCommandWithTimeout(
          [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, workspace, winnerNonce!],
          { timeoutMs: 10_000, baseEnv: environment },
        ),
      ).resolves.toMatchObject({ code: 0 });
      const lockFiles = (await fs.readdir(path.dirname(leaseFile))).filter((name) =>
        name.endsWith(".sqlite"),
      );
      expect(lockFiles).toEqual(["windows-shared-host.lock.sqlite"]);

      const dedicated = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_QUIESCE_JS, workspace, "20000", "dedicated"],
        { timeoutMs: 10_000, baseEnv: environment },
      );
      expect(dedicated.code).not.toBe(0);
      expect(dedicated.stderr).toContain("workspace quiescence requires POSIX");
    },
  );

  it("excludes its ps scanner and terminates its watchdog on resume", async () => {
    const input = await fixture();
    const nonce = await quiesce(input);
    const lease = JSON.parse(
      await fs.readFile(leasePath(input.home, input.workspace, nonce), "utf8"),
    ) as {
      watchdog: { pid: number; start: string };
    };

    await resume(input, nonce);

    await expect(fs.access(leasePath(input.home, input.workspace, nonce))).rejects.toThrow();
    await vi.waitFor(() => {
      expect(() => process.kill(lease.watchdog.pid, 0)).toThrow();
    });
  });

  it("recovers a prior nonce without letting its watchdog own the next lease", async () => {
    const input = await fixture();
    const firstNonce = await quiesce(input, false, "1000");
    const firstLease = JSON.parse(
      await fs.readFile(leasePath(input.home, input.workspace, firstNonce), "utf8"),
    ) as { watchdog: { pid: number; start: string } };

    const secondNonce = await quiesce(input);

    expect(secondNonce).not.toBe(firstNonce);
    await expect(fs.access(leasePath(input.home, input.workspace, firstNonce))).rejects.toThrow();
    await expect(
      fs.access(leasePath(input.home, input.workspace, secondNonce)),
    ).resolves.toBeUndefined();
    await vi.waitFor(
      () => {
        expect(() => process.kill(firstLease.watchdog.pid, 0)).toThrow();
      },
      { timeout: 5_000 },
    );
    await resume(input, secondNonce);
  });

  it("proves the lease is active and renews its watchdog deadline", async () => {
    const input = await fixture();
    const nonce = await quiesce(input);
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const before = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      expiresAtMs: number;
      watchdog: { pid: number; start: string };
    };

    await renew(input, nonce);

    const after = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      expiresAtMs: number;
      watchdog: { pid: number; start: string };
    };
    expect(after.expiresAtMs).toBeGreaterThan(before.expiresAtMs);
    expect(after.watchdog).toEqual(before.watchdog);
    expect(() => process.kill(after.watchdog.pid, 0)).not.toThrow();
    await resume(input, nonce);
  });

  it("stops a writable process that appeared after the workspace was quiesced", async () => {
    const input = await fixture();
    const nonce = await quiesce(input);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    expect(child.pid).toBeDefined();
    await fs.writeFile(input.extraProcessPath, `${child.pid}\n`);

    const heartbeat = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
        input.workspace,
        nonce,
        "20000",
        "heartbeat",
      ],
      { timeoutMs: 10_000, baseEnv: input.env },
    );
    expect(heartbeat.code).toBe(0);

    try {
      const result = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS, input.workspace, nonce],
        { timeoutMs: 10_000, baseEnv: input.env },
      );

      expect(result.code).toBe(0);
      const lease = JSON.parse(
        await fs.readFile(leasePath(input.home, input.workspace, nonce), "utf8"),
      ) as { processes: Array<{ pid: number }> };
      expect(lease.processes.some((entry) => entry.pid === child.pid)).toBe(true);
    } finally {
      await resume(input, nonce);
      child.kill("SIGCONT");
      child.kill("SIGTERM");
      if (child.exitCode === null) {
        await once(child, "exit");
      }
      await fs.rm(input.extraProcessPath, { force: true });
    }
  });

  it("keeps unrelated same-uid processes running on a declared shared host", async () => {
    const input = await fixture();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    expect(child.pid).toBeDefined();
    await fs.writeFile(input.extraProcessPath, `${child.pid}\n`);

    let nonce: string | undefined;
    try {
      nonce = await quiesce(input, true);
      await renew(input, nonce, true);
      const lease = JSON.parse(
        await fs.readFile(leasePath(input.home, input.workspace, nonce), "utf8"),
      ) as { processes: Array<{ pid: number }>; sharedHost: boolean };
      expect(lease).toMatchObject({ processes: [], sharedHost: true });
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      if (nonce) {
        await resume(input, nonce);
      }
      child.kill("SIGCONT");
      child.kill("SIGTERM");
      if (child.exitCode === null) {
        await once(child, "exit");
      }
      await fs.rm(input.extraProcessPath, { force: true });
    }
  });

  it("fails closed when the watchdog lease no longer exists", async () => {
    const input = await fixture();
    const nonce = await quiesce(input);
    await resume(input, nonce);

    const result = await runCommandWithTimeout(
      [process.execPath, "-e", REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS, input.workspace, nonce],
      { timeoutMs: 10_000, baseEnv: input.env },
    );
    expect(result.code).not.toBe(0);
  });

  it("cleans up the initial watchdog when identity probing times out", async () => {
    const input = await fixture();
    const watchdogPidPath = path.join(input.home, "initial-watchdog.pid");
    await fs.writeFile(
      path.join(input.bin, "ps"),
      `#!/bin/sh
case "$*" in
  *"lstart= -p"*)
    for pid do :; done
    printf "%s\n" "$pid" > "$OPENCLAW_TEST_WATCHDOG_PID"
    trap '' TERM
    while true; do sleep 1; done
    ;;
  *) printf "%s %s %s S Tue Jul 15 08:00:00 2026\n" "$$" "$PPID" "$(id -u)" ;;
esac
`,
    );
    await fs.chmod(path.join(input.bin, "ps"), 0o755);

    const result = await runCommandWithTimeout(
      [process.execPath, "-e", REMOTE_WORKSPACE_QUIESCE_JS, input.workspace, "10000", "dedicated"],
      {
        timeoutMs: 10_000,
        baseEnv: { ...input.env, OPENCLAW_TEST_WATCHDOG_PID: watchdogPidPath },
      },
    );

    expect(result.termination).toBe("exit");
    expect(result.code).not.toBe(0);
    const watchdogPid = Number((await fs.readFile(watchdogPidPath, "utf8")).trim());
    expect(Number.isSafeInteger(watchdogPid)).toBe(true);
    const leaseDirectory = path.join(input.home, ".openclaw-worker", "quiescence");
    await expect(fs.readdir(leaseDirectory)).resolves.toEqual([]);
    await vi.waitFor(() => {
      expect(() => process.kill(watchdogPid, 0)).toThrow();
    });
  });

  it("releases an empty shared-host lease without depending on ps", async () => {
    const input = await fixture();
    const healthyPs = await fs.readFile(path.join(input.bin, "ps"), "utf8");
    const nonce = await quiesce(input, true, "1000");
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as { watchdog: { pid: number } };

    // Shared hosts intentionally freeze nothing. A ps outage must not block a no-op release or
    // turn a successfully reconciled worker result into an error.
    await fs.writeFile(path.join(input.bin, "ps"), STALLED_PS);
    await fs.chmod(path.join(input.bin, "ps"), 0o755);

    try {
      const result = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
        { timeoutMs: 15_000, baseEnv: input.env },
      );

      expect(result.termination).toBe("exit");
      expect(result.code).toBe(0);
      await expect(fs.access(leaseFile)).rejects.toThrow();
      await vi.waitFor(
        () => {
          expect(() => process.kill(lease.watchdog.pid, 0)).toThrow();
        },
        { timeout: 5_000 },
      );
    } finally {
      await fs.writeFile(path.join(input.bin, "ps"), healthyPs);
      await fs.chmod(path.join(input.bin, "ps"), 0o755);
      try {
        process.kill(lease.watchdog.pid, "SIGTERM");
      } catch {
        // Expected once the missing lease has retired it.
      }
    }
  });

  it.each([
    ["shared-host", true],
    ["dedicated", false],
  ])("removes an empty %s orphan lease without depending on ps", async (_mode, sharedHost) => {
    const input = await fixture();
    const healthyPs = await fs.readFile(path.join(input.bin, "ps"), "utf8");
    const nonce = await quiesce(input, true, "30000");
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const lease = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      sharedHost: boolean;
      watchdog: { pid: number };
    };
    lease.sharedHost = sharedHost;
    await fs.writeFile(leaseFile, JSON.stringify(lease));

    await fs.writeFile(path.join(input.bin, "ps"), STALLED_PS);
    await fs.chmod(path.join(input.bin, "ps"), 0o755);

    try {
      const result = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          REMOTE_WORKSPACE_QUIESCE_JS,
          input.workspace,
          "10000",
          "shared-host",
        ],
        { timeoutMs: 15_000, baseEnv: input.env },
      );

      // Starting the replacement watchdog still needs ps and fails closed, but the stale
      // empty lease must already be gone so it cannot block another reconciliation attempt.
      expect(result.termination).toBe("exit");
      expect(result.code).not.toBe(0);
      await expect(fs.access(leaseFile)).rejects.toThrow();
    } finally {
      await fs.writeFile(path.join(input.bin, "ps"), healthyPs);
      await fs.chmod(path.join(input.bin, "ps"), 0o755);
      try {
        process.kill(lease.watchdog.pid, "SIGTERM");
      } catch {
        // Expected once the missing lease has retired it.
      }
    }
  });

  it("retains an unverified empty orphan lease until a dedicated retry can retire it", async () => {
    const input = await fixture();
    const healthyPs = await fs.readFile(path.join(input.bin, "ps"), "utf8");
    const firstNonce = await quiesce(input, true, "30000");
    const firstLeaseFile = leasePath(input.home, input.workspace, firstNonce);
    const firstLease = JSON.parse(await fs.readFile(firstLeaseFile, "utf8")) as {
      watchdog: { pid: number };
    };
    let replacementNonce: string | undefined;

    await fs.writeFile(path.join(input.bin, "ps"), STALLED_PS);
    await fs.chmod(path.join(input.bin, "ps"), 0o755);
    try {
      const failed = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          REMOTE_WORKSPACE_QUIESCE_JS,
          input.workspace,
          "10000",
          "dedicated",
        ],
        { timeoutMs: 15_000, baseEnv: input.env },
      );

      expect(failed.termination).toBe("exit");
      expect(failed.code).not.toBe(0);
      await expect(fs.access(firstLeaseFile)).resolves.toBeUndefined();

      await fs.writeFile(path.join(input.bin, "ps"), healthyPs);
      await fs.chmod(path.join(input.bin, "ps"), 0o755);
      replacementNonce = await quiesce(input, false, "10000");
      const replacementLease = JSON.parse(
        await fs.readFile(leasePath(input.home, input.workspace, replacementNonce), "utf8"),
      ) as { processes: Array<{ pid: number }> };

      expect(replacementLease.processes).not.toContainEqual({ pid: firstLease.watchdog.pid });
      await expect(fs.access(firstLeaseFile)).rejects.toThrow();
    } finally {
      await fs.writeFile(path.join(input.bin, "ps"), healthyPs);
      await fs.chmod(path.join(input.bin, "ps"), 0o755);
      if (replacementNonce !== undefined) {
        await resume(input, replacementNonce);
      }
      try {
        process.kill(firstLease.watchdog.pid, "SIGTERM");
      } catch {
        // Expected once the healthy retry retires it.
      }
    }
  });

  it("retires an empty orphan watchdog before a dedicated replacement sweep", async () => {
    const input = await fixture();
    const firstNonce = await quiesce(input, true, "30000");
    const firstLeaseFile = leasePath(input.home, input.workspace, firstNonce);
    const firstLease = JSON.parse(await fs.readFile(firstLeaseFile, "utf8")) as {
      watchdog: { pid: number };
    };
    await fs.writeFile(input.extraProcessPath, `${firstLease.watchdog.pid}\n`);

    let replacementNonce: string | undefined;
    try {
      replacementNonce = await quiesce(input, false, "10000");
      const replacementLease = JSON.parse(
        await fs.readFile(leasePath(input.home, input.workspace, replacementNonce), "utf8"),
      ) as { processes: Array<{ pid: number }> };

      expect(replacementLease.processes).not.toContainEqual({ pid: firstLease.watchdog.pid });
      expect(() => process.kill(firstLease.watchdog.pid, 0)).toThrow();
    } finally {
      if (replacementNonce !== undefined) {
        await resume(input, replacementNonce);
      }
      try {
        process.kill(firstLease.watchdog.pid, "SIGTERM");
      } catch {
        // Expected once orphan recovery retires it.
      }
    }
  });

  it("thaws a real stopped worker and clears the lease", async () => {
    const input = await fixture();
    const child = spawnIdleWorker();
    await fs.writeFile(input.extraProcessPath, `${child.pid}\n`);

    try {
      const nonce = await quiesce(input);
      expect(await waitForProcessState(child.pid!, /^T/u)).toMatch(/^T/u);

      await resume(input, nonce);

      expect(await waitForProcessState(child.pid!, /^[^T]/u)).not.toMatch(/^T/u);
      await expect(fs.stat(leasePath(input.home, input.workspace, nonce))).rejects.toThrow();
    } finally {
      await stopIdleWorker(child);
      await fs.rm(input.extraProcessPath, { force: true });
    }
  });

  it("keeps the watchdog resumer alive when the identity sweep aborts partway", async () => {
    const input = await fixture();
    const child = spawnIdleWorker();
    await fs.writeFile(input.extraProcessPath, `${child.pid}\n`);
    let watchdogPid: number | undefined;

    try {
      const nonce = await quiesce(input);
      const lease = JSON.parse(
        await fs.readFile(leasePath(input.home, input.workspace, nonce), "utf8"),
      ) as { processes: Array<{ pid: number }>; watchdog: { pid: number } };
      expect(lease.processes.some((entry) => entry.pid === child.pid)).toBe(true);
      watchdogPid = lease.watchdog.pid;

      // Identity stays answerable for the watchdog but stalls for the frozen worker, so the
      // sweep aborts exactly where the old order had already retired the last resumer.
      await fs.writeFile(
        path.join(input.bin, "ps"),
        `#!/bin/sh\ntrap '' TERM\ncase "$*" in\n  *"lstart= -p ${watchdogPid}") exec /bin/ps "$@" ;;\n  *"lstart= -p"*) while true; do sleep 1; done ;;\n  *) exit 1 ;;\nesac\n`,
      );
      await fs.chmod(path.join(input.bin, "ps"), 0o755);

      const result = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
        { timeoutMs: 15_000, baseEnv: input.env },
      );

      expect(result.termination).toBe("exit");
      expect(result.code).not.toBe(0);
      // The watchdog is the only owner left that can still thaw this lease.
      expect(() => process.kill(watchdogPid!, 0)).not.toThrow();
    } finally {
      if (watchdogPid !== undefined) {
        try {
          process.kill(watchdogPid, "SIGTERM");
        } catch {
          // Already gone; the assertion above owns that outcome.
        }
      }
      await stopIdleWorker(child);
      await fs.rm(input.extraProcessPath, { force: true });
    }
  });

  it("recovers a frozen worker once a stalled ps answers again after lease expiry", async () => {
    const input = await fixture();
    const healthyPs = await fs.readFile(path.join(input.bin, "ps"), "utf8");
    const child = spawnIdleWorker();
    await fs.writeFile(input.extraProcessPath, `${child.pid}\n`);

    try {
      const nonce = await quiesce(input, false, "6000");
      const lease = JSON.parse(
        await fs.readFile(leasePath(input.home, input.workspace, nonce), "utf8"),
      ) as { watchdog: { pid: number } };
      expect(await waitForProcessState(child.pid!, /^T/u)).toMatch(/^T/u);

      // ps stays stalled across the failed resume and past lease expiry, so only a
      // watchdog that keeps re-probing identity can still thaw this worker.
      await fs.writeFile(path.join(input.bin, "ps"), STALLED_PS);
      await fs.chmod(path.join(input.bin, "ps"), 0o755);

      const failed = await runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
        { timeoutMs: 15_000, baseEnv: input.env },
      );
      expect(failed.code).not.toBe(0);

      await new Promise((resolve) => {
        setTimeout(resolve, 9_000);
      });
      expect(await processState(child.pid!)).toMatch(/^T/u);
      // The watchdog must still be holding the lease well past expiry, not retired by a cap.
      expect(() => process.kill(lease.watchdog.pid, 0)).not.toThrow();

      await fs.writeFile(path.join(input.bin, "ps"), healthyPs);
      await fs.chmod(path.join(input.bin, "ps"), 0o755);

      expect(await waitForProcessState(child.pid!, /^[^T]/u)).not.toMatch(/^T/u);
      await expect(fs.stat(leasePath(input.home, input.workspace, nonce))).rejects.toThrow();
    } finally {
      await stopIdleWorker(child);
      await fs.rm(input.extraProcessPath, { force: true });
    }
  }, 60_000);
});

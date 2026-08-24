import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  REMOTE_WORKSPACE_QUIESCE_JS,
  REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
  REMOTE_WORKSPACE_RESUME_JS,
} from "./workspace-quiescence-scripts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function leasePath(home: string, workspace: string) {
  const workspaceKey = createHash("sha256").update(workspace).digest("hex");
  return path.join(home, ".openclaw-worker", "quiescence", `${workspaceKey}.shared-host.json`);
}

describe.runIf(process.platform === "win32")("Windows workspace quiescence", () => {
  it("serializes file-backed shared-host lease acquisition, renewal, and release", async () => {
    const root = tempDirs.make("openclaw-windows-quiescence-test-");
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(home);
    await fs.mkdir(workspace);
    const realWorkspace = await fs.realpath(workspace);
    const environment = { ...process.env, HOME: home, USERPROFILE: home };

    const quiesced = await runCommandWithTimeout(
      [process.execPath, "-e", REMOTE_WORKSPACE_QUIESCE_JS, realWorkspace, "20000", "shared-host"],
      { timeoutMs: 10_000, baseEnv: environment },
    );
    expect(quiesced.code).toBe(0);
    const nonce = /^quiesced ([a-f0-9]{32})\n$/u.exec(quiesced.stdout)?.[1];
    expect(nonce).toBeDefined();
    const leaseFile = leasePath(home, realWorkspace);
    await expect(fs.readFile(leaseFile, "utf8")).resolves.toContain('"sharedHost":true');

    const overlapping = await runCommandWithTimeout(
      [process.execPath, "-e", REMOTE_WORKSPACE_QUIESCE_JS, realWorkspace, "20000", "shared-host"],
      { timeoutMs: 10_000, baseEnv: environment },
    );
    expect(overlapping.code).not.toBe(0);
    expect(overlapping.stderr).toContain("workspace quiescence lease is already active");

    const renewed = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
        realWorkspace,
        nonce!,
        "20000",
        "final",
        "shared-host",
      ],
      { timeoutMs: 10_000, baseEnv: environment },
    );
    expect(renewed).toMatchObject({ code: 0, stdout: `renewed ${nonce}\n` });

    await expect(
      runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, realWorkspace, nonce!],
        { timeoutMs: 10_000, baseEnv: environment },
      ),
    ).resolves.toMatchObject({ code: 0 });
    await expect(fs.access(leaseFile)).rejects.toThrow();

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
        [
          process.execPath,
          "-e",
          REMOTE_WORKSPACE_QUIESCE_JS,
          realWorkspace,
          "20000",
          "shared-host",
        ],
        { timeoutMs: 10_000, baseEnv: environment },
      ),
      runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          REMOTE_WORKSPACE_QUIESCE_JS,
          realWorkspace,
          "20000",
          "shared-host",
        ],
        { timeoutMs: 10_000, baseEnv: environment },
      ),
    ]);
    expect(simultaneous.filter((result) => result.code === 0)).toHaveLength(1);
    expect(simultaneous.find((result) => result.code !== 0)?.stderr).toContain(
      "workspace quiescence lease is already active",
    );
    const winner = simultaneous.find((result) => result.code === 0)!;
    const winnerNonce = /^quiesced ([a-f0-9]{32})\n$/u.exec(winner.stdout)?.[1];
    expect(winnerNonce).toBeDefined();
    await expect(
      runCommandWithTimeout(
        [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, realWorkspace, winnerNonce!],
        { timeoutMs: 10_000, baseEnv: environment },
      ),
    ).resolves.toMatchObject({ code: 0 });
    await expect(fs.access(leaseFile)).rejects.toThrow();

    const dedicated = await runCommandWithTimeout(
      [process.execPath, "-e", REMOTE_WORKSPACE_QUIESCE_JS, realWorkspace, "20000", "dedicated"],
      { timeoutMs: 10_000, baseEnv: environment },
    );
    expect(dedicated.code).not.toBe(0);
    expect(dedicated.stderr).toContain("workspace quiescence requires POSIX");
  });
});

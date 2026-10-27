#!/usr/bin/env node
// One managed update across the published-driver/candidate boundary, with synthetic state only.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCancelableCommand } from "../../../lib/cancelable-command.mts";
import { toErrorObject } from "../../../lib/error-format.mts";
import { hasUnjoinedWork, runManagedCommand } from "../../../lib/managed-child-process.mts";
import {
  classifyReleaseTrain,
  compareReleaseVersions,
  parseReleaseVersion,
} from "../../../lib/release-version.mjs";
import { stampFixtureVersion } from "../update-first-hop-package-fixtures.mjs";
import { assertNoIncognitoArtifacts } from "./incognito-artifacts.mjs";
import { provePublishedDriverScopedRestore } from "./published-driver-scoped-restore.mjs";
import {
  assertPublishedDriverReclaimed,
  inspectPublishedDriverSqlite,
  publishedDriverSqliteTargets,
  seedPublishedDriverLegacySqlite,
  seedPublishedDriverSessionSources,
} from "./published-driver-sqlite.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const [candidateArg, artifactsArg, driverTag = "latest"] = process.argv.slice(2);
const legacySqlite = process.env.OPENCLAW_PUBLISHED_DRIVER_LEGACY_SQLITE === "1";
const profileUpgrade = process.env.OPENCLAW_PUBLISHED_DRIVER_PROFILE_UPGRADE === "1";
assert.equal(process.platform, "linux", "The managed-service fixture requires Linux");
assert(fs.existsSync("/.dockerenv"), "Run through the bare Docker E2E runner");
const accountHome = os.userInfo().homedir;
assert.equal(accountHome, "/home/appuser", "Expected the disposable E2E account");
assert(candidateArg && artifactsArg, "Expected candidate tarball and artifact directory");
const requestedDriver = parseReleaseVersion(driverTag);
assert(
  driverTag === "latest" || (requestedDriver && classifyReleaseTrain(requestedDriver) === "stable"),
  "Driver must be a published stable version",
);
const candidate = fs.realpathSync(candidateArg);
const artifacts = path.resolve(artifactsArg);
fs.mkdirSync(artifacts, { recursive: true });
// The caller's absolute deadline includes image preparation. Keep diagnostics
// inside it so the outer Docker owner cannot remove the fixture during capture.
const cellDeadline = Number(process.env.CELL_DEADLINE_EPOCH_SECONDS) * 1000;
assert(
  Number.isSafeInteger(cellDeadline) && cellDeadline > 0,
  "Expected the caller's cell deadline",
);
const workDeadline = cellDeadline - 60_000;
let commandSignal;
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-published-driver-"));
const prefix = path.join(runtime, "npm");
const state = path.join(accountHome, ".openclaw");
assert(!fs.existsSync(state), "The published-driver cell requires a fresh account home");
const packageRoot = path.join(prefix, "lib/node_modules/openclaw");
const bin = path.join(prefix, "bin");
const env = {
  PATH: `${bin}:${process.env.PATH}`,
  HOME: accountHome,
  TMPDIR: path.join(runtime, "tmp"),
  CI: "true",
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
  OPENCLAW_NO_ONBOARD: "1",
  OPENCLAW_NO_PROMPT: "1",
  OPENCLAW_SKIP_PROVIDERS: "1",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_DISABLE_BONJOUR: "1",
  npm_config_prefix: prefix,
  NPM_CONFIG_PREFIX: prefix,
  npm_config_cache: path.join(runtime, "npm-cache"),
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_loglevel: "error",
  XDG_RUNTIME_DIR: path.join(bin, "runtime"),
  DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(bin, "runtime/bus")}`,
  OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG: path.join(artifacts, "systemctl.log"),
  OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE: path.join(runtime, "service.pid"),
  OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG: path.join(artifacts, "gateway.log"),
};
for (const directory of [env.HOME, env.TMPDIR, state, bin]) {
  fs.mkdirSync(directory, { recursive: true });
}

function writeJson(name, value) {
  fs.writeFileSync(path.join(artifacts, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

async function run(name, command, args, allowFailure = false, commandEnv = {}) {
  const started = Date.now();
  const diagnostic = name === "recorded-run" || name === "stop-service";
  const deadline = diagnostic ? cellDeadline - 5_000 : workDeadline;
  const cap = name === "recorded-run" ? 20_000 : name === "stop-service" ? 5_000 : Infinity;
  // Each managed command can spend another 5s terminating and 5s draining.
  const timeoutMs = Math.min(cap, deadline - started - (diagnostic ? 10_000 : 0));
  fs.writeFileSync(path.join(artifacts, "phase.txt"), `${name}\n`);
  const out = fs.openSync(path.join(artifacts, `${name}.stdout`), "w");
  const err = fs.openSync(path.join(artifacts, `${name}.stderr`), "w");
  const result = { status: null, signal: null, receivedSignal: null, exitCode: null };
  let failure;
  try {
    if (timeoutMs <= 0) {
      throw Object.assign(new Error(`${name} exhausted the cell budget`), { code: "ETIMEDOUT" });
    }
    result.exitCode = await runManagedCommand({
      bin: command,
      args,
      cwd: root,
      env: { ...env, ...commandEnv },
      stdio: ["ignore", out, err],
      signal: diagnostic ? undefined : commandSignal,
      timeoutMs,
      timeoutKillGraceMs: 5_000,
      signalKillGraceMs: 5_000,
      abortKillGraceMs: 5_000,
      cleanupDrainTimeoutMs: 5_000,
      requireProcessTreeExit: true,
      onReady: (child) =>
        child.once("exit", (status, signal) => {
          result.status = status;
          result.signal = signal;
        }),
      onSignal: (signal) => {
        result.receivedSignal = signal;
      },
    });
  } catch (error) {
    failure = toErrorObject(error, `${name} failed`);
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
  const exitCode = failure?.code === "ETIMEDOUT" ? 124 : result.exitCode || 1;
  console.log(`${name}: exit=${result.status} durationMs=${Date.now() - started}`);
  writeJson(`${name}-exit`, {
    ...result,
    durationMs: Date.now() - started,
    error: failure ? String(failure) : undefined,
    code: failure?.code,
    processTreeState: hasUnjoinedWork(failure) ? "unjoined" : "terminated",
  });
  if (failure) {
    throw Object.assign(failure, { command: name, exitCode });
  }
  if (!allowFailure && result.exitCode !== 0) {
    throw Object.assign(new Error(`${name} failed; see ${artifacts}/${name}.stderr`), {
      command: name,
      exitCode,
    });
  }
  return result;
}

function output(name) {
  const text = fs.readFileSync(path.join(artifacts, `${name}.stdout`), "utf8");
  return JSON.parse(text.slice(text.indexOf("{")));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function relabelCandidate(from, to) {
  const dir = path.join(runtime, "candidate-relabel");
  fs.mkdirSync(dir, { recursive: true });
  await run("candidate-relabel-extract", "tar", ["-xf", candidate, "-C", dir]);
  stampFixtureVersion(path.join(dir, "package"), to);
  const relabeled = path.join(runtime, "openclaw-candidate-relabeled.tgz");
  await run("candidate-relabel-pack", "tar", ["-czf", relabeled, "-C", dir, "package"]);
  writeJson("candidate-relabel", { from, to, package: relabeled });
  return relabeled;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => {
    server.close((error) =>
      error ? reject(toErrorObject(error, "Port close failed")) : resolve(),
    );
  });
  return port;
}

async function ready(name, port) {
  await run(name, process.execPath, [
    "scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs",
    "--base-url",
    `http://127.0.0.1:${port}`,
    "--path",
    "/readyz",
    "--expect",
    "ready",
    "--timeout-ms",
    "30000",
    "--attempt-timeout-ms",
    "1000",
    "--out",
    path.join(artifacts, `${name}.json`),
  ]);
  assert.equal(readJson(path.join(artifacts, `${name}.json`)).status, 200);
}

process.exitCode = await runCancelableCommand(async (signal) => {
  commandSignal = signal;
  let fixtureInstalled = false;
  const failures = [];
  try {
    let driverVersion = driverTag;
    if (driverTag === "latest") {
      await run("resolve-driver", "npm", ["view", "openclaw@latest", "version", "--json"]);
      driverVersion = JSON.parse(
        fs.readFileSync(path.join(artifacts, "resolve-driver.stdout"), "utf8"),
      );
    }
    const driverRelease = parseReleaseVersion(driverVersion);
    assert(
      driverRelease && classifyReleaseTrain(driverRelease) === "stable",
      "npm latest must resolve to stable",
    );
    const driverSeed = "/tmp/published-driver-cache/driver.tar";
    if (fs.existsSync(driverSeed)) {
      await run("restore-driver", "tar", ["-xf", driverSeed, "-C", prefix]);
    } else {
      await run("install-driver", "npm", [
        "install",
        "-g",
        `openclaw@${driverVersion}`,
        "--no-fund",
        "--no-audit",
      ]);
    }
    assert.equal(readJson(path.join(packageRoot, "package.json")).version, driverVersion);
    await run("candidate-build", "tar", ["-xOf", candidate, "package/dist/build-info.json"]);
    let build = output("candidate-build");
    let candidatePackage = candidate;
    if (profileUpgrade) {
      assert.equal(driverTag, driverVersion, "Profile upgrade requires an exact stable baseline pin");
      assert(
        compareReleaseVersions(build.version, driverVersion) >= 0,
        `Candidate ${build.version} is older than pinned stable ${driverVersion}`,
      );
      assert.equal(candidatePackage, candidate, "Profile upgrade must use the exact candidate artifact");
    }
    // Between a release and its forward-port, main lags npm latest. The cell proves
    // the update mechanics, not the version label: relabel the candidate to the
    // driver version so the future-version guard sees an upgrade, not a downgrade.
    if (!profileUpgrade && compareReleaseVersions(build.version, driverVersion) < 0) {
      candidatePackage = await relabelCandidate(build.version, driverVersion);
      // Match the relabeled dist/build-info.json exactly; the installed bytes carry no source label.
      build = { ...build, version: driverVersion };
    }
    const driverBuild = legacySqlite || profileUpgrade
      ? readJson(path.join(packageRoot, "dist/build-info.json"))
      : undefined;
    writeJson("inputs", {
      driverVersion,
      candidate: build,
      ...(profileUpgrade ? { driverBuild } : {}),
      ...(legacySqlite ? { expectedSqliteStores: publishedDriverSqliteTargets(state) } : {}),
    });

    const port = await freePort();
    const token = "published-driver-synthetic-token";
    const probe = async (name, version) => {
      await run(name, "openclaw", [
        "gateway",
        "probe",
        "--url",
        `ws://127.0.0.1:${port}`,
        "--token",
        token,
        "--json",
      ]);
      const target = output(name).targets.find((entry) => entry.url === `ws://127.0.0.1:${port}`);
      assert.equal(target?.connect.ok, true);
      assert.equal(target.server.version, version);
      return target;
    };
    const config = {
      gateway: {
        mode: "local",
        port,
        bind: "loopback",
        auth: { mode: "token", token },
        reload: { mode: "off" },
      },
      plugins: { enabled: false },
      agents: {
        ownership: "explicit",
        defaults: { heartbeat: { every: "0m" } },
        entries: {
          main: { workspace: path.join(runtime, "workspaces", "main") },
          second: { workspace: path.join(runtime, "workspaces", "second") },
        },
      },
    };
    for (const agent of Object.values(config.agents.entries)) {
      fs.mkdirSync(agent.workspace, { recursive: true });
    }
    fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, `${JSON.stringify(config)}\n`);
    await run("fixture", "bash", [
      "-c",
      'source "$1"; install_update_restart_systemctl_shim absent',
      "fixture",
      "scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh",
    ]);
    fixtureInstalled = true;
    if (legacySqlite) {
      seedPublishedDriverSessionSources(state);
    }
    // PRs start from the serving Gateway's state; main/release proofs also seed
    // Doctor's broader repair state before exercising the same managed update.
    if (legacySqlite || process.env.GITHUB_EVENT_NAME !== "pull_request") {
      await run("seed-state", "openclaw", ["doctor", "--fix", "--non-interactive"]);
    }
    const projectSettings = (value) => ({
      gateway: {
        mode: value.gateway.mode,
        bind: value.gateway.bind,
        port: value.gateway.port,
        authMode: value.gateway.auth?.mode,
      },
      pluginsEnabled: value.plugins.enabled,
      agentOwnership: value.agents.ownership,
      heartbeatEvery: value.agents.defaults.heartbeat.every,
      workspaces: Object.fromEntries(
        Object.entries(value.agents.entries)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([id, agent]) => [id, agent.workspace]),
      ),
    });
    const settingsBefore = projectSettings(readJson(env.OPENCLAW_CONFIG_PATH));
    if (profileUpgrade) writeJson("settings-before-update", settingsBefore);
    if (legacySqlite) {
      writeJson("sqlite-seeded", seedPublishedDriverLegacySqlite(state));
    }
    await run("install-service", "openclaw", ["gateway", "install", "--force", "--json"]);
    await ready("before-ready", port);
    if (legacySqlite || profileUpgrade) {
      const serving = await probe("running-before", driverVersion);
      const buildComparable =
        typeof serving.server.buildId === "string" && typeof driverBuild.buildId === "string";
      if (profileUpgrade) {
        assert.equal(typeof driverBuild.buildId, "string", "Stable package build identity is missing");
        assert.equal(typeof serving.server.buildId, "string", "Stable Gateway build identity is missing");
      }
      if (buildComparable) {
        assert.equal(serving.server.buildId, driverBuild.buildId);
      }
      writeJson("baseline-serving-identity", {
        installed: driverBuild,
        serving: serving.server,
        verification: buildComparable ? "version-and-build-id" : "version-only",
        ...(!buildComparable
          ? { limit: "Published driver did not expose both installed and serving build IDs" }
          : {}),
      });
    }
    const beforePid = fs.readFileSync(
      env.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE,
      "utf8",
    );
    const gateway = async (name, method, params) => {
      await run(name, "openclaw", [
        "gateway",
        "call",
        method,
        "--url",
        `ws://127.0.0.1:${port}`,
        "--token",
        token,
        "--timeout",
        "30000",
        "--json",
        "--params",
        JSON.stringify(params),
      ]);
      return output(name);
    };
    let stableProfile;
    const browserProfileDir = path.join(runtime, "control-ui-browser-profile");
    if (profileUpgrade) {
      await run(
        "stable-profile-ui",
        process.execPath,
        [
          "scripts/e2e/lib/upgrade-survivor/profile-upgrade-ui.mjs",
          "stable-seed",
          `http://127.0.0.1:${port}/`,
          artifacts,
          browserProfileDir,
          "",
          "Stable Upgrade Survivor",
          "",
        ],
        false,
        { OPENCLAW_GATEWAY_TOKEN: token },
      );
      const receipt = output("stable-profile-ui");
      assert.equal(receipt.stableDisplayName, "Stable Upgrade Survivor");
      const profiles = await gateway("stable-profile-list", "users.list", {});
      stableProfile = profiles.profiles?.find((profile) => profile.id === receipt.profileId);
      assert(stableProfile, "Stable users.list omitted the authenticated UI profile");
      assert.equal(stableProfile.displayName, receipt.stableDisplayName);
      writeJson("stable-profile", {
        ...receipt,
        profileCount: profiles.profiles.length,
      });
    }
    const sessions = [];
    for (const incognito of [false, true]) {
      const kind = incognito ? "incognito" : "durable";
      const marker = `published-driver-${kind}-${randomUUID()}`;
      const created = await gateway(`${kind}-create`, "sessions.create", {
        agentId: "main",
        ...(incognito ? { incognito: true } : { key: "agent:main:update-cell" }),
      });
      assert(created.ok && created.key && created.sessionId);
      assert.equal(created.runStarted, false, "Fixture unexpectedly started inference");
      if (incognito) {
        assert.equal(created.entry.incognito, true);
      }
      const params = { agentId: "main", sessionKey: created.key };
      const injected = await gateway(`${kind}-inject`, "chat.inject", {
        ...params,
        message: marker,
      });
      assert(injected.ok && injected.messageId);
      const history = await gateway(`${kind}-before`, "chat.history", { ...params, limit: 20 });
      assert.equal(history.sessionId, created.sessionId);
      assert(
        JSON.stringify(history.messages).includes(marker),
        `${kind} content missing before update`,
      );
      sessions.push({ kind, marker, params, sessionId: created.sessionId });
    }
    const inspectIncognito = (name) => {
      const backups = fs
        .readdirSync(path.dirname(packageRoot))
        .filter((entry) => /^\.openclaw[.-]package-(?:backup|activation)-/u.test(entry))
        .map((entry) => path.join(path.dirname(packageRoot), entry));
      writeJson(name, assertNoIncognitoArtifacts([state, ...backups], sessions[1].marker));
    };
    inspectIncognito("incognito-artifacts-before");
    // Seed retained 2026.9.7 state after baseline setup: newer published Doctors
    // reject these sidecars, while candidate repair must carry them unchanged.
    const orphanSidecar = path.join(state, "credentials/auth-profiles", `${"e".repeat(32)}.json`);
    const orphanSidecarBytes = `${JSON.stringify({
      version: 1,
      profileId: "openai-codex:default",
      provider: "openai-codex",
      encrypted: {
        algorithm: "aes-256-gcm",
        iv: "c3ludGg=",
        tag: "c3ludGg=",
        ciphertext: "c3ludGg=",
      },
    })}\n`;
    fs.mkdirSync(path.dirname(orphanSidecar), { recursive: true });
    fs.writeFileSync(orphanSidecar, orphanSidecarBytes, { mode: 0o600 });
    let update;
    let updateFailure;
    const sqliteBefore = legacySqlite ? inspectPublishedDriverSqlite(state, 0) : undefined;
    if (sqliteBefore) {
      writeJson("sqlite-before-update", sqliteBefore);
    }
    try {
      update = await run(
        "update",
        "openclaw",
        ["update", "--tag", candidatePackage, "--yes", "--json"],
        true,
      );
      if (update.exitCode !== 0) {
        updateFailure = Object.assign(new Error("Published updater failed"), {
          command: "update",
          exitCode: update.exitCode || 1,
        });
      }
    } catch (error) {
      updateFailure = toErrorObject(error, "Published updater failed");
    }
    // Public status belongs after updater settlement and before fixture teardown.
    // A failed query is secondary to the original update outcome.
    if (updateFailure) {
      failures.push(updateFailure);
      if (hasUnjoinedWork(updateFailure)) {
        throw updateFailure;
      }
    }
    await run("recorded-run", "openclaw", ["update", "status", "--json"]);
    if (updateFailure) {
      throw updateFailure;
    }
    const result = output("update");
    const recorded = output("recorded-run").lastRun;
    assert(recorded, "Update omitted its durable run");
    for (const record of [result.run, recorded].filter(Boolean)) {
      assert(
        !/candidate-startup-failed|authority-check-failed/i.test(JSON.stringify(record)),
        "Update recorded startup or authority failure",
      );
      for (const step of record.steps ?? []) {
        if (step.step?.startsWith("warning:")) {
          assert(
            !/canary|identity|lease/i.test(JSON.stringify(step)),
            `Update boundary warning: ${JSON.stringify(step)}`,
          );
        }
      }
    }
    assert.equal(update.status, 0, "Published updater failed");
    assert.equal(result.status, "ok");
    assert.equal(recorded.runId, result.run?.runId, "Status read a different update run");
    assert.equal(recorded.phase, "finished");
    assert.equal(recorded.status, "succeeded");
    assert.equal(result.after?.version, build.version);
    assert.deepEqual(readJson(path.join(packageRoot, "dist/build-info.json")), build);
    assert.equal(fs.readFileSync(orphanSidecar, "utf8"), orphanSidecarBytes);
    assert.notEqual(
      fs.readFileSync(env.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE, "utf8"),
      beforePid,
      "Update did not replace the managed service",
    );
    await ready("after-ready", port);
    const target = await probe("running-version", build.version);
    for (const session of sessions) {
      const history = await gateway(`${session.kind}-after`, "chat.history", {
        ...session.params,
        limit: 20,
      });
      if (session.kind === "incognito") {
        assert.deepEqual(history.messages, [], "Incognito content survived restart");
      } else {
        assert.equal(history.sessionId, session.sessionId);
        assert(JSON.stringify(history.messages).includes(session.marker), "Durable content lost");
      }
    }
    inspectIncognito("incognito-artifacts-after");
    let profileReceipt;
    if (profileUpgrade) {
      const settingsAfter = projectSettings(readJson(env.OPENCLAW_CONFIG_PATH));
      assert.deepEqual(settingsAfter, settingsBefore, "Published update changed retained settings");
      writeJson("settings-after-update", settingsAfter);

      const profiles = await gateway("candidate-profile-list-before-ui", "users.list", {});
      const retained = profiles.profiles?.find((profile) => profile.id === stableProfile.id);
      assert(retained, "Candidate users.list lost the stable UI profile ID");
      assert.equal(retained.displayName, "Stable Upgrade Survivor");
      writeJson("candidate-profile-preserved", {
        profileId: retained.id,
        displayName: retained.displayName,
        profileCount: profiles.profiles.length,
        candidateBuildId: target.server.buildId,
      });

      await run(
        "candidate-profile-ui",
        process.execPath,
        [
          "scripts/e2e/lib/upgrade-survivor/profile-upgrade-ui.mjs",
          "candidate-revisit",
          `http://127.0.0.1:${port}/`,
          artifacts,
          browserProfileDir,
          stableProfile.id,
          "Stable Upgrade Survivor",
          "Candidate Onboarding Survivor",
        ],
        false,
        { OPENCLAW_GATEWAY_TOKEN: token },
      );
      profileReceipt = output("candidate-profile-ui");
      assert.equal(profileReceipt.profileId, stableProfile.id);
      assert.equal(profileReceipt.stableDisplayName, "Stable Upgrade Survivor");
      assert.equal(profileReceipt.candidateDisplayName, "Candidate Onboarding Survivor");
      const afterUi = await gateway("candidate-profile-list-after-ui", "users.list", {});
      const saved = afterUi.profiles?.find((profile) => profile.id === stableProfile.id);
      assert(saved, "Candidate users.list lost the UI profile after onboarding save");
      assert.equal(saved.displayName, "Candidate Onboarding Survivor");
      writeJson("candidate-profile-after-ui", {
        ...profileReceipt,
        profileCount: afterUi.profiles.length,
      });
    }
    if (sqliteBefore || profileUpgrade) {
      assert.equal(typeof build.buildId, "string", "Candidate build identity is missing");
      assert.equal(target.server.buildId, build.buildId);
    }
    if (sqliteBefore) {
      const sqliteAfter = inspectPublishedDriverSqlite(state, 2);
      writeJson("sqlite-after-update", sqliteAfter);
      await run("stop-before-repeat", path.join(bin, "systemctl"), [
        "--user",
        "stop",
        "openclaw-gateway.service",
      ]);
      const settledSqlite = inspectPublishedDriverSqlite(state, 2);
      writeJson("sqlite-after-stop", settledSqlite);
      assertPublishedDriverReclaimed(
        readJson(path.join(artifacts, "sqlite-seeded.json")),
        settledSqlite,
      );
      env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
      try {
        await run("repeat-maintenance", "openclaw", ["doctor", "--fix", "--non-interactive"]);
      } finally {
        delete env.OPENCLAW_UPDATE_IN_PROGRESS;
      }
      writeJson("sqlite-after-repeat", inspectPublishedDriverSqlite(state, 2));
      assert(
        !fs
          .readFileSync(path.join(artifacts, "repeat-maintenance.stdout"), "utf8")
          .includes("Enabling incremental SQLite reclamation once:"),
        "Second maintenance repeated conversion",
      );
    }
    if (process.env.OPENCLAW_PUBLISHED_DRIVER_SCOPED_RESTORE === "1") {
      await run("stop-before-scoped-restore", path.join(bin, "systemctl"), [
        "--user",
        "stop",
        "openclaw-gateway.service",
      ]);
      await provePublishedDriverScopedRestore({
        packageRoot,
        state,
        env,
        artifacts,
        run,
        writeJson,
      });
    }
    writeJson("summary", {
      driverVersion,
      candidate: build,
      runId: recorded.runId,
      phase: recorded.phase,
      readyz: 200,
      runningVersion: target.server.version,
      ...(profileUpgrade
        ? {
            stableProfileId: stableProfile.id,
            profileNameAfterUpdate: "Stable Upgrade Survivor",
            profileNameAfterOnboarding: profileReceipt.candidateDisplayName,
            settingsPreserved: true,
          }
        : {}),
    });
    console.log(
      `PASS published ${driverVersion} → candidate ${build.version} (${build.commit}): finished, readyz=200, running version verified`,
    );
  } catch (error) {
    if (!failures.includes(error)) {
      failures.push(error);
    }
  }
  if (!failures.some(hasUnjoinedWork) && fixtureInstalled) {
    try {
      await run("stop-service", path.join(bin, "systemctl"), [
        "--user",
        "stop",
        "openclaw-gateway.service",
      ]);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.some((error) => hasUnjoinedWork(error) || error.command === "stop-service")) {
    writeJson("retained-runtime", {
      runtime,
      reason: "Owned work or service cleanup did not settle",
    });
  } else {
    try {
      fs.rmSync(runtime, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    const failure =
      failures.length === 1
        ? failures[0]
        : new AggregateError(failures, "Published-driver cell failed", { cause: failures[0] });
    console.error(failure);
    writeJson("failure", {
      failures: failures.map((error) => ({
        command: error.command,
        message: String(error),
        exitCode: error.exitCode,
        unjoined: hasUnjoinedWork(error),
      })),
    });
    fs.writeFileSync(path.join(artifacts, "phase.txt"), `${failures[0].command ?? "assertions"}\n`);
    if (hasUnjoinedWork(failure)) {
      throw failure;
    }
    return failures[0].exitCode || 1;
  }
  return 0;
});

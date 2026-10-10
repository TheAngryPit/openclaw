#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const EXPECTED_PRODUCT_SHA = "b3c6e1abc7544ae0874d1a53a7f84ec7c3c472a7";
const NODE_UID = 1000;
const GATEWAY_PORT = 18789;
const PARKING_OBSERVE_MS = 10_000;
const BACKEND_TIMEOUT_MS = 180_000;
const UNIT_STOP_TIMEOUT_MS = 150_000;
const TAILSCALE_STOP_TIMEOUT_MS = 30_000;
const PARKING_SIGNAL_TIMEOUT_MS = 60_000;
const STATUS_POLL_MS = 1_000;
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const PARKED_SIGNAL =
  "Tailscale Serve needs operator sign-in or device approval; Gateway startup is parked until the local backend recovers";

class ProofFailure extends Error {
  constructor(category) {
    super(category);
    this.category = category;
  }
}

function fail(category) {
  throw new ProofFailure(category);
}

function assert(condition, category) {
  if (!condition) {
    fail(category);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const acceptedExitCodes = options.acceptedExitCodes ?? [0];
  const maxOutputBytes = options.maxOutputBytes ?? MAX_COMMAND_OUTPUT_BYTES;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timeout;
    let escalation;
    let timedOut = false;
    let overflow = false;

    const append = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        overflow = true;
        child.kill("SIGTERM");
        return target;
      }
      return target + chunk.toString("utf8");
    };

    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", () => {
      clearTimeout(timeout);
      clearTimeout(escalation);
      reject(new ProofFailure("command-start-failed"));
    });
    timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), 2_000);
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(escalation);
      if (timedOut) {
        reject(new ProofFailure("command-timeout"));
        return;
      }
      if (overflow) {
        reject(new ProofFailure("command-output-limit"));
        return;
      }
      if (!acceptedExitCodes.includes(code)) {
        reject(new ProofFailure(options.failureCategory ?? "command-failed"));
        return;
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function parseJson(text, category) {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  assert(start >= 0 && end > start, category);
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    fail(category);
  }
}

function parseKeyValues(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      values[line.slice(0, separator)] = line.slice(separator + 1);
    }
  }
  return values;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ensureDirectory(directory, mode = 0o700) {
  if (existsSync(directory)) {
    const info = lstatSync(directory);
    assert(info.isDirectory() && !info.isSymbolicLink(), "unsafe-directory");
  } else {
    mkdirSync(directory, { mode });
  }
  chmodSync(directory, mode);
}

function assertRegularOrAbsent(file) {
  if (!existsSync(file)) {
    return false;
  }
  const info = lstatSync(file);
  assert(info.isFile() && !info.isSymbolicLink(), "unsafe-file");
  return true;
}

function writeJsonPrivate(file, value) {
  assert(!assertRegularOrAbsent(`${file}.tmp`), "private-write-collision");
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

function writePublicJson(file, value) {
  assert(!assertRegularOrAbsent(file), "public-receipt-exists");
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644, flag: "wx" });
}

function readState(context) {
  const file = path.join(context.privateRoot, "state.json");
  assert(assertRegularOrAbsent(file), "state-missing");
  let state;
  try {
    state = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    fail("state-invalid");
  }
  assert(isRecord(state), "state-invalid");
  assert(
    state.privateRoot === context.privateRoot &&
      state.publicRoot === context.publicRoot &&
      state.root === context.root,
    "state-root-mismatch",
  );
  assert(
    state.prefix === context.prefix && state.productSha === context.productSha,
    "state-identity-mismatch",
  );
  assert(state.proofMode === context.mode, "state-mode-mismatch");
  assert(state.workflowSha === context.workflowSha, "state-workflow-mismatch");
  assert(
    state.gatewayImage === context.gatewayImage && state.tailscaleImage === context.tailscaleImage,
    "state-image-mismatch",
  );
  for (const role of ["parking", "cancel"]) {
    const expected = roleNames(context, role);
    const recorded = state.names?.[role];
    assert(
      isRecord(recorded) && Object.keys(expected).every((key) => recorded[key] === expected[key]),
      "state-resource-name-mismatch",
    );
  }
  return state;
}

function taskContext({ requireImages = false } = {}) {
  assert(process.platform === "linux", "runner-not-linux");
  assert(process.env.GITHUB_ACTIONS === "true", "not-github-actions");
  assert(process.env.RUNNER_OS === "Linux", "runner-not-linux");
  assert(process.env.RUNNER_ENVIRONMENT === "github-hosted", "runner-not-public-hosted");
  assert(process.env.QA_PRODUCT_SHA === EXPECTED_PRODUCT_SHA, "product-sha-mismatch");
  const workflowSha = process.env.QA_WORKFLOW_SHA;
  assert(/^[a-f0-9]{40}$/i.test(workflowSha ?? ""), "workflow-sha-invalid");
  const tailscaleVersion = process.env.QA_TAILSCALE_VERSION;
  assert(/^\d+\.\d+\.\d+$/.test(tailscaleVersion ?? ""), "tailscale-version-invalid");
  const tailscaleSha256 = process.env.QA_TAILSCALE_SHA256;
  assert(/^[a-f0-9]{64}$/i.test(tailscaleSha256 ?? ""), "tailscale-archive-sha-invalid");

  const runId = process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT;
  const expectedPrefix = `pr167880-${runId}-${attempt}`;
  assert(/^\d+$/.test(runId ?? "") && /^\d+$/.test(attempt ?? ""), "run-identity-missing");
  assert(process.env.QA_PREFIX === expectedPrefix, "prefix-mismatch");
  assert(
    process.env.QA_PROOF_MODE === "parking" || process.env.QA_PROOF_MODE === "full",
    "proof-mode-invalid",
  );

  const runnerTempInput = process.env.RUNNER_TEMP;
  const rootInput = process.env.QA_ROOT;
  assert(runnerTempInput && rootInput, "task-root-missing");
  const runnerTemp = realpathSync(runnerTempInput);
  const root = path.resolve(rootInput);
  const relativeRoot = path.relative(runnerTemp, root);
  assert(relativeRoot === `pr167880-runtime-${runId}-${attempt}`, "task-root-outside-runner-temp");
  ensureDirectory(root);
  assert(realpathSync(root) === root, "task-root-symlink");

  const privateRoot = path.join(root, "private");
  const publicRoot = path.join(root, "public");
  ensureDirectory(privateRoot);
  ensureDirectory(publicRoot);
  const authRoot = path.join(privateRoot, "auth");
  ensureDirectory(authRoot);
  assert(path.resolve(authRoot).startsWith(`${root}${path.sep}`), "auth-path-outside-root");

  const prefix = process.env.QA_PREFIX;
  assert(/^[a-z][a-z0-9-]{1,57}$/.test(prefix), "prefix-invalid");
  const context = {
    root,
    privateRoot,
    publicRoot,
    authRoot,
    prefix,
    mode: process.env.QA_PROOF_MODE,
    productSha: EXPECTED_PRODUCT_SHA,
    workflowSha,
    gatewayImage: process.env.QA_GATEWAY_IMAGE,
    tailscaleImage: process.env.QA_TAILSCALE_IMAGE,
    tailscaleVersion,
    tailscaleSha256: tailscaleSha256.toLowerCase(),
    gatewayPort: GATEWAY_PORT,
  };

  if (requireImages) {
    assert(/^sha256:[a-f0-9]{64}$/i.test(context.gatewayImage ?? ""), "gateway-image-id-invalid");
    assert(
      /^sha256:[a-f0-9]{64}$/i.test(context.tailscaleImage ?? ""),
      "tailscale-image-id-invalid",
    );
  }
  return context;
}

function roleNames(context, role) {
  const stem = role === "cancel" ? `${context.prefix}-cancel` : context.prefix;
  return {
    sidecar: `${stem}-tailscale`,
    gateway: `${stem}-gateway`,
    unit: `${stem}-gateway.service`,
    unitFile: `/run/systemd/system/${stem}-gateway.service`,
    localApi: path.join(context.privateRoot, role === "cancel" ? "cancel-localapi" : "localapi"),
    tailscaleAuth: role === "cancel" ? null : path.join(context.authRoot, "key"),
  };
}

async function docker(args, options = {}) {
  return run("docker", args, options);
}

async function sudo(args, options = {}) {
  return run("sudo", ["-n", ...args], options);
}

function privateDiagnosticPath(context, role, filename) {
  const directory = path.join(context.privateRoot, "diagnostics", role);
  ensureDirectory(path.dirname(directory));
  ensureDirectory(directory);
  const target = path.join(directory, filename);
  assert(
    path.resolve(target).startsWith(`${context.privateRoot}${path.sep}`),
    "diagnostic-path-outside-private-root",
  );
  return target;
}

function retainPrivateText(context, role, filename, value) {
  const target = privateDiagnosticPath(context, role, filename);
  writeFileSync(target, value, { mode: 0o600 });
  chmodSync(target, 0o600);
  return target;
}

async function captureDockerLogs(context, role, name, filename) {
  const result = await docker(["logs", "--timestamps", "--tail", "1000", name], {
    timeoutMs: 15_000,
    acceptedExitCodes: [0, 1],
    maxOutputBytes: 2 * 1024 * 1024,
  });
  const combined = `${result.stdout}${result.stderr ? `\n[private docker-log stderr]\n${result.stderr}` : ""}`;
  retainPrivateText(context, role, filename, combined);
  return { ok: result.code === 0, text: combined };
}

async function captureUnitJournal(context, role, unit) {
  const result = await sudo(
    ["journalctl", "--no-pager", "--output=short-iso", "--unit", unit, "--lines=1000"],
    {
      timeoutMs: 15_000,
      acceptedExitCodes: [0, 1],
      maxOutputBytes: 2 * 1024 * 1024,
    },
  );
  const combined = `${result.stdout}${result.stderr ? `\n[private journal stderr]\n${result.stderr}` : ""}`;
  retainPrivateText(context, role, "gateway-unit.journal", combined);
  return result.code === 0;
}

async function waitForParkingSignal(context, role, names) {
  const deadline = Date.now() + PARKING_SIGNAL_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    const snapshot = await captureDockerLogs(
      context,
      role,
      names.gateway,
      "gateway-parking-observation.log",
    );
    assert(snapshot.ok, "gateway-parking-log-unavailable");
    if (snapshot.text.includes(PARKED_SIGNAL)) {
      return true;
    }
    const container = await inspectContainer(names.gateway, { optional: true });
    if (container?.State?.Running === false) {
      fail("gateway-exited-before-parking-signal");
    }
    await sleep(STATUS_POLL_MS);
  }
  fail("gateway-parking-signal-timeout");
}

async function assertNodeIdentity(container) {
  const uid = await docker(["exec", container, "id", "-u", "node"], {
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
  });
  const name = await docker(["exec", container, "id", "-un", "1000"], {
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
  });
  assert(
    uid.stdout.trim() === String(NODE_UID) && name.stdout.trim() === "node",
    "runtime-node-identity-mismatch",
  );
  return true;
}

async function inspectImage(image) {
  const result = await docker(["image", "inspect", "--format={{.Id}}", image], {
    timeoutMs: 20_000,
    maxOutputBytes: 64 * 1024,
  });
  assert(result.stdout.trim() === image, "image-pin-mismatch");
  return result.stdout.trim();
}

async function inspectContainer(name, { optional = false } = {}) {
  const result = await run("docker", ["container", "inspect", name], {
    timeoutMs: 20_000,
    acceptedExitCodes: optional ? [0, 1] : [0],
    maxOutputBytes: 1_000_000,
  });
  if (result.code === 1) {
    assert(/no such (?:object|container)/i.test(result.stderr), "container-inspect-failed");
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    fail("container-inspect-invalid");
  }
  assert(
    Array.isArray(parsed) && parsed.length === 1 && isRecord(parsed[0]),
    "container-inspect-invalid",
  );
  return parsed[0];
}

async function systemdProperties(unit) {
  const result = await sudo(
    [
      "systemctl",
      "show",
      "--no-pager",
      "--property=ActiveState,SubState,Restart,NRestarts,InvocationID,MainPID,ExecMainCode,ExecMainStatus,Result",
      unit,
    ],
    { timeoutMs: 15_000, maxOutputBytes: 128 * 1024 },
  );
  return parseKeyValues(result.stdout);
}

async function imageAndHostPreflight(context) {
  const osRelease = readFileSync("/etc/os-release", "utf8");
  assert(
    /^ID=ubuntu$/m.test(osRelease) && /^VERSION_ID="24\.04"$/m.test(osRelease),
    "runner-not-ubuntu-24-04",
  );
  const init = await run("ps", ["-p", "1", "-o", "comm="], {
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
  });
  assert(init.stdout.trim() === "systemd", "systemd-not-pid1");
  await run("docker", ["info", "--format={{.ServerVersion}}"], {
    timeoutMs: 20_000,
    maxOutputBytes: 64 * 1024,
  });
  await sudo(["systemctl", "is-system-running"], {
    timeoutMs: 15_000,
    acceptedExitCodes: [0, 1],
    maxOutputBytes: 64 * 1024,
  });
  await inspectImage(context.gatewayImage);
  await inspectImage(context.tailscaleImage);
}

async function ensureFreshResourceNames(context, role) {
  const names = roleNames(context, role);
  assert(!existsSync(names.unitFile), "unit-file-collision");
  const unitStatus = await run(
    "sudo",
    ["-n", "systemctl", "show", "--property=LoadState", "--value", names.unit],
    {
      timeoutMs: 10_000,
      acceptedExitCodes: [0, 1],
      maxOutputBytes: 64 * 1024,
    },
  );
  assert(unitStatus.code !== 0 || unitStatus.stdout.trim() === "not-found", "unit-collision");
  assert(
    (await inspectContainer(names.sidecar, { optional: true })) === null,
    "sidecar-container-collision",
  );
  assert(
    (await inspectContainer(names.gateway, { optional: true })) === null,
    "gateway-container-collision",
  );
  if (names.tailscaleAuth) {
    assert(!assertRegularOrAbsent(names.tailscaleAuth), "auth-file-present-before-parking");
  }
  return names;
}

async function tailscaleStatus(name) {
  const result = await docker(["exec", name, "/usr/local/bin/tailscale", "status", "--json"], {
    timeoutMs: 10_000,
    acceptedExitCodes: [0, 1],
    maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
  });
  return parseJson(result.stdout, "tailscale-status-invalid");
}

async function runtimePins(context, gatewayName, tailscaleName) {
  const gatewayScript = [
    "const fs=require('node:fs');",
    "const path=require('node:path');",
    "const crypto=require('node:crypto');",
    "const cp=require('node:child_process');",
    "const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');",
    "const packageRoot='/opt/openclaw/lib/node_modules/openclaw';",
    "const pkg=JSON.parse(fs.readFileSync(path.join(packageRoot,'package.json'),'utf8'));",
    "const cli='/opt/openclaw/bin/openclaw';",
    "const cliVersion=cp.execFileSync(cli,['--version'],{encoding:'utf8',timeout:15000}).trim();",
    "const tailscale='/usr/local/bin/tailscale';",
    "const tailscaleVersion=cp.execFileSync(tailscale,['version'],{encoding:'utf8',timeout:15000}).trim().split(/\\r?\\n/)[0].match(/(?:^|\\s)v?(\\d+\\.\\d+\\.\\d+)(?:\\s|$)/)?.[1]||'';",
    "const result={packageVersion:pkg.version,cliVersionMatches:cliVersion.includes(pkg.version),packageTarballSha256:sha('/qa/candidate.tgz'),installedCliSha256:sha(fs.realpathSync(cli)),tailscaleVersion,tailscaleCliSha256:sha(fs.realpathSync(tailscale))};",
    "process.stdout.write(JSON.stringify(result));",
  ].join(" ");
  const sidecarScript = [
    "const fs=require('node:fs');",
    "const crypto=require('node:crypto');",
    "const cp=require('node:child_process');",
    "const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');",
    "const tailscale='/usr/local/bin/tailscale';",
    "const version=cp.execFileSync(tailscale,['version'],{encoding:'utf8',timeout:15000}).trim().split(/\\r?\\n/)[0].match(/(?:^|\\s)v?(\\d+\\.\\d+\\.\\d+)(?:\\s|$)/)?.[1]||'';",
    "process.stdout.write(JSON.stringify({version,cliSha256:sha(fs.realpathSync(tailscale)),daemonSha256:sha('/usr/local/bin/tailscaled')}));",
  ].join(" ");
  const result = await docker(["exec", gatewayName, "node", "-e", gatewayScript], {
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
  });
  const pins = parseJson(result.stdout, "runtime-pins-invalid");
  const sidecarResult = await docker(["exec", tailscaleName, "node", "-e", sidecarScript], {
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
  });
  const sidecarPins = parseJson(sidecarResult.stdout, "tailscale-runtime-pins-invalid");
  assert(
    typeof pins.packageVersion === "string" &&
      /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(pins.packageVersion),
    "installed-package-version-invalid",
  );
  assert(pins.cliVersionMatches === true, "installed-cli-version-mismatch");
  assert(
    pins.tailscaleVersion === context.tailscaleVersion &&
      sidecarPins.version === context.tailscaleVersion,
    "installed-tailscale-version-mismatch",
  );
  assert(pins.tailscaleCliSha256 === sidecarPins.cliSha256, "tailscale-cli-image-binary-mismatch");
  for (const key of ["packageTarballSha256", "installedCliSha256", "tailscaleCliSha256"]) {
    assert(/^[a-f0-9]{64}$/.test(pins[key] ?? ""), "runtime-binary-sha-invalid");
  }
  assert(/^[a-f0-9]{64}$/.test(sidecarPins.daemonSha256 ?? ""), "tailscale-daemon-sha-invalid");
  return { ...pins, tailscaledSha256: sidecarPins.daemonSha256 };
}

function backendState(status) {
  return typeof status?.BackendState === "string" ? status.BackendState : "";
}

async function waitForBackend(name, expected, timeoutMs, phase) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() <= deadline) {
    const status = await tailscaleStatus(name);
    last = backendState(status);
    if (last === expected) {
      return status;
    }
    if (last === "NeedsMachineAuth") {
      fail(`${phase}-needs-machine-auth`);
    }
    if (
      last &&
      !["NoState", "Starting", "NeedsLogin"].includes(last) &&
      expected === "NeedsLogin"
    ) {
      fail(`${phase}-unexpected-backend-state`);
    }
    await sleep(STATUS_POLL_MS);
  }
  fail(`${phase}-backend-timeout`);
}

async function serveConfig(name) {
  const result = await docker(
    ["exec", name, "/usr/local/bin/tailscale", "serve", "status", "--json"],
    {
      timeoutMs: 10_000,
      acceptedExitCodes: [0],
      maxOutputBytes: 1_000_000,
      failureCategory: "serve-status-command-failed",
    },
  );
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    fail("serve-status-invalid");
  }
  if (parsed === null) {
    return {};
  }
  assert(isRecord(parsed), "serve-status-invalid");
  return parsed;
}

function countServeRoutes(config) {
  const tcp = isRecord(config.TCP) ? Object.keys(config.TCP).length : 0;
  const web = isRecord(config.Web)
    ? Object.values(config.Web).reduce((count, server) => {
        const handlers = isRecord(server?.Handlers) ? Object.keys(server.Handlers).length : 0;
        return count + handlers;
      }, 0)
    : 0;
  const funnel = isRecord(config.AllowFunnel)
    ? Object.values(config.AllowFunnel).filter(Boolean).length
    : 0;
  const foreground = countNonEmptyServeStructure(config.Foreground);
  const services = countNonEmptyServeStructure(config.Services);
  return tcp + web + funnel + foreground + services;
}

function countNonEmptyServeStructure(value) {
  if (Array.isArray(value)) {
    return (
      value.reduce((count, child) => count + countNonEmptyServeStructure(child), 0) ||
      Number(value.length > 0)
    );
  }
  if (isRecord(value)) {
    const nested = Object.values(value).reduce(
      (count, child) => count + countNonEmptyServeStructure(child),
      0,
    );
    return nested || Number(Object.keys(value).length > 0);
  }
  return value === null || value === undefined || value === false || value === "" ? 0 : 1;
}

function loopbackProxyPort(proxy) {
  if (typeof proxy !== "string") {
    return null;
  }
  const candidate = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/?$/i.exec(proxy.trim());
  if (!candidate) {
    return null;
  }
  const port = Number(candidate[1]);
  return port > 0 && port <= 65535 ? port : null;
}

function expectedServeTarget(config, gatewayPort, expectedDnsName) {
  const pending = [config];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!isRecord(current) || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const tcp = isRecord(current.TCP) ? current.TCP : {};
    const web = isRecord(current.Web) ? current.Web : {};
    const allowFunnel = isRecord(current.AllowFunnel) ? current.AllowFunnel : {};
    for (const [hostPort, server] of Object.entries(web)) {
      const suffix = /^(.+):(443|8443|10000)$/.exec(hostPort);
      if (!suffix) {
        continue;
      }
      if (normalizeDnsSuffix(suffix[1]) !== normalizeDnsSuffix(expectedDnsName ?? "")) {
        continue;
      }
      const handlers = isRecord(server?.Handlers) ? server.Handlers : {};
      const backendPort = loopbackProxyPort(handlers["/"]?.Proxy);
      const httpsPort = suffix[2];
      if (
        Object.keys(handlers).length === 1 &&
        backendPort !== null &&
        backendPort !== gatewayPort &&
        tcp[httpsPort]?.HTTPS === true &&
        allowFunnel[hostPort] !== true
      ) {
        return backendPort;
      }
    }
    for (const [key, child] of Object.entries(current)) {
      if (key === "Foreground" || isRecord(child)) {
        if (isRecord(child)) {
          pending.push(child);
        }
      } else if (Array.isArray(child)) {
        pending.push(...child.filter(isRecord));
      }
    }
  }
  return null;
}

function configForRuntime(prefix, role) {
  const workspace = `/tmp/openclaw-pr167880-${prefix}-${role}-workspace`;
  return { workspace };
}

function gatewayContainerArgs(context, role, names) {
  const sentinel = configForRuntime(context.prefix, role).workspace;
  const seedScript = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const crypto = require('node:crypto');",
    "const prefix = process.argv[1];",
    "const role = process.argv[2];",
    "const workspace = process.argv[3];",
    "const root = '/tmp/openclaw-qa';",
    "for (const dir of [root, root + '/home', root + '/state', root + '/cache', root + '/tmp', workspace]) fs.mkdirSync(dir, {recursive:true, mode:0o700});",
    "const token = crypto.createHash('sha256').update(prefix + ':' + role + ':synthetic-gateway-token').digest('hex');",
    "const config = {gateway:{mode:'local',bind:'loopback',port:18789,auth:{mode:'token',token},tailscale:{mode:'serve'}},agents:{defaults:{workspace}}};",
    "fs.writeFileSync(path.join(root,'state','openclaw.json'), JSON.stringify(config,null,2) + '\\n', {mode:0o600});",
  ].join(" ");
  const shell =
    'node -e "$1" "$2" "$3" "$4"; /opt/openclaw/bin/openclaw config validate; exec /opt/openclaw/bin/openclaw gateway run --port 18789 --bind loopback --tailscale serve';
  return [
    "run",
    "--name",
    names.gateway,
    "--label",
    `com.openclaw.qa.run=${context.prefix}`,
    "--label",
    `com.openclaw.qa.role=${role}-gateway`,
    "--label",
    `com.openclaw.qa.product-sha=${context.productSha}`,
    "--network",
    `container:${names.sidecar}`,
    "--user",
    "1000:1000",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,uid=1000,gid=1000,mode=1777,size=512m",
    "--mount",
    `type=bind,source=${names.localApi},target=/var/run/tailscale,readonly`,
    "--workdir",
    "/opt/openclaw",
    "--env",
    "HOME=/tmp/openclaw-qa/home",
    "--env",
    "TMPDIR=/tmp/openclaw-qa/tmp",
    "--env",
    "XDG_CACHE_HOME=/tmp/openclaw-qa/cache",
    "--env",
    "OPENCLAW_STATE_DIR=/tmp/openclaw-qa/state",
    "--env",
    "OPENCLAW_CONFIG_PATH=/tmp/openclaw-qa/state/openclaw.json",
    "--env",
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "--env",
    "INVOCATION_ID",
    "--sig-proxy=true",
    "--entrypoint",
    "/bin/sh",
    context.gatewayImage,
    "-eu",
    "-c",
    shell,
    "runtime-proof",
    seedScript,
    context.prefix,
    role,
    sentinel,
  ];
}

async function startSidecar(context, role, names) {
  ensureDirectory(names.localApi, 0o777);
  chmodSync(names.localApi, 0o777);
  const args = [
    "run",
    "--detach",
    "--name",
    names.sidecar,
    "--label",
    `com.openclaw.qa.run=${context.prefix}`,
    "--label",
    `com.openclaw.qa.role=${role}-tailscale`,
    "--label",
    `com.openclaw.qa.product-sha=${context.productSha}`,
    "--user",
    "1000:1000",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,uid=1000,gid=1000,mode=1777,size=64m",
    "--tmpfs",
    "/var/lib/tailscale:rw,nosuid,nodev,uid=1000,gid=1000,mode=700,size=128m",
    "--mount",
    `type=bind,source=${names.localApi},target=/var/run/tailscale`,
  ];
  if (role === "parking") {
    args.push("--mount", `type=bind,source=${context.authRoot},target=/run/qa-auth,readonly`);
  }
  args.push(
    "--entrypoint",
    "/usr/local/bin/tailscaled",
    context.tailscaleImage,
    "--tun=userspace-networking",
    "--state=/var/lib/tailscale/tailscaled.state",
    "--socket=/var/run/tailscale/tailscaled.sock",
  );
  await docker(args, { timeoutMs: 45_000, maxOutputBytes: 64 * 1024 });
  await assertNodeIdentity(names.sidecar);
}

async function makeSystemdUnit(context, role, names) {
  const unitDir = path.join(context.privateRoot, "units");
  ensureDirectory(unitDir);
  const unitSource = path.join(unitDir, names.unit);
  assert(!assertRegularOrAbsent(unitSource), "unit-source-collision");
  const command = ["/usr/bin/docker", ...gatewayContainerArgs(context, role, names)];
  const escape = (value) =>
    `"${String(value)
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("$", () => "$$")}"`;
  const contents = [
    "[Unit]",
    `Description=OpenClaw PR 167880 ephemeral Gateway proof (${role})`,
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    "Type=exec",
    "User=root",
    "Group=root",
    "ExecStart=" + command.map(escape).join(" "),
    "Restart=no",
    "TimeoutStopSec=infinity",
    "KillSignal=SIGTERM",
    "KillMode=control-group",
    "SendSIGKILL=no",
    "StandardOutput=journal",
    "StandardError=journal",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
  writeFileSync(unitSource, contents, { mode: 0o600, flag: "wx" });
  const unitTarget = names.unitFile;
  await sudo(["install", "-o", "root", "-g", "root", "-m", "0644", "--", unitSource, unitTarget]);
  await sudo(["systemctl", "daemon-reload"]);
  await sudo(["systemctl", "start", names.unit], { timeoutMs: 45_000, maxOutputBytes: 64 * 1024 });
}

async function candidateConfigCheck(context, role, names) {
  const script = [
    "const fs=require('node:fs');",
    "const crypto=require('node:crypto');",
    "const c=JSON.parse(fs.readFileSync('/tmp/openclaw-qa/state/openclaw.json','utf8'));",
    "const prefix=process.argv[1], role=process.argv[2], workspace=process.argv[3];",
    "const expected=crypto.createHash('sha256').update(prefix+':'+role+':synthetic-gateway-token').digest('hex');",
    "const ok=c.gateway?.auth?.mode==='token'&&c.gateway.auth.token===expected&&c.gateway?.tailscale?.mode==='serve'&&c.gateway?.port===18789&&c.agents?.defaults?.workspace===workspace;",
    "process.stdout.write(JSON.stringify({ok,tokenPresent:typeof c.gateway?.auth?.token==='string'&&c.gateway.auth.token.length===64,workspacePreserved:c.agents?.defaults?.workspace===workspace,serveConfigured:c.gateway?.tailscale?.mode==='serve'}));",
    "process.exitCode=ok?0:3;",
  ].join(" ");
  const result = await docker(
    [
      "exec",
      names.gateway,
      "node",
      "-e",
      script,
      context.prefix,
      role,
      configForRuntime(context.prefix, role).workspace,
    ],
    {
      timeoutMs: 15_000,
      maxOutputBytes: 64 * 1024,
      acceptedExitCodes: [0, 3],
      failureCategory: "config-check-command-failed",
    },
  );
  const parsed = parseJson(result.stdout, "config-check-invalid");
  assert(parsed.ok === true, "config-seed-mismatch");
  return {
    configSeeded: true,
    syntheticTokenPresent: parsed.tokenPresent === true,
    preservedSettingPresent: parsed.workspacePreserved === true,
    serveConfigured: parsed.serveConfigured === true,
  };
}

async function candidateProcessCheck(names, invocationId) {
  const script = [
    "const fs=require('node:fs');",
    "const args=fs.readFileSync('/proc/1/cmdline','utf8').split('\\0').filter(Boolean);",
    "const launcher=fs.realpathSync('/opt/openclaw/bin/openclaw');",
    "const original=args.some(arg=>{try{return fs.realpathSync(arg)===launcher;}catch{return false;}})&&args.includes('gateway')&&args.includes('run');",
    "const renamed=args.length===1&&args[0]==='openclaw-gateway';",
    "const env=fs.readFileSync('/proc/1/environ','utf8').split('\\0');",
    "const ok=(original||renamed)&&fs.realpathSync('/proc/1/exe')===fs.realpathSync(process.execPath)&&fs.realpathSync('/proc/1/cwd')==='/opt/openclaw'&&env.includes('INVOCATION_ID='+process.argv[1]);",
    "process.stdout.write(ok?'true':'false');",
    "process.exitCode=ok?0:4;",
  ].join(" ");
  const result = await docker(["exec", names.gateway, "node", "-e", script, invocationId], {
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
    acceptedExitCodes: [0, 4],
    failureCategory: "process-check-command-failed",
  });
  return result.stdout.trim() === "true";
}

async function listenerIsAbsent(names) {
  const script = [
    "const fs=require('node:fs');",
    "const files=['/proc/net/tcp','/proc/net/tcp6'];",
    "const listeners=[];",
    "for(const file of files){if(!fs.existsSync(file))continue;for(const line of fs.readFileSync(file,'utf8').trim().split(/\\r?\\n/).slice(1)){const fields=line.trim().split(/\\s+/);if(fields[3]==='0A'){const port=Number.parseInt(fields[1].split(':').at(-1),16);if(Number.isInteger(port))listeners.push(port);}}}",
    "process.stdout.write(JSON.stringify({listenerCount:listeners.length}));",
    "process.exitCode=listeners.length===0?0:4;",
  ].join(" ");
  const result = await docker(["exec", names.gateway, "node", "-e", script], {
    timeoutMs: 10_000,
    acceptedExitCodes: [0, 4],
    maxOutputBytes: 64 * 1024,
  });
  const parsed = parseJson(result.stdout, "tcp-listener-census-invalid");
  return { absent: result.code === 0 && parsed.listenerCount === 0, count: parsed.listenerCount };
}

async function tcpPortIsListening(names, port) {
  const script = [
    "const fs=require('node:fs');",
    "const wanted=Number(process.argv[1]);",
    "let found=false;",
    "for(const file of ['/proc/net/tcp','/proc/net/tcp6']){if(!fs.existsSync(file))continue;for(const line of fs.readFileSync(file,'utf8').trim().split(/\\r?\\n/).slice(1)){const fields=line.trim().split(/\\s+/);if(fields[3]==='0A'&&Number.parseInt(fields[1].split(':').at(-1),16)===wanted)found=true;}}",
    "process.stdout.write(found?'true':'false');",
    "process.exitCode=found?0:4;",
  ].join(" ");
  const result = await docker(["exec", names.gateway, "node", "-e", script, String(port)], {
    timeoutMs: 10_000,
    acceptedExitCodes: [0, 4],
    maxOutputBytes: 64 * 1024,
  });
  return result.code === 0 && result.stdout.trim() === "true";
}

async function httpStatus(names, port, pathName) {
  const script = [
    "fetch('http://127.0.0.1:' + process.argv[1] + process.argv[2], {signal:AbortSignal.timeout(2500)}).then(r=>{process.stdout.write(String(r.status));}).catch(()=>{process.stdout.write('0');});",
  ].join(" ");
  const result = await docker(
    ["exec", names.gateway, "node", "-e", script, String(port), pathName],
    {
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
    },
  );
  return Number(result.stdout.trim());
}

async function containerShape(context, role, names, invocationId) {
  const inspected = await inspectContainer(names.gateway);
  const sidecar = await inspectContainer(names.sidecar);
  await assertNodeIdentity(names.gateway);
  await assertNodeIdentity(names.sidecar);
  const config = inspected.Config ?? {};
  const host = inspected.HostConfig ?? {};
  const mounts = Array.isArray(inspected.Mounts) ? inspected.Mounts : [];
  const bindMounts = mounts.filter((mount) => mount.Type === "bind");
  const env = Array.isArray(config.Env) ? config.Env : [];
  const containerInvocation = env
    .find((entry) => entry.startsWith("INVOCATION_ID="))
    ?.slice("INVOCATION_ID=".length);
  const socketMount =
    bindMounts.length === 1 &&
    bindMounts[0].Destination === "/var/run/tailscale" &&
    bindMounts[0].Source === names.localApi &&
    bindMounts[0].RW === false;
  const forbiddenEnv = env.some((entry) => /(?:AUTHKEY|AUTH_KEY|TAILSCALE.*KEY)=/i.test(entry));
  const networkMode =
    host.NetworkMode === `container:${sidecar.Id}` ||
    host.NetworkMode === `container:${names.sidecar}`;
  const forbiddenBind = bindMounts.some((mount) => mount.Destination !== "/var/run/tailscale");
  const sidecarLabels = sidecar.Config?.Labels ?? {};
  const labels = config.Labels ?? {};
  const actualRole = role === "recovery" ? "parking" : role;
  const launchArgs = gatewayContainerArgs(context, actualRole, names);
  const expectedCommand = launchArgs.slice(launchArgs.indexOf(context.gatewayImage) + 1);
  const safe =
    JSON.stringify(config.Entrypoint) === JSON.stringify(["/bin/sh"]) &&
    JSON.stringify(config.Cmd) === JSON.stringify(expectedCommand) &&
    config.WorkingDir === "/opt/openclaw" &&
    config.User === "1000:1000" &&
    inspected.Image === context.gatewayImage &&
    host.RestartPolicy?.Name === "no" &&
    sidecar.Config?.User === "1000:1000" &&
    sidecar.Image === context.tailscaleImage &&
    sidecarLabels["com.openclaw.qa.run"] === context.prefix &&
    sidecarLabels["com.openclaw.qa.role"] === `${actualRole}-tailscale` &&
    sidecarLabels["com.openclaw.qa.product-sha"] === context.productSha &&
    sidecar.HostConfig?.RestartPolicy?.Name === "no" &&
    labels["com.openclaw.qa.run"] === context.prefix &&
    labels["com.openclaw.qa.role"] === `${actualRole}-gateway` &&
    labels["com.openclaw.qa.product-sha"] === context.productSha &&
    host.Privileged !== true &&
    Array.isArray(host.CapDrop) &&
    host.CapDrop.includes("ALL") &&
    (host.SecurityOpt ?? []).includes("no-new-privileges:true") &&
    host.ReadonlyRootfs === true &&
    socketMount &&
    !forbiddenBind &&
    !forbiddenEnv &&
    networkMode &&
    !host.PidMode &&
    !host.Binds?.some((bind) => bind.includes("/run/qa-auth"));
  assert(safe, `${role}-container-isolation-mismatch`);
  assert(
    containerInvocation && containerInvocation === invocationId,
    `${role}-invocation-id-mismatch`,
  );
  return {
    userUid1000: config.User === "1000:1000",
    capsDropped: Array.isArray(host.CapDrop) && host.CapDrop.includes("ALL"),
    noNewPrivileges: (host.SecurityOpt ?? []).includes("no-new-privileges:true"),
    readOnlyRoot: host.ReadonlyRootfs === true,
    localApiOnlyMount: socketMount && !forbiddenBind,
    noAuthMaterialMounted:
      !forbiddenEnv && !host.Binds?.some((bind) => bind.includes("/run/qa-auth")),
    sharedSidecarNetwork: networkMode,
    noHostPidNamespace: !host.PidMode,
    invocationIdMatches: true,
    running: inspected.State?.Running === true,
    oomKilled: inspected.State?.OOMKilled === true,
  };
}

async function unitRunningCheck(names, expectedInvocationId) {
  const properties = await systemdProperties(names.unit);
  const count = Number(properties.NRestarts);
  return {
    active: properties.ActiveState === "active" && properties.SubState === "running",
    mainPidPresent: Number(properties.MainPID) > 0,
    restartPolicyNo: properties.Restart === "no",
    restartCountZero: Number.isFinite(count) && count === 0,
    invocationId: properties.InvocationID ?? "",
    invocationIdMatches: Boolean(
      expectedInvocationId && properties.InvocationID === expectedInvocationId,
    ),
  };
}

async function waitUnitActive(names) {
  const deadline = Date.now() + 60_000;
  while (Date.now() <= deadline) {
    const checked = await unitRunningCheck(names);
    if (
      checked.active &&
      checked.invocationId &&
      checked.restartPolicyNo &&
      checked.restartCountZero
    ) {
      return checked;
    }
    await sleep(STATUS_POLL_MS);
  }
  fail("gateway-unit-not-active");
}

function updateStage(state, name, stage) {
  state.stages ??= {};
  state.stages[name] = stage;
  writeJsonPrivate(path.join(state.privateRoot, "state.json"), state);
}

function createInitialState(context) {
  const primary = roleNames(context, "parking");
  const cancel = roleNames(context, "cancel");
  return {
    schemaVersion: 1,
    privateRoot: context.privateRoot,
    publicRoot: context.publicRoot,
    root: context.root,
    prefix: context.prefix,
    proofMode: context.mode,
    productSha: context.productSha,
    gatewayImage: context.gatewayImage,
    tailscaleImage: context.tailscaleImage,
    workflowSha: context.workflowSha,
    tailscaleVersion: context.tailscaleVersion,
    tailscaleSha256: context.tailscaleSha256,
    gatewayPort: context.gatewayPort,
    names: {
      parking: primary,
      cancel,
    },
    stages: {},
  };
}

async function startGatewayUnit(context, role, names) {
  await makeSystemdUnit(context, role, names);
  const started = await waitUnitActive(names);
  const containerDeadline = Date.now() + 60_000;
  let inspected = null;
  while (Date.now() <= containerDeadline) {
    inspected = await inspectContainer(names.gateway, { optional: true });
    if (inspected?.State?.Running === true) {
      break;
    }
    await sleep(STATUS_POLL_MS);
  }
  assert(inspected?.State?.Running === true, "gateway-container-not-running");
  return { ...started, container: inspected };
}

async function parking() {
  const context = taskContext({ requireImages: true });
  const prior = path.join(context.privateRoot, "state.json");
  assert(!assertRegularOrAbsent(prior), "state-already-exists");
  await imageAndHostPreflight(context);
  const names = await ensureFreshResourceNames(context, "parking");
  const state = createInitialState(context);
  updateStage(state, "preflight", { status: "passed", imagesPinned: true, runnerPinned: true });
  const startedAt = Date.now();
  let stage = { status: "failed", category: "parking-incomplete" };
  try {
    await startSidecar(context, "parking", names);
    const loginStatus = await waitForBackend(names.sidecar, "NeedsLogin", 45_000, "parking");
    const service = await startGatewayUnit(context, "parking", names);
    const invocationId = service.invocationId;
    assert(/^[0-9a-f]{32}$/i.test(invocationId), "systemd-invocation-id-invalid");
    state.invocationIds ??= {};
    state.invocationIds.parking = invocationId;
    writeJsonPrivate(path.join(state.privateRoot, "state.json"), state);
    const parkingSignalObserved = await waitForParkingSignal(context, "parking", names);
    assert(parkingSignalObserved, "gateway-parking-signal-missing");
    const gatewayShape = await containerShape(context, "parking", names, invocationId);
    const pins = await runtimePins(context, names.gateway, names.sidecar);
    state.runtimePins = pins;
    const config = await candidateConfigCheck(context, "parking", names);
    const processOwned = await candidateProcessCheck(names, invocationId);
    assert(processOwned, "installed-gateway-not-foreground");
    const initialServe = await serveConfig(names.sidecar);
    assert(countServeRoutes(initialServe) === 0, "parking-serve-route-present");
    const initialListener = await listenerIsAbsent(names);
    assert(initialListener.absent, "parking-gateway-listener-present");

    await sleep(PARKING_OBSERVE_MS);
    const after = await waitForBackend(names.sidecar, "NeedsLogin", 10_000, "parking-observation");
    const running = await unitRunningCheck(names, invocationId);
    assert(
      running.active &&
        running.mainPidPresent &&
        running.restartPolicyNo &&
        running.restartCountZero &&
        running.invocationIdMatches,
      "parking-unit-restarted-or-stopped",
    );
    const afterServe = await serveConfig(names.sidecar);
    assert(countServeRoutes(afterServe) === 0, "parking-serve-route-appeared");
    const afterListener = await listenerIsAbsent(names);
    assert(afterListener.absent, "parking-gateway-listener-appeared");
    const secondProcessOwned = await candidateProcessCheck(names, invocationId);
    assert(secondProcessOwned, "parking-gateway-process-missing");

    state.startedAtUtc = new Date(startedAt).toISOString();
    stage = {
      status: "passed",
      durationMs: Date.now() - startedAt,
      backendNeedsLoginInitially: backendState(loginStatus) === "NeedsLogin",
      backendNeedsLoginAfterBackoff: backendState(after) === "NeedsLogin",
      backoffMs: PARKING_OBSERVE_MS,
      systemdUnitActive: running.active,
      restartPolicyNo: running.restartPolicyNo,
      restartCountZero: running.restartCountZero,
      invocationIdStable: running.invocationIdMatches,
      installedGatewayForeground: processOwned && secondProcessOwned,
      parkingSignalObserved,
      gatewayTcpListenerCountBeforeAndAfterBackoff: [initialListener.count, afterListener.count],
      gatewayListenerAbsentBeforeAndAfterBackoff: initialListener.absent && afterListener.absent,
      tailscaleServeEmptyBeforeAndAfterBackoff: true,
      configValidBeforeForegroundStart: true,
      ...config,
      ...gatewayShape,
      ...pins,
      expectedDnsSuffixChecked: false,
      upgrade: "not_run",
    };
  } catch (error) {
    stage = {
      status: "failed",
      category: error instanceof ProofFailure ? error.category : "parking-failed",
    };
    throw error;
  } finally {
    updateStage(state, "parking", {
      ...stage,
      durationMs: stage.durationMs ?? Date.now() - startedAt,
    });
  }
}

function normalizeDnsSuffix(value) {
  return value
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();
}

function dnsSuffixMatches(dnsName, suffix) {
  const dns = normalizeDnsSuffix(dnsName ?? "");
  const expected = normalizeDnsSuffix(suffix ?? "");
  return Boolean(dns && expected && (dns === expected || dns.endsWith(`.${expected}`)));
}

function isDnsSuffix(value) {
  const suffix = normalizeDnsSuffix(value);
  return (
    suffix.length <= 253 &&
    suffix.includes(".") &&
    suffix
      .split(".")
      .every(
        (label) =>
          label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
      )
  );
}

async function waitForHttp(names, port, route, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const status = await httpStatus(names, port, route);
    if (status === 200) {
      return { passed: true, status };
    }
    await sleep(2_000);
  }
  return { passed: false, status: 0 };
}

async function recovery() {
  const context = taskContext({ requireImages: true });
  assert(context.mode === "full", "recovery-requires-full-mode");
  const expectedSuffix = process.env.TS_QA_EXPECTED_DNS_SUFFIX;
  const expectedTag = process.env.TS_QA_TAG;
  assert(
    typeof expectedSuffix === "string" && isDnsSuffix(expectedSuffix),
    "expected-dns-suffix-missing-or-invalid",
  );
  assert(
    typeof expectedTag === "string" && /^tag:[a-zA-Z0-9][a-zA-Z0-9:_-]{0,62}$/.test(expectedTag),
    "approved-tag-missing-or-invalid",
  );
  const state = readState(context);
  assert(
    state.proofMode === "full" &&
      state.prefix === context.prefix &&
      state.productSha === context.productSha,
    "state-identity-mismatch",
  );
  assert(state.stages?.parking?.status === "passed", "parking-prerequisite-failed");
  assert(
    state.stages?.parking?.parkingSignalObserved === true,
    "parking-signal-prerequisite-missing",
  );
  const names = state.names.parking;
  const invocationId = state.invocationIds?.parking;
  assert(invocationId, "parking-invocation-id-missing");
  const startedAt = Date.now();
  let stage = { status: "failed", category: "recovery-incomplete" };
  try {
    const status = await waitForBackend(names.sidecar, "Running", BACKEND_TIMEOUT_MS, "recovery");
    const dnsMatched = dnsSuffixMatches(status?.Self?.DNSName, expectedSuffix);
    assert(dnsMatched, "tailnet-dns-suffix-mismatch");
    const tags = Array.isArray(status?.Self?.Tags) ? status.Self.Tags : [];
    const tagMatched = tags.includes(expectedTag);
    assert(tagMatched, "tailnet-tag-mismatch");

    const unit = await unitRunningCheck(names, invocationId);
    assert(
      unit.active &&
        unit.mainPidPresent &&
        unit.restartPolicyNo &&
        unit.restartCountZero &&
        unit.invocationIdMatches,
      "recovery-unit-identity-changed",
    );
    const gatewayShape = await containerShape(context, "recovery", names, invocationId);
    const processOwned = await candidateProcessCheck(names, invocationId);
    assert(processOwned, "recovery-installed-gateway-missing");
    const health = await waitForHttp(names, context.gatewayPort, "/healthz", BACKEND_TIMEOUT_MS);
    const startup = await waitForHttp(names, context.gatewayPort, "/startupz", BACKEND_TIMEOUT_MS);
    const ready = await waitForHttp(names, context.gatewayPort, "/readyz", BACKEND_TIMEOUT_MS);
    assert(health.passed && startup.passed && ready.passed, "gateway-http-readiness-failed");
    const serve = await serveConfig(names.sidecar);
    const backendPort = expectedServeTarget(serve, context.gatewayPort, status?.Self?.DNSName);
    const foregroundSessionPresent = countNonEmptyServeStructure(serve.Foreground) > 0;
    const routeMatched =
      backendPort !== null && backendPort !== context.gatewayPort && foregroundSessionPresent;
    assert(routeMatched, "foreground-serve-loopback-route-mismatch");
    const backendListenerPresent = await tcpPortIsListening(names, backendPort);
    assert(backendListenerPresent, "foreground-serve-backend-not-listening");
    const backendProbe = await waitForHttp(names, backendPort, "/healthz", BACKEND_TIMEOUT_MS);
    assert(backendProbe.passed, "foreground-serve-backend-health-failed");
    const gatewayCli = await run("docker", ["top", names.gateway], {
      timeoutMs: 15_000,
      maxOutputBytes: 256 * 1024,
    });
    const processLines = gatewayCli.stdout.split(/\r?\n/);
    const foregroundProcessPresent = processLines.some(
      (line) =>
        line.includes("/usr/local/bin/tailscale") &&
        /\bserve\b/.test(line) &&
        line.includes("--bg=false"),
    );
    assert(foregroundProcessPresent, "foreground-serve-process-missing");
    const config = await candidateConfigCheck(context, "parking", names);
    const finalUnit = await unitRunningCheck(names, invocationId);
    assert(
      finalUnit.active &&
        finalUnit.restartPolicyNo &&
        finalUnit.restartCountZero &&
        finalUnit.invocationIdMatches,
      "recovery-unit-changed-after-probes",
    );

    stage = {
      status: "passed",
      durationMs: Date.now() - startedAt,
      backendRunning: backendState(status) === "Running",
      expectedDnsSuffixMatched: dnsMatched,
      approvedTagMatched: tagMatched,
      sameSystemdInvocationId: finalUnit.invocationIdMatches,
      restartCountZero: finalUnit.restartCountZero,
      healthz: health.passed,
      startupz: startup.passed,
      readyz: ready.passed,
      foregroundServeRouteMatchesLoopbackGateway: routeMatched,
      foregroundServeBackendListening: backendListenerPresent,
      foregroundServeBackendHealthz: backendProbe.passed,
      ordinaryGatewayHealthz: health.passed,
      ordinaryGatewayStartupz: startup.passed,
      ordinaryGatewayReadyz: ready.passed,
      foregroundServeSessionPresent: foregroundSessionPresent,
      foregroundServeProcessPresent: foregroundProcessPresent,
      ...config,
      ...gatewayShape,
      upgrade: "not_run",
      crossPeerHttps: "not_run",
    };
  } catch (error) {
    stage = {
      status: "failed",
      category: error instanceof ProofFailure ? error.category : "recovery-failed",
    };
    throw error;
  } finally {
    updateStage(state, "recovery", {
      ...stage,
      durationMs: stage.durationMs ?? Date.now() - startedAt,
    });
  }
}

function shutdownExitChecks(properties, container) {
  return {
    systemdExitStatus: Number(properties.ExecMainStatus),
    systemdExitKind: Number(properties.ExecMainCode),
    gatewayExitStatus: Number(container?.State?.ExitCode),
    unitFailureObserved: properties.ActiveState === "failed",
  };
}

function shutdownLogChecks(text) {
  const step = [
    "restart failure recovery",
    "active work drain",
    "startup operations",
    "restart signal settlement",
    "gateway server close",
  ].find((value) => text.includes(`shutdown step failed (${value})`));
  return {
    shutdownSignalObserved: text.includes("received SIGTERM; shutting down"),
    shutdownDeadlineObserved: text.includes("shutdown deadline reached;"),
    handledPrerequisiteRethrownAtShutdown: text
      .split(/\r?\n/)
      .some(
        (line) =>
          line.includes("shutdown step failed (startup operations)") &&
          line.includes(
            "Tailscale backend requires the operator to sign in to the local node (NeedsLogin)",
          ),
      ),
    ...(step ? { shutdownFailureStep: step.replaceAll(" ", "-") } : {}),
  };
}

async function stopUnitAndVerify(state, role) {
  const names = state.names[role];
  const container = await inspectContainer(names.gateway, { optional: true });
  if (!container) {
    return {
      unitStopped: true,
      gatewayContainerStopped: true,
      gracefulExit: false,
      statusKnown: false,
    };
  }
  assert(
    container.Config?.Labels?.["com.openclaw.qa.run"] === state.prefix,
    "container-ownership-mismatch",
  );
  const propsBefore = await systemdProperties(names.unit);
  const activeBeforeStop =
    propsBefore.ActiveState === "active" && propsBefore.SubState === "running";
  const restartPolicyNoBeforeStop = propsBefore.Restart === "no";
  const restartCountZeroBeforeStop = Number(propsBefore.NRestarts) === 0;
  const invocationMatchesBeforeStop =
    Boolean(state.invocationIds?.[role]) && propsBefore.InvocationID === state.invocationIds[role];
  if (activeBeforeStop) {
    await sudo(["systemctl", "stop", "--no-block", names.unit], {
      timeoutMs: 15_000,
      maxOutputBytes: 64 * 1024,
    });
  }
  const deadline = Date.now() + UNIT_STOP_TIMEOUT_MS;
  let properties = propsBefore;
  while (Date.now() <= deadline) {
    properties = await systemdProperties(names.unit);
    if (
      properties.ActiveState !== "active" &&
      properties.ActiveState !== "activating" &&
      properties.ActiveState !== "deactivating"
    ) {
      break;
    }
    await sleep(STATUS_POLL_MS);
  }
  const after = await inspectContainer(names.gateway, { optional: true });
  const statusKnown = Boolean(
    properties.ActiveState &&
    properties.ExecMainStatus !== undefined &&
    properties.Result !== undefined,
  );
  const unitStopped = properties.ActiveState === "inactive";
  const restartCountZero = Number(properties.NRestarts) === 0;
  const containerStopped = after?.State?.Running === false && Number(after.State.Pid) === 0;
  const containerOk =
    containerStopped && after.State.ExitCode === 0 && after.State.OOMKilled === false;
  const unitOk =
    activeBeforeStop &&
    restartPolicyNoBeforeStop &&
    properties.Restart === "no" &&
    invocationMatchesBeforeStop &&
    restartCountZeroBeforeStop &&
    unitStopped &&
    Number(properties.MainPID) === 0 &&
    Number(properties.ExecMainStatus) === 0 &&
    properties.Result === "success" &&
    restartCountZero;
  return {
    unitStopped,
    gatewayContainerStopped: containerStopped,
    gracefulExit: unitOk && containerOk,
    statusKnown,
    restartCountZero,
    restartPolicyNo: properties.Restart === "no",
    mainPidGone: Number(properties.MainPID) === 0,
    exitCodeZero: Number(properties.ExecMainStatus) === 0 && after?.State?.ExitCode === 0,
    notOomKilled: after?.State?.OOMKilled === false,
    invocationIdStable: invocationMatchesBeforeStop,
    ...shutdownExitChecks(properties, after),
    container: after,
  };
}

async function startCancel() {
  const context = taskContext({ requireImages: true });
  const state = readState(context);
  assert(
    state.prefix === context.prefix &&
      state.gatewayImage === context.gatewayImage &&
      state.tailscaleImage === context.tailscaleImage,
    "state-identity-mismatch",
  );
  const names = await ensureFreshResourceNames(context, "cancel");
  const startedAt = Date.now();
  let stage = { status: "failed", category: "cancel-incomplete" };
  try {
    await startSidecar(context, "cancel", names);
    const initial = await waitForBackend(names.sidecar, "NeedsLogin", 45_000, "cancel");
    const service = await startGatewayUnit(context, "cancel", names);
    state.invocationIds ??= {};
    state.invocationIds.cancel = service.invocationId;
    writeJsonPrivate(path.join(state.privateRoot, "state.json"), state);
    const shape = await containerShape(context, "cancel", names, service.invocationId);
    const parkingSignalObserved = await waitForParkingSignal(context, "cancel", names);
    assert(parkingSignalObserved, "cancel-parking-signal-missing");
    assert(
      await candidateProcessCheck(names, service.invocationId),
      "cancel-installed-gateway-missing",
    );
    const serve = await serveConfig(names.sidecar);
    assert(countServeRoutes(serve) === 0, "cancel-serve-route-present-before-stop");
    const initialListener = await listenerIsAbsent(names);
    assert(initialListener.absent, "cancel-gateway-listener-present-before-stop");
    await sleep(4_000);
    const afterLogin = await waitForBackend(
      names.sidecar,
      "NeedsLogin",
      10_000,
      "cancel-observation",
    );
    const running = await unitRunningCheck(names, service.invocationId);
    assert(
      running.active &&
        running.restartPolicyNo &&
        running.restartCountZero &&
        running.invocationIdMatches,
      "cancel-unit-restarted-before-stop",
    );
    assert(
      countServeRoutes(await serveConfig(names.sidecar)) === 0,
      "cancel-serve-route-present-before-stop",
    );
    const afterListener = await listenerIsAbsent(names);
    assert(afterListener.absent, "cancel-gateway-listener-present-before-stop");

    const stopped = await stopUnitAndVerify(state, "cancel");
    assert(stopped.gracefulExit, "cancel-shutdown-not-graceful");
    const afterStopServeEmpty = countServeRoutes(await serveConfig(names.sidecar)) === 0;
    assert(afterStopServeEmpty, "cancel-serve-claim-remained-active");
    stage = {
      status: "passed",
      durationMs: Date.now() - startedAt,
      backendNeedsLoginBeforeAndAfterBackoff:
        backendState(initial) === "NeedsLogin" && backendState(afterLogin) === "NeedsLogin",
      parkingSignalObserved,
      gatewayTcpListenerCountBeforeAndAfterBackoff: [initialListener.count, afterListener.count],
      backoffMs: 4_000,
      gracefulSystemdStop: stopped.gracefulExit,
      gatewayExitCodeZero: stopped.exitCodeZero,
      gatewayNotOomKilled: stopped.notOomKilled,
      gatewayMainPidGone: stopped.mainPidGone && stopped.gatewayContainerStopped,
      restartCountZero: stopped.restartCountZero,
      restartPolicyNo: stopped.restartPolicyNo,
      invocationIdStable: stopped.invocationIdStable,
      serveClaimGoneAfterStop: afterStopServeEmpty,
      ...shape,
    };
  } catch (error) {
    stage = {
      status: "failed",
      category: error instanceof ProofFailure ? error.category : "cancel-failed",
    };
    throw error;
  } finally {
    updateStage(state, "cancel", {
      ...stage,
      durationMs: stage.durationMs ?? Date.now() - startedAt,
    });
  }
}

async function maybeLogoutSidecar(state, role) {
  const names = state.names[role];
  const container = await inspectContainer(names.sidecar, { optional: true });
  if (!container) {
    return {
      sidecarStopped: true,
      sidecarRemoved: true,
      logoutAttempted: false,
      logoutSucceeded: null,
    };
  }
  assert(
    container.Config?.Labels?.["com.openclaw.qa.run"] === state.prefix,
    "sidecar-ownership-mismatch",
  );
  const candidate = await inspectContainer(names.gateway, { optional: true });
  if (candidate?.State?.Running === true || Number(candidate?.State?.Pid) > 0) {
    return {
      sidecarStopped: false,
      sidecarRemoved: false,
      logoutAttempted: false,
      logoutSucceeded: null,
    };
  }
  let serveEmpty = false;
  try {
    serveEmpty = countServeRoutes(await serveConfig(names.sidecar)) === 0;
  } catch {
    return {
      sidecarStopped: false,
      sidecarRemoved: false,
      logoutAttempted: false,
      logoutSucceeded: null,
    };
  }
  if (!serveEmpty) {
    return {
      sidecarStopped: false,
      sidecarRemoved: false,
      logoutAttempted: false,
      logoutSucceeded: null,
    };
  }
  const backend = await tailscaleStatus(names.sidecar).catch(() => null);
  let logoutAttempted = false;
  let logoutSucceeded = null;
  // Full-mode authentication may register a node before it becomes Running.
  // Retain its state unless logout succeeds, including approval/failure paths.
  if (state.proofMode === "full" && role === "parking") {
    logoutAttempted = true;
    logoutSucceeded = await docker(["exec", names.sidecar, "/usr/local/bin/tailscale", "logout"], {
      timeoutMs: TAILSCALE_STOP_TIMEOUT_MS,
      acceptedExitCodes: [0],
      maxOutputBytes: 128 * 1024,
    }).then(
      () => true,
      () => false,
    );
    if (!logoutSucceeded) {
      return { sidecarStopped: false, sidecarRemoved: false, logoutAttempted, logoutSucceeded };
    }
  } else if (backendState(backend) !== "NeedsLogin") {
    return { sidecarStopped: false, sidecarRemoved: false, logoutAttempted, logoutSucceeded };
  }
  await docker(["stop", "--time=-1", names.sidecar], {
    timeoutMs: TAILSCALE_STOP_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
  }).catch(() => undefined);
  const stopped = await inspectContainer(names.sidecar, { optional: true });
  if (
    stopped?.State?.Running !== false ||
    Number(stopped?.State?.Pid) !== 0 ||
    stopped.State.OOMKilled !== false ||
    stopped.State.ExitCode !== 0
  ) {
    return { sidecarStopped: false, sidecarRemoved: false, logoutAttempted, logoutSucceeded };
  }
  await docker(["rm", names.sidecar], { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 });
  return { sidecarStopped: true, sidecarRemoved: true, logoutAttempted, logoutSucceeded };
}

async function removeUnitFileIfStopped(state, role) {
  const names = state.names[role];
  const loaded = await run(
    "sudo",
    ["-n", "systemctl", "show", "--property=LoadState", "--value", names.unit],
    {
      timeoutMs: 10_000,
      acceptedExitCodes: [0, 1],
      maxOutputBytes: 64 * 1024,
    },
  );
  if (loaded.code !== 0) {
    return false;
  }
  const loadState = loaded.stdout.trim();
  if (loadState === "loaded") {
    const props = await systemdProperties(names.unit);
    if (props.ActiveState !== "inactive") {
      return false;
    }
  } else if (loadState !== "not-found") {
    return false;
  }
  if (existsSync(names.unitFile)) {
    await sudo(["rm", "--", names.unitFile], { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
    await sudo(["systemctl", "daemon-reload"], { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 });
  }
  return true;
}

async function cleanup() {
  const context = taskContext();
  const state = readState(context);
  const cleanupStage = { status: "partial", roles: {} };
  for (const role of ["parking", "cancel"]) {
    const names = state.names?.[role];
    if (!names) {
      cleanupStage.roles[role] = { complete: true, resourceAbsent: true };
      continue;
    }
    try {
      const gateway = await inspectContainer(names.gateway, { optional: true });
      const sidecar = await inspectContainer(names.sidecar, { optional: true });
      const diagnostics = { gatewayLog: !gateway, sidecarLog: !sidecar, unitJournal: false };
      if (gateway) {
        assert(
          gateway.Config?.Labels?.["com.openclaw.qa.run"] === state.prefix,
          "gateway-container-ownership-mismatch",
        );
        diagnostics.gatewayLog = (
          await captureDockerLogs(context, role, names.gateway, "gateway.log")
        ).ok;
      }
      if (sidecar) {
        assert(
          sidecar.Config?.Labels?.["com.openclaw.qa.run"] === state.prefix,
          "sidecar-container-ownership-mismatch",
        );
        diagnostics.sidecarLog = (
          await captureDockerLogs(context, role, names.sidecar, "tailscale-sidecar.log")
        ).ok;
      }
      diagnostics.unitJournal = await captureUnitJournal(context, role, names.unit);
      let gatewayShutdown = {
        unitStopped: true,
        gatewayContainerStopped: !gateway,
        gracefulExit: true,
        statusKnown: !gateway,
      };
      if (gateway?.State?.Running === true) {
        gatewayShutdown = await stopUnitAndVerify(state, role);
      } else if (gateway) {
        const properties = await systemdProperties(names.unit).catch(() => ({}));
        gatewayShutdown = {
          unitStopped: properties.ActiveState === "inactive",
          gatewayContainerStopped:
            gateway.State?.Running === false && Number(gateway.State?.Pid) === 0,
          gracefulExit:
            properties.ActiveState === "inactive" &&
            properties.Result === "success" &&
            Number(properties.ExecMainStatus) === 0 &&
            gateway.State?.ExitCode === 0 &&
            gateway.State?.OOMKilled === false,
          statusKnown: Boolean(properties.ActiveState),
          restartCountZero: Number(properties.NRestarts) === 0,
          restartPolicyNo: properties.Restart === "no",
          mainPidGone: Number(properties.MainPID) === 0,
          exitCodeZero: Number(properties.ExecMainStatus) === 0 && gateway.State?.ExitCode === 0,
          notOomKilled: gateway.State?.OOMKilled === false,
          invocationIdStable: properties.InvocationID === state.invocationIds?.[role],
          ...shutdownExitChecks(properties, gateway),
        };
      }
      let sidecarCleanup = {
        sidecarStopped: !sidecar,
        sidecarRemoved: !sidecar,
        logoutAttempted: false,
        logoutSucceeded: null,
      };
      if (gatewayShutdown.gatewayContainerStopped && gatewayShutdown.unitStopped) {
        const afterStop = await inspectContainer(names.gateway, { optional: true });
        if (afterStop) {
          diagnostics.gatewayLog = (
            await captureDockerLogs(context, role, names.gateway, "gateway.log")
          ).ok;
        }
        diagnostics.unitJournal = await captureUnitJournal(context, role, names.unit);
        const afterSidecar = await inspectContainer(names.sidecar, { optional: true });
        if (afterSidecar) {
          diagnostics.sidecarLog = (
            await captureDockerLogs(context, role, names.sidecar, "tailscale-sidecar.log")
          ).ok;
        }
        const canRemoveGateway = diagnostics.gatewayLog && diagnostics.unitJournal;
        if (
          canRemoveGateway &&
          afterStop &&
          afterStop.State?.Running === false &&
          afterStop.State?.Pid === 0 &&
          afterStop.State?.ExitCode === 0 &&
          afterStop.State?.OOMKilled === false
        ) {
          await docker(["rm", names.gateway], { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 });
        }
        if (canRemoveGateway && diagnostics.sidecarLog) {
          sidecarCleanup = await maybeLogoutSidecar(state, role);
        } else if (afterSidecar) {
          sidecarCleanup = {
            sidecarStopped: false,
            sidecarRemoved: false,
            logoutAttempted: false,
            logoutSucceeded: null,
          };
        }
      }
      const unitRemoved = diagnostics.unitJournal && (await removeUnitFileIfStopped(state, role));
      let shutdownLogs = {};
      if (gateway && gatewayShutdown.gatewayContainerStopped) {
        const snapshot = await captureDockerLogs(context, role, names.gateway, "gateway.log");
        diagnostics.gatewayLog = snapshot.ok;
        shutdownLogs = shutdownLogChecks(snapshot.text);
      }
      const privateDiagnosticsRetained =
        diagnostics.gatewayLog && diagnostics.sidecarLog && diagnostics.unitJournal;
      cleanupStage.roles[role] = {
        ...gatewayShutdown,
        ...sidecarCleanup,
        ...shutdownLogs,
        unitFileRemoved: unitRemoved,
        privateDiagnosticsRetained,
        complete:
          gatewayShutdown.gracefulExit &&
          sidecarCleanup.sidecarStopped &&
          sidecarCleanup.sidecarRemoved &&
          unitRemoved &&
          privateDiagnosticsRetained,
      };
    } catch (error) {
      cleanupStage.roles[role] = {
        complete: false,
        category: error instanceof ProofFailure ? error.category : "cleanup-failed",
      };
    }
  }
  cleanupStage.status = Object.values(cleanupStage.roles).every((role) => role.complete)
    ? "passed"
    : "failed";
  updateStage(state, "cleanup", cleanupStage);
  if (cleanupStage.status === "failed") {
    process.exitCode = 1;
  }
}

function publicProjection(state) {
  const booleanFields = {
    preflight: ["imagesPinned", "runnerPinned"],
    parking: [
      "backendNeedsLoginInitially",
      "backendNeedsLoginAfterBackoff",
      "parkingSignalObserved",
      "systemdUnitActive",
      "restartPolicyNo",
      "restartCountZero",
      "invocationIdStable",
      "installedGatewayForeground",
      "gatewayListenerAbsentBeforeAndAfterBackoff",
      "tailscaleServeEmptyBeforeAndAfterBackoff",
      "configValidBeforeForegroundStart",
      "configSeeded",
      "syntheticTokenPresent",
      "preservedSettingPresent",
      "serveConfigured",
      "userUid1000",
      "capsDropped",
      "noNewPrivileges",
      "readOnlyRoot",
      "localApiOnlyMount",
      "noAuthMaterialMounted",
      "sharedSidecarNetwork",
      "noHostPidNamespace",
      "running",
    ],
    recovery: [
      "backendRunning",
      "expectedDnsSuffixMatched",
      "approvedTagMatched",
      "sameSystemdInvocationId",
      "restartPolicyNo",
      "restartCountZero",
      "healthz",
      "startupz",
      "readyz",
      "ordinaryGatewayHealthz",
      "ordinaryGatewayStartupz",
      "ordinaryGatewayReadyz",
      "foregroundServeRouteMatchesLoopbackGateway",
      "foregroundServeBackendListening",
      "foregroundServeBackendHealthz",
      "foregroundServeSessionPresent",
      "foregroundServeProcessPresent",
      "configSeeded",
      "syntheticTokenPresent",
      "preservedSettingPresent",
      "serveConfigured",
      "userUid1000",
      "capsDropped",
      "noNewPrivileges",
      "readOnlyRoot",
      "localApiOnlyMount",
      "noAuthMaterialMounted",
      "sharedSidecarNetwork",
      "noHostPidNamespace",
    ],
    cancel: [
      "backendNeedsLoginBeforeAndAfterBackoff",
      "parkingSignalObserved",
      "gracefulSystemdStop",
      "gatewayExitCodeZero",
      "gatewayNotOomKilled",
      "gatewayMainPidGone",
      "restartCountZero",
      "restartPolicyNo",
      "invocationIdStable",
      "serveClaimGoneAfterStop",
      "userUid1000",
      "capsDropped",
      "noNewPrivileges",
      "readOnlyRoot",
      "localApiOnlyMount",
      "noAuthMaterialMounted",
      "sharedSidecarNetwork",
      "noHostPidNamespace",
    ],
  };
  const stage = (name) => {
    const value = state.stages?.[name];
    if (!value) {
      return { status: "not_run" };
    }
    const output = {
      status: ["passed", "failed", "partial"].includes(value.status) ? value.status : "not_run",
    };
    if (
      Number.isSafeInteger(value.durationMs) &&
      value.durationMs >= 0 &&
      value.durationMs <= 86_400_000
    ) {
      output.durationMs = value.durationMs;
    }
    if (name === "parking" && value.backoffMs === PARKING_OBSERVE_MS) {
      output.backoffMs = PARKING_OBSERVE_MS;
    }
    if (name === "cancel" && value.backoffMs === 4_000) {
      output.backoffMs = 4_000;
    }
    for (const key of booleanFields[name] ?? []) {
      if (typeof value[key] === "boolean") {
        output[key] = value[key];
      }
    }
    return output;
  };
  const cleanupStage = state.stages?.cleanup;
  const cleanupRoles = cleanupStage?.roles ?? {};
  const cleanupChecks = (role) => {
    const source = cleanupRoles[role] ?? {};
    const output = {};
    for (const key of [
      "unitStopped",
      "gatewayContainerStopped",
      "gracefulExit",
      "statusKnown",
      "restartCountZero",
      "restartPolicyNo",
      "mainPidGone",
      "exitCodeZero",
      "notOomKilled",
      "invocationIdStable",
      "sidecarStopped",
      "sidecarRemoved",
      "unitFileRemoved",
      "privateDiagnosticsRetained",
      "unitFailureObserved",
      "shutdownSignalObserved",
      "shutdownDeadlineObserved",
      "handledPrerequisiteRethrownAtShutdown",
    ]) {
      if (typeof source[key] === "boolean") {
        output[key] = source[key];
      }
    }
    for (const key of ["systemdExitStatus", "gatewayExitStatus", "systemdExitKind"]) {
      const value = source[key];
      if (Number.isInteger(value) && value >= 0 && value <= (key === "systemdExitKind" ? 3 : 255)) {
        output[key] = value;
      }
    }
    if (
      [
        "restart-failure-recovery",
        "active-work-drain",
        "startup-operations",
        "restart-signal-settlement",
        "gateway-server-close",
      ].includes(source.shutdownFailureStep)
    ) {
      output.shutdownFailureStep = source.shutdownFailureStep;
    }
    return output;
  };
  const allCoreStages = ["parking", "cancel"].every(
    (name) => state.stages?.[name]?.status === "passed",
  );
  const recoveryRequired = state.proofMode === "full";
  const recoveryPassed = state.stages?.recovery?.status === "passed";
  const cleanupPassed = cleanupStage?.status === "passed";
  const requiredPassed = allCoreStages && (!recoveryRequired || recoveryPassed) && cleanupPassed;
  const pins = isRecord(state.runtimePins) ? state.runtimePins : {};
  const safeHex = (value) =>
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
  const safeVersion = (value) =>
    typeof value === "string" && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(value)
      ? value
      : null;
  const safeImageId = (value) =>
    typeof value === "string" && /^sha256:[a-f0-9]{64}$/i.test(value) ? value : null;
  const safeCommitSha = (value) =>
    typeof value === "string" && /^[a-f0-9]{40}$/i.test(value) ? value : null;
  return {
    schemaVersion: 1,
    status: requiredPassed ? "partial" : "failed",
    result: requiredPassed
      ? state.proofMode === "full"
        ? "parking, real login recovery, and graceful cancellation passed; upgrade and cross-peer HTTPS proof were not run"
        : "parking and graceful cancellation passed; real recovery, upgrade, and cross-peer HTTPS proof were not run"
      : "one or more required runtime phases failed",
    pins: {
      productSha: safeCommitSha(state.productSha),
      workflowSha: safeCommitSha(state.workflowSha),
      gatewayImageId: safeImageId(state.gatewayImage),
      tailscaleImageId: safeImageId(state.tailscaleImage),
      gatewayPort: state.gatewayPort === GATEWAY_PORT ? GATEWAY_PORT : null,
      installed: {
        packageVersion: safeVersion(pins.packageVersion),
        packageTarballSha256: safeHex(pins.packageTarballSha256),
        installedCliSha256: safeHex(pins.installedCliSha256),
        tailscaleVersion: safeVersion(pins.tailscaleVersion),
        tailscaleArchiveSha256: safeHex(state.tailscaleSha256),
        tailscaleCliSha256: safeHex(pins.tailscaleCliSha256),
        tailscaledSha256: safeHex(pins.tailscaledSha256),
      },
    },
    phases: {
      parking: stage("parking"),
      recovery: stage("recovery"),
      cancel: stage("cancel"),
      cleanup: {
        status: ["passed", "failed", "partial"].includes(cleanupStage?.status)
          ? cleanupStage.status
          : "not_run",
        parkingComplete: cleanupRoles.parking?.complete === true,
        cancelComplete: cleanupRoles.cancel?.complete === true,
        parkingChecks: cleanupChecks("parking"),
        cancelChecks: cleanupChecks("cancel"),
        parkingPrivateDiagnosticsRetained:
          cleanupRoles.parking?.privateDiagnosticsRetained === true,
        cancelPrivateDiagnosticsRetained: cleanupRoles.cancel?.privateDiagnosticsRetained === true,
      },
    },
    limits: {
      upgrade: "not_run",
      crossPeerHttps: "not_run",
      dnsSuffixChecked: state.stages?.recovery?.expectedDnsSuffixMatched === true,
    },
  };
}

function renderMarkdown(result) {
  const checked = (value) => (value === true ? "yes" : value === false ? "no" : "not run");
  const parkingStage = result.phases.parking;
  const recoveryStage = result.phases.recovery;
  const cancelStage = result.phases.cancel;
  return [
    "# OpenClaw PR 167880 runtime proof",
    "",
    `Result: **${result.status}** — ${result.result}.`,
    "",
    `Product source: \`${result.pins.productSha}\``,
    `Workflow source: \`${result.pins.workflowSha}\``,
    `Gateway image: \`${result.pins.gatewayImageId}\``,
    `Tailscale image: \`${result.pins.tailscaleImageId}\``,
    `Gateway port: \`${result.pins.gatewayPort}\``,
    `Installed OpenClaw: ${result.pins.installed.packageVersion ?? "not observed"}; package SHA-256 \`${result.pins.installed.packageTarballSha256 ?? "not observed"}\`; installed CLI SHA-256 \`${result.pins.installed.installedCliSha256 ?? "not observed"}\``,
    `Installed Tailscale: ${result.pins.installed.tailscaleVersion ?? "not observed"}; archive SHA-256 \`${result.pins.installed.tailscaleArchiveSha256 ?? "not observed"}\`; CLI/daemon SHA-256 \`${result.pins.installed.tailscaleCliSha256 ?? "not observed"}\` / \`${result.pins.installed.tailscaledSha256 ?? "not observed"}\``,
    "",
    "| Phase | Status | Evidence |",
    "| --- | --- | --- |",
    `| NeedsLogin parking | ${parkingStage.status} | parked signal ${checked(parkingStage.parkingSignalObserved)}, unit active with Restart=no ${checked(parkingStage.systemdUnitActive && parkingStage.restartPolicyNo)}, no restart ${checked(parkingStage.restartCountZero)}, all TCP listeners absent ${checked(parkingStage.gatewayListenerAbsentBeforeAndAfterBackoff)}, Serve empty ${checked(parkingStage.tailscaleServeEmptyBeforeAndAfterBackoff)} |`,
    `| Real login recovery | ${recoveryStage.status} | DNS suffix ${checked(recoveryStage.expectedDnsSuffixMatched)}, approved tag ${checked(recoveryStage.approvedTagMatched)}, ordinary readyz ${checked(recoveryStage.ordinaryGatewayReadyz)}, foreground backend health ${checked(recoveryStage.foregroundServeBackendHealthz)}, foreground Serve process ${checked(recoveryStage.foregroundServeProcessPresent)} |`,
    `| Joined cancellation | ${cancelStage.status} | parked signal ${checked(cancelStage.parkingSignalObserved)}, graceful exit ${checked(cancelStage.gracefulSystemdStop)}, exit code zero ${checked(cancelStage.gatewayExitCodeZero)}, no OOM ${checked(cancelStage.gatewayNotOomKilled)}, claim released ${checked(cancelStage.serveClaimGoneAfterStop)} |`,
    `| Cleanup | ${result.phases.cleanup.status} | private task logs retained before removal ${checked(result.phases.cleanup.parkingPrivateDiagnosticsRetained && result.phases.cleanup.cancelPrivateDiagnosticsRetained)} |`,
    "",
    "Upgrade survival was not run. This receipt does not prove predecessor upgrade settings preservation or HTTPS reachability from another tailnet peer.",
    "",
  ].join("\n");
}

async function summarize() {
  const context = taskContext();
  const state = readState(context);
  assert(readdirSync(context.publicRoot).length === 0, "public-output-directory-not-empty");
  const result = publicProjection(state);
  const jsonPath = path.join(context.publicRoot, "runtime-proof.json");
  const markdownPath = path.join(context.publicRoot, "runtime-proof.md");
  writePublicJson(jsonPath, result);
  writeFileSync(markdownPath, renderMarkdown(result), { mode: 0o644, flag: "wx" });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "failed") {
    process.exitCode = 1;
  }
}

function phaseFailure(phase, error) {
  const allowedPhase = ["parking", "recovery", "cancel", "cleanup", "summarize"].includes(phase)
    ? phase
    : "startup";
  const systemCode = ["EACCES", "EPERM", "ENOENT", "EEXIST", "ENOTDIR"].includes(error?.code)
    ? `-${error.code.toLowerCase()}`
    : "";
  const candidate =
    error instanceof ProofFailure ? error.category : `${allowedPhase}-failed${systemCode}`;
  const category = /^[a-z0-9-]{1,64}$/.test(candidate) ? candidate : `${allowedPhase}-failed`;
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, phase: allowedPhase, status: "failed", category })}\n`,
  );
  process.exitCode = 1;
}

async function main() {
  const mode = process.argv[2];
  try {
    switch (mode) {
      case "parking":
        await parking();
        break;
      case "recovery":
        await recovery();
        break;
      case "cancel":
        await startCancel();
        break;
      case "cleanup":
        await cleanup();
        break;
      case "summarize":
        await summarize();
        break;
      default:
        fail("mode-invalid");
    }
  } catch (error) {
    phaseFailure(typeof mode === "string" ? mode : "startup", error);
  }
}

await main();

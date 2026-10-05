import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { createServer } from "node:net";

const invitationKey = "openclaw:control-ui:community-invite:v2";
const invitationValue = JSON.stringify({ dismissedAtMs: 1770000000000 });
const sharedAccessExplanation =
  "Connected with the Gateway token or over a tunnel, not a personal sign-in.";
const expectedProfileId = "gateway-owner";
const requestedDisplayNameByCase = {
  named: "Synthetic operator",
  unnamed: "",
  mutation: "Synthetic mutation probe",
};
function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function requireCommit(name) {
  const value = requiredEnvironment(name).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${name} must be a full 40-character Git commit SHA.`);
  }
  return value;
}

function requireSha256(name) {
  const value = requiredEnvironment(name).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} must be a full 64-character SHA-256 hex digest.`);
  }
  return value;
}

function requireDirectory(name) {
  const value = requiredEnvironment(name);
  if (!isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  const path = realpathSync(value);
  if (!statSync(path).isDirectory()) {
    throw new Error(`${name} must resolve to a directory.`);
  }
  return path;
}

function isAtOrInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertUbuntu2404() {
  if (process.platform !== "linux") {
    throw new Error("This helper only runs on the approved Linux qualification runner.");
  }
  const release = readFileSync("/etc/os-release", "utf8");
  const values = Object.fromEntries(
    release.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (!match) {
        return [];
      }
      return [[match[1], match[2].replace(/^\"|\"$/g, "")]];
    }),
  );
  if (values.ID !== "ubuntu" || values.VERSION_ID !== "24.04") {
    throw new Error("This helper requires standard Ubuntu 24.04.");
  }
}

function sanitizedBaseEnvironment() {
  const env = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "TZ", "CI"]) {
    if (process.env[name]) {
      env[name] = process.env[name];
    }
  }
  if (!env.PATH) {
    throw new Error("The runner PATH is missing; pnpm and Git cannot be selected safely.");
  }
  return env;
}

function gitOutput(repoRoot, args, baseEnv) {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", ...args],
    {
      cwd: repoRoot,
      env: {
        ...baseEnv,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    },
  ).trim();
}

function verifyProductCheckout(repoRoot, expectedCommit, baseEnv, label) {
  const reportedRoot = realpathSync(gitOutput(repoRoot, ["rev-parse", "--show-toplevel"], baseEnv));
  if (reportedRoot !== repoRoot) {
    throw new Error(`${label} path is not the root of its Git checkout.`);
  }
  const actualCommit = gitOutput(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"], baseEnv)
    .toLowerCase();
  if (actualCommit !== expectedCommit) {
    throw new Error(`${label} HEAD does not match its required full commit SHA.`);
  }
  const status = gitOutput(
    repoRoot,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    baseEnv,
  );
  if (status) {
    throw new Error(`${label} checkout is not clean; refuse to qualify an edited source tree.`);
  }
  return actualCommit;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function verifyGatewayBuild(gatewayRoot, expectedCommit, expectedEntrySha256) {
  const entryRelativePath = "dist/entry.js";
  const entryPath = resolve(gatewayRoot, entryRelativePath);
  if (!existsSync(entryPath)) {
    throw new Error("The selected Gateway checkout has no dist/entry.js; build it before capture.");
  }
  const entrySha256 = sha256(readFileSync(entryPath));
  if (entrySha256 !== expectedEntrySha256) {
    throw new Error("The built Gateway entry does not match OPENCLAW_QA_EXPECTED_GATEWAY_ENTRY_SHA256.");
  }

  const metadata = {};
  for (const [name, relativePath, commitField] of [
    ["buildInfo", "dist/build-info.json", "commit"],
    ["buildStamp", "dist/.buildstamp", "head"],
    ["runtimePostbuildStamp", "dist/.runtime-postbuildstamp", "head"],
  ]) {
    const metadataPath = resolve(gatewayRoot, relativePath);
    if (!existsSync(metadataPath)) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(metadataPath, "utf8"));
    } catch {
      throw new Error(`The selected Gateway ${name} metadata is invalid JSON.`);
    }
    const recordedCommit = parsed?.[commitField];
    if (typeof recordedCommit === "string" && recordedCommit.toLowerCase() !== expectedCommit) {
      throw new Error(`The selected Gateway ${name} identifies a different source commit.`);
    }
    if (Object.hasOwn(parsed ?? {}, "inputsClean") && parsed.inputsClean !== true) {
      throw new Error(`The selected Gateway ${name} says its build inputs were not clean.`);
    }
    metadata[name] = {
      ...(typeof recordedCommit === "string" ? { commit: recordedCommit.toLowerCase() } : {}),
      ...(Object.hasOwn(parsed ?? {}, "inputsClean") ? { inputsClean: parsed.inputsClean } : {}),
    };
  }
  return {
    entryRelativePath,
    entrySha256,
    expectedEntrySha256,
    metadata,
  };
}

function writeNewArtifact(path, value) {
  writeFileSync(path, value, { flag: "wx" });
}

async function chooseLoopbackPort() {
  const probe = createServer();
  await new Promise((resolvePromise, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = probe.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a loopback Gateway port.");
  }
  const port = address.port;
  await new Promise((resolvePromise, reject) => {
    probe.close((error) => (error ? reject(error) : resolvePromise()));
  });
  return port;
}

async function assertPortAvailable(port) {
  const probe = createServer();
  await new Promise((resolvePromise, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", resolvePromise);
  });
  await new Promise((resolvePromise, reject) => {
    probe.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

async function waitForHealth(child, origin, isInterrupted) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (isInterrupted()) {
      throw new Error("Gateway startup was interrupted.");
    }
    if (child.spawnError) {
      throw new Error("Could not start the task-owned pnpm Gateway process.");
    }
    if (child.exitCode !== null) {
      throw new Error(`Task-owned Gateway exited before health check (${child.exitCode}).`);
    }
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        return;
      }
    } catch {
      // Keep startup bounded by the deadline above.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error("The task-owned Gateway did not become healthy within 90 seconds.");
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) {
      return true;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return !processGroupExists(pid);
}

async function stopTaskOwnedGateway(child) {
  if (!child?.pid) {
    return true;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
  if (await waitForProcessGroupExit(child.pid, 8_000)) {
    return true;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
  return await waitForProcessGroupExit(child.pid, 3_000);
}

async function prepareBrowserStorage(page, origin) {
  await page.goto(`${origin}/health`, { waitUntil: "domcontentloaded" });
  const storedValue = await page.evaluate(
    async ({ key, value }) => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem(key, value);
      const cacheApi = globalThis.caches;
      const cacheNames = cacheApi ? await cacheApi.keys().catch(() => []) : [];
      await Promise.all(cacheNames.map((name) => cacheApi?.delete(name)));
      const registrations = "serviceWorker" in navigator
        ? await navigator.serviceWorker.getRegistrations().catch(() => [])
        : [];
      await Promise.all(registrations.map((registration) => registration.unregister()));
      const databases = await indexedDB.databases?.().catch(() => []);
      await Promise.all(
        (databases ?? []).map(
          (database) =>
            new Promise((resolvePromise) => {
              if (!database.name) {
                resolvePromise();
                return;
              }
              const request = indexedDB.deleteDatabase(database.name);
              request.onsuccess = request.onerror = request.onblocked = () => resolvePromise();
            }),
        ),
      );
      return localStorage.getItem(key);
    },
    { key: invitationKey, value: invitationValue },
  );
  if (storedValue !== invitationValue) {
    throw new Error("The canonical community invitation dismissal was not stored before UI render.");
  }
}

async function assertInvitationDismissed(page) {
  const state = await page.evaluate((key) => ({
    storedValue: localStorage.getItem(key),
    cardCount: document.querySelectorAll(".community-invite-card").length,
  }), invitationKey);
  if (state.storedValue !== invitationValue || state.cardCount !== 0) {
    throw new Error("The community invitation dismissal was not honored by the rendered UI.");
  }
  return state;
}

async function saveUiDiagnostic(page, artifactRoot, name, token) {
  const diagnostic = await page.evaluate(() => ({
    path: `${location.pathname}${location.search}`,
    title: document.title,
    bodyText: document.body.innerText.slice(0, 8_000),
    onlineRows: [...document.querySelectorAll("[data-online-user-id]")].map((row) => ({
      id: row.getAttribute("data-online-user-id"),
      label: row.textContent?.trim(),
    })),
  })).catch(() => ({ captureFailed: true }));
  const safeDiagnostic = JSON.stringify(diagnostic, null, 2).replaceAll(token, "[synthetic token redacted]");
  writeNewArtifact(resolve(artifactRoot, `${name}-diagnostic.json`), `${safeDiagnostic}\n`);
  await page.screenshot({
    path: resolve(artifactRoot, `${name}-diagnostic.png`),
    animations: "disabled",
    fullPage: true,
  }).catch(() => undefined);
}

async function assertOwnerCard(page, expectedLabel, screenshotPath, viewport, artifactRoot, token) {
  if (viewport.width < 700) {
    const navigationToggle = page
      .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
      .first();
    if (await navigationToggle.count()) {
      await navigationToggle.click();
    }
  }
  const owner = page.locator('[data-online-user-id="gateway-owner"]');
  try {
    await owner.waitFor({ state: "visible", timeout: 20_000 });
    await owner.hover();
    await page.locator(".person-activity-hovercard").waitFor({
      state: "visible",
      timeout: 10_000,
    });
  } catch {
    const diagnosticName = basename(screenshotPath, ".png");
    await saveUiDiagnostic(page, artifactRoot, diagnosticName, token);
    throw new Error("The live Gateway owner presence row or its hovercard did not render.");
  }
  const card = page.locator(".person-activity-hovercard");
  const ownerText = await owner.innerText();
  const heading = await card.locator("h2").innerText();
  const explanation = await card.innerText();
  const opened = await card.getAttribute("data-open");
  if (opened !== "true" || !ownerText.includes(expectedLabel) || heading !== expectedLabel) {
    throw new Error("The real Gateway owner hovercard did not show the expected expanded profile label.");
  }
  if (!explanation.includes(sharedAccessExplanation)) {
    throw new Error("The expanded owner card is missing the shared-access explanation.");
  }
  const invitation = await assertInvitationDismissed(page);
  await page.screenshot({ path: screenshotPath, animations: "disabled", fullPage: false });
  return {
    label: heading,
    expanded: opened === "true",
    sharedAccessExplanationPresent: true,
    communityInvitationCardCount: invitation.cardCount,
    viewport,
    screenshot: screenshotPath,
    screenshotSha256: sha256(readFileSync(screenshotPath)),
  };
}

async function main() {
  assertUbuntu2404();
  const uiVariant = requiredEnvironment("OPENCLAW_QA_UI_VARIANT");
  if (!new Set(["baseline", "candidate"]).has(uiVariant)) {
    throw new Error("OPENCLAW_QA_UI_VARIANT must be baseline or candidate.");
  }
  const qaCase = requiredEnvironment("OPENCLAW_QA_CASE");
  if (!Object.hasOwn(requestedDisplayNameByCase, qaCase)) {
    throw new Error("OPENCLAW_QA_CASE must be named, unnamed, or mutation.");
  }
  const uiRoot = requireDirectory("OPENCLAW_QA_UI_REPO_ROOT");
  const gatewayRoot = requireDirectory("OPENCLAW_QA_GATEWAY_REPO_ROOT");
  const artifactRoot = requireDirectory("OPENCLAW_QA_ARTIFACT_DIR");
  const expectedUiCommit = requireCommit("OPENCLAW_QA_EXPECTED_UI_COMMIT");
  const expectedGatewayCommit = requireCommit("OPENCLAW_QA_EXPECTED_GATEWAY_COMMIT");
  const expectedGatewayEntrySha256 = requireSha256("OPENCLAW_QA_EXPECTED_GATEWAY_ENTRY_SHA256");
  const expectedUiIndexSha256 = requireSha256("OPENCLAW_QA_EXPECTED_UI_INDEX_SHA256");
  const expectedUiMainAssetSha256 = requireSha256("OPENCLAW_QA_EXPECTED_UI_MAIN_ASSET_SHA256");
  if ([uiRoot, gatewayRoot].some((productRoot) => isAtOrInside(productRoot, artifactRoot))) {
    throw new Error("OPENCLAW_QA_ARTIFACT_DIR must be outside both product checkouts.");
  }
  if (readdirSync(artifactRoot).length !== 0) {
    throw new Error("OPENCLAW_QA_ARTIFACT_DIR must be a fresh empty per-case directory.");
  }

  const baseEnv = sanitizedBaseEnvironment();
  const uiCommit = verifyProductCheckout(uiRoot, expectedUiCommit, baseEnv, "UI");
  const gatewayCommit = verifyProductCheckout(
    gatewayRoot,
    expectedGatewayCommit,
    baseEnv,
    "Gateway",
  );
  const gatewayBuildIdentity = verifyGatewayBuild(
    gatewayRoot,
    expectedGatewayCommit,
    expectedGatewayEntrySha256,
  );
  const uiDistRoot = resolve(uiRoot, "dist", "control-ui");
  const localIndexPath = resolve(uiDistRoot, "index.html");
  if (!existsSync(localIndexPath)) {
    throw new Error("The verified UI checkout has no built dist/control-ui/index.html.");
  }
  let mainAssetRelativePath;
  let localMainAssetPath;
  let localIndexSha256;
  let servedIndexSha256;
  let localMainAssetSha256;
  let servedMainAssetSha256;
  const uiAssetDigests = {
    expected: {
      indexSha256: expectedUiIndexSha256,
      mainAssetSha256: expectedUiMainAssetSha256,
    },
    observed: {},
  };
  const requireFromGateway = createRequire(resolve(gatewayRoot, "package.json"));
  let chromium;
  try {
    ({ chromium } = requireFromGateway("playwright"));
  } catch (error) {
    throw new Error(
      "The verified Gateway product dependency root must have its existing Playwright package installed.",
      { cause: error },
    );
  }
  const browserExecutablePath = chromium.executablePath();
  if (!existsSync(browserExecutablePath)) {
    throw new Error("The preinstalled Playwright Chromium executable is unavailable.");
  }

  const stateRoot = resolve(artifactRoot, "runtime", "openclaw");
  const isolatedHome = resolve(artifactRoot, "runtime", "home");
  const isolatedTemp = resolve(artifactRoot, "runtime", "tmp");
  const workspacePath = resolve(stateRoot, "workspace");
  const agentDir = resolve(stateRoot, "agents", "main", "agent");
  const configPath = resolve(stateRoot, "openclaw.json");
  for (const directory of [stateRoot, isolatedHome, isolatedTemp, workspacePath, agentDir]) {
    mkdirSync(directory, { recursive: true });
  }
  const port = await chooseLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  const profileName = `operator-token-capture-${uiVariant}-${qaCase}`;
  const token = randomBytes(32).toString("hex");
  const runtimeEnv = {
    ...baseEnv,
    HOME: isolatedHome,
    XDG_CACHE_HOME: resolve(isolatedHome, ".cache"),
    XDG_CONFIG_HOME: resolve(isolatedHome, ".config"),
    TMPDIR: isolatedTemp,
    TMP: isolatedTemp,
    TEMP: isolatedTemp,
    OPENCLAW_PROFILE: profileName,
    OPENCLAW_STATE_DIR: stateRoot,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_GATEWAY_PORT: String(port),
    OPENCLAW_GATEWAY_TOKEN: token,
  };
  const gatewayConfig = {
    agents: {
      entries: {
        main: {
          name: "main",
          workspace: workspacePath,
          agentDir,
          identity: { name: "main" },
        },
      },
      defaults: { workspace: workspacePath, skipBootstrap: true },
    },
    gateway: {
      mode: "local",
      auth: {
        mode: "token",
        token: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" },
      },
      port,
      bind: "loopback",
      controlUi: { root: uiDistRoot },
      tailscale: { mode: "off" },
    },
    tools: { profile: "full" },
  };
  writeNewArtifact(configPath, `${JSON.stringify(gatewayConfig, null, 2)}\n`);
  const logPath = resolve(artifactRoot, "gateway.log");
  writeNewArtifact(logPath, "");

  const browserEnv = {
    ...baseEnv,
    HOME: isolatedHome,
    XDG_CACHE_HOME: resolve(isolatedHome, ".cache"),
    XDG_CONFIG_HOME: resolve(isolatedHome, ".config"),
    TMPDIR: isolatedTemp,
    TMP: isolatedTemp,
    TEMP: isolatedTemp,
  };

  let gateway;
  let browser;
  let context;
  let result;
  let failure;
  let interruptedBy;
  let interruptionShutdownPromise;
  let browserClosed = true;
  let gatewayProcessGroupStopped = true;
  let gatewayPortReleased = false;
  const closeBrowser = async () => {
    if (context) {
      await context.close().catch(() => undefined);
    }
    if (browser) {
      await browser.close().catch(() => undefined);
      browserClosed = !browser.isConnected();
    }
  };
  const onInterrupt = (signal) => {
    if (interruptedBy) {
      return;
    }
    interruptedBy = signal;
    interruptionShutdownPromise = (async () => {
      gatewayProcessGroupStopped = await stopTaskOwnedGateway(gateway).catch(() => false);
      await closeBrowser();
    })();
    void interruptionShutdownPromise.catch(() => {
      browserClosed = false;
      gatewayProcessGroupStopped = false;
    });
  };
  const onSigint = () => onInterrupt("SIGINT");
  const onSigterm = () => onInterrupt("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    await assertPortAvailable(port);
    gateway = spawn("pnpm", ["openclaw", "gateway", "--port", String(port), "--bind", "loopback"], {
      cwd: gatewayRoot,
      env: runtimeEnv,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    gateway.spawnError = null;
    gateway.once("error", (error) => {
      gateway.spawnError = error;
    });
    let gatewayLogBytes = 0;
    const maxGatewayLogBytes = 2 * 1024 * 1024;
    let logTruncationRecorded = false;
    const appendBoundedGatewayLog = (text) => {
      const sanitized = text
        .replaceAll(token, "[synthetic token redacted]")
        .replaceAll(artifactRoot, "[task artifacts]");
      const available = maxGatewayLogBytes - gatewayLogBytes;
      if (available <= 0) {
        return;
      }
      const bounded = Buffer.from(sanitized).subarray(0, available);
      appendFileSync(logPath, bounded);
      gatewayLogBytes += bounded.byteLength;
      if (bounded.byteLength < Buffer.byteLength(sanitized) && !logTruncationRecorded) {
        appendFileSync(logPath, "\n[Gateway output truncated at 2 MiB]\n");
        logTruncationRecorded = true;
      }
    };
    for (const stream of [gateway.stdout, gateway.stderr]) {
      if (!stream) {
        continue;
      }
      const decoder = new StringDecoder("utf8");
      let pending = "";
      let droppingLongLine = false;
      const maxGatewayLogLineChars = 64 * 1024;
      const consumeLogText = (text) => {
        let remaining = pending + text;
        pending = "";
        while (remaining.length > 0) {
          const newline = remaining.indexOf("\n");
          if (droppingLongLine) {
            if (newline < 0) {
              return;
            }
            remaining = remaining.slice(newline + 1);
            droppingLongLine = false;
            continue;
          }
          if (newline >= 0) {
            appendBoundedGatewayLog(`${remaining.slice(0, newline)}\n`);
            remaining = remaining.slice(newline + 1);
            continue;
          }
          if (remaining.length > maxGatewayLogLineChars) {
            appendBoundedGatewayLog("[Gateway log line omitted: over 64 KiB]\n");
            droppingLongLine = true;
            return;
          }
          pending = remaining;
          return;
        }
      };
      stream.on("data", (chunk) => {
        consumeLogText(decoder.write(chunk));
      });
      stream.on("end", () => {
        consumeLogText(decoder.end());
        if (!droppingLongLine && pending) {
          appendBoundedGatewayLog(pending);
        }
        pending = "";
      });
    }
    if (interruptedBy) {
      throw new Error("Gateway startup was interrupted.");
    }
    await waitForHealth(gateway, origin, () => Boolean(interruptedBy));

    const indexResponse = await fetch(origin, { headers: { "accept-encoding": "identity" } });
    if (!indexResponse.ok) {
      throw new Error(`Gateway UI root returned HTTP ${indexResponse.status}.`);
    }
    const servedIndex = Buffer.from(await indexResponse.arrayBuffer());
    const localIndex = readFileSync(localIndexPath);
    servedIndexSha256 = sha256(servedIndex);
    localIndexSha256 = sha256(localIndex);
    uiAssetDigests.observed.index = {
      localSha256: localIndexSha256,
      servedSha256: servedIndexSha256,
    };
    if (servedIndexSha256 !== localIndexSha256) {
      throw new Error("Gateway-served UI index does not match the selected UI checkout's build output.");
    }
    if (localIndexSha256 !== expectedUiIndexSha256 || servedIndexSha256 !== expectedUiIndexSha256) {
      throw new Error("The UI index does not match the caller's fresh-build SHA-256 receipt.");
    }
    const servedIndexText = servedIndex.toString("utf8");
    const mainScriptUrl = servedIndexText.match(/<script\b[^>]*\bsrc=[\"']([^\"']+\.js(?:\?[^\"']*)?)[\"']/i)?.[1];
    if (!mainScriptUrl) {
      writeNewArtifact(resolve(artifactRoot, "served-index.html"), servedIndex);
      throw new Error("The Gateway-served UI index has no identifiable main JavaScript asset.");
    }
    const mainAssetUrl = new URL(mainScriptUrl, origin);
    const mainAssetResponse = await fetch(mainAssetUrl, {
      headers: { "accept-encoding": "identity" },
    });
    if (!mainAssetResponse.ok) {
      throw new Error(`Gateway UI main asset returned HTTP ${mainAssetResponse.status}.`);
    }
    const servedMainAsset = Buffer.from(await mainAssetResponse.arrayBuffer());
    mainAssetRelativePath = decodeURIComponent(mainAssetUrl.pathname.replace(/^\//, ""));
    localMainAssetPath = resolve(uiDistRoot, mainAssetRelativePath);
    if (!isAtOrInside(uiDistRoot, localMainAssetPath)) {
      throw new Error("The served main JavaScript path escaped the selected UI build directory.");
    }
    const localMainAsset = readFileSync(localMainAssetPath);
    servedMainAssetSha256 = sha256(servedMainAsset);
    localMainAssetSha256 = sha256(localMainAsset);
    uiAssetDigests.observed.mainAsset = {
      relativePath: mainAssetRelativePath,
      localSha256: localMainAssetSha256,
      servedSha256: servedMainAssetSha256,
    };
    if (servedMainAssetSha256 !== localMainAssetSha256) {
      throw new Error("Gateway-served main JavaScript does not match the selected UI build output.");
    }
    if (localMainAssetSha256 !== expectedUiMainAssetSha256 || servedMainAssetSha256 !== expectedUiMainAssetSha256) {
      throw new Error("The UI main JavaScript does not match the caller's fresh-build SHA-256 receipt.");
    }

    browser = await chromium.launch({
      headless: true,
      timeout: 30_000,
      env: browserEnv,
    });
    context = await browser.newContext({
      locale: "en-US",
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const pendingProfileMutations = new Map();
    const profileMutationWaiters = [];
    const profileMutationResponses = [];
    function createProfileMutationWaiter() {
      let resolvePromise;
      let rejectPromise;
      let timeout;
      let settled = false;
      const waiter = {
        resolve(response) {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          resolvePromise(response);
        },
        reject(error) {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          const index = profileMutationWaiters.indexOf(waiter);
          if (index >= 0) {
            profileMutationWaiters.splice(index, 1);
          }
          rejectPromise(error);
        },
      };
      const promise = new Promise((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });
      timeout = setTimeout(
        () => waiter.reject(new Error("users.setDisplayName did not return in 20 seconds.")),
        20_000,
      );
      profileMutationWaiters.push(waiter);
      return { promise, cancel: (error) => waiter.reject(error) };
    }
    page.on("websocket", (socket) => {
      socket.on("framesent", (frame) => {
        try {
          const payload = JSON.parse(String(frame.payload));
          if (payload.method === "users.setDisplayName" && typeof payload.id === "string") {
            const waiter = profileMutationWaiters.shift();
            pendingProfileMutations.set(payload.id, {
              method: payload.method,
              profileId: payload.params?.profileId,
              displayName: payload.params?.displayName,
              waiter,
            });
          }
        } catch {
          // Non-JSON browser WebSocket frames are outside the profile-edit proof.
        }
      });
      socket.on("framereceived", (frame) => {
        try {
          const payload = JSON.parse(String(frame.payload));
          const request = pendingProfileMutations.get(payload.id);
          if (!request) {
            return;
          }
          pendingProfileMutations.delete(payload.id);
          const { waiter, ...requestDetails } = request;
          const response = {
            ...requestDetails,
            ok: payload.ok === true,
            ...(payload.error
              ? { errorCode: payload.error.code, errorMessage: payload.error.message }
              : {}),
          };
          profileMutationResponses.push(response);
          waiter?.resolve(response);
        } catch {
          // Non-JSON browser WebSocket frames are outside the profile-edit proof.
        }
      });
    });

    async function reloadAndAssertDisplayName(expectedDisplayName) {
      await page.reload({ waitUntil: "domcontentloaded" });
      await displayName.waitFor({ state: "visible", timeout: 20_000 });
      await page.waitForFunction(
        (expected) => document.querySelector(".identity-name-control input")?.value === expected,
        expectedDisplayName,
        { timeout: 20_000 },
      );
      const persistedDisplayName = await displayName.inputValue();
      if (persistedDisplayName !== expectedDisplayName) {
        throw new Error("The profile display name did not persist after reload.");
      }
    }

    async function saveDisplayNameThroughUi(expectedDisplayName) {
      const waiter = createProfileMutationWaiter();
      try {
        await displayName.fill(expectedDisplayName);
        await page.getByRole("button", { name: "Save", exact: true }).click();
        const response = await waiter.promise;
        if (
          response.ok !== true ||
          response.profileId !== expectedProfileId ||
          response.displayName !== (expectedDisplayName || null)
        ) {
          throw new Error("The actual UI users.setDisplayName acknowledgement did not match the requested gateway-owner value.");
        }
        await reloadAndAssertDisplayName(expectedDisplayName);
        return response;
      } catch (error) {
        waiter.cancel(error);
        await waiter.promise.catch(() => undefined);
        throw error;
      }
    }

    await prepareBrowserStorage(page, origin);
    await page.goto(`${origin}/settings/profile#token=${token}`, { waitUntil: "domcontentloaded" });
    const displayName = page.getByLabel("Display name", { exact: true });
    try {
      await displayName.waitFor({ state: "visible", timeout: 30_000 });
    } catch {
      await saveUiDiagnostic(page, artifactRoot, `${uiVariant}-${qaCase}-profile`, token);
      throw new Error("The live profile page did not expose its Display name control.");
    }
    const tokenFragmentRemoved = await page.evaluate(() => !location.hash.includes("token="));
    if (!tokenFragmentRemoved) {
      throw new Error("The browser did not remove the synthetic token fragment after bootstrap.");
    }

    const requestedDisplayName = requestedDisplayNameByCase[qaCase];
    const initialDisplayName = await displayName.inputValue();
    const profileMutationTargets = qaCase === "mutation"
      ? [requestedDisplayNameByCase.named, requestedDisplayName]
      : [requestedDisplayName];
    const profileMutations = [];
    if (qaCase === "mutation") {
      if (initialDisplayName === profileMutationTargets[0]) {
        throw new Error("The mutation case requires a fresh profile that is not already named Synthetic operator.");
      }
      profileMutations.push(await saveDisplayNameThroughUi(profileMutationTargets[0]));
      profileMutations.push(await saveDisplayNameThroughUi(profileMutationTargets[1]));
      if (
        profileMutationResponses.length !== 2 ||
        profileMutationTargets.some((expected, index) => {
          const response = profileMutationResponses[index];
          return (
            !response ||
            response.ok !== true ||
            response.profileId !== expectedProfileId ||
            response.displayName !== expected
          );
        })
      ) {
        throw new Error("The mutation case did not capture both acknowledged gateway-owner display-name changes in order.");
      }
    } else if (initialDisplayName !== requestedDisplayName) {
      profileMutations.push(await saveDisplayNameThroughUi(requestedDisplayName));
    } else {
      await reloadAndAssertDisplayName(requestedDisplayName);
    }
    const profileMutation = profileMutations.at(-1) ?? null;

    // Select the ordinary seeded session without configuring a model or sending a prompt.
    await page.goto(`${origin}/chat/main?session=agent%3Amain%3Amain`, {
      waitUntil: "domcontentloaded",
    });
    const expectedOwnerLabel =
      uiVariant === "candidate" && requestedDisplayName
        ? `${requestedDisplayName} · Shared owner`
        : "Shared owner";
    const desktopScreenshot = resolve(artifactRoot, `${uiVariant}-${qaCase}-owner-desktop.png`);
    const mobileScreenshot = resolve(artifactRoot, `${uiVariant}-${qaCase}-owner-mobile.png`);
    const desktopOwnerCard = await assertOwnerCard(
      page,
      expectedOwnerLabel,
      desktopScreenshot,
      { width: 1440, height: 1000 },
      artifactRoot,
      token,
    );

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileOwnerCard = await assertOwnerCard(
      page,
      expectedOwnerLabel,
      mobileScreenshot,
      { width: 390, height: 844 },
      artifactRoot,
      token,
    );
    result = {
      schemaVersion: 1,
      status: "passed",
      uiVariant,
      qaCase,
      sourceProvenance: {
        uiRepoRoot: uiRoot,
        uiCommit,
        expectedUiCommit,
        gatewayRepoRoot: gatewayRoot,
        gatewayCommit,
        expectedGatewayCommit,
        gatewayBuildIdentity,
        gatewayServesExplicitUiRepo: true,
        uiAssetDigests,
      },
      gateway: {
        bind: "loopback",
        port,
        profile: profileName,
        browserToken: "process-only synthetic token; value omitted",
      },
      browser: {
        engine: "Playwright Chromium",
        version: browser.version(),
        executablePath: browserExecutablePath,
      },
      communityInvitation: {
        key: invitationKey,
        value: invitationValue,
        canonicalValueStoredBeforeFirstUiRender: true,
        cardAbsentInDesktopAndMobileScreenshots: true,
      },
      profile: {
        profileId: expectedProfileId,
        initialDisplayName,
        requestedDisplayName,
        mutationTargets: profileMutationTargets,
        persistedAfterReload: requestedDisplayName,
        mutation: profileMutation,
        mutationResponses: profileMutationResponses,
      },
      tokenFragmentRemoved,
      ownerCards: { desktop: desktopOwnerCard, mobile: mobileOwnerCard },
    };
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    if (token) {
      failure = failure.replaceAll(token, "[synthetic token redacted]");
    }
    failure = failure.replaceAll(artifactRoot, "[task artifacts]");
    if (interruptedBy) {
      failure = `${interruptedBy}: ${failure}`;
    }
  } finally {
    await interruptionShutdownPromise?.catch(() => undefined);
    await closeBrowser();
    gatewayProcessGroupStopped = await stopTaskOwnedGateway(gateway).catch(() => false);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }

  try {
    await assertPortAvailable(port);
    gatewayPortReleased = true;
  } catch {
    gatewayPortReleased = false;
  }
  if (!browserClosed || !gatewayProcessGroupStopped || !gatewayPortReleased) {
    failure ??= "Task-owned browser and Gateway process cleanup could not be verified.";
  }
  try {
    const uiCommitAfter = verifyProductCheckout(uiRoot, expectedUiCommit, baseEnv, "UI");
    const gatewayCommitAfter = verifyProductCheckout(
      gatewayRoot,
      expectedGatewayCommit,
      baseEnv,
      "Gateway",
    );
    if (uiCommitAfter !== uiCommit || gatewayCommitAfter !== gatewayCommit) {
      failure ??= "A product checkout identity changed during the isolated run.";
    }
    const gatewayBuildAfter = verifyGatewayBuild(
      gatewayRoot,
      expectedGatewayCommit,
      expectedGatewayEntrySha256,
    );
    if (gatewayBuildAfter.entrySha256 !== gatewayBuildIdentity.entrySha256) {
      failure ??= "The selected Gateway runtime entry changed during the isolated run.";
    }
  } catch {
    failure ??= "A product checkout changed during the isolated run.";
  }
  try {
    const localIndexAfterCleanupSha256 = sha256(readFileSync(localIndexPath));
    if (!localMainAssetPath || !mainAssetRelativePath) {
      throw new Error("The UI main asset was not resolved before cleanup.");
    }
    const localMainAssetAfterCleanupSha256 = sha256(readFileSync(localMainAssetPath));
    uiAssetDigests.observed.afterCleanup = {
      localIndexSha256: localIndexAfterCleanupSha256,
      capturedServedIndexSha256: servedIndexSha256,
      localMainAssetSha256: localMainAssetAfterCleanupSha256,
      capturedServedMainAssetSha256: servedMainAssetSha256,
    };
    if (
      localIndexAfterCleanupSha256 !== expectedUiIndexSha256 ||
      servedIndexSha256 !== expectedUiIndexSha256 ||
      localMainAssetAfterCleanupSha256 !== expectedUiMainAssetSha256 ||
      servedMainAssetSha256 !== expectedUiMainAssetSha256
    ) {
      failure ??= "The selected UI build artifacts changed or failed their fresh-build SHA-256 receipt after cleanup.";
    }
  } catch {
    failure ??= "The selected UI build artifacts could not be verified after cleanup.";
  }
  if (interruptedBy) {
    failure ??= `${interruptedBy}: qualification interrupted before completion.`;
  }

  const finalResult = {
    ...(result ?? {
      schemaVersion: 1,
      uiVariant,
      qaCase,
      sourceProvenance: {
        uiRepoRoot: uiRoot,
        expectedUiCommit,
        gatewayRepoRoot: gatewayRoot,
        expectedGatewayCommit,
        gatewayBuildIdentity,
        uiAssetDigests,
      },
    }),
    status: failure ? "failed" : "passed",
    cleanup: {
      browserClosed,
      gatewayProcessGroupStopped,
      gatewayPortReleased,
    },
    ...(failure ? { error: failure } : {}),
  };
  writeNewArtifact(resolve(artifactRoot, "result.json"), `${JSON.stringify(finalResult, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(finalResult, null, 2)}\n`);
  if (failure) {
    process.exitCode = 1;
  }
}

await main();

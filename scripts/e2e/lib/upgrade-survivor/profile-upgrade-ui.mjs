#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire("/opt/openclaw-published-driver-browser/package.json");
const { chromium } = require("playwright-core");
const [
  mode,
  baseUrlArg,
  artifactsDir,
  browserProfileDir,
  expectedProfileId,
  stableName,
  candidateName,
] = process.argv.slice(2);
const token = process.env.OPENCLAW_GATEWAY_TOKEN;
assert(token, "Expected the synthetic Gateway token in the child environment");
assert(mode === "stable-seed" || mode === "candidate-revisit", "Unknown profile proof mode");
const baseUrl = new URL(baseUrlArg);
const profileUrl = new URL("settings/profile", baseUrl);
const onboardingUrl = new URL("custodian?onboarding=1", baseUrl);
for (const url of [profileUrl, onboardingUrl]) {
  url.hash = new URLSearchParams({ token }).toString();
}

const gatewayResponseRegistries = new WeakMap();

function createGatewayResponseRegistry(page) {
  const sockets = new Map();
  const observers = new Set();
  const onSocket = (socket) => {
    if (sockets.has(socket)) return;
    const pendingIds = new Set();
    const onFrameSent = ({ payload }) => {
      try {
        const frame = JSON.parse(String(payload));
        if (frame.type !== "req" || typeof frame.id !== "string") return;
        for (const observer of observers) {
          if (observer.method === frame.method && !observer.settled) {
            observer.pending.add(frame.id);
            pendingIds.add(frame.id);
          }
        }
      } catch {}
    };
    const onFrameReceived = ({ payload }) => {
      try {
        const frame = JSON.parse(String(payload));
        if (frame.type !== "res" || typeof frame.id !== "string") return;
        pendingIds.delete(frame.id);
        for (const observer of observers) {
          if (observer.pending.delete(frame.id)) {
            observer.settled = true;
            observers.delete(observer);
            if (frame.ok === true) observer.resolve(frame.payload);
            else observer.reject(new Error(`${observer.method} failed`));
            break;
          }
        }
      } catch {}
    };
    const onClose = () => {
      for (const observer of observers) {
        let closedRequest = false;
        for (const id of pendingIds) {
          closedRequest = observer.pending.delete(id) || closedRequest;
        }
        if (closedRequest && observer.pending.size === 0) {
          observer.settled = true;
          observers.delete(observer);
          observer.reject(new Error(`${observer.method} socket closed before its response`));
        }
      }
      pendingIds.clear();
      socket.off("framesent", onFrameSent);
      socket.off("framereceived", onFrameReceived);
      socket.off("close", onClose);
      sockets.delete(socket);
    };
    sockets.set(socket, { onFrameSent, onFrameReceived, onClose, pendingIds });
    socket.on("framesent", onFrameSent);
    socket.on("framereceived", onFrameReceived);
    socket.on("close", onClose);
  };
  page.on("websocket", onSocket);
  return {
    observe(method) {
      let resolve;
      let reject;
      const response = new Promise((resolveResponse, rejectResponse) => {
        resolve = resolveResponse;
        reject = rejectResponse;
      });
      void response.catch(() => {});
      const observer = { method, pending: new Set(), resolve, reject, settled: false };
      observers.add(observer);
      return {
        response,
        stop() {
          observers.delete(observer);
          for (const id of observer.pending) {
            for (const listeners of sockets.values()) listeners.pendingIds.delete(id);
          }
          observer.pending.clear();
        },
      };
    },
    dispose() {
      page.off("websocket", onSocket);
      for (const observer of observers) {
        observer.settled = true;
        observer.reject(new Error(`${observer.method} response registry disposed`));
        observer.pending.clear();
      }
      observers.clear();
      for (const [socket, listeners] of sockets) {
        socket.off("framesent", listeners.onFrameSent);
        socket.off("framereceived", listeners.onFrameReceived);
        socket.off("close", listeners.onClose);
        listeners.pendingIds.clear();
      }
      sockets.clear();
    },
  };
}

function observeGatewayMethodResponse(page, method) {
  const registry = gatewayResponseRegistries.get(page);
  assert(registry, "Gateway response registry must be installed before page navigation");
  return registry.observe(method);
}

function waitForInputValue(page, selector, value) {
  return page.waitForFunction(
    ({ selector: target, value: expected }) => {
      const element = document.querySelector(target);
      return element instanceof HTMLInputElement && element.value === expected;
    },
    { selector, value },
    { timeout: 30_000 },
  );
}

function withTimeout(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 30_000);
    }),
  ]).finally(() => clearTimeout(timer));
}

function profileFrom(result) {
  assert.equal(typeof result?.profile?.id, "string", "users.self omitted its profile ID");
  return result.profile;
}

function displayName(profile) {
  return profile.displayName ?? "";
}

async function readSelfAfterNavigation(page, url) {
  const observed = observeGatewayMethodResponse(page, "users.self");
  try {
    const navigation = page.url() === url.href ? await page.reload() : await page.goto(url.href);
    assert.equal(navigation?.status(), 200, "Control UI navigation did not return HTTP 200");
    return profileFrom(await withTimeout(observed.response, "users.self"));
  } finally {
    observed.stop();
  }
}

async function saveVisibleProfileName(page, value) {
  const input = page.locator(".identity-name-control input");
  await input.waitFor({ state: "visible", timeout: 30_000 });
  await input.fill(value);
  const observed = observeGatewayMethodResponse(page, "users.setDisplayName");
  try {
    await input.press("Enter");
    await withTimeout(observed.response, "users.setDisplayName");
  } finally {
    observed.stop();
  }
  await waitForInputValue(page, ".identity-name-control input", value);
  const refreshed = await readSelfAfterNavigation(page, profileUrl);
  assert.equal(displayName(refreshed), value, "Visible Profile save did not persist through Gateway");
  return refreshed;
}

async function stableSeed(page, screenshots) {
  const profile = await readSelfAfterNavigation(page, profileUrl);
  assert.equal(displayName(profile), "", "Stable baseline unexpectedly has a display name");
  const saved = await saveVisibleProfileName(page, stableName);
  assert.equal(saved.id, profile.id, "Stable name save changed the authenticated profile");
  await page.screenshot({ path: path.join(screenshots, "stable-profile-created.png") });
  return {
    profileId: saved.id,
    stableDisplayName: displayName(saved),
    actions: ["authenticated-control-ui-users.self", "visible-profile-name-save"],
  };
}

async function candidateRevisit(page, screenshots) {
  assert(expectedProfileId && stableName && candidateName, "Expected migrated profile proof inputs");
  const migrated = await readSelfAfterNavigation(page, profileUrl);
  assert.equal(migrated.id, expectedProfileId, "Candidate UI authenticated as a different profile");
  assert.equal(displayName(migrated), stableName, "Stable profile name did not survive update");
  await waitForInputValue(page, ".identity-name-control input", stableName);
  await page.screenshot({ path: path.join(screenshots, "candidate-profile-preserved.png") });

  const profileInput = page.locator(".identity-name-control input");
  await profileInput.fill("");
  const clear = observeGatewayMethodResponse(page, "users.setDisplayName");
  try {
    await profileInput.press("Enter");
    await withTimeout(clear.response, "users.setDisplayName clear");
  } finally {
    clear.stop();
  }
  const cleared = await readSelfAfterNavigation(page, profileUrl);
  assert.equal(cleared.id, expectedProfileId, "Clearing the profile changed its identity");
  assert.equal(displayName(cleared), "", "Candidate Profile did not clear the migrated name");
  await waitForInputValue(page, ".identity-name-control input", "");
  await page.screenshot({ path: path.join(screenshots, "candidate-profile-cleared.png") });

  let self = await readSelfAfterNavigation(page, onboardingUrl);
  assert.equal(self.id, expectedProfileId, "Candidate onboarding changed the migrated profile");
  assert.equal(displayName(self), "", "Expected an unnamed migrated profile before onboarding");
  const prompt = page.locator(".custodian__name-prompt");
  await prompt.waitFor({ state: "visible", timeout: 30_000 });
  await waitForInputValue(page, "#custodian-onboarding-display-name", "");
  await page.screenshot({ path: path.join(screenshots, "candidate-onboarding-prompt.png") });
  await page.getByRole("button", { name: "Maybe later", exact: true }).click();
  await prompt.waitFor({ state: "detached", timeout: 30_000 });
  await page.locator(".custodian-surface").waitFor({ state: "visible", timeout: 30_000 });
  await page.screenshot({ path: path.join(screenshots, "candidate-onboarding-skipped.png") });

  await page.goto(profileUrl.href);
  await waitForInputValue(page, ".identity-name-control input", "");
  self = await readSelfAfterNavigation(page, onboardingUrl);
  assert.equal(self.id, expectedProfileId);
  assert.equal(displayName(self), "", "Skipping onboarding changed the unnamed profile");
  await prompt.waitFor({ state: "visible", timeout: 30_000 });
  await waitForInputValue(page, "#custodian-onboarding-display-name", "");
  await page.screenshot({ path: path.join(screenshots, "candidate-onboarding-revisited.png") });

  await page.locator("#custodian-onboarding-display-name").fill(candidateName);
  const save = observeGatewayMethodResponse(page, "users.setDisplayName");
  try {
    await page.getByRole("button", { name: "Save name", exact: true }).click();
    await withTimeout(save.response, "users.setDisplayName onboarding save");
  } finally {
    save.stop();
  }
  await prompt.waitFor({ state: "detached", timeout: 30_000 });
  await page.locator(".custodian-surface").waitFor({ state: "visible", timeout: 30_000 });
  await page.screenshot({ path: path.join(screenshots, "candidate-onboarding-saved.png") });

  const saved = await readSelfAfterNavigation(page, profileUrl);
  assert.equal(saved.id, expectedProfileId, "Onboarding save changed the migrated profile identity");
  assert.equal(displayName(saved), candidateName, "Onboarding save did not persist the candidate name");
  await waitForInputValue(page, ".identity-name-control input", candidateName);
  await page.screenshot({ path: path.join(screenshots, "candidate-profile-saved.png") });

  const revisited = await readSelfAfterNavigation(page, onboardingUrl);
  assert.equal(revisited.id, expectedProfileId);
  assert.equal(displayName(revisited), candidateName);
  await page.locator(".custodian-surface").waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await prompt.count(), 0, "Named profile still shows the onboarding prompt");
  await page.screenshot({ path: path.join(screenshots, "candidate-onboarding-existing-name.png") });
  return {
    profileId: revisited.id,
    stableDisplayName: stableName,
    candidateDisplayName: displayName(revisited),
    actions: [
      "candidate-ui-observed-stable-profile",
      "visible-profile-clear-after-preservation-check",
      "onboarding-skip",
      "onboarding-revisit",
      "onboarding-save",
      "named-onboarding-revisit",
    ],
  };
}

async function main() {
  const context = await chromium.launchPersistentContext(browserProfileDir, {
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    viewport: { width: 1440, height: 1000 },
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const gatewayResponses = createGatewayResponseRegistry(page);
    gatewayResponseRegistries.set(page, gatewayResponses);
    const devtools = await context.newCDPSession(page);
    await devtools.send("Network.enable");
    await devtools.send("Network.setCacheDisabled", { cacheDisabled: true });
    const screenshots = artifactsDir;
    const receipt =
      mode === "stable-seed"
        ? await stableSeed(page, screenshots)
        : await candidateRevisit(page, screenshots);
    console.log(JSON.stringify(receipt));
    await devtools.detach();
  } finally {
    for (const page of context.pages()) {
      gatewayResponseRegistries.get(page)?.dispose();
    }
    await context.close();
  }
}

main().catch((error) => {
  const encodedToken = new URLSearchParams({ token }).toString().slice("token=".length);
  const message = [token, encodeURIComponent(token), encodedToken]
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .reduce((result, value) => result.replaceAll(value, "[redacted]"), String(error));
  console.error(message);
  process.exitCode = 1;
});

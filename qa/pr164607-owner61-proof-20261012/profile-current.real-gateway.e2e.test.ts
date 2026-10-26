import { createHash } from "node:crypto";
// Control UI proof against an isolated real Gateway and trusted user identity.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { listCanonicalUserChannelIdentities } from "../../../src/state/user-channel-identity-operations.ts";
import { setDisplayName } from "../../../src/state/user-profile-writes.worker.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { COMMUNITY_INVITE_KEY } from "../components/community-invite-state.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI profile page real Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const authenticatedUser = "primary.user@example.test";
const variant = process.env.OPENCLAW_PROFILE_QA_VARIANT;
const viewports = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;
const channelIdentityRpcMethods = [
  "users.listChannelIdentities",
  "users.linkChannelIdentity",
  "users.unlinkChannelIdentity",
] as const;
const channelIdentityRpcErrorCodes = [
  "INVALID_REQUEST",
  "FORBIDDEN",
  "UNAVAILABLE",
] as const;
type ChannelIdentityRpcMethod = (typeof channelIdentityRpcMethods)[number];
type ChannelIdentityRpcObservation = {
  method: ChannelIdentityRpcMethod;
  outcome: "pending" | "ok" | "error" | "connection-closed";
  errorCode?: (typeof channelIdentityRpcErrorCodes)[number] | "other";
  requestMatchesFixture?: boolean;
  responseMatchesFixture?: boolean;
};
type ChannelIdentityAddPhase =
  | "started"
  | "filling-channel-id"
  | "channel-id-filled"
  | "filling-configured-account-id"
  | "configured-account-id-filled"
  | "filling-native-sender-id"
  | "native-sender-id-filled"
  | "clicking-add-link"
  | "submitted"
  | "waiting-for-result"
  | "result-observed"
  | "result-timeout"
  | "reading-status"
  | "status-read"
  | "reading-alert"
  | "alert-read"
  | "reading-form-state"
  | "form-state-read"
  | "reading-canonical-storage"
  | "canonical-storage-read"
  | "canonical-storage-read-failed"
  | "asserting-success"
  | "success-asserted";

suite.define(() => {
  it("shows the authenticated user instead of the default agent through a real Gateway", async () => {
    if (variant !== "baseline" && variant !== "candidate") {
      throw new Error("OPENCLAW_PROFILE_QA_VARIANT must be baseline or candidate");
    }
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "control-ui-profile-real-gateway",
      layout: "home",
      env: {
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    let gateway: GatewayServer | undefined;
    let proxy: ViteDevServer | undefined;
    try {
      const clipperWorkspace = state.path("workspace-clipper");
      await mkdir(clipperWorkspace, { recursive: true });
      const profile = ensureProfileForEmail(authenticatedUser);
      setDisplayName(profile.id, "Test Person");
      const trustedProxy = {
        allowLoopback: true,
        allowUsers: [authenticatedUser],
        deviceAutoApprove: {
          enabled: true,
          scopes: ["operator.admin", "operator.read", "operator.write"],
        },
        requiredHeaders: ["x-forwarded-proto"],
        userHeader: "x-forwarded-user",
      };
      await state.writeConfig({
        agents: {
          ownership: "explicit",
          defaults: {
            workspace: state.workspaceDir,
            systemAgent: { agentId: "clipper" },
            authInheritance: { agentId: "clipper" },
            sessionStore: { agentId: "clipper" },
          },
          entries: {
            main: { name: "Main", workspace: state.workspaceDir },
            clipper: { name: "Clipper", workspace: clipperWorkspace },
          },
        },
        talk: { agentId: "clipper" },
        gateway: {
          auth: { mode: "trusted-proxy", trustedProxy },
          controlUi: {
            allowedOrigins: [new URL(suite.server.baseUrl).origin],
            enabled: false,
          },
          port,
          trustedProxies: ["127.0.0.1", "::1"],
        },
      });
      const { startGatewayServer } = await import("../../../src/gateway/server.js");
      gateway = await startGatewayServer(port, {
        auth: { mode: "trusted-proxy", trustedProxy },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });

      // Chromium does not consistently apply extraHTTPHeaders to WebSocket upgrades.
      proxy = await createServer({
        configFile: false,
        envFile: false,
        root: state.workspaceDir,
        appType: "custom",
        logLevel: "error",
        server: {
          host: "127.0.0.1",
          port: 0,
          proxy: {
            "/": {
              target: `http://127.0.0.1:${port}`,
              ws: true,
              headers: {
                "x-forwarded-for": "192.0.2.10",
                "x-forwarded-proto": "http",
                "x-forwarded-user": authenticatedUser,
              },
            },
          },
        },
      });
      await proxy.listen();
      const proxyUrl = proxy.resolvedUrls?.local[0];
      if (!proxyUrl) {
        throw new Error("Profile test proxy did not expose a loopback URL");
      }
      const gatewayUrl = new URL(proxyUrl);
      gatewayUrl.protocol = "ws:";
      const connectedProxy = proxy;

      const proofDir = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1" ? suite.artifactDir : null;
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 800, width: 1280 },
          ...(proofDir
            ? { recordVideo: { dir: proofDir, size: { height: 800, width: 1280 } } }
            : {}),
        },
        async ({ page }) => {
          if (!proofDir) {
            throw new Error("Current Profile qualification requires retained media");
          }
          const servedAssets = new Map<string, string>();
          const assetReads: Promise<void>[] = [];
          page.on("response", (response) => {
            const url = new URL(response.url());
            if (
              url.origin === new URL(suite.server.baseUrl).origin &&
              /\/assets\/.*\.(?:js|css)$/.test(url.pathname)
            ) {
              const read = response.body().then((body) => {
                servedAssets.set(url.pathname, createHash("sha256").update(body).digest("hex"));
              });
              void read.catch(() => undefined);
              assetReads.push(read);
            }
          });
          const saveServedAssets = async () => {
            await Promise.all(assetReads);
            expect(servedAssets.size).toBeGreaterThan(0);
            const packageManager = JSON.parse(
              await readFile("package.json", "utf8"),
            ).packageManager;
            const playwrightVersion = JSON.parse(
              await readFile("ui/node_modules/playwright/package.json", "utf8"),
            ).version;
            expect(packageManager).toBe(process.env.OPENCLAW_PROFILE_QA_PACKAGE_MANAGER);
            expect(playwrightVersion).toBe(process.env.OPENCLAW_PROFILE_QA_PLAYWRIGHT_VERSION);
            const browserVersion = page.context().browser()?.version();
            expect(browserVersion).toMatch(/^\d+\.\d+/);
            await writeFile(
              path.join(proofDir, "served-assets.json"),
              JSON.stringify(
                {
                  source: process.env.OPENCLAW_PROFILE_QA_PRODUCT_SHA,
                  candidate: process.env.OPENCLAW_PROFILE_QA_CANDIDATE_SHA,
                  harness: process.env.OPENCLAW_PROFILE_QA_HARNESS_SHA,
                  variant,
                  runtime: {
                    node: process.version,
                    packageManager,
                    pnpm: process.env.OPENCLAW_PROFILE_QA_PNPM_VERSION,
                    playwright: playwrightVersion,
                    browser: browserVersion,
                    runner: {
                      os: process.env.RUNNER_OS ?? process.platform,
                      image: process.env.ImageOS ?? null,
                      imageVersion: process.env.ImageVersion ?? null,
                      arch: process.arch,
                    },
                  },
                  assets: Object.fromEntries([...servedAssets.entries()].sort()),
                },
                null,
                2,
              ) + "\n",
            );
          };
          const capture = async (stage: string, selector: string, contentSelector: string) => {
            const surface = page.locator(selector);
            const content = surface.locator(contentSelector).first();
            for (const viewport of viewports) {
              const frame = await takeControlUiScreenshotFrame(page, surface, [content], {
                viewport: { width: viewport.width, height: viewport.height },
                scrollTo: content,
                animations: "disabled",
              });
              await writeFile(path.join(proofDir, `${stage}-${viewport.name}.png`), frame.png);
            }
          };
          const captureNamedFrame = async (
            filename: string,
            surface: Locator,
            content: readonly Locator[],
            scrollTo: Locator,
          ) => {
            const frame = await takeControlUiScreenshotFrame(page, surface, content, {
              viewport: { width: 1280, height: 800 },
              scrollTo,
              animations: "disabled",
            });
            await writeFile(path.join(proofDir, filename), frame.png);
          };
          const channelIdentity = {
            channelId: "synthetic-e2e-channel",
            accountId: "synthetic-e2e-account",
            senderId: "synthetic-e2e-sender",
          };
          const matchesSyntheticIdentity = (value: unknown) => {
            const identity = asOptionalRecord(value);
            return (
              identity?.channelId === channelIdentity.channelId &&
              identity?.accountId === channelIdentity.accountId &&
              identity?.senderId === channelIdentity.senderId
            );
          };
          const channelRpcObservations: ChannelIdentityRpcObservation[] = [];
          page.on("websocket", (socket) => {
            const pending = new Map<string, ChannelIdentityRpcObservation>();
            socket.on("framesent", ({ payload }) => {
              try {
                const frame = asOptionalRecord(JSON.parse(String(payload)));
                if (frame?.type !== "req" || typeof frame.id !== "string") {
                  return;
                }
                const method = channelIdentityRpcMethods.find((candidate) => candidate === frame.method);
                if (!method) {
                  return;
                }
                const params = asOptionalRecord(frame.params);
                const observation: ChannelIdentityRpcObservation = {
                  method,
                  outcome: "pending",
                  requestMatchesFixture:
                    params?.profileId === profile.id &&
                    (method === "users.listChannelIdentities" ||
                      matchesSyntheticIdentity(params?.identity)),
                };
                channelRpcObservations.push(observation);
                pending.set(frame.id, observation);
              } catch {
                return;
              }
            });
            socket.on("framereceived", ({ payload }) => {
              try {
                const frame = asOptionalRecord(JSON.parse(String(payload)));
                if (frame?.type !== "res" || typeof frame.id !== "string") {
                  return;
                }
                const observation = pending.get(frame.id);
                if (!observation) {
                  return;
                }
                pending.delete(frame.id);
                observation.outcome = frame.ok === true ? "ok" : "error";
                if (frame.ok !== true) {
                  const error = asOptionalRecord(frame.error);
                  observation.errorCode =
                    channelIdentityRpcErrorCodes.find((candidate) => candidate === error?.code) ??
                    "other";
                }
                if (observation.method === "users.linkChannelIdentity" && frame.ok === true) {
                  const result = asOptionalRecord(frame.payload);
                  observation.responseMatchesFixture =
                    result?.profileId === profile.id && matchesSyntheticIdentity(result?.identity);
                }
              } catch {
                return;
              }
            });
            socket.on("close", () => {
              for (const observation of pending.values()) {
                observation.outcome = "connection-closed";
              }
              pending.clear();
            });
          });
          await page.addInitScript((key) => {
            window.localStorage.setItem(key, JSON.stringify({ dismissedAtMs: 1770000000000 }));
          }, COMMUNITY_INVITE_KEY);
          const url = new URL("settings/profile", suite.server.baseUrl);
          url.hash = new URLSearchParams({ gatewayUrl: gatewayUrl.href }).toString();
          const response = await page.goto(url.href);
          expect(response?.status()).toBe(200);
          const confirmation = page.locator("openclaw-gateway-url-confirmation");
          await confirmation.waitFor();
          await confirmation
            .getByRole("button", { name: `Switch to ${gatewayUrl.host}`, exact: true })
            .click();
          await expect
            .poll(() => page.locator(".profile-hero__name").textContent())
            .toBe("Test Person");
          await expect
            .poll(() => page.locator(".profile-hero__handle").textContent())
            .toContain(authenticatedUser);
          await expect
            .poll(() => page.locator(".profile-hero").textContent())
            .not.toContain("Clipper");
          const profileHero = page.locator(".profile-hero");
          await captureNamedFrame(
            "01-real-gateway-authenticated-profile.png",
            profileHero,
            [profileHero],
            profileHero,
          );
          await expect.poll(() => page.locator(".community-invite-card").count()).toBe(0);
          await expect.poll(() => page.locator(".profile-refresh").isEnabled()).toBe(true);
          if (variant === "baseline") {
            expect(await page.locator("#settings-profile-channel-identities").count()).toBe(0);
          } else {
            await expect
              .poll(() =>
                page.locator("#settings-profile-channel-identities .settings-empty").textContent(),
              )
              .toContain("No channel accounts are linked to your profile.");
          }
          await capture(
            "06-current-profile",
            "#settings-profile-identity",
            ".identity-name-control",
          );
          if (variant === "candidate") {
            await capture(
              "07-current-channel-form",
              "#settings-profile-channel-identities",
              'button[type="submit"]',
            );
          }
          await page.setViewportSize({ width: 1280, height: 800 });
          await page.locator(".identity-name-control input").fill("Local draft");
          const editor = await page.context().newPage();
          await editor.goto(new URL("settings/profile", suite.server.baseUrl).href);
          const nameInput = editor.locator(".identity-name-control input");
          await expect.poll(() => nameInput.inputValue()).toBe("Test Person");
          await nameInput.fill("Remote Person");
          await nameInput.press("Enter");
          await expect
            .poll(() => page.locator(".profile-hero__name").textContent())
            .toBe("Remote Person");
          await nameInput.fill("");
          await nameInput.press("Enter");
          await expect
            .poll(() => page.locator(".profile-hero__name").textContent())
            .toBe(authenticatedUser);
          await expect
            .poll(() => page.locator(".identity-name-control input").inputValue())
            .toBe("Local draft");
          await captureNamedFrame(
            "02-real-gateway-cleared-profile.png",
            profileHero,
            [profileHero],
            profileHero,
          );

          if (variant === "baseline") {
            await saveServedAssets();
            return;
          }

          const identitySection = page.locator("#settings-profile-channel-identities");
          const identityRow = identitySection
            .locator(".settings-row")
            .filter({ hasText: channelIdentity.senderId });
          const expectIdentitySectionInFrame = async (
            contentSelector: string,
            contentText: string,
          ) => {
            const heading = identitySection.locator(".settings-section__heading");
            const content = identitySection
              .locator(contentSelector)
              .filter({ hasText: contentText });
            await expect.poll(() => heading.textContent()).toContain("Linked channel accounts");
            await expect.poll(() => content.count()).toBe(1);
            await content.evaluate((element) => element.scrollIntoView({ block: "center" }));
            const [headingBox, contentBox] = await Promise.all([
              heading.boundingBox(),
              content.boundingBox(),
            ]);
            const viewport = page.viewportSize();
            expect(viewport).not.toBeNull();
            expect(headingBox).not.toBeNull();
            expect(contentBox).not.toBeNull();
            expect(headingBox!.y).toBeGreaterThanOrEqual(0);
            expect(headingBox!.y + headingBox!.height).toBeLessThanOrEqual(viewport!.height);
            expect(contentBox!.y).toBeGreaterThanOrEqual(0);
            expect(contentBox!.y + contentBox!.height).toBeLessThanOrEqual(viewport!.height);
          };

          const observationPath = path.join(proofDir, "channel-link-add-observation.json");
          let phase: ChannelIdentityAddPhase = "started";
          let addSignal: "not-observed" | "status" | "alert" | "timeout" = "not-observed";
          let statusOutcome: "unread" | "success" | "other" | "absent" = "unread";
          let alertPresent: boolean | null = null;
          let formCleared: boolean | null = null;
          let expectedLinkPresent: boolean | null = null;
          const writeAddObservation = async () => {
            await writeFile(
              observationPath,
              JSON.stringify(
                {
                  source: process.env.OPENCLAW_PROFILE_QA_PRODUCT_SHA,
                  harness: process.env.OPENCLAW_PROFILE_QA_HARNESS_SHA,
                  variant,
                  phase,
                  addSignal,
                  ui: {
                    status: statusOutcome,
                    alert: alertPresent === null ? "unread" : alertPresent ? "present" : "absent",
                    formCleared,
                  },
                  gatewayRpc: channelRpcObservations,
                  storage: { expectedLinkPresent },
                },
                null,
                2,
              ) + "\n",
            );
          };
          await writeAddObservation();
          for (const field of [
            {
              label: "Channel ID",
              value: channelIdentity.channelId,
              startingPhase: "filling-channel-id",
              completedPhase: "channel-id-filled",
            },
            {
              label: "Configured account ID",
              value: channelIdentity.accountId,
              startingPhase: "filling-configured-account-id",
              completedPhase: "configured-account-id-filled",
            },
            {
              label: "Native sender ID",
              value: channelIdentity.senderId,
              startingPhase: "filling-native-sender-id",
              completedPhase: "native-sender-id-filled",
            },
          ] as const) {
            phase = field.startingPhase;
            await writeAddObservation();
            await identitySection
              .getByRole("textbox", { name: field.label, exact: true })
              .fill(field.value);
            phase = field.completedPhase;
            await writeAddObservation();
          }
          phase = "clicking-add-link";
          await writeAddObservation();
          await identitySection.getByRole("button", { name: "Add link", exact: true }).click();
          phase = "submitted";
          await writeAddObservation();
          const status = identitySection.locator('[role="status"]');
          const alert = identitySection.locator('[role="alert"]');
          phase = "waiting-for-result";
          await writeAddObservation();
          try {
            await expect
              .poll(
                async () => {
                  const hasStatus = (await status.count()) > 0;
                  if (
                    hasStatus &&
                    (await status.textContent())?.includes("Channel account link added.")
                  ) {
                    addSignal = "status";
                    return true;
                  }
                  if ((await alert.count()) > 0) {
                    addSignal = "alert";
                    return true;
                  }
                  return false;
                },
                { timeout: 60_000 },
              )
              .toBe(true);
          } catch {
            addSignal = "timeout";
          }
          phase = addSignal === "timeout" ? "result-timeout" : "result-observed";
          await writeAddObservation();
          phase = "reading-status";
          await writeAddObservation();
          const statusText = (await status.count()) > 0 ? await status.textContent() : null;
          statusOutcome = statusText?.includes("Channel account link added.")
            ? "success"
            : statusText?.trim()
              ? "other"
              : "absent";
          phase = "status-read";
          await writeAddObservation();
          phase = "reading-alert";
          await writeAddObservation();
          alertPresent = (await alert.count()) > 0;
          phase = "alert-read";
          await writeAddObservation();
          phase = "reading-form-state";
          await writeAddObservation();
          const inputValues = await Promise.all(
            ["Channel ID", "Configured account ID", "Native sender ID"].map((name) =>
              identitySection.getByRole("textbox", { name, exact: true }).inputValue(),
            ),
          );
          formCleared = inputValues.every((value) => value.length === 0);
          phase = "form-state-read";
          await writeAddObservation();
          phase = "reading-canonical-storage";
          await writeAddObservation();
          try {
            const storedLinks = await listCanonicalUserChannelIdentities(profile.id);
            expectedLinkPresent = storedLinks.some((link) =>
              matchesSyntheticIdentity(link.identity),
            );
          } catch {
            expectedLinkPresent = null;
          }
          phase =
            expectedLinkPresent === null
              ? "canonical-storage-read-failed"
              : "canonical-storage-read";
          await writeAddObservation();
          phase = "asserting-success";
          await writeAddObservation();
          expect(statusOutcome).toBe("success");
          expect(alertPresent).toBe(false);
          phase = "success-asserted";
          await writeAddObservation();
          await expect.poll(() => identityRow.count()).toBe(1);
          await expect.poll(() => identityRow.textContent()).toContain(channelIdentity.senderId);
          await expectIdentitySectionInFrame(".settings-row", channelIdentity.senderId);
          const identityHeading = identitySection.locator(".settings-section__heading");
          await captureNamedFrame(
            "03-real-gateway-channel-link-added.png",
            identitySection,
            [identityHeading, identityRow],
            identityRow,
          );

          expect(await listCanonicalUserChannelIdentities(profile.id)).toEqual([
            { profileId: profile.id, identity: channelIdentity },
          ]);
          await capture(
            "08-link-added",
            "#settings-profile-channel-identities",
            'button[aria-label^="Remove link"]',
          );
          await page.setViewportSize({ width: 1280, height: 800 });
          const reloadWithLink = await page.reload();
          expect(reloadWithLink?.status()).toBe(200);
          await expect
            .poll(() => page.locator(".profile-hero__handle").textContent())
            .toContain(authenticatedUser);
          await expect.poll(() => identityRow.count()).toBe(1);
          await expect.poll(() => identityRow.textContent()).toContain(channelIdentity.senderId);
          await expectIdentitySectionInFrame(".settings-row", channelIdentity.senderId);
          await captureNamedFrame(
            "04-real-gateway-channel-link-reloaded.png",
            identitySection,
            [identityHeading, identityRow],
            identityRow,
          );

          await capture(
            "09-link-reloaded",
            "#settings-profile-channel-identities",
            'button[aria-label^="Remove link"]',
          );
          await page.setViewportSize({ width: 1280, height: 800 });
          await identitySection
            .getByRole("button", {
              name: `Remove link ${channelIdentity.channelId}, ${channelIdentity.accountId}, ${channelIdentity.senderId}`,
              exact: true,
            })
            .click();
          await expect
            .poll(() => identitySection.locator('[role="status"]').textContent())
            .toContain("Channel account link removed.");
          await expect
            .poll(() => identitySection.locator(".settings-empty").textContent())
            .toContain("No channel accounts are linked to your profile.");

          const reloadWithoutLink = await page.reload();
          expect(reloadWithoutLink?.status()).toBe(200);
          await expect
            .poll(() => page.locator(".profile-hero__handle").textContent())
            .toContain(authenticatedUser);
          await expect.poll(() => identityRow.count()).toBe(0);
          await expect
            .poll(() => identitySection.locator(".settings-empty").textContent())
            .toContain("No channel accounts are linked to your profile.");
          await expectIdentitySectionInFrame(
            ".settings-empty",
            "No channel accounts are linked to your profile.",
          );
          const identityEmptyState = identitySection.locator(".settings-empty");
          await captureNamedFrame(
            "05-real-gateway-channel-link-removed-reloaded.png",
            identitySection,
            [identityHeading, identityEmptyState],
            identityEmptyState,
          );
          expect(await listCanonicalUserChannelIdentities(profile.id)).toEqual([]);
          await capture(
            "10-link-removed",
            "#settings-profile-channel-identities",
            ".settings-empty",
          );
          await page.setViewportSize({ width: 1280, height: 800 });

          for (const [label, value] of [
            ["Channel ID", "synthetic-abandoned-channel"],
            ["Configured account ID", "synthetic-abandoned-account"],
            ["Native sender ID", "synthetic-abandoned-sender"],
          ] as const) {
            await identitySection.getByRole("textbox", { name: label, exact: true }).fill(value);
          }
          const navigation = await page.goto(new URL("settings/about", suite.server.baseUrl).href);
          expect(navigation?.status()).toBe(200);
          const returned = await page.goto(new URL("settings/profile", suite.server.baseUrl).href);
          expect(returned?.status()).toBe(200);
          await expect
            .poll(() => identitySection.locator(".settings-empty").textContent())
            .toContain("No channel accounts are linked to your profile.");
          expect(
            await identitySection
              .getByRole("textbox", { name: "Channel ID", exact: true })
              .inputValue(),
          ).toBe("");
          expect(await listCanonicalUserChannelIdentities(profile.id)).toEqual([]);
          await capture(
            "11-navigation-abandoned-draft",
            "#settings-profile-channel-identities",
            ".settings-empty",
          );
          await page.setViewportSize({ width: 1280, height: 800 });

          for (const [label, value] of [
            ["Channel ID", "synthetic-disconnected-channel"],
            ["Configured account ID", "synthetic-disconnected-account"],
            ["Native sender ID", "synthetic-disconnected-sender"],
          ] as const) {
            await identitySection.getByRole("textbox", { name: label, exact: true }).fill(value);
          }
          await capture(
            "12-disconnecting-draft",
            "#settings-profile-channel-identities",
            'button[type="submit"]',
          );
          await connectedProxy.close();
          await expect.poll(() => identitySection.count()).toBe(0);
          expect(await listCanonicalUserChannelIdentities(profile.id)).toEqual([]);
          await capture("13-disconnected", "openclaw-profile-page", ".settings-empty");
          await saveServedAssets();
          await writeFile(
            path.join(proofDir, "browser-final-storage.json"),
            JSON.stringify(
              {
                source: process.env.OPENCLAW_PROFILE_QA_PRODUCT_SHA,
                variant,
                crud: "add-reload-remove-reload",
                abandonedDraftBinding: "absent",
                disconnectedDraftBinding: "absent",
                mediaViewports: viewports,
                boundary: "real browser, registered Gateway, real isolated storage",
              },
              null,
              2,
            ) + "\n",
          );
        },
      );
    } finally {
      try {
        await proxy?.close();
      } finally {
        try {
          await gateway?.close({ reason: "profile real Gateway e2e cleanup" });
        } finally {
          await state.cleanup();
        }
      }
    }
  });
});

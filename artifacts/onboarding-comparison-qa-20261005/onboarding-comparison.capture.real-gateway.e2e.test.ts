// Task-local, read-only visual comparison against an isolated real Gateway.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { COMMUNITY_INVITE_KEY } from "../components/community-invite-state.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Onboarding comparison with a real Gateway",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const authenticatedUser = "primary.user@example.test";
const comparisonSide = process.env.OPENCLAW_ONBOARDING_COMPARISON_SIDE;

suite.define(() => {
  it("captures the same unnamed writable Profile at desktop and mobile sizes", async () => {
    if (comparisonSide !== "baseline" && comparisonSide !== "candidate") {
      throw new Error("Set OPENCLAW_ONBOARDING_COMPARISON_SIDE to baseline or candidate");
    }

    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "onboarding-comparison-real-gateway",
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

      // Create the same blank synthetic Profile on both revisions; do not set or
      // infer a name through a candidate-only API.
      const profile = ensureProfileForEmail(authenticatedUser);
      expect(profile.displayName ?? "").toBe("");

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
            heartbeat: { agentId: "clipper" },
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
        throw new Error("Onboarding comparison proxy did not expose a loopback URL");
      }
      const gatewayUrl = new URL(proxyUrl);
      gatewayUrl.protocol = "ws:";

      const proofDir = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1" ? suite.artifactDir : null;
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 800, width: 1280 },
        },
        async ({ page }) => {
          await page.addInitScript((inviteKey) => {
            window.localStorage.setItem(
              inviteKey,
              JSON.stringify({ dismissedAtMs: 1770000000000 }),
            );
          }, COMMUNITY_INVITE_KEY);

          const profileUrl = new URL("settings/profile", suite.server.baseUrl);
          profileUrl.hash = new URLSearchParams({ gatewayUrl: gatewayUrl.href }).toString();
          const response = await page.goto(profileUrl.href);
          expect(response?.status()).toBe(200);
          const confirmation = page.locator("openclaw-gateway-url-confirmation");
          await confirmation.waitFor();
          await confirmation
            .getByRole("button", { name: `Switch to ${gatewayUrl.host}`, exact: true })
            .click();
          await waitForControlUiGatewayReady(page);

          // This common, existing Profile surface proves the actual Gateway-backed
          // name is empty and the trusted synthetic user can edit it on both SHAs.
          await expect
            .poll(() => page.locator(".profile-hero__handle").textContent())
            .toContain(authenticatedUser);
          const profileNameInput = page.locator(".identity-name-control input");
          await expect.poll(() => profileNameInput.inputValue()).toBe("");
          await expect.poll(() => profileNameInput.isEnabled()).toBe(true);

          const onboardingUrl = new URL("custodian?onboarding=1", suite.server.baseUrl);
          await page.goto(onboardingUrl.href);
          await waitForControlUiGatewayReady(page);
          await expect.poll(() => page.locator(".custodian-surface").isVisible()).toBe(true);
          const onboardingPrompt = page.locator(".custodian__name-prompt");

          if (comparisonSide === "baseline") {
            // The baseline frame is the ordinary setup surface; it does not claim
            // that a pre-feature onboarding name response existed.
            await expect.poll(() => onboardingPrompt.count()).toBe(0);
          } else {
            await expect.poll(() => onboardingPrompt.isVisible()).toBe(true);
            const onboardingNameInput = page.getByRole("textbox", {
              name: "Your name",
              exact: true,
            });
            await expect.poll(() => onboardingNameInput.inputValue()).toBe("");
            await expect.poll(() => onboardingNameInput.isEnabled()).toBe(true);
            await expect
              .poll(() =>
                page.getByRole("button", { name: "Maybe later", exact: true }).isVisible(),
              )
              .toBe(true);
          }

          if (proofDir) {
            await page.screenshot({
              animations: "disabled",
              path: path.join(proofDir, `01-${comparisonSide}-onboarding-desktop-1280x800.png`),
            });
          }

          await page.setViewportSize({ width: 390, height: 844 });
          await expect.poll(() => page.locator(".custodian-surface").isVisible()).toBe(true);
          if (comparisonSide === "candidate") {
            await expect.poll(() => onboardingPrompt.isVisible()).toBe(true);
            await expect
              .poll(() =>
                page.getByRole("textbox", { name: "Your name", exact: true }).inputValue(),
              )
              .toBe("");
          } else {
            await expect.poll(() => onboardingPrompt.count()).toBe(0);
          }
          if (proofDir) {
            await page.screenshot({
              animations: "disabled",
              path: path.join(proofDir, `02-${comparisonSide}-onboarding-mobile-390x844.png`),
            });
          }
        },
      );
    } finally {
      try {
        await proxy?.close();
      } finally {
        try {
          await gateway?.close();
        } finally {
          await state.cleanup();
        }
      }
    }
  });
});



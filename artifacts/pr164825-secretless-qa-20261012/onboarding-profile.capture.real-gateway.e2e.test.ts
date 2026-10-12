import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { setDisplayName } from "../../../src/state/user-profile-writes.worker.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { COMMUNITY_INVITE_KEY } from "../components/community-invite-state.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "PR164825 secretless onboarding proof",
  startServerBeforeBrowser: true,
});
const authenticatedUser = "primary.user@example.test";
const existingName = "Existing Synthetic Person";
const savedName = "Synthetic Onboarding Person";
const comparisonSide = process.env.OPENCLAW_ONBOARDING_COMPARISON_SIDE;

async function capture(page: Page, surface: Locator, content: readonly Locator[], name: string) {
  const frame = await takeControlUiScreenshotFrame(page, surface, content, {
    animations: "disabled",
  });
  await writeFile(path.join(suite.artifactDir, name), frame.png);
}

suite.define(() => {
  it("preserves named profiles and proves optional naming with matched desktop and mobile captures", async (test) => {
    if (comparisonSide !== "baseline" && comparisonSide !== "candidate") {
      throw new Error("OPENCLAW_ONBOARDING_COMPARISON_SIDE must be baseline or candidate");
    }
    let state: OpenClawTestState | undefined;
    let gateway: Promise<GatewayServer> | undefined;
    let proxy: ViteDevServer | undefined;
    await suite.runScenario(test, {
      retainedState: () => state?.root,
      close: async () => {
        const results = await Promise.allSettled([
          proxy?.close(),
          gateway?.then((server) => server.close({ reason: "PR164825 synthetic proof cleanup" })),
        ]);
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (errors.length) {
          throw new AggregateError(errors, "PR164825 synthetic resources did not close");
        }
      },
      release: async () => {
        await state?.cleanup();
        await writeFile(
          path.join(suite.artifactDir, "cleanup.json"),
          JSON.stringify({ gatewayClosed: true, proxyClosed: true, stateReleased: true }),
        );
      },
      run: async (signal) => {
        const port = await getFreePort();
        signal.throwIfAborted();
        state = await createOpenClawTestState({
          label: "pr164825-onboarding-proof",
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
        signal.throwIfAborted();
        const clipperWorkspace = state.path("workspace-clipper");
        await mkdir(clipperWorkspace, { recursive: true });
        const profile = ensureProfileForEmail(authenticatedUser);
        expect(setDisplayName(profile.id, existingName).displayName).toBe(existingName);
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
            controlUi: { allowedOrigins: [new URL(suite.server.baseUrl).origin], enabled: false },
            port,
            trustedProxies: ["127.0.0.1", "::1"],
          },
        });
        signal.throwIfAborted();
        const { startGatewayServer } = await import("../../../src/gateway/server.js");
        gateway = startGatewayServer(port, {
          auth: { mode: "trusted-proxy", trustedProxy },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        await gateway;
        signal.throwIfAborted();
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
        signal.throwIfAborted();
        const proxyUrl = proxy.resolvedUrls?.local[0];
        if (!proxyUrl) {
          throw new Error("Synthetic proxy did not expose a loopback URL");
        }
        const gatewayUrl = new URL(proxyUrl);
        gatewayUrl.protocol = "ws:";
        await suite.withPage(
          { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 800 } },
          async ({ page }) => {
            await page.addInitScript(
              (inviteKey) =>
                localStorage.setItem(inviteKey, JSON.stringify({ dismissedAtMs: 1770000000000 })),
              COMMUNITY_INVITE_KEY,
            );
            const profileUrl = new URL("settings/profile", suite.server.baseUrl);
            const onboardingUrl = new URL("custodian?onboarding=1", suite.server.baseUrl);
            const initialUrl = new URL(profileUrl);
            initialUrl.hash = new URLSearchParams({ gatewayUrl: gatewayUrl.href }).toString();
            expect((await page.goto(initialUrl.href))?.status()).toBe(200);
            const confirmation = page.locator("openclaw-gateway-url-confirmation");
            await confirmation.waitFor();
            await confirmation
              .getByRole("button", { name: `Switch to ${gatewayUrl.host}`, exact: true })
              .click();
            await waitForControlUiGatewayReady(page);
            const nameEditor = page.locator(".identity-name-control input");
            const profileHero = page.locator(".profile-hero__name");
            await expect.poll(() => nameEditor.inputValue()).toBe(existingName);
            await expect.poll(() => profileHero.textContent()).toBe(existingName);
            await capture(
              page,
              page.locator(".profile-hero"),
              [profileHero, nameEditor],
              "01-named-profile-desktop.png",
            );
            await page.reload();
            await expect.poll(() => nameEditor.inputValue()).toBe(existingName);
            await page.goto(onboardingUrl.href);
            await waitForControlUiGatewayReady(page);
            const surface = page.locator(".custodian-surface");
            const nudge = page.locator(".custodian__nudge--channel-onboarding");
            const prompt = page.locator(".custodian__name-prompt");
            await nudge.waitFor();
            expect(await prompt.count()).toBe(0);
            await page.goto(profileUrl.href);
            await expect.poll(() => nameEditor.inputValue()).toBe(existingName);
            await nameEditor.fill("");
            await nameEditor.press("Enter");
            await expect.poll(() => profileHero.textContent()).toBe(authenticatedUser);
            await page.reload();
            await expect.poll(() => nameEditor.inputValue()).toBe("");
            await page.goto(onboardingUrl.href);
            await waitForControlUiGatewayReady(page);
            await nudge.waitFor();
            await expect.poll(() => nudge.getAttribute("role")).toBe("status");
            const nameInput = page.getByRole("textbox", { name: "Your name", exact: true });
            const skip = page.getByRole("button", { name: "Maybe later", exact: true });
            if (comparisonSide === "candidate") {
              await nameInput.waitFor();
              await expect.poll(() => nameInput.inputValue()).toBe("");
              expect(await skip.isEnabled()).toBe(true);
            } else {
              expect(await prompt.count()).toBe(0);
            }
            for (const viewport of [
              { width: 1280, height: 800 },
              { width: 390, height: 844 },
            ]) {
              await page.setViewportSize(viewport);
              await expect
                .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
                .toBe(true);
              await capture(
                page,
                surface,
                comparisonSide === "candidate" ? [nudge, nameInput, skip] : [nudge],
                `${comparisonSide}-${viewport.width}-onboarding.png`,
              );
            }
            if (comparisonSide === "baseline") {
              return;
            }
            await skip.click();
            await expect.poll(() => prompt.count()).toBe(0);
            await expect.poll(() => surface.isVisible()).toBe(true);
            await capture(page, surface, [nudge], "03-skipped-mobile.png");
            await page.goto(profileUrl.href);
            await expect.poll(() => nameEditor.inputValue()).toBe("");
            await page.goto(onboardingUrl.href);
            await nameInput.waitFor();
            await nameInput.fill("Navigation draft");
            await page.goto(profileUrl.href);
            await expect.poll(() => nameEditor.inputValue()).toBe("");
            await page.goto(onboardingUrl.href);
            await nameInput.waitFor();
            await expect.poll(() => nameInput.inputValue()).toBe("");
            await nameInput.fill(savedName);
            await page.getByRole("button", { name: "Save name", exact: true }).click();
            await expect.poll(() => prompt.count()).toBe(0);
            await page.goto(profileUrl.href);
            await expect.poll(() => nameEditor.inputValue()).toBe(savedName);
            await expect.poll(() => profileHero.textContent()).toBe(savedName);
            await page.reload();
            await expect.poll(() => nameEditor.inputValue()).toBe(savedName);
            await capture(
              page,
              page.locator(".profile-hero"),
              [profileHero, nameEditor],
              "04-persisted-profile-mobile.png",
            );
            await page.setViewportSize({ width: 1280, height: 800 });
            await capture(
              page,
              page.locator(".profile-hero"),
              [profileHero, nameEditor],
              "05-persisted-profile-desktop.png",
            );
            await nameEditor.fill("Ordinary Profile Edit");
            await nameEditor.press("Enter");
            await expect.poll(() => profileHero.textContent()).toBe("Ordinary Profile Edit");
            await page.reload();
            await expect.poll(() => nameEditor.inputValue()).toBe("Ordinary Profile Edit");
            await page.goto(onboardingUrl.href);
            await nudge.waitFor();
            expect(await prompt.count()).toBe(0);
            await capture(page, surface, [nudge], "06-named-revisit-desktop.png");
            await page.goto(profileUrl.href);
            await expect.poll(() => nameEditor.inputValue()).toBe("Ordinary Profile Edit");
            await writeFile(
              path.join(suite.artifactDir, "behavior.json"),
              JSON.stringify({
                comparisonSide,
                syntheticIdentity: true,
                namedReload: true,
                skipUnchanged: true,
                navigationDraftUnchanged: true,
                saveReload: true,
                ordinaryEditReload: true,
                namedRevisit: true,
                installedUpgrade: "not_proven",
              }),
            );
          },
        );
      },
    });
  });
});

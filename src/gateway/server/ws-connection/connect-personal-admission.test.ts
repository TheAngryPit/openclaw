import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import type { HelloOk } from "../../../../packages/gateway-protocol/src/index.js";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/version.js";
import { prepareUserProfileCatalog } from "../../../state/user-profile-list.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { GatewayClientRegistry } from "../client-registry.js";
import { sendGatewayHello } from "./connect-hello.js";
import { resolveGatewayConnectProfileAdmission } from "./connect-user-profile.js";

const { whois, pairingRead } = vi.hoisted(() => ({ whois: vi.fn(), pairingRead: vi.fn() }));
vi.mock("../../../infra/tailscale.js", () => ({ readTailscaleWhoisIdentity: whois }));
vi.mock("../../../infra/device-pairing-store-readonly.js", () => ({
  loadPairedDevicePairingStoreRecordReadOnly: pairingRead,
}));
vi.mock("../health-state.js", () => ({
  getHealthCache: () => null,
  getHealthVersion: () => 1,
  buildGatewaySnapshot: () => ({
    presence: [],
    health: {},
    stateVersion: { presence: 1, health: 1 },
    uptimeMs: 1,
  }),
}));
vi.mock("../../control-ui-plugin-tabs.js", () => ({
  listControlUiLinkReaders: () => [],
  listControlUiPluginTabs: () => [],
  listControlUiPluginWidgetKinds: () => [],
}));

it("admits a Serve binding, emits its hello proof, and preserves the person on local use", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const now = Date.now();
    const scopes = ["operator.read"];
    const clients = new GatewayClientRegistry();
    const fingerprint = "a".repeat(64);
    whois.mockResolvedValue({ login: "admission@example.test", name: "Admission" });
    pairingRead.mockResolvedValue({
      deviceId: "paired-device",
      publicKey: "fixture-public-key",
      role: "operator",
      roles: ["operator"],
      approvedScopes: scopes,
      createdAtMs: 1,
      tokens: { operator: { role: "operator", token: "synthetic-token", scopes, createdAtMs: 1 } },
    });
    const device = {
      id: "paired-device",
      publicKey: "fixture-public-key",
      signature: "already-verified",
      nonce: "nonce",
      signedAt: now,
    };
    const bindIntent = {
      mode: "personal-identity",
      provider: "tailscale",
      phase: "bind",
      bindingId: "admitted-binding",
      issuedAtMs: now,
    } as const;
    const context = {
      configSnapshot: {},
      isLocalClient: false,
      connectParams: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: { id: "gateway-client", version: "dev", platform: "test", mode: "backend" },
        role: "operator",
        scopes,
        device,
        personalIdentity: bindIntent,
      },
      handler: {
        clients,
        bootId: "admission-boot",
        connId: "bind",
        socket: new EventEmitter(),
        ingressAttribution: { kind: "tailscale-serve", clientIp: "100.64.0.10" },
        buildRequestContext: () => ({
          gatewayTlsFingerprint: fingerprint,
          nodeRegistry: { get: () => undefined },
        }),
        logWsControl: { warn: vi.fn() },
        logGateway: { warn: vi.fn() },
        logHealth: { error: vi.fn() },
        close: vi.fn(),
        isClosed: () => false,
        advanceHandshakePhase: vi.fn(),
        setCloseCause: vi.fn(),
        gatewayMethods: [],
        events: [],
        refreshHealthSnapshot: vi.fn(async () => ({})),
        getClient: () => null as unknown,
      },
      markHandshakeFailure: vi.fn(),
      sendHandshakeErrorResponse: vi.fn(),
      releasePendingNodePairingCleanup: vi.fn(async () => {}),
      frame: { id: "bind" },
      sendFrame: vi.fn(async (_frame: unknown) => {}),
      onHelloDelivered: vi.fn(),
      pendingNodePairingCleanup: {},
    };
    const state = {
      authMethod: "tailscale",
      role: "operator",
      scopes,
      device,
      devicePublicKey: device.publicKey,
      deviceAuthPayloadVersion: "v4",
      authResult: {
        ok: true,
        method: "tailscale",
        user: "admission@example.test",
        tailscaleIdentity: { login: "admission@example.test" },
      },
      resolvedAuth: { mode: "token" },
      hasTokenAuth: false,
      hasPasswordAuth: false,
      issuedBootstrapProfile: null,
      handoffBootstrapProfile: null,
      deviceToken: null,
      bootstrapDeviceTokens: [],
    };
    const admit = (nextContext = context, nextState = state) =>
      resolveGatewayConnectProfileAdmission({
        context: nextContext as never,
        state: nextState as never,
        ownerProfileExpected: false,
        authenticatedUserId: nextState.authResult.user,
        resolveAuthenticatedGitHubIdentity: undefined,
      });
    const bound = await admit();
    expect(context.handler.logWsControl.warn.mock.calls).toEqual([]);
    expect(bound.ok).toBe(true);
    if (!bound.ok || !bound.prepared || !bound.personalIdentityBinding) {
      throw new Error("Expected actual bind admission");
    }
    const profileId = bound.prepared.profile.profileId;
    expect(profileId).not.toBe("gateway-owner");
    expect(bound.personalIdentityBinding.scopes).toEqual(scopes);
    context.handler.getClient = () => ({
      connect: context.connectParams,
      internal: { personalIdentityBinding: bound.personalIdentityBinding },
    });
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    await sendGatewayHello(context as never, state as never, {}, profileId);
    const sent = context.sendFrame.mock.calls[0];
    if (!sent) {
      throw new Error("Expected hello delivery");
    }
    const hello = (sent[0] as { payload: HelloOk }).payload;
    expect(hello.personalIdentityBinding).toEqual({
      mode: "personal-identity",
      provider: "tailscale",
      bindingId: "admitted-binding",
      profileId,
      gatewayId: "admission-boot",
      tlsFingerprint: fingerprint,
    });
    expect(hello.auth?.scopes).toEqual(scopes);
    const local = {
      ...context,
      isLocalClient: true,
      connectParams: {
        ...context.connectParams,
        personalIdentity: {
          ...bindIntent,
          phase: "use",
          profileId,
          gatewayId: hello.server.bootId,
        },
      },
      handler: {
        ...context.handler,
        ingressAttribution: { kind: "direct-local", clientIp: "127.0.0.1" },
      },
    };
    const localState = {
      ...state,
      authMethod: "device-token",
      authResult: { ok: true, method: "device-token" },
    };
    const used = await admit(local as never, localState as never);
    expect(used.ok).toBe(true);
    if (!used.ok) {
      throw new Error("Expected actual use admission");
    }
    expect(used.prepared?.profile.profileId).toBe(profileId);
    expect(used.personalIdentityBinding?.scopes).toEqual(scopes);
    expect(
      await admit(
        {
          ...local,
          connectParams: {
            ...local.connectParams,
            personalIdentity: { ...local.connectParams.personalIdentity, bindingId: "unknown" },
          },
        } as never,
        localState as never,
      ),
    ).toEqual({ ok: false });
    expect(context.sendHandshakeErrorResponse).toHaveBeenCalled();
    expect(
      await admit({
        ...context,
        handler: {
          ...context.handler,
          ingressAttribution: { kind: "direct-remote", clientIp: "192.0.2.1" },
        },
      } as never),
    ).toEqual({ ok: false });
  });
});

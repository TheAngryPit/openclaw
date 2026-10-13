// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type {
  SessionCatalog,
  SessionCatalogHost,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  refreshSessionCatalogsLive,
  SessionCatalogLiveState,
} from "./app-sidebar-session-catalog-live.ts";
import { refetchExpandedSessionCatalogPages } from "./app-sidebar-session-catalog-state.ts";
import { sessionCatalogHostKey } from "./app-sidebar-session-types.ts";

function catalog(id: string, hostCount: number): SessionCatalog {
  return {
    id,
    label: id,
    capabilities: { continueSession: true, archive: true },
    hosts: Array.from({ length: hostCount }, (_, hostIndex) => ({
      hostId: `${id}-host-${hostIndex}`,
      label: `Host ${hostIndex}`,
      kind: "node",
      connected: true,
      sessions: [
        {
          threadId: `${id}-thread-${hostIndex}`,
          name: `Session ${hostIndex}`,
          status: "idle",
          archived: false,
          canContinue: true,
          canArchive: true,
        },
      ],
    })),
  };
}

describe("SessionCatalogLiveState", () => {
  it.each(["claude", "codex"])(
    "recovers an unavailable %s node without a catalog event or page reload",
    async (id) => {
      vi.useFakeTimers();
      vi.stubGlobal("document", { visibilityState: "visible" });
      const live = new SessionCatalogLiveState();
      try {
        const recovered = catalog(id, 1);
        const unavailable = {
          ...recovered,
          hosts: [
            {
              ...recovered.hosts[0]!,
              sessions: [],
              error: { code: "NODE_INVOKE_FAILED", message: "Paired node temporarily unavailable" },
            },
          ],
        };
        const request = vi
          .fn()
          .mockResolvedValueOnce({ catalogs: [unavailable] })
          .mockResolvedValue({ catalogs: [recovered] });
        const client = { request } as unknown as GatewayBrowserClient;
        let displayed: SessionCatalog[] = [];
        const refresh = (): Promise<void> =>
          refreshSessionCatalogsLive({
            live,
            client,
            agentId: "main",
            generation: 1,
            currentGeneration: () => 1,
            currentClient: () => client,
            catalogs: () => displayed,
            pageDepths: new Map(),
            connected: () => true,
            catalogChangedEvents: true,
            applyFinal: (rows) => {
              displayed = rows;
            },
            continueRefresh: async () => {},
            applyError: (error) => {
              throw error;
            },
            refresh,
          });
        await refresh();
        expect(displayed[0]?.hosts[0]?.error?.code).toBe("NODE_INVOKE_FAILED");
        await vi.advanceTimersByTimeAsync(30_000);
        expect(displayed[0]?.hosts[0]?.sessions.map((row) => row.name)).toEqual(["Session 0"]);
        expect(displayed[0]?.hosts[0]?.error).toBeUndefined();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(request).toHaveBeenCalledTimes(2);
      } finally {
        live.clear();
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    },
  );
  it.each(["final", "incremental"] as const)(
    "retains rows and cursors for a pending host in %s publications",
    async (publication) => {
      const live = new SessionCatalogLiveState();
      const { progressId } = live.beginRequest(1);
      const current = catalog("codex", 2);
      current.hosts[0]!.nextCursor = "next-page";
      const pending = { ...current.hosts[0]!, pending: true, sessions: [], nextCursor: undefined };
      const incoming = { ...current, hosts: [pending] };
      const catalogs =
        publication === "final"
          ? live.mergeFinal([incoming], [current])
          : live.applyHost({
              payload: { progressId, agentId: "main", catalog: incoming },
              agentId: "main",
              catalogs: [current],
              pageDepths: new Map(),
            })!.catalogs;
      expect(catalogs[0]?.hosts[0]).toMatchObject({
        pending: true,
        sessions: current.hosts[0]!.sessions,
        nextCursor: "next-page",
      });
      // A final response still removes genuinely absent hosts.
      expect(catalogs[0]?.hosts).toHaveLength(publication === "final" ? 1 : 2);
      const request = vi.fn();
      expect(
        await refetchExpandedSessionCatalogPages({
          catalogs,
          previousCatalogs: [current],
          client: { request } as unknown as GatewayBrowserClient,
          agentId: "main",
          pageDepths: new Map([[sessionCatalogHostKey("codex", pending.hostId), 1]]),
          isCurrent: () => true,
          canRequestPage: () => true,
        }),
      ).toEqual(catalogs);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("does not replace a settled progressive host with its pending final response", () => {
    const live = new SessionCatalogLiveState();
    const { progressId } = live.beginRequest(1);
    const current = catalog("codex", 1);
    const pending: SessionCatalogHost = { ...current.hosts[0]!, pending: true, sessions: [] };
    const published = live.applyHost({
      payload: { progressId, agentId: "main", catalog: current },
      agentId: "main",
      catalogs: [{ ...current, hosts: [pending] }],
      pageDepths: new Map(),
    })!;
    expect(live.mergeFinal([{ ...current, hosts: [pending] }], published.catalogs)).toEqual([
      current,
    ]);
  });

  it("clears unavailable native readiness without losing another host or expanded rows", () => {
    const live = new SessionCatalogLiveState();
    const { progressId } = live.beginRequest(1);
    const current = catalog("codex", 2);
    current.capabilities.startTerminal = true;
    current.hosts.forEach((host) => {
      host.canStartTerminal = true;
    });
    const changed = {
      ...current.hosts[0]!,
      canStartTerminal: false,
      sessions: [],
      error: { code: "offline", message: "Offline" },
    };
    const result = live.applyHost({
      payload: { progressId, agentId: "main", catalog: { ...current, hosts: [changed] } },
      agentId: "main",
      catalogs: [current],
      pageDepths: new Map([[sessionCatalogHostKey("codex", changed.hostId), 1]]),
    });
    expect(result?.catalogs[0]?.hosts.map((host) => host.canStartTerminal)).toEqual([false, true]);
    expect(result?.catalogs[0]?.hosts[1]).toEqual(current.hosts[1]);
    expect(result?.catalogs[0]?.hosts[0]?.sessions).toEqual(current.hosts[0]?.sessions);
  });
  it("compares a host event only with the catalog and host it can replace", () => {
    const live = new SessionCatalogLiveState();
    const { progressId } = live.beginRequest(1);
    const changed = catalog("changed", 1);
    const unrelated = catalog("unrelated", 100);
    Object.defineProperty(unrelated, "toJSON", {
      value: () => {
        throw new Error("unrelated catalog serialized");
      },
    });

    let result: ReturnType<SessionCatalogLiveState["applyHost"]>;
    expect(() => {
      result = live.applyHost({
        payload: {
          progressId,
          agentId: "main",
          catalog: { ...changed, hosts: [changed.hosts[0]!] },
        },
        agentId: "main",
        catalogs: [changed, unrelated],
        pageDepths: new Map(),
      });
    }).not.toThrow();
    expect(result!).toBeNull();
  });
});

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  invalidateChatMetadataStore,
  loadChatMetadata,
  peekChatMetadata,
  rememberChatMetadata,
  type ChatMetadataResult,
} from "./chat-metadata-store.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function clientWith(request: ReturnType<typeof vi.fn>): GatewayBrowserClient {
  return { request } as unknown as GatewayBrowserClient;
}

function metadata(modelId: string): ChatMetadataResult {
  return {
    commands: [],
    models: [{ id: modelId, name: modelId, provider: "openai" }],
  };
}

describe("chat metadata store", () => {
  it("returns a cached result without requesting it again", async () => {
    const result = metadata("cached-model");
    const request = vi.fn().mockResolvedValue(result);
    const client = clientWith(request);

    await expect(loadChatMetadata(client, " main ")).resolves.toBe(result);
    await expect(loadChatMetadata(client, "main")).resolves.toBe(result);

    expect(request).toHaveBeenCalledOnce();
  });

  it("shares one pending load between concurrent readers", async () => {
    const pending = deferred<ChatMetadataResult>();
    const request = vi.fn().mockReturnValue(pending.promise);
    const client = clientWith(request);

    const first = loadChatMetadata(client, "main");
    const second = loadChatMetadata(client, "main");

    expect(second).toBe(first);
    expect(request).toHaveBeenCalledOnce();
    pending.resolve(metadata("shared-model"));
    await expect(first).resolves.toEqual(metadata("shared-model"));
  });

  it("clears a failed pending load so a later read can retry", async () => {
    const result = metadata("recovered-model");
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("metadata unavailable"))
      .mockResolvedValueOnce(result);
    const client = clientWith(request);

    await expect(loadChatMetadata(client, "main")).rejects.toThrow("metadata unavailable");
    await expect(loadChatMetadata(client, "main")).resolves.toBe(result);

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("uses remembered startup metadata as the current snapshot", async () => {
    const result = metadata("startup-model");
    const request = vi.fn();
    const client = clientWith(request);

    rememberChatMetadata(client, "main", result);

    expect(peekChatMetadata(client, "main")).toBe(result);
    await expect(loadChatMetadata(client, "main")).resolves.toBe(result);
    expect(request).not.toHaveBeenCalled();
  });

  it("drops every agent snapshot when the client store is invalidated", async () => {
    const main = metadata("main-model");
    const worker = metadata("worker-model");
    const request = vi.fn().mockResolvedValue(main);
    const client = clientWith(request);
    rememberChatMetadata(client, "main", main);
    rememberChatMetadata(client, "worker", worker);

    invalidateChatMetadataStore(client);

    expect(peekChatMetadata(client, "main")).toBeUndefined();
    expect(peekChatMetadata(client, "worker")).toBeUndefined();
    await expect(loadChatMetadata(client, "main")).resolves.toBe(main);
    expect(request).toHaveBeenCalledOnce();
  });
});

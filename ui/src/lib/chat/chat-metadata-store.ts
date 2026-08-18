import type { CommandsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";

export type ChatMetadataResult = CommandsListResult & {
  models?: ModelCatalogEntry[];
};

type ChatMetadataEntry = {
  result?: ChatMetadataResult;
  loadPending?: Promise<ChatMetadataResult>;
  latestRequest?: Promise<ChatMetadataResult>;
};

const chatMetadataCache = new WeakMap<GatewayBrowserClient, Map<string, ChatMetadataEntry>>();

function chatMetadataAgentKey(agentId: string | null | undefined): string {
  return agentId?.trim() ?? "";
}

function metadataEntryFor(
  client: GatewayBrowserClient,
  agentId: string | null | undefined,
): ChatMetadataEntry {
  const key = chatMetadataAgentKey(agentId);
  let cache = chatMetadataCache.get(client);
  if (!cache) {
    cache = new Map();
    chatMetadataCache.set(client, cache);
  }
  let entry = cache.get(key);
  if (!entry) {
    entry = {};
    cache.set(key, entry);
  }
  return entry;
}

async function requestChatMetadata(
  client: GatewayBrowserClient,
  agentId: string | null | undefined,
): Promise<ChatMetadataResult> {
  const params = agentId ? { agentId } : {};
  return client.request<ChatMetadataResult>("chat.metadata", params);
}

function beginChatMetadataRequest(
  entry: ChatMetadataEntry,
  request: Promise<ChatMetadataResult>,
): Promise<ChatMetadataResult> {
  const pending = request
    .then((result) => {
      // The newest request owns the snapshot even when an older load settles later.
      if (entry.latestRequest === pending) {
        entry.result = result;
      }
      return result;
    })
    .finally(() => {
      if (entry.loadPending === pending) {
        entry.loadPending = undefined;
      }
    });
  entry.loadPending = pending;
  entry.latestRequest = pending;
  return pending;
}

export function peekChatMetadata(
  client: GatewayBrowserClient,
  agentId: string | null | undefined,
): ChatMetadataResult | undefined {
  return chatMetadataCache.get(client)?.get(chatMetadataAgentKey(agentId))?.result;
}

export function loadChatMetadata(
  client: GatewayBrowserClient,
  agentId: string | null | undefined,
): Promise<ChatMetadataResult> {
  const entry = metadataEntryFor(client, agentId);
  if (entry.result) {
    return Promise.resolve(entry.result);
  }
  if (entry.loadPending) {
    return entry.loadPending;
  }
  return beginChatMetadataRequest(entry, requestChatMetadata(client, agentId));
}

export function rememberChatMetadata(
  client: GatewayBrowserClient,
  agentId: string | null | undefined,
  result: ChatMetadataResult,
): void {
  const entry = metadataEntryFor(client, agentId);
  entry.result = result;
  entry.loadPending = undefined;
  entry.latestRequest = undefined;
}

export function invalidateChatMetadataStore(client: GatewayBrowserClient): void {
  chatMetadataCache.delete(client);
}

// Control UI model metadata boundary.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { retryGatewayStartupRequest } from "../gateway-startup-retry.ts";

const MODEL_CATALOG_CACHE_TTL_MS = 60_000;

type ModelCatalogCacheEntry = {
  expiresAt: number;
  models: ModelCatalogEntry[];
  inFlight?: Promise<ModelCatalogEntry[]>;
  inFlightRefresh?: boolean;
  inFlightRejects?: boolean;
};

const modelCatalogCache = new WeakMap<GatewayBrowserClient, Map<string, ModelCatalogCacheEntry>>();

export function invalidateModelCatalogStore(client: GatewayBrowserClient): void {
  modelCatalogCache.delete(client);
}

type ModelCatalogScope = {
  agentId: string;
  preparedOnly?: boolean;
};

type LoadModelsOptions = ModelCatalogScope & {
  refresh?: boolean;
  rejectOnFailure?: boolean;
};

function modelCatalogCacheFor(client: GatewayBrowserClient): Map<string, ModelCatalogCacheEntry> {
  let cache = modelCatalogCache.get(client);
  if (!cache) {
    cache = new Map();
    modelCatalogCache.set(client, cache);
  }
  return cache;
}

export async function loadModels(
  client: GatewayBrowserClient,
  opts: LoadModelsOptions,
): Promise<ModelCatalogEntry[]> {
  return await loadModelsCached(client, opts, opts.refresh === true);
}

export function peekModels(
  client: GatewayBrowserClient,
  opts: ModelCatalogScope,
): ModelCatalogEntry[] | undefined {
  const cached = modelCatalogCacheFor(client).get(modelCatalogCacheKey(opts));
  return cached && cached.expiresAt > 0 ? cached.models : undefined;
}

export async function revalidateModels(
  client: GatewayBrowserClient,
  opts: ModelCatalogScope & { startupRetryWindowMs?: number },
): Promise<ModelCatalogEntry[]> {
  const retryWindowMs = opts.startupRetryWindowMs;
  const request = () => loadModelsCached(client, { ...opts, rejectOnFailure: true }, true);
  if (retryWindowMs === undefined) {
    return await request();
  }
  return await retryGatewayStartupRequest({
    retryWindowMs,
    request,
    requestFailure: (error) => {
      return error instanceof Error
        ? error
        : new Error("Model catalog request failed", { cause: error });
    },
    timeoutMessage: "Model catalog retry deadline elapsed",
  });
}

function modelCatalogCacheKey(opts: ModelCatalogScope): string {
  return `${opts.agentId.trim()}\0${opts.preparedOnly ? "prepared" : "exact"}`;
}

async function loadModelsCached(
  client: GatewayBrowserClient,
  opts: LoadModelsOptions,
  bypassCache: boolean,
): Promise<ModelCatalogEntry[]> {
  const cache = modelCatalogCacheFor(client);
  const agentId = opts.agentId.trim();
  const rejectOnFailure = opts.rejectOnFailure === true;
  const cacheKey = modelCatalogCacheKey(opts);
  const preparedCacheKey = `${agentId}\0prepared`;
  const cached = cache.get(cacheKey);
  const now = Date.now();
  if (!bypassCache && cached?.models && cached.expiresAt > now) {
    return cached.models;
  }
  if (
    cached?.inFlight &&
    cached.inFlightRejects === rejectOnFailure &&
    (!opts.refresh || cached.inFlightRefresh === true)
  ) {
    return cached.inFlight;
  }

  // The cache write happens here, gated on inFlight identity: a refresh call
  // replaces inFlight, so an older request resolving late cannot clobber the
  // fresher result with pre-mutation catalog data.
  const inFlight: Promise<ModelCatalogEntry[]> = requestModels(
    client,
    cached?.models,
    agentId,
    opts.preparedOnly === true,
    opts.refresh === true,
    rejectOnFailure,
  )
    .then((result) => {
      const latest = cache.get(cacheKey);
      if (!latest || latest.inFlight === inFlight) {
        const entry = {
          expiresAt: result.fresh ? Date.now() + MODEL_CATALOG_CACHE_TTL_MS : 0,
          models: result.models,
        };
        cache.set(cacheKey, entry);
        if (result.fresh && opts.preparedOnly !== true) {
          // An exact catalog supersedes the prepared projection. Reusing it for
          // automatic reads prevents route re-entry from restoring stale data.
          cache.set(preparedCacheKey, entry);
        }
      }
      return result.models;
    })
    .finally(() => {
      const latest = cache.get(cacheKey);
      if (latest?.inFlight === inFlight) {
        delete latest.inFlight;
      }
    });
  cache.set(cacheKey, {
    expiresAt: cached?.expiresAt ?? 0,
    models: cached?.models ?? [],
    inFlight,
    inFlightRejects: rejectOnFailure,
    ...(opts.refresh ? { inFlightRefresh: true } : {}),
  });
  return inFlight;
}

async function requestModels(
  client: GatewayBrowserClient,
  fallback: ModelCatalogEntry[] | undefined,
  agentId: string,
  preparedOnly: boolean,
  refresh: boolean,
  rejectOnFailure: boolean,
): Promise<{ models: ModelCatalogEntry[]; fresh: boolean }> {
  try {
    const result = await client.request<{ models: ModelCatalogEntry[] }>("models.list", {
      view: "configured",
      agentId,
      ...(preparedOnly ? { preparedOnly: true } : {}),
      ...(refresh ? { refresh: true } : {}),
    });
    return { models: result?.models ?? [], fresh: true };
  } catch (error) {
    if (rejectOnFailure) {
      throw error;
    }
    // Failed loads fall back without extending the TTL so the next call retries.
    return { models: fallback ?? [], fresh: false };
  }
}

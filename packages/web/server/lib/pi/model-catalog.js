import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;

const isFinitePositive = (value) => Number.isFinite(value) && value > 0;

const publicBaseUrl = (value) => {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
};

const emptyCapabilities = (input) => ({
  temperature: false,
  reasoning: input.reasoning === true,
  attachment: input.input.includes('image'),
  toolcall: false,
  input: {
    text: input.input.includes('text'),
    audio: false,
    image: input.input.includes('image'),
    video: false,
    pdf: false,
  },
  output: {
    text: true,
    audio: false,
    image: false,
    video: false,
    pdf: false,
  },
  interleaved: false,
});

function translateModel(model) {
  return {
    id: model.id,
    providerID: model.provider,
    api: {
      id: model.api,
      url: publicBaseUrl(model.baseUrl),
      npm: '',
    },
    name: model.name,
    capabilities: emptyCapabilities(model),
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cache: {
        read: model.cost.cacheRead,
        write: model.cost.cacheWrite,
      },
      ...(model.cost.tiers ? {
        tiers: model.cost.tiers.map((tier) => ({
          input: tier.input,
          output: tier.output,
          cache: {
            read: tier.cacheRead,
            write: tier.cacheWrite,
          },
          tier: { type: 'context', size: tier.inputTokensAbove },
        })),
      } : {}),
    },
    limit: {
      context: model.contextWindow,
      output: model.maxTokens,
    },
    // Required by the OpenCode 1.17.18 wire shape; Pi does not expose status.
    status: 'active',
    options: {},
    headers: {},
    release_date: '',
    ...(model.thinkingLevelMap ? { variants: Object.fromEntries(Object.entries(model.thinkingLevelMap)
      .filter(([, value]) => value !== null)
      .map(([key, value]) => [key, {}])) } : {}),
  };
}

function translateProvider(provider, models) {
  return {
    id: provider.id,
    name: provider.name,
    source: 'api',
    env: [],
    options: {},
    models: Object.fromEntries(models.map((model) => [model.id, model])),
  };
}

function translateSnapshot(runtime, registry, availableModels) {
  const providerModels = new Map();
  for (const model of availableModels) {
    if (!model || typeof model.id !== 'string' || typeof model.provider !== 'string') continue;
    const models = providerModels.get(model.provider) || [];
    models.push(translateModel(model));
    providerModels.set(model.provider, models);
  }

  const providers = [];
  for (const provider of runtime.getProviders()) {
    const models = providerModels.get(provider.id);
    if (!models?.length) continue;
    const name = typeof registry.getProviderDisplayName === 'function'
      ? registry.getProviderDisplayName(provider.id)
      : provider.name;
    providers.push(translateProvider({ ...provider, name }, models));
  }

  const defaults = Object.fromEntries(providers.map((provider) => [provider.id, Object.keys(provider.models)[0]]));
  const firstProvider = providers[0];
  const firstModel = firstProvider ? Object.keys(firstProvider.models)[0] : undefined;
  return {
    providers,
    default: defaults,
    defaultModel: firstProvider && firstModel ? `${firstProvider.id}/${firstModel}` : undefined,
    connected: providers.map((provider) => provider.id),
  };
}

/**
 * Pi's ModelRuntime owns catalog loading, auth resolution, and refresh policy.
 * This module only snapshots its authenticated selectable models into the
 * OpenCode 1.17.18 provider contract. Credentials and request configuration
 * never cross this boundary.
 */
export function createPiModelCatalog(options = {}) {
  const createRuntime = options.createRuntime || ((runtimeOptions) => ModelRuntime.create(runtimeOptions));
  const createRegistry = options.createRegistry || ((runtime) => new ModelRegistry(runtime));
  const runtimeOptions = {
    ...(options.runtimeOptions || {}),
    ...(options.allowModelNetwork === undefined ? {} : { allowModelNetwork: options.allowModelNetwork }),
    ...(options.modelRefreshTimeoutMs === undefined ? {} : { modelRefreshTimeoutMs: options.modelRefreshTimeoutMs }),
  };
  if (runtimeOptions.modelRefreshTimeoutMs === undefined) runtimeOptions.modelRefreshTimeoutMs = DEFAULT_REFRESH_TIMEOUT_MS;
  const cacheTtlMs = isFinitePositive(options.cacheTtlMs) ? options.cacheTtlMs : DEFAULT_CACHE_TTL_MS;
  const now = options.now || (() => Date.now());
  let cached;
  let cachedAt = 0;
  let inFlight;
  let generation = 0;

  const load = async (loadGeneration) => {
    const runtime = await createRuntime(runtimeOptions);
    const registry = createRegistry(runtime);
    // ModelRuntime.getAvailable() is the same auth-filtered set used by Pi CLI.
    const available = await runtime.getAvailable();
    const snapshot = translateSnapshot(runtime, registry, available);
    if (loadGeneration === generation) {
      cached = snapshot;
      cachedAt = now();
    }
    return snapshot;
  };

  const getSnapshot = () => {
    if (cached && now() - cachedAt < cacheTtlMs) return Promise.resolve(cached);
    if (inFlight) return inFlight;
    const loadGeneration = generation;
    const request = load(loadGeneration).finally(() => {
      if (inFlight === request) inFlight = undefined;
    });
    inFlight = request;
    return request;
  };

  return {
    getSnapshot,
    invalidate() {
      generation += 1;
      cached = undefined;
      cachedAt = 0;
    },
  };
}

export { translateModel, translateSnapshot };

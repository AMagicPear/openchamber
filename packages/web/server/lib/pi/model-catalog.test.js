import { describe, expect, it, vi } from 'vitest';
import { createPiModelCatalog, translateModel, translateSnapshot } from './model-catalog.js';

const model = (overrides = {}) => ({
  id: 'model/one',
  name: 'Model One',
  provider: 'provider-one',
  api: 'openai-completions',
  baseUrl: 'https://example.test/v1',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
  contextWindow: 1000,
  maxTokens: 200,
  ...overrides,
});

const runtimeHarness = (available, providers = [{ id: 'provider-one', name: 'Provider One' }]) => ({
  getAvailable: vi.fn(async () => available),
  getProviders: vi.fn(() => providers),
});

describe('Pi model catalog', () => {
  it('translates the Pi model into the installed OpenCode model contract without secrets', () => {
    const translated = translateModel(model({
      baseUrl: 'https://user:password@example.test/v1?api_key=secret#private',
      headers: { Authorization: 'secret' },
    }));
    expect(translated).toMatchObject({
      id: 'model/one',
      providerID: 'provider-one',
      name: 'Model One',
      api: { id: 'openai-completions', url: 'https://example.test/v1', npm: '' },
      capabilities: {
        reasoning: true,
        attachment: true,
        input: { text: true, image: true },
        output: { text: true, image: false },
      },
      cost: { input: 1, output: 2, cache: { read: 3, write: 4 } },
      limit: { context: 1000, output: 200 },
    });
    expect(JSON.stringify(translated)).not.toContain('secret');
    expect(JSON.stringify(translated)).not.toContain('password');
    expect(translated.headers).toEqual({});
    expect(translated.release_date).toBe('');
  });

  it('keeps only authenticated available models and creates deterministic defaults', () => {
    const runtime = runtimeHarness([
      model(),
      model({ id: 'model/two', provider: 'provider-two', name: 'Model Two' }),
    ], [
      { id: 'provider-one', name: 'Provider One' },
      { id: 'provider-two', name: 'Provider Two' },
      { id: 'not-authenticated', name: 'Not Authenticated' },
    ]);
    const registry = { getProviderDisplayName: vi.fn((id) => id === 'provider-two' ? 'Pi Provider Two' : 'Provider One') };
    const snapshot = translateSnapshot(runtime, registry, [model(), model({ id: 'model/two', provider: 'provider-two', name: 'Model Two' })]);

    expect(snapshot.default).toEqual({ 'provider-one': 'model/one', 'provider-two': 'model/two' });
    expect(snapshot.defaultModel).toBe('provider-one/model/one');
    expect(snapshot.connected).toEqual(['provider-one', 'provider-two']);
    expect(snapshot.providers).toHaveLength(2);
    expect(snapshot.providers[1].name).toBe('Pi Provider Two');
    expect(snapshot.providers[0].models).toEqual({
      'model/one': expect.objectContaining({ id: 'model/one', providerID: 'provider-one' }),
    });
    expect(JSON.stringify(snapshot)).not.toContain('not-authenticated');
  });

  it('deduplicates, caches successful snapshots, retries failures, and invalidates explicitly', async () => {
    let now = 100;
    const runtime = runtimeHarness([model()]);
    const createRuntime = vi.fn(async () => runtime);
    const catalog = createPiModelCatalog({
      createRuntime,
      createRegistry: () => ({ getProviderDisplayName: () => 'Provider One' }),
      cacheTtlMs: 10,
      now: () => now,
    });

    const [first, second] = await Promise.all([catalog.getSnapshot(), catalog.getSnapshot()]);
    expect(first).toBe(second);
    expect(createRuntime).toHaveBeenCalledTimes(1);
    await catalog.getSnapshot();
    expect(createRuntime).toHaveBeenCalledTimes(1);

    now = 111;
    await catalog.getSnapshot();
    expect(createRuntime).toHaveBeenCalledTimes(2);

    const failure = new Error('catalog failed');
    createRuntime.mockRejectedValueOnce(failure);
    catalog.invalidate();
    await expect(catalog.getSnapshot()).rejects.toBe(failure);
    await expect(catalog.getSnapshot()).resolves.toBeTruthy();
    expect(createRuntime).toHaveBeenCalledTimes(4);
  });

  it('passes offline and bounded refresh options directly to Pi', async () => {
    const runtime = runtimeHarness([]);
    const createRuntime = vi.fn(async () => runtime);
    const catalog = createPiModelCatalog({
      createRuntime,
      allowModelNetwork: false,
      modelRefreshTimeoutMs: 321,
    });
    await catalog.getSnapshot();
    expect(createRuntime).toHaveBeenCalledWith({ allowModelNetwork: false, modelRefreshTimeoutMs: 321 });
  });
});

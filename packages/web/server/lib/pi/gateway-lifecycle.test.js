import { describe, expect, it, vi } from 'vitest';
import { createPiGatewayLifecycleRuntime } from './gateway-lifecycle.js';

function createState() {
  return {
    openCodeWorkingDirectory: '/tmp',
    openCodeProcess: null,
    openCodePort: null,
    openCodeBaseUrl: null,
    openCodeApiPrefix: '',
    openCodeApiPrefixDetected: false,
    currentRestartPromise: null,
    isRestartingOpenCode: false,
    isOpenCodeReady: false,
    openCodeNotReadySince: 0,
    isExternalOpenCode: false,
    isShuttingDown: false,
    lastOpenCodeError: null,
    healthCheckInterval: null,
    expressApp: null,
  };
}

function createRuntime(overrides = {}) {
  const state = createState();
  const managers = [];
  const gateways = [];
  const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ healthy: true }) }));
  const runtime = createPiGatewayLifecycleRuntime({
    state,
    fetchImpl,
    createRpcProcessManager: vi.fn(() => {
      const manager = { shutdown: vi.fn(async () => {}) };
      managers.push(manager);
      return manager;
    }),
    createSessionRepository: vi.fn(() => ({})),
    createCompatibilityGateway: vi.fn(() => {
      const port = 4000 + gateways.length;
      const gateway = {
        start: vi.fn(async () => ({ url: `http://127.0.0.1:${port}`, port })),
        close: vi.fn(async () => {}),
      };
      gateways.push(gateway);
      return gateway;
    }),
    setupProxy: vi.fn(),
    ensureOpenCodeApiPrefix: vi.fn(),
    syncToHmrState: vi.fn(),
    syncFromHmrState: vi.fn(),
    healthFailureLimit: 5,
    ...overrides,
  });
  return { runtime, state, managers, gateways, fetchImpl: overrides.fetchImpl || fetchImpl };
}

describe('Pi gateway lifecycle', () => {
  it('starts with fresh resources, proves health, and closes gateway before RPC manager', async () => {
    const { runtime, state, managers, gateways } = createRuntime();
    const handle = await runtime.startOpenCode();

    expect(handle).toMatchObject({ backend: 'pi', pid: null, url: 'http://127.0.0.1:4000' });
    expect(state.openCodePort).toBe(4000);
    expect(state.openCodeBaseUrl).toBe(handle.url);
    await handle.close();
    await handle.close();
    expect(gateways[0].close).toHaveBeenCalledTimes(1);
    expect(managers[0].shutdown).toHaveBeenCalledTimes(1);
  });

  it('reuses a genuinely healthy existing handle during bootstrap', async () => {
    const { runtime, state, managers } = createRuntime();
    const first = await runtime.startOpenCode();
    const second = await runtime.bootstrapOpenCodeAtStartup();

    expect(second).toBeUndefined();
    expect(state.openCodeProcess).toBe(first);
    expect(managers).toHaveLength(1);
  });

  it('does not reuse a healthy handle from another backend', async () => {
    const { runtime, state, managers } = createRuntime();
    const foreignClose = vi.fn(async () => {});
    state.openCodeProcess = {
      backend: 'opencode',
      url: 'http://127.0.0.1:3999',
      close: foreignClose,
    };

    await runtime.bootstrapOpenCodeAtStartup();

    expect(foreignClose).toHaveBeenCalledTimes(1);
    expect(state.openCodeProcess).toMatchObject({ backend: 'pi', url: 'http://127.0.0.1:4000' });
    expect(managers).toHaveLength(1);
  });

  it('fully replaces old resources on restart', async () => {
    const { runtime, state, managers, gateways } = createRuntime();
    await runtime.startOpenCode();
    await runtime.restartOpenCode();

    expect(gateways[0].close).toHaveBeenCalledTimes(1);
    expect(managers[0].shutdown).toHaveBeenCalledTimes(1);
    expect(managers).toHaveLength(2);
    expect(state.openCodePort).toBe(4001);
  });

  it('cleans up all resources when gateway startup fails', async () => {
    const gatewayClose = vi.fn(async () => {});
    const managerShutdown = vi.fn(async () => {});
    const { runtime, state } = createRuntime({
      createRpcProcessManager: () => ({ shutdown: managerShutdown }),
      createCompatibilityGateway: () => ({ start: vi.fn(async () => { throw new Error('bind failed'); }), close: gatewayClose }),
    });

    await expect(runtime.startOpenCode()).rejects.toThrow('bind failed');
    expect(gatewayClose).toHaveBeenCalledTimes(1);
    expect(managerShutdown).toHaveBeenCalledTimes(1);
    expect(state.openCodePort).toBeNull();
  });

  it('serializes overlapping health probes', async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const healthFetch = vi.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.resolve({ ok: true, json: async () => ({ healthy: true }) }) : pending;
    });
    const { runtime, fetchImpl: runtimeFetch } = createRuntime({
      fetchImpl: healthFetch,
    });
    await runtime.startOpenCode();
    runtimeFetch.mockClear();
    const first = runtime.triggerHealthCheck();
    const second = runtime.triggerHealthCheck();
    await Promise.resolve();
    expect(runtimeFetch).toHaveBeenCalledTimes(1);
    release({ ok: true, json: async () => ({ healthy: true }) });
    await Promise.all([first, second]);
  });

  it('reports agent presence as unsupported and does not claim verification on refresh', async () => {
    const { runtime } = createRuntime();
    await runtime.startOpenCode();
    await expect(runtime.waitForAgentPresence('default')).rejects.toThrow('unsupported');
    await expect(runtime.refreshOpenCodeAfterConfigChange('test', { agentName: 'default' }))
      .resolves.toMatchObject({ reloaded: true, agentVerified: false, agentVerification: 'unsupported' });
  });
});


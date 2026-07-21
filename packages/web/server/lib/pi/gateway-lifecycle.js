import { createPiCompatibilityGateway } from './gateway.js';
import { createPiRpcProcessManager } from './rpc-process-manager.js';
import { createPiSessionRepository } from './session-repository.js';
import { createPiModelCatalog } from './model-catalog.js';

const HEALTH_PATH = '/global/health';
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;
const DEFAULT_HEALTH_FAILURE_LIMIT = 3;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Pi's in-process equivalent of createOpenCodeLifecycleRuntime.
 * OpenCode names are retained because the server proxy, watcher, and shutdown
 * composition already consume those names; the returned handle is a gateway,
 * not a detached OpenCode child process.
 */
export function createPiGatewayLifecycleRuntime(dependencies = {}) {
  const {
    state,
    syncToHmrState = () => {},
    syncFromHmrState = () => {},
    setOpenCodePort = (port) => { state.openCodePort = port; },
    setDetectedOpenCodeApiPrefix = () => {},
    setupProxy,
    ensureOpenCodeApiPrefix,
    createRpcProcessManager = (options) => createPiRpcProcessManager(options),
    createSessionRepository = (options) => createPiSessionRepository(options),
    createModelCatalog = (options) => createPiModelCatalog(options),
    createCompatibilityGateway = (options) => createPiCompatibilityGateway(options),
    rpcProcessManagerOptions = {},
    sessionRepositoryOptions = {},
    modelCatalogOptions = {},
    gatewayOptions = {},
    fetchImpl = fetch,
    healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
    healthFailureLimit = DEFAULT_HEALTH_FAILURE_LIMIT,
  } = dependencies;

  if (!state || typeof state !== 'object') throw new TypeError('state is required');

  const boundedHealthTimeoutMs = positiveInteger(healthTimeoutMs, DEFAULT_HEALTH_TIMEOUT_MS);
  const boundedHealthFailureLimit = positiveInteger(healthFailureLimit, DEFAULT_HEALTH_FAILURE_LIMIT);
  let healthProbePromise = null;
  let healthCyclePromise = null;
  let consecutiveHealthFailures = 0;

  const setGatewayState = ({ url, port }) => {
    state.openCodeBaseUrl = url;
    state.openCodeApiPrefix = '';
    state.openCodeApiPrefixDetected = true;
    state.isExternalOpenCode = false;
    setOpenCodePort(port);
    setDetectedOpenCodeApiPrefix('');
    state.isOpenCodeReady = true;
    state.lastOpenCodeError = null;
    state.openCodeNotReadySince = 0;
    syncToHmrState();
  };

  const clearGatewayState = () => {
    state.openCodeProcess = null;
    state.openCodePort = null;
    state.openCodeBaseUrl = null;
    state.openCodeApiPrefix = '';
    state.openCodeApiPrefixDetected = true;
    state.isOpenCodeReady = false;
    syncToHmrState();
  };

  const healthUrl = (url) => `${String(url).replace(/\/+$/, '')}${HEALTH_PATH}`;

  const probeHealth = async (url) => {
    if (typeof url !== 'string' || !url) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), boundedHealthTimeoutMs);
    try {
      const response = await fetchImpl(healthUrl(url), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response?.ok) return false;
      const body = await response.json().catch(() => null);
      return body?.healthy === true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  const closeResources = async ({ gateway, processManager }) => {
    let firstError = null;
    try {
      await gateway?.close?.();
    } catch (error) {
      firstError = error;
    }
    try {
      await processManager?.shutdown?.();
    } catch (error) {
      firstError ||= error;
    }
    if (firstError) throw firstError;
  };

  const closeHandle = (handle) => {
    if (!handle || typeof handle.close !== 'function') return Promise.resolve();
    return handle.close();
  };

  const closeCurrentGateway = async () => {
    const current = state.openCodeProcess;
    if (!current) {
      clearGatewayState();
      return;
    }
    try {
      await closeHandle(current);
    } finally {
      if (state.openCodeProcess === current) clearGatewayState();
    }
  };

  const startOpenCode = async () => {
    if (state.openCodeProcess) await closeCurrentGateway();
    const processManager = createRpcProcessManager({ ...rpcProcessManagerOptions });
    const sessionRepository = createSessionRepository({ ...sessionRepositoryOptions });
    const modelCatalog = createModelCatalog({ ...modelCatalogOptions });
    const gateway = createCompatibilityGateway({
      ...gatewayOptions,
      processManager,
      sessionRepository,
      modelCatalog,
      defaultDirectory: state.openCodeWorkingDirectory || process.cwd(),
    });

    let started = false;
    try {
      const result = await gateway.start();
      if (!result?.url || !Number.isInteger(result.port) || result.port <= 0) {
        throw new Error('Pi compatibility gateway started without a valid loopback URL');
      }
      if (!(await probeHealth(result.url))) {
        throw new Error('Pi compatibility gateway started but health check failed');
      }

      const handle = {
        backend: 'pi',
        url: result.url,
        pid: null,
        closePromise: null,
        close() {
          if (!this.closePromise) {
            this.closePromise = closeResources({ gateway, processManager });
          }
          return this.closePromise;
        },
      };
      started = true;
      setGatewayState(result);
      state.openCodeProcess = handle;
      syncToHmrState();
      return handle;
    } catch (error) {
      if (!started) {
        await closeResources({ gateway, processManager }).catch(() => {});
      }
      state.lastOpenCodeError = error instanceof Error ? error.message : String(error);
      clearGatewayState();
      throw error;
    }
  };

  const restartOpenCode = async () => {
    if (state.isShuttingDown) return;
    if (state.currentRestartPromise) return state.currentRestartPromise;

    state.currentRestartPromise = (async () => {
      state.isRestartingOpenCode = true;
      state.isOpenCodeReady = false;
      state.openCodeNotReadySince = Date.now();
      await closeCurrentGateway();
      state.openCodeProcess = await startOpenCode();
      setupProxy?.(state.expressApp);
      ensureOpenCodeApiPrefix?.();
      consecutiveHealthFailures = 0;
    })();

    try {
      await state.currentRestartPromise;
    } finally {
      state.currentRestartPromise = null;
      state.isRestartingOpenCode = false;
      syncToHmrState();
    }
  };

  const waitForOpenCodeReady = async (timeoutMs = 20_000, intervalMs = 400) => {
    if (!state.openCodePort || !state.openCodeProcess?.url) {
      throw new Error('Pi gateway port is not available');
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await probeHealth(state.openCodeProcess.url)) {
        state.isOpenCodeReady = true;
        state.lastOpenCodeError = null;
        return;
      }
      await delay(intervalMs);
    }
    const error = new Error('Timed out waiting for Pi compatibility gateway to become ready');
    state.lastOpenCodeError = error.message;
    throw error;
  };

  const waitForAgentPresence = async () => {
    throw new Error('Agent presence verification is unsupported by the Pi backend');
  };

  const refreshOpenCodeAfterConfigChange = async (reason, options = {}) => {
    await restartOpenCode();
    await waitForOpenCodeReady();
    return {
      reloaded: true,
      external: false,
      agentVerified: false,
      ...(options.agentName ? { agentVerification: 'unsupported' } : {}),
      reason,
    };
  };

  const bootstrapOpenCodeAtStartup = async () => {
    syncFromHmrState();
    const existing = state.openCodeProcess;
    if (existing?.backend === 'pi' && existing.url && await probeHealth(existing.url)) {
      const port = Number.parseInt(new URL(existing.url).port, 10);
      if (port > 0) {
        setGatewayState({ url: existing.url, port });
        state.openCodeProcess = existing;
        return;
      }
    }

    if (existing) await closeCurrentGateway();
    try {
      state.openCodeProcess = await startOpenCode();
      await waitForOpenCodeReady();
    } catch (error) {
      state.lastOpenCodeError = error instanceof Error ? error.message : String(error);
      state.isOpenCodeReady = false;
      syncToHmrState();
    }
  };

  const runHealthCheckCycle = async () => {
    if (state.isShuttingDown || state.isRestartingOpenCode || !state.openCodeProcess?.url) return;
    if (healthCyclePromise) return healthCyclePromise;
    healthCyclePromise = (async () => {
      const healthy = await (healthProbePromise ||= probeHealth(state.openCodeProcess.url)
        .finally(() => { healthProbePromise = null; }));
      if (healthy) {
        consecutiveHealthFailures = 0;
        state.isOpenCodeReady = true;
        return;
      }
      consecutiveHealthFailures += 1;
      if (consecutiveHealthFailures >= boundedHealthFailureLimit) {
        consecutiveHealthFailures = 0;
        await restartOpenCode();
      }
    })().finally(() => { healthCyclePromise = null; });
    return healthCyclePromise;
  };

  const triggerHealthCheck = async () => {
    try {
      await runHealthCheckCycle();
    } catch (error) {
      state.lastOpenCodeError = error instanceof Error ? error.message : String(error);
    }
  };

  const startHealthMonitoring = (healthCheckIntervalMs) => {
    if (state.healthCheckInterval) clearInterval(state.healthCheckInterval);
    state.healthCheckInterval = setInterval(() => { void triggerHealthCheck(); }, positiveInteger(healthCheckIntervalMs, 15_000));
    state.healthCheckInterval.unref?.();
  };

  return {
    startOpenCode,
    restartOpenCode,
    waitForOpenCodeReady,
    waitForAgentPresence,
    refreshOpenCodeAfterConfigChange,
    bootstrapOpenCodeAtStartup,
    startHealthMonitoring,
    triggerHealthCheck,
    killProcessOnPort: () => {},
    waitForPortRelease: async () => true,
  };
}


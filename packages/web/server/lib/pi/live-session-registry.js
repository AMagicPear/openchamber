import { randomUUID } from 'node:crypto';
import path from 'node:path';

function normalizedPath(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
  return path.resolve(value);
}

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function identityKey(cwd, sessionId) {
  return JSON.stringify([cwd, sessionId]);
}

function authoritativeState(process, sessionId) {
  const state = process?.state;
  if (!state || typeof state !== 'object') throw new Error('Pi readiness did not return authoritative state');
  if (state.sessionId !== sessionId || process.sessionId !== sessionId) {
    throw new Error('Pi readiness returned a different session identity');
  }
  const sessionPath = state.sessionFile;
  if (typeof sessionPath !== 'string' || !path.isAbsolute(sessionPath)) {
    throw new Error('Pi readiness did not return an authoritative session path');
  }
  return { state, sessionPath: path.resolve(sessionPath) };
}

function publicBinding(binding) {
  return {
    cwd: binding.cwd,
    sessionId: binding.sessionId,
    generation: binding.generation,
    processKey: binding.processKey,
    processGeneration: binding.processGeneration,
    sessionPath: binding.sessionPath,
    state: binding.state,
    createdAt: binding.createdAt,
  };
}

/**
 * Owns the short-lived gateway binding between an OpenCode identity and Pi RPC.
 * Historical session catalogs never establish a live binding.
 */
export function createPiLiveSessionRegistry(options = {}) {
  const processManager = options.processManager;
  if (!processManager || typeof processManager.ensureProcess !== 'function') {
    throw new TypeError('processManager.ensureProcess is required');
  }
  if (typeof processManager.stopProcess !== 'function' || typeof processManager.subscribe !== 'function') {
    throw new TypeError('processManager must provide stopProcess and subscribe');
  }
  const makeId = options.randomUUID || randomUUID;
  if (typeof makeId !== 'function') throw new TypeError('randomUUID must be a function');

  const bindings = new Map();
  let generation = 0;

  function removeBinding(binding) {
    const key = identityKey(binding.cwd, binding.sessionId);
    if (bindings.get(key) !== binding) return false;
    bindings.delete(key);
    binding.unsubscribe?.();
    binding.unsubscribe = undefined;
    return true;
  }

  async function stopOwnedProcess(binding, process) {
    if (!process || process.generation !== binding.processGeneration) return;
    await processManager.stopProcess(binding.processKey).catch(() => {});
  }

  function watchProcess(binding) {
    binding.unsubscribe = processManager.subscribe(binding.processKey, (event) => {
      if (
        event?.type === 'lifecycle' &&
        event.event === 'process_failed' &&
        event.generation === binding.processGeneration
      ) {
        removeBinding(binding);
      }
    });
  }

  function create({ cwd, sessionId } = {}) {
    const normalizedCwd = normalizedPath(cwd, 'cwd');
    const requestedId = sessionId === undefined ? makeId() : nonEmptyString(sessionId, 'sessionId');
    const key = identityKey(normalizedCwd, requestedId);
    const existing = bindings.get(key);
    if (existing) return existing.readyPromise;

    const binding = {
      cwd: normalizedCwd,
      sessionId: requestedId,
      generation: ++generation,
      processKey: `pi:${key}`,
      processGeneration: undefined,
      sessionPath: undefined,
      state: undefined,
      createdAt: Date.now(),
      readyPromise: undefined,
      unsubscribe: undefined,
    };
    bindings.set(key, binding);

    binding.readyPromise = (async () => {
      let process;
      try {
        process = await processManager.ensureProcess({
          key: binding.processKey,
          cwd: binding.cwd,
          sessionId: binding.sessionId,
        });
        binding.processGeneration = process?.generation;
        const authoritative = authoritativeState(process, binding.sessionId);
        if (bindings.get(key) !== binding) throw new Error('Pi session binding became stale during startup');
        binding.sessionPath = authoritative.sessionPath;
        binding.state = authoritative.state;
        watchProcess(binding);
        return publicBinding(binding);
      } catch (error) {
        const stillOwned = bindings.get(key) === binding;
        if (stillOwned) removeBinding(binding);
        if (stillOwned && process) await stopOwnedProcess(binding, process);
        throw error;
      }
    })();

    return binding.readyPromise;
  }

  function get({ cwd, sessionId } = {}) {
    const normalizedCwd = normalizedPath(cwd, 'cwd');
    const id = nonEmptyString(sessionId, 'sessionId');
    const binding = bindings.get(identityKey(normalizedCwd, id));
    if (!binding || !binding.state || !binding.sessionPath) return undefined;
    return publicBinding(binding);
  }

  async function remove({ cwd, sessionId } = {}) {
    const normalizedCwd = normalizedPath(cwd, 'cwd');
    const id = nonEmptyString(sessionId, 'sessionId');
    const binding = bindings.get(identityKey(normalizedCwd, id));
    if (!binding) return false;
    removeBinding(binding);
    await processManager.stopProcess(binding.processKey).catch(() => {});
    return true;
  }

  async function close() {
    const current = Array.from(bindings.values());
    for (const binding of current) {
      removeBinding(binding);
      await processManager.stopProcess(binding.processKey).catch(() => {});
    }
  }

  return { get, create, remove, close };
}

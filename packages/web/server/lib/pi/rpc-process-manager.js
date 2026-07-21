import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_JSONL_RECORD_BYTES = 1024 * 1024;
const DEFAULT_MAX_DIAGNOSTIC_BYTES = 64 * 1024;

function asPositiveInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function validateString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function normalizeAbsolutePath(value, name) {
  validateString(value, name);
  if (!path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
  return path.resolve(value);
}

function defaultResolveLaunchSpec() {
  return {
    command: process.env.PI_BINARY || process.env.PICHAMBER_PI_PATH || 'pi',
    args: [],
  };
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorFromResponse(command, response) {
  const detail = typeof response.error === 'string' && response.error ? `: ${response.error}` : '';
  return new Error(`Pi RPC command ${command.type} failed${detail}`);
}

/**
 * Owns one `pi --mode rpc` child process for each live runtime/session key.
 * This module deliberately has no HTTP or OpenCode schema knowledge.
 */
export function createPiRpcProcessManager(options = {}) {
  const spawnProcess = options.spawnProcess || spawn;
  const resolveLaunchSpec = options.resolveLaunchSpec || defaultResolveLaunchSpec;
  const maxProcesses = asPositiveInteger(options.maxProcesses, 'maxProcesses', Infinity);
  const maxJsonlRecordBytes = asPositiveInteger(
    options.maxJsonlRecordBytes,
    'maxJsonlRecordBytes',
    DEFAULT_MAX_JSONL_RECORD_BYTES,
  );
  const maxDiagnosticBytes = asPositiveInteger(
    options.maxDiagnosticBytes,
    'maxDiagnosticBytes',
    DEFAULT_MAX_DIAGNOSTIC_BYTES,
  );
  const requestTimeoutMs = asPositiveInteger(options.requestTimeoutMs, 'requestTimeoutMs', DEFAULT_REQUEST_TIMEOUT_MS);
  const readyTimeoutMs = asPositiveInteger(options.readyTimeoutMs, 'readyTimeoutMs', DEFAULT_READY_TIMEOUT_MS);
  const stopTimeoutMs = asPositiveInteger(options.stopTimeoutMs, 'stopTimeoutMs', DEFAULT_STOP_TIMEOUT_MS);
  const forceKillTimeoutMs = asPositiveInteger(
    options.forceKillTimeoutMs,
    'forceKillTimeoutMs',
    stopTimeoutMs,
  );
  const killProcess = options.killProcess || ((pid, signal) => process.kill(pid, signal));
  const spawnTaskkill = options.spawnTaskkill || spawnProcess;

  const entries = new Map();
  const sessionPathClaims = new Map();
  const sessionIdentityClaims = new Map();
  const subscribers = new Map();
  let generation = 0;
  let shuttingDown = false;
  let shutdownPromise;

  function validateKey(key) {
    validateString(key, 'key');
  }

  function getSubscribers(key) {
    let listeners = subscribers.get(key);
    if (!listeners) {
      listeners = new Set();
      subscribers.set(key, listeners);
    }
    return listeners;
  }

  function broadcast(key, record) {
    const listeners = subscribers.get(key);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(record);
      } catch {
        // A subscriber is not allowed to break protocol processing.
      }
    }
  }

  function sessionIdentityKey(cwd, sessionId) {
    return JSON.stringify([cwd, sessionId]);
  }

  function claimSessionIdentity(entry, sessionId) {
    const claimKey = sessionIdentityKey(entry.cwd, sessionId);
    const claimed = sessionIdentityClaims.get(claimKey);
    if (claimed && claimed !== entry) {
      throw new Error(`Pi session identity is already claimed by key ${claimed.key}`);
    }
    sessionIdentityClaims.set(claimKey, entry);
    entry.sessionIdentityClaims.add(claimKey);
  }

  function releaseEntry(entry) {
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    if (entry.sessionPath && sessionPathClaims.get(entry.sessionPath) === entry) {
      sessionPathClaims.delete(entry.sessionPath);
    }
    for (const claimKey of entry.sessionIdentityClaims) {
      if (sessionIdentityClaims.get(claimKey) === entry) sessionIdentityClaims.delete(claimKey);
    }
  }

  function rejectPending(entry, error) {
    for (const pending of entry.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    entry.pending.clear();
  }

  function removeProcessListeners(entry) {
    const child = entry.child;
    if (!child || typeof child.removeListener !== 'function') return;
    child.removeListener('error', entry.onError);
    child.removeListener('exit', entry.onExit);
    child.removeListener('close', entry.onClose);
    entry.stdout?.removeListener?.('data', entry.onStdoutData);
    entry.stdout?.removeListener?.('end', entry.onStdoutEnd);
    entry.stderr?.removeListener?.('data', entry.onStderrData);
  }

  function signalChild(entry, force) {
    const child = entry.child;
    if (!child) return;

    if (process.platform === 'win32' && child.pid) {
      try {
        const args = ['/PID', String(child.pid), '/T'];
        if (force) args.push('/F');
        const taskkill = spawnTaskkill('taskkill', args, { stdio: 'ignore', windowsHide: true });
        taskkill?.on?.('error', () => {});
      } catch {
        // Fall back to the child handle below.
      }
    }

    if (process.platform !== 'win32' && child.pid) {
      try {
        killProcess(-Math.abs(child.pid), force ? 'SIGKILL' : 'SIGTERM');
        return;
      } catch {
        // The process may have exited, or the platform may not support groups.
      }
    }

    try {
      child.kill?.(force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      // Teardown is best effort after the process has already failed.
    }
  }

  function closeStdin(entry) {
    try {
      entry.stdin?.end?.();
    } catch {
      // The child may have already closed stdin.
    }
  }

  function waitForClose(entry, timeoutMs) {
    if (entry.closed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        entry.closeWaiters.delete(resolve);
        resolve(false);
      }, timeoutMs);
      entry.closeWaiters.set(resolve, timer);
    });
  }

  function resolveCloseWaiters(entry) {
    for (const [resolve, timer] of entry.closeWaiters) {
      clearTimeout(timer);
      resolve(true);
    }
    entry.closeWaiters.clear();
  }

  function markClosed(entry) {
    if (entry.closed) return;
    entry.closed = true;
    resolveCloseWaiters(entry);
    removeProcessListeners(entry);
  }

  function failEntry(entry, reason, terminate = true) {
    if (entry.failureHandled || entry.stopping) return;
    entry.failureHandled = true;
    const error = new Error(`Pi RPC process failed (${reason})`);
    rejectPending(entry, error);
    releaseEntry(entry);
    broadcast(entry.key, { type: 'lifecycle', event: 'process_failed', generation: entry.generation });
    if (terminate) {
      closeStdin(entry);
      signalChild(entry, false);
    }
  }

  function handleRecord(entry, record) {
    if (entry.failureHandled || entry.stopping) return;

    if (isRecord(record) && record.type === 'agent_start') entry.busy = true;
    if (isRecord(record) && record.type === 'agent_settled') entry.busy = false;

    if (isRecord(record) && record.type === 'response' && typeof record.id === 'string') {
      const pending = entry.pending.get(record.id);
      if (pending) {
        entry.pending.delete(record.id);
        clearTimeout(pending.timer);
        if (record.success === true) {
          pending.resolve(record.data);
        } else if (record.success === false) {
          pending.reject(errorFromResponse(pending.command, record));
        } else {
          pending.reject(new Error(`Pi RPC command ${pending.command.type} returned an invalid response`));
        }
        return;
      }
    }

    broadcast(entry.key, record);
  }

  function createParser(entry) {
    const decoder = new StringDecoder('utf8');
    let textBuffer = '';
    let recordBytes = 0;
    const completedRecordBytes = [];

    function failOversized() {
      failEntry(entry, 'record_too_large');
    }

    function feed(chunk) {
      if (entry.failureHandled || entry.stopping) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));

      for (const byte of bytes) {
        if (byte === 0x0a) {
          completedRecordBytes.push(recordBytes);
          recordBytes = 0;
        } else {
          recordBytes += 1;
          if (recordBytes > maxJsonlRecordBytes) {
            failOversized();
            return;
          }
        }
      }

      textBuffer += decoder.write(bytes);
      while (true) {
        const newlineIndex = textBuffer.indexOf('\n');
        if (newlineIndex === -1) return;
        const line = textBuffer.slice(0, newlineIndex);
        textBuffer = textBuffer.slice(newlineIndex + 1);
        const lineBytes = completedRecordBytes.shift();
        if (lineBytes > maxJsonlRecordBytes) {
          failOversized();
          return;
        }
        handleLine(line.endsWith('\r') ? line.slice(0, -1) : line);
        if (entry.failureHandled) return;
      }
    }

    function finish() {
      if (entry.failureHandled || entry.stopping) return;
      textBuffer += decoder.end();
      if (!textBuffer) return;
      if (recordBytes > maxJsonlRecordBytes) {
        failOversized();
        return;
      }
      handleLine(textBuffer.endsWith('\r') ? textBuffer.slice(0, -1) : textBuffer);
      textBuffer = '';
    }

    function handleLine(line) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        failEntry(entry, 'malformed_json');
        return;
      }
      handleRecord(entry, record);
    }

    return { feed, finish };
  }

  function attachChild(entry, child) {
    entry.child = child;
    entry.stdin = child.stdin;
    entry.stdout = child.stdout;
    entry.stderr = child.stderr;
    entry.parser = createParser(entry);

    entry.onStdoutData = (chunk) => entry.parser.feed(chunk);
    entry.onStdoutEnd = () => entry.parser.finish();
    entry.onStderrData = (chunk) => {
      entry.stderrBytes = Math.min(maxDiagnosticBytes, entry.stderrBytes + Buffer.byteLength(chunk));
    };
    entry.onError = () => failEntry(entry, 'process_error');
    entry.onExit = () => failEntry(entry, 'process_exit');
    entry.onClose = () => {
      markClosed(entry);
      if (!entry.stopping && !entry.failureHandled) failEntry(entry, 'process_close', false);
    };

    child.stdout?.on?.('data', entry.onStdoutData);
    child.stdout?.on?.('end', entry.onStdoutEnd);
    child.stderr?.on?.('data', entry.onStderrData);
    child.on?.('error', entry.onError);
    child.on?.('exit', entry.onExit);
    child.on?.('close', entry.onClose);
  }

  function writeToStdin(entry, payload) {
    return new Promise((resolve, reject) => {
      let callbackCalled = false;
      let drained = true;
      let writeReturned = false;
      let settled = false;

      const finish = (error) => {
        if (error) {
          if (!settled) {
            settled = true;
            reject(error);
          }
          return;
        }
        if (callbackCalled && drained && writeReturned && !settled) {
          settled = true;
          resolve();
        }
      };
      const onDrain = () => {
        drained = true;
        entry.stdin?.removeListener?.('drain', onDrain);
        finish();
      };

      try {
        drained = entry.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
          callbackCalled = true;
          finish(error);
        });
        writeReturned = true;
        if (!drained) entry.stdin.once?.('drain', onDrain);
        else finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function requestEntry(entry, command, timeoutMs) {
    const id = `pi_${randomUUID()}`;
    const requestCommand = { ...command, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!entry.pending.delete(id)) return;
        reject(new Error(`Pi RPC command ${command.type} timed out`));
      }, timeoutMs);
      entry.pending.set(id, { command, resolve, reject, timer });
      void writeToStdin(entry, requestCommand).catch((error) => {
        if (!entry.pending.delete(id)) return;
        clearTimeout(timer);
        reject(error);
        failEntry(entry, 'stdin_error');
      });
    });
  }

  async function initializeEntry(entry, sessionId) {
    try {
      const resolved = await resolveLaunchSpec({
        key: entry.key,
        cwd: entry.cwd,
        sessionPath: entry.sessionPath,
        sessionId,
      });
      if (!resolved || typeof resolved.command !== 'string' || !resolved.command) {
        throw new TypeError('resolveLaunchSpec must return a command');
      }
      if (entry.stopping || entries.get(entry.key) !== entry) {
        throw new Error('Pi RPC process launch was stopped');
      }
      const args = Array.isArray(resolved.args) ? [...resolved.args] : [];
      args.push('--mode', 'rpc');
      if (entry.sessionPath) args.push('--session', entry.sessionPath);
      else if (sessionId) args.push('--session-id', sessionId);
      const env = { ...process.env, ...(resolved.env || {}) };
      const child = spawnProcess(resolved.command, args, {
        cwd: entry.cwd,
        env,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      attachChild(entry, child);
      const state = await requestEntry(entry, { type: 'get_state' }, readyTimeoutMs);
      if (entry.failureHandled || entry.stopping || entries.get(entry.key) !== entry) {
        throw new Error('Pi RPC process became unavailable during readiness');
      }
      const returnedSessionId =
        isRecord(state) && typeof state.sessionId === 'string' && state.sessionId.length > 0
          ? state.sessionId
          : undefined;
      if (entry.requestedSessionId && returnedSessionId && returnedSessionId !== entry.requestedSessionId) {
        throw new Error(
          `Pi session identity mismatch: requested ${entry.requestedSessionId}, returned ${returnedSessionId}`,
        );
      }
      if (!entry.requestedSessionId && returnedSessionId) claimSessionIdentity(entry, returnedSessionId);
      entry.ready = true;
      entry.sessionId = returnedSessionId || entry.requestedSessionId;
      entry.readyResolve({
        key: entry.key,
        generation: entry.generation,
        cwd: entry.cwd,
        sessionPath: entry.sessionPath,
        sessionId: entry.sessionId,
        state,
      });
    } catch (error) {
      if (!entry.failureHandled && !entry.stopping) {
        const reason = error instanceof TypeError ? 'launch_spec_error' : 'readiness_failed';
        rejectPending(entry, error instanceof Error ? error : new Error(String(error)));
        entry.failureHandled = true;
        releaseEntry(entry);
        broadcast(entry.key, { type: 'lifecycle', event: 'process_failed', generation: entry.generation });
        closeStdin(entry);
        signalChild(entry, false);
      }
      entry.readyReject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  function ensureProcess({ key, cwd, sessionPath, sessionId } = {}) {
    validateKey(key);
    const normalizedCwd = normalizeAbsolutePath(cwd, 'cwd');
    const normalizedSessionPath = sessionPath === undefined ? undefined : normalizeAbsolutePath(sessionPath, 'sessionPath');
    if (sessionPath !== undefined && sessionId !== undefined) {
      throw new TypeError('sessionPath and sessionId are mutually exclusive');
    }
    if (sessionId !== undefined) validateString(sessionId, 'sessionId');
    if (shuttingDown) return Promise.reject(new Error('Pi RPC process manager is shut down'));

    const existing = entries.get(key);
    if (existing) {
      if (
        existing.cwd !== normalizedCwd ||
        existing.sessionPath !== normalizedSessionPath ||
        existing.requestedSessionId !== sessionId
      ) {
        return Promise.reject(new Error(`Pi RPC key ${key} is already bound to a different session`));
      }
      return existing.readyPromise;
    }
    if (entries.size >= maxProcesses) {
      return Promise.reject(new Error(`Pi RPC process cap reached (${maxProcesses})`));
    }
    if (normalizedSessionPath) {
      const claimed = sessionPathClaims.get(normalizedSessionPath);
      if (claimed) return Promise.reject(new Error(`Pi session path is already claimed by key ${claimed.key}`));
    }
    if (sessionId !== undefined) {
      const claimed = sessionIdentityClaims.get(sessionIdentityKey(normalizedCwd, sessionId));
      if (claimed) return Promise.reject(new Error(`Pi session identity is already claimed by key ${claimed.key}`));
    }

    const entry = {
      key,
      cwd: normalizedCwd,
      sessionPath: normalizedSessionPath,
      requestedSessionId: sessionId,
      sessionId: sessionId,
      generation: ++generation,
      pending: new Map(),
      closeWaiters: new Map(),
      stderrBytes: 0,
      busy: false,
      ready: false,
      closed: false,
      stopping: false,
      failureHandled: false,
      sessionIdentityClaims: new Set(),
    };
    entry.readyPromise = new Promise((resolve, reject) => {
      entry.readyResolve = resolve;
      entry.readyReject = reject;
    });
    entries.set(key, entry);
    if (normalizedSessionPath) sessionPathClaims.set(normalizedSessionPath, entry);
    if (sessionId !== undefined) claimSessionIdentity(entry, sessionId);
    void initializeEntry(entry, sessionId);
    return entry.readyPromise;
  }

  function request(key, command, requestOptions = {}) {
    validateKey(key);
    if (!isRecord(command) || typeof command.type !== 'string' || command.type.length === 0) {
      return Promise.reject(new TypeError('command must be an object with a non-empty type'));
    }
    const timeoutMs = asPositiveInteger(requestOptions.timeoutMs, 'timeoutMs', requestTimeoutMs);
    const entry = entries.get(key);
    if (!entry) return Promise.reject(new Error(`Pi RPC process not found for key ${key}`));
    if (!entry.ready) return Promise.reject(new Error(`Pi RPC process is not ready for key ${key}`));
    return requestEntry(entry, command, timeoutMs);
  }

  function subscribe(key, listener) {
    validateKey(key);
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const listeners = getSubscribers(key);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) subscribers.delete(key);
    };
  }

  async function stopProcess(key) {
    validateKey(key);
    const entry = entries.get(key);
    if (!entry) return false;
    entry.stopping = true;
    releaseEntry(entry);
    rejectPending(entry, new Error(`Pi RPC process stopped for key ${key}`));
    entry.readyReject(new Error(`Pi RPC process stopped for key ${key}`));
    if (!entry.child) {
      markClosed(entry);
      return true;
    }
    closeStdin(entry);
    signalChild(entry, false);
    let closed = await waitForClose(entry, stopTimeoutMs);
    if (!closed) {
      signalChild(entry, true);
      closed = await waitForClose(entry, forceKillTimeoutMs);
    }
    markClosed(entry);
    return closed;
  }

  function getSnapshot() {
    return {
      shuttingDown,
      processes: [...entries.values()].map((entry) => ({
        key: entry.key,
        generation: entry.generation,
        cwd: entry.cwd,
        sessionPath: entry.sessionPath,
        sessionId: entry.sessionId,
        ready: entry.ready,
        busy: entry.busy,
        pendingRequests: entry.pending.size,
        stderrBytes: entry.stderrBytes,
        status: entry.stopping ? 'stopping' : entry.failureHandled ? 'failed' : entry.ready ? 'ready' : 'starting',
      })),
    };
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = Promise.all([...entries.keys()].map((key) => stopProcess(key))).then(() => undefined);
    return shutdownPromise;
  }

  return {
    ensureProcess,
    request,
    subscribe,
    stopProcess,
    getSnapshot,
    shutdown,
  };
}


import express from 'express';
import { createServer } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VERSION } from '@earendil-works/pi-coding-agent';
import {
  piBranchToOpenCodeMessages,
  piDirectoryToPath,
  piDirectoryToProject,
  normalizePiSessionInfo,
  piSessionToGlobalSession,
  piSessionToOpenCodeSession,
} from './opencode-shapes.js';
import { createPiLiveSessionRegistry } from './live-session-registry.js';
import { createPiEventTranslator } from './event-translator.js';

function fail(status, name, message) {
  const error = new Error(message);
  error.status = status;
  error.publicName = name;
  return error;
}

function directoryValue(value, name = 'directory') {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw fail(400, 'BadRequestError', `${name} is invalid`);
  const resolved = path.resolve(value);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) throw fail(400, 'BadRequestError', `${name} is invalid`);
  return resolved;
}

function optionalDirectory(req, defaultDirectory) {
  return req.query.directory === undefined ? directoryValue(defaultDirectory) : directoryValue(req.query.directory);
}

function booleanQuery(value, name) {
  if (value === undefined) return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw fail(400, 'BadRequestError', `${name} is invalid`);
}

function integerQuery(value, name, fallback, maximum = 500) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw fail(400, 'BadRequestError', `${name} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw fail(400, 'BadRequestError', `${name} is invalid`);
  return parsed;
}

function searchSessions(sessions, search) {
  if (!search) return sessions;
  const needle = search.toLowerCase();
  return sessions.filter((session) => [session.id, session.name, session.firstMessage, session.allMessagesText]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle)));
}

function sortSessions(sessions) {
  return [...sessions].sort((a, b) => {
    const modified = b.modified.getTime() - a.modified.getTime();
    return modified || a.id.localeCompare(b.id);
  });
}

function sendJson(res, value) {
  res.type('application/json').send(value);
}

function isNonEmptyCreationValue(value) {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function validateSessionCreateBody(body) {
  if (body === undefined) return {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw fail(400, 'BadRequestError', 'session creation body is invalid');
  }
  const unsupported = new Set(['parentID', 'metadata', 'title', 'agent', 'model', 'permission', 'workspaceID']);
  for (const [key, value] of Object.entries(body)) {
    if (!unsupported.has(key) && isNonEmptyCreationValue(value)) {
      throw fail(400, 'BadRequestError', `session creation field ${key} is not supported`);
    }
    if (unsupported.has(key) && isNonEmptyCreationValue(value)) {
      throw fail(501, 'UnsupportedError', `session creation field ${key} is not supported by Pi`);
    }
  }
  return body;
}

async function readConfig(provider, directory) {
  const value = await provider(directory);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(503, 'UpstreamError', 'config provider failed');
  return value;
}

function route(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
}

function writeSseChunk(client, value) {
  client.queue = client.queue
    .catch(() => false)
    .then(async (canContinue) => {
      if (!canContinue || client.closed || client.res.writableEnded || client.res.destroyed) return false;
      if (client.res.write(value)) return true;
      return await new Promise((resolve) => {
        const finish = () => {
          client.res.off('drain', finish);
          client.res.off('close', finish);
          client.res.off('error', finish);
          resolve(!client.closed && !client.res.writableEnded && !client.res.destroyed);
        };
        client.res.once('drain', finish);
        client.res.once('close', finish);
        client.res.once('error', finish);
      });
    });
  return client.queue;
}

/**
 * Create the Pi -> OpenCode compatibility upstream.
 * The gateway remains read-only in Phase 2B. Its SSE endpoints are the internal
 * upstream consumed by the existing OpenChamber proxy and watcher.
 */
export function createPiCompatibilityGateway(options = {}) {
  if (!options.sessionRepository) throw new TypeError('sessionRepository is required');
  if (options.messageAliasStore !== undefined) {
    const store = options.messageAliasStore;
    const methods = ['get', 'listSession', 'upsert', 'removeSession', 'close'];
    if (!store || methods.some((method) => typeof store[method] !== 'function')) {
      throw new TypeError('messageAliasStore is invalid');
    }
  }
  const messageAliasStore = options.messageAliasStore;
  const repository = options.sessionRepository;
  const defaultDirectory = options.defaultDirectory || process.cwd();
  const configProvider = options.configProvider || (() => ({}));
  const modelCatalog = options.modelCatalog;
  const pathsProvider = options.pathsProvider || ((directory) => piDirectoryToPath(directory, { home: os.homedir() }));
  const vcsProvider = options.vcsProvider;
  const processManager = options.processManager;
  const liveSessions = options.liveSessionRegistry || (
    processManager && typeof processManager.ensureProcess === 'function'
      ? createPiLiveSessionRegistry({ processManager, randomUUID: options.randomUUID })
      : null
  );
  const createGatewayServer = options.createServer || createServer;
  const version = options.version || VERSION;
  const sseHeartbeatIntervalMs = Number.isFinite(options.sseHeartbeatIntervalMs) && options.sseHeartbeatIntervalMs > 0
    ? Math.min(options.sseHeartbeatIntervalMs, 19_000)
    : 10_000;
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const sseClients = new Set();
  const eventTranslators = new Map();
  let sseEventId = 0;

  const health = (_req, res) => sendJson(res, { healthy: true, version });
  app.get('/global/health', health);
  app.get('/opencode/health', health);

  const openSseStream = (req, res, directory) => {
    const client = { req, res, directory, queue: Promise.resolve(true), closed: false, heartbeat: null };
    const cleanup = () => {
      if (client.closed) return;
      client.closed = true;
      if (client.heartbeat) clearInterval(client.heartbeat);
      client.heartbeat = null;
      sseClients.delete(client);
      req.off('aborted', cleanup);
      res.off('close', cleanup);
      res.off('error', cleanup);
    };
    client.cleanup = cleanup;

    sseClients.add(client);
    req.once('aborted', cleanup);
    res.once('close', cleanup);
    res.once('error', cleanup);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const connectedPayload = {
      type: 'server.connected',
      properties: directory ? { directory } : {},
    };
    void writeSseChunk(client, `event: server.connected\ndata: ${JSON.stringify(connectedPayload)}\n\n`);
    client.heartbeat = setInterval(() => {
      void writeSseChunk(client, ': heartbeat\n\n');
    }, sseHeartbeatIntervalMs);
    client.heartbeat.unref?.();
  };

  const publishSseEvent = (payload, directory) => {
    const eventId = String(++sseEventId);
    const chunk = `id: ${eventId}\nevent: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of Array.from(sseClients)) {
      if (client.directory !== null && client.directory !== directory) continue;
      void writeSseChunk(client, chunk);
    }
  };

  app.get('/global/event', (req, res) => openSseStream(req, res, null));
  app.get('/event', route((req, res) => openSseStream(
    req,
    res,
    optionalDirectory(req, defaultDirectory),
  )));

  app.get('/path', route((req, res) => sendJson(res, pathsProvider(optionalDirectory(req, defaultDirectory)))));
  async function configWithDefault(directory) {
    const config = await readConfig(configProvider, directory);
    if (!modelCatalog) return config;
    const catalog = await modelCatalog.getSnapshot();
    if (config.model || !catalog.defaultModel) return config;
    return { ...config, model: catalog.defaultModel };
  }

  app.get('/global/config', route(async (_req, res) => sendJson(res, await configWithDefault())));
  app.get('/config', route(async (req, res) => sendJson(res, await configWithDefault(optionalDirectory(req, defaultDirectory)))));

  const providerList = async (_req, res) => {
    if (!modelCatalog) throw fail(503, 'UpstreamError', 'model catalog unavailable');
    const catalog = await modelCatalog.getSnapshot();
    sendJson(res, { providers: catalog.providers, default: catalog.default });
  };
  app.get('/config/providers', route(providerList));
  app.get('/provider', route(async (_req, res) => {
    if (!modelCatalog) throw fail(503, 'UpstreamError', 'model catalog unavailable');
    const catalog = await modelCatalog.getSnapshot();
    sendJson(res, { all: catalog.providers, default: catalog.default, connected: catalog.connected });
  }));

  const piPrimaryAgent = {
    name: 'pi',
    description: 'Pi primary agent',
    mode: 'primary',
    native: true,
    permission: [],
    options: {},
  };
  const agentList = (_req, res) => sendJson(res, [piPrimaryAgent]);
  app.get('/agent', agentList);
  app.get('/app/agents', agentList);

  app.get('/project', route(async (req, res) => {
    const requested = req.query.directory === undefined ? undefined : directoryValue(req.query.directory);
    const sessions = await repository.listAll();
    const directories = new Set(sessions.map((session) => session.cwd).filter(Boolean).map((directory) => path.resolve(directory)));
    directories.add(requested || directoryValue(defaultDirectory));
    sendJson(res, [...directories].sort().map((directory) => piDirectoryToProject(directory)));
  }));
  app.get('/project/current', route((req, res) => sendJson(res, piDirectoryToProject(optionalDirectory(req, defaultDirectory)))));

  async function listRoute(req, res, global) {
    const directory = req.query.directory === undefined ? undefined : directoryValue(req.query.directory);
    const archived = booleanQuery(req.query.archived, 'archived');
    if (archived === true) throw fail(501, 'UnsupportedError', 'archived session listing is not available');
    const roots = booleanQuery(req.query.roots, 'roots');
    const limit = integerQuery(req.query.limit, 'limit', 100);
    const cursor = global && req.query.cursor !== undefined
      ? integerQuery(req.query.cursor, 'cursor', undefined, Number.MAX_SAFE_INTEGER)
      : undefined;
    const start = !global && req.query.start !== undefined
      ? integerQuery(req.query.start, 'start', 0, Number.MAX_SAFE_INTEGER)
      : 0;
    let sessions = global ? await repository.list({ directory }) : await repository.list({ directory: directory || undefined });
    sessions = sessions.map(normalizePiSessionInfo);
    sessions = sortSessions(searchSessions(sessions, req.query.search));
    if (roots === true) sessions = sessions.filter((session) => !session.parentSessionPath);
    if (global && cursor !== undefined) {
      sessions = sessions.filter((session) => session.modified.getTime() < cursor);
    }
    let page = sessions.slice(start, start + limit);
    if (global && page.length > 0) {
      // A timestamp cursor cannot identify one item among an equal-time group.
      // Include the complete boundary group so the next request can use the
      // strict timestamp predicate without repeating or skipping sessions.
      const boundary = page[page.length - 1].modified.getTime();
      let end = page.length;
      while (end < sessions.length && sessions[end].modified.getTime() === boundary) end += 1;
      page = sessions.slice(start, end);
      if (end < sessions.length) res.set('x-next-cursor', String(boundary));
    }
    const index = await repository.getCatalogIndex({ directory });
    return page.map((session) => global
      ? piSessionToGlobalSession(session, { sessionIndex: index, version })
      : piSessionToOpenCodeSession(session, { sessionIndex: index, version }));
  }

  function translatorKey(cwd, sessionId) {
    return JSON.stringify([cwd, sessionId]);
  }

  app.get('/experimental/session', route(async (req, res) => sendJson(res, await listRoute(req, res, true))));
  app.get('/session', route(async (req, res) => sendJson(res, await listRoute(req, res, false))));

  function getOrCreateEventTranslator(sessionId, cwd, binding) {
    const key = translatorKey(cwd, sessionId);
    const existing = eventTranslators.get(key);
    if (existing && !existing.isClosed) return existing;
    const translator = createPiEventTranslator({
      sessionId,
      cwd,
      processManager,
      processKey: binding.processKey,
      messageAliasStore: options.messageAliasStore,
      onEvent: (payload) => publishSseEvent(payload, cwd),
      onSettled: () => {
        if (typeof repository.invalidate === 'function') {
          Promise.resolve().then(() => repository.invalidate({ directory: cwd })).catch(() => {});
          Promise.resolve().then(() => repository.invalidate()).catch(() => {});
        }
      },
    });
    eventTranslators.set(key, translator);
    return translator;
  }

  app.post('/session', route(async (req, res) => {
    const directory = optionalDirectory(req, defaultDirectory);
    validateSessionCreateBody(req.body);
    if (!liveSessions) throw fail(501, 'UnsupportedError', 'session creation is not available');

    const binding = await liveSessions.create({ cwd: directory });
    const createdAt = binding.createdAt;
    const sessionInfo = {
      id: binding.sessionId,
      path: binding.sessionPath,
      cwd: binding.cwd,
      created: new Date(createdAt),
      modified: new Date(createdAt),
    };
    const session = piSessionToOpenCodeSession(sessionInfo, { version });

    // A failed invalidation must not turn a confirmed live create into a missing
    // response. The live registry remains the authoritative immediate lookup.
    if (typeof repository.invalidate === 'function') {
      await Promise.resolve().then(() => repository.invalidate({ directory })).catch(() => {});
      await Promise.resolve().then(() => repository.invalidate()).catch(() => {});
    }
    publishSseEvent({ type: 'session.created', properties: { info: session } }, directory);
    sendJson(res, session);
  }));

  app.delete('/session/:sessionID', route(async (req, res) => {
    const directory = optionalDirectory(req, defaultDirectory);
    const sessionId = req.params.sessionID;

    const live = liveSessions?.get({ cwd: directory, sessionId });
    const info = live
      ? { id: sessionId, path: live.sessionPath, cwd: live.cwd, created: new Date(live.createdAt), modified: new Date(live.createdAt), name: undefined }
      : await repository.getSession(sessionId, { directory });
    if (!info?.path) throw fail(404, 'NotFoundError', 'session not found');

    const session = piSessionToOpenCodeSession(info, { version });

    if (liveSessions) await liveSessions.remove({ cwd: directory, sessionId });
    const tKey = translatorKey(directory, sessionId);
    const t = eventTranslators.get(tKey);
    if (t) { t.close(); eventTranslators.delete(tKey); }

    await unlink(info.path).catch((e) => {
      if (e?.code !== 'ENOENT') throw e;
    });
    if (messageAliasStore) await messageAliasStore.removeSession(sessionId);
    if (typeof repository.invalidate === 'function') {
      await repository.invalidate({ directory });
      await repository.invalidate();
    }

    publishSseEvent({ type: 'session.deleted', properties: { sessionID: sessionId, info: session } }, directory);
    sendJson(res, true);
  }));

  app.get('/session/status', route(async (req, res) => {
    const directory = req.query.directory === undefined ? undefined : directoryValue(req.query.directory);
    if (!processManager || typeof processManager.getSnapshot !== 'function') return sendJson(res, {});
    const snapshot = processManager.getSnapshot();
    if (!snapshot || !Array.isArray(snapshot.processes)) throw fail(503, 'UpstreamError', 'process status unavailable');
    const result = {};
    for (const process of snapshot.processes) {
      if (!process?.sessionId || (directory && path.resolve(process.cwd || '') !== directory)) continue;
      result[process.sessionId] = { type: process.busy ? 'busy' : 'idle' };
    }
    sendJson(res, result);
  }));

  app.get('/session/:sessionID', route(async (req, res) => {
    const liveDirectory = optionalDirectory(req, defaultDirectory);
    const live = liveSessions?.get({ cwd: liveDirectory, sessionId: req.params.sessionID });
    if (live) {
      sendJson(res, piSessionToOpenCodeSession({
        id: live.sessionId,
        path: live.sessionPath,
        cwd: live.cwd,
        created: new Date(live.createdAt),
        modified: new Date(live.createdAt),
      }, { version }));
      return;
    }
    const directory = req.query.directory === undefined ? undefined : directoryValue(req.query.directory);
    const info = await repository.getSession(req.params.sessionID, { directory });
    if (!info) throw fail(404, 'NotFoundError', 'session not found');
    const index = await repository.getCatalogIndex({ directory });
    sendJson(res, piSessionToOpenCodeSession(info, { sessionIndex: index, version }));
  }));

  // Shared prompt handler — accepts both SDK prompt_async and simpler prompt bodies.
  async function handlePrompt(req, res) {
    const directory = req.query.directory !== undefined
      ? directoryValue(req.query.directory)
      : optionalDirectory(req, defaultDirectory);
    const body = req.body || {};

    // Extract text from SDK parts array or direct text field.
    // Image-only and file-only prompts are allowed — Pi accepts content arrays
    // without text. Empty bodies (no text and no parts) are still rejected.
    const text = (() => {
      if (typeof body.text === 'string' && body.text.trim()) return body.text;
      if (Array.isArray(body.parts)) {
        return body.parts
          .filter((p) => p?.type === 'text')
          .map((p) => p.text || '')
          .join('\n')
          .trim();
      }
      return '';
    })();
    const hasParts = Array.isArray(body.parts) && body.parts.length > 0;
    if (!text && !hasParts) throw fail(400, 'BadRequestError', 'prompt text or parts are required');

    if (!liveSessions) throw fail(501, 'UnsupportedError', 'session prompt is not available');
    if (!processManager) throw fail(503, 'UpstreamError', 'RPC process manager is not available');

    const binding = liveSessions.get({ cwd: directory, sessionId: req.params.sessionID });
    if (!binding) throw fail(404, 'NotFoundError', 'live session not found');

    const translator = getOrCreateEventTranslator(binding.sessionId, directory, binding);
    const messageId = translator.reserveNextMessageId(body.messageID);

    const images = Array.isArray(body.images) && body.images.length > 0 ? body.images : undefined;
    const delivery = body.delivery === 'steer' ? 'steer' : body.delivery === 'followUp' ? 'followUp' : undefined;

    processManager.request(binding.processKey, {
      type: 'prompt',
      message: text,
      ...(images ? { images } : {}),
      ...(delivery ? { streamingBehavior: delivery } : {}),
    }).catch(() => {});

    // OpenCode SDK SessionPromptAsyncResponses expects 204 No Content; the UI
    // uses its own optimistic messageId returned via `promptAsync({ messageID })`.
    res.status(204).end();
  }

  app.post('/session/:sessionID/prompt_async', route(handlePrompt));
  app.post('/session/:sessionID/prompt', route(handlePrompt));

  app.post('/session/:sessionID/abort', route(async (req, res) => {
    const directory = optionalDirectory(req, defaultDirectory);
    if (!liveSessions) throw fail(501, 'UnsupportedError', 'session abort is not available');
    if (!processManager) throw fail(503, 'UpstreamError', 'RPC process manager is not available');

    const binding = liveSessions.get({ cwd: directory, sessionId: req.params.sessionID });
    if (!binding) throw fail(404, 'NotFoundError', 'live session not found');

    await processManager.request(binding.processKey, { type: 'abort' });
    sendJson(res, true);
  }));

  app.get('/session/:sessionID/message', route(async (req, res) => {
    const directory = req.query.directory === undefined ? undefined : directoryValue(req.query.directory);
    const limit = integerQuery(req.query.limit, 'limit', 100);
    
    // Live sessions are still being streamed via SSE; the frontend already has
    // the messages from live events. Return empty so the frontend doesn't
    // receive a second copy with different (durable) IDs that would duplicate
    // every message in the UI.
    const liveDirectory = optionalDirectory(req, defaultDirectory);
    const live = liveSessions?.get({ cwd: liveDirectory, sessionId: req.params.sessionID });
    if (live) {
      sendJson(res, []);
      return;
    }
    
    // Session is no longer live — serve from durable storage.
    const branch = await repository.getActiveBranch(req.params.sessionID, { directory });
    if (branch) {
      const messages = piBranchToOpenCodeMessages(branch.entries, {
        sessionId: branch.info.id,
        directory: branch.info.cwd,
      });
      let end = messages.length;
      if (req.query.before !== undefined) {
        const beforeIndex = messages.findIndex((message) => message.info.id === req.query.before);
        if (beforeIndex < 0) throw fail(400, 'BadRequestError', 'before is invalid');
        end = beforeIndex;
      }
      const start = Math.max(0, end - limit);
      const page = messages.slice(start, end);
      if (start > 0) res.set('x-next-cursor', page[0]?.info.id || messages[start - 1].info.id);
      sendJson(res, page);
      return;
    }
    
    throw fail(404, 'NotFoundError', 'session not found');
  }));

  app.get('/command', (_req, _res, next) => next(fail(501, 'UnsupportedError', 'command translation is not available')));
  app.get('/mcp', (_req, _res, next) => next(fail(501, 'UnsupportedError', 'MCP translation is not available')));
  app.get('/lsp', (_req, _res, next) => next(fail(501, 'UnsupportedError', 'LSP translation is not available')));
  app.get('/permission', route((req, res) => {
    if (req.query.directory !== undefined) directoryValue(req.query.directory);
    sendJson(res, []);
  }));
  app.get('/question', route((req, res) => {
    if (req.query.directory !== undefined) directoryValue(req.query.directory);
    sendJson(res, []);
  }));
  app.get('/vcs', route(async (req, res) => {
    if (!vcsProvider) throw fail(501, 'UnsupportedError', 'VCS provider is not configured');
    const directory = optionalDirectory(req, defaultDirectory);
    const value = typeof vcsProvider === 'function' ? await vcsProvider(directory) : await vcsProvider.get(directory);
    if (!value || typeof value !== 'object') throw fail(503, 'UpstreamError', 'VCS provider failed');
    sendJson(res, value);
  }));

  app.use((_req, _res, next) => next(fail(404, 'NotFoundError', 'route not found')));
  app.use((error, _req, res, _next) => {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    const name = error?.publicName || (status === 404 ? 'NotFoundError' : 'InternalError');
    const message = status === 400 || status === 501 ? error.message : status === 404 ? 'route not found' : 'gateway request failed';
    res.status(status).type('application/json').send({ error: { name, message } });
  });

  let server;
  let starting;
  let closing;
  let closeRequested = false;

  function closeServer(target) {
    return new Promise((resolve, reject) => target.close((error) => {
      if (error) reject(error);
      else resolve();
    })).finally(() => {
      if (server === target) server = undefined;
    });
  }

  function closeSseStreams() {
    for (const client of Array.from(sseClients)) {
      client.closed = true;
      if (client.heartbeat) clearInterval(client.heartbeat);
      client.heartbeat = null;
      sseClients.delete(client);
      client.req.off('aborted', client.cleanup);
      client.res.off('close', client.cleanup);
      client.res.off('error', client.cleanup);
      if (!client.res.writableEnded && !client.res.destroyed) client.res.end();
    }
  }

  function closeEventTranslators() {
    for (const [key, translator] of eventTranslators) {
      try { translator.close(); } catch {}
      eventTranslators.delete(key);
    }
  }

  async function start() {
    if (closing) {
      await closing;
      return start();
    }
    if (server?.listening) return { url: `http://127.0.0.1:${server.address().port}`, port: server.address().port };
    if (starting) return starting;
    closeRequested = false;
    const target = createGatewayServer(app);
    server = target;
    let currentStarting;
    currentStarting = new Promise((resolve, reject) => {
      target.once('error', reject);
      target.listen(0, '127.0.0.1', () => {
        target.removeListener('error', reject);
        const port = target.address().port;
        resolve({ url: `http://127.0.0.1:${port}`, port });
      });
    }).then(async (result) => {
      if (closeRequested) {
        closeSseStreams();
        await closeServer(target);
      }
      return result;
    }).catch((error) => {
      if (server === target) server = undefined;
      throw error;
    }).finally(() => {
      if (starting === currentStarting) starting = undefined;
    });
    starting = currentStarting;
    return starting;
  }
  async function close() {
    if (closing) return closing;
    if (starting) {
      closeRequested = true;
      const pendingStart = starting;
      closing = Promise.resolve(pendingStart)
        .catch(() => undefined)
        .then(() => server?.listening ? closeServer(server) : undefined)
        .finally(() => {
          closeRequested = false;
          closing = undefined;
        });
      return closing;
    }
    if (!server || !server.listening) {
      server = undefined;
      return undefined;
    }
    const target = server;
    closeSseStreams();
    closeEventTranslators();
    closing = closeServer(target).finally(() => { closing = undefined; closeRequested = false; });
    return closing;
  }

  return { app, start, close, getUrl: () => server?.listening ? `http://127.0.0.1:${server.address().port}` : undefined };
}


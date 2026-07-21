import express from 'express';
import { createServer } from 'node:http';
import { existsSync, statSync } from 'node:fs';
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

async function readConfig(provider, directory) {
  const value = await provider(directory);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(503, 'UpstreamError', 'config provider failed');
  return value;
}

function route(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
}

/**
 * Create the standalone Phase 2A Pi -> OpenCode compatibility upstream.
 * It intentionally has no mutation, SSE, auth, or OpenCode lifecycle wiring.
 */
export function createPiCompatibilityGateway(options = {}) {
  if (!options.sessionRepository) throw new TypeError('sessionRepository is required');
  const repository = options.sessionRepository;
  const defaultDirectory = options.defaultDirectory || process.cwd();
  const configProvider = options.configProvider || (() => ({}));
  const pathsProvider = options.pathsProvider || ((directory) => piDirectoryToPath(directory, { home: os.homedir() }));
  const vcsProvider = options.vcsProvider;
  const processManager = options.processManager;
  const createGatewayServer = options.createServer || createServer;
  const version = options.version || VERSION;
  const app = express();

  const health = (_req, res) => sendJson(res, { healthy: true, version });
  app.get('/global/health', health);
  app.get('/opencode/health', health);

  app.get('/path', route((req, res) => sendJson(res, pathsProvider(optionalDirectory(req, defaultDirectory)))));
  app.get('/global/config', route(async (_req, res) => sendJson(res, await readConfig(configProvider))));
  app.get('/config', route(async (req, res) => sendJson(res, await readConfig(configProvider, optionalDirectory(req, defaultDirectory)))));

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

  app.get('/experimental/session', route(async (req, res) => sendJson(res, await listRoute(req, res, true))));
  app.get('/session', route(async (req, res) => sendJson(res, await listRoute(req, res, false))));

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
    const directory = req.query.directory === undefined ? undefined : directoryValue(req.query.directory);
    const info = await repository.getSession(req.params.sessionID, { directory });
    if (!info) throw fail(404, 'NotFoundError', 'session not found');
    const index = await repository.getCatalogIndex({ directory });
    sendJson(res, piSessionToOpenCodeSession(info, { sessionIndex: index, version }));
  }));

  app.get('/session/:sessionID/message', route(async (req, res) => {
    const directory = req.query.directory === undefined ? undefined : directoryValue(req.query.directory);
    const limit = integerQuery(req.query.limit, 'limit', 100);
    const branch = await repository.getActiveBranch(req.params.sessionID, { directory });
    if (!branch) throw fail(404, 'NotFoundError', 'session not found');
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
      if (closeRequested) await closeServer(target);
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
    closing = closeServer(target).finally(() => { closing = undefined; closeRequested = false; });
    return closing;
  }

  return { app, start, close, getUrl: () => server?.listening ? `http://127.0.0.1:${server.address().port}` : undefined };
}


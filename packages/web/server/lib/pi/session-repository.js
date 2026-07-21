import { SessionManager } from '@earendil-works/pi-coding-agent';
import path from 'node:path';
import { normalizePiSessionInfo } from './opencode-shapes.js';

const DEFAULT_CACHE_TTL_MS = 1_000;

function assertAbsoluteDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new TypeError('directory must be an absolute path');
  }
  return path.resolve(directory);
}

function assertSessionInfo(info) {
  return normalizePiSessionInfo(info);
}

function buildIndex(sessions) {
  const byId = new Map();
  const byPath = new Map();
  for (const session of sessions) {
    const info = assertSessionInfo(session);
    const resolvedPath = path.resolve(info.path);
    byPath.set(resolvedPath, info);
    if (!byId.has(info.id)) byId.set(info.id, []);
    byId.get(info.id).push(info);
  }
  return { byId, byPath };
}

/**
 * Read-only access to Pi's durable session catalog and active branch trees.
 * Catalog failures are deliberately not converted into an empty result.
 */
export function createPiSessionRepository(options = {}) {
  const manager = options.SessionManager || SessionManager;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  if (!Number.isInteger(cacheTtlMs) || cacheTtlMs < 0) {
    throw new TypeError('cacheTtlMs must be a non-negative integer');
  }
  if (typeof manager.list !== 'function' || typeof manager.listAll !== 'function' || typeof manager.open !== 'function') {
    throw new TypeError('SessionManager must provide list, listAll, and open');
  }

  const cache = new Map();
  const pending = new Map();

  async function loadCatalog(key, loader) {
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) return cached;
    if (pending.has(key)) return pending.get(key);

    const request = Promise.resolve()
      .then(loader)
      .then((sessions) => {
        if (!Array.isArray(sessions)) throw new TypeError('Pi SessionManager returned an invalid catalog');
        const record = {
          sessions: sessions.map(assertSessionInfo),
          ...buildIndex(sessions),
          expiresAt: Date.now() + cacheTtlMs,
        };
        cache.set(key, record);
        return record;
      })
      .finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  }

  async function listDirectory(directory) {
    const resolvedDirectory = assertAbsoluteDirectory(directory);
    const key = `directory:${resolvedDirectory}`;
    const record = await loadCatalog(key, () => manager.list(resolvedDirectory));
    return record.sessions;
  }

  async function listAll() {
    const record = await loadCatalog('global', () => manager.listAll());
    return record.sessions;
  }

  async function list(options = {}) {
    return options.directory === undefined ? listAll() : listDirectory(options.directory);
  }

  async function getSession(id, options = {}) {
    if (typeof id !== 'string' || id.length === 0) throw new TypeError('session id must be a non-empty string');
    const sessions = await list(options);
    const candidates = sessions.filter((session) => session.id === id);
    if (options.directory !== undefined) return candidates[0];
    if (candidates.length > 1) {
      throw new Error('Pi session id is ambiguous; directory is required');
    }
    return candidates[0];
  }

  async function getCatalogIndex(options = {}) {
    const key = options.directory === undefined ? 'global' : `directory:${assertAbsoluteDirectory(options.directory)}`;
    const record = await loadCatalog(key, () =>
      options.directory === undefined ? manager.listAll() : manager.list(assertAbsoluteDirectory(options.directory)),
    );
    return { byId: record.byId, byPath: record.byPath };
  }

  async function getActiveBranch(id, options = {}) {
    const info = await getSession(id, options);
    if (!info) return undefined;
    const opened = manager.open(path.resolve(info.path));
    if (!opened || typeof opened.getBranch !== 'function') {
      throw new TypeError('Pi SessionManager.open returned an invalid session');
    }
    return { info, entries: opened.getBranch(), session: opened };
  }

  function invalidate(options = {}) {
    if (options.directory === undefined) {
      cache.clear();
      return;
    }
    cache.delete(`directory:${assertAbsoluteDirectory(options.directory)}`);
  }

  return { list, listAll, listDirectory, getSession, getCatalogIndex, getActiveBranch, invalidate };
}


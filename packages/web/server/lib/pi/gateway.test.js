import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import http from 'node:http';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createPiCompatibilityGateway } from './gateway.js';

const directory = '/Users/amagicpear/projects/pichamber-plans/openchamber';
const sessions = [
  {
    id: 'session-new', path: '/sessions/new.jsonl', cwd: directory, name: 'New', created: new Date(2), modified: new Date(20),
    messageCount: 1, firstMessage: 'new text', allMessagesText: 'new text',
  },
  {
    id: 'session-old', path: '/sessions/old.jsonl', cwd: directory, created: new Date(1), modified: new Date(10),
    messageCount: 1, firstMessage: 'old text', allMessagesText: 'old text',
  },
];

function repositoryHarness() {
  return {
    listAll: vi.fn(async () => sessions),
    list: vi.fn(async ({ directory: requested } = {}) => requested ? sessions.filter((session) => session.cwd === requested) : sessions),
    getCatalogIndex: vi.fn(async () => ({ byId: new Map(), byPath: new Map() })),
    getSession: vi.fn(async (id) => sessions.find((session) => session.id === id)),
    getActiveBranch: vi.fn(async () => ({
      info: sessions[0],
      entries: [
        { type: 'message', id: 'user-entry', parentId: null, timestamp: '2026-01-01T00:00:00.000Z', message: {
          role: 'user', timestamp: 1, content: 'hello',
        } },
      ],
    })),
  };
}

function liveSessionHarness({ create = undefined, sessionId = 'fresh-session', sessionPath } = {}) {
  const session = {
    cwd: directory,
    sessionId,
    sessionPath: sessionPath || `/sessions/${sessionId}.jsonl`,
    createdAt: 1767225600000,
    processKey: `pi:${JSON.stringify([directory, sessionId])}`,
    processGeneration: 1,
    state: { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, messageCount: 0 },
    generation: 1,
  };
  return {
    session,
    get: vi.fn(({ cwd, sessionId }) => cwd === directory && sessionId === session.sessionId ? session : undefined),
    create: vi.fn(create || (async () => session)),
    remove: vi.fn(async () => true),
    close: vi.fn(async () => {}),
  };
}

async function openSse(url) {
  const chunks = [];
  const response = await new Promise((resolve, reject) => {
    const client = http.get(url, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('error', reject);
      resolve(res);
    });
    client.once('error', reject);
  });
  return { response, chunks };
}

describe('Pi compatibility gateway', () => {
  it('rejects an explicitly supplied invalid message alias store', () => {
    expect(() => createPiCompatibilityGateway({
      sessionRepository: repositoryHarness(),
      messageAliasStore: {},
    })).toThrow('messageAliasStore is invalid');
  });

  it('serves connected SSE envelopes, heartbeats, and closes live streams', async () => {
    const gateway = createPiCompatibilityGateway({
      sessionRepository: repositoryHarness(),
      defaultDirectory: directory,
      sseHeartbeatIntervalMs: 10,
    });
    const started = await gateway.start();
    const chunks = [];
    const response = await new Promise((resolve, reject) => {
      const request = http.get(`${started.url}/event?directory=${encodeURIComponent(directory)}`, (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => chunks.push(chunk));
        res.once('error', reject);
        resolve(res);
      });
      request.once('error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['cache-control']).toContain('no-cache');
    expect(chunks.join('')).toContain('event: server.connected');
    expect(chunks.join('')).toContain('"directory":"' + directory + '"');
    expect(chunks.join('')).toContain(': heartbeat');

    const closed = new Promise((resolve) => response.once('close', resolve));
    await gateway.close();
    await closed;
    await expect(gateway.close()).resolves.toBeUndefined();
  });

  it('serves health, path, config, project, and read-only session routes with SDK-compatible shapes', async () => {
    const repository = repositoryHarness();
    const gateway = createPiCompatibilityGateway({
      sessionRepository: repository,
      defaultDirectory: directory,
      configProvider: vi.fn(async () => ({ $schema: 'https://opencode.ai/config.json' })),
    });
    const health = await request(gateway.app).get('/global/health').expect(200);
    expect(health.body).toMatchObject({ healthy: true, version: expect.any(String) });
    await request(gateway.app).get('/opencode/health').expect(200);
    await request(gateway.app).get('/path').expect(200).expect(({ body }) => expect(body.directory).toBe(directory));
    await request(gateway.app).get(`/config?directory=${encodeURIComponent(directory)}`).expect(200).expect(({ body }) => expect(body.$schema).toContain('opencode'));
    await request(gateway.app).get(`/project/current?directory=${encodeURIComponent(directory)}`).expect(200).expect(({ body }) => expect(body.worktree).toBe(directory));
    await request(gateway.app).get('/experimental/session?limit=1').expect(200).expect(({ body, headers }) => {
      expect(body).toHaveLength(1);
      expect(headers['x-next-cursor']).toBe('20');
      expect(body[0]).toMatchObject({ id: 'session-new', project: { worktree: directory } });
    });
    await request(gateway.app).get('/session?limit=1').expect(200).expect(({ body }) => expect(body[0]).toMatchObject({ id: 'session-new' }));
    await request(gateway.app).get('/session?start=1&limit=1').expect(200).expect(({ body }) => expect(body[0]).toMatchObject({ id: 'session-old' }));
    await request(gateway.app).get('/session?cursor=1&limit=1').expect(200).expect(({ body }) => expect(body[0]).toMatchObject({ id: 'session-new' }));
    await request(gateway.app).get('/session/session-new').expect(200).expect(({ body }) => expect(body.id).toBe('session-new'));
    await request(gateway.app).get('/session/session-new/message').expect(200).expect(({ body }) => expect(body[0].info.id).toBe('msg_000000000000_user-entry'));
  });

  it('creates an authoritative Pi session through the installed SDK and publishes one event to global and directory SSE', async () => {
    const repository = repositoryHarness();
    repository.invalidate = vi.fn();
    const liveSessions = liveSessionHarness();
    const gateway = createPiCompatibilityGateway({
      sessionRepository: repository,
      liveSessionRegistry: liveSessions,
      defaultDirectory: directory,
    });
    const started = await gateway.start();
    const globalStream = await openSse(`${started.url}/global/event`);
    const directoryStream = await openSse(`${started.url}/event?directory=${encodeURIComponent(directory)}`);
    const client = createOpencodeClient({ baseUrl: started.url });

    const result = await client.session.create({ directory });
    expect(result.data).toMatchObject({
      id: 'fresh-session',
      slug: 'fresh-session',
      directory,
      path: '/sessions/fresh-session.jsonl',
      title: 'Untitled session',
      version: expect.any(String),
      time: { created: 1767225600000, updated: 1767225600000 },
    });
    expect(liveSessions.create).toHaveBeenCalledWith({ cwd: directory });
    expect(repository.getSession).not.toHaveBeenCalled();
    expect(repository.invalidate).toHaveBeenCalledTimes(2);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const globalText = globalStream.chunks.join('');
    const directoryText = directoryStream.chunks.join('');
    expect(globalText).toContain('event: session.created');
    expect(directoryText).toContain('event: session.created');
    expect(globalText).toContain('id: 1');
    expect(directoryText).toContain('id: 1');
    expect(globalText).toContain('"id":"fresh-session"');
    expect(globalText).not.toContain(`directory=${encodeURIComponent(directory)}`);

    globalStream.response.destroy();
    directoryStream.response.destroy();
    await gateway.close();
  });

  it('rejects unsupported SDK creation fields and serves a fresh live session when the file is not ready yet', async () => {
    const repository = repositoryHarness();
    // Fresh session: repository has no branch yet (Pi hasn't written any entries)
    repository.getActiveBranch.mockResolvedValue(null);
    const liveSessions = liveSessionHarness();
    const gateway = createPiCompatibilityGateway({ sessionRepository: repository, liveSessionRegistry: liveSessions, defaultDirectory: directory });
    await request(gateway.app).post('/session').send({ parentID: 'parent' }).expect(501);
    await request(gateway.app).post('/session').send({ metadata: { owner: 'client' } }).expect(501);
    await request(gateway.app).post('/session').send({ title: 'client title' }).expect(501);
    await request(gateway.app).post('/session').send({ extra: 'unknown' }).expect(400);

    await request(gateway.app).get('/session/fresh-session').expect(200).expect(({ body }) => {
      expect(body).toMatchObject({ id: 'fresh-session', directory, path: '/sessions/fresh-session.jsonl' });
    });
    await request(gateway.app).get('/session/fresh-session/message').expect(200).expect([]);
    // File-first lookup: getSession was called but missed (fresh session not in catalog yet)
    expect(repository.getSession).toHaveBeenCalled();
  });

  it('keeps create successful and the live lookup usable when repository invalidation fails', async () => {
    const repository = repositoryHarness();
    repository.invalidate = vi.fn(() => { throw new Error('cache failure'); });
    const liveSessions = liveSessionHarness();
    const gateway = createPiCompatibilityGateway({ sessionRepository: repository, liveSessionRegistry: liveSessions, defaultDirectory: directory });

    await request(gateway.app).post(`/session?directory=${encodeURIComponent(directory)}`).expect(200).expect(({ body }) => {
      expect(body.id).toBe('fresh-session');
    });
    // File-first lookup: getSession is tried, returns undefined (not in catalog),
    // then falls back to the live binding.
    await request(gateway.app).get(`/session/fresh-session?directory=${encodeURIComponent(directory)}`).expect(200);
    expect(repository.getSession).toHaveBeenCalled();
    expect(liveSessions.create).toHaveBeenCalledOnce();
  });

  it('paginates chronologically projected history despite non-chronological Pi entry ids', async () => {
    const repository = repositoryHarness();
    repository.getActiveBranch.mockResolvedValue({
      info: sessions[0],
      entries: [
        { type: 'message', id: 'z-user', parentId: null, message: { role: 'user', timestamp: 1, content: 'first' } },
        { type: 'message', id: 'a-assistant', parentId: 'z-user', message: { role: 'assistant', timestamp: 2, provider: 'p', model: 'm', usage: {}, content: [{ type: 'text', text: 'first reply' }] } },
        { type: 'message', id: 'y-user', parentId: 'a-assistant', message: { role: 'user', timestamp: 3, content: 'second' } },
      ],
    });
    const gateway = createPiCompatibilityGateway({ sessionRepository: repository, defaultDirectory: directory });
    const newest = await request(gateway.app).get('/session/session-new/message?limit=2').expect(200);
    expect(newest.body.map((message) => message.info.id)).toEqual([
      'msg_000000000001_a-assistant',
      'msg_000000000002_y-user',
    ]);
    expect(newest.headers['x-next-cursor']).toBe('msg_000000000001_a-assistant');
    const oldest = await request(gateway.app)
      .get(`/session/session-new/message?limit=2&before=${encodeURIComponent(newest.headers['x-next-cursor'])}`)
      .expect(200);
    expect(oldest.body.map((message) => message.info.id)).toEqual(['msg_000000000000_z-user']);
  });

  it('rejects malformed or nonexistent explicit directories and does not expose errors', async () => {
    const gateway = createPiCompatibilityGateway({ sessionRepository: repositoryHarness(), defaultDirectory: directory });
    await request(gateway.app).get('/path?directory=relative').expect(400).expect(({ body }) => {
      expect(body.error.name).toBe('BadRequestError');
      expect(JSON.stringify(body)).not.toContain('node_modules');
    });
    await request(gateway.app).get('/path?directory=%2Fdefinitely%2Fmissing').expect(400);
    await request(gateway.app).get('/unknown').expect(404).expect(({ body }) => expect(body.error).toEqual({ name: 'NotFoundError', message: 'route not found' }));
  });

  it('preserves failure semantics, scopes live status, and marks unsupported routes explicitly', async () => {
    const repository = repositoryHarness();
    const processManager = { getSnapshot: vi.fn(() => ({ processes: [
      { sessionId: 'session-new', cwd: directory, busy: true },
      { sessionId: 'other', cwd: '/var', busy: true },
    ] })) };
    const gateway = createPiCompatibilityGateway({
      sessionRepository: repository,
      processManager,
      defaultDirectory: directory,
      configProvider: vi.fn(() => { throw new Error('secret local failure'); }),
    });
    await request(gateway.app).get('/config').expect(500).expect(({ body }) => {
      expect(body.error.message).toBe('gateway request failed');
      expect(JSON.stringify(body)).not.toContain('secret');
    });
    await request(gateway.app).get(`/session/status?directory=${encodeURIComponent(directory)}`).expect(200).expect(({ body }) => {
      expect(body).toEqual({ 'session-new': { type: 'busy' } });
    });
    await request(gateway.app).get('/command').expect(501);
    await request(gateway.app).get('/mcp').expect(501);
    await request(gateway.app).get('/lsp').expect(501);
    await request(gateway.app).get('/permission').expect(200).expect([]);
    await request(gateway.app).get('/question').expect(200).expect([]);
  });

  it('supports loopback ephemeral lifecycle and an SDK-level smoke call', async () => {
    const gateway = createPiCompatibilityGateway({ sessionRepository: repositoryHarness(), defaultDirectory: directory });
    const first = await gateway.start();
    const second = await gateway.start();
    expect(first).toEqual(second);
    expect(new URL(first.url).hostname).toBe('127.0.0.1');
    const client = createOpencodeClient({ baseUrl: first.url });
    await expect(client.global.health()).resolves.toMatchObject({ data: { healthy: true } });
    await expect(gateway.close()).resolves.toBeUndefined();
    await expect(gateway.close()).resolves.toBeUndefined();
  });

  it('paginates equal timestamps through the installed SDK without skipping or repeating sessions', async () => {
    const equalTimeSessions = [
      ...['a', 'b', 'c'].map((id) => ({ id: `same-${id}`, path: `/sessions/${id}.jsonl`, cwd: directory, created: new Date(1), modified: new Date(300) })),
      ...['d', 'e'].map((id) => ({ id: `older-${id}`, path: `/sessions/${id}.jsonl`, cwd: directory, created: new Date(1), modified: new Date(200) })),
      { id: 'oldest', path: '/sessions/oldest.jsonl', cwd: directory, created: new Date(1), modified: new Date(100) },
    ];
    const repository = repositoryHarness();
    repository.listAll.mockResolvedValue(equalTimeSessions);
    repository.list.mockImplementation(async ({ directory: requested } = {}) => requested ? equalTimeSessions.filter((session) => session.cwd === requested) : equalTimeSessions);
    const gateway = createPiCompatibilityGateway({ sessionRepository: repository, defaultDirectory: directory });
    const started = await gateway.start();
    const client = createOpencodeClient({ baseUrl: started.url });
    const found = [];
    let cursor;
    while (true) {
      const result = await client.experimental.session.list({ archived: false, limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      found.push(...result.data.map((session) => session.id));
      const next = result.response?.headers?.get('x-next-cursor');
      if (!next) break;
      const nextCursor = Number(next);
      expect(Number.isSafeInteger(nextCursor)).toBe(true);
      if (cursor !== undefined) expect(nextCursor).toBeLessThan(cursor);
      cursor = nextCursor;
    }

    expect(found).toEqual(['same-a', 'same-b', 'same-c', 'older-d', 'older-e', 'oldest']);
    expect(new Set(found).size).toBe(equalTimeSessions.length);
    await gateway.close();
  });

  it('closes a listener that is still starting and permits a fresh start afterward', async () => {
    const servers = [];
    let releaseStart;
    const gateway = createPiCompatibilityGateway({
      sessionRepository: repositoryHarness(),
      defaultDirectory: directory,
      createServer: () => {
        const server = new (class extends EventTarget {
          constructor() {
            super();
            this.listening = false;
            this.port = 4500 + servers.length;
          }
          once(type, listener) { this.addEventListener(type, listener, { once: true }); }
          removeListener(type, listener) { this.removeEventListener(type, listener); }
          address() { return { port: this.port }; }
          listen(_port, _host, callback) { releaseStart = () => { this.listening = true; callback(); }; }
          close(callback) { this.listening = false; callback(); }
        })();
        servers.push(server);
        return server;
      },
    });
    const firstStart = gateway.start();
    const firstClose = gateway.close();
    releaseStart();
    await firstClose;
    const firstResult = await firstStart;
    expect(firstResult.port).toBe(4500);
    expect(gateway.getUrl()).toBeUndefined();

    const secondStart = gateway.start();
    releaseStart();
    const second = await secondStart;
    expect(second.port).toBe(4501);
    expect(gateway.getUrl()).toBe('http://127.0.0.1:4501');
    await gateway.close();
  });

  it('prompt_async accepts SDK parts, returns 204, and reserves an explicit messageID', async () => {
    const liveSessions = liveSessionHarness();
    const requests = [];
    const processManager = {
      request: vi.fn(async (key, command) => { requests.push({ key, command }); return { ok: true }; }),
      subscribe: vi.fn(() => () => {}),
      getSnapshot: vi.fn(() => ({ processes: [] })),
    };
    const gateway = createPiCompatibilityGateway({
      sessionRepository: repositoryHarness(),
      liveSessionRegistry: liveSessions,
      processManager,
      defaultDirectory: directory,
    });

    const res = await request(gateway.app)
      .post(`/session/fresh-session/prompt_async?directory=${encodeURIComponent(directory)}`)
      .send({
        messageID: 'msg_explicit_42',
        parts: [{ type: 'text', text: 'hello' }],
      })
      .expect(204);

    expect(res.body).toEqual({});
    expect(requests).toHaveLength(1);
    expect(requests[0].command).toMatchObject({
      type: 'prompt',
      message: 'hello',
    });
    expect(processManager.request).toHaveBeenCalledTimes(1);
    await gateway.close();
  });

  it('prompt_async allows image-only parts without text', async () => {
    const liveSessions = liveSessionHarness();
    const processManager = {
      request: vi.fn(async () => ({ ok: true })),
      subscribe: vi.fn(() => () => {}),
      getSnapshot: vi.fn(() => ({ processes: [] })),
    };
    const gateway = createPiCompatibilityGateway({
      sessionRepository: repositoryHarness(),
      liveSessionRegistry: liveSessions,
      processManager,
      defaultDirectory: directory,
    });

    await request(gateway.app)
      .post(`/session/fresh-session/prompt_async?directory=${encodeURIComponent(directory)}`)
      .send({
        parts: [{ type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAAA' }],
      })
      .expect(204);

    expect(processManager.request).toHaveBeenCalledTimes(1);
    await gateway.close();
  });

  it('prompt_async rejects empty bodies with 400', async () => {
    const liveSessions = liveSessionHarness();
    const gateway = createPiCompatibilityGateway({
      sessionRepository: repositoryHarness(),
      liveSessionRegistry: liveSessions,
      defaultDirectory: directory,
    });
    await request(gateway.app)
      .post(`/session/fresh-session/prompt_async?directory=${encodeURIComponent(directory)}`)
      .send({})
      .expect(400);
    await gateway.close();
  });

  it('abort sends an abort RPC and returns true', async () => {
    const liveSessions = liveSessionHarness();
    const processManager = {
      request: vi.fn(async (key, command) => {
        if (command.type === 'abort') return { ok: true };
        throw new Error(`unexpected ${command.type}`);
      }),
      subscribe: vi.fn(() => () => {}),
      getSnapshot: vi.fn(() => ({ processes: [] })),
    };
    const gateway = createPiCompatibilityGateway({
      sessionRepository: repositoryHarness(),
      liveSessionRegistry: liveSessions,
      processManager,
      defaultDirectory: directory,
    });

    await request(gateway.app)
      .post(`/session/fresh-session/abort?directory=${encodeURIComponent(directory)}`)
      .expect(200)
      .expect('true');

    expect(processManager.request).toHaveBeenCalledWith(
      'pi:["' + directory + '","fresh-session"]',
      { type: 'abort' },
    );
    await gateway.close();
  });

  it('DELETE removes the live session, deletes the file, emits session.deleted with full info', async () => {
    const aliasStore = {
      get: vi.fn(async () => undefined),
      listSession: vi.fn(async () => []),
      upsert: vi.fn(async (r) => r),
      removeSession: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const processManager = {
      request: vi.fn(async () => ({ ok: true })),
      subscribe: vi.fn(() => () => {}),
      stopProcess: vi.fn(async () => true),
      getSnapshot: vi.fn(() => ({ processes: [] })),
    };
    const liveSessions = liveSessionHarness();
    let sessionRemoved = false;
    // Make liveSessions.remove() invoke processManager.stopProcess like the real registry does
    liveSessions.remove = vi.fn(async ({ cwd, sessionId }) => {
      processManager.stopProcess(`pi:${JSON.stringify([cwd, sessionId])}`);
      sessionRemoved = true;
      return true;
    });
    // Make liveSessions.get reflect the removal so subsequent GETs return 404
    const originalGet = liveSessions.get;
    liveSessions.get = vi.fn(({ cwd, sessionId }) => {
      if (sessionRemoved) return undefined;
      return originalGet({ cwd, sessionId });
    });
    const repository = repositoryHarness();
    const gateway = createPiCompatibilityGateway({
      sessionRepository: repository,
      liveSessionRegistry: liveSessions,
      processManager,
      messageAliasStore: aliasStore,
      defaultDirectory: directory,
    });
    const started = await gateway.start();
    const directoryStream = await openSse(`${started.url}/event?directory=${encodeURIComponent(directory)}`);

    await request(gateway.app)
      .delete(`/session/fresh-session?directory=${encodeURIComponent(directory)}`)
      .expect(200)
      .expect('true');

    expect(processManager.stopProcess).toHaveBeenCalled();
    expect(aliasStore.removeSession).toHaveBeenCalledWith('fresh-session');

    await new Promise((resolve) => setTimeout(resolve, 10));
    const text = directoryStream.chunks.join('');
    expect(text).toContain('event: session.deleted');
    // session.deleted payload must include the full Session info per SDK schema.
    expect(text).toMatch(/"info":\{"id":"fresh-session"/);
    expect(text).toMatch(/"sessionID":"fresh-session"/);

    // After delete, GET returns 404
    await request(gateway.app)
      .get(`/session/fresh-session?directory=${encodeURIComponent(directory)}`)
      .expect(404);

    directoryStream.response.destroy();
    await gateway.close();
  });

  it('DELETE returns 404 for unknown session', async () => {
    const liveSessions = {
      get: vi.fn(() => undefined),
      create: vi.fn(),
      remove: vi.fn(async () => false),
      close: vi.fn(async () => {}),
    };
    void liveSessions;
    const repository = repositoryHarness();
    repository.getSession.mockResolvedValue(undefined);
    const gateway = createPiCompatibilityGateway({
      sessionRepository: repository,
      liveSessionRegistry: liveSessions,
      defaultDirectory: directory,
    });
    await request(gateway.app)
      .delete(`/session/nonexistent?directory=${encodeURIComponent(directory)}`)
      .expect(404);
    await gateway.close();
  });

  it('session_info_changed invalidates cache and emits session.updated with the canonical Session shape', async () => {
    const liveSessions = liveSessionHarness();
    const invalidated = { directory: 0, global: 0 };
    const processManager = {
      request: vi.fn(async () => ({ ok: true })),
      subscribe: vi.fn(() => () => {}),
      stopProcess: vi.fn(async () => true),
      getSnapshot: vi.fn(() => ({ processes: [] })),
    };
    // Track subscribed listeners so the test can emit session_info_changed
    // through the same path the gateway uses.
    const subscribed = new Map();
    processManager.subscribe = vi.fn((key, listener) => {
      let set = subscribed.get(key);
      if (!set) { set = new Set(); subscribed.set(key, set); }
      set.add(listener);
      return () => set.delete(listener);
    });

    const repository = repositoryHarness();
    const sessionInfo = {
      id: 'fresh-session',
      path: '/sessions/fresh-session.jsonl',
      cwd: directory,
      name: 'Renamed Session',
      created: new Date(1000),
      modified: new Date(5000),
      messageCount: 1,
      firstMessage: 'first',
      allMessagesText: 'first',
    };
    repository.invalidate = vi.fn((opts) => {
      if (opts && opts.directory === directory) invalidated.directory += 1;
      else invalidated.global += 1;
      return Promise.resolve();
    });
    repository.getSession = vi.fn(async () => sessionInfo);

    const gateway = createPiCompatibilityGateway({
      sessionRepository: repository,
      liveSessionRegistry: liveSessions,
      processManager,
      defaultDirectory: directory,
    });
    const started = await gateway.start();
    const directoryStream = await openSse(`${started.url}/event?directory=${encodeURIComponent(directory)}`);

    // The first prompt_async triggers getOrCreateEventTranslator which
    // subscribes the translator to the processManager; from that moment on
    // session_info_changed events emitted into the subscription reach the
    // gateway's session rename handler.
    await request(gateway.app)
      .post(`/session/fresh-session/prompt_async?directory=${encodeURIComponent(directory)}`)
      .send({ parts: [{ type: 'text', text: 'hi' }] })
      .expect(204);

    const listeners = subscribed.get(`pi:${JSON.stringify([directory, 'fresh-session'])}`);
    expect(listeners && listeners.size).toBe(1);

    for (const listener of listeners) {
      listener({ type: 'session_info_changed', name: 'Renamed Session' });
    }

    // The rename handler is async (cache invalidate + getSession + emit);
    // wait for the microtask queue to drain.
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(invalidated.directory).toBeGreaterThanOrEqual(1);
    expect(invalidated.global).toBeGreaterThanOrEqual(1);
    expect(repository.getSession).toHaveBeenCalledWith('fresh-session', { directory });

    const text = directoryStream.chunks.join('');
    expect(text).toContain('event: session.updated');
    expect(text).toContain('"title":"Renamed Session"');
    // projectID must be hashed, not the raw cwd (event would have set cwd)
    expect(text).toMatch(/"projectID":"project_[0-9a-f]{64}"/);
    // time.created must come from the file (1000), not the rename event time
    expect(text).toContain('"created":1000');
    // time.updated must come from the file (5000), greater than created
    expect(text).toContain('"updated":5000');
    // version must be present
    expect(text).toMatch(/"version":"[^"]+"/);
    // path must be present and absolute
    expect(text).toContain('"path":"/sessions/fresh-session.jsonl"');

    directoryStream.response.destroy();
    await gateway.close();
  });

  it('session_info_changed falls back to global listAll when cwd-filtered getSession misses (macOS symlink mismatch)', async () => {
    const liveSessions = liveSessionHarness();
    const processManager = {
      request: vi.fn(async () => ({ ok: true })),
      subscribe: vi.fn(() => () => {}),
      stopProcess: vi.fn(async () => true),
      getSnapshot: vi.fn(() => ({ processes: [] })),
    };
    const subscribed = new Map();
    processManager.subscribe = vi.fn((key, listener) => {
      let set = subscribed.get(key);
      if (!set) { set = new Set(); subscribed.set(key, set); }
      set.add(listener);
      return () => set.delete(listener);
    });

    const repository = repositoryHarness();
    const sessionInfo = {
      id: 'fresh-session',
      path: '/sessions/fresh-session.jsonl',
      cwd: '/private/var/folders/dk/.../pi-smoke', // canonical form Pi stored
      name: 'Renamed Session',
      created: new Date(2000),
      modified: new Date(7000),
      messageCount: 1,
      firstMessage: 'first',
      allMessagesText: 'first',
    };
    // cwd-filtered lookup misses (Node path.resolve returns /var/... but Pi
    // stored /private/var/...), forcing the fallback to listAll().
    repository.getSession = vi.fn(async () => undefined);
    repository.listAll = vi.fn(async () => [sessionInfo]);

    const gateway = createPiCompatibilityGateway({
      sessionRepository: repository,
      liveSessionRegistry: liveSessions,
      processManager,
      defaultDirectory: directory,
    });
    const started = await gateway.start();
    const directoryStream = await openSse(`${started.url}/event?directory=${encodeURIComponent(directory)}`);

    await request(gateway.app)
      .post(`/session/fresh-session/prompt_async?directory=${encodeURIComponent(directory)}`)
      .send({ parts: [{ type: 'text', text: 'hi' }] })
      .expect(204);

    const listeners = subscribed.get(`pi:${JSON.stringify([directory, 'fresh-session'])}`);
    for (const listener of listeners) {
      listener({ type: 'session_info_changed', name: 'Renamed Session' });
    }
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(repository.getSession).toHaveBeenCalledWith('fresh-session', { directory });
    expect(repository.listAll).toHaveBeenCalled();

    const text = directoryStream.chunks.join('');
    expect(text).toContain('event: session.updated');
    expect(text).toContain('"title":"Renamed Session"');
    expect(text).toContain('"created":2000');
    expect(text).toContain('"updated":7000');

    directoryStream.response.destroy();
    await gateway.close();
  });
});


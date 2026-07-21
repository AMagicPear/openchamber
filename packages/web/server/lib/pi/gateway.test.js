import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import http from 'node:http';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createPiCompatibilityGateway } from './gateway.js';

const directory = '/tmp';
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

describe('Pi compatibility gateway', () => {
  it('serves connected SSE envelopes, heartbeats, and closes live streams', async () => {
    const gateway = createPiCompatibilityGateway({
      sessionRepository: repositoryHarness(),
      defaultDirectory: directory,
      sseHeartbeatIntervalMs: 10,
    });
    const started = await gateway.start();
    const chunks = [];
    const response = await new Promise((resolve, reject) => {
      const request = http.get(`${started.url}/event?directory=%2Ftmp`, (res) => {
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
    expect(chunks.join('')).toContain('"directory":"/tmp"');
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
    await request(gateway.app).get('/config?directory=%2Ftmp').expect(200).expect(({ body }) => expect(body.$schema).toContain('opencode'));
    await request(gateway.app).get('/project/current?directory=%2Ftmp').expect(200).expect(({ body }) => expect(body.worktree).toBe(directory));
    await request(gateway.app).get('/experimental/session?limit=1').expect(200).expect(({ body, headers }) => {
      expect(body).toHaveLength(1);
      expect(headers['x-next-cursor']).toBe('20');
      expect(body[0]).toMatchObject({ id: 'session-new', project: { worktree: directory } });
    });
    await request(gateway.app).get('/session?limit=1').expect(200).expect(({ body }) => expect(body[0]).toMatchObject({ id: 'session-new' }));
    await request(gateway.app).get('/session?start=1&limit=1').expect(200).expect(({ body }) => expect(body[0]).toMatchObject({ id: 'session-old' }));
    await request(gateway.app).get('/session?cursor=1&limit=1').expect(200).expect(({ body }) => expect(body[0]).toMatchObject({ id: 'session-new' }));
    await request(gateway.app).get('/session/session-new').expect(200).expect(({ body }) => expect(body.id).toBe('session-new'));
    await request(gateway.app).get('/session/session-new/message').expect(200).expect(({ body }) => expect(body[0].info.id).toBe('msg_user-entry'));
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
    await request(gateway.app).get('/session/status?directory=%2Ftmp').expect(200).expect(({ body }) => {
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
});


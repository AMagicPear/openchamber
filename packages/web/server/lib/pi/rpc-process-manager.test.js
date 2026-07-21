import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createPiRpcProcessManager } from './rpc-process-manager.js';

const CWD = '/workspace/project';
const SESSION = '/sessions/one.jsonl';

class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.writeReturns = true;
    this.writeError = null;
    this.ended = false;
  }

  write(value, callback) {
    this.writes.push(value);
    callback?.(this.writeError);
    return this.writeReturns;
  }

  end() {
    this.ended = true;
  }
}

class FakeChild extends EventEmitter {
  constructor(pid = 100) {
    super();
    this.pid = pid;
    this.stdin = new FakeStream();
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    this.kills = [];
    this.closeOnKill = true;
    this.stdin.on('data', () => {});
  }

  kill(signal) {
    this.kills.push(signal);
    if (this.closeOnKill) this.close();
    return true;
  }

  close() {
    this.emit('close', 0, null);
  }

  respond(response) {
    this.stdout.emit('data', Buffer.from(`${JSON.stringify(response)}\n`));
  }
}

function createHarness({ onSpawn, ...options } = {}) {
  const children = [];
  const launches = [];
  const spawnProcess = (command, args, spawnOptions) => {
    launches.push({ command, args, spawnOptions });
    const child = new FakeChild(100 + children.length);
    children.push(child);
    onSpawn?.(child, launches.at(-1));
    return child;
  };
  const manager = createPiRpcProcessManager({
    spawnProcess,
    killProcess: options.killProcess || (() => {
      throw new Error('fake process group is unavailable');
    }),
    readyTimeoutMs: 100,
    stopTimeoutMs: 10,
    forceKillTimeoutMs: 10,
    ...options,
  });
  return { manager, children, launches };
}

function answerGetState(child, state = { sessionId: 'pi-session', isStreaming: false }) {
  const request = JSON.parse(child.stdin.writes.at(-1));
  child.respond({ id: request.id, type: 'response', command: 'get_state', success: true, data: state });
}

function flushLaunches() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function readyHarness(options = {}) {
  const harness = createHarness({
    ...options,
    onSpawn: (child) => {
      queueMicrotask(() => answerGetState(child));
      options.onSpawn?.(child);
    },
  });
  const ready = harness.manager.ensureProcess({ key: 'runtime:session', cwd: CWD, sessionPath: SESSION });
  return { ...harness, identity: await ready };
}

describe('createPiRpcProcessManager', () => {
  it('launches with fixed cwd, merged env, session args, and proves get_state readiness', async () => {
    const { manager, launches, identity } = await readyHarness({
      resolveLaunchSpec: () => ({ command: '/bin/pi', args: ['--flag'], env: { PI_TEST: 'yes' } }),
    });
    expect(launches[0]).toMatchObject({
      command: '/bin/pi',
      args: ['--flag', '--mode', 'rpc', '--session', SESSION],
      spawnOptions: { cwd: CWD, detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    });
    expect(launches[0].spawnOptions.env).toMatchObject({ PI_TEST: 'yes' });
    expect(identity).toMatchObject({ key: 'runtime:session', cwd: CWD, sessionPath: SESSION, sessionId: 'pi-session' });
    await manager.shutdown();
  });

  it('supports session-id launches and manager-owned ids', async () => {
    const harness = await readyHarness({
      onSpawn: undefined,
      resolveLaunchSpec: () => ({ command: 'pi' }),
    });
    await harness.manager.stopProcess('runtime:session');
    const second = createHarness({
      resolveLaunchSpec: () => ({ command: 'pi' }),
      onSpawn: (child) => queueMicrotask(() => answerGetState(child, { sessionId: 'requested-id' })),
    });
    await second.manager.ensureProcess({ key: 'id-key', cwd: CWD, sessionId: 'requested-id' });
    expect(second.launches[0].args).toEqual(['--mode', 'rpc', '--session-id', 'requested-id']);
    const requestPromise = second.manager.request('id-key', { type: 'get_state', id: 'caller-id' });
    const request = JSON.parse(second.children[0].stdin.writes.at(-1));
    expect(request.id).not.toBe('caller-id');
    second.children[0].respond({ id: request.id, type: 'response', command: 'get_state', success: true, data: { ok: true } });
    await expect(requestPromise).resolves.toEqual({ ok: true });
    await second.manager.shutdown();
  });

  it('parses fragmented and multiple records, including UTF-8 split and Unicode separators', async () => {
    const { manager, children } = await readyHarness();
    const events = [];
    manager.subscribe('runtime:session', (event) => events.push(event));
    const child = children[0];
    const event = { type: 'message_update', text: 'a\u2028b\u2029c', value: 'é' };
    const encoded = Buffer.from(`${JSON.stringify(event)}\n${JSON.stringify({ type: 'agent_end' })}\n`);
    const split = encoded.indexOf(Buffer.from('é')) + 1;
    child.stdout.emit('data', encoded.subarray(0, split));
    child.stdout.emit('data', encoded.subarray(split));
    expect(events).toEqual([event, { type: 'agent_end' }]);
    await manager.shutdown();
  });

  it('handles an unterminated final JSONL record at EOF', async () => {
    const { manager, children } = await readyHarness();
    const events = [];
    manager.subscribe('runtime:session', (event) => events.push(event));
    children[0].stdout.emit('data', Buffer.from('{"type":"message_update","text":"final"}'));
    children[0].stdout.emit('end');
    expect(events).toEqual([{ type: 'message_update', text: 'final' }]);
    await manager.shutdown();
  });

  it('correlates only matching responses and broadcasts interleaved events in order', async () => {
    const { manager, children } = await readyHarness();
    const events = [];
    manager.subscribe('runtime:session', (event) => events.push(event));
    const child = children[0];
    const pending = manager.request('runtime:session', { type: 'get_state' });
    const request = JSON.parse(child.stdin.writes.at(-1));
    child.respond({ type: 'message_start', id: 'event-id' });
    child.respond({ id: 'other', type: 'response', command: 'other', success: true, data: 1 });
    child.respond({ id: request.id, type: 'response', command: 'get_state', success: true, data: { ready: true } });
    child.respond({ type: 'message_end' });
    await expect(pending).resolves.toEqual({ ready: true });
    expect(events).toEqual([
      { type: 'message_start', id: 'event-id' },
      { id: 'other', type: 'response', command: 'other', success: true, data: 1 },
      { type: 'message_end' },
    ]);
    const errorRequest = manager.request('runtime:session', { type: 'abort' });
    const errorId = JSON.parse(child.stdin.writes.at(-1)).id;
    child.respond({ id: errorId, type: 'response', command: 'abort', success: false, error: 'denied' });
    await expect(errorRequest).rejects.toThrow('abort failed: denied');
    await manager.shutdown();
  });

  it('deduplicates concurrent ensure calls', async () => {
    let spawnCount = 0;
    const harness = createHarness({
      onSpawn: (child) => {
        spawnCount += 1;
        queueMicrotask(() => answerGetState(child));
      },
    });
    const first = harness.manager.ensureProcess({ key: 'same', cwd: CWD });
    const second = harness.manager.ensureProcess({ key: 'same', cwd: CWD });
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(spawnCount).toBe(1);
    await harness.manager.shutdown();
  });

  it('claims a requested cwd and session identity before concurrent startup', async () => {
    const harness = createHarness({
      onSpawn: (child) => queueMicrotask(() => answerGetState(child, { sessionId: 'same-id' })),
    });
    const first = harness.manager.ensureProcess({ key: 'first', cwd: CWD, sessionId: 'same-id' });
    const second = harness.manager.ensureProcess({ key: 'second', cwd: CWD, sessionId: 'same-id' });
    await expect(second).rejects.toThrow('already claimed');
    await expect(first).resolves.toMatchObject({ key: 'first', sessionId: 'same-id' });
    expect(harness.children).toHaveLength(1);
    await harness.manager.shutdown();
  });

  it('keeps a requested cwd and session identity claimed after readiness', async () => {
    let launchNumber = 0;
    const harness = createHarness({
      onSpawn: (child) => {
        launchNumber += 1;
        queueMicrotask(() => answerGetState(child, { sessionId: launchNumber === 1 ? 'same-id' : 'other-id' }));
      },
    });
    await harness.manager.ensureProcess({ key: 'first', cwd: CWD, sessionId: 'same-id' });
    await expect(harness.manager.ensureProcess({ key: 'second', cwd: CWD, sessionId: 'same-id' })).rejects.toThrow(
      'already claimed',
    );
    await expect(harness.manager.ensureProcess({ key: 'third', cwd: CWD, sessionId: 'other-id' })).resolves.toMatchObject({
      key: 'third',
      sessionId: 'other-id',
    });
    expect(harness.children).toHaveLength(2);
    await harness.manager.shutdown();
  });

  it('claims authoritative identities for initially ID-less launches', async () => {
    const harness = createHarness();
    const first = harness.manager.ensureProcess({ key: 'first', cwd: CWD });
    await flushLaunches();
    const second = harness.manager.ensureProcess({ key: 'second', cwd: CWD });
    await flushLaunches();
    expect(harness.children).toHaveLength(2);

    answerGetState(harness.children[0], { sessionId: 'authoritative-id' });
    await expect(first).resolves.toMatchObject({ key: 'first', sessionId: 'authoritative-id' });
    answerGetState(harness.children[1], { sessionId: 'authoritative-id' });
    await expect(second).rejects.toThrow('already claimed');
    expect(harness.manager.getSnapshot().processes.map((process) => process.key)).toEqual(['first']);
    await harness.manager.shutdown();
  });

  it('rejects a requested identity when get_state returns a different non-empty identity', async () => {
    const harness = createHarness({
      onSpawn: (child) => queueMicrotask(() => answerGetState(child, { sessionId: 'returned-id' })),
    });
    await expect(harness.manager.ensureProcess({ key: 'mismatch', cwd: CWD, sessionId: 'requested-id' })).rejects.toThrow(
      'identity mismatch',
    );
    expect(harness.manager.getSnapshot().processes).toHaveLength(0);
    await harness.manager.shutdown();
  });

  it('releases session identity claims after stop', async () => {
    const harness = createHarness({
      onSpawn: (child) => queueMicrotask(() => answerGetState(child, { sessionId: 'released-id' })),
    });
    await harness.manager.ensureProcess({ key: 'first', cwd: CWD, sessionId: 'released-id' });
    await expect(harness.manager.stopProcess('first')).resolves.toBe(true);
    await expect(harness.manager.ensureProcess({ key: 'second', cwd: CWD, sessionId: 'released-id' })).resolves.toMatchObject({
      key: 'second',
      sessionId: 'released-id',
    });
    await harness.manager.shutdown();
  });

  it('cleans up a timed-out request independently', async () => {
    const { manager, children } = await readyHarness({ requestTimeoutMs: 5 });
    const pending = manager.request('runtime:session', { type: 'get_messages' }, { timeoutMs: 5 });
    const rejection = expect(pending).rejects.toThrow('get_messages timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await rejection;
    expect(manager.getSnapshot().processes[0].pendingRequests).toBe(0);
    children[0].closeOnKill = true;
    await manager.shutdown();
  });

  it('fails on malformed and oversized records', async () => {
    const malformed = await readyHarness({ maxJsonlRecordBytes: 1000 });
    const failureEvents = [];
    malformed.manager.subscribe('runtime:session', (event) => failureEvents.push(event));
    malformed.children[0].stdout.emit('data', Buffer.from('{bad}\n'));
    expect(malformed.manager.getSnapshot().processes).toHaveLength(0);
    expect(failureEvents).toEqual([{ type: 'lifecycle', event: 'process_failed', generation: 1 }]);
    await malformed.manager.shutdown();

    const oversized = await readyHarness({ maxJsonlRecordBytes: 1000 });
    const oversizedEvents = [];
    oversized.manager.subscribe('runtime:session', (event) => oversizedEvents.push(event));
    oversized.children[0].stdout.emit('data', Buffer.from(`{"too-long":"${'x'.repeat(1000)}"`));
    expect(oversized.manager.getSnapshot().processes).toHaveLength(0);
    expect(oversizedEvents).toEqual([{ type: 'lifecycle', event: 'process_failed', generation: 1 }]);
    await oversized.manager.shutdown();
  });

  it('rejects all pending calls and emits one lifecycle event on unexpected exit', async () => {
    const { manager, children } = await readyHarness();
    const events = [];
    manager.subscribe('runtime:session', (event) => events.push(event));

    // Verify that the process is ready and can receive requests
    expect(manager.getSnapshot().processes).toHaveLength(1);
    expect(manager.getSnapshot().processes[0].ready).toBe(true);

    // Simulate unexpected exit: emit process exit/close events directly
    children[0].emit('exit', 1, null);
    children[0].emit('close', 1, null);

    // After failure, pending requests should be cleared
    expect(events).toEqual([{ type: 'lifecycle', event: 'process_failed', generation: 1 }]);
    expect(manager.getSnapshot().processes).toHaveLength(0);

    // New requests against a failed entry should reject
    await expect(manager.request('runtime:session', { type: 'prompt' }, { timeoutMs: 50 }))
      .rejects.toThrow('process not found');
    await manager.shutdown();
  });

  it('prevents duplicate session-path claims but allows different keys in one cwd', async () => {
    let launchNumber = 0;
    const harness = createHarness({
      onSpawn: (child) => {
        launchNumber += 1;
        queueMicrotask(() => answerGetState(child, { sessionId: launchNumber === 1 ? 'pi-session' : 'different' }));
      },
    });
    await harness.manager.ensureProcess({ key: 'runtime:session', cwd: CWD, sessionPath: SESSION });
    await expect(harness.manager.ensureProcess({ key: 'other', cwd: CWD, sessionPath: SESSION })).rejects.toThrow(
      'already claimed',
    );
    await harness.manager.ensureProcess({ key: 'other', cwd: CWD, sessionId: 'different' });
    expect(harness.manager.getSnapshot().processes).toHaveLength(2);
    await harness.manager.shutdown();
  });

  it('tracks busy from agent_start through agent_settled, not agent_end', async () => {
    const { manager, children } = await readyHarness();
    children[0].stdout.emit('data', Buffer.from('{"type":"agent_start"}\n'));
    expect(manager.getSnapshot().processes[0].busy).toBe(true);
    children[0].stdout.emit('data', Buffer.from('{"type":"agent_end"}\n'));
    expect(manager.getSnapshot().processes[0].busy).toBe(true);
    children[0].stdout.emit('data', Buffer.from('{"type":"agent_settled"}\n'));
    expect(manager.getSnapshot().processes[0].busy).toBe(false);
    await manager.shutdown();
  });

  it('enforces maxProcesses without evicting the existing process', async () => {
    const harness = createHarness({
      maxProcesses: 1,
      onSpawn: (child) => queueMicrotask(() => answerGetState(child)),
    });
    await harness.manager.ensureProcess({ key: 'first', cwd: CWD });
    await expect(harness.manager.ensureProcess({ key: 'second', cwd: CWD })).rejects.toThrow('process cap reached');
    expect(harness.manager.getSnapshot().processes.map((process) => process.key)).toEqual(['first']);
    await harness.manager.shutdown();
  });

  it('honors stdin backpressure and callback errors', async () => {
    const harness = await readyHarness();
    const child = harness.children[0];
    child.stdin.writeReturns = false;
    const pending = harness.manager.request('runtime:session', { type: 'get_state' });
    const request = JSON.parse(child.stdin.writes.at(-1));
    child.stdin.emit('drain');
    child.respond({ id: request.id, type: 'response', command: 'get_state', success: true, data: 7 });
    await expect(pending).resolves.toBe(7);
    child.stdin.writeError = new Error('pipe closed');
    await expect(harness.manager.request('runtime:session', { type: 'get_state' })).rejects.toThrow('pipe closed');
    await harness.manager.shutdown();
  });

  it('keeps a replacement registered when stale exit and close events arrive', async () => {
    let spawnNumber = 0;
    const harness = createHarness({
      onSpawn: (child) => {
        spawnNumber += 1;
        child.closeOnKill = spawnNumber !== 1;
        queueMicrotask(() => answerGetState(child, { sessionId: 'same-id' }));
      },
    });
    await harness.manager.ensureProcess({ key: 'runtime:session', cwd: CWD, sessionId: 'same-id' });
    const oldChild = harness.children[0];
    const stopping = harness.manager.stopProcess('runtime:session');
    const replacementReady = harness.manager.ensureProcess({
      key: 'runtime:session',
      cwd: CWD,
      sessionId: 'same-id',
    });
    await replacementReady;

    oldChild.emit('exit', 1, null);
    oldChild.emit('close', 1, null);
    await expect(stopping).resolves.toBe(true);
    expect(harness.manager.getSnapshot().processes).toMatchObject([{ key: 'runtime:session', ready: true }]);

    const requestPromise = harness.manager.request('runtime:session', { type: 'get_state' });
    const request = JSON.parse(harness.children[1].stdin.writes.at(-1));
    harness.children[1].respond({ id: request.id, type: 'response', command: 'get_state', success: true, data: 7 });
    await expect(requestPromise).resolves.toBe(7);
    await expect(harness.manager.stopProcess('runtime:session')).resolves.toBe(true);
    await harness.manager.shutdown();
  });

  it('reports false when force termination is not observed', async () => {
    const killedPids = [];
    const harness = createHarness({
      killProcess: (pid, signal) => killedPids.push([pid, signal]),
      stopTimeoutMs: 5,
      forceKillTimeoutMs: 5,
      onSpawn: (child) => {
        child.closeOnKill = false;
        queueMicrotask(() => answerGetState(child, { sessionId: 'force-id' }));
      },
    });
    await harness.manager.ensureProcess({ key: 'force', cwd: CWD, sessionId: 'force-id' });
    const stopping = harness.manager.stopProcess('force');
    await expect(stopping).resolves.toBe(false);
    expect(killedPids).toEqual([[-100, 'SIGTERM'], [-100, 'SIGKILL']]);
    expect(harness.manager.getSnapshot().processes).toHaveLength(0);
    await harness.manager.shutdown();
  });

  it('makes shutdown idempotent and covers every process', async () => {
    let launchNumber = 0;
    const harness = createHarness({
      onSpawn: (child) => {
        launchNumber += 1;
        queueMicrotask(() => answerGetState(child, { sessionId: launchNumber === 1 ? 'pi-session' : 'two' }));
      },
    });
    await harness.manager.ensureProcess({ key: 'one', cwd: CWD });
    await harness.manager.ensureProcess({ key: 'two', cwd: CWD, sessionId: 'two' });
    const first = harness.manager.shutdown();
    const second = harness.manager.shutdown();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(harness.manager.getSnapshot()).toMatchObject({ shuttingDown: true, processes: [] });
  });
});


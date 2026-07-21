import { describe, expect, it, vi } from 'vitest';
import { createPiLiveSessionRegistry } from './live-session-registry.js';

const cwd = '/tmp';

function managerHarness() {
  let generation = 0;
  const listeners = new Map();
  const manager = {
    ensureProcess: vi.fn(async ({ key, cwd: requestedCwd, sessionId }) => ({
      key,
      generation: ++generation,
      cwd: requestedCwd,
      sessionId,
      state: { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, messageCount: 0 },
    })),
    stopProcess: vi.fn(async () => true),
    subscribe: vi.fn((key, listener) => {
      listeners.set(key, listener);
      return () => listeners.delete(key);
    }),
  };
  return { manager, listeners };
}

describe('Pi live session registry', () => {
  it('deduplicates the same requested or generated identity and tracks authoritative state', async () => {
    const { manager } = managerHarness();
    const registry = createPiLiveSessionRegistry({ processManager: manager, randomUUID: () => 'generated-id' });
    const first = registry.create({ cwd });
    const second = registry.create({ cwd, sessionId: 'generated-id' });
    expect(first).toBe(second);
    await expect(first).resolves.toMatchObject({
      cwd,
      sessionId: 'generated-id',
      sessionPath: '/sessions/generated-id.jsonl',
      state: { sessionId: 'generated-id' },
    });
    expect(manager.ensureProcess).toHaveBeenCalledOnce();
    expect(registry.get({ cwd, sessionId: 'generated-id' })).toMatchObject({ generation: 1 });
  });

  it('rejects authoritative identity and path mismatches without retaining a fake binding', async () => {
    const { manager } = managerHarness();
    manager.ensureProcess.mockResolvedValueOnce({
      key: 'pi', generation: 1, cwd, sessionId: 'requested', state: { sessionId: 'other', sessionFile: '/sessions/other.jsonl' },
    });
    const registry = createPiLiveSessionRegistry({ processManager: manager });
    await expect(registry.create({ cwd, sessionId: 'requested' })).rejects.toThrow('different session identity');
    expect(registry.get({ cwd, sessionId: 'requested' })).toBeUndefined();
    expect(manager.stopProcess).toHaveBeenCalledOnce();

    manager.ensureProcess.mockResolvedValueOnce({
      key: 'pi', generation: 2, cwd, sessionId: 'path-only', state: { sessionId: 'path-only' },
    });
    await expect(registry.create({ cwd, sessionId: 'path-only' })).rejects.toThrow('authoritative session path');
    expect(registry.get({ cwd, sessionId: 'path-only' })).toBeUndefined();
  });

  it('does not let a stale completion overwrite a later binding and clears failed live state', async () => {
    let resolveFirst;
    const { manager, listeners } = managerHarness();
    manager.ensureProcess
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({
        key: 'pi', generation: 2, cwd, sessionId: 'same', state: { sessionId: 'same', sessionFile: '/sessions/new.jsonl' },
      });
    const registry = createPiLiveSessionRegistry({ processManager: manager });
    const first = registry.create({ cwd, sessionId: 'same' });
    await registry.remove({ cwd, sessionId: 'same' });
    await expect(registry.create({ cwd, sessionId: 'same' })).resolves.toMatchObject({ sessionPath: '/sessions/new.jsonl' });
    resolveFirst({ key: 'pi', generation: 1, cwd, sessionId: 'same', state: { sessionId: 'same', sessionFile: '/sessions/old.jsonl' } });
    await expect(first).rejects.toThrow('stale');
    expect(registry.get({ cwd, sessionId: 'same' })).toMatchObject({ sessionPath: '/sessions/new.jsonl' });
    const listener = listeners.get('pi:' + JSON.stringify([cwd, 'same']));
    listener({ type: 'lifecycle', event: 'process_failed', generation: 2 });
    expect(registry.get({ cwd, sessionId: 'same' })).toBeUndefined();
  });
});

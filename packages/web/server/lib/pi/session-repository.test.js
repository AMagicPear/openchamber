import { describe, expect, it, vi } from 'vitest';
import { createPiSessionRepository } from './session-repository.js';

const first = {
  id: 'session-one',
  path: '/sessions/one.jsonl',
  cwd: '/workspace/one',
  created: new Date('2026-01-01T00:00:00.000Z'),
  modified: new Date('2026-01-01T00:01:00.000Z'),
  messageCount: 1,
  firstMessage: 'hello',
  allMessagesText: 'hello',
};

function managerHarness() {
  const opened = { getBranch: vi.fn(() => [{ type: 'message', id: 'entry-one', parentId: null, message: { role: 'user' } }]) };
  const manager = {
    list: vi.fn(async () => [first]),
    listAll: vi.fn(async () => [first]),
    open: vi.fn(() => opened),
  };
  return { manager, opened };
}

describe('createPiSessionRepository', () => {
  it('caches successful catalogs, indexes by id/path, and opens the active branch', async () => {
    const { manager, opened } = managerHarness();
    const repository = createPiSessionRepository({ SessionManager: manager, cacheTtlMs: 60_000 });

    await expect(repository.listDirectory('/workspace/one')).resolves.toEqual([first]);
    await expect(repository.listDirectory('/workspace/one')).resolves.toEqual([first]);
    expect(manager.list).toHaveBeenCalledTimes(1);
    await expect(repository.getCatalogIndex({ directory: '/workspace/one' })).resolves.toMatchObject({
      byId: expect.any(Map),
      byPath: expect.any(Map),
    });
    await expect(repository.getActiveBranch('session-one', { directory: '/workspace/one' })).resolves.toMatchObject({
      info: first,
      entries: expect.any(Array),
    });
    expect(opened.getBranch).toHaveBeenCalledTimes(1);
  });

  it('rethrows catalog errors and preserves prior cache until explicit invalidation', async () => {
    const { manager } = managerHarness();
    const repository = createPiSessionRepository({ SessionManager: manager, cacheTtlMs: 0 });
    await expect(repository.listAll()).resolves.toEqual([first]);
    manager.listAll.mockRejectedValueOnce(new Error('catalog unavailable'));
    await expect(repository.listAll()).rejects.toThrow('catalog unavailable');
    expect(manager.listAll).toHaveBeenCalledTimes(2);
    manager.listAll.mockResolvedValueOnce([]);
    repository.invalidate();
    await expect(repository.listAll()).resolves.toEqual([]);
  });

  it('supports optional directory disambiguation without treating a miss as an empty success from failure', async () => {
    const { manager } = managerHarness();
    const second = { ...first, id: 'session-two', path: '/sessions/two.jsonl', cwd: '/workspace/two' };
    manager.listAll.mockResolvedValue([first, second]);
    const repository = createPiSessionRepository({ SessionManager: manager });
    await expect(repository.getSession('session-two')).resolves.toEqual(second);
    await expect(repository.getSession('session-two', { directory: '/workspace/one' })).resolves.toBeUndefined();
  });

  it('rejects ambiguous global ids instead of opening a session from the wrong directory', async () => {
    const { manager } = managerHarness();
    manager.listAll.mockResolvedValue([
      first,
      { ...first, path: '/sessions/duplicate.jsonl', cwd: '/workspace/two' },
    ]);
    const repository = createPiSessionRepository({ SessionManager: manager });

    await expect(repository.getSession('session-one')).rejects.toThrow('directory is required');
  });

  it('rejects incomplete durable catalog entries instead of normalizing them to the process directory', async () => {
    const { manager } = managerHarness();
    manager.listAll.mockResolvedValueOnce([{ ...first, cwd: '', modified: new Date('invalid') }]);
    const repository = createPiSessionRepository({ SessionManager: manager });

    await expect(repository.listAll()).rejects.toThrow('non-empty absolute path');
  });
});


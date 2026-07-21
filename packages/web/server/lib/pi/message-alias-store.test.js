import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPiMessageAliasStore, hashPiMessageContent } from './message-alias-store.js';

const temporaryDirectories = [];

async function createTemporaryFilePath() {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openchamber-pi-alias-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'nested', 'pi-message-aliases.json');
}

function alias(overrides = {}) {
  return {
    sessionID: 'session-1',
    entryID: 'entry-1',
    messageID: 'message-1',
    role: 'user',
    created: 1_700_000_000_000,
    contentHash: hashPiMessageContent('hello'),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fsPromises.rm(directory, { recursive: true, force: true })));
});

describe('Pi message alias store', () => {
  it('treats a missing file as an empty state', async () => {
    const filePath = await createTemporaryFilePath();
    const store = createPiMessageAliasStore({ filePath });

    await expect(store.get({ sessionID: 'session-1', entryID: 'entry-1' })).resolves.toBeUndefined();
    await expect(store.listSession('session-1')).resolves.toEqual([]);
  });

  it('hashes UTF-8 content deterministically through the caller-side helper', () => {
    expect(hashPiMessageContent('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(hashPiMessageContent('é')).toBe('4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c');
    expect(() => hashPiMessageContent('hello', { contentHash: () => 'not-a-hash' })).toThrow('SHA-256');
  });

  it('persists only the strict alias shape and uses atomic restricted writes', async () => {
    const filePath = await createTemporaryFilePath();
    const writes = [];
    const chmods = [];
    const renames = [];
    const fs = {
      ...fsPromises,
      writeFile: vi.fn(async (temporary, contents, options) => {
        writes.push({ temporary, contents, options });
        return fsPromises.writeFile(temporary, contents, options);
      }),
      chmod: vi.fn(async (target, mode) => {
        chmods.push({ target, mode });
        return fsPromises.chmod(target, mode);
      }),
      rename: vi.fn(async (temporary, destination) => {
        renames.push({ temporary, destination });
        return fsPromises.rename(temporary, destination);
      }),
    };
    const store = createPiMessageAliasStore({ filePath, fsPromises: fs, now: () => 123 });

    await store.upsert(alias());
    const persisted = JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
    expect(persisted).toEqual({ version: 1, aliases: [alias()] });
    expect(persisted.aliases[0]).not.toHaveProperty('text');
    expect(JSON.stringify(persisted)).not.toContain('hello');
    expect(writes).toHaveLength(1);
    expect(writes[0].options.mode).toBe(0o600);
    expect(writes[0].temporary).not.toBe(filePath);
    expect(writes[0].temporary).toContain('.tmp-');
    expect(renames).toEqual([{ temporary: writes[0].temporary, destination: filePath }]);
    expect(chmods).toContainEqual({ target: writes[0].temporary, mode: 0o600 });
    expect(chmods).toContainEqual({ target: filePath, mode: 0o600 });
    const directoryStat = await fsPromises.stat(path.dirname(filePath));
    expect(directoryStat.mode & 0o777).toBe(0o700);
  });

  it('cleans up a failed temporary write without replacing memory', async () => {
    const filePath = await createTemporaryFilePath();
    const temporaryPaths = [];
    const fs = {
      ...fsPromises,
      writeFile: vi.fn(async (temporary, contents, options) => {
        temporaryPaths.push(temporary);
        return fsPromises.writeFile(temporary, contents, options);
      }),
      rename: vi.fn(async () => { throw new Error('rename failed'); }),
    };
    const store = createPiMessageAliasStore({ filePath, fsPromises: fs, now: () => 1 });

    await expect(store.upsert(alias())).rejects.toThrow('rename failed');
    await expect(store.get({ sessionID: 'session-1', entryID: 'entry-1' })).resolves.toBeUndefined();
    await expect(fsPromises.access(temporaryPaths[0])).rejects.toThrow();
  });

  it('reads aliases after a restart and returns copies', async () => {
    const filePath = await createTemporaryFilePath();
    const first = createPiMessageAliasStore({ filePath });
    await first.upsert(alias());
    const second = createPiMessageAliasStore({ filePath });

    const found = await second.get({ sessionID: 'session-1', entryID: 'entry-1' });
    found.messageID = 'changed-locally';
    expect(await second.get({ sessionID: 'session-1', entryID: 'entry-1' })).toEqual(alias());
    expect(await second.listSession('session-1')).toEqual([alias()]);
  });

  it.each([
    ['malformed JSON', '{'],
    ['wrong version', JSON.stringify({ version: 2, aliases: [] })],
    ['forbidden nested field', JSON.stringify({ version: 1, aliases: [{ ...alias(), extra: { TEXT: 'secret' } }] })],
    ['unexpected record field', JSON.stringify({ version: 1, aliases: [{ ...alias(), extra: true }] })],
  ])('rejects %s instead of treating storage as empty', async (_name, contents) => {
    const filePath = await createTemporaryFilePath();
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.writeFile(filePath, contents, 'utf8');
    const store = createPiMessageAliasStore({ filePath });

    await expect(store.listSession('session-1')).rejects.toThrow();
    await expect(store.get({ sessionID: 'session-1', entryID: 'entry-1' })).rejects.toThrow();
  });

  it('rejects duplicate identities in persisted state and preserves loaded memory', async () => {
    const filePath = await createTemporaryFilePath();
    const duplicate = alias({ messageID: 'message-2' });
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.writeFile(filePath, JSON.stringify({ version: 1, aliases: [alias(), duplicate] }), 'utf8');
    const store = createPiMessageAliasStore({ filePath });
    await expect(store.listSession('session-1')).rejects.toThrow('Duplicate alias identity');

    await expect(store.listSession('session-1')).rejects.toThrow('Duplicate alias identity');
  });

  it('rejects incompatible aliases, accepts exact idempotent upserts, and serializes concurrent updates', async () => {
    const filePath = await createTemporaryFilePath();
    const writes = vi.fn((temporary, contents, options) => fsPromises.writeFile(temporary, contents, options));
    const store = createPiMessageAliasStore({
      filePath,
      fsPromises: { ...fsPromises, writeFile: writes },
    });
    const second = alias({ entryID: 'entry-2', messageID: 'message-2', role: 'assistant' });

    await Promise.all([store.upsert(alias()), store.upsert(second)]);
    expect(await store.listSession('session-1')).toEqual([alias(), second]);
    expect(writes).toHaveBeenCalledTimes(2);
    await expect(store.upsert(alias({ messageID: 'different' }))).rejects.toThrow('Incompatible alias');
    await expect(store.upsert(alias())).resolves.toEqual(alias());
    expect(writes).toHaveBeenCalledTimes(2);
  });

  it('removes a session durably', async () => {
    const filePath = await createTemporaryFilePath();
    const store = createPiMessageAliasStore({ filePath });
    await store.upsert(alias());
    await store.upsert(alias({ entryID: 'entry-2', messageID: 'message-2' }));
    await store.upsert(alias({ sessionID: 'session-2', entryID: 'entry-3', messageID: 'message-3' }));
    await store.removeSession('session-1');

    expect(await store.listSession('session-1')).toEqual([]);
    const restarted = createPiMessageAliasStore({ filePath });
    expect(await restarted.listSession('session-1')).toEqual([]);
    expect(await restarted.listSession('session-2')).toEqual([alias({ sessionID: 'session-2', entryID: 'entry-3', messageID: 'message-3' })]);
  });
});

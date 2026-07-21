import { describe, expect, it } from 'vitest';
import {
  piBranchToOpenCodeMessages,
  piDirectoryToPath,
  piDirectoryToProject,
  piSessionToGlobalSession,
  piSessionToOpenCodeSession,
  projectIdForDirectory,
} from './opencode-shapes.js';

const info = {
  id: 'pi-session',
  path: '/sessions/one.jsonl',
  cwd: '/workspace/project',
  parentSessionPath: '/sessions/parent.jsonl',
  name: 'A saved session',
  firstMessage: 'ignored title',
  created: new Date('2026-01-01T00:00:00.000Z'),
  modified: new Date('2026-01-01T00:01:00.000Z'),
};

describe('Pi OpenCode shape conversion', () => {
  it('uses durable ids, Pi version, parent path resolution, and a full cryptographic project id', () => {
    const session = piSessionToOpenCodeSession(info, {
      version: '0.80.10',
      sessionIndex: { byPath: new Map([['/sessions/parent.jsonl', { id: 'parent-session' }]]) },
    });
    expect(session).toMatchObject({
      id: 'pi-session',
      version: '0.80.10',
      parentID: 'parent-session',
      projectID: projectIdForDirectory('/workspace/project'),
      time: { created: 1767225600000, updated: 1767225660000 },
    });
    expect(session.projectID).toMatch(/^project_[a-f0-9]{64}$/);
    expect(piSessionToGlobalSession(info).project).toMatchObject({ id: session.projectID, worktree: '/workspace/project' });
  });

  it('rejects invalid session directories and dates instead of falling back to process.cwd', () => {
    expect(() => piSessionToOpenCodeSession({ ...info, cwd: '' })).toThrow('non-empty absolute path');
    expect(() => piSessionToOpenCodeSession({ ...info, path: 'relative.jsonl' })).toThrow('non-empty absolute path');
    expect(() => piSessionToOpenCodeSession({ ...info, created: 'invalid date' })).toThrow('created is invalid');
    expect(() => piDirectoryToProject('relative')).toThrow('absolute path');
  });

  it('creates valid path/project shapes from the requested directory', () => {
    expect(piDirectoryToPath('/workspace/project', {
      home: '/home/test', state: '/state', config: '/config',
    })).toEqual({
      home: '/home/test', state: '/state', config: '/config', worktree: '/workspace/project', directory: '/workspace/project',
    });
    expect(piDirectoryToProject('/workspace/project')).toMatchObject({
      id: projectIdForDirectory('/workspace/project'), worktree: '/workspace/project', sandboxes: [],
    });
  });

  it('converts visible messages and merges tool results into the matching ordered ToolPart', () => {
    const records = piBranchToOpenCodeMessages([
      { type: 'message', id: 'user-entry', parentId: null, timestamp: '2026-01-01T00:00:00.000Z', message: {
        role: 'user', timestamp: 1767225600000, content: [{ type: 'text', text: 'look' }, { type: 'image', data: 'abc', mimeType: 'image/png' }],
      } },
      { type: 'message', id: 'assistant-entry', parentId: 'user-entry', timestamp: '2026-01-01T00:00:01.000Z', message: {
        role: 'assistant', timestamp: 1767225601000, provider: 'provider', model: 'model',
        content: [
          { type: 'thinking', thinking: 'reason' },
          { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'file' } },
          { type: 'text', text: 'done' },
        ],
        usage: { input: 1, output: 2, reasoning: 1, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 } },
        stopReason: 'toolUse',
      } },
      { type: 'message', id: 'tool-entry', parentId: 'assistant-entry', timestamp: '2026-01-01T00:00:02.000Z', message: {
        role: 'toolResult', toolCallId: 'call-1', toolName: 'read', timestamp: 1767225602000,
        content: [{ type: 'text', text: 'file contents' }], isError: false,
      } },
    ], { sessionId: 'pi-session', directory: '/workspace/project' });

    expect(records).toHaveLength(2);
    expect(records[0].info.id).toBe('msg_user-entry');
    expect(records[0].parts[1]).toMatchObject({ id: 'prt_user-entry_1', type: 'file', url: 'data:image/png;base64,abc' });
    expect(records[1].info.parentID).toBe('msg_user-entry');
    expect(records[1].parts.map((part) => part.type)).toEqual(['reasoning', 'tool', 'text']);
    expect(records[1].parts[1].state).toMatchObject({ status: 'completed', output: 'file contents' });
    expect(records[1].parts[1].id).toBe('prt_assistant-entry_1');
  });

  it('keeps missing tool results pending and ignores unrelated results', () => {
    const records = piBranchToOpenCodeMessages([
      { type: 'message', id: 'orphan', parentId: null, message: {
        role: 'toolResult', toolCallId: 'missing', toolName: 'unknown', content: [], isError: true, timestamp: 1,
      } },
      { type: 'custom', id: 'custom', parentId: null },
      { type: 'message', id: 'assistant', parentId: null, message: {
        role: 'assistant', provider: 'p', model: 'm', content: [{ type: 'toolCall', id: 'call', name: 'tool', arguments: {} }],
        usage: {}, stopReason: 'stop', timestamp: 2,
      } },
    ], { sessionId: 'pi-session', directory: '/workspace/project' });
    expect(records).toHaveLength(1);
    expect(records[0].parts[0].state.status).toBe('pending');
  });

  it('uses a durable parent for a first assistant and never self-references it', () => {
    const records = piBranchToOpenCodeMessages([
      { type: 'message', id: 'missing-user', parentId: null, message: { role: 'custom', content: 'hidden' } },
      { type: 'message', id: 'assistant-first', parentId: 'missing-user', message: {
        role: 'assistant', provider: 'provider', model: 'model', content: [{ type: 'text', text: 'hello' }],
        usage: {
          input: 10, output: 20, reasoning: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 39,
          cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
        },
        stopReason: 'aborted', errorMessage: 'cancelled', timestamp: 2,
      } },
    ], { sessionId: 'pi-session', directory: '/workspace/project' });

    expect(records[0].info.parentID).toBe('msg_missing-user');
    expect(records[0].info.parentID).not.toBe(records[0].info.id);
    expect(records[0].info.error).toEqual({ name: 'MessageAbortedError', data: { message: 'cancelled' } });
    expect(records[0].info.cost).toBe(10);
    expect(records[0].info.tokens).toEqual({ total: 39, input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } });
    expect(records[0].info.finish).toBe('aborted');
  });
});


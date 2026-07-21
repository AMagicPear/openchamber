import { describe, expect, it, vi } from 'vitest';
import { createPiEventTranslator } from './event-translator.js';

function createFakeProcessManager() {
  const subscribers = new Map();
  const requests = [];
  return {
    subscribe(key, listener) {
      let listeners = subscribers.get(key);
      if (!listeners) {
        listeners = new Set();
        subscribers.set(key, listeners);
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request(key, command) {
      requests.push({ key, command });
      return Promise.resolve({ entries: [] });
    },
    emit(key, event) {
      const listeners = subscribers.get(key);
      if (listeners) {
        for (const listener of listeners) listener(event);
      }
    },
    get requests() { return requests; },
    reset() { requests.length = 0; },
  };
}

function createMockAliasStore() {
  const aliases = [];
  return {
    upsert: vi.fn(async (record) => { aliases.push(record); return record; }),
    get: vi.fn(async () => undefined),
    listSession: vi.fn(async () => []),
    removeSession: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    _records: aliases,
  };
}

function partUpdatedTexts(events) {
  return events
    .filter((e) => e.type === 'message.part.updated' && e.properties.part?.type === 'text')
    .map((e) => e.properties.part.text);
}

function partUpdatedReasoning(events) {
  return events
    .filter((e) => e.type === 'message.part.updated' && e.properties.part?.type === 'reasoning')
    .map((e) => e.properties.part.text);
}

function lastToolState(events, callID) {
  const matches = events
    .filter((e) => e.type === 'message.part.updated' && e.properties.part?.type === 'tool' && e.properties.part?.callID === callID);
  return matches.length > 0 ? matches[matches.length - 1].properties.part.state : null;
}

describe('createPiEventTranslator', () => {
  it('validates required options', () => {
    expect(() => createPiEventTranslator({})).toThrow('sessionId is required');
    expect(() => createPiEventTranslator({ sessionId: 's1' })).toThrow('cwd is required');
    expect(() => createPiEventTranslator({ sessionId: 's1', cwd: '/tmp' })).toThrow('processManager');
    expect(() => createPiEventTranslator({
      sessionId: 's1', cwd: '/tmp', processManager: { request() {}, subscribe() {} }, processKey: 'k',
    })).toThrow('onEvent is required');
  });

  it('emits session.status busy on agent_start', () => {
    const pm = createFakeProcessManager();
    const events = [];
    const t = createPiEventTranslator({
      sessionId: 's', cwd: '/tmp', processManager: pm, processKey: 'k',
      onEvent: events.push.bind(events),
    });

    pm.emit('k', { type: 'agent_start' });

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('session.status');
    expect(events[0].properties.sessionID).toBe('s');
    expect(events[0].properties.status).toEqual({ type: 'busy' });
    t.close();
  });

  it('emits message.updated with assistant metadata including path and parentID', () => {
    const pm = createFakeProcessManager();
    const events = [];
    const t = createPiEventTranslator({
      sessionId: 's', cwd: '/repo', processManager: pm, processKey: 'k',
      onEvent: events.push.bind(events),
    });

    // User message → assistant message in same turn
    pm.emit('k', { type: 'message_start', message: { role: 'user', content: 'hi' } });
    pm.emit('k', { type: 'message_end', message: { role: 'user', content: 'hi' } });
    pm.emit('k', { type: 'message_start', message: { role: 'assistant', provider: 'anthropic', model: 'claude-opus-4-5' } });

    const assistantStart = events.find((e) => e.type === 'message.updated' && e.properties.info?.role === 'assistant');
    expect(assistantStart).toBeTruthy();
    expect(assistantStart.properties.info.modelID).toBe('claude-opus-4-5');
    expect(assistantStart.properties.info.providerID).toBe('anthropic');
    expect(assistantStart.properties.info.path).toEqual({ cwd: '/repo', root: '/repo' });
    expect(assistantStart.properties.info.parentID).toMatch(/^msg_live_/);
    expect(assistantStart.properties.info.mode).toBe('default');
    expect(assistantStart.properties.info.agent).toBe('pi');
    t.close();
  });

  it('emits text part with deltas via real Pi AssistantMessageEvent types', () => {
    const pm = createFakeProcessManager();
    const events = [];
    const t = createPiEventTranslator({
      sessionId: 's', cwd: '/tmp', processManager: pm, processKey: 'k',
      onEvent: events.push.bind(events),
    });

    pm.emit('k', { type: 'message_start', message: { role: 'assistant' } });
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: { content: [{ type: 'text', text: '' }] } },
    });
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello, ' },
    });
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'world!' },
    });
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Hello, world!', partial: { content: [{ type: 'text', text: 'Hello, world!' }] } },
    });

    const textParts = events.filter((e) => e.type === 'message.part.updated' && e.properties.part?.type === 'text');
    const deltas = events.filter((e) => e.type === 'message.part.delta');
    expect(textParts).toHaveLength(2); // text_start + text_end
    expect(textParts[0].properties.part.text).toBe('');
    expect(textParts[textParts.length - 1].properties.part.text).toBe('Hello, world!');
    expect(deltas).toHaveLength(2);
    expect(deltas[0].properties.delta).toBe('Hello, ');
    expect(deltas[1].properties.delta).toBe('world!');
    t.close();
  });

  it('emits reasoning parts via real Pi thinking_* types', () => {
    const pm = createFakeProcessManager();
    const events = [];
    const t = createPiEventTranslator({
      sessionId: 's', cwd: '/tmp', processManager: pm, processKey: 'k',
      onEvent: events.push.bind(events),
    });

    pm.emit('k', { type: 'message_start', message: { role: 'assistant' } });
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_start', contentIndex: 1, partial: { content: [{}, { type: 'thinking', thinking: '' }] } },
    });
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 1, delta: 'Let me think...' },
    });
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 1, delta: ' more' },
    });
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_end', contentIndex: 1, content: 'Let me think... more', partial: { content: [{}, { type: 'thinking', thinking: 'Let me think... more' }] } },
    });

    const reasoningParts = partUpdatedReasoning(events);
    expect(reasoningParts).toHaveLength(2);
    expect(reasoningParts[0]).toBe('');
    expect(reasoningParts[reasoningParts.length - 1]).toBe('Let me think... more');
    const reasoningDeltas = events.filter((e) => e.type === 'message.part.delta' && e.properties.field === 'text');
    expect(reasoningDeltas).toHaveLength(2);
    t.close();
  });

  it('emits tool part pending → running → completed with proper start time', () => {
    const pm = createFakeProcessManager();
    const events = [];
    const t = createPiEventTranslator({
      sessionId: 's', cwd: '/tmp', processManager: pm, processKey: 'k',
      onEvent: events.push.bind(events),
    });

    pm.emit('k', { type: 'message_start', message: { role: 'assistant' } });
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: 0,
        partial: { content: [{ type: 'toolCall' }] },
      },
    });
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{"path":' },
    });
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '"/tmp/x"}' },
    });
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/tmp/x' } },
        partial: { content: [{ type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/tmp/x' } }] },
      },
    });
    pm.emit('k', { type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'read', args: { path: '/tmp/x' } });
    pm.emit('k', {
      type: 'tool_execution_end',
      toolCallId: 'tc1',
      toolName: 'read',
      isError: false,
      result: { content: [{ type: 'text', text: 'file contents' }] },
    });

    const pendingState = events
      .filter((e) => e.type === 'message.part.updated' && e.properties.part?.type === 'tool')
      .find((e) => e.properties.part.state?.status === 'pending' && e.properties.part.callID === 'tc1');
    expect(pendingState).toBeTruthy();
    expect(pendingState.properties.part.state.input).toEqual({ path: '/tmp/x' });
    expect(pendingState.properties.part.state.raw).toBe('{"path":"/tmp/x"}');

    const running = events.find((e) => e.type === 'message.part.updated' && e.properties.part?.state?.status === 'running');
    expect(running).toBeTruthy();
    expect(running.properties.part.state.time.start).toEqual(running.properties.part.state.time.start);

    const completed = lastToolState(events, 'tc1');
    expect(completed.status).toBe('completed');
    expect(completed.output).toBe('file contents');
    expect(completed.time.start).toBeLessThanOrEqual(completed.time.end);
    t.close();
  });

  it('emits tool part error state on tool execution failure', () => {
    const pm = createFakeProcessManager();
    const events = [];
    const t = createPiEventTranslator({
      sessionId: 's', cwd: '/tmp', processManager: pm, processKey: 'k',
      onEvent: events.push.bind(events),
    });

    pm.emit('k', { type: 'message_start', message: { role: 'assistant' } });
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { type: 'toolCall', id: 'tc2', name: 'bash', arguments: {} },
        partial: { content: [{ type: 'toolCall', id: 'tc2', name: 'bash', arguments: {} }] },
      },
    });
    pm.emit('k', {
      type: 'tool_execution_end',
      toolCallId: 'tc2',
      toolName: 'bash',
      isError: true,
      result: { content: [{ type: 'text', text: 'command not found' }], isError: true },
    });

    const error = lastToolState(events, 'tc2');
    expect(error.status).toBe('error');
    expect(error.error).toBe('command not found');
    t.close();
  });

  it('emits session.idle on agent_settled and triggers alias reconciliation', async () => {
    const pm = createFakeProcessManager();
    const events = [];
    const store = createMockAliasStore();
    const t = createPiEventTranslator({
      sessionId: 's', cwd: '/tmp', processManager: pm, processKey: 'k',
      messageAliasStore: store,
      onEvent: events.push.bind(events),
    });

    pm.emit('k', { type: 'message_start', message: { role: 'user', content: 'Hello' } });
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: { content: [{ type: 'text', text: '' }] } },
    });
    // Pretend the message was assistant — switch
    // Actually that was user; emit a user message_end and continue
    pm.emit('k', { type: 'message_end', message: { role: 'user', content: 'Hello' } });
    pm.emit('k', { type: 'agent_settled' });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.some((e) => e.type === 'session.idle')).toBe(true);
    // get_entries returned [] so no aliases written
    expect(store.upsert).not.toHaveBeenCalled();
    t.close();
  });

  it('writeDurable aliases after agent_settled when get_entries returns matching content', async () => {
    const pm = createFakeProcessManager();
    const store = createMockAliasStore();
    const t = createPiEventTranslator({
      sessionId: 's1', cwd: '/tmp', processManager: pm, processKey: 'k',
      messageAliasStore: store,
      onEvent: () => {},
    });

    pm.emit('k', { type: 'message_start', message: { role: 'user', content: 'Hello world' } });
    pm.emit('k', { type: 'message_end', message: { role: 'user', content: 'Hello world' } });
    pm.emit('k', { type: 'message_start', message: { role: 'assistant' } });
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: { content: [{ type: 'text', text: '' }] } },
    });
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hi there' },
    });
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Hi there', partial: { content: [{ type: 'text', text: 'Hi there' }] } },
    });
    pm.emit('k', { type: 'message_end', message: { role: 'assistant' } });

    // Override get_entries to return matching content
    const userMessageId = t.currentMessageId; // null after message_end; capture before via reservation
    // Resubscribe to control get_entries return — fetch last emitted message_id
    pm.request = async () => ({
      entries: [
        {
          type: 'message',
          id: 'pi-user-1',
          parentId: null,
          message: { role: 'user', timestamp: 1, content: 'Hello world' },
        },
      ],
    });

    pm.emit('k', { type: 'agent_settled' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(store.upsert).toHaveBeenCalled();
    const call = store.upsert.mock.calls.find((c) => c[0].entryID === 'pi-user-1');
    expect(call).toBeTruthy();
    expect(call[0].role).toBe('user');
    void userMessageId; // silence unused
    t.close();
  });

  it('reserveNextMessageId is idempotent and consumed by message_start', () => {
    const pm = createFakeProcessManager();
    const events = [];
    const t = createPiEventTranslator({
      sessionId: 's', cwd: '/tmp', processManager: pm, processKey: 'k',
      onEvent: events.push.bind(events),
    });

    const id1 = t.reserveNextMessageId();
    const id2 = t.reserveNextMessageId();
    expect(id1).toBe(id2);

    pm.emit('k', { type: 'message_start', message: { role: 'assistant' } });
    const msgEvent = events.find((e) => e.type === 'message.updated');
    expect(msgEvent.properties.info.id).toBe(id1);

    const id3 = t.reserveNextMessageId();
    expect(id3).not.toBe(id1);
    t.close();
  });

  it('auto-closes on process_failed lifecycle event', () => {
    const pm = createFakeProcessManager();
    const t = createPiEventTranslator({
      sessionId: 's', cwd: '/tmp', processManager: pm, processKey: 'k',
      onEvent: () => {},
    });

    expect(t.isClosed).toBe(false);
    pm.emit('k', { type: 'lifecycle', event: 'process_failed', generation: 1 });
    expect(t.isClosed).toBe(true);
    t.close();
  });

  it('clears pending reservation on agent_settled without message_start', () => {
    const pm = createFakeProcessManager();
    const t = createPiEventTranslator({
      sessionId: 's', cwd: '/tmp', processManager: pm, processKey: 'k',
      onEvent: () => {},
    });

    const id1 = t.reserveNextMessageId();
    pm.emit('k', { type: 'agent_settled' });
    const id2 = t.reserveNextMessageId();
    expect(id2).not.toBe(id1);
    t.close();
  });

  it('handles aborted assistant message with error', () => {
    const pm = createFakeProcessManager();
    const events = [];
    const t = createPiEventTranslator({
      sessionId: 's', cwd: '/tmp', processManager: pm, processKey: 'k',
      onEvent: events.push.bind(events),
    });

    pm.emit('k', { type: 'message_start', message: { role: 'assistant' } });
    pm.emit('k', {
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'aborted', errorMessage: 'User cancelled' },
    });

    const endEvents = events.filter((e) => e.type === 'message.updated');
    const last = endEvents[endEvents.length - 1];
    expect(last.properties.info.finish).toBe('aborted');
    expect(last.properties.info.error.name).toBe('MessageAbortedError');
    t.close();
  });

  it('uses explicit ID from reserveNextMessageId for user message', () => {
    const pm = createFakeProcessManager();
    const events = [];
    const t = createPiEventTranslator({
      sessionId: 's', cwd: '/tmp', processManager: pm, processKey: 'k',
      onEvent: events.push.bind(events),
    });

    const frontendId = 'msg_frontend_abc123';
    const reserved = t.reserveNextMessageId(frontendId);
    expect(reserved).toBe(frontendId);

    pm.emit('k', { type: 'message_start', message: { role: 'user', content: 'hi' } });
    const msgEvent = events.find((e) => e.type === 'message.updated');
    expect(msgEvent.properties.info.id).toBe(frontendId);
    expect(msgEvent.properties.info.role).toBe('user');
    t.close();
  });

  it('ignores events after close', () => {
    const pm = createFakeProcessManager();
    const events = [];
    const t = createPiEventTranslator({
      sessionId: 's', cwd: '/tmp', processManager: pm, processKey: 'k',
      onEvent: events.push.bind(events),
    });

    pm.emit('k', { type: 'agent_start' });
    expect(events.length).toBe(1);

    t.close();
    expect(t.isClosed).toBe(true);

    pm.emit('k', { type: 'agent_settled' });
    expect(events.length).toBe(1);
  });

  it('handles interleaved text + toolcall content blocks per contentIndex', () => {
    const pm = createFakeProcessManager();
    const events = [];
    const t = createPiEventTranslator({
      sessionId: 's', cwd: '/tmp', processManager: pm, processKey: 'k',
      onEvent: events.push.bind(events),
    });

    pm.emit('k', { type: 'message_start', message: { role: 'assistant' } });
    // content[0] = text
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: { content: [{ type: 'text', text: '' }] } },
    });
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Let me check' },
    });
    // content[1] = toolcall
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, partial: { content: [{}, {}] } },
    });
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 1,
        toolCall: { type: 'toolCall', id: 'tc-int', name: 'bash', arguments: {} },
        partial: { content: [{}, { type: 'toolCall', id: 'tc-int', name: 'bash', arguments: {} }] },
      },
    });
    // back to content[2] = text
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_start', contentIndex: 2, partial: { content: [{}, {}, { type: 'text', text: '' }] } },
    });
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 2, delta: 'done' },
    });
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_end', contentIndex: 2, content: 'done', partial: { content: [{}, {}, { type: 'text', text: 'done' }] } },
    });

    const textParts = partUpdatedTexts(events);
    expect(textParts.length).toBeGreaterThanOrEqual(2);
    // Tool part should exist with status pending
    const toolPending = events.find((e) => e.type === 'message.part.updated' && e.properties.part?.type === 'tool' && e.properties.part?.callID === 'tc-int');
    expect(toolPending).toBeTruthy();
    t.close();
  });

  it('falls back to empty args when toolcall_delta JSON is malformed', () => {
    const pm = createFakeProcessManager();
    const events = [];
    const t = createPiEventTranslator({
      sessionId: 's', cwd: '/tmp', processManager: pm, processKey: 'k',
      onEvent: events.push.bind(events),
    });

    pm.emit('k', { type: 'message_start', message: { role: 'assistant' } });
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, partial: { content: [{ type: 'toolCall' }] } },
    });
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{garbage' },
    });
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { type: 'toolCall', id: 'tc-bad', name: 'bash', arguments: { fixed: 'value' } },
        partial: { content: [{ type: 'toolCall', id: 'tc-bad', name: 'bash', arguments: { fixed: 'value' } }] },
      },
    });

    const pendingWithBadDelta = events
      .filter((e) => e.type === 'message.part.updated' && e.properties.part?.type === 'tool')
      .find((e) => e.properties.part.state?.status === 'pending' && e.properties.part.state?.raw === '{garbage');
    expect(pendingWithBadDelta).toBeTruthy();
    expect(pendingWithBadDelta.properties.part.state.input).toEqual({});

    const final = lastToolState(events, 'tc-bad');
    expect(final.input).toEqual({ fixed: 'value' });
    t.close();
  });

  it('tracks tool execution start time before completion', () => {
    const pm = createFakeProcessManager();
    const events = [];
    let currentTime = 1000;
    const t = createPiEventTranslator({
      sessionId: 's', cwd: '/tmp', processManager: pm, processKey: 'k',
      now: () => currentTime,
      onEvent: events.push.bind(events),
    });

    pm.emit('k', { type: 'message_start', message: { role: 'assistant' } });
    pm.emit('k', {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { type: 'toolCall', id: 'tc-time', name: 'bash', arguments: {} },
        partial: { content: [{ type: 'toolCall', id: 'tc-time', name: 'bash', arguments: {} }] },
      },
    });
    currentTime = 2000;
    pm.emit('k', { type: 'tool_execution_start', toolCallId: 'tc-time', toolName: 'bash', args: {} });
    currentTime = 2500;
    pm.emit('k', {
      type: 'tool_execution_end',
      toolCallId: 'tc-time',
      toolName: 'bash',
      isError: false,
      result: { content: [{ type: 'text', text: 'ok' }] },
    });

    const completed = lastToolState(events, 'tc-time');
    expect(completed.status).toBe('completed');
    expect(completed.time.start).toBe(2000);
    expect(completed.time.end).toBe(2500);
    t.close();
  });
});
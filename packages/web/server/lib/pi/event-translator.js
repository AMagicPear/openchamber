import { randomUUID } from 'node:crypto';
import { hashPiMessageContent } from './message-alias-store.js';
import { textFromContent, assistantError } from './opencode-shapes.js';

const SEQUENCE_WIDTH = 12;

function padSequence(index) {
  return String(index).padStart(SEQUENCE_WIDTH, '0');
}

function liveMessageId(turnIndex, messageIndex) {
  return `msg_live_${padSequence(turnIndex)}_${padSequence(messageIndex)}`;
}

function livePartId(turnIndex, messageIndex, contentIndex) {
  return `prt_live_${padSequence(turnIndex)}_${padSequence(messageIndex)}_${padSequence(contentIndex)}`;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeParsePartialJson(text) {
  if (typeof text !== 'string' || text.length === 0) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function modelRef(message) {
  return {
    providerID: message?.provider || 'pi',
    modelID: message?.model || 'pi',
  };
}

function extractTokens(usage) {
  if (!isRecord(usage)) return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  return {
    input: Number.isFinite(usage.inputTokens) ? usage.inputTokens : Number.isFinite(usage.input) ? usage.input : 0,
    output: Number.isFinite(usage.outputTokens) ? usage.outputTokens : Number.isFinite(usage.output) ? usage.output : 0,
    reasoning: Number.isFinite(usage.reasoningTokens) ? usage.reasoningTokens : Number.isFinite(usage.reasoning) ? usage.reasoning : 0,
    cache: {
      read: Number.isFinite(usage.cacheRead) ? usage.cacheRead : Number.isFinite(usage.cache?.read) ? usage.cache.read : 0,
      write: Number.isFinite(usage.cacheWrite) ? usage.cacheWrite : Number.isFinite(usage.cache?.write) ? usage.cache.write : 0,
    },
  };
}

/**
 * Per-contentIndex state for an in-flight assistant message.
 * Tracks the OpenCode-shaped part id alongside accumulated text or JSON args
 * so deltas can be replayed without depending on Pi's `partial.content` shape.
 */
function createPartState(partId, type) {
  return { partId, type, accumulated: '', partialJson: '' };
}

function createMessageState({ messageId, role, model, parentID, cwd }) {
  return {
    messageId,
    role,
    model,
    parentID: parentID ?? null,
    cwd,
    parts: new Map(), // contentIndex -> PartState
    toolParts: new Map(), // toolCallId -> { partId, contentIndex, toolName }
    accumulatedContent: '',
    partIndex: 0,
  };
}

/**
 * Converts Pi RPC stdout events to OpenCode V1 SSE events and writes durable
 * message aliases when Pi persists entries (via the alias store's content-match
 * path on agent_settled, since Pi does not broadcast entry_appended for normal
 * message persistence).
 */
export function createPiEventTranslator(options = {}) {
  const {
    sessionId,
    cwd,
    processManager,
    processKey,
    messageAliasStore,
    makeId = randomUUID,
    now = Date.now,
    onEvent,
    onSettled,
    onSessionInfoChanged,
  } = options;

  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new TypeError('sessionId is required');
  if (typeof cwd !== 'string' || cwd.length === 0) throw new TypeError('cwd is required');
  if (!processManager || typeof processManager.request !== 'function' || typeof processManager.subscribe !== 'function') {
    throw new TypeError('processManager with request and subscribe is required');
  }
  if (typeof processKey !== 'string' || processKey.length === 0) throw new TypeError('processKey is required');
  if (typeof onEvent !== 'function') throw new TypeError('onEvent is required');

  let turnIndex = 0;
  let messageIndex = 0;
  let closed = false;
  let reconciling = false;
  let pendingReservation = null;
  let currentMessage = null;
  let lastUserMessageId = null;
  let unsubscribe;
  // Map<messageId, accumulatedContent> — used for alias reconciliation by content.
  const messageContentMap = new Map();
  // Map<toolCallId, { partId, messageId, toolName, start }> — persists across message boundaries.
  const toolPartRegistry = new Map();

  function emit(type, data) {
    if (closed) return;
    onEvent({
      id: `evt_${makeId()}`,
      type,
      properties: { sessionID: sessionId, ...data },
    });
  }

  function nextPartId(state, contentIndex) {
    if (state.parts.has(contentIndex)) return state.parts.get(contentIndex).partId;
    state.partIndex += 1;
    return livePartId(turnIndex, messageIndex, contentIndex);
  }

  function getOrCreatePart(state, contentIndex, type) {
    let partState = state.parts.get(contentIndex);
    if (partState && partState.type === type) return partState;
    const partId = nextPartId(state, contentIndex);
    partState = createPartState(partId, type);
    state.parts.set(contentIndex, partState);
    return partState;
  }

  function buildUserInfo(state, message) {
    return {
      id: state.messageId,
      sessionID: sessionId,
      role: 'user',
      time: { created: timestamp(now) },
      agent: 'pi',
      model: state.model,
    };
  }

  function buildAssistantInfo(state, message) {
    const usage = message?.usage;
    const tokens = extractTokens(usage);
    const cost = Number.isFinite(usage?.cost?.total) ? usage.cost.total : 0;
    const error = assistantError(message || {});
    return {
      id: state.messageId,
      sessionID: sessionId,
      role: 'assistant',
      time: { created: timestamp(now), completed: timestamp(now) },
      parentID: state.parentID ?? lastUserMessageId ?? undefined,
      modelID: state.model.modelID,
      providerID: state.model.providerID,
      mode: 'default',
      agent: 'pi',
      path: { cwd: state.cwd, root: state.cwd },
      cost,
      tokens,
      ...(message?.stopReason ? { finish: message.stopReason } : { finish: 'end' }),
      ...(error ? { error } : {}),
    };
  }

  function handleMessageStart(event) {
    const message = event.message || {};
    const reservation = pendingReservation;
    pendingReservation = null;

    let id;
    if (reservation) {
      id = reservation.id;
    } else {
      turnIndex += 1;
      messageIndex += 1;
      id = liveMessageId(turnIndex, messageIndex);
    }

    const role = message.role === 'user' ? 'user' : 'assistant';
    const parentID = role === 'assistant' ? lastUserMessageId : null;
    const model = role === 'assistant' ? modelRef(message) : { providerID: 'pi', modelID: 'pi' };

    currentMessage = createMessageState({
      messageId: id,
      role,
      model,
      parentID,
      cwd,
    });

    if (role === 'user') {
      lastUserMessageId = id;
    }

    // User messages don't stream text deltas; capture their content up front
    // so the alias reconciliation pass on agent_settled can match.
    if (role === 'user') {
      currentMessage.accumulatedContent = textFromContent(message.content);
    }

    emit('message.updated', {
      info: role === 'user' ? buildUserInfo(currentMessage, message) : buildAssistantInfo(currentMessage, message),
    });
  }

  function handleTextStart(state, eventData, message) {
    const contentIndex = eventData.contentIndex ?? state.partIndex;
    const part = getOrCreatePart(state, contentIndex, 'text');
    const text = eventData.partial?.content?.[contentIndex]?.text ?? '';
    part.accumulated = text;
    part.startTime = timestamp(now);
    state.accumulatedContent += text;
    emit('message.part.updated', {
      part: {
        id: part.partId,
        sessionID: sessionId,
        messageID: state.messageId,
        type: 'text',
        text,
      },
    });
  }

  function handleTextDelta(state, eventData) {
    const contentIndex = eventData.contentIndex ?? state.parts.size;
    const part = getOrCreatePart(state, contentIndex, 'text');
    // Use the authoritative partial content to compute the true delta;
    // fall back to eventData.delta when partial is unavailable.
    const fullText = eventData.partial?.content?.[contentIndex]?.text;
    const delta = typeof fullText === 'string'
      ? fullText.slice(part.accumulated.length)
      : (eventData.delta || '');
    if (!delta) return;
    part.accumulated = typeof fullText === 'string' ? fullText : (part.accumulated + delta);
    state.accumulatedContent += delta;
    emit('message.part.delta', {
      messageID: state.messageId,
      partID: part.partId,
      field: 'text',
      delta,
    });
  }

  function handleTextEnd(state, eventData) {
    const contentIndex = eventData.contentIndex ?? state.parts.size;
    const part = getOrCreatePart(state, contentIndex, 'text');
    const finalText = typeof eventData.content === 'string' ? eventData.content : part.accumulated;
    const endTime = timestamp(now);
    const startTime = part.startTime ?? endTime;
    // Replace accumulated text with the authoritative final content so subsequent
    // alias reconciliation matches the persisted version exactly.
    state.accumulatedContent = state.accumulatedContent.slice(0, state.accumulatedContent.length - part.accumulated.length) + finalText;
    part.accumulated = finalText;
    part.startTime = startTime;
    emit('message.part.updated', {
      part: {
        id: part.partId,
        sessionID: sessionId,
        messageID: state.messageId,
        type: 'text',
        text: finalText,
        time: { start: startTime, end: endTime },
      },
    });
  }

  function handleThinkingStart(state, eventData) {
    const contentIndex = eventData.contentIndex ?? state.partIndex;
    const part = getOrCreatePart(state, contentIndex, 'reasoning');
    const text = eventData.partial?.content?.[contentIndex]?.thinking ?? '';
    part.accumulated = text;
    emit('message.part.updated', {
      part: {
        id: part.partId,
        sessionID: sessionId,
        messageID: state.messageId,
        type: 'reasoning',
        text,
        time: { start: timestamp(now), end: timestamp(now) },
      },
    });
  }

  function handleThinkingDelta(state, eventData) {
    const contentIndex = eventData.contentIndex ?? state.parts.size;
    const part = getOrCreatePart(state, contentIndex, 'reasoning');
    // Use the authoritative partial content to compute the true delta;
    // fall back to eventData.delta when partial is unavailable.
    const fullText = eventData.partial?.content?.[contentIndex]?.thinking;
    const delta = typeof fullText === 'string'
      ? fullText.slice(part.accumulated.length)
      : (eventData.delta || '');
    if (!delta) return;
    part.accumulated = typeof fullText === 'string' ? fullText : (part.accumulated + delta);
    emit('message.part.delta', {
      messageID: state.messageId,
      partID: part.partId,
      field: 'text',
      delta,
    });
  }

  function handleThinkingEnd(state, eventData) {
    const contentIndex = eventData.contentIndex ?? state.parts.size;
    const part = getOrCreatePart(state, contentIndex, 'reasoning');
    const finalText = typeof eventData.content === 'string' ? eventData.content : part.accumulated;
    part.accumulated = finalText;
    emit('message.part.updated', {
      part: {
        id: part.partId,
        sessionID: sessionId,
        messageID: state.messageId,
        type: 'reasoning',
        text: finalText,
        time: { start: timestamp(now), end: timestamp(now) },
      },
    });
  }

  function handleToolcallStart(state, eventData) {
    const contentIndex = eventData.contentIndex ?? state.partIndex;
    const part = getOrCreatePart(state, contentIndex, 'tool');
    // toolcall_start can fire before the model finalizes toolCall.id; defer
    // registering in toolPartRegistry until toolcall_end so the callID matches.
    emit('message.part.updated', {
      part: {
        id: part.partId,
        sessionID: sessionId,
        messageID: state.messageId,
        type: 'tool',
        callID: '',
        tool: '',
        state: { status: 'pending', input: {}, raw: '' },
      },
    });
  }

  function handleToolcallDelta(state, eventData) {
    const contentIndex = eventData.contentIndex ?? state.parts.size;
    const part = getOrCreatePart(state, contentIndex, 'tool');
    const delta = eventData.delta || '';
    if (!delta) return;
    part.partialJson += delta;
    const input = safeParsePartialJson(part.partialJson);
    emit('message.part.updated', {
      part: {
        id: part.partId,
        sessionID: sessionId,
        messageID: state.messageId,
        type: 'tool',
        callID: '',
        tool: '',
        state: { status: 'pending', input, raw: part.partialJson },
      },
    });
  }

  function handleToolcallEnd(state, eventData) {
    const contentIndex = eventData.contentIndex ?? state.parts.size;
    const part = getOrCreatePart(state, contentIndex, 'tool');
    const toolCall = eventData.toolCall;
    if (!isRecord(toolCall)) return;
    const callID = String(toolCall.id || '');
    const toolName = String(toolCall.name || 'tool');
    const input = isRecord(toolCall.arguments) ? toolCall.arguments : safeParsePartialJson(part.partialJson);
    const raw = part.partialJson || JSON.stringify(input);
    part.partialJson = raw;
    state.toolParts.set(callID, { partId: part.partId, contentIndex, toolName });
    // start is set later by tool_execution_start; do not prefill with toolcall_end time
    // Preserve the tool call input so handleToolExecutionStart can include it.
    toolPartRegistry.set(callID, { partId: part.partId, messageId: state.messageId, toolName, input, start: null });
    emit('message.part.updated', {
      part: {
        id: part.partId,
        sessionID: sessionId,
        messageID: state.messageId,
        type: 'tool',
        callID,
        tool: toolName,
        state: { status: 'pending', input, raw },
      },
    });
  }

  function handleMessageUpdate(event) {
    if (!currentMessage) return;
    const eventData = event.assistantMessageEvent;
    if (!isRecord(eventData)) return;
    const state = currentMessage;

    switch (eventData.type) {
      case 'start':
        // Initial signal — no part action required; message_start already ran.
        break;
      case 'text_start':
        handleTextStart(state, eventData, event.message);
        break;
      case 'text_delta':
        handleTextDelta(state, eventData);
        break;
      case 'text_end':
        handleTextEnd(state, eventData);
        break;
      case 'thinking_start':
        handleThinkingStart(state, eventData);
        break;
      case 'thinking_delta':
        handleThinkingDelta(state, eventData);
        break;
      case 'thinking_end':
        handleThinkingEnd(state, eventData);
        break;
      case 'toolcall_start':
        handleToolcallStart(state, eventData);
        break;
      case 'toolcall_delta':
        handleToolcallDelta(state, eventData);
        break;
      case 'toolcall_end':
        handleToolcallEnd(state, eventData);
        break;
      case 'done':
      case 'error':
        // Terminal model events — finalized state is set by message_end.
        break;
      default:
        break;
    }
  }

  function handleMessageEnd(event) {
    if (!currentMessage) return;
    const state = currentMessage;
    const message = event.message || {};

    if (state.role === 'assistant') {
      emit('message.updated', { info: buildAssistantInfo(state, message) });
    }
    // Persist accumulated content for alias reconciliation on agent_settled.
    if (state.accumulatedContent.length > 0) {
      messageContentMap.set(state.messageId, state.accumulatedContent);
    }
    currentMessage = null;
  }

  function handleToolExecutionStart(event) {
    const callID = event.toolCallId;
    if (!callID) return;
    const entry = toolPartRegistry.get(callID);
    if (!entry) return;
    entry.start = timestamp(now);
    emit('message.part.updated', {
      part: {
        id: entry.partId,
        sessionID: sessionId,
        messageID: entry.messageId,
        type: 'tool',
        callID,
        tool: entry.toolName,
        state: {
          status: 'running',
          // Include the input from the tool call so the frontend can show
          // which file is being read, which command is running, etc.
          input: (entry.input && typeof entry.input === 'object' ? { ...entry.input } : {}),
          title: event.toolName || entry.toolName,
          metadata: {},
          time: { start: entry.start },
        },
      },
    });
  }

  function handleToolExecutionEnd(event) {
    const callID = event.toolCallId;
    if (!callID) return;
    const entry = toolPartRegistry.get(callID);
    if (!entry) return;
    const endTs = timestamp(now);
    const startTs = entry.start ?? endTs;
    // Preserve the tool call input so the frontend keeps seeing which file
    // was read, which command was run, etc. even after execution completes.
    const preservedInput = (entry.input && typeof entry.input === 'object' ? { ...entry.input } : {});
    if (event.isError) {
      emit('message.part.updated', {
        part: {
          id: entry.partId,
          sessionID: sessionId,
          messageID: entry.messageId,
          type: 'tool',
          callID,
          tool: entry.toolName,
          state: {
            status: 'error',
            input: preservedInput,
            error: textFromContent(event.result?.content) || 'Tool failed',
            metadata: {},
            time: { start: startTs, end: endTs },
          },
        },
      });
    } else {
      emit('message.part.updated', {
        part: {
          id: entry.partId,
          sessionID: sessionId,
          messageID: entry.messageId,
          type: 'tool',
          callID,
          tool: entry.toolName,
          state: {
            status: 'completed',
            input: preservedInput,
            output: textFromContent(event.result?.content),
            title: event.toolName || entry.toolName,
            metadata: {},
            time: { start: startTs, end: endTs },
          },
        },
      });
    }
    toolPartRegistry.delete(callID);
  }

  async function reconcileAliases() {
    if (!messageAliasStore || closed || reconciling) return;
    reconciling = true;
    try {
      const response = await processManager.request(processKey, { type: 'get_entries' });
      const entries = response?.entries || [];
      for (const entry of entries) {
        if (!isRecord(entry) || typeof entry.id !== 'string' || entry.type !== 'message') continue;
        const message = entry.message;
        if (!isRecord(message)) continue;
        if (message.role !== 'user' && message.role !== 'assistant') continue;

        const content = textFromContent(message.content);
        let bestMatchId = null;
        for (const [msgId, msgContent] of messageContentMap) {
          if (msgContent === content) {
            bestMatchId = msgId;
            break;
          }
        }
        if (!bestMatchId) continue;

        const contentHash = hashPiMessageContent(content);
        try {
          await messageAliasStore.upsert({
            sessionID: sessionId,
            entryID: entry.id,
            messageID: bestMatchId,
            role: message.role,
            created: timestamp(now),
            contentHash,
          });
        } catch {
          // Alias write failures are non-fatal — the next reconcile pass retries.
        }
      }
    } catch {
      // Reconcile failures must not interrupt event streaming.
    } finally {
      reconciling = false;
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    pendingReservation = null;
    if (typeof unsubscribe === 'function') unsubscribe();
    unsubscribe = undefined;
    messageContentMap.clear();
    toolPartRegistry.clear();
    currentMessage = null;
  }

  function handleEvent(event) {
    if (closed) return;
    if (!isRecord(event)) return;

    switch (event.type) {
      case 'agent_start':
        emit('session.status', { status: { type: 'busy' } });
        break;
      case 'message_start':
        handleMessageStart(event);
        break;
      case 'message_update':
        handleMessageUpdate(event);
        break;
      case 'message_end':
        handleMessageEnd(event);
        break;
      case 'tool_execution_start':
        handleToolExecutionStart(event);
        break;
      case 'tool_execution_end':
        handleToolExecutionEnd(event);
        break;
      case 'turn_end':
        pendingReservation = null;
        currentMessage = null;
        break;
      case 'agent_settled':
        pendingReservation = null;
        emit('session.idle', {});
        if (typeof onSettled === 'function') onSettled();
        void reconcileAliases();
        break;
      case 'session_info_changed':
        // The Pi event only carries { name }; the gateway callback is
        // responsible for reading the freshly persisted session file and
        // emitting session.updated with the canonical OpenCode Session shape
        // (proper projectID hash, original created time, version, etc).
        if (typeof onSessionInfoChanged === 'function') onSessionInfoChanged();
        break;
      case 'lifecycle':
        if (event.event === 'process_failed') close();
        break;
      default:
        break;
    }
  }

  unsubscribe = processManager.subscribe(processKey, handleEvent);

  return {
    close,
    reserveNextMessageId(explicitId) {
      if (pendingReservation) return pendingReservation.id;
      if (explicitId !== undefined) {
        pendingReservation = { id: explicitId, turnIndex, messageIndex };
        return explicitId;
      }
      turnIndex += 1;
      messageIndex += 1;
      const id = liveMessageId(turnIndex, messageIndex);
      pendingReservation = { id, turnIndex, messageIndex };
      return id;
    },
    get currentMessageId() {
      return currentMessage?.messageId ?? null;
    },
    get isClosed() {
      return closed;
    },
  };
}

// Local helper kept private — `now` is captured by closure inside the factory.
function timestamp(now) {
  return now();
}
import { VERSION } from '@earendil-works/pi-coding-agent';
import { createHash } from 'node:crypto';
import path from 'node:path';

function numberOr(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function timestamp(value, fallback = 0) {
  if (value instanceof Date) return numberOr(value.getTime(), fallback);
  if (typeof value === 'number') return numberOr(value, fallback);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function requiredDate(value, name) {
  const parsed = timestamp(value, NaN);
  if (!Number.isFinite(parsed)) throw new TypeError(`Pi session ${name} is invalid`);
  return new Date(parsed);
}

function requiredAbsolutePath(value, name) {
  if (typeof value !== 'string' || value.trim() === '' || !path.isAbsolute(value)) {
    throw new TypeError(`Pi session ${name} must be a non-empty absolute path`);
  }
  return path.resolve(value);
}

/** Normalize the verified durable SessionInfo contract before conversion. */
export function normalizePiSessionInfo(info) {
  if (!info || typeof info !== 'object') throw new TypeError('Pi SessionManager returned an invalid session catalog');
  if (typeof info.id !== 'string' || info.id.trim() === '') {
    throw new TypeError('Pi session id must be a non-empty string');
  }
  return {
    ...info,
    id: info.id,
    path: requiredAbsolutePath(info.path, 'path'),
    cwd: requiredAbsolutePath(info.cwd, 'cwd'),
    created: requiredDate(info.created, 'created'),
    modified: requiredDate(info.modified, 'modified'),
  };
}

function normalizedDirectory(directory) {
  if (typeof directory !== 'string' || directory.trim() === '' || !path.isAbsolute(directory)) {
    throw new TypeError('directory must be a non-empty absolute path');
  }
  return path.resolve(directory);
}

export function projectIdForDirectory(directory) {
  return `project_${createHash('sha256').update(normalizedDirectory(directory)).digest('hex')}`;
}

export function piSessionToOpenCodeSession(info, options = {}) {
  info = normalizePiSessionInfo(info);
  const directory = normalizedDirectory(info.cwd);
  const parent = info.parentSessionPath ? options.sessionIndex?.byPath?.get(path.resolve(info.parentSessionPath)) : undefined;
  const created = timestamp(info.created);
  const updated = timestamp(info.modified, created);
  return {
    id: info.id,
    slug: info.id,
    projectID: projectIdForDirectory(directory),
    directory,
    path: path.resolve(info.path),
    ...(parent ? { parentID: parent.id } : {}),
    title: info.name || (info.firstMessage && info.firstMessage !== '(no messages)' ? info.firstMessage : 'Untitled session'),
    version: options.version || VERSION,
    time: { created, updated },
  };
}

export function piSessionToGlobalSession(info, options = {}) {
  const session = piSessionToOpenCodeSession(info, options);
  return {
    ...session,
    project: {
      id: session.projectID,
      name: path.basename(session.directory),
      worktree: session.directory,
    },
  };
}

export function piDirectoryToProject(directory, options = {}) {
  const resolved = normalizedDirectory(directory);
  const now = numberOr(options.updated, Date.now());
  return {
    id: projectIdForDirectory(resolved),
    worktree: resolved,
    ...(options.vcs ? { vcs: options.vcs } : {}),
    name: options.name || path.basename(resolved),
    time: { created: numberOr(options.created, now), updated: now },
    sandboxes: [],
  };
}

export function piDirectoryToPath(directory, options = {}) {
  const resolved = normalizedDirectory(directory);
  const home = options.home || process.env.HOME || path.parse(resolved).root;
  return {
    home: path.resolve(home),
    state: path.resolve(options.state || path.join(home, '.pi', 'agent')),
    config: path.resolve(options.config || path.join(home, '.pi')),
    worktree: resolved,
    directory: resolved,
  };
}

export function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part?.type === 'text' ? part.text : part?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

const BRANCH_ORDER_WIDTH = 12;

function branchOrder(index) {
  return String(index).padStart(BRANCH_ORDER_WIDTH, '0');
}

function openCodeMessageId(entryId, entryOrder) {
  return `msg_${entryOrder}_${entryId}`;
}

function contentParts(content, ids) {
  const values = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  return values.flatMap((part, index) => {
    const id = `prt_${ids.entryOrder}_${branchOrder(index)}_${ids.entryId}`;
    if (part?.type === 'text') {
      return [{ id, sessionID: ids.sessionId, messageID: ids.messageId, type: 'text', text: String(part.text || '') }];
    }
    if (part?.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string') {
      return [{
        id,
        sessionID: ids.sessionId,
        messageID: ids.messageId,
        type: 'file',
        mime: part.mimeType,
        url: `data:${part.mimeType};base64,${part.data}`,
      }];
    }
    return [];
  });
}

function usageShape(usage = {}) {
  return {
    total: numberOr(usage.totalTokens),
    input: numberOr(usage.input),
    output: numberOr(usage.output),
    reasoning: numberOr(usage.reasoning),
    cache: { read: numberOr(usage.cacheRead), write: numberOr(usage.cacheWrite) },
  };
}

function toolStateFromResult(result, start, input) {
  const output = textFromContent(result.content);
  const end = timestamp(result.timestamp, start);
  if (result.isError) {
    return {
      status: 'error',
      input,
      error: output || 'Tool failed',
      time: { start, end },
    };
  }
  return {
    status: 'completed',
    input,
    output,
    title: result.toolName || 'Tool',
    metadata: {},
    time: { start, end },
  };
}

function mergeToolResult(result, toolCalls, orphanResults) {
  const call = toolCalls.get(result.toolCallId);
  if (!call) {
    orphanResults.set(result.toolCallId, result);
    return;
  }
  call.part.state = toolStateFromResult(result, call.start, call.part.state.input);
}

export function assistantError(message) {
  if (message.stopReason === 'aborted') {
    return { name: 'MessageAbortedError', data: { message: String(message.errorMessage || 'Assistant message aborted') } };
  }
  if (message.stopReason === 'error') {
    return { name: 'UnknownError', data: { message: String(message.errorMessage || 'Assistant error') } };
  }
  return undefined;
}

/** Convert the visible entries on one Pi branch into OpenCode message records. */
export function piBranchToOpenCodeMessages(entries, options = {}) {
  const sessionId = options.sessionId || '';
  const records = [];
  const toolCalls = new Map();
  const orphanResults = new Map();
  let currentUserMessageId;
  const durableMessageIds = new Map();
  let model = options.defaultModel || { providerID: 'pi', modelID: 'pi' };

  for (const [entryIndex, entry] of (entries || []).entries()) {
    if (!entry || entry.type !== 'message' || !entry.message) continue;
    const message = entry.message;
    const entryOrder = branchOrder(entryIndex);
    const messageId = openCodeMessageId(entry.id, entryOrder);
    const ids = { entryId: entry.id, entryOrder, messageId, sessionId };
    const created = timestamp(message.timestamp, timestamp(entry.timestamp));

    if (message.role === 'toolResult') {
      mergeToolResult(message, toolCalls, orphanResults);
      continue;
    }

    if (message.role === 'user') {
      const info = {
        id: messageId,
        sessionID: sessionId,
        role: 'user',
        time: { created },
        agent: options.agent || 'pi',
        model,
      };
      records.push({ info, parts: contentParts(message.content, ids) });
      currentUserMessageId = messageId;
      durableMessageIds.set(entry.id, messageId);
      continue;
    }

    if (message.role !== 'assistant') continue;
    model = { providerID: message.provider || model.providerID, modelID: message.model || model.modelID };
    const parts = [];
    for (const [index, part] of (Array.isArray(message.content) ? message.content : []).entries()) {
      const id = `prt_${entryOrder}_${branchOrder(index)}_${entry.id}`;
      if (part?.type === 'text') {
        parts.push({ id, sessionID: sessionId, messageID: messageId, type: 'text', text: String(part.text || '') });
      } else if (part?.type === 'thinking') {
        parts.push({
          id,
          sessionID: sessionId,
          messageID: messageId,
          type: 'reasoning',
          text: String(part.thinking || ''),
          time: { start: created, end: created },
        });
      } else if (part?.type === 'toolCall' && typeof part.id === 'string') {
        const toolPart = {
          id,
          sessionID: sessionId,
          messageID: messageId,
          type: 'tool',
          callID: part.id,
          tool: String(part.name || 'tool'),
          state: {
            status: 'pending',
            input: part.arguments && typeof part.arguments === 'object' ? part.arguments : {},
            raw: JSON.stringify(part.arguments && typeof part.arguments === 'object' ? part.arguments : {}),
          },
        };
        parts.push(toolPart);
        const call = { part: toolPart, start: created };
        toolCalls.set(part.id, call);
        const orphan = orphanResults.get(part.id);
        if (orphan) {
          orphanResults.delete(part.id);
          mergeToolResult(orphan, toolCalls, orphanResults);
        }
      }
    }
    const durableParentId = typeof entry.parentId === 'string' && entry.parentId !== entry.id
      ? durableMessageIds.get(entry.parentId) || openCodeMessageId(entry.parentId, entryOrder)
      : undefined;
    const parentID = currentUserMessageId || durableParentId;
    records.push({
      info: {
        id: messageId,
        sessionID: sessionId,
        role: 'assistant',
        time: { created, completed: created },
        ...(parentID ? { parentID } : {}),
        modelID: model.modelID,
        providerID: model.providerID,
        mode: options.mode || 'default',
        agent: options.agent || 'pi',
        path: { cwd: normalizedDirectory(options.directory), root: normalizedDirectory(options.directory) },
        cost: numberOr(message.usage?.cost?.total),
        tokens: usageShape(message.usage),
        ...(message.stopReason ? { finish: message.stopReason } : {}),
        ...(assistantError(message) ? { error: assistantError(message) } : {}),
      },
      parts,
    });
    durableMessageIds.set(entry.id, messageId);
  }
  return records;
}


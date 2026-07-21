import fsPromisesDefault from 'node:fs/promises';
import os from 'node:os';
import pathDefault from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const VERSION = 1;
const FILE_NAME = 'pi-message-aliases.json';
const MAX_IDENTIFIER_LENGTH = 512;
const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const RECORD_KEYS = ['sessionID', 'entryID', 'messageID', 'role', 'created', 'contentHash'];
const RECORD_KEY_SET = new Set(RECORD_KEYS);
const FORBIDDEN_KEYS = new Set([
  'text',
  'content',
  'message',
  'parts',
  'images',
  'prompt',
  'headers',
  'env',
  'auth',
  'key',
  'token',
  'credential',
]);

const defaultDataDir = (path) => (process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber'));

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function assertNoForbiddenKeys(value, location = 'value', seen = new Set()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, `${location}[${index}]`, seen));
    return;
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw new Error(`Forbidden payload field at ${location}.${key}`);
    }
    assertNoForbiddenKeys(nestedValue, `${location}.${key}`, seen);
  }
}

function assertIdentifier(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_IDENTIFIER_LENGTH) {
    throw new TypeError(`${name} must be a non-empty bounded string`);
  }
}

function assertRecordKeys(record) {
  if (!isObject(record)) throw new TypeError('Alias record must be an object');
  assertNoForbiddenKeys(record, 'alias');
  const keys = Object.keys(record);
  if (keys.length !== RECORD_KEYS.length || keys.some((key) => !RECORD_KEY_SET.has(key))) {
    throw new TypeError('Alias record has unexpected fields');
  }
  if (Object.getOwnPropertySymbols(record).length > 0) {
    throw new TypeError('Alias record has unexpected fields');
  }
}

function validateRecord(record, location = 'alias') {
  assertRecordKeys(record);
  assertIdentifier(record.sessionID, `${location}.sessionID`);
  assertIdentifier(record.entryID, `${location}.entryID`);
  assertIdentifier(record.messageID, `${location}.messageID`);
  if (record.role !== 'user' && record.role !== 'assistant') {
    throw new TypeError(`${location}.role must be user or assistant`);
  }
  if (!Number.isSafeInteger(record.created) || record.created < 0) {
    throw new TypeError(`${location}.created must be a safe nonnegative integer`);
  }
  if (typeof record.contentHash !== 'string' || !CONTENT_HASH_PATTERN.test(record.contentHash)) {
    throw new TypeError(`${location}.contentHash must be a SHA-256 hex digest`);
  }
  return {
    sessionID: record.sessionID,
    entryID: record.entryID,
    messageID: record.messageID,
    role: record.role,
    created: record.created,
    contentHash: record.contentHash,
  };
}

function identityKey(sessionID, entryID) {
  return `${sessionID}\u0000${entryID}`;
}

function validateIdentity(value) {
  if (!isObject(value)) throw new TypeError('Alias identity must be an object');
  assertIdentifier(value.sessionID, 'sessionID');
  assertIdentifier(value.entryID, 'entryID');
}

function cloneRecord(record) {
  return { ...record };
}

function parsePersistedState(value) {
  assertNoForbiddenKeys(value, 'state');
  if (!isObject(value) || Object.keys(value).length !== 2
    || !Object.prototype.hasOwnProperty.call(value, 'version')
    || !Object.prototype.hasOwnProperty.call(value, 'aliases')) {
    throw new Error('Pi message alias storage has an invalid schema');
  }
  if (value.version !== VERSION) throw new Error('Pi message alias storage has an unsupported version');
  if (!Array.isArray(value.aliases)) throw new Error('Pi message alias storage aliases must be an array');

  const aliases = new Map();
  for (const [index, record] of value.aliases.entries()) {
    const validated = validateRecord(record, `aliases[${index}]`);
    const key = identityKey(validated.sessionID, validated.entryID);
    if (aliases.has(key)) throw new Error(`Duplicate alias identity at aliases[${index}]`);
    aliases.set(key, validated);
  }
  return aliases;
}

function defaultContentHash(content) {
  if (typeof content !== 'string') throw new TypeError('Message content must be a string');
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function assertContentHash(value) {
  if (typeof value !== 'string' || !CONTENT_HASH_PATTERN.test(value)) {
    throw new TypeError('contentHash must return a SHA-256 hex digest');
  }
  return value;
}

/** Hash message content before constructing an alias record. */
export function hashPiMessageContent(content, { contentHash = defaultContentHash } = {}) {
  if (typeof contentHash !== 'function') throw new TypeError('contentHash must be a function');
  return assertContentHash(contentHash(content));
}

export function createPiMessageAliasStore(options = {}) {
  const {
    fsPromises = fsPromisesDefault,
    path = pathDefault,
    dataDir,
    filePath: injectedFilePath,
    now = Date.now,
    contentHash = defaultContentHash,
  } = options;
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof contentHash !== 'function') throw new TypeError('contentHash must be a function');
  const resolvedDataDir = dataDir || defaultDataDir(path);
  const filePath = injectedFilePath || path.join(resolvedDataDir, FILE_NAME);
  const aliases = new Map();
  let loaded = false;
  let queue = Promise.resolve();

  const enqueue = (operation) => {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  };

  const load = async () => {
    if (loaded) return;
    let raw;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        loaded = true;
        return;
      }
      throw error;
    }
    const parsed = JSON.parse(raw);
    const persisted = parsePersistedState(parsed);
    aliases.clear();
    for (const [key, record] of persisted) aliases.set(key, record);
    loaded = true;
  };

  const writeState = async (nextAliases) => {
    const serialized = `${JSON.stringify({ version: VERSION, aliases: [...nextAliases.values()] }, null, 2)}\n`;
    const parent = path.dirname(filePath);
    await fsPromises.mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.tmp-${process.pid}-${now()}-${randomUUID()}`;
    let renamed = false;
    try {
      await fsPromises.writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
      await fsPromises.chmod(temporary, 0o600);
      await fsPromises.rename(temporary, filePath);
      renamed = true;
      try {
        await fsPromises.chmod(filePath, 0o600);
      } catch {
        // The rename already made the snapshot durable; destination chmod is best effort.
      }
    } finally {
      if (!renamed) await fsPromises.unlink(temporary).catch(() => {});
    }
  };

  const get = ({ sessionID, entryID }) => enqueue(async () => {
    validateIdentity({ sessionID, entryID });
    await load();
    const record = aliases.get(identityKey(sessionID, entryID));
    return record ? cloneRecord(record) : undefined;
  });

  const listSession = (sessionID) => enqueue(async () => {
    assertIdentifier(sessionID, 'sessionID');
    await load();
    return [...aliases.values()]
      .filter((record) => record.sessionID === sessionID)
      .map(cloneRecord);
  });

  const upsert = (record) => {
    const validated = validateRecord(record);
    return enqueue(async () => {
      await load();
      const key = identityKey(validated.sessionID, validated.entryID);
      const existing = aliases.get(key);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(validated)) {
          throw new Error('Incompatible alias for durable identity');
        }
        return cloneRecord(existing);
      }
      const nextAliases = new Map(aliases);
      nextAliases.set(key, validated);
      await writeState(nextAliases);
      aliases.clear();
      for (const [nextKey, nextRecord] of nextAliases) aliases.set(nextKey, nextRecord);
      return cloneRecord(validated);
    });
  };

  const removeSession = (sessionID) => enqueue(async () => {
    assertIdentifier(sessionID, 'sessionID');
    await load();
    const nextAliases = new Map([...aliases].filter(([, record]) => record.sessionID !== sessionID));
    if (nextAliases.size === aliases.size) return;
    await writeState(nextAliases);
    aliases.clear();
    for (const [key, record] of nextAliases) aliases.set(key, record);
  });

  const close = () => enqueue(async () => {});

  return { get, listSession, upsert, removeSession, close };
}

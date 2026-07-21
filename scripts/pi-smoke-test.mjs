// Smoke test: drive a real Pi RPC process through the Pi compatibility gateway
// and observe the resulting SSE stream. Exercises the full event-translator path
// against actual Pi `AssistantMessageEvent` types.
import { createPiCompatibilityGateway } from '../packages/web/server/lib/pi/gateway.js';
import { createPiRpcProcessManager } from '../packages/web/server/lib/pi/rpc-process-manager.js';
import { createPiSessionRepository } from '../packages/web/server/lib/pi/session-repository.js';
import { createPiModelCatalog } from '../packages/web/server/lib/pi/model-catalog.js';
import { createPiMessageAliasStore } from '../packages/web/server/lib/pi/message-alias-store.js';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-smoke-'));

const processManager = createPiRpcProcessManager({});
const sessionRepository = createPiSessionRepository({});
const modelCatalog = createPiModelCatalog({});
const aliasStore = createPiMessageAliasStore({ dataDir: path.join(directory, 'alias') });

const gateway = createPiCompatibilityGateway({
  processManager,
  sessionRepository,
  modelCatalog,
  messageAliasStore: aliasStore,
  defaultDirectory: directory,
});

const started = await gateway.start();
console.log('GATEWAY', started.url);

const events = [];
const directoryStream = await openSse(`${started.url}/event?directory=${encodeURIComponent(directory)}`);
const globalStream = await openSse(`${started.url}/global/event`);

// Create session
const created = await fetch(`${started.url}/session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({}),
}).then((r) => r.json());
console.log('CREATED', created.id, created.path);

// Send a prompt
const prompt = await fetch(`${started.url}/session/${created.id}/prompt_async?directory=${encodeURIComponent(directory)}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    messageID: 'msg_smoke_test_1',
    parts: [{ type: 'text', text: 'Reply with exactly: SMOKE_OK' }],
  }),
});
console.log('PROMPT STATUS', prompt.status);

await new Promise((r) => setTimeout(r, 5000));

// Check message history
const history = await fetch(`${started.url}/session/${created.id}/message?directory=${encodeURIComponent(directory)}`).then((r) => r.json());
console.log('HISTORY', history.map((m) => ({ id: m.info.id, role: m.info.role, parts: m.parts?.length })));

// DELETE
const deleted = await fetch(`${started.url}/session/${created.id}?directory=${encodeURIComponent(directory)}`, { method: 'DELETE' });
console.log('DELETE STATUS', deleted.status);

await new Promise((r) => setTimeout(r, 500));

directoryStream.response.destroy();
globalStream.response.destroy();
await gateway.close();
await processManager.shutdown();
await aliasStore.close();

// Inspect the SSE stream content
const dirText = directoryStream.chunks.join('');
const globText = globalStream.chunks.join('');
console.log('---');
console.log('DIR SSE EVENTS:');
for (const line of dirText.split('\n').filter((l) => l.startsWith('event: '))) {
  console.log(' ', line);
}
console.log('GLOBAL SSE EVENTS:');
for (const line of globText.split('\n').filter((l) => l.startsWith('event: '))) {
  console.log(' ', line);
}

async function openSse(url) {
  const chunks = [];
  const response = await new Promise((resolve, reject) => {
    const client = http.get(url, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('error', reject);
      resolve(res);
    });
    client.once('error', reject);
  });
  return { response, chunks };
}
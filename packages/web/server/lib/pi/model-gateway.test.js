import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createPiCompatibilityGateway } from './gateway.js';

const directory = '/tmp';
const catalog = {
  getSnapshot: vi.fn(async () => ({
    providers: [{
      id: 'pi-provider',
      name: 'Pi Provider',
      source: 'api',
      env: [],
      options: {},
      models: {
        'pi-model': {
          id: 'pi-model',
          providerID: 'pi-provider',
          api: { id: 'pi-messages', url: 'https://pi.test', npm: '' },
          name: 'Pi Model',
          capabilities: {
            temperature: false,
            reasoning: false,
            attachment: false,
            toolcall: false,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: false, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 1000, output: 100 },
          status: 'active',
          options: {},
          headers: {},
          release_date: '',
        },
      },
    }],
    default: { 'pi-provider': 'pi-model' },
    defaultModel: 'pi-provider/pi-model',
    connected: ['pi-provider'],
  })),
};

const repository = {
  listAll: vi.fn(async () => []),
};

describe('Pi model and agent gateway contract', () => {
  it('serves provider/config/agent shapes through the installed SDK', async () => {
    const gateway = createPiCompatibilityGateway({
      sessionRepository: repository,
      defaultDirectory: directory,
      modelCatalog: catalog,
      configProvider: vi.fn(async () => ({ $schema: 'https://opencode.ai/config.json', custom: true })),
    });
    const started = await gateway.start();
    const client = createOpencodeClient({ baseUrl: started.url });

    await expect(client.config.providers()).resolves.toMatchObject({
      data: { default: { 'pi-provider': 'pi-model' }, providers: [{ id: 'pi-provider' }] },
    });
    await expect(client.provider.list()).resolves.toMatchObject({
      data: { connected: ['pi-provider'], all: [{ id: 'pi-provider' }] },
    });
    await expect(client.app.agents()).resolves.toMatchObject({
      data: [{ name: 'pi', mode: 'primary', native: true, permission: [], options: {} }],
    });
    await expect(client.config.get()).resolves.toMatchObject({
      data: { custom: true, model: 'pi-provider/pi-model' },
    });
    await expect(client.global.config.get()).resolves.toMatchObject({
      data: { custom: true, model: 'pi-provider/pi-model' },
    });
    expect(JSON.stringify(catalog)).not.toContain('secret');
    await gateway.close();
  });

  it('keeps the Pi primary agent available when catalog initialization fails', async () => {
    const failedCatalog = { getSnapshot: vi.fn(async () => { throw new Error('private catalog failure'); }) };
    const gateway = createPiCompatibilityGateway({
      sessionRepository: repository,
      defaultDirectory: directory,
      modelCatalog: failedCatalog,
    });
    await request(gateway.app).get('/agent').expect(200).expect(({ body }) => {
      expect(body).toEqual([{ name: 'pi', description: 'Pi primary agent', mode: 'primary', native: true, permission: [], options: {} }]);
    });
    await request(gateway.app).get('/config/providers').expect(500);
  });

  it('keeps an authoritative empty catalog successful and leaves config without a model', async () => {
    const emptyCatalog = {
      getSnapshot: vi.fn(async () => ({ providers: [], default: {}, connected: [] })),
    };
    const gateway = createPiCompatibilityGateway({
      sessionRepository: repository,
      defaultDirectory: directory,
      modelCatalog: emptyCatalog,
      configProvider: vi.fn(async () => ({ $schema: 'https://opencode.ai/config.json' })),
    });
    await request(gateway.app).get('/config').expect(200).expect(({ body }) => expect(body.model).toBeUndefined());
    await gateway.close();
  });
});

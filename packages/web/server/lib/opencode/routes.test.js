import { describe, expect, it, vi } from 'vitest';
import { registerOpenCodeRoutes } from './routes.js';

const createRouteRegistry = () => {
  const routes = new Map();
  const register = (method) => (routePath, handler) => {
    routes.set(`${method} ${routePath}`, handler);
  };
  return {
    app: {
      get: register('GET'),
      post: register('POST'),
      put: register('PUT'),
      delete: register('DELETE'),
    },
    getRoute: (method, routePath) => routes.get(`${method} ${routePath}`),
  };
};

const createResponse = () => {
  let statusCode = 200;
  let body;
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

const createDependencies = (overrides = {}) => ({
  crypto: {},
  clientReloadDelayMs: 0,
  getOpenCodeResolutionSnapshot: vi.fn(),
  formatSettingsResponse: (settings) => ({ ...settings, formatted: true }),
  readSettingsFromDisk: vi.fn(async () => ({ projects: [{ id: 'persisted', path: '/persisted' }], activeProjectId: 'persisted' })),
  readSettingsFromDiskMigrated: vi.fn(async () => ({ projects: [{ id: 'persisted', path: '/persisted' }], activeProjectId: 'persisted' })),
  persistSettings: vi.fn(async () => ({ projects: [{ id: 'persisted', path: '/persisted' }], activeProjectId: 'persisted', formatted: true })),
  sanitizeProjects: (projects) => projects,
  validateDirectoryPath: vi.fn(),
  resolveProjectDirectory: vi.fn(),
  getProviderSources: vi.fn(),
  removeProviderConfig: vi.fn(),
  refreshOpenCodeAfterConfigChange: vi.fn(),
  buildOpenCodeUrl: vi.fn(),
  getOpenCodeAuthHeaders: vi.fn(() => ({})),
  ...overrides,
});

const getSettingsHandlers = (dependencies) => {
  const { app, getRoute } = createRouteRegistry();
  registerOpenCodeRoutes(app, dependencies);
  return {
    get: getRoute('GET', '/api/config/settings'),
    put: getRoute('PUT', '/api/config/settings'),
  };
};

describe('settings route project response augmentation', () => {
  it('augments both GET and PUT responses while preserving activeProjectId', async () => {
    const augmentSettingsResponse = vi.fn(async (settings) => ({
      ...settings,
      projects: [...settings.projects, { id: 'discovered', path: '/discovered', addedAt: 10, lastOpenedAt: 20 }],
    }));
    const dependencies = createDependencies({ augmentSettingsResponse });
    const handlers = getSettingsHandlers(dependencies);

    const getResponse = createResponse();
    await handlers.get({}, getResponse);
    const putResponse = createResponse();
    await handlers.put({ body: { themeId: 'dark' } }, putResponse);

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.body.projects).toHaveLength(2);
    expect(getResponse.body.activeProjectId).toBe('persisted');
    expect(putResponse.statusCode).toBe(200);
    expect(putResponse.body.projects).toHaveLength(2);
    expect(putResponse.body.activeProjectId).toBe('persisted');
    expect(augmentSettingsResponse).toHaveBeenCalledTimes(2);
  });

  it('keeps OpenCode behavior unchanged when no augmenter is supplied', async () => {
    const dependencies = createDependencies();
    const handlers = getSettingsHandlers(dependencies);
    const getResponse = createResponse();
    await handlers.get({}, getResponse);
    const putResponse = createResponse();
    await handlers.put({ body: { themeId: 'dark' } }, putResponse);

    expect(getResponse.body).toEqual({
      projects: [{ id: 'persisted', path: '/persisted' }],
      activeProjectId: 'persisted',
      formatted: true,
    });
    expect(putResponse.body).toEqual({
      projects: [{ id: 'persisted', path: '/persisted' }],
      activeProjectId: 'persisted',
      formatted: true,
    });
  });

  it('returns a non-success response without an empty discovered project list when discovery fails', async () => {
    const dependencies = createDependencies({
      augmentSettingsResponse: vi.fn(async () => {
        throw new Error('catalog path /private/session.jsonl unavailable');
      }),
    });
    const handlers = getSettingsHandlers(dependencies);
    const response = createResponse();

    await handlers.get({}, response);

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({ error: 'Failed to read settings' });
    expect(response.body.projects).toBeUndefined();

    const putResponse = createResponse();
    await handlers.put({ body: { themeId: 'dark' } }, putResponse);
    expect(putResponse.statusCode).toBe(500);
    expect(putResponse.body).toEqual({ error: 'Failed to save settings' });
    expect(dependencies.persistSettings).toHaveBeenCalledWith({ themeId: 'dark' });
  });
});

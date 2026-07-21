import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import {
  createPiSettingsResponseAugmenter,
  discoverPiProjects,
  mergePiProjectsIntoSettings,
} from './project-discovery.js';

const session = (cwd, modified, created = modified) => ({
  cwd,
  created: new Date(created),
  modified: new Date(modified),
});

describe('Pi project discovery', () => {
  it('adds the current OpenChamber cwd without requiring it in persisted settings', async () => {
    const currentDirectory = process.cwd();
    const manager = { listAll: vi.fn(async () => [session(currentDirectory, 200, 100)]) };
    const augmentSettingsResponse = createPiSettingsResponseAugmenter({ SessionManager: manager });
    const settings = { projects: [{ id: 'persisted', path: '/persisted', addedAt: 1, lastOpenedAt: 2 }], activeProjectId: 'persisted' };

    const response = await augmentSettingsResponse(settings);

    expect(manager.listAll).toHaveBeenCalledTimes(1);
    expect(response.projects).toEqual([
      ...settings.projects,
      {
        id: expect.stringMatching(/^path_/),
        path: path.resolve(currentDirectory),
        addedAt: 100,
        lastOpenedAt: 200,
      },
    ]);
    expect(response.activeProjectId).toBe('persisted');
  });

  it('deduplicates cwd values and aggregates stable session timestamps', () => {
    expect(discoverPiProjects([
      session('/workspace/recent', 300, 250),
      session('/workspace/recent/', 200, 100),
      session('/workspace/older', 150, 125),
    ])).toEqual([
      {
        id: expect.stringMatching(/^path_/),
        path: '/workspace/recent',
        addedAt: 100,
        lastOpenedAt: 300,
      },
      {
        id: expect.stringMatching(/^path_/),
        path: '/workspace/older',
        addedAt: 125,
        lastOpenedAt: 150,
      },
    ]);
  });

  it('keeps existing project metadata and order ahead of discovered projects', () => {
    const existing = [
      { id: 'manual-one', path: '/workspace/one', label: 'Keep this', addedAt: 7, lastOpenedAt: 8 },
      { id: 'manual-two', path: '/workspace/two', color: 'red', addedAt: 9, lastOpenedAt: 10 },
    ];

    const response = mergePiProjectsIntoSettings(
      { projects: existing, activeProjectId: 'manual-two', themeId: 'dark' },
      discoverPiProjects([
        session('/workspace/two', 400, 300),
        session('/workspace/three', 200, 100),
        session('/workspace/one', 500, 400),
      ]),
    );

    expect(response).toEqual({
      projects: [
        ...existing,
        {
          id: expect.stringMatching(/^path_/),
          path: '/workspace/three',
          addedAt: 100,
          lastOpenedAt: 200,
        },
      ],
      activeProjectId: 'manual-two',
      themeId: 'dark',
    });
  });

  it('preserves newest-first cwd order from the Pi catalog', () => {
    const projects = discoverPiProjects([
      session('/workspace/newest', 300),
      session('/workspace/middle', 200),
      session('/workspace/newest', 100),
      session('/workspace/oldest', 50),
    ]);

    expect(projects.map((project) => project.path)).toEqual([
      '/workspace/newest',
      '/workspace/middle',
      '/workspace/oldest',
    ]);
  });

  it('does not turn catalog failures into an empty project result', async () => {
    const augmentSettingsResponse = createPiSettingsResponseAugmenter({
      loadSessions: async () => {
        throw new Error('catalog unavailable');
      },
    });

    await expect(augmentSettingsResponse({ projects: [{ path: '/persisted' }] })).rejects.toThrow('catalog unavailable');
  });

  it('removes sessions whose cwd is a macOS per-user temp directory', () => {
    const projects = discoverPiProjects([
      session('/var/folders/dk/gyt7kxxs4zvbyf509znpbbvr0000gn/T/pi-runtime-1783843528371-abc', 300),
      session('/Users/amagicpear/projects/openchamber', 200),
      session('/private/var/folders/dk/gyt7kxxs4zvbyf509znpbbvr0000gn/T/pi-smoke-test', 100),
      session('/Users/amagicpear/projects/pichamber', 50),
    ]);

    expect(projects.map((p) => p.path)).toEqual([
      '/Users/amagicpear/projects/openchamber',
      '/Users/amagicpear/projects/pichamber',
    ]);
  });
});

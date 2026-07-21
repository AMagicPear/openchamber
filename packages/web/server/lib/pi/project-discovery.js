import { SessionManager } from '@earendil-works/pi-coding-agent';
import path from 'node:path';
import { createProjectIdFromPath } from '../projects/project-id.js';

const timestampOf = (value) => {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }
  return undefined;
};

const normalizeAbsolutePath = (value) => {
  if (typeof value !== 'string' || value.trim().length === 0 || !path.isAbsolute(value)) {
    return null;
  }
  return path.resolve(value);
};

/**
 * Returns true when the cwd is a macOS per-user temporary directory
 * (/var/folders/<XX>/<UUID>/T/...) that should not appear in session
 * listings or project directories.
 */
export const shouldHidePiCwd = (cwd) => {
  if (!cwd) return true;
  const resolved = path.resolve(cwd);
  const segs = resolved.split(path.sep).filter(Boolean);
  // /var/folders/<XX>/<UUID>/T/...          → segs[0]=var,    segs[4]=T
  // /private/var/folders/<XX>/<UUID>/T/...  → segs[0]=private, segs[5]=T
  return (segs.at(0) === 'var' && segs.at(1) === 'folders' && segs.at(4) === 'T')
    || (segs.at(0) === 'private' && segs.at(1) === 'var' && segs.at(2) === 'folders' && segs.at(5) === 'T');
};

const projectTimestamps = (session) => {
  const created = timestampOf(session.created);
  const modified = timestampOf(session.modified);
  const fallback = modified ?? created ?? 0;
  return {
    addedAt: created ?? fallback,
    lastOpenedAt: modified ?? fallback,
  };
};

/**
 * Convert Pi's newest-first session catalog into settings project entries.
 * Invalid cwd values are ignored; catalog loading/shape failures are thrown.
 */
export const discoverPiProjects = (sessions) => {
  if (!Array.isArray(sessions)) {
    throw new TypeError('Pi SessionManager returned an invalid session catalog');
  }

  const projectsByPath = new Map();
  for (const session of sessions) {
    const projectPath = normalizeAbsolutePath(session?.cwd);
    if (!projectPath || shouldHidePiCwd(projectPath)) continue;

    const timestamps = projectTimestamps(session);
    const existing = projectsByPath.get(projectPath);
    if (!existing) {
      projectsByPath.set(projectPath, {
        id: createProjectIdFromPath(projectPath),
        path: projectPath,
        addedAt: timestamps.addedAt,
        lastOpenedAt: timestamps.lastOpenedAt,
      });
      continue;
    }

    existing.addedAt = Math.min(existing.addedAt, timestamps.addedAt);
    existing.lastOpenedAt = Math.max(existing.lastOpenedAt, timestamps.lastOpenedAt);
  }

  return [...projectsByPath.values()];
};

const settingsProjectPath = (project) => {
  const value = typeof project?.path === 'string' ? project.path.trim() : '';
  return normalizeAbsolutePath(value) || value;
};

/** Merge discovered projects without changing persisted settings or active selection. */
export const mergePiProjectsIntoSettings = (settings, discoveredProjects) => {
  const existingProjects = Array.isArray(settings?.projects) ? settings.projects : [];
  const seenPaths = new Set(existingProjects.map(settingsProjectPath).filter(Boolean));
  const projects = [...existingProjects];

  for (const project of discoveredProjects) {
    if (seenPaths.has(project.path)) continue;
    seenPaths.add(project.path);
    projects.push(project);
  }

  return { ...settings, projects };
};

export const createPiSettingsResponseAugmenter = (options = {}) => {
  const manager = options.SessionManager || SessionManager;
  const loadSessions = options.loadSessions || (() => manager.listAll());
  if (typeof loadSessions !== 'function') {
    throw new TypeError('Pi project discovery requires a session catalog loader');
  }

  return async (settings) => {
    const sessions = await loadSessions();
    const discoveredProjects = discoverPiProjects(sessions);
    return mergePiProjectsIntoSettings(settings, discoveredProjects);
  };
};

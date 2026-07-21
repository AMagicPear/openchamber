const OPENCHAMBER_BACKENDS = Object.freeze(['opencode', 'pi']);
const DEFAULT_OPENCHAMBER_BACKEND = 'opencode';

export function resolveOpenChamberBackend(env = process.env) {
  const raw = env?.OPENCHAMBER_BACKEND;
  if (raw === undefined || raw === null) return DEFAULT_OPENCHAMBER_BACKEND;

  const normalized = String(raw).trim().toLowerCase();
  if (OPENCHAMBER_BACKENDS.includes(normalized)) return normalized;

  throw new Error(
    `Invalid OPENCHAMBER_BACKEND value "${String(raw)}". Supported values are: opencode, pi`,
  );
}


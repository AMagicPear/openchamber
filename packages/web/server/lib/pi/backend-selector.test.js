import { describe, expect, it } from 'vitest';
import { resolveOpenChamberBackend } from './backend-selector.js';

describe('resolveOpenChamberBackend', () => {
  it('defaults to OpenCode and normalizes explicit values', () => {
    expect(resolveOpenChamberBackend({})).toBe('opencode');
    expect(resolveOpenChamberBackend({ OPENCHAMBER_BACKEND: '  PI ' })).toBe('pi');
    expect(resolveOpenChamberBackend({ OPENCHAMBER_BACKEND: ' OpenCode ' })).toBe('opencode');
  });

  it('rejects unsupported explicit values', () => {
    expect(() => resolveOpenChamberBackend({ OPENCHAMBER_BACKEND: 'gateway' })).toThrow(
      'Invalid OPENCHAMBER_BACKEND value',
    );
  });
});


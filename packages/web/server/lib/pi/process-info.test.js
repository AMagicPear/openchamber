import { describe, expect, it } from 'vitest';
import { shouldReportManagedOpenCodeProcess } from './process-info.js';

describe('shouldReportManagedOpenCodeProcess', () => {
  it('never exposes an in-process Pi gateway to detached process cleanup', () => {
    expect(shouldReportManagedOpenCodeProcess({
      backend: 'pi',
      processHandle: { url: 'http://127.0.0.1:1234', pid: null },
      port: 1234,
    })).toBe(false);
  });

  it('preserves managed OpenCode reporting decisions', () => {
    expect(shouldReportManagedOpenCodeProcess({ backend: 'opencode', processHandle: {}, port: 1234 })).toBe(true);
    expect(shouldReportManagedOpenCodeProcess({ backend: 'opencode', processHandle: {}, port: 1234, external: true })).toBe(false);
  });
});


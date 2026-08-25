import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConfig, updateConfig } from './config.js';
import { useTempHome } from './testUtil.js';

describe('config', () => {
  const t = useTempHome();
  it('defaults, updates and rejects invalid urls', () => {
    const f = join(t.home, 'config.json');
    expect(readConfig(f)).toEqual({ serverKeys: {} });
    updateConfig(f, { deviceId: 'dev_1', gatewayUrl: 'wss://gw.example' });
    expect(readConfig(f).deviceId).toBe('dev_1');
    expect(() => updateConfig(f, { gatewayUrl: 'nope' })).toThrow();
  });
});

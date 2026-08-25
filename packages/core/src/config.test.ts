import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectConfig, readConfig, updateConfig } from './config.js';
import { useTempHome } from './testUtil.js';

describe('config', () => {
  const t = useTempHome();
  const file = () => join(t.home, 'config.json');

  it('defaults, updates and rejects invalid urls', () => {
    expect(readConfig(file())).toEqual({ serverKeys: {} });
    updateConfig(file(), { deviceId: 'dev_1', gatewayUrl: 'wss://gw.example' });
    expect(readConfig(file()).deviceId).toBe('dev_1');
    expect(() => updateConfig(file(), { gatewayUrl: 'nope' })).toThrow();
  });

  it('inspectConfig is silent about a healthy config', () => {
    updateConfig(file(), { deviceId: 'dev_1' });
    const r = inspectConfig(file());
    expect(r.problem).toBeUndefined();
    expect(r.config.deviceId).toBe('dev_1');
  });

  it('inspectConfig explains a corrupt file that readConfig silently ignores', () => {
    writeFileSync(file(), '{"deviceId": "dev_1"');
    expect(readConfig(file())).toEqual({ serverKeys: {} }); // the silent-fallback behaviour
    const r = inspectConfig(file());
    expect(r.problem?.code).toBe('corrupt');
    expect(r.problem?.hint).toContain('pagr connect');
  });

  it('inspectConfig names the offending field when the shape is wrong', () => {
    writeFileSync(file(), JSON.stringify({ deviceId: 'dev_1', gatewayUrl: 'not-a-url' }));
    const r = inspectConfig(file());
    expect(r.problem?.code).toBe('wrong_shape');
    expect(r.problem?.message).toContain('gatewayUrl');
    expect(r.problem?.hint).toContain('--force');
  });

  it('a wrong-shaped config does not pretend a device is still paired', () => {
    writeFileSync(file(), JSON.stringify({ deviceId: 'dev_1', gatewayUrl: 'not-a-url' }));
    expect(inspectConfig(file()).config.deviceId).toBeUndefined();
  });
});
